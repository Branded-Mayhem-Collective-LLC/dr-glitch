/**
 * Read-boundary validation for at-rest IndexedDB rows. The corruption threat
 * model treats stored rows as untrusted until revalidated: a crashed write,
 * a disk-level flip, or another (buggy or hostile) writer sharing the origin
 * can leave arbitrary data under our keys.
 *
 * Wherever a reconstructive validator exists in src/io/validate.ts it is
 * reused (project envelopes, cores, recipes, snapshots); the remaining row
 * shapes (recovery, trash, preset, asset rows) get light structural checks
 * here. Every failure surfaces as a typed CorruptRecordError whose `cause`
 * is the underlying violation.
 */
import type {
  AssetRecordV1,
  ProjectEnvelopeV1,
  RecipePresetV1,
  RecoveryRecordV1,
  TrashRecordV1,
} from "../core/types";
import { validateProjectEnvelope } from "../io/validate";
import { sanitizeSvg, SvgValidationError } from "../io/svg-sanitizer";
import { isSha256Hex } from "../io/sha256";
import { parsePreset, PresetValidationError, serializePreset } from "../io/drpreset";
import type { StoredAssetRow } from "./schema";
import { CorruptRecordError } from "./errors";

const ASSET_KINDS = ["raster", "svg", "thumbnail"] as const;

