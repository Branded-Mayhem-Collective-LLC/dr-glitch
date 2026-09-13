/**
 * .drglitch project archive format.
 *
 * Layout (versioned ZIP):
 *   manifest.json                {format:"drglitch", schema:1, appVersion}
 *   project.json                 ProjectEnvelopeV1 (no history/recovery/workspace/accounts/presets)
 *   assets/<sha256>.<ext>        deduplicated source assets (png/jpg/jpeg/webp/svg)
 *   thumbnails/<sha256>.png      snapshot thumbnails
 *
 * Export writes the CURRENT schema only and captures the current working
 * state (savedRevision semantics are the caller's concern; exporting never
 * implies Save). Import validates everything before anything is installed:
 * manifest (future schemas rejected safely), full structural project
 * validation, per-asset hash recomputation, and per-kind content validation
 * (raster-validator / svg-sanitizer). Installation flows through a narrow
 * StagingSink so atomic staging storage can plug in, and always assigns a
 * NEW local project id.
 */
import { retainAllocation } from "../render/instrumentation";
import { RESOURCE_POLICY, type ResourcePolicy } from "../core/resource-policy";
import type { AssetKind, AssetRecordV1, Id, ProjectCoreV1, ProjectEnvelopeV1, Sha256 } from "../core/types";
import { ImportOperation, WorkingSetLedger } from "./operation";
import { defaultRasterDecoder, validateRasterPayload, type RasterDecoder } from "./raster-decoder";
import { validateRaster, RasterValidationError } from "./raster-validator";
import { sha256HexAbortable } from "./sha256";
import { sanitizeSvg, SvgValidationError, SVG_PROFILE_LIMITS, type SvgProfile } from "./svg-sanitizer";
import { DEFAULT_MAX_WORKING_SET_BYTES, openArchiveStream, type ArchiveStream } from "./zip-reader";
import { writeArchive, type ArchiveInputEntry } from "./zip-writer";
import { SchemaViolation, validateProjectEnvelope } from "./validate";

export const DRGLITCH_FORMAT = "drglitch";
export const DRGLITCH_SCHEMA = 1;

/** Byte cap on manifest.json, applied before an archive is emitted or parsed. */
export const DRGLITCH_MAX_MANIFEST_BYTES = 64 * 1024;

/** Byte cap on project.json, applied before an archive is emitted or parsed. */
export const DRGLITCH_MAX_PROJECT_BYTES = 8 * 1024 * 1024;

export type DrglitchErrorCode =
  | "manifest-missing"
  | "manifest-invalid"
  | "future-schema"
  | "project-missing"
  | "project-invalid"
  | "unexpected-entry"
  | "asset-missing"
  | "asset-hash-mismatch"
  | "asset-invalid"
  | "thumbnail-missing"
  | "thumbnail-invalid"
  // Export-side archive-policy refusals, named after the import-side
  // ArchiveValidationError codes that would reject the same archive.
  | "archive-entry-count"
  | "archive-uncompressed-quota"
  | "archive-working-set"
  | "archive-too-large"
  /* Frozen-plan execution divergence (wave G2 streamed export). */
  | "plan-mismatch";

export class DrglitchError extends Error {
  readonly code: DrglitchErrorCode;
  constructor(code: DrglitchErrorCode, message: string) {
    super(message);
    this.name = "DrglitchError";
    this.code = code;
  }
}

function fail(code: DrglitchErrorCode, message: string): never {
  throw new DrglitchError(code, message);
}

export type DrglitchManifest = {
  format: typeof DRGLITCH_FORMAT;
  schema: number;
  appVersion: string;
};

/** Build the two generated entries under the same limits the importer uses. */
function encodeExportMetadata(
  envelope: ProjectEnvelopeV1,
  appVersion: string,
): { manifestBytes: Uint8Array; projectBytes: Uint8Array } {
  if (typeof appVersion !== "string" || appVersion.length > 64) {
    fail("manifest-invalid", "Cannot export: appVersion must be a string of at most 64 characters.");
  }
  const encoder = new TextEncoder();
  const manifestBytes = encoder.encode(JSON.stringify({
    format: DRGLITCH_FORMAT,
    schema: DRGLITCH_SCHEMA,
    appVersion,
  } satisfies DrglitchManifest));
  if (manifestBytes.byteLength > DRGLITCH_MAX_MANIFEST_BYTES) {
    fail("manifest-invalid", `Cannot export: manifest.json exceeds ${DRGLITCH_MAX_MANIFEST_BYTES} bytes.`);
  }
  const projectBytes = encoder.encode(JSON.stringify(envelope));
  if (projectBytes.byteLength > DRGLITCH_MAX_PROJECT_BYTES) {
    fail("project-invalid", `Cannot export: project.json exceeds ${DRGLITCH_MAX_PROJECT_BYTES} bytes.`);
  }
  return { manifestBytes, projectBytes };
}

export type DrglitchAssetExt = "png" | "jpg" | "jpeg" | "webp" | "svg";

const ASSET_EXTENSIONS: readonly DrglitchAssetExt[] = ["png", "jpg", "jpeg", "webp", "svg"];

/* ------------------------------------------------------------------ */
/* Reference collection                                                */
/* ------------------------------------------------------------------ */

/** SVG profile an asset must satisfy per reference site; rasters use "artwork" only. */
type AssetRole = Extract<SvgProfile, "artwork" | "custom-dot" | "registration-mark">;

type References = {
  /** Every referenced source asset and the roles that reference it. */
  assets: Map<Sha256, Set<AssetRole>>;
  thumbnails: Set<Sha256>;
};

function collectCore(core: ProjectCoreV1, references: References): void {
  for (const layer of core.layers) {
    const roles = references.assets.get(layer.assetId) ?? new Set<AssetRole>();
    roles.add("artwork");
    references.assets.set(layer.assetId, roles);
    const dot = layer.recipe.halftone.customShapeAssetId;
    if (dot) {
      const dotRoles = references.assets.get(dot) ?? new Set<AssetRole>();
      dotRoles.add("custom-dot");
      references.assets.set(dot, dotRoles);
    }
  }
  const mark = core.registration.customShapeAssetId;
  if (mark) {
    const markRoles = references.assets.get(mark) ?? new Set<AssetRole>();
    markRoles.add("registration-mark");
    references.assets.set(mark, markRoles);
  }
}

