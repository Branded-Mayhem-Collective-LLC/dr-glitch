/**
 * AssetRepository: immutable content-addressed asset bytes (raster, canonical
 * SVG, thumbnails) keyed by SHA-256, with dedupe on write and mark-and-sweep
 * garbage collection. Thumbnails live in their own store but share the same
 * addressing and GC.
 *
 * GC roots are every sha referenced by live projects (which includes trashed
 * projects, since Trash keeps envelopes in the projects store), snapshots
 * and their thumbnails, recovery records, and staging areas — plus any
 * caller-supplied session roots (in-memory references that have not reached
 * a durable row yet). A referenced asset is never collected.
 *
 * CONCURRENCY DESIGN (see garbageCollect): one transaction over every root
 * store AND both asset stores, so the root scan and the sweep observe one
 * serialized view, combined with an age grace window for references that
 * exist only in some tab's memory at scan time.
 */
import type {
  AssetKind,
  AssetRecordV1,
  ProjectCoreV1,
  ProjectEnvelopeV1,
  Sha256,
  SnapshotV1,
} from "../core/types";
import { RESOURCE_POLICY } from "../core/resource-policy";
import type { BackendTransaction, StorageBackend } from "./backend";
import type { StoreName, StoredAssetRow } from "./schema";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { CorruptRecordError, NotFoundError, StorageError, isQuotaExceededError } from "./errors";
import { isSha256Hex, sha256HexAbortable } from "../io/sha256";
import { sha256Hex } from "./sha256";
import { validateStoredAssetRow } from "./validate";
import { validateRaster, RasterValidationError } from "../io/raster-validator";
import { validateRasterPayload, type RasterDecoder } from "../io/raster-decoder";
import { sanitizeSvg, SvgValidationError, SVG_PROFILE_LIMITS, type SvgProfile } from "../io/svg-sanitizer";

export type AssetDimensions = { width: number; height: number };

/**
 * One immutable IndexedDB row snapshot for export. `record` and the Blob
 * captured by `readBytes` come from the same structural read, so a later
 * same-key replacement cannot pair new metadata with old bytes (or vice
 * versa). The body is deliberately one-shot and remains unmaterialized until
 * the caller has applied every metadata-only allocation gate.
 */
export type AssetExportSnapshot = {
  readonly record: Readonly<AssetRecordV1>;
  readBytes(signal?: AbortSignal): Promise<Uint8Array>;
};

/**
 * One bound raster row for a consumer that will perform the actual native
 * image decode. `verify()` hashes and header-validates the captured Blob but
 * deliberately does not invoke AssetRepository's decoder: the consuming
 * Image/ImageBitmap is the sole full payload decode.
 */
export type RasterDecodeSnapshot = {
  readonly record: Readonly<AssetRecordV1>;
  verify(signal?: AbortSignal): Promise<Blob>;
};

function abortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "Aborted",
    "AbortError",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Settle the caller promptly on abort while the provider receives cleanup separately. */
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

/** Read a Blob once with cooperative cancellation and one final allocation. */
async function readBlobBytes(
  blob: Blob,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const reader = blob.stream().getReader();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await raceWithAbort(reader.read(), signal);
      throwIfAborted(signal);
      if (done) break;
      if (offset + value.byteLength > output.byteLength) {
        throw new Error("Asset body grew beyond its bound metadata snapshot.");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== output.byteLength) {
      throw new Error(
        `Asset body ended at ${offset} bytes; its bound metadata declares ${output.byteLength}.`,
      );
    }
    return output;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* an aborted pending read retains the lock until cancel settles */ }
  }
}

/** Granular integrity failures from the verified-read API. */
export type AssetIntegrityCode =
  | "asset-missing-blob"
  | "asset-hash-mismatch"
  | "asset-kind-mismatch"
  | "asset-dimensions-mismatch"
  /** Raster payload failed a FULL decode through the configured decoder. */
  | "asset-decode-failed"
  /** Stored content violates its kind's strict content rules (e.g. SVG that is not canonical sanitized markup). */
  | "asset-content-invalid";

/**
 * A stored asset failed cryptographic/content verification. `integrity`
 * carries the granular cause; consumers (export preflight, AssetCache
 * priming) branch on it instead of trusting at-rest bytes.
 */
export class AssetIntegrityError extends StorageError {
  readonly integrity: AssetIntegrityCode;
  readonly sha256: Sha256;

  constructor(integrity: AssetIntegrityCode, sha256: Sha256, detail: string) {
    super(integrity, `Asset ${sha256}: ${detail}`);
    this.name = "AssetIntegrityError";
    this.integrity = integrity;
    this.sha256 = sha256;
  }
}