function corrupt(store: string, key: string, cause: unknown): never {
  throw new CorruptRecordError(store, key, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Full reconstructive validation of a stored project envelope. */
export function validateStoredEnvelope(key: string, value: unknown): ProjectEnvelopeV1 {
  try {
    const envelope = validateProjectEnvelope(value);
    if (envelope.id !== key) {
      throw new Error(`envelope id "${envelope.id}" does not match its storage key`);
    }
    return envelope;
  } catch (cause) {
    corrupt("projects", key, cause);
  }
}

/**
 * Full reconstructive validation of a stored recovery record. Core and
 * snapshots reuse the envelope validator by wrapping the record in an
 * envelope-shaped carrier; the journal-specific counters are checked here.
 */
export function validateStoredRecoveryRecord(key: string, value: unknown): RecoveryRecordV1 {
  try {
    if (!isRecord(value)) throw new Error("expected an object");
    if (
      !finiteNumber(value.revision) ||
      !finiteNumber(value.savedRevision) ||
      value.revision < 0 ||
      value.savedRevision < 0
    ) {
      throw new Error("invalid revision counters");
    }
    const carrier = validateProjectEnvelope({
      schema: 1,
      id: value.projectId,
      title: value.title,
      createdAt: 0,
      updatedAt: finiteNumber(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : -1,
      savedRevision: 0,
      core: value.core,
      snapshots: value.snapshots,
    });
    if (carrier.id !== key) {
      throw new Error(`recovery projectId "${carrier.id}" does not match its storage key`);
    }
    return {
      projectId: carrier.id,
      revision: value.revision,
      savedRevision: value.savedRevision,
      updatedAt: carrier.updatedAt,
      title: carrier.title,
      core: carrier.core,
      snapshots: carrier.snapshots,
    };
  } catch (cause) {
    corrupt("recovery", key, cause);
  }
}

/**
 * Reconstructive validation of a stored recipe preset. Reuses the hardened
 * .drpreset parser (numeric ranges, enum checks, canonical custom-dot SVG
 * re-sanitization) by round-tripping the row through its own serializer, so
 * a poisoned at-rest preset can never reach the UI or prime the AssetCache.
 * The stored identity (id/createdAt) is preserved after validation.
 */
export function validateStoredPreset(key: string, value: unknown): RecipePresetV1 {
  try {
    if (!isRecord(value)) throw new Error("expected an object");
    const id = value.id;
    const createdAt = value.createdAt;
    if (typeof id !== "string" || !id || id.length > 128 || id !== key) {
      throw new Error("preset id missing or mismatched with its storage key");
    }
    if (!finiteNumber(createdAt) || createdAt < 0) throw new Error("invalid createdAt");
    const parsed = parsePreset(serializePreset(value as RecipePresetV1), {
      newId: () => id,
      now: () => createdAt,
    });
    return parsed;
  } catch (cause) {
    corrupt("presets", key, cause);
  }
}

/** Light structural validation of a stored trash record. */
export function validateStoredTrashRecord(key: string, value: unknown): TrashRecordV1 {
  try {
    if (!isRecord(value)) throw new Error("expected an object");
    if (value.projectId !== key || typeof value.projectId !== "string" || !value.projectId) {
      throw new Error("trash projectId missing or mismatched with its storage key");
    }
    if (
      !finiteNumber(value.deletedAt) ||
      !finiteNumber(value.expiresAt) ||
      value.deletedAt < 0 ||
      value.expiresAt < value.deletedAt
    ) {
      throw new Error("invalid trash timestamps");
    }
    if (typeof value.title !== "string" || value.title.length > 500) {
      throw new Error("invalid trash title");
    }
    return {
      projectId: value.projectId,
      deletedAt: value.deletedAt,
      expiresAt: value.expiresAt,
      title: value.title,
    };
  } catch (cause) {
    corrupt("trash", key, cause);
  }
}

/**
 * Structural validation of one stored asset row: record shape, key match,
 * and blob integrity (present, byteLength agreeing with the record). Hash
 * verification is separate (AssetRepository verifyHash) because it requires
 * reading the bytes.
 */
export function validateStoredAssetRow(
  store: "assets" | "thumbnails",
  key: string,
  value: unknown,
): StoredAssetRow {
  try {
    if (!isRecord(value)) throw new Error("expected an object");
    const record = value.record;
    const blob = value.blob;
    if (!isRecord(record)) throw new Error("missing asset record");
    if (!isSha256Hex(record.sha256) || record.sha256 !== key) {
      throw new Error("asset sha256 missing or mismatched with its storage key");
    }
    if (!ASSET_KINDS.includes(record.kind as (typeof ASSET_KINDS)[number])) {
      throw new Error("invalid asset kind");
    }
    if (typeof record.mime !== "string" || !record.mime || record.mime.length > 255) {
      throw new Error("invalid asset mime");
    }
    if (!finiteNumber(record.byteLength) || record.byteLength < 0) {
      throw new Error("invalid asset byteLength");
    }
    if (!finiteNumber(record.width) || !finiteNumber(record.height)) {
      throw new Error("invalid asset dimensions");
    }
    if (!finiteNumber(record.createdAt) || record.createdAt < 0) {
      throw new Error("invalid asset createdAt");
    }
    if (!(blob instanceof Blob)) throw new Error("asset blob missing");
    if (blob.size !== record.byteLength) {
      throw new Error(
        `asset blob is ${blob.size} bytes but the record declares ${record.byteLength}`,
      );
    }
    const row: StoredAssetRow = {
      record: {
        sha256: record.sha256,
        kind: record.kind as AssetRecordV1["kind"],
        mime: record.mime,
        byteLength: record.byteLength,
        width: record.width,
        height: record.height,
        createdAt: record.createdAt,
      },
      blob,
    };
    // touchedAt is advisory (GC grace recency); a malformed value is treated
    // as absent rather than condemning an otherwise-valid row.
    if (finiteNumber(value.touchedAt) && value.touchedAt >= 0) {
      row.touchedAt = value.touchedAt;
    }
    return row;
  } catch (cause) {
    corrupt(store, key, cause);
  }
}

/**
 * Canonical custom-dot SVG re-check used by preset consumers; exported so
 * callers can verify an SVG string independent of a full preset row.
 */
export function isCanonicalCustomDotSvg(svg: string): boolean {
  try {
    sanitizeSvg(svg, "custom-dot");
    return true;
  } catch (error) {
    if (error instanceof SvgValidationError) return false;
    throw error;
  }
}

export { PresetValidationError };