/** All asset/thumbnail references across the main core and every snapshot core. */
export function collectAssetReferences(envelope: ProjectEnvelopeV1): { assets: Map<Sha256, Set<AssetRole>>; thumbnails: Set<Sha256> } {
  const references: References = { assets: new Map(), thumbnails: new Set() };
  collectCore(envelope.core, references);
  for (const snapshot of envelope.snapshots) {
    collectCore(snapshot.core, references);
    if (snapshot.thumbnailId) references.thumbnails.add(snapshot.thumbnailId);
  }
  return references;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export type DrglitchAssetSource = { bytes: Uint8Array; ext: DrglitchAssetExt };

/** Metadata needed to reject unsafe allocations before an archive body read. */
export type DrglitchSourceRecord = Pick<
  AssetRecordV1,
  "sha256" | "kind" | "mime" | "byteLength" | "width" | "height"
>;

/**
 * Record-bound body handle. The provider must capture `record` and the bytes
 * read by `readBytes` from one immutable storage-row snapshot. This closes the
 * getRecord/getBlob TOCTOU window while preserving metadata-first refusal.
 */
export type DrglitchBoundSource = {
  readonly record: Readonly<DrglitchSourceRecord>;
  readBytes(signal?: AbortSignal): Promise<Uint8Array>;
};

export type ExportDrglitchOptions = {
  /** Current working state; exporting captures it without implying Save. */
  envelope: ProjectEnvelopeV1;
  appVersion: string;
  /** Legacy unfrozen source hooks retained for deterministic codec tests. */
  getAsset?: (sha256: Sha256) => Promise<DrglitchAssetSource | null> | DrglitchAssetSource | null;
  getThumbnail?: (sha256: Sha256) => Promise<Uint8Array | null> | Uint8Array | null;
  /** Production/frozen path: metadata and body are one atomic row snapshot. */
  getBoundSource?: (
    sha256: Sha256,
    kind: "asset" | "thumbnail",
    signal?: AbortSignal,
  ) => Promise<DrglitchBoundSource | undefined>;
  policy?: ResourcePolicy;
  /** Same complete-decode boundary as import; browser default fails closed in Node. */
  decoder?: RasterDecoder;
  /**
   * Working-memory ceiling the produced archive must fit under (default
   * 512 MiB, matching the importer's default). The importer retains the
   * compressed archive plus one inflating entry at a time, so exports whose
   * compressed size + largest entry exceed this would produce a file a
   * default-options importer refuses to extract.
   */
  maxWorkingSetBytes?: number;
};

/**
 * Frozen-plan row assertion shared by BOTH delivery modes (buffered and
 * streamed): one plan, two packagers. Size divergence rejects typed
 * BEFORE the row is written — and callers check the PLANNED size before
 * even reading a body (two-stage order: cheap size/ext rejection first,
 * then the hash over the single body pass).
 */
function makePlanAssertion(plan: DrglitchExportPlan | undefined) {
  const byName = new Map<string, DrglitchExportPlanEntry>();
  if (plan) for (const entry of plan.entries) byName.set(entry.name, entry);
  return (name: string, byteLength: number): void => {
    if (!plan) return;
    const planned = byName.get(name);
    if (!planned || planned.byteLength !== byteLength) {
      fail(
        "plan-mismatch",
        `Cannot export: entry "${name}" diverged from the frozen plan ` +
          `(${byteLength} bytes vs planned ${planned?.byteLength ?? "absent"}); the project changed between planning and writing.`,
      );
    }
  };
}

/**
 * Export-side content validation: the SAME validators the importer runs.
 * The one asymmetry is intentional: the importer canonicalizes non-canonical
 * SVG and remaps references, but stored assets are supposed to be canonical
 * already, so the exporter refuses anything canonicalization would change.
 */
async function validateExportAsset(
  name: string,
  ext: DrglitchAssetExt,
  bytes: Uint8Array,
  roles: ReadonlySet<AssetRole>,
  policy: ResourcePolicy,
  options: {
    decoder?: RasterDecoder;
    signal?: AbortSignal;
    planned?: DrglitchExportPlanEntry;
    admit(windowBytes: number): void;
    thumbnail?: boolean;
  },
): Promise<void> {
  const code = options.thumbnail ? "thumbnail-invalid" : "asset-invalid";
  const needsSvg = roles.has("custom-dot") || roles.has("registration-mark");
  if (ext === "svg") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("asset-invalid", `Cannot export: SVG asset "${name}" is not valid UTF-8.`);
    }
    try {
      for (const role of roles) {
        if (sanitizeSvg(text, role).svg !== text) {
          fail("asset-invalid", `Cannot export: SVG asset "${name}" is not canonical; stored assets must already be canonical.`);
        }
      }
    } catch (error) {
      if (error instanceof DrglitchError) throw error;
      if (error instanceof SvgValidationError) {
        fail("asset-invalid", `Cannot export: SVG asset "${name}" was rejected (${error.code}): ${error.message}`);
      }
      throw error;
    }
  } else {
    if (needsSvg) {
      fail("asset-invalid", `Cannot export: asset "${name}" must be an SVG for custom-dot or registration use.`);
    }
    try {
      const header = validateRaster(bytes, { filename: name, policy });
      if (options.planned && (options.planned.width !== header.width || options.planned.height !== header.height)) {
        fail("plan-mismatch", `Cannot export: "${name}" dimensions differ from its frozen record.`);
      }
      // Admit the source plus both native encoded copies and the decoded
      // RGBA surface before asking the browser to decode any pixels.
      options.admit(rasterValidationWindow(bytes.length, header.width, header.height));
      const reservation = decodeReservation(retainAllocation(
        2 * bytes.byteLength + header.width * header.height * 4, "raster", "archive-native-validation",
      ));
      try {
        await validateRasterPayload(bytes, {
          filename: name, policy, decoder: options.decoder ?? defaultRasterDecoder(), signal: options.signal,
          onResourcesSettled: reservation.onResourcesSettled,
        });
      } finally { reservation.finish(); }
      checkExportAborted(options.signal);
    } catch (error) {
      checkExportAborted(options.signal);
      if (error instanceof RasterValidationError) {
        fail(code, `Cannot export: raster "${name}" was rejected (${error.code}): ${error.message}`);
      }
      throw error;
    }
  }
}

/** Refund a native decode only when its resources really settle, including after cancel. */
function decodeReservation(release: () => void) {
  let ownedByNative = false;
  return {
    onResourcesSettled(settled: Promise<void>) {
      ownedByNative = true;
      void settled.then(release, release);
    },
    finish() { if (!ownedByNative) release(); },
  };
}

/** Retained input + encoded buffer/Blob snapshots + one decoded RGBA surface. */
function rasterValidationWindow(bytes: number, width: number, height: number): number {
  return 3 * bytes + width * height * 4;
}

/**
 * Serialize the current schema only, deterministically ordered. Enforces the
 * archive policy the importer enforces (entry count, cumulative uncompressed
 * bytes, working-set ceiling, compressed size) and validates every referenced
 * asset/thumbnail's CONTENT with the importer's validators, so every archive
 * this function accepts is importable under the same policy.
 */