const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SVG_MIME = "image/svg+xml";

type AssetRootSets = {
  assets: Set<Sha256>;
  thumbnails: Set<Sha256>;
};

function createAssetRootSets(): AssetRootSets {
  return { assets: new Set<Sha256>(), thumbnails: new Set<Sha256>() };
}

function addCoreRefs(core: ProjectCoreV1, roots: AssetRootSets): void {
  for (const layer of core.layers) {
    roots.assets.add(layer.assetId);
    if (layer.recipe.halftone.customShapeAssetId) {
      roots.assets.add(layer.recipe.halftone.customShapeAssetId);
    }
  }
  if (core.registration.customShapeAssetId) {
    roots.assets.add(core.registration.customShapeAssetId);
  }
}

function addSnapshotRefs(snapshots: SnapshotV1[], roots: AssetRootSets): void {
  for (const snapshot of snapshots) {
    if (snapshot.thumbnailId) roots.thumbnails.add(snapshot.thumbnailId);
    addCoreRefs(snapshot.core, roots);
  }
}

/**
 * Every sha a project envelope keeps alive (layers, halftone custom dots,
 * registration custom marks, snapshot cores, snapshot thumbnails). For
 * TRUSTED in-memory envelopes (open project stores, unsaved projects) —
 * at-rest rows go through the strict scan below instead.
 */
export function collectEnvelopeAssetRefs(envelope: ProjectEnvelopeV1): Set<Sha256> {
  const byStore = createAssetRootSets();
  addCoreRefs(envelope.core, byStore);
  addSnapshotRefs(envelope.snapshots, byStore);
  return new Set([...byStore.assets, ...byStore.thumbnails]);
}

/**
 * GC aborted before any deletion because a durable root row could not be
 * read as reference-bearing structure. CONSERVATIVE by design: an
 * incomplete root scan must retain everything — sweeping against partial
 * roots is how live blobs get lost.
 */
export class GcRootScanError extends StorageError {
  /** Root store holding the unreadable row. */
  readonly store: string;
  /** Best-effort key of the unreadable row (null when unrecoverable). */
  readonly key: string | null;

  constructor(store: string, key: string | null, detail: string) {
    super(
      "gc-root-scan-failed",
      `Asset GC aborted (everything retained): unreadable ${store} row${key ? ` "${key}"` : ""}: ${detail}`,
    );
    this.name = "GcRootScanError";
    this.store = store;
    this.key = key;
  }
}

/* ---- strict at-rest root walk -------------------------------------- */
/* At-rest rows are untrusted (corruption threat model, see validate.ts).
 * The GC root scan extracts asset references with STRICT structural checks
 * on every reference-bearing field: any malformed field aborts the whole
 * collection via GcRootScanError, because a row we cannot read completely
 * may reference assets we cannot see. Fields that carry no references
 * (guides, recipes' numeric knobs, titles, …) are deliberately not
 * validated here — damage to them cannot hide a reference. */

function strictSha(value: unknown, what: string): Sha256 {
  if (!isSha256Hex(value)) throw new Error(`${what} is not a sha256 digest`);
  return value;
}

