/**
 * Atomic import staging. Importers (e.g. .drglitch archives) write a
 * candidate project and its assets into the staging store, validate, and
 * only then commit: the candidate is installed into the live stores under a
 * NEW local project id in one transaction. Abort or a crash never leaves
 * partial data in live stores; sweepAbandonedStaging() cleans up leftovers
 * from crashed imports.
 *
 * Staging store keys:
 *   `<stagingId>`                    StagingMetaRow
 *   `<stagingId>:asset:<store>:<sha256>` StagingAssetRow
 *
 * Legacy rows used `<stagingId>:asset:<sha256>` plus meta.assetShas. They
 * remain readable/collectable so an upgrade can finish or sweep a crashed
 * import, but current writers always use store-qualified identities.
 */
import type { AssetRecordV1, Id, ProjectEnvelopeV1, Sha256 } from "../core/types";
import { createId } from "../core/id";
import { validateRaster, RasterValidationError } from "../io/raster-validator";
import { sanitizeSvg, SvgValidationError, type SvgProfile } from "../io/svg-sanitizer";
import { SchemaViolation, validateProjectEnvelope } from "../io/validate";
import type { StorageBackend } from "./backend";
import type {
  AssetStoreName,
  StagingAssetRef,
  StagingAssetRow,
  StagingMetaRow,
  StagingRow,
  StoredAssetRow,
} from "./schema";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { CorruptRecordError, NotFoundError } from "./errors";
import { validateStoredAssetRow } from "./validate";
import { sha256HexAbortable } from "../io/sha256";

/** Staging areas older than this are considered abandoned by a crash. */
export const STAGING_ABANDONED_AFTER_MS = 60 * 60 * 1000;

const assetKey = (stagingId: Id, store: AssetStoreName, sha256: Sha256): string =>
  `${stagingId}:asset:${store}:${sha256}`;
const legacyAssetKey = (stagingId: Id, sha256: Sha256): string =>
  `${stagingId}:asset:${sha256}`;

function destinationFor(record: AssetRecordV1): AssetStoreName {
  return record.kind === "thumbnail" ? "thumbnails" : "assets";
}

function abortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "The import staging operation was aborted.",
    "AbortError",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function raceWithAbort<T>(value: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const SVG_ROLE_PROFILES: readonly SvgProfile[] = ["artwork", "custom-dot", "registration-mark"];

/**
 * Kind-aware content check for one staged asset at commit time. The hash
 * recompute already pins the bytes to their content address; this check
 * additionally proves the row's METADATA tells the truth about them:
 * raster/thumbnail bytes must parse as the recorded mime with the recorded
 * dimensions (full payload decode already happened in the importer — the
 * hash guarantees these are those exact bytes); SVG bytes must be UTF-8 and
 * a canonical fixed point of the strict sanitizer for at least one profile
 * (the same rule the at-rest verifier and AssetCache enforce).
 */
function verifyStagedContent(
  store: "assets" | "thumbnails",
  record: AssetRecordV1,
  bytes: Uint8Array,
): void {
  const corrupt = (cause: Error): never => {
    throw new CorruptRecordError(store, record.sha256, { cause });
  };
  if (record.kind === "svg") {
    if (record.mime !== "image/svg+xml") {
      corrupt(new Error(`svg asset carries mime "${record.mime}"`));
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return corrupt(new Error("staged SVG bytes are not valid UTF-8"));
    }
    const canonical = SVG_ROLE_PROFILES.some((profile) => {
      try {
        return sanitizeSvg(text, profile).svg === text;
      } catch (error) {
        if (error instanceof SvgValidationError) return false;
        throw error;
      }
    });
    if (!canonical) corrupt(new Error("staged SVG is not canonical sanitized markup"));
    return;
  }
  try {
    const info = validateRaster(bytes, { declaredType: record.mime });
    if (info.width !== record.width || info.height !== record.height) {
      corrupt(new Error(
        `staged ${record.kind} header says ${info.width}x${info.height}, record says ${record.width}x${record.height}`,
      ));
    }
  } catch (error) {
    if (error instanceof RasterValidationError) {
      corrupt(new Error(`staged ${record.kind} bytes rejected (${error.code}): ${error.message}`));
    }
    throw error;
  }
}

export type StagedImport = {
  envelope: ProjectEnvelopeV1;
  assets: {
    record: AssetRecordV1;
    blob: Blob;
    /** Qualified destination; present for current and normalized legacy rows. */
    destination: AssetStoreName;
  }[];
};

type ReadStagedImport = StagedImport & {
  assets: Array<StagedImport["assets"][number] & { stagingKey: string }>;
};

/** Throw to reject the staged candidate; commit() aborts and cleans up. */
export type StagingValidator = (staged: StagedImport) => void | Promise<void>;

export type CommitOptions = {
  validate?: StagingValidator;
  /** Title override for the installed project. */
  title?: string;
  /** Cancellation may roll back until the atomic storage commit settles. */
  signal?: AbortSignal;
};

export type ImportStagingOptions = {
  now?: Clock;
  newId?: () => Id;
};

export type StagingHandle = {
  readonly stagingId: Id;
  /** Stage one content-addressed asset (raster/svg/thumbnail bytes). */
  stageAsset(record: AssetRecordV1, blob: Blob, signal?: AbortSignal): Promise<void>;
  /** Stage the candidate project envelope (ids as found in the archive). */
  stageProject(envelope: ProjectEnvelopeV1, signal?: AbortSignal): Promise<void>;
  /**
   * Validate, then atomically install: assets/thumbnails are deduped into
   * the live stores, the envelope is written under a NEW local project id,
   * and the staging area is deleted — all in one transaction. Returns the
   * installed envelope.
   */
  commit(options?: CommitOptions): Promise<ProjectEnvelopeV1>;
  /** Discard the staging area and everything in it. */
  abort(): Promise<void>;
};

export class ImportStaging {
  private readonly now: Clock;
  private readonly newId: () => Id;

  constructor(
    private readonly backend: StorageBackend,
    options: ImportStagingOptions = {},
  ) {
    this.now = options.now ?? systemClock;
    this.newId = options.newId ?? createId;
  }

  /** Allocate a new staging area. */
  async begin(signal?: AbortSignal): Promise<StagingHandle> {
    throwIfAborted(signal);
    const stagingId = this.newId();
    const meta: StagingMetaRow = {
      type: "meta",
      stagingId,
      createdAt: this.now(),
      envelope: null,
      assetRefs: [],
    };
    await this.backend.transaction(
      ["staging"],
      async (tx) => tx.put("staging", stagingId, meta),
      signal,
    );
    return this.handleFor(stagingId);
  }

  private handleFor(stagingId: Id): StagingHandle {
    return {
      stagingId,
      stageAsset: (record, blob, signal) => this.stageAsset(stagingId, record, blob, signal),
      stageProject: (envelope, signal) => this.stageProject(stagingId, envelope, signal),
      commit: (options) => this.commit(stagingId, options),
      abort: () => this.abort(stagingId),
    };
  }

  private async stageAsset(
    stagingId: Id,
    record: AssetRecordV1,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<void> {
    const destination = destinationFor(record);
    const row: StagingAssetRow = {
      type: "asset",
      stagingId,
      destination,
      asset: { record, blob },
    };
    await this.backend.transaction(["staging"], async (tx) => {
      // The existence check and metadata update share the write transaction.
      // A concurrent abort either runs before this (and this sees no meta) or
      // after it (and deletes the complete row set); no stale meta snapshot can
      // be written late and resurrect the staging area.
      const meta = await tx.get<StagingRow>("staging", stagingId);
      if (!meta || meta.type !== "meta") throw new NotFoundError("staging area", stagingId);
      const ref: StagingAssetRef = { store: destination, sha256: record.sha256 };
      const refs = meta.assetRefs ?? [];
      await tx.put("staging", assetKey(stagingId, destination, record.sha256), row);
      if (!refs.some((candidate) => candidate.store === ref.store && candidate.sha256 === ref.sha256)) {
        await tx.put("staging", stagingId, { ...meta, assetRefs: [...refs, ref] });
      }
    }, signal);
  }

  private async stageProject(
    stagingId: Id,
    envelope: ProjectEnvelopeV1,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.backend.transaction(["staging"], async (tx) => {
      const meta = await tx.get<StagingRow>("staging", stagingId);
      if (!meta || meta.type !== "meta") throw new NotFoundError("staging area", stagingId);
      await tx.put("staging", stagingId, { ...meta, envelope });
    }, signal);
  }

  private async readStaged(stagingId: Id, signal?: AbortSignal): Promise<ReadStagedImport> {
    let staged: ReadStagedImport | null = null;
    await this.backend.transaction(["staging"], async (tx) => {
      const meta = await tx.get<StagingRow>("staging", stagingId);
      if (!meta || meta.type !== "meta") throw new NotFoundError("staging area", stagingId);
      if (!meta.envelope) throw new NotFoundError("staged project envelope", stagingId);

      const assets: ReadStagedImport["assets"] = [];
      const seen = new Set<string>();
      const accept = (
        row: StagingRow | undefined,
        stagingKey: string,
        expected?: AssetStoreName,
      ): void => {
        if (!row || row.type !== "asset" || row.stagingId !== stagingId) {
          throw new NotFoundError("staged asset", stagingKey);
        }
        const destination = row.destination ?? destinationFor(row.asset.record);
        if (expected && destination !== expected) {
          throw new CorruptRecordError("staging", stagingKey, {
            cause: new Error(`staged destination ${destination} disagrees with metadata ${expected}`),
          });
        }
        const identity = `${destination}:${row.asset.record.sha256}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        assets.push({ ...row.asset, destination, stagingKey });
      };

      for (const ref of meta.assetRefs ?? []) {
        const key = assetKey(stagingId, ref.store, ref.sha256);
        accept(await tx.get<StagingRow>("staging", key), key, ref.store);
      }
      // Migration-only legacy path. A digest could not name two stores in
      // the old layout; infer its one destination from the staged record.
      for (const sha256 of meta.assetShas ?? []) {
        const key = legacyAssetKey(stagingId, sha256);
        const row = await tx.get<StagingRow>("staging", key);
        if (!row && [...seen].some((identity) => identity.endsWith(`:${sha256}`))) continue;
        accept(row, key);
      }
      staged = { envelope: meta.envelope, assets };
    }, signal);
    if (!staged) throw new NotFoundError("staging area", stagingId);
    return staged;
  }

  private async commit(stagingId: Id, options: CommitOptions = {}): Promise<ProjectEnvelopeV1> {
    const { signal } = options;
    throwIfAborted(signal);
    // Read and validate OUTSIDE the install transaction: validators may be
    // async/non-IDB work, which would auto-commit an IndexedDB transaction.
    const staged = await this.readStaged(stagingId, signal);
    if (options.validate) {
      await raceWithAbort(options.validate(staged), signal);
    }
    throwIfAborted(signal);

    // ON-COMMIT TRUST BOUNDARY (immediately adjacent to the install
    // transaction — hash recompute awaits crypto, which would auto-commit an
    // IndexedDB transaction, see backend.ts). Every staged row is
    // revalidated HERE, one asset resident at a time:
    //   - structural row/key/byteLength agreement,
    //   - SHA-256 recomputed over the staged bytes against the key,
    //   - kind-aware content checks (raster/thumbnail header + dimensions
    //     against the record; SVG UTF-8 + canonical-sanitizer fixed point).
    // The verified Blob INSTANCE is what gets installed: Blobs are
    // immutable, so a writer racing the staging rows (or the live stores)
    // can never swap bytes between this verification and the install —
    // same-length poison can neither install nor be reused through any
    // window, because pre-existing live rows NEVER contribute bytes (they
    // are overwritten with the verified staged bytes; only a structurally
    // valid existing row's createdAt survives, preserving dedupe identity).
    let candidate: ProjectEnvelopeV1;
    try {
      candidate = validateProjectEnvelope(staged.envelope);
    } catch (error) {
      if (error instanceof SchemaViolation) {
        throw new CorruptRecordError("staging", stagingId, { cause: error });
      }
      throw error;
    }
    const verified: {
      store: AssetStoreName;
      record: AssetRecordV1;
      blob: Blob;
      stagingKey: string;
    }[] = [];
    for (const { record, blob, destination: store, stagingKey } of staged.assets) {
      throwIfAborted(signal);
      if (destinationFor(record) !== store) {
        throw new CorruptRecordError("staging", stagingKey, {
          cause: new Error(`record kind ${record.kind} cannot install into ${store}`),
        });
      }
      const row = validateStoredAssetRow(store, record.sha256, { record, blob });
      const bytes = new Uint8Array(await raceWithAbort(row.blob.arrayBuffer(), signal));
      const digest = await sha256HexAbortable(bytes, () => throwIfAborted(signal));
      if (digest !== record.sha256) {
        throw new CorruptRecordError(store, record.sha256, {
          cause: new Error(`staged bytes hash to ${digest}, expected ${record.sha256}`),
        });
      }
      verifyStagedContent(store, row.record, bytes);
      verified.push({ store, record: row.record, blob: row.blob, stagingKey });
    }

    const timestamp = this.now();
    const installed: ProjectEnvelopeV1 = {
      ...candidate,
      id: this.newId(),
      title: options.title ?? candidate.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      // Honor the staged envelope's savedRevision: importers install with 0
      // ("never explicitly saved") so imported/sample projects open unsaved.
      savedRevision: candidate.savedRevision,
    };

    await this.backend.transaction(
      ["staging", "projects", "assets", "thumbnails"],
      async (tx) => {
        // Guard against double-commit / concurrent abort.
        const meta = await tx.get<StagingRow>("staging", stagingId);
        if (!meta || meta.type !== "meta") throw new NotFoundError("staging area", stagingId);
        for (const { store, record, blob, stagingKey } of verified) {
          // ALWAYS install the verified bytes — existing rows are never
          // reused (hash recompute cannot run inside an IDB transaction, so
          // reuse would be unverifiable and TOCTOU-exposed). A structurally
          // valid pre-existing row only donates its createdAt so dedupe
          // keeps the original creation time.
          let createdAt = record.createdAt;
          const existing = await tx.get<StoredAssetRow>(store, record.sha256);
          if (existing !== undefined) {
            try {
              createdAt = validateStoredAssetRow(store, record.sha256, existing).record.createdAt;
            } catch (error) {
              if (!(error instanceof CorruptRecordError)) throw error;
              console.warn(
                `Import will replace corrupt asset row "${record.sha256}":`,
                error.cause ?? error,
              );
            }
          }
          await tx.put<StoredAssetRow>(store, record.sha256, {
            record: { ...record, createdAt },
            blob,
          });
          await tx.delete("staging", stagingKey);
        }
        await tx.put("projects", installed.id, installed);
        // Delete every row in the area, including migration-era keys and any
        // orphan a crashed old writer omitted from its metadata.
        for (const key of await tx.getAllKeys("staging")) {
          if (key === stagingId || key.startsWith(`${stagingId}:asset:`)) {
            await tx.delete("staging", key);
          }
        }
      },
      signal,
    );
    // No post-commit signal check: tx.done resolving is the atomic terminal
    // event. Cancellation before that point rolls back; after it, success is
    // truthful because the project and assets are already durably visible.
    return installed;
  }

  private async abort(stagingId: Id): Promise<void> {
    await this.backend.transaction(["staging"], async (tx) => {
      // Prefix cleanup is idempotent and migration-compatible: it removes
      // qualified current rows, legacy digest-only rows, and orphan rows whose
      // metadata update never landed before a crash.
      for (const key of await tx.getAllKeys("staging")) {
        if (key === stagingId || key.startsWith(`${stagingId}:asset:`)) {
          await tx.delete("staging", key);
        }
      }
    });
  }

  /**
   * Delete staging areas (and their staged rows) older than `maxAgeMs` —
   * leftovers of imports interrupted by a crash. Returns swept area count.
   */
  async sweepAbandonedStaging(maxAgeMs: number = STAGING_ABANDONED_AFTER_MS): Promise<number> {
    const cutoff = this.now() - maxAgeMs;
    let swept = 0;
    await this.backend.transaction(["staging"], async (tx) => {
      const rows = await tx.getAll<StagingRow>("staging");
      const abandoned = new Set(
        rows
          .filter((row): row is StagingMetaRow => row.type === "meta" && row.createdAt <= cutoff)
          .map((row) => row.stagingId),
      );
      swept = abandoned.size;
      const liveMeta = new Set(
        rows
          .filter((row): row is StagingMetaRow => row.type === "meta" && row.createdAt > cutoff)
          .map((row) => row.stagingId),
      );
      for (const key of await tx.getAllKeys("staging")) {
        const owner = key.split(":asset:", 1)[0];
        if (abandoned.has(owner) || (key.includes(":asset:") && !liveMeta.has(owner))) {
          await tx.delete("staging", key);
        }
      }
      for (const stagingId of abandoned) await tx.delete("staging", stagingId);
    });
    return swept;
  }
}