export async function exportDrglitch(
  options: ExportDrglitchOptions & { plan?: DrglitchExportPlan; signal?: AbortSignal },
): Promise<Uint8Array> {
  // Genuine buffered-path cancellation: checked between entries and inside
  // the hash checkpoints — a cancelled build settles without producing an
  // archive (the same contract as the streamed exporter).
  const checkAborted = (): void => {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const policy = options.policy ?? RESOURCE_POLICY;
  const maxWorkingSetBytes = options.maxWorkingSetBytes ?? DEFAULT_MAX_WORKING_SET_BYTES;
  // ONE PLAN, TWO DELIVERY MODES: when a frozen plan is passed, the
  // buffered packager enforces the same ordered manifest/TOCTOU contract
  // as the streamed one.
  const assertPlanned = makePlanAssertion(options.plan);
  let envelope: ProjectEnvelopeV1;
  if (options.plan) {
    envelope = options.plan.envelope;
  } else {
    try {
      // Reconstructive validation guarantees only schema fields are serialized —
      // history, recovery, workspace, and account data can never leak into the file.
      envelope = validateProjectEnvelope(options.envelope, policy);
    } catch (error) {
      if (error instanceof SchemaViolation) fail("project-invalid", `Cannot export: ${error.message}`);
      throw error;
    }
  }
  // Production buffered exports always carry a metadata-only frozen plan.
  // Refuse its full retained-input + pre-sized ZIP + delivery snapshot peak
  // before the first source body is materialized.
  if (options.plan && options.plan.bufferedPeakBytes > policy.maxRenderPeakBytes) {
    fail(
      "archive-working-set",
      `Cannot export buffered: the estimated ${options.plan.bufferedPeakBytes}-byte peak exceeds ` +
        `the ${policy.maxRenderPeakBytes}-byte in-memory export budget; use streamed delivery.`,
    );
  }
  const { manifestBytes, projectBytes } = encodeExportMetadata(envelope, options.appVersion);
  const entries: ArchiveInputEntry[] = [
    { name: "manifest.json", data: manifestBytes },
    { name: "project.json", data: projectBytes },
  ];
  const references = collectAssetReferences(envelope);
  // Fail fast on entry count, before fetching a single asset: the importer
  // would refuse the finished archive at the same quota.
  const totalEntries = entries.length + references.assets.size + references.thumbnails.size;
  if (totalEntries > policy.maxArchiveEntries) {
    fail("archive-entry-count", `Cannot export: the project needs ${totalEntries} archive entries but the policy allows ${policy.maxArchiveEntries}.`);
  }
  let totalBytes = 0;
  // Working-set guard seeded from the FROZEN plan so it reflects the
  // planned largest validation window before the first body ever arrives.
  let largestImportWindowBytes = options.plan?.largestImportWindowBytes ?? 0;
  const account = (name: string, byteLength: number): void => {
    totalBytes += byteLength;
    largestImportWindowBytes = Math.max(largestImportWindowBytes, byteLength);
    if (totalBytes > policy.maxArchiveUncompressedBytes) {
      fail("archive-uncompressed-quota", `Cannot export: entry "${name}" pushes the archive past ${policy.maxArchiveUncompressedBytes} uncompressed bytes.`);
    }
  };
  const validate = (name: string, ext: DrglitchAssetExt, bytes: Uint8Array, roles: ReadonlySet<AssetRole>, thumbnail = false) =>
    validateExportAsset(name, ext, bytes, roles, policy, {
      decoder: options.decoder, signal: options.signal, thumbnail,
      planned: options.plan?.entries.find((entry) => entry.name === name),
      admit: (windowBytes) => {
        largestImportWindowBytes = Math.max(largestImportWindowBytes, windowBytes);
        if (totalBytes + windowBytes > policy.maxRenderPeakBytes) {
          fail("archive-working-set", "Cannot export: complete raster validation exceeds the working-memory budget.");
        }
      },
    });
  for (const entry of entries) account(entry.name, entry.data.length);
  for (const sha256 of [...references.assets.keys()].sort()) {
    checkAborted();
    const roles = references.assets.get(sha256)!;
    const source = await loadDrglitchSource(options, sha256, "asset", roles, policy);
    const name = `assets/${sha256}.${source.ext}`;
    // TWO-STAGE ORDER: the cheap frozen-manifest size check rejects BEFORE
    // the body is hashed.
    assertPlanned(name, source.bytes.length);
    if ((await sha256HexAbortable(source.bytes, checkAborted)) !== sha256) {
      fail("asset-hash-mismatch", `Asset ${sha256} bytes do not match their content hash.`);
    }
    await validate(name, source.ext, source.bytes, roles);
    account(name, source.bytes.length);
    entries.push({ name, data: source.bytes, compress: source.ext === "svg" });
  }
  for (const sha256 of [...references.thumbnails].sort()) {
    checkAborted();
    const { bytes } = await loadDrglitchSource(
      options,
      sha256,
      "thumbnail",
      new Set<AssetRole>(),
      policy,
    );
    const name = `thumbnails/${sha256}.png`;
    assertPlanned(name, bytes.length);
    if ((await sha256HexAbortable(bytes, checkAborted)) !== sha256) {
      fail("asset-hash-mismatch", `Thumbnail ${sha256} bytes do not match their content hash.`);
    }
    await validate(name, "png", bytes, new Set<AssetRole>(), true);
    account(name, bytes.length);
    entries.push({ name, data: bytes, compress: false });
  }
  checkAborted();
  const archive = await writeArchive(entries, {
    signal: options.signal,
    initialCapacityBytes: options.plan?.estimatedBytes,
  });
  checkAborted();
  if (options.plan && archive.length > options.plan.estimatedBytes) {
    fail(
      "plan-mismatch",
      `Cannot export: the ${archive.length}-byte archive exceeded its ` +
        `${options.plan.estimatedBytes}-byte frozen size ceiling.`,
    );
  }
  // Stored/deflated entries plus headers can exceed the compressed cap even
  // when uncompressed totals fit; the importer checks the file size first.
  if (archive.length > policy.maxArchiveCompressedBytes) {
    fail("archive-too-large", `Cannot export: the archive is ${archive.length} bytes; the policy allows ${policy.maxArchiveCompressedBytes} compressed bytes.`);
  }
  // Mirror the importer's honest retained-memory model: it keeps the
  // compressed archive resident and inflates one entry at a time, so its
  // peak is archive size + largest extraction/decode window. Refuse to produce a file a
  // default-options importer would refuse to extract.
  if (archive.length + largestImportWindowBytes > maxWorkingSetBytes) {
    fail("archive-working-set", `Cannot export: the archive (${archive.length} bytes) plus its largest validation window (${largestImportWindowBytes} bytes) exceeds the ${maxWorkingSetBytes}-byte working-memory ceiling an importer would enforce.`);
  }
  return archive;
}

/* ------------------------------------------------------------------ */
/* Streamed export (wave G2)                                           */
/* ------------------------------------------------------------------ */

/** Byte sink for streamed .drglitch delivery (an FSA writable wrapper). */
export type DrglitchByteSink = {
  write(chunk: Uint8Array, signal?: AbortSignal): void | Promise<void>;
  /** Transactionally discard a partial delivery. Must be safe to call once. */
  abort?(reason?: unknown): void | Promise<void>;
};

/* ------------------------------------------------------------------ */
/* Frozen export plan (metadata-only; zero body reads)                 */
/* ------------------------------------------------------------------ */

export type DrglitchExportPlanEntry = {
  name: string;
  kind: "manifest" | "project" | "asset" | "thumbnail";
  sha256?: Sha256;
  ext?: DrglitchAssetExt;
  storageKind?: AssetKind;
  mime?: string;
  width?: number;
  height?: number;
  /** Exact metadata bytes, or the stored record's byteLength for bodies. */
  byteLength: number;
};

export type DrglitchExportPlan = {
  /** Validated, frozen envelope the execution must serialize verbatim. */
  envelope: ProjectEnvelopeV1;
  /** Ordered entry manifest execution revalidates against (TOCTOU gate). */
  entries: DrglitchExportPlanEntry[];
  /** Conservative delivered-size ceiling: stored-size worst case + ZIP
   *  local/central/descriptor overhead per entry. */
  estimatedBytes: number;
  largestEntryBytes: number;
  /** Largest importer window, including native raster validation residency. */
  largestImportWindowBytes: number;
  /** Sum of every entry body retained by the deterministic buffered writer. */
  totalEntryBytes: number;
  /**
   * Application-level buffered residency: all input entries plus one
   * pre-sized ZIP capacity and one returned ZIP/Blob snapshot, or the
   * largest native raster validation transient, whichever is larger.
   */
  bufferedPeakBytes: number;
};

/** Per-entry ZIP overhead ceiling: local + central headers, descriptor,
 *  and the entry name twice. */
const ZIP_ENTRY_OVERHEAD_BYTES = 128 + 128 + 24;

/** Deflate stored-size worst case: input + 5 B per 16 KiB block + slack. */
function storedSizeCeiling(bytes: number): number {
  return bytes + Math.ceil(bytes / 16_384) * 5 + 64;
}

const EXT_BY_MIME: Record<string, DrglitchAssetExt> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export type DrglitchPlanRecordSource = (
  sha256: Sha256,
  kind: "asset" | "thumbnail",
  signal?: AbortSignal,
) => Promise<DrglitchSourceRecord | undefined>;

type RecordFailureCode = Extract<
  DrglitchErrorCode,
  "asset-invalid" | "thumbnail-invalid" | "plan-mismatch"
>;

/** Apply every allocation-relevant row policy using metadata only. */
function validateSourceRecord(
  sha256: Sha256,
  kind: "asset" | "thumbnail",
  record: Readonly<DrglitchSourceRecord>,
  roles: ReadonlySet<AssetRole>,
  policy: ResourcePolicy,
  code: RecordFailureCode,
): DrglitchAssetExt {
  const reject = (detail: string): never =>
    fail(code, `Cannot export: ${kind} ${sha256} ${detail}`);
  if (record.sha256 !== sha256) reject("does not match its content-addressed key.");
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength <= 0) {
    reject("has an invalid stored byte length.");
  }
  if (
    !Number.isSafeInteger(record.width) ||
    !Number.isSafeInteger(record.height) ||
    record.width <= 0 ||
    record.height <= 0 ||
    !Number.isSafeInteger(record.width * record.height)
  ) {
    reject("has invalid stored dimensions.");
  }
  if (typeof record.mime !== "string" || record.mime.length === 0) {
    reject("has an invalid stored MIME type.");
  }
  const mime = record.mime.toLowerCase();
  if (kind === "thumbnail") {
    if (record.kind !== "thumbnail" || mime !== "image/png") {
      reject(`must be a PNG thumbnail row, not ${record.kind}/${record.mime}.`);
    }
    if (record.byteLength > policy.maxRasterBytes) reject("exceeds the raster byte policy.");
    if (record.width * record.height > policy.maxRasterPixels) reject("exceeds the raster pixel policy.");
    return "png";
  }

  const ext = EXT_BY_MIME[mime];
  if (!ext) reject(`has unsupported stored type ${record.mime}.`);
  const needsSvg = roles.has("custom-dot") || roles.has("registration-mark");
  if (ext === "svg") {
    if (record.kind !== "svg") reject(`has incoherent kind ${record.kind} for SVG bytes.`);
    const effectiveRoles = roles.size > 0 ? [...roles] : (["artwork"] as AssetRole[]);
    const byteCap = Math.min(...effectiveRoles.map((role) => SVG_PROFILE_LIMITS[role].maxBytes));
    const pixelCap = Math.min(...effectiveRoles.map((role) => SVG_PROFILE_LIMITS[role].maxPixelArea));
    if (record.byteLength > byteCap) reject(`exceeds the ${byteCap}-byte SVG profile cap.`);
    if (record.width * record.height > pixelCap) reject(`exceeds the SVG profile pixel cap.`);
  } else {
    if (record.kind !== "raster") reject(`has incoherent kind ${record.kind} for raster bytes.`);
    if (needsSvg) reject("must be SVG for custom-dot or registration use.");
    if (record.byteLength > policy.maxRasterBytes) reject("exceeds the raster byte policy.");
    if (record.width * record.height > policy.maxRasterPixels) reject("exceeds the raster pixel policy.");
  }
  return ext;
}