function strictOptionalSha(value: unknown, what: string, roots: Set<Sha256>): void {
  if (value === null || value === undefined) return;
  roots.add(strictSha(value, what));
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function strictCoreRefs(value: unknown, what: string, roots: AssetRootSets): void {
  const core = asRecord(value, what);
  if (!Array.isArray(core.layers)) throw new Error(`${what}.layers is not an array`);
  core.layers.forEach((layerValue, index) => {
    const layer = asRecord(layerValue, `${what}.layers[${index}]`);
    roots.assets.add(strictSha(layer.assetId, `${what}.layers[${index}].assetId`));
    const recipe = asRecord(layer.recipe, `${what}.layers[${index}].recipe`);
    const halftone = asRecord(recipe.halftone, `${what}.layers[${index}].recipe.halftone`);
    strictOptionalSha(
      halftone.customShapeAssetId,
      `${what}.layers[${index}].recipe.halftone.customShapeAssetId`,
      roots.assets,
    );
  });
  const registration = asRecord(core.registration, `${what}.registration`);
  strictOptionalSha(
    registration.customShapeAssetId,
    `${what}.registration.customShapeAssetId`,
    roots.assets,
  );
}

function strictSnapshotRefs(value: unknown, what: string, roots: AssetRootSets): void {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  value.forEach((snapshotValue, index) => {
    const snapshot = asRecord(snapshotValue, `${what}[${index}]`);
    strictOptionalSha(snapshot.thumbnailId, `${what}[${index}].thumbnailId`, roots.thumbnails);
    strictCoreRefs(snapshot.core, `${what}[${index}].core`, roots);
  });
}

function strictEnvelopeRefs(value: unknown, what: string, roots: AssetRootSets): void {
  const envelope = asRecord(value, what);
  strictCoreRefs(envelope.core, `${what}.core`, roots);
  strictSnapshotRefs(envelope.snapshots, `${what}.snapshots`, roots);
}

/** Anything with per-store getAll: a StorageBackend or a BackendTransaction. */
export type RootsReader = {
  getAll<T>(store: StoreName): Promise<T[]>;
};

function bestEffortKey(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const candidate = (row as { id?: unknown; projectId?: unknown; stagingId?: unknown });
  for (const value of [candidate.id, candidate.projectId, candidate.stagingId]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Durable GC roots, strictly scanned:
 *  - projects: every envelope (live AND trash-retained — Trash keeps the
 *    envelope in the projects store for its 30-day window), covering layer
 *    assets, halftone/registration custom shapes, snapshot cores, and
 *    snapshot thumbnails;
 *  - recovery: the same reference walk over journaled core + snapshots;
 *  - staging: every ACTIVE import area — its declared assetShas, its staged
 *    asset rows, and any envelope the candidate already references.
 *
 * NOT roots, verified: presets (the .drpreset serializer and parser both
 * null customShapeAssetId, and validateStoredPreset round-trips rows
 * through them, so no consumer can ever observe an asset id from a preset
 * row — presets keep their custom dot as inline SVG text); trash rows
 * (marker only — the envelope in the projects store carries the refs);
 * leases (no asset fields).
 *
 * Throws GcRootScanError on ANY malformed reference-bearing field.
 */
async function collectAllAssetRootsByStore(reader: RootsReader): Promise<AssetRootSets> {
  const roots = createAssetRootSets();

  const envelopes = await reader.getAll<unknown>("projects");
  for (const row of envelopes) {
    try {
      strictEnvelopeRefs(row, "envelope", roots);
    } catch (error) {
      throw new GcRootScanError("projects", bestEffortKey(row), (error as Error).message);
    }
  }

  const recoveries = await reader.getAll<unknown>("recovery");
  for (const row of recoveries) {
    try {
      const record = asRecord(row, "recovery record");
      strictCoreRefs(record.core, "recovery.core", roots);
      strictSnapshotRefs(record.snapshots, "recovery.snapshots", roots);
    } catch (error) {
      throw new GcRootScanError("recovery", bestEffortKey(row), (error as Error).message);
    }
  }

  const stagingRows = await reader.getAll<unknown>("staging");
  for (const row of stagingRows) {
    try {
      const record = asRecord(row, "staging row");
      if (record.type === "meta") {
        const hasCurrent = record.assetRefs !== undefined;
        const hasLegacy = record.assetShas !== undefined;
        if (!hasCurrent && !hasLegacy) {
          throw new Error("meta has neither assetRefs nor legacy assetShas");
        }
        if (hasCurrent) {
          if (!Array.isArray(record.assetRefs)) throw new Error("meta.assetRefs is not an array");
          record.assetRefs.forEach((value, index) => {
            const ref = asRecord(value, `meta.assetRefs[${index}]`);
            if (ref.store !== "assets" && ref.store !== "thumbnails") {
              throw new Error(`meta.assetRefs[${index}].store is invalid`);
            }
            roots[ref.store].add(strictSha(ref.sha256, `meta.assetRefs[${index}].sha256`));
          });
        }
        if (hasLegacy) {
          if (!Array.isArray(record.assetShas)) throw new Error("meta.assetShas is not an array");
          record.assetShas.forEach((sha, index) => {
            const digest = strictSha(sha, `meta.assetShas[${index}]`);
            // Legacy metadata did not preserve the destination. Retain both
            // stores conservatively until the old staging area is committed
            // or swept; cleanup still understands its digest-only row key.
            roots.assets.add(digest);
            roots.thumbnails.add(digest);
          });
        }
        if (record.envelope !== null && record.envelope !== undefined) {
          strictEnvelopeRefs(record.envelope, "meta.envelope", roots);
        }
      } else if (record.type === "asset") {
        const asset = asRecord(record.asset, "staged asset");
        const assetRecord = asRecord(asset.record, "staged asset.record");
        const destination = record.destination ??
          (assetRecord.kind === "thumbnail" ? "thumbnails" : "assets");
        if (destination !== "assets" && destination !== "thumbnails") {
          throw new Error("staged asset.destination is invalid");
        }
        roots[destination].add(strictSha(assetRecord.sha256, "staged asset.record.sha256"));
      } else {
        throw new Error(`unknown staging row type ${JSON.stringify(record.type)}`);
      }
    } catch (error) {
      throw new GcRootScanError("staging", bestEffortKey(row), (error as Error).message);
    }
  }

  return roots;
}

/**
 * Compatibility union used by diagnostics/tests and session-root callers.
 * The collector itself remains store-aware; garbageCollect consumes the
 * qualified sets so a thumbnail reference does not accidentally root an
 * unrelated artwork row with identical bytes.
 */
export async function collectAllAssetRoots(reader: RootsReader): Promise<Set<Sha256>> {
  const roots = await collectAllAssetRootsByStore(reader);
  return new Set([...roots.assets, ...roots.thumbnails]);
}

export type GarbageCollectResult = {
  /** Digests removed from the assets store. */
  removedAssets: Sha256[];
  /** Digests removed from the thumbnails store. */
  removedThumbnails: Sha256[];
  /** Unreferenced digests RETAINED because they are younger than the grace
   * window (a concurrent operation may be about to reference them). */
  retainedRecent: Sha256[];
};

/**
 * Unreferenced assets younger than this are retained. Aligned with
 * STAGING_ABANDONED_AFTER_MS: the system already presumes any cross-tab
 * operation silent for an hour is dead, and every write-then-reference flow
 * (putBlob → save, thumbnail capture → snapshot add) closes its gap orders
 * of magnitude faster than this.
 */
export const ASSET_GC_GRACE_MS = 60 * 60 * 1000;

export type GarbageCollectOptions = {
  /**
   * Session roots: shas referenced ONLY in memory right now (the open
   * project's working envelope, never-saved projects). Durable rows cannot
   * see these, so the caller that owns the in-memory state must supply them.
   */
  extraRoots?: Iterable<Sha256>;
  /** Grace window override (tests). Defaults to ASSET_GC_GRACE_MS. */
  graceMs?: number;
};

/** Stores the GC transaction must span: every durable root store plus both
 * asset stores, so no writer can change either side mid-collection. */
const GC_STORES: StoreName[] = ["projects", "recovery", "staging", "assets", "thumbnails"];

export type AssetRepositoryOptions = {
  now?: Clock;
  /**
   * Full raster decode adapter for at-rest verification and writes. When
   * configured, verifyAsset()/getVerifiedBlob()/getVerifiedRecord() accept a
   * raster ONLY after its payload fully decodes with dimensions matching the
   * record, and putBlob() refuses undecodable raster bytes. Browser sessions
   * configure the real decoder (see AppSessionController); non-DOM callers
   * that need decode-strength verification must inject one explicitly —
   * without it verification stops at header + hash strength.
   */
  rasterDecoder?: RasterDecoder;
};

const SVG_ROLE_PROFILES: readonly SvgProfile[] = ["artwork", "custom-dot", "registration-mark"];

export class AssetRepository {
  private readonly now: Clock;
  private readonly rasterDecoder: RasterDecoder | null;

  constructor(
    private readonly backend: StorageBackend,
    options: AssetRepositoryOptions = {},
  ) {
    this.now = options.now ?? systemClock;
    this.rasterDecoder = options.rasterDecoder ?? null;
  }

  private storeFor(kind: AssetKind): "assets" | "thumbnails" {
    return kind === "thumbnail" ? "thumbnails" : "assets";
  }

  /**
   * Reads and structurally validates one stored row: record shape, key
   * match, blob present with byteLength agreeing with the record. Returns
   * undefined for a missing row; throws CorruptRecordError for a damaged one.
   */
  private async readRow(
    store: "assets" | "thumbnails",
    sha256: Sha256,
  ): Promise<StoredAssetRow | undefined> {
    const raw = await this.backend.get<unknown>(store, sha256);
    if (raw === undefined) return undefined;
    return validateStoredAssetRow(store, sha256, raw);
  }

  /**
   * Store immutable bytes content-addressed by SHA-256. Re-putting existing
   * content is a dedupe no-op that returns the existing record — but ONLY
   * after the existing row's bytes are re-hashed to the key. A structurally
   * broken OR poisoned (same length, wrong bytes) row is REPLACED with the
   * fresh, verified bytes: writes are the repair seam for at-rest damage.
   */
  async putBlob(
    bytes: Uint8Array | Blob,
    kind: AssetKind,
    mime: string,
    dimensions: AssetDimensions,
  ): Promise<AssetRecordV1> {
    const raw =
      bytes instanceof Uint8Array ? bytes : new Uint8Array(await bytes.arrayBuffer());
    // With a decoder configured, raster bytes must FULLY decode — and agree
    // with the caller-declared dimensions — before they may persist.
    if (this.rasterDecoder && kind !== "svg" && RASTER_MIMES.has(mime)) {
      const info = await validateRasterPayload(raw, {
        declaredType: mime,
        decoder: this.rasterDecoder,
      });
      if (info.width !== dimensions.width || info.height !== dimensions.height) {
        throw new RasterValidationError(
          "raster-decode-dimensions",
          `Decoded dimensions ${info.width}x${info.height} disagree with the declared ${dimensions.width}x${dimensions.height}.`,
        );
      }
    }
    const sha256 = await sha256Hex(raw);
    const store = this.storeFor(kind);
    try {
      const existing = await this.readRow(store, sha256);
      if (existing) {
        const digest = await sha256Hex(new Uint8Array(await existing.blob.arrayBuffer()));
        if (digest === sha256) {
          // Dedupe hit: refresh the row's recency BEFORE returning. The
          // existing row may be an orphan about to be re-referenced (same
          // bytes re-imported); its createdAt can be arbitrarily old, so
          // without this touch a concurrent GC in ANOTHER tab could sweep
          // it between this return and the caller's reference landing in a
          // durable row. Best-effort under quota pressure: dedupe must not
          // start failing when storage is full (no new bytes are added).
          try {
            await this.backend.put<StoredAssetRow>(store, sha256, {
              ...existing,
              touchedAt: this.now(),
            });
          } catch (error) {
            if (!isQuotaExceededError(error)) throw error;
          }
          return existing.record;
        }
        console.warn(
          `Repairing poisoned asset row "${sha256}": stored bytes hash to ${digest}`,
        );
      }
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      console.warn(`Replacing corrupt asset row "${sha256}":`, error.cause ?? error);
    }
    const record: AssetRecordV1 = {
      sha256,
      kind,
      mime,
      byteLength: raw.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      createdAt: this.now(),
    };
    const blob = bytes instanceof Blob ? bytes : new Blob([raw.slice()], { type: mime });
    await this.backend.put<StoredAssetRow>(store, sha256, { record, blob });
    return record;
  }

  /**
   * Returns the stored bytes after structural validation. Pass
   * `verifyHash: true` for cryptographic certainty: the bytes are re-hashed
   * and a digest mismatch surfaces as CorruptRecordError instead of handing
   * back tampered content.
   */
  async getBlob(
    sha256: Sha256,
    kind: AssetKind = "raster",
    options: { verifyHash?: boolean } = {},
  ): Promise<Blob> {
    const store = this.storeFor(kind);
    const row = await this.readRow(store, sha256);
    if (!row) throw new NotFoundError("asset", sha256);
    if (options.verifyHash) {
      const digest = await sha256Hex(new Uint8Array(await row.blob.arrayBuffer()));
      if (digest !== sha256) {
        throw new CorruptRecordError(store, sha256, {
          cause: new Error(`stored bytes hash to ${digest}, expected ${sha256}`),
        });
      }
    }
    return row.blob;
  }

  async getRecord(sha256: Sha256, kind: AssetKind = "raster"): Promise<AssetRecordV1 | undefined> {
    const row = await this.readRow(this.storeFor(kind), sha256);
    return row?.record;
  }

  /**
   * Capture metadata and its body handle from one storage row. Unlike a
   * getRecord()+getBlob() pair this has no TOCTOU window: callers validate the
   * captured record first, then materialize exactly that row's Blob once.
   */
  async openExportSnapshot(
    sha256: Sha256,
    kind: AssetKind = "raster",
    signal?: AbortSignal,
  ): Promise<AssetExportSnapshot | undefined> {
    throwIfAborted(signal);
    const row = await raceWithAbort(this.readRow(this.storeFor(kind), sha256), signal);
    throwIfAborted(signal);
    if (!row) return undefined;
    const record = Object.freeze({ ...row.record });
    const blob = row.blob;
    let consumed = false;
    return {
      record,
      async readBytes(readSignal = signal) {
        if (consumed) throw new Error(`Asset snapshot ${sha256} body was already consumed.`);
        consumed = true;
        // The archive packager admits its decode window before validating
        // these bytes. Reading a snapshot must not secretly decode first.
        const bytes = await readBlobBytes(blob, record.byteLength, readSignal);
        return bytes;
      },
    };
  }

  /**
   * Capture and verify a raster decode candidate without a throwaway native
   * decode. Metadata gates run before the encoded-body allocation; hash and
   * header validation are bound to the same row/Blob returned to the caller.
   */
  openRasterDecodeSnapshot(
    sha256: Sha256, kind: "raster" | "thumbnail" = "raster", signal?: AbortSignal,
  ): Promise<RasterDecodeSnapshot> {
    return this.openDecodeSnapshot(sha256, kind, signal, false);
  }

  /** Artwork may be a raster or strictly canonical SVG; thumbnails remain PNG-only. */
  openArtworkDecodeSnapshot(
    sha256: Sha256, kind: "raster" | "thumbnail" = "raster", signal?: AbortSignal,
  ): Promise<RasterDecodeSnapshot> {
    return this.openDecodeSnapshot(sha256, kind, signal, kind !== "thumbnail");
  }

  private async openDecodeSnapshot(
    sha256: Sha256, kind: "raster" | "thumbnail", signal: AbortSignal | undefined, allowSvg: boolean,
  ): Promise<RasterDecodeSnapshot> {
    throwIfAborted(signal);
    const row = await raceWithAbort(this.readRow(this.storeFor(kind), sha256), signal);
    throwIfAborted(signal);
    if (!row) throw new NotFoundError("asset", sha256);
    const record = Object.freeze({ ...row.record });
    const svg = allowSvg && record.kind === "svg" && record.mime === "image/svg+xml";
    if (
      (!svg && (record.kind === "svg" || !RASTER_MIMES.has(record.mime))) ||
      !Number.isSafeInteger(record.byteLength) ||
      record.byteLength <= 0 ||
      record.byteLength > (svg ? SVG_PROFILE_LIMITS.artwork.maxBytes : RESOURCE_POLICY.maxRasterBytes) ||
      !Number.isSafeInteger(record.width) ||
      !Number.isSafeInteger(record.height) ||
      record.width <= 0 ||
      record.height <= 0 ||
      record.width * record.height > RESOURCE_POLICY.maxRasterPixels
    ) {
      throw new AssetIntegrityError(
        "asset-kind-mismatch",
        sha256,
        "stored artwork metadata violates the decode policy",
      );
    }
    const blob = row.blob;
    let consumed = false;
    return {
      record,
      async verify(readSignal = signal) {
        if (consumed) throw new Error(`Raster decode snapshot ${sha256} was already consumed.`);
        consumed = true;
        const bytes = await readBlobBytes(blob, record.byteLength, readSignal);
        const digest = await sha256HexAbortable(bytes, () => throwIfAborted(readSignal));
        if (digest !== sha256) {
          throw new AssetIntegrityError(
            "asset-hash-mismatch",
            sha256,
            `stored bytes hash to ${digest}`,
          );
        }
        let info;
        try {
          if (svg) {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            info = sanitizeSvg(text, "artwork");
            if (info.svg !== text) throw new Error("Stored SVG is not canonical.");
          } else {
            info = validateRaster(bytes, { declaredType: record.mime });
          }
        } catch (error) {
          if (error instanceof RasterValidationError || error instanceof SvgValidationError) {
            throw new AssetIntegrityError(
              "asset-kind-mismatch",
              sha256,
              `bytes do not match ${record.mime} (${error.code})`,
            );
          }
          throw error;
        }
        if (info.width !== record.width || info.height !== record.height) {
          throw new AssetIntegrityError(
            "asset-dimensions-mismatch",
            sha256,
            `header says ${info.width}x${info.height}, record says ${record.width}x${record.height}`,
          );
        }
        throwIfAborted(readSignal);
        return blob;
      },
    };
  }

  /**
   * Verified read: structural row validation, SHA-256 recompute over the
   * stored bytes, and content agreement (raster magic/header dimensions vs
   * the record; SVG kind/mime coherence). Failures surface as granular
   * typed AssetIntegrityError codes.
   *
   * DELIBERATELY UNCACHED: an IDB row can be swapped by any same-origin
   * writer between reads (same-length poison defeats structural rechecks),
   * so every verified read hashes the CURRENT bytes. Consumers that need
   * caching hold on to the verified BYTES themselves (immutable in-memory
   * copies), never a verification decision keyed to a mutable row.
   *
   * SVG note: kind/mime coherence and UTF-8 well-formedness are checked
   * here; PROFILE-level sanitization (custom-dot vs registration-mark
   * limits) is contextual and stays with the consumer that knows which
   * profile applies.
   */
  async verifyAsset(
    sha256: Sha256,
    kind: AssetKind = "raster",
  ): Promise<StoredAssetRow> {
    const store = this.storeFor(kind);
    const raw = await this.backend.get<unknown>(store, sha256);
    if (raw === undefined) throw new NotFoundError("asset", sha256);
    // Granular missing-blob signal before the generic structural check.
    if (
      typeof raw === "object" &&
      raw !== null &&
      !(((raw as { blob?: unknown }).blob) instanceof Blob)
    ) {
      throw new AssetIntegrityError("asset-missing-blob", sha256, "stored row has no blob");
    }
    const row = validateStoredAssetRow(store, sha256, raw);
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    const digest = await sha256Hex(bytes);
    if (digest !== sha256) {
      throw new AssetIntegrityError(
        "asset-hash-mismatch",
        sha256,
        `stored bytes hash to ${digest}`,
      );
    }

    const { record } = row;
    if (RASTER_MIMES.has(record.mime)) {
      if (record.kind === "svg") {
        throw new AssetIntegrityError(
          "asset-kind-mismatch",
          sha256,
          `kind "svg" cannot carry ${record.mime} bytes`,
        );
      }
      let info;
      try {
        // With a decoder configured, at-rest verification is FULL content
        // validation: header gates plus a complete payload decode whose
        // dimensions must equal the header. Without one, verification stops
        // at header + hash strength (see AssetRepositoryOptions).
        info = this.rasterDecoder
          ? await validateRasterPayload(bytes, {
              declaredType: record.mime,
              decoder: this.rasterDecoder,
            })
          : validateRaster(bytes, { declaredType: record.mime });
      } catch (error) {
        if (error instanceof RasterValidationError) {
          const decodeFailure =
            error.code === "raster-decode-failed" ||
            error.code === "raster-decode-dimensions" ||
            error.code === "raster-decode-unavailable";
          throw new AssetIntegrityError(
            decodeFailure ? "asset-decode-failed" : "asset-kind-mismatch",
            sha256,
            `bytes do not match ${record.mime} (${error.code})`,
          );
        }
        throw error;
      }
      if (info.width !== record.width || info.height !== record.height) {
        throw new AssetIntegrityError(
          "asset-dimensions-mismatch",
          sha256,
          `header says ${info.width}x${info.height}, record says ${record.width}x${record.height}`,
        );
      }
    } else if (record.mime === SVG_MIME) {
      if (record.kind !== "svg") {
        throw new AssetIntegrityError(
          "asset-kind-mismatch",
          sha256,
          `kind "${record.kind}" cannot carry SVG markup`,
        );
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AssetIntegrityError("asset-kind-mismatch", sha256, "SVG bytes are not valid UTF-8");
      }
      // Strict at-rest SVG rule — the SAME rule the sanitizer enforces at
      // intake (finite positive bounds, pixel-area ceiling, allowlist):
      // stored markup must be a canonical fixed point for at least one
      // profile. Legitimately imported SVGs always are; anything else fails
      // closed here before a consumer can decode or rasterize it.
      const canonical = SVG_ROLE_PROFILES.some((profile) => {
        try {
          return sanitizeSvg(text, profile).svg === text;
        } catch (error) {
          if (error instanceof SvgValidationError) return false;
          throw error;
        }
      });
      if (!canonical) {
        throw new AssetIntegrityError(
          "asset-content-invalid",
          sha256,
          "stored SVG is not canonical sanitized markup",
        );
      }
    } else {
      throw new AssetIntegrityError(
        "asset-kind-mismatch",
        sha256,
        `unsupported stored mime "${record.mime}"`,
      );
    }

    return row;
  }

  /** Verified bytes (see verifyAsset). */
  async getVerifiedBlob(sha256: Sha256, kind: AssetKind = "raster"): Promise<Blob> {
    return (await this.verifyAsset(sha256, kind)).blob;
  }

  /** Verified record (see verifyAsset). */
  async getVerifiedRecord(sha256: Sha256, kind: AssetKind = "raster"): Promise<AssetRecordV1> {
    return (await this.verifyAsset(sha256, kind)).record;
  }

  /**
   * STRUCTURAL existence only — NOT proof of byte integrity (no hash is
   * computed). Never gate a security decision on has(); use verifyAsset /
   * getVerifiedBlob where the bytes matter. A corrupt row reports false so
   * callers re-import (putBlob then repairs the row).
   */
  async has(sha256: Sha256, kind: AssetKind = "raster"): Promise<boolean> {
    try {
      return (await this.readRow(this.storeFor(kind), sha256)) !== undefined;
    } catch (error) {
      if (error instanceof CorruptRecordError) return false;
      throw error;
    }
  }

  /**
   * Mark-and-sweep: delete every stored asset/thumbnail whose sha is not in
   * the root set and whose row is older than the grace window.
   *
   * CONCURRENCY DESIGN — chosen: (a) root snapshot + orphan deletion inside
   * ONE transaction spanning ALL root stores and both asset stores, layered
   * with an age grace window. Justification:
   *  - The transaction (GC_STORES) makes scan and sweep one serialized unit
   *    on IndexedDB: an overlapping readwrite transaction on projects/
   *    recovery/staging/assets/thumbnails (saves, journal flushes, staging
   *    writes, import commits) either completes before the scan starts —
   *    and is seen — or queues until after the sweep. A reference written
   *    to any durable root store can therefore never land "between scan
   *    and sweep".
   *  - What NO transaction can see is a reference that exists only in some
   *    tab's memory at scan time: putBlob has returned but the envelope
   *    referencing the sha has not been saved/journaled yet. The grace
   *    window covers exactly that gap — an unreferenced row younger than
   *    graceMs (by createdAt, or touchedAt for a dedupe re-put) is
   *    retained, and any legitimate write-then-reference flow closes its
   *    gap in seconds, not the hour the grace allows. Long-lived in-memory
   *    references (an unsaved sample project open for hours) must be passed
   *    as extraRoots by the session owner.
   *
   * CONSERVATIVE FAILURE: any unreadable root row throws GcRootScanError
   * from inside the transaction — the backend rolls back and nothing at all
   * is deleted; sweeping on an incomplete scan is never allowed. A corrupt
   * NON-root row (an asset row that fails structural reads) is NOT
   * protected the same way: fresh legitimate writes are never corrupt, so
   * an unreferenced corrupt asset row is at-rest damage and is reclaimed.
   *
   * QUOTA/FAILURE SAFETY: the sweep only deletes; if the transaction fails
   * at any point everything rolls back to the pre-GC state, which is
   * exactly the retain-everything outcome. Idempotent: a second run over
   * the same state removes nothing new.
   */
  async garbageCollect(options: GarbageCollectOptions = {}): Promise<GarbageCollectResult> {
    const graceMs = options.graceMs ?? ASSET_GC_GRACE_MS;
    const sweepBefore = this.now() - graceMs;
    const extraRoots = new Set<Sha256>(options.extraRoots ?? []);
    const result: GarbageCollectResult = {
      removedAssets: [],
      removedThumbnails: [],
      retainedRecent: [],
    };
    await this.backend.transaction(GC_STORES, async (tx: BackendTransaction) => {
      // Root scan INSIDE the transaction: only tx ops are awaited (the
      // reference walk itself is synchronous), so IndexedDB auto-commit
      // rules are respected. Throws GcRootScanError -> full rollback.
      const roots = await collectAllAssetRootsByStore(tx);
      // Existing callers provide an unqualified union of in-memory refs.
      // Root both stores conservatively; durable roots above stay precise.
      for (const sha of extraRoots) {
        roots.assets.add(sha);
        roots.thumbnails.add(sha);
      }
      for (const store of ["assets", "thumbnails"] as const) {
        const keys = await tx.getAllKeys(store);
        for (const key of keys) {
          if (roots[store].has(key)) continue;
          const raw = await tx.get<unknown>(store, key);
          if (raw === undefined) continue;
          if (newestRowTimestamp(raw) > sweepBefore) {
            result.retainedRecent.push(key);
            continue;
          }
          await tx.delete(store, key);
          (store === "assets" ? result.removedAssets : result.removedThumbnails).push(key);
        }
      }
    });
    return result;
  }
}

/**
 * Newest recency signal a candidate orphan row carries: max of createdAt
 * and touchedAt where finite. A row carrying NO finite timestamp is
 * structurally damaged — fresh legitimate writes always carry one — so it
 * reports -Infinity and falls to the sweep once unreferenced.
 */
function newestRowTimestamp(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return -Infinity;
  const row = raw as { record?: { createdAt?: unknown }; touchedAt?: unknown };
  let newest = -Infinity;
  const createdAt = row.record?.createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    newest = Math.max(newest, createdAt);
  }
  if (typeof row.touchedAt === "number" && Number.isFinite(row.touchedAt)) {
    newest = Math.max(newest, row.touchedAt);
  }
  return newest;
}
