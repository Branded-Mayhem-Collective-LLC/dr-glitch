/**
 * IndexedDB layout for the DR.GLITCH local library. This file owns the
 * database name, version, object-store list, per-store row shapes, and the
 * versioned upgrade path. Everything else reaches the database through
 * StorageBackend (backend.ts); no other module opens IndexedDB.
 *
 * All stores use out-of-line string keys supplied by the repositories:
 *   projects    ProjectEnvelopeV1                     key: project id
 *   assets      StoredAssetRow (record + Blob)        key: sha256
 *   thumbnails  StoredAssetRow (record + Blob)        key: sha256
 *   recovery    RecoveryRecordV1                      key: project id
 *   presets     RecipePresetV1                        key: preset id
 *   trash       TrashRecordV1                         key: project id
 *   staging     StagingRow (meta or staged asset)     key: see staging.ts
 *   leases      LeaseRecordV1 (single-writer leases)  key: project id
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AssetRecordV1,
  Id,
  ProjectEnvelopeV1,
  RecipePresetV1,
  RecoveryRecordV1,
  Sha256,
  TrashRecordV1,
} from "../core/types";

/** Single IndexedDB database; the name is part of the e2e storage contract
 * (tests/e2e/helpers/storage.ts APP_DB_NAME). */
export const DB_NAME = "drglitch";
export const DB_VERSION = 1;

export const STORE_NAMES = [
  "projects",
  "assets",
  "thumbnails",
  "recovery",
  "presets",
  "trash",
  "staging",
  "leases",
] as const;

export type StoreName = (typeof STORE_NAMES)[number];

/** Content-addressed asset bytes plus metadata, stored as one row. */
export type StoredAssetRow = {
  record: AssetRecordV1;
  blob: Blob;
  /**
   * Last time this content address was re-put (dedupe hit). GC's grace
   * window keys off max(createdAt, touchedAt): a dedupe hit resurrects an
   * otherwise-orphaned row moments before a project row references it, and
   * without the refresh a concurrent GC in another tab could sweep the row
   * inside that gap (createdAt alone may be arbitrarily old). Optional —
   * absent on rows written before this field existed.
   */
  touchedAt?: number;
};

/** The live object store a staged content address will be installed into. */
export type AssetStoreName = "assets" | "thumbnails";

/**
 * Store-qualified staging reference. The same bytes (and therefore the same
 * SHA-256) may legitimately be both artwork and a snapshot thumbnail; the
 * destination is part of the staging identity even though it is not part of
 * the content address.
 */
export type StagingAssetRef = {
  store: AssetStoreName;
  sha256: Sha256;
};

/** Metadata row for one atomic-import staging area. */
export type StagingMetaRow = {
  type: "meta";
  stagingId: Id;
  createdAt: number;
  /** Candidate envelope; null until the importer stages it. */
  envelope: ProjectEnvelopeV1 | null;
  /** Store-qualified references written by current versions. */
  assetRefs?: StagingAssetRef[];
  /**
   * Legacy v1 metadata. Old rows did not record a destination and keyed a
   * staged row only by digest. Readers retain support solely so crash cleanup
   * and GC can conservatively recover installations created by that version.
   * New writers never populate this field.
   */
  assetShas?: Sha256[];
};

/** One staged asset belonging to a staging area. */
export type StagingAssetRow = {
  type: "asset";
  stagingId: Id;
  /** Missing only on legacy rows; then record.kind determines the store. */
  destination?: AssetStoreName;
  asset: StoredAssetRow;
};

export type StagingRow = StagingMetaRow | StagingAssetRow;

/** Single-writer lease used when Web Locks is unavailable. */
export type LeaseRecordV1 = {
  projectId: Id;
  /** Opaque id of the holder (per acquire attempt, not per tab). */
  ownerId: Id;
  acquiredAt: number;
  /** Epoch ms after which the lease may be stolen. */
  expiresAt: number;
};

export interface DrGlitchDbSchema extends DBSchema {
  projects: { key: string; value: ProjectEnvelopeV1 };
  assets: { key: string; value: StoredAssetRow };
  thumbnails: { key: string; value: StoredAssetRow };
  recovery: { key: string; value: RecoveryRecordV1 };
  presets: { key: string; value: RecipePresetV1 };
  trash: { key: string; value: TrashRecordV1 };
  staging: { key: string; value: StagingRow };
  leases: { key: string; value: LeaseRecordV1 };
}

export type DrGlitchDatabase = IDBPDatabase<DrGlitchDbSchema>;

/**
 * Open (and if needed create/upgrade) the local database. Upgrades run as a
 * fallthrough ladder: each released version adds one block guarded by
 * `oldVersion < n`, and blocks must never be edited after release.
 */
export function openDrGlitchDatabase(): Promise<DrGlitchDatabase> {
  return openDB<DrGlitchDbSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        for (const name of STORE_NAMES) {
          db.createObjectStore(name);
        }
      }
      // Future versions: `if (oldVersion < 2) { ... }` and bump DB_VERSION.
    },
  });
}