/** Compare an atomic execution snapshot against its frozen metadata plan. */
function assertBoundRecord(
  plan: DrglitchExportPlan | undefined,
  sha256: Sha256,
  kind: "asset" | "thumbnail",
  record: Readonly<DrglitchSourceRecord>,
  roles: ReadonlySet<AssetRole>,
  policy: ResourcePolicy,
): DrglitchAssetExt {
  const ext = validateSourceRecord(
    sha256,
    kind,
    record,
    roles,
    policy,
    plan ? "plan-mismatch" : kind === "thumbnail" ? "thumbnail-invalid" : "asset-invalid",
  );
  if (!plan) return ext;
  const planned = plan.entries.find((entry) => entry.sha256 === sha256 && entry.kind === kind);
  if (
    !planned ||
    planned.byteLength !== record.byteLength ||
    planned.ext !== ext ||
    planned.storageKind !== record.kind ||
    planned.mime !== record.mime.toLowerCase() ||
    planned.width !== record.width ||
    planned.height !== record.height
  ) {
    fail(
      "plan-mismatch",
      `Cannot export: ${kind} ${sha256} diverged from its frozen metadata snapshot before its body was read.`,
    );
  }
  return ext;
}

function exportAbortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "Aborted",
    "AbortError",
  );
}

function checkExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw exportAbortError(signal);
}

