/**
 * Public surface of the storage subsystem. Consumers construct one backend
 * (IdbBackend in the browser, MemoryBackend in tests or as a last-resort
 * fallback) and pass it to the repositories/services they need.
 */
export {
  DB_NAME,
  DB_VERSION,
  STORE_NAMES,
  openDrGlitchDatabase,
} from "./schema";
export type {
  DrGlitchDatabase,
  DrGlitchDbSchema,
  LeaseRecordV1,
  StagingAssetRow,
  StagingAssetRef,
  StagingMetaRow,
  AssetStoreName,
  StagingRow,
  StoreName,
  StoredAssetRow,
} from "./schema";

export { IdbBackend } from "./backend";
export type { BackendTransaction, StorageBackend } from "./backend";
export { MemoryBackend, MemoryBusHub } from "./memory-backend";

export {
  ConflictError,
  CorruptRecordError,
  NotFoundError,
  StorageError,
  StorageQuotaError,
  isQuotaExceededError,
} from "./errors";

export {
  validateStoredAssetRow,
  validateStoredEnvelope,
  validateStoredPreset,
  validateStoredRecoveryRecord,
  validateStoredTrashRecord,
} from "./validate";

export { systemClock, systemTimer } from "./clock";
export type { Clock, TimerHandle, TimerHost } from "./clock";

export { sha256Hex, sha256HexFallback } from "./sha256";

export { ProjectRepository, TRASH_RETENTION_MS } from "./project-repository";
export type { ProjectRepositoryOptions, ProjectSummary } from "./project-repository";

export {
  ASSET_GC_GRACE_MS,
  AssetIntegrityError,
  AssetRepository,
  GcRootScanError,
  collectAllAssetRoots,
  collectEnvelopeAssetRefs,
} from "./asset-repository";
export type {
  AssetDimensions,
  AssetExportSnapshot,
  RasterDecodeSnapshot,
  AssetIntegrityCode,
  AssetRepositoryOptions,
  GarbageCollectOptions,
  GarbageCollectResult,
  RootsReader,
} from "./asset-repository";

export { RECOVERY_DEBOUNCE_MS, RecoveryJournal } from "./recovery";
export type { RecoveryJournalOptions } from "./recovery";

export {
  BroadcastChannelBus,
  LEASE_TTL_MS,
  LeaseOwnershipLock,
  NullOwnershipBus,
  OWNERSHIP_CHANNEL,
  WebLocksOwnershipLock,
  acquireOwnership,
  createOwnershipDeps,
  sanitizeOwnershipMessage,
} from "./ownership";
export type {
  LeaseLockOptions,
  LockAttempt,
  OwnershipBus,
  OwnershipDeps,
  OwnershipHandle,
  OwnershipLock,
  OwnershipMessage,
  OwnershipStatus,
} from "./ownership";

export { ImportStaging, STAGING_ABANDONED_AFTER_MS } from "./staging";
export type {
  CommitOptions,
  ImportStagingOptions,
  StagedImport,
  StagingHandle,
  StagingValidator,
} from "./staging";

export { PresetRepository } from "./preset-repository";