/** Caller-facing cancellation race; production providers also receive the signal. */
async function raceExport<T>(value: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const settled = Promise.resolve(value);
  if (!signal) return settled;
  checkExportAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(exportAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    settled.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

type LoadedDrglitchSource = { bytes: Uint8Array; ext: DrglitchAssetExt };

/**
 * Production execution opens one bound row, validates all metadata, and only
 * then invokes its one-shot body reader. Frozen plans deliberately refuse the
 * legacy split providers because they cannot close the record/body TOCTOU gap.
 */
async function loadDrglitchSource(
  options: ExportDrglitchOptions & { plan?: DrglitchExportPlan; signal?: AbortSignal },
  sha256: Sha256,
  kind: "asset" | "thumbnail",
  roles: ReadonlySet<AssetRole>,
  policy: ResourcePolicy,
): Promise<LoadedDrglitchSource> {
  const { signal } = options;
  checkExportAborted(signal);
  if (options.getBoundSource) {
    const source = await raceExport(options.getBoundSource(sha256, kind, signal), signal);
    if (!source) {
      fail(
        kind === "thumbnail" ? "thumbnail-missing" : "asset-missing",
        `${kind} ${sha256} is missing from local storage.`,
      );
    }
    const ext = assertBoundRecord(options.plan, sha256, kind, source.record, roles, policy);
    checkExportAborted(signal);
    const bytes = await raceExport(source.readBytes(signal), signal);
    checkExportAborted(signal);
    if (bytes.byteLength !== source.record.byteLength) {
      fail("plan-mismatch", `Cannot export: ${kind} ${sha256} body length diverged from its bound record.`);
    }
    return { bytes, ext };
  }

  if (options.plan) {
    fail(
      "plan-mismatch",
      `Cannot export frozen ${kind} ${sha256} without a record-bound body provider.`,
    );
  }
  if (kind === "asset") {
    const source = await raceExport(options.getAsset?.(sha256) ?? null, signal);
    if (!source) fail("asset-missing", `Asset ${sha256} is missing from local storage.`);
    if (!ASSET_EXTENSIONS.includes(source.ext)) {
      fail("asset-invalid", `Asset ${sha256} has unsupported extension .${source.ext}.`);
    }
    return source;
  }
  const bytes = await raceExport(options.getThumbnail?.(sha256) ?? null, signal);
  if (!bytes) fail("thumbnail-missing", `Thumbnail ${sha256} is missing from local storage.`);
  return { bytes, ext: "png" };
}

/**
 * METADATA-ONLY export plan: exact UTF-8 byte counts for manifest.json and
 * project.json, REAL record byteLengths for every referenced asset and
 * thumbnail (no body/blob is ever read), ZIP overhead and stored-size
 * ceilings per entry, and the archive quotas enforced up front. Any
 * missing or corrupt record FAILS the plan typed — a broken project must
 * surface here, pre-picker, never as a zero-counted entry that understates
 * the estimate and dies mid-write. The result is FROZEN: execution
 * (exportDrglitchToSink with `plan`) revalidates each row against it
 * before reading a single body byte.
 */
export async function planDrglitchExport(options: {
  envelope: ProjectEnvelopeV1;
  appVersion: string;
  getRecord: DrglitchPlanRecordSource;
  signal?: AbortSignal;
  policy?: ResourcePolicy;
  maxWorkingSetBytes?: number;
}): Promise<DrglitchExportPlan> {
  checkExportAborted(options.signal);
  const policy = options.policy ?? RESOURCE_POLICY;
  const maxWorkingSetBytes = options.maxWorkingSetBytes ?? DEFAULT_MAX_WORKING_SET_BYTES;
  let envelope: ProjectEnvelopeV1;
  try {
    envelope = validateProjectEnvelope(options.envelope, policy);
  } catch (error) {
    if (error instanceof SchemaViolation) fail("project-invalid", `Cannot export: ${error.message}`);
    throw error;
  }
  const { manifestBytes, projectBytes } = encodeExportMetadata(envelope, options.appVersion);
  const entries: DrglitchExportPlanEntry[] = [
    {
      name: "manifest.json",
      kind: "manifest",
      byteLength: manifestBytes.byteLength,
    },
    {
      name: "project.json",
      kind: "project",
      byteLength: projectBytes.byteLength,
    },
  ];
  const references = collectAssetReferences(envelope);
  const totalEntries = entries.length + references.assets.size + references.thumbnails.size;
  if (totalEntries > policy.maxArchiveEntries) {
    fail("archive-entry-count", `Cannot export: the project needs ${totalEntries} archive entries but the policy allows ${policy.maxArchiveEntries}.`);
  }
  for (const sha256 of [...references.assets.keys()].sort()) {
    checkExportAborted(options.signal);
    const record = await raceExport(options.getRecord(sha256, "asset", options.signal), options.signal);
    if (!record) {
      fail("asset-missing", `Cannot plan the export: asset ${sha256} is missing or has no stored size.`);
    }
    const roles = references.assets.get(sha256)!;
    const ext = validateSourceRecord(sha256, "asset", record, roles, policy, "asset-invalid");
    entries.push({
      name: `assets/${sha256}.${ext}`,
      kind: "asset",
      sha256,
      ext,
      storageKind: record.kind,
      mime: record.mime.toLowerCase(),
      width: record.width,
      height: record.height,
      byteLength: record.byteLength,
    });
  }
  for (const sha256 of [...references.thumbnails].sort()) {
    checkExportAborted(options.signal);
    const record = await raceExport(
      options.getRecord(sha256, "thumbnail", options.signal),
      options.signal,
    );
    if (!record) {
      fail("thumbnail-missing", `Cannot plan the export: thumbnail ${sha256} is missing or has no stored size.`);
    }
    validateSourceRecord(
      sha256,
      "thumbnail",
      record,
      new Set<AssetRole>(),
      policy,
      "thumbnail-invalid",
    );
    entries.push({
      name: `thumbnails/${sha256}.png`,
      kind: "thumbnail",
      sha256,
      ext: "png",
      storageKind: record.kind,
      mime: record.mime.toLowerCase(),
      width: record.width,
      height: record.height,
      byteLength: record.byteLength,
    });
  }
  checkExportAborted(options.signal);
  let totalBytes = 0;
  let estimatedBytes = 22; // end-of-central-directory record
  let largestEntryBytes = 0;
  let largestImportWindowBytes = 0;
  let largestDecodeTransient = 0;
  for (const entry of entries) {
    totalBytes += entry.byteLength;
    largestEntryBytes = Math.max(largestEntryBytes, entry.byteLength);
    const windowBytes = entry.ext && entry.ext !== "svg"
      ? rasterValidationWindow(entry.byteLength, entry.width!, entry.height!)
      : entry.byteLength;
    largestImportWindowBytes = Math.max(largestImportWindowBytes, windowBytes);
    largestDecodeTransient = Math.max(largestDecodeTransient, windowBytes - entry.byteLength);
    estimatedBytes +=
      storedSizeCeiling(entry.byteLength) + ZIP_ENTRY_OVERHEAD_BYTES + entry.name.length * 2;
    if (totalBytes > policy.maxArchiveUncompressedBytes) {
      fail("archive-uncompressed-quota", `Cannot export: entry "${entry.name}" pushes the archive past ${policy.maxArchiveUncompressedBytes} uncompressed bytes.`);
    }
  }
  if (estimatedBytes > policy.maxArchiveCompressedBytes) {
    fail("archive-too-large", `Cannot export: the archive is estimated at ${estimatedBytes} bytes; the policy allows ${policy.maxArchiveCompressedBytes} compressed bytes.`);
  }
  if (estimatedBytes + largestImportWindowBytes > maxWorkingSetBytes) {
    fail("archive-working-set", `Cannot export: the estimated archive plus its largest validation window exceeds the ${maxWorkingSetBytes}-byte working-memory ceiling an importer would enforce.`);
  }
  return {
    envelope,
    entries,
    estimatedBytes,
    largestEntryBytes,
    largestImportWindowBytes,
    totalEntryBytes: totalBytes,
    bufferedPeakBytes: totalBytes + Math.max(2 * estimatedBytes, largestDecodeTransient),
  };
}

/**
 * TRUE STREAMING .drglitch export for archives above the delivery
 * threshold: entries are produced ONE AT A TIME (manifest, project, then
 * each validated asset/thumbnail) and drain entry-wise through a streaming
 * ZIP writer (data descriptors; see zip-writer's determinism split)
 * straight into the caller's sink — the peak retention is ONE entry's
 * bytes plus ZIP staging, never all entries plus the whole archive.
 *
 * SAME acceptance contract as exportDrglitch: identical per-entry
 * validators and incremental quota accounting; the compressed-size and
 * importer working-set ceilings are verified against the ACTUAL streamed
 * bytes before this resolves — a violation (or any mid-stream failure)
 * rejects AND aborts the archive, and the caller must abort its writable,
 * so nothing partial is ever delivered. Cancellation via `signal` is
 * checked between entries.
 */
export async function exportDrglitchToSink(
  options: ExportDrglitchOptions & {
    sink: DrglitchByteSink;
    signal?: AbortSignal;
    /**
     * FROZEN PLAN (planDrglitchExport): when present, execution serializes
     * the plan's envelope verbatim and revalidates every body row against
     * the frozen manifest BEFORE reading it — a row whose stored size
     * diverged since planning (swapped between plan and write) rejects
     * typed ("plan-mismatch") with nothing partial finalized.
     */
    plan?: DrglitchExportPlan;
  },
): Promise<{ bytesWritten: number }> {
  const policy = options.policy ?? RESOURCE_POLICY;
  const maxWorkingSetBytes = options.maxWorkingSetBytes ?? DEFAULT_MAX_WORKING_SET_BYTES;
  const { signal } = options;
  const checkAborted = (): void => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const raced = <T,>(value: Promise<T> | T): Promise<T> => raceExport(value, signal);
  // A PRE-ABORTED signal writes NOTHING.
  checkAborted();
  const frozen = options.plan;
  const assertPlanned = makePlanAssertion(frozen);
  let envelope: ProjectEnvelopeV1;
  if (frozen) {
    envelope = frozen.envelope;
  } else {
    try {
      envelope = validateProjectEnvelope(options.envelope, policy);
    } catch (error) {
      if (error instanceof SchemaViolation) fail("project-invalid", `Cannot export: ${error.message}`);
      throw error;
    }
  }
  const { manifestBytes, projectBytes } = encodeExportMetadata(envelope, options.appVersion);
  const references = collectAssetReferences(envelope);
  const totalEntries = 2 + references.assets.size + references.thumbnails.size;
  if (totalEntries > policy.maxArchiveEntries) {
    fail("archive-entry-count", `Cannot export: the project needs ${totalEntries} archive entries but the policy allows ${policy.maxArchiveEntries}.`);
  }
  let totalBytes = 0;
  // Working-set guard seeded from the FROZEN plan so it reflects the
  // planned largest validation window before the first body ever arrives.
  let largestImportWindowBytes = frozen?.largestImportWindowBytes ?? 0;
  const account = (name: string, byteLength: number): void => {
    totalBytes += byteLength;
    largestImportWindowBytes = Math.max(largestImportWindowBytes, byteLength);
    if (totalBytes > policy.maxArchiveUncompressedBytes) {
      fail("archive-uncompressed-quota", `Cannot export: entry "${name}" pushes the archive past ${policy.maxArchiveUncompressedBytes} uncompressed bytes.`);
    }
  };
  const validate = (name: string, ext: DrglitchAssetExt, bytes: Uint8Array, roles: ReadonlySet<AssetRole>, thumbnail = false) =>
    validateExportAsset(name, ext, bytes, roles, policy, {
      decoder: options.decoder, signal: options.signal, thumbnail,
      planned: options.plan?.entries.find((entry) => entry.name === name),
      admit: (windowBytes) => {
        largestImportWindowBytes = Math.max(largestImportWindowBytes, windowBytes);
        if (0 + windowBytes > policy.maxRenderPeakBytes) {
          fail("archive-working-set", "Cannot export: complete raster validation exceeds the working-memory budget.");
        }
      },
    });
  const { createStreamingArchiveWriter } = await import("./zip-writer");
  // A cancel that landed during the lazy module import proceeds no further.
  checkAborted();
  let bytesWritten = 0;
  let sinkAbortPromise: Promise<void> | null = null;
  const abortSinkOnce = (reason: unknown): Promise<void> => {
    if (!options.sink.abort) return Promise.resolve();
    if (!sinkAbortPromise) {
      const attempted = Promise.resolve()
        .then(() => options.sink.abort!(reason))
        .then(() => undefined)
        .catch(() => undefined);
      // Cleanup must not turn cancellation/disposal into an unbounded wait.
      sinkAbortPromise = Promise.race([
        attempted,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);
    }
    return sinkAbortPromise;
  };
  const archive = createStreamingArchiveWriter({
    async write(chunk) {
      // CAP ENFORCEMENT BEFORE THE WRITE: a chunk that would push the
      // compressed size (or the importer working set) past its ceiling is
      // refused before it reaches the sink — overflow is never durable.
      if (bytesWritten + chunk.byteLength > policy.maxArchiveCompressedBytes) {
        fail("archive-too-large", `Cannot export: the archive exceeds ${policy.maxArchiveCompressedBytes} compressed bytes.`);
      }
      if (bytesWritten + chunk.byteLength + largestImportWindowBytes > maxWorkingSetBytes) {
        fail("archive-working-set", `Cannot export: the archive plus its largest entry exceeds the ${maxWorkingSetBytes}-byte working-memory ceiling an importer would enforce.`);
      }
      await raceExport(options.sink.write(chunk, signal), signal);
      bytesWritten += chunk.byteLength;
    },
  });
  try {
    assertPlanned("manifest.json", manifestBytes.length);
    account("manifest.json", manifestBytes.length);
    await raced(archive.addEntry("manifest.json", manifestBytes));
    checkAborted();
    assertPlanned("project.json", projectBytes.length);
    account("project.json", projectBytes.length);
    await raced(archive.addEntry("project.json", projectBytes));
    for (const sha256 of [...references.assets.keys()].sort()) {
      checkAborted();
      const roles = references.assets.get(sha256)!;
      const source = await loadDrglitchSource(options, sha256, "asset", roles, policy);
      const name = `assets/${sha256}.${source.ext}`;
      // TOCTOU gate, TWO-STAGE ORDER: the cheap frozen-manifest size check
      // rejects a swapped row BEFORE the body is hashed or written.
      assertPlanned(name, source.bytes.length);
      // Cooperative hashing: the checkpoint observes the export signal.
      if ((await sha256HexAbortable(source.bytes, checkAborted)) !== sha256) {
        fail("asset-hash-mismatch", `Asset ${sha256} bytes do not match their content hash.`);
      }
      await validate(name, source.ext, source.bytes, roles);
      account(name, source.bytes.length);
      await raced(archive.addEntry(name, source.bytes, { compress: source.ext === "svg" }));
      // source drops here — exactly one asset's bytes are ever resident.
    }
    for (const sha256 of [...references.thumbnails].sort()) {
      checkAborted();
      const { bytes } = await loadDrglitchSource(
        options,
        sha256,
        "thumbnail",
        new Set<AssetRole>(),
        policy,
      );
      const name = `thumbnails/${sha256}.png`;
      assertPlanned(name, bytes.length);
      if ((await sha256HexAbortable(bytes, checkAborted)) !== sha256) {
        fail("asset-hash-mismatch", `Thumbnail ${sha256} bytes do not match their content hash.`);
      }
      await validate(name, "png", bytes, new Set<AssetRole>(), true);
      account(name, bytes.length);
      await raced(archive.addEntry(name, bytes, { compress: false }));
    }
    checkAborted();
    // The caps were enforced BEFORE every write (sink wrapper above), so
    // closing can add only the central directory, itself cap-checked too.
    await raced(archive.close());
    // POST-CLOSE ARBITRATION: a cancellation observed while the close was
    // settling wins — never report success on a cancelled export.
    checkAborted();
    return { bytesWritten };
  } catch (error) {
    await archive.abort(error);
    await abortSinkOnce(error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Narrow staging boundary the storage subsystem implements. Import calls
 * allocate, then write for every asset/thumbnail, then commit exactly once;
 * on any failure it calls abort and rethrows. Nothing must become visible
 * outside staging before commit.
 */
export interface StagingSink {
  allocate(
    plan: { projectId: Id; assetCount: number; totalAssetBytes: number },
    signal?: AbortSignal,
  ): Promise<void> | void;
  write(record: AssetRecordV1, bytes: Uint8Array, signal?: AbortSignal): Promise<void> | void;
  /**
   * Signal-aware atomic terminal operation. Implementations must reject when
   * cancellation wins before installation, but once their atomic commit has
   * succeeded they resolve success even if cancellation arrives later. A
   * never-settling implementation that ignores `signal` cannot be made both
   * promptly cancellable and atomically truthful by this caller.
   */
  commit(envelope: ProjectEnvelopeV1, signal?: AbortSignal): Promise<void> | void;
  abort(reason: unknown): Promise<void> | void;
}

/** Default wall-clock budget for one whole import operation. */
export const DEFAULT_IMPORT_TIMEOUT_MS = 120_000;

export type DrglitchImportPhase = "extract" | "validate" | "stage" | "commit";

/** Coarse progress for the UI's cancellable import affordance (wave F seam). */
export type DrglitchImportProgress = {
  phase: DrglitchImportPhase;
  /** Assets + thumbnails staged so far / total (0/0 before the plan exists). */
  assetsDone: number;
  assetsTotal: number;
};

export type ImportDrglitchOptions = {
  sink: StagingSink;
  policy?: ResourcePolicy;
  /**
   * External cancellation for the WHOLE operation: file read, extraction,
   * parsing, hashing, media validation, staging writes, and commit all
   * observe this one signal (plus the timeoutMs deadline) at every async
   * boundary and inside long loops.
   */
  signal?: AbortSignal;
  /** Wall-clock budget for the whole operation (default 120 s). */
  timeoutMs?: number;
  /**
   * Working-memory ceiling for this one import (default 512 MiB; see
   * zip-reader DEFAULT_MAX_WORKING_SET_BYTES). The account is honest: the
   * resident compressed archive is counted, and entries inflate one at a
   * time — each released as soon as its bytes are staged — so the retained
   * peak is compressed input + a bounded streaming window.
   * ResourcePolicy.maxArchiveUncompressedBytes stays the absolute cap on
   * cumulative inflated data.
   */
  maxWorkingSetBytes?: number;
  /**
   * Full raster decode adapter. Every raster (and PNG thumbnail) must FULLY
   * decode — and match its header dimensions — before it is staged.
   * Defaults to the browser decoder; in non-DOM environments the default
   * FAILS CLOSED with "raster-decode-unavailable", so tests must inject an
   * explicit decoder (header-only can never silently count as fully valid).
   */
  decoder?: RasterDecoder;
  /** Progress callback for the UI's cancellable import handle. */
  onProgress?: (progress: DrglitchImportProgress) => void;
  /** Injectable retained-memory account (tests assert its peak). */
  ledger?: WorkingSetLedger;
  /** Injectable for tests; defaults to crypto.randomUUID. */
  newProjectId?: () => Id;
  now?: () => number;
};

function parseManifest(bytes: Uint8Array | undefined): DrglitchManifest {
  if (!bytes) fail("manifest-missing", "The archive has no manifest.json.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("manifest-invalid", "manifest.json is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("manifest-invalid", "manifest.json must be an object.");
  const manifest = raw as Record<string, unknown>;
  if (manifest.format !== DRGLITCH_FORMAT) fail("manifest-invalid", "The archive is not a DR.GLITCH project.");
  const schema = manifest.schema;
  if (typeof schema !== "number" || !Number.isSafeInteger(schema) || schema < 1) {
    fail("manifest-invalid", "manifest.json declares an invalid schema.");
  }
  if (schema > DRGLITCH_SCHEMA) {
    fail("future-schema", `This project uses schema ${schema}; this app supports up to ${DRGLITCH_SCHEMA}. Update DR.GLITCH to open it.`);
  }
  if (typeof manifest.appVersion !== "string" || manifest.appVersion.length > 64) {
    fail("manifest-invalid", "manifest.json declares an invalid appVersion.");
  }
  return { format: DRGLITCH_FORMAT, schema, appVersion: manifest.appVersion };
}

function findAssetEntry(archive: ArchiveStream, sha256: Sha256): { name: string; ext: DrglitchAssetExt; declared: number } {
  for (const ext of ASSET_EXTENSIONS) {
    const name = `assets/${sha256}.${ext}`;
    if (archive.has(name)) return { name, ext, declared: archive.sizeOf(name) };
  }
  fail("asset-missing", `Referenced asset ${sha256} is not in the archive.`);
}

/** Rewrite every reference from oldSha to newSha after SVG canonicalization. */
function remapReferences(envelope: ProjectEnvelopeV1, map: Map<Sha256, Sha256>): ProjectEnvelopeV1 {
  if (map.size === 0) return envelope;
  const swap = (sha: Sha256 | null): Sha256 | null => (sha ? map.get(sha) ?? sha : null);
  const remapCore = (core: ProjectCoreV1): ProjectCoreV1 => ({
    ...core,
    layers: core.layers.map((layer) => ({
      ...layer,
      assetId: map.get(layer.assetId) ?? layer.assetId,
      recipe: {
        ...layer.recipe,
        halftone: { ...layer.recipe.halftone, customShapeAssetId: swap(layer.recipe.halftone.customShapeAssetId) },
      },
    })),
    registration: { ...core.registration, customShapeAssetId: swap(core.registration.customShapeAssetId) },
  });
  return {
    ...envelope,
    core: remapCore(envelope.core),
    snapshots: envelope.snapshots.map((snapshot) => ({ ...snapshot, core: remapCore(snapshot.core) })),
  };
}

/**
 * Validate and stage a .drglitch archive under ONE operation-scoped budget.
 *
 * One deadline + one AbortSignal (ImportOperation) span the entire pipeline:
 * archive open, incremental extraction, manifest/project parsing (behind
 * dedicated byte caps checked BEFORE TextDecoder/JSON.parse), abortable
 * hashing, full media validation (raster payloads FULLY decoded through the
 * injected adapter; SVG through the strict sanitizer with its resource
 * bounds), incremental staging writes, and the atomic commit. The budget is
 * checked at every async boundary and inside every long loop.
 *
 * Memory model (WorkingSetLedger, honest accounting): the resident
 * compressed archive is charged for the whole operation; each referenced
 * entry inflates into ONE exact-size buffer, is validated, handed to the
 * sink, and released before the next entry inflates. Retained peak =
 * compressed input + a bounded streaming window — never compressed input +
 * all inflated entries + staging copies at once.
 *
 * Cleanup is exactly-once: after sink.allocate(), ANY failure — including a
 * cancellation or deadline at any stage — aborts the sink exactly once, so
 * zero rows outlive a failed import. Nothing becomes visible outside staging
 * before commit.
 *
 * Returns the envelope handed to commit: a NEW local project id,
 * savedRevision 0 (imported projects open unsaved), fresh timestamps.
 */
export async function importDrglitch(bytes: Uint8Array, options: ImportDrglitchOptions): Promise<ProjectEnvelopeV1> {
  const policy = options.policy ?? RESOURCE_POLICY;
  const now = options.now ?? Date.now;
  const newProjectId = options.newProjectId ?? (() => crypto.randomUUID());
  const decoder = options.decoder ?? defaultRasterDecoder();
  const maxWorkingSetBytes = options.maxWorkingSetBytes ?? DEFAULT_MAX_WORKING_SET_BYTES;
  const operation = new ImportOperation({
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS,
  });
  const ledger = options.ledger ?? new WorkingSetLedger(maxWorkingSetBytes);
  const report = (phase: DrglitchImportPhase, assetsDone: number, assetsTotal: number): void => {
    options.onProgress?.({ phase, assetsDone, assetsTotal });
  };
  const checkpoint = (): void => operation.checkpoint();
  const raceStageMutation = async <T>(invoke: () => Promise<T> | T): Promise<T> => {
    checkpoint();
    const pending = Promise.resolve().then(invoke);
    const signal = operation.signal;
    try {
      if (signal.aborted) checkpoint();
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("The import was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } catch (error) {
      // Translate an operation cancellation/timeout consistently even when
      // the provider rejected with a DOMException (or remained stalled).
      checkpoint();
      throw error;
    }
  };

  let archive: ArchiveStream | null = null;
  let compressedRetained = false;
  try {
    checkpoint();
    // The compressed input stays resident for the whole operation (the ZIP
    // reader random-accesses it), so it is counted in the ceiling honestly.
    ledger.retain(bytes.length, "compressed archive");
    compressedRetained = true;
    report("extract", 0, 0);
    archive = await openArchiveStream(bytes, { policy, operation, ledger });
    checkpoint();
    report("validate", 0, 0);

    /* --- manifest.json: byte cap BEFORE TextDecoder/JSON.parse --- */
    if (!archive.has("manifest.json")) fail("manifest-missing", "The archive has no manifest.json.");
    if (archive.sizeOf("manifest.json") > DRGLITCH_MAX_MANIFEST_BYTES) {
      fail("manifest-invalid", `manifest.json exceeds the ${DRGLITCH_MAX_MANIFEST_BYTES}-byte cap.`);
    }
    parseManifest(await archive.read("manifest.json"));
    archive.release("manifest.json");
    checkpoint();

    /* --- project.json: byte cap BEFORE TextDecoder/JSON.parse --- */
    if (!archive.has("project.json")) fail("project-missing", "The archive has no project.json.");
    if (archive.sizeOf("project.json") > DRGLITCH_MAX_PROJECT_BYTES) {
      fail("project-invalid", `project.json exceeds the ${DRGLITCH_MAX_PROJECT_BYTES}-byte cap.`);
    }
    const projectBytes = await archive.read("project.json");
    let projectRaw: unknown;
    try {
      projectRaw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(projectBytes));
    } catch {
      fail("project-invalid", "project.json is not valid JSON.");
    }
    archive.release("project.json");
    let envelope: ProjectEnvelopeV1;
    try {
      envelope = validateProjectEnvelope(projectRaw, policy);
    } catch (error) {
      if (error instanceof SchemaViolation) fail("project-invalid", error.message);
      throw error;
    }
    checkpoint();

    /* --- strict archive: resolve references BY NAME, no extraction --- */
    const references = collectAssetReferences(envelope);
    const expected = new Set(["manifest.json", "project.json"]);
    const assetEntries = new Map<Sha256, { name: string; ext: DrglitchAssetExt; declared: number }>();
    let totalAssetBytes = 0;
    for (const sha256 of references.assets.keys()) {
      const entry = findAssetEntry(archive, sha256);
      assetEntries.set(sha256, entry);
      expected.add(entry.name);
      totalAssetBytes += entry.declared;
    }
    for (const sha256 of references.thumbnails) {
      const name = `thumbnails/${sha256}.png`;
      if (!archive.has(name)) fail("thumbnail-missing", `Referenced thumbnail ${sha256} is not in the archive.`);
      expected.add(name);
      totalAssetBytes += archive.sizeOf(name);
    }
    for (const name of archive.names) {
      if (!expected.has(name)) fail("unexpected-entry", `The archive contains unreferenced entry "${name}".`);
    }

    /* --- incremental validate-and-stage: one entry resident at a time --- */
    const projectId = newProjectId();
    const timestamp = now();
    const assetsTotal = references.assets.size + references.thumbnails.size;
    let assetsDone = 0;
    const remap = new Map<Sha256, Sha256>();
    const { sink } = options;
    try {
      checkpoint();
      await raceStageMutation(() => sink.allocate({
        projectId,
        assetCount: assetsTotal,
        totalAssetBytes,
      }, operation.signal));

      for (const [sha256, roles] of references.assets) {
        checkpoint();
        report("stage", assetsDone, assetsTotal);
        const entry = assetEntries.get(sha256)!;
        const needsSvg = roles.has("custom-dot") || roles.has("registration-mark");
        if (entry.ext === "svg") {
          // Dedicated byte cap BEFORE inflation and BEFORE TextDecoder: the
          // tightest referencing profile bounds the whole entry.
          const maxSvgBytes = Math.min(...[...roles].map((role) => SVG_PROFILE_LIMITS[role].maxBytes));
          if (entry.declared > maxSvgBytes) {
            fail("asset-invalid", `SVG asset "${entry.name}" exceeds the ${maxSvgBytes}-byte profile cap.`);
          }
        } else {
          if (needsSvg) {
            fail("asset-invalid", `Asset "${entry.name}" must be an SVG for custom-dot or registration use.`);
          }
          if (entry.declared > policy.maxRasterBytes) {
            fail("asset-invalid", `Raster asset "${entry.name}" exceeds ${policy.maxRasterBytes} bytes.`);
          }
        }

        const data = await archive.read(entry.name);
        if (await sha256HexAbortable(data, checkpoint) !== sha256) {
          fail("asset-hash-mismatch", `Asset "${entry.name}" does not match its content hash.`);
        }

        if (entry.ext === "svg") {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(data);
          } catch {
            fail("asset-invalid", `SVG asset "${entry.name}" is not valid UTF-8.`);
          }
          let canonical = "";
          let width = 0;
          let height = 0;
          try {
            // Every referencing role must accept the SVG; profiles share one
            // canonicalization, so the reconstructed output is identical.
            for (const role of roles) {
              const result = sanitizeSvg(text, role);
              canonical = result.svg;
              width = result.width;
              height = result.height;
            }
          } catch (error) {
            if (error instanceof SvgValidationError) {
              fail("asset-invalid", `SVG asset "${entry.name}" was rejected (${error.code}): ${error.message}`);
            }
            throw error;
          }
          checkpoint();
          let finalSha = sha256;
          let finalBytes = data;
          let canonicalRetained = 0;
          try {
            if (canonical !== text) {
              const canonicalBytes = new TextEncoder().encode(canonical);
              ledger.retain(canonicalBytes.length, `${entry.name} (canonical)`);
              canonicalRetained = canonicalBytes.length;
              finalBytes = canonicalBytes;
              finalSha = await sha256HexAbortable(canonicalBytes, checkpoint);
              remap.set(sha256, finalSha);
            }
            // Blob/structured-clone implementations may snapshot the view
            // during staging. Admit one conservative encoded-size transient
            // in addition to the retained entry/canonical buffer.
            ledger.retain(finalBytes.length, `${entry.name} (staging handoff)`);
            try {
              await raceStageMutation(() => sink.write(
                {
                  sha256: finalSha,
                  kind: "svg",
                  mime: "image/svg+xml",
                  byteLength: finalBytes.length,
                  width: Math.max(1, Math.round(width)),
                  height: Math.max(1, Math.round(height)),
                  createdAt: timestamp,
                },
                finalBytes,
                operation.signal,
              ));
            } finally {
              ledger.release(finalBytes.length);
            }
          } finally {
            if (canonicalRetained > 0) ledger.release(canonicalRetained);
          }
        } else {
          // FULL payload validation: header gates (signature/dims/animation/
          // bomb) first, then a complete decode through the injected adapter
          // with decoded-vs-header dimension equality. Header-only never
          // counts as fully valid.
          let info;
          let header;
          try {
            header = validateRaster(data, { filename: entry.name, policy });
          } catch (error) {
            if (error instanceof RasterValidationError) {
              fail("asset-invalid", `Raster asset "${entry.name}" was rejected (${error.code}): ${error.message}`);
            }
            throw error;
          }
          // The browser decoder may snapshot the encoded payload and retain a
          // full RGBA surface while validating it. Reject before invoking the
          // decoder if that conservative transient cannot fit.
          const decodeTransient = 2 * data.byteLength + header.width * header.height * 4;
          ledger.retain(decodeTransient, `${entry.name} (full decode)`);
          const reservation = decodeReservation(() => ledger.release(decodeTransient));
          try {
            info = await validateRasterPayload(data, {
              filename: entry.name,
              policy,
              decoder,
              signal: operation.signal,
              onResourcesSettled: reservation.onResourcesSettled,
            });
          } catch (error) {
            // A cancel/deadline that preempted the decoder surfaces as the
            // operation's typed error, not as an asset defect.
            checkpoint();
            if (error instanceof RasterValidationError) {
              fail("asset-invalid", `Raster asset "${entry.name}" was rejected (${error.code}): ${error.message}`);
            }
            throw error;
          } finally {
            reservation.finish();
          }
          checkpoint();
          ledger.retain(data.length, `${entry.name} (staging handoff)`);
          try {
            await raceStageMutation(() => sink.write(
              {
                sha256,
                kind: "raster",
                mime: info.mime,
                byteLength: data.length,
                width: info.width,
                height: info.height,
                createdAt: timestamp,
              },
              data,
              operation.signal,
            ));
          } finally {
            ledger.release(data.length);
          }
        }
        // The sink owns its copy now; drop this entry's window before the
        // next entry inflates.
        archive.release(entry.name);
        assetsDone += 1;
        report("stage", assetsDone, assetsTotal);
      }

      for (const sha256 of references.thumbnails) {
        checkpoint();
        const name = `thumbnails/${sha256}.png`;
        if (archive.sizeOf(name) > policy.maxRasterBytes) {
          fail("thumbnail-invalid", `Thumbnail "${name}" exceeds ${policy.maxRasterBytes} bytes.`);
        }
        const data = await archive.read(name);
        if (await sha256HexAbortable(data, checkpoint) !== sha256) {
          fail("asset-hash-mismatch", `Thumbnail "${name}" does not match its content hash.`);
        }
        let info;
        let header;
        try {
          header = validateRaster(data, { filename: name, policy });
        } catch (error) {
          if (error instanceof RasterValidationError) {
            fail("thumbnail-invalid", `Thumbnail "${name}" was rejected (${error.code}): ${error.message}`);
          }
          throw error;
        }
        const decodeTransient = 2 * data.byteLength + header.width * header.height * 4;
        ledger.retain(decodeTransient, `${name} (full decode)`);
        const reservation = decodeReservation(() => ledger.release(decodeTransient));
        try {
          // The .png filename makes the header gate require genuine still
          // PNG; the injected adapter then proves the payload decodes.
          info = await validateRasterPayload(data, {
            filename: name,
            policy,
            decoder,
            signal: operation.signal,
            onResourcesSettled: reservation.onResourcesSettled,
          });
        } catch (error) {
          checkpoint();
          if (error instanceof RasterValidationError) {
            fail("thumbnail-invalid", `Thumbnail "${name}" was rejected (${error.code}): ${error.message}`);
          }
          throw error;
        } finally {
          reservation.finish();
        }
        checkpoint();
        ledger.retain(data.length, `${name} (staging handoff)`);
        try {
          await raceStageMutation(() => sink.write(
            {
              sha256,
              kind: "thumbnail",
              mime: info.mime,
              byteLength: data.length,
              width: info.width,
              height: info.height,
              createdAt: timestamp,
            },
            data,
            operation.signal,
          ));
        } finally {
          ledger.release(data.length);
        }
        archive.release(name);
        assetsDone += 1;
        report("stage", assetsDone, assetsTotal);
      }

      /* --- atomic commit: new local identity, imports open unsaved --- */
      checkpoint();
      report("commit", assetsDone, assetsTotal);
      // The progress callback may itself cancel. Do not enter the atomic
      // sink boundary after that cancellation has already won.
      checkpoint();
      const installed: ProjectEnvelopeV1 = {
        ...remapReferences(envelope, remap),
        id: projectId,
        createdAt: timestamp,
        updatedAt: timestamp,
        savedRevision: 0,
      };
      // Do not race the terminal commit from the outside: a blind abort could
      // report cancellation after durable installation. The sink receives the
      // operation signal and owns the exact atomic arbitration point.
      await sink.commit(installed, operation.signal);
      return installed;
    } catch (error) {
      // Exactly-once cleanup: any failure inside the staging section —
      // including cancellation/deadline at any stage — aborts the sink once;
      // zero rows survive. Failures BEFORE this section never touch the sink.
      try { await sink.abort(error); } catch { /* the import error wins */ }
      // A storage/provider AbortError is normalized only after cleanup has
      // drained; unrelated failures retain their original typed identity.
      checkpoint();
      throw error;
    }
  } finally {
    if (archive) {
      try { await archive.close(); } catch { /* original error wins */ }
    }
    if (compressedRetained) ledger.release(bytes.length);
    operation.dispose();
  }
}
