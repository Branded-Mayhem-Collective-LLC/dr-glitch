/**
 * AppSessionController — the application state spine.
 *
 * Owns exactly one storage backend (IdbBackend, MemoryBackend fallback), the
 * repositories built on it, the recovery journal, cross-tab ownership, the
 * open project's ProjectStore/DocumentApi, and the ProjectLibraryApi binding
 * the home surface renders against.
 *
 * Framework-free: React binds via subscribe/getSnapshot. Every environment
 * touchpoint (backend, ownership, timers, last-open storage, sample factory)
 * is injectable so the controller is fully testable on MemoryBackend in node.
 *
 * Revision handshake (store <-> repository):
 * - `casToken` is the repository-side savedRevision (the CAS token). The
 *   store's session revision starts at the loaded envelope's savedRevision
 *   and increments per committed transaction; the two counters advance
 *   independently.
 * - On explicit Save we submit the working envelope with savedRevision =
 *   casToken; the repository CAS-increments it. On success the controller
 *   adopts the returned token AND calls store.markSaved(sessionRevision) so
 *   dirty flips off without renumbering session history.
 * - Recovery records carry the session revision; loadNewer(projectId,
 *   casToken) is therefore "is there journaled work past the last explicit
 *   save".
 */
import {
  createLayerFromAsset,
  createEmptyProject,
  createEmptyProjectCore,
  applyCommand,
  ProjectStore,
} from "../project";
import type {
  Id,
  ProjectEnvelopeV1,
  RecoveryRecordV1,
  Sha256,
} from "../core/types";
import {
  AssetRepository,
  ConflictError,
  IdbBackend,
  ImportStaging,
  MemoryBackend,
  NotFoundError,
  PresetRepository,
  ProjectRepository,
  RecoveryJournal,
  acquireOwnership,
  collectEnvelopeAssetRefs,
  createOwnershipDeps,
  systemTimer,
  RECOVERY_DEBOUNCE_MS,
  type OwnershipDeps,
  type OwnershipHandle,
  type OwnershipLock,
  type StorageBackend,
  type TimerHost,
} from "../storage";
import { GcRootScanError } from "../storage";
import { StorageStagingSink } from "../storage/import-sink";
import { captureHandledError, stableErrorCode, traceAppOperation } from "../telemetry/sentry";
import { createId } from "../core/id";
import { RESOURCE_POLICY } from "../core/resource-policy";
import {
  ArchiveValidationError,
  DEFAULT_IMPORT_TIMEOUT_MS,
  DrglitchError,
  MAX_PRESET_TEXT_LENGTH,
  PresetValidationError,
  createBrowserRasterDecoder,
  exportDrglitch,
  exportDrglitchToSink,
  planDrglitchExport,
  hasBrowserRasterDecoder,
  importDrglitch,
  parsePreset,
  type DrglitchImportProgress,
  type DrglitchByteSink,
  type ExportDrglitchOptions,
  type RasterDecoder,
} from "../io";
import type { RecipePresetV1 } from "../core/types";
import type { ProjectLibraryApi, ProjectSummary, TrashSummary } from "../home/library";
import { DocumentApi, RECOVERED_WORK_LABEL } from "./document-api";

export const LAST_OPEN_STORAGE_KEY = "drglitch.last-project.v1";
export const APP_VERSION = "0.1.0";

/** Thrown by session operations invoked after (or during) dispose(). */
export class SessionDisposedError extends Error {
  constructor() {
    super("This session has been disposed and can no longer be used.");
    this.name = "SessionDisposedError";
  }
}

/** Minimal key-value store for the last-open project id (localStorage). */
export type KeyValueStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

/**
 * Last-open persistence is PER TAB (sessionStorage): reloading a studio tab
 * restores its project (recovery applies), while a brand-new tab always
 * lands on Home — localStorage would drag every new tab into the project
 * and defeat the read-only second-tab flow.
 */
export function browserKeyValueStore(): KeyValueStore {
  return {
    get(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        /* privacy mode: session-only behavior */
      }
    },
    remove(key) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

function memoryKeyValueStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

export type SampleArtwork = {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  layerName: string;
  title: string;
};

export type RecoveryUiState = "none" | "pending" | "flushed";

export type OpenProject = {
  projectId: Id;
  store: ProjectStore;
  doc: DocumentApi;
  ownership: OwnershipHandle;
  readOnly: boolean;
  /** Display title; the store envelope's title may lag (see performSave). */
  title: string;
  /** Repository-side savedRevision CAS token; 0 = never explicitly saved. */
  casToken: number;
  /** False for in-memory (sample / snapshot-duplicate) projects. */
  persisted: boolean;
  /** True until the user's first explicit Save of this project. */
  neverSaved: boolean;
  /** True when this open adopted a newer recovery journal. */
  recovered: boolean;
};

export type SessionSnapshot = {
  backendKind: "idb" | "memory";
  /**
   * False when the session runs on the in-memory fallback backend: nothing
   * written this session survives a reload. The UI must surface this loudly
   * BEFORE the user trusts Save (see StorageModeBanner) — Save still works,
   * but only for the lifetime of the tab.
   */
  durable: boolean;
  open: OpenProject | null;
  recoveryState: RecoveryUiState;
  /** Non-blocking storage alert (quota etc.); null when clear. */
  storageAlert: string | null;
  version: number;
};

export type AppSessionOptions = {
  backend?: StorageBackend;
  backendKind?: "idb" | "memory";
  ownership?: OwnershipDeps;
  timer?: TimerHost;
  now?: () => number;
  journalDebounceMs?: number;
  keyValue?: KeyValueStore;
  /** Builds the bundled sample artwork bytes (canvas in the browser). */
  sampleFactory?: () => Promise<SampleArtwork>;
  /**
   * dispose() closes the backend only when the controller owns it (set by
   * AppSessionController.create). Injected backends stay open — tests share
   * one MemoryBackend across controllers to simulate multiple tabs.
   */
  ownsBackend?: boolean;
  /**
   * Full raster decode adapter for imports and at-rest verification.
   * Defaults to the real browser decoder when the environment has one;
   * node tests importing rasters MUST inject a decoder — without one, any
   * .drglitch import that contains a raster fails closed with the typed
   * "raster-decode-unavailable" rejection (header-only validation never
   * silently counts as full validation).
   */
  rasterDecoder?: RasterDecoder;
};

/* ------------------------------------------------------------------ */
/* Cancellable project import (UI seam for wave F)                     */
/* ------------------------------------------------------------------ */

/**
 * Handle returned by importProjectFileCancellable(). SEAM FOR WAVE F: the
 * import UI wires its Cancel affordance to cancel() and its progress
 * readout to onProgress(); this controller owns everything behind the
 * handle (one operation-scoped deadline/AbortSignal spanning file read →
 * extraction → parsing → hashing → full media validation → staging →
 * atomic commit, with exactly-once cleanup and zero surviving rows on
 * cancel/timeout at any stage).
 */
export type CancellableProjectImport = {
  /** Resolves to the installed project id; rejects with typed errors
   * (ArchiveValidationError "archive-aborted" after cancel()). */
  promise: Promise<Id>;
  /** Idempotent; cancels the WHOLE operation at its next checkpoint. */
  cancel(): void;
  /** Subscribe to coarse progress; returns the unsubscribe function. */
  onProgress(listener: (progress: DrglitchImportProgress) => void): () => void;
};

/** Minimal file surface the import intake needs (File satisfies it). */
export type ImportSourceFile = {
  size: number;
  stream?: () => ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function exportAbortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "Aborted",
    "AbortError",
  );
}

/** Cancellation race for storage/provider awaits used by archive operations. */
async function raceWithExportAbort<T>(value: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) throw exportAbortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(exportAbortError(signal));
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

/**
 * Read a (pre-size-gated) file under the import's AbortSignal. Prefers the
 * streaming reader so cancellation lands between chunks instead of after a
 * monolithic arrayBuffer() completes.
 */
async function readFileWithSignal(file: ImportSourceFile, signal: AbortSignal): Promise<Uint8Array> {
  const assertLive = (): void => {
    if (signal.aborted) {
      throw new ArchiveValidationError("archive-aborted", "The import was cancelled while reading the file.");
    }
  };
  assertLive();
  if (typeof file.stream === "function") {
    const reader = file.stream().getReader();
    const target = new Uint8Array(file.size);
    let offset = 0;
    let cancelPromise: Promise<void> | null = null;
    const cancelOnce = (reason?: unknown): Promise<void> => {
      cancelPromise ??= Promise.resolve(reader.cancel(reason)).then(
        () => undefined,
        () => undefined,
      );
      return cancelPromise;
    };
    const onAbort = () => void cancelOnce(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        assertLive();
        // A provider is allowed to leave read() pending. Race it so session
        // disposal/cancel settles promptly, while cancelOnce releases the
        // underlying stream exactly once.
        const { done, value } = await raceWithExportAbort(reader.read(), signal);
        assertLive();
        if (done) break;
        if (offset + value.length > target.length) {
          throw new ArchiveValidationError("archive-invalid", "The file changed while it was being read.");
        }
        target.set(value, offset);
        offset += value.length;
      }
    } catch (error) {
      void cancelOnce(error);
      if (signal.aborted) {
        throw new ArchiveValidationError(
          "archive-aborted",
          "The import was cancelled while reading the file.",
        );
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { reader.releaseLock(); } catch { /* cancel owns a still-pending read */ }
    }
    if (offset !== target.length) {
      throw new ArchiveValidationError("archive-invalid", "The file changed while it was being read.");
    }
    return target;
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await raceWithExportAbort(file.arrayBuffer(), signal);
  } catch (error) {
    if (signal.aborted) {
      throw new ArchiveValidationError(
        "archive-aborted",
        "The import was cancelled while reading the file.",
      );
    }
    throw error;
  }
  assertLive();
  return new Uint8Array(buffer);
}

export class AppSessionController {
  readonly backend: StorageBackend;
  readonly backendKind: "idb" | "memory";
  readonly projects: ProjectRepository;
  readonly assets: AssetRepository;
  readonly presets: PresetRepository;
  readonly journal: RecoveryJournal;
  readonly library: ProjectLibraryApi;

  private readonly ownershipDeps: OwnershipDeps;
  private readonly timer: TimerHost;
  private readonly now: () => number;
  private readonly journalDebounceMs: number;
  private readonly keyValue: KeyValueStore;
  private readonly sampleFactory: (() => Promise<SampleArtwork>) | null;
  /** Real decoder in the browser; null in non-DOM environments unless injected. */
  private readonly rasterDecoder: RasterDecoder | null;

  /** Never-persisted projects addressable by id (sample, snapshot copies). */
  private readonly unsavedProjects = new Map<Id, ProjectEnvelopeV1>();

  private open: OpenProject | null = null;
  private recoveryState: RecoveryUiState = "none";
  private storageAlert: string | null = null;
  private storeUnsubscribe: (() => void) | null = null;
  private ownershipUnsubscribes: (() => void)[] = [];
  private lastJournaledRevision = 0;
  private version = 0;
  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private readonly ownsBackend: boolean;
  private readonly ownsOwnershipDeps: boolean;
  /** Pending "recovery flushed" UI-signal timer (see scheduleJournal). */
  private flushedSignalTimer: ReturnType<TimerHost["set"]> | null = null;

  constructor(options: AppSessionOptions) {
    if (!options.backend) throw new Error("AppSessionController requires a backend; use AppSessionController.create()");
    this.backend = options.backend;
    this.backendKind = options.backendKind ?? "memory";
    this.timer = options.timer ?? systemTimer;
    this.now = options.now ?? Date.now;
    this.journalDebounceMs = options.journalDebounceMs ?? RECOVERY_DEBOUNCE_MS;
    this.keyValue = options.keyValue ?? memoryKeyValueStore();
    this.sampleFactory = options.sampleFactory ?? null;
    this.ownsBackend = options.ownsBackend ?? false;
    this.ownsOwnershipDeps = !options.ownership;
    this.ownershipDeps = options.ownership ?? createOwnershipDeps(this.backend);
    this.rasterDecoder =
      options.rasterDecoder ?? (hasBrowserRasterDecoder() ? createBrowserRasterDecoder() : null);
    this.projects = new ProjectRepository(this.backend, { now: this.now });
    this.assets = new AssetRepository(this.backend, {
      now: this.now,
      // With a decoder, verified reads/writes are decode-strength (full
      // payload). Without one (non-DOM, none injected) they stop at
      // header + hash strength — imports still fail closed via importDrglitch.
      ...(this.rasterDecoder ? { rasterDecoder: this.rasterDecoder } : {}),
    });
    this.presets = new PresetRepository(this.backend);
    this.journal = new RecoveryJournal(this.backend, {
      debounceMs: this.journalDebounceMs,
      timer: this.timer,
      onError: (error) => this.reportStorageError(error),
    });
    this.library = this.buildLibrary();
    this.snapshot = this.buildSnapshot();
    // Startup maintenance: purge staging areas abandoned by a crashed import,
    // then reclaim orphaned asset blobs. Age-gated (STAGING_ABANDONED_AFTER_MS
    // for staging; ASSET_GC_GRACE_MS inside the GC) so an in-flight
    // import/save in another tab is never raced; fire-and-forget, but
    // awaitable by tests. scheduleAssetGc never rejects.
    this.startupMaintenance = new ImportStaging(this.backend, { now: this.now })
      .sweepAbandonedStaging()
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn("Abandoned-import sweep failed:", error);
      })
      .then(() => this.scheduleAssetGc("startup"));
  }

  /** Resolves when boot-time storage maintenance (staging sweep) finished. */
  readonly startupMaintenance: Promise<void>;

  /** True when writes land in IndexedDB; false on the in-memory fallback. */
  get isDurable(): boolean {
    return this.backendKind === "idb";
  }

  /** Opens IndexedDB; falls back to a MemoryBackend so the app still runs. */
  static async create(options: Omit<AppSessionOptions, "backend" | "backendKind"> = {}): Promise<AppSessionController> {
    let backend: StorageBackend;
    let backendKind: "idb" | "memory";
    try {
      backend = await IdbBackend.open();
      backendKind = "idb";
    } catch {
      backend = new MemoryBackend();
      backendKind = "memory";
    }
    return new AppSessionController({
      ...options,
      backend,
      backendKind,
      ownsBackend: true,
      keyValue:
        options.keyValue ??
        (typeof window !== "undefined" ? browserKeyValueStore() : memoryKeyValueStore()),
    });
  }

  /**
   * Idempotent session teardown: refuses new operations (typed
   * SessionDisposedError), AWAITS any in-flight open chain so a project can
   * never finish opening against a closed backend or retain its write lock,
   * then closes the open project (journal flush + ownership release),
   * cancels the pending recovery-signal timer, closes the self-created
   * ownership bus, and closes the backend when owned (so IndexedDB deletion
   * by the clean-storage flow is never blocked by a lingering connection).
   *
   * Every caller shares ONE memoized disposal promise — concurrent dispose()
   * calls never run the teardown twice. Safe to call on a controller that a
   * React StrictMode cleanup orphaned while create() was still in flight.
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.performDispose();
    return this.disposePromise;
  }

  private disposePromise: Promise<void> | null = null;

  private async performDispose(): Promise<void> {
    this.disposed = true;
    // Stop archive work immediately; do not let a stalled file/provider keep
    // running while unrelated project/ownership teardown drains.
    const activeArchiveOperations = [...this.activeArchiveOperations];
    for (const operation of activeArchiveOperations) operation.abort();
    // Let any in-flight open settle first (it bails with SessionDisposedError
    // after releasing whatever it acquired — see openProjectExclusive).
    await this.openChain.catch(() => undefined);
    try {
      await this.closeProject({ keepLastOpen: true });
    } catch {
      /* best-effort: release already reported storage errors */
    }
    // Drain queued ownership transitions (they no-op on the identity check
    // now that the project is closed) so no transient handle or probe can
    // outlive the session or touch a closed backend.
    await this.transitionChain.catch(() => undefined);
    // Abort and drain every import/export operation BEFORE GC and backend
    // close. Imports may still own staging transactions; exports may still
    // read assets. Neither may touch storage after teardown advances.
    await Promise.all(activeArchiveOperations.map((entry) => entry.settled));
    // Drain in-flight asset GC after imports have either committed or fully
    // cleaned staging (queued runs no-op on the disposed check).
    await this.gcChain.catch(() => undefined);
    if (this.flushedSignalTimer !== null) {
      this.timer.clear(this.flushedSignalTimer);
      this.flushedSignalTimer = null;
    }
    if (this.ownsOwnershipDeps) this.ownershipDeps.bus.close();
    if (this.ownsBackend) this.backend.close();
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new SessionDisposedError();
  }

  /* ----- subscription ----- */

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SessionSnapshot => this.snapshot;

  private buildSnapshot(): SessionSnapshot {
    return {
      backendKind: this.backendKind,
      durable: this.isDurable,
      open: this.open,
      recoveryState: this.recoveryState,
      storageAlert: this.storageAlert,
      version: this.version,
    };
  }

  private bump(): void {
    this.version += 1;
    // OpenProject is mutated in place; clone the reference so React sees change.
    if (this.open) this.open = { ...this.open };
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Re-resolves the LIVE OpenProject for a store. bump() replaces this.open
   * with a shallow clone on every notification, so an OpenProject reference
   * captured before an await goes stale the moment anything bumps mid-await
   * (a mid-save edit, a journal flush signal, an ownership event) — mutating
   * the stale clone would silently discard the mutation. Store identity
   * survives cloning, so it keys the lookup.
   */
  private liveOpen(store: ProjectStore, fallback: OpenProject): OpenProject {
    const open = this.open;
    return open && open.store === store ? open : fallback;
  }

  private reportStorageError(error: unknown): void {
    const quota = error instanceof Error && /quota/i.test(`${error.name} ${error.message}`);
    // One scrubbed stable-code event per real storage failure. Errors are
    // deduped on the error OBJECT: a failure that flows through several
    // surfaces (journal onError, save catch, lifecycle flush) reports once,
    // and the SDK's global handlers skip marked errors. Inert without a DSN.
    captureHandledError(quota ? "storage-quota" : "storage-write-failed", error);
    this.storageAlert = quota
      ? "Local storage is full. Your work stays in memory and the last save is untouched — free space or export your project."
      : "A storage write failed. Your in-memory work and last explicit save are untouched.";
    this.bump();
  }

  clearStorageAlert(): void {
    if (this.storageAlert === null) return;
    this.storageAlert = null;
    this.bump();
  }

  /* ----- last-open project ----- */

  get lastOpenProjectId(): Id | null {
    return this.keyValue.get(LAST_OPEN_STORAGE_KEY);
  }

  clearLastOpenProject(): void {
    this.keyValue.remove(LAST_OPEN_STORAGE_KEY);
  }

  /* ----- open/close ----- */

  getOpenProject(): OpenProject | null {
    return this.open;
  }

  private async resolveEnvelope(projectId: Id, signal?: AbortSignal): Promise<{
    envelope: ProjectEnvelopeV1;
    persisted: boolean;
    /** True when the envelope was rebuilt from the recovery journal alone. */
    recoveredFromJournal: boolean;
  }> {
    const unsaved = this.unsavedProjects.get(projectId);
    if (unsaved) return { envelope: unsaved, persisted: false, recoveredFromJournal: false };
    try {
      return {
        envelope: await raceWithExportAbort(this.projects.load(projectId), signal),
        persisted: true,
        recoveredFromJournal: false,
      };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Persisted recovery base for never-saved projects: an unsaved
      // sample/snapshot-duplicate lives only in this map, which is empty on
      // a fresh boot — but its recovery journal (full core + snapshots +
      // title) survives the crash. Hydrate an unsaved envelope from the
      // journal so the work reopens recovered+dirty instead of vanishing.
      // Chosen over persisting placeholder project rows because journal
      // records are already crash-durable, asset-GC roots, and invisible to
      // the library/trash — no schema or GC changes needed.
      const record = await raceWithExportAbort(this.journal.load(projectId), signal);
      if (!record) throw error;
      const envelope: ProjectEnvelopeV1 = {
        schema: 1,
        id: record.projectId,
        title: record.title,
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
        savedRevision: 0,
        core: record.core,
        snapshots: record.snapshots,
      };
      if (signal?.aborted) throw exportAbortError(signal);
      this.unsavedProjects.set(projectId, envelope);
      return { envelope, persisted: false, recoveredFromJournal: true };
    }
  }

  /** Serializes opens so StrictMode double-effects can't race the lock. */
  private openChain: Promise<unknown> = Promise.resolve();

  openProject(projectId: Id): Promise<OpenProject> {
    if (this.disposed) return Promise.reject(new SessionDisposedError());
    const next = this.openChain
      .catch(() => undefined)
      .then(() => {
        this.assertNotDisposed();
        return this.openProjectExclusive(projectId);
      });
    this.openChain = next;
    return next;
  }

  private async openProjectExclusive(projectId: Id): Promise<OpenProject> {
    if (this.open?.projectId === projectId) return this.open;
    await this.closeProject({ keepLastOpen: true });

    const { envelope, persisted, recoveredFromJournal } = await this.resolveEnvelope(projectId);
    const ownership = await acquireOwnership(projectId, this.ownershipDeps);
    if (this.disposed) {
      // dispose() started while we were acquiring: hand the lock straight
      // back and bail — no open state may outlive the session.
      await ownership.release();
      throw new SessionDisposedError();
    }
    const readOnly = ownership.status !== "owner";
    const casToken = persisted ? envelope.savedRevision : 0;

    let store: ProjectStore;
    let recovered = recoveredFromJournal;
    if (!readOnly && persisted) {
      const record = await this.journal.loadNewer(projectId, casToken);
      if (record) {
        store = this.buildRecoveredStore(envelope, record);
        recovered = true;
      } else {
        store = new ProjectStore(envelope, { now: this.now });
      }
    } else {
      store = new ProjectStore(envelope, { now: this.now });
    }

    const open: OpenProject = {
      projectId,
      store,
      doc: new DocumentApi(store, { readOnly }),
      ownership,
      readOnly,
      title: envelope.title,
      casToken,
      persisted,
      neverSaved:
        !persisted ||
        casToken === 0 ||
        (casToken <= 1 && envelope.title === "Untitled"),
      recovered,
    };
    this.open = open;
    this.recoveryState = "none";
    this.lastJournaledRevision = store.getState().revision;
    this.attachStore(open);
    this.attachOwnership(open);
    this.keyValue.set(LAST_OPEN_STORAGE_KEY, projectId);
    this.bump();
    return this.open ?? open;
  }

  /**
   * Recovery adoption: base the store on the saved envelope (plus the
   * journal's snapshots), then commit the journaled core as one transaction,
   * so the state is recovered AND dirty, and Undo returns to the last save.
   */
  private buildRecoveredStore(envelope: ProjectEnvelopeV1, record: RecoveryRecordV1): ProjectStore {
    const store = new ProjectStore(
      { ...envelope, snapshots: record.snapshots },
      { now: this.now },
    );
    store.beginTransaction(RECOVERED_WORK_LABEL);
    store.updateTransaction({ type: "snapshot/restore", core: record.core });
    store.commitTransaction();
    return store;
  }

  async closeProject(options: { keepLastOpen?: boolean } = {}): Promise<void> {
    const open = this.open;
    if (!open) {
      if (!options.keepLastOpen) this.clearLastOpenProject();
      return;
    }
    this.storeUnsubscribe?.();
    this.storeUnsubscribe = null;
    for (const unsubscribe of this.ownershipUnsubscribes) unsubscribe();
    this.ownershipUnsubscribes = [];
    try {
      await this.journal.flushNow();
    } catch (error) {
      this.reportStorageError(error);
    }
    await open.ownership.release();
    this.open = null;
    this.recoveryState = "none";
    if (!options.keepLastOpen) this.clearLastOpenProject();
    this.bump();
  }

  /* ----- journaling ----- */

  /**
   * bump() replaces this.open with a shallow clone so React sees changes,
   * so the subscription must re-resolve the CURRENT OpenProject on every
   * event — capturing the parameter would freeze casToken/persisted/title.
   */
  private attachStore(open: OpenProject): void {
    const { store, projectId } = open;
    // Snapshot-removal GC trigger state: the snapshots array reference only
    // changes on snapshot operations, so the comparison below is one
    // identity check per commit in the common case.
    let lastSnapshots = store.getEnvelope().snapshots;
    this.storeUnsubscribe = store.subscribe(() => {
      const current = this.open;
      if (!current || current.projectId !== projectId || current.store !== store) return;
      const state = store.getState();
      if (state.transactionOpen) return;
      if (current.readOnly) return;
      const snapshots = state.envelope.snapshots;
      if (snapshots !== lastSnapshots) {
        const previous = lastSnapshots;
        lastSnapshots = snapshots;
        // Deleted snapshot, or replaced/dropped thumbnail: a thumbnail (and
        // possibly snapshot-only asset refs) may just have lost its last
        // in-session reference. Durable rows still root it until the next
        // save/journal flush, so this trigger is an opportunity, never a
        // correctness requirement.
        const kept = new Set(snapshots.map((snapshot) => snapshot.thumbnailId));
        const removedRef =
          snapshots.length < previous.length ||
          previous.some(
            (snapshot) => snapshot.thumbnailId !== null && !kept.has(snapshot.thumbnailId),
          );
        if (removedRef) void this.scheduleAssetGc("snapshot-removed");
      }
      if (state.revision === this.lastJournaledRevision) {
        this.bump();
        return;
      }
      this.lastJournaledRevision = state.revision;
      this.scheduleJournal(current);
      this.bump();
    });
  }

  private journalRecord(open: OpenProject): RecoveryRecordV1 {
    const envelope = open.store.getEnvelope();
    const state = open.store.getState();
    // The session counter and the repository CAS token advance independently
    // (renames bump the token without a session edit), so the journaled
    // revision is rebased: casToken + edits-past-last-save. loadNewer's
    // `revision > savedRevision` then means exactly "dirty work exists".
    const editsPastSave = Math.max(0, state.revision - envelope.savedRevision);
    return {
      projectId: open.projectId,
      revision: open.casToken + editsPastSave,
      savedRevision: open.casToken,
      updatedAt: this.now(),
      title: open.title,
      core: envelope.core,
      snapshots: envelope.snapshots,
    };
  }

  private scheduleJournal(open: OpenProject): void {
    if (!open.persisted && !this.unsavedProjects.has(open.projectId)) return;
    this.journal.scheduleJournal(this.journalRecord(open));
    this.recoveryState = "pending";
    // Deterministic "flushed" signal shortly after the debounce window.
    if (this.flushedSignalTimer !== null) this.timer.clear(this.flushedSignalTimer);
    this.flushedSignalTimer = this.timer.set(() => {
      this.flushedSignalTimer = null;
      if (this.open?.projectId !== open.projectId) return;
      if (this.journal.latestInMemory(open.projectId) === undefined) {
        this.recoveryState = "flushed";
        this.bump();
      }
    }, this.journalDebounceMs + 40);
  }

  /** Lifecycle flush: call on visibilitychange(hidden)/pagehide/beforeunload. */
  async flushJournalNow(): Promise<void> {
    try {
      await this.journal.flushNow();
      if (this.open && this.journal.latestInMemory(this.open.projectId) === undefined && this.recoveryState === "pending") {
        this.recoveryState = "flushed";
        this.bump();
      }
    } catch (error) {
      this.reportStorageError(error);
    }
  }

  /* ----- asset garbage collection (lifecycle maintenance) ----- */

  /**
   * Session roots: asset references that exist ONLY in this tab's memory —
   * the open project's working envelope (unsaved edits, freshly imported
   * artwork/custom shapes/snapshot thumbnails not yet journaled) and every
   * never-persisted project (sample, snapshot duplicates). The durable root
   * scan cannot see these, so every GC this session triggers must carry
   * them; without them a long-lived unsaved project would outlive the GC
   * grace window and lose its blobs.
   */
  private sessionAssetRoots(): Set<Sha256> {
    const roots = new Set<Sha256>();
    const addEnvelope = (envelope: ProjectEnvelopeV1): void => {
      for (const sha of collectEnvelopeAssetRefs(envelope)) roots.add(sha);
    };
    if (this.open) addEnvelope(this.open.store.getEnvelope());
    for (const envelope of this.unsavedProjects.values()) addEnvelope(envelope);
    return roots;
  }

  /** Serialized fire-and-forget GC runs; drained by dispose(). */
  private gcChain: Promise<void> = Promise.resolve();

  /**
   * Queue one asset GC pass at a safe lifecycle point. Fire-and-forget by
   * design: callers `void` the returned promise (tests await it). The
   * returned promise NEVER rejects — failures are contained here (typed
   * GcRootScanError = conservative full retention; quota/transaction
   * failures roll back to the retain-everything state), logged, and never
   * become unhandled rejections or block UX. Runs are serialized and
   * idempotent, so overlapping triggers cannot double-sweep.
   */
  scheduleAssetGc(reason: string): Promise<void> {
    const next = this.gcChain
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) return;
        await this.assets.garbageCollect({ extraRoots: this.sessionAssetRoots() });
      })
      .catch((error: unknown) => {
        // Conservative outcome is already guaranteed (nothing was deleted);
        // surfacing is log-only so background maintenance never alarms UX.
        // A GcRootScanError is the one condition worth an event: a corrupt
        // root row blocks reclamation indefinitely by design (retain-all),
        // and nothing else would ever make that visible.
        if (error instanceof GcRootScanError) {
          captureHandledError("gc-root-scan-failed", error);
        }
        console.warn(`Asset GC (${reason}) skipped:`, error);
      });
    this.gcChain = next;
    return next;
  }

  /* ----- ownership ----- */

  /**
   * Ownership transitions (takeover handoff, released-promotion) are
   * SERIALIZED through one chain and IDENTITY-CHECKED: each queued
   * transition runs alone, and only if the handle that observed the event
   * is still the open project's current handle when its turn comes. A
   * transition initiated against a superseded handle — a duplicate release
   * notification, an event that raced closeProject/dispose or another
   * transition — no-ops instead of double-acquiring or resurrecting closed
   * state. The handlers re-check the same identity after their own awaits.
   */
  private transitionChain: Promise<void> = Promise.resolve();

  private queueOwnershipTransition(initiator: OwnershipHandle, run: () => Promise<void>): void {
    this.transitionChain = this.transitionChain
      .then(async () => {
        if (this.disposed) return;
        if (this.open?.ownership !== initiator) return; // stale: no-op
        await run();
      })
      .catch(() => {
        // A failed transition must never poison the chain; failures are
        // benign (project deleted mid-flight) or already surfaced.
      });
  }

  private attachOwnership(open: OpenProject): void {
    const handle = open.ownership;
    this.ownershipUnsubscribes.push(
      handle.onTakeoverRequested(() => {
        this.queueOwnershipTransition(handle, () => this.handleTakeoverRequested());
      }),
      handle.onOwnershipReleased(() => {
        this.queueOwnershipTransition(handle, () => this.handleOwnershipReleased());
      }),
      handle.onProjectChanged(() => {
        void this.handleRemoteProjectChanged();
      }),
    );
  }

  /** Owner side: hand the project over — flush, release, become a read-only WAITER. */
  private async handleTakeoverRequested(): Promise<void> {
    const captured = this.open;
    if (!captured || captured.readOnly) return;
    await this.flushJournalNow();
    if (this.open?.ownership !== captured.ownership) return; // closed mid-flush
    for (const unsubscribe of this.ownershipUnsubscribes) unsubscribe();
    this.ownershipUnsubscribes = [];
    await captured.ownership.release();
    // Re-arm as a pure WAITER, never a tryAcquire racer: the requester's
    // probe is ahead of us in the lock layer's queue (Web Locks FIFO; the
    // lease probe wait-first grace), so the requester wins the freed lock.
    // Parking our own probe BEHIND it lets this former owner recover
    // ownership later — on a cooperative handback or on the new owner's
    // silent crash — while requestTakeover still works over the bus.
    const realLock = this.ownershipDeps.lock;
    const waiterLock: OwnershipLock = {
      tryAcquire: async () => ({ acquired: false, release: async () => undefined }),
      ...(realLock.acquireWhenAvailable
        ? { acquireWhenAvailable: realLock.acquireWhenAvailable.bind(realLock) }
        : {}),
    };
    const ownership = await acquireOwnership(captured.projectId, {
      lock: waiterLock,
      bus: this.ownershipDeps.bus,
    });
    if (this.open?.store !== captured.store) {
      // Stale: the project closed while we were re-arming.
      await ownership.release();
      return;
    }
    const open = this.liveOpen(captured.store, captured);
    open.ownership = ownership;
    open.readOnly = true;
    open.doc.setReadOnly(true);
    this.attachOwnership(open);
    this.bump();
  }

  /** Read-only side: the owner released — adopt the probe grant or retry the lock. */
  private async handleOwnershipReleased(): Promise<void> {
    const captured = this.open;
    if (!captured || !captured.readOnly) return;
    // Adopt-first: when this handle's parked probe already HOLDS the lock,
    // promotion must reuse that exact grant. Releasing it to re-race a
    // fresh tryAcquire was the WEBLOCKS-RACE bug — the freed lock could be
    // granted to another parked waiter (or to nobody, the probe being
    // consumed), and the handoff died.
    const ownership =
      captured.ownership.adoptPendingOwnership() ??
      (await acquireOwnership(captured.projectId, this.ownershipDeps));
    if (ownership.status !== "owner") {
      await ownership.release();
      return;
    }
    if (this.open?.ownership !== captured.ownership) {
      // Stale: the project closed or transitioned while we acquired.
      await ownership.release();
      return;
    }
    for (const unsubscribe of this.ownershipUnsubscribes) unsubscribe();
    this.ownershipUnsubscribes = [];
    await captured.ownership.release();
    // Reload the envelope (and any newer recovery) now that we own it.
    let resolved: { envelope: ProjectEnvelopeV1; persisted: boolean };
    try {
      resolved = await this.resolveEnvelope(captured.projectId);
    } catch {
      // The owner deleted the project before releasing: nothing to promote.
      await ownership.release();
      return;
    }
    const { envelope, persisted } = resolved;
    if (this.open?.store !== captured.store) {
      await ownership.release();
      return;
    }
    let open = this.liveOpen(captured.store, captured);
    open.ownership = ownership;
    const casToken = persisted ? envelope.savedRevision : 0;
    const record = persisted ? await this.journal.loadNewer(open.projectId, casToken) : null;
    open = this.liveOpen(open.store, open);
    open.store = record
      ? this.buildRecoveredStore(envelope, record)
      : new ProjectStore(envelope, { now: this.now });
    open.doc = new DocumentApi(open.store, { readOnly: false });
    open.readOnly = false;
    open.title = envelope.title;
    open.casToken = casToken;
    open.persisted = persisted;
    open.recovered = record !== null;
    open.neverSaved = !persisted || casToken === 0;
    this.storeUnsubscribe?.();
    this.lastJournaledRevision = open.store.getState().revision;
    this.attachStore(open);
    this.attachOwnership(open);
    this.bump();
  }

  /** Read-only tab live-update: the owner saved a new revision. */
  private async handleRemoteProjectChanged(): Promise<void> {
    const open = this.open;
    if (!open || !open.readOnly) return;
    try {
      const envelope = await this.projects.load(open.projectId);
      open.store = new ProjectStore(envelope, { now: this.now });
      open.doc = new DocumentApi(open.store, { readOnly: true });
      open.title = envelope.title;
      open.casToken = envelope.savedRevision;
      this.bump();
    } catch {
      /* project may have been deleted by the owner */
    }
  }

  /** Read-only side action: ask the current owner to hand the project over. */
  requestOwnership(): void {
    this.open?.ownership.requestTakeover();
  }

  /** Read-only side action: fork the saved project as a new unsaved copy. */
  async duplicateAsUnsaved(): Promise<Id> {
    this.assertNotDisposed();
    const open = this.open;
    if (!open) throw new Error("No open project to duplicate");
    const source = open.persisted
      ? await this.projects.load(open.projectId)
      : open.store.getEnvelope();
    const timestamp = this.now();
    const copy: ProjectEnvelopeV1 = {
      ...structuredClone(source),
      id: createId(),
      title: `${open.title} copy`,
      createdAt: timestamp,
      updatedAt: timestamp,
      savedRevision: 0,
    };
    this.unsavedProjects.set(copy.id, copy);
    return copy.id;
  }

  /* ----- dirty state ----- */

  /**
   * Dirty for UI purposes: edits past the last explicit save, OR a project
   * whose content only exists outside the saved library (in-memory sample /
   * snapshot duplicates, imports installed at savedRevision 0). A freshly
   * created Untitled project with no edits is NOT dirty — its default core
   * is already persisted, so leaving it loses nothing.
   */
  isOpenProjectDirty(): boolean {
    const open = this.open;
    if (!open || open.readOnly) return false;
    return open.store.getState().dirty || !open.persisted || open.casToken === 0;
  }

  /* ----- save ----- */

  /** "dialog" when Save must first ask for a project name. */
  savePlan(): "dialog" | "silent" {
    const open = this.open;
    if (!open) return "silent";
    return open.neverSaved ? "dialog" : "silent";
  }

  /**
   * Explicit Save. Throws ConflictError on a CAS collision (the UI offers
   * Reload or Duplicate); every other failure surfaces as a storage alert
   * and rethrows. On success the store adopts the save (markSaved).
   */
  performSave(title?: string): Promise<void> {
    return traceAppOperation("app.save", () => this.performSaveInner(title));
  }

  private async performSaveInner(title?: string): Promise<void> {
    this.assertNotDisposed();
    const open = this.open;
    if (!open) throw new Error("No open project to save");
    if (open.readOnly) throw new Error("This project is open read-only");
    const name = title?.trim() || open.title;
    const envelope = open.store.getEnvelope();
    // Frozen revision: the exact session state this Save persists. Edits
    // that land while the write is in flight are NOT covered by it.
    const sessionRevision = open.store.getState().revision;
    try {
      let casToken: number;
      if (!open.persisted) {
        // Atomic first save: the COMPLETE unsaved envelope (core + snapshots
        // + title) lands in ONE transaction with savedRevision 1, pinned to
        // the open project id. Session flags are adopted only afterwards, so
        // a failure leaves the session unsaved+dirty with the in-memory
        // envelope intact and Save retryable — never a partial project row.
        const pinned = new ProjectRepository(this.backend, {
          now: this.now,
          newId: () => open.projectId,
        });
        const saved = await pinned.createFromEnvelope({ ...envelope, title: name });
        casToken = saved.savedRevision;
        this.unsavedProjects.delete(open.projectId);
      } else {
        const saved = await this.projects.saveExplicit({
          ...envelope,
          title: name,
          savedRevision: open.casToken,
        });
        casToken = saved.savedRevision;
      }
      // Adopt on the LIVE OpenProject: a mid-save edit bumps and clones
      // this.open, so the reference captured above may be stale by now.
      const live = this.liveOpen(open.store, open);
      live.persisted = true;
      live.casToken = casToken;
      live.title = name;
      live.neverSaved = false;
      live.recovered = false;
      live.store.markSaved(sessionRevision);
      const currentRevision = live.store.getState().revision;
      if (currentRevision === sessionRevision) {
        // Nothing changed while the write was in flight: the save covers
        // everything, so the journal can be dropped.
        this.lastJournaledRevision = currentRevision;
        await this.journal.clear(live.projectId);
        this.recoveryState = "none";
      } else {
        // Mid-save edits exist past the frozen revision. Clearing the
        // journal here would cancel their crash recovery — instead reschedule
        // it immediately for the CURRENT state (rebased on the new CAS
        // token). lastJournaledRevision reflects what is actually journaled.
        this.lastJournaledRevision = currentRevision;
        this.scheduleJournal(live);
      }
      live.ownership.notifyProjectChanged(live.casToken);
      this.bump();
    } catch (error) {
      if (error instanceof ConflictError) {
        // A CAS collision is a real handled failure (the UI offers
        // Reload/Duplicate); report it under its own stable code.
        captureHandledError("save-conflict", error);
      } else {
        this.reportStorageError(error);
      }
      throw error;
    }
  }

  /**
   * Dirty-guard "Discard": drops the journal (so the abandoned work can never
   * come back as recovery) and forgets a never-persisted project entirely.
   */
  async discardOpenProjectChanges(): Promise<void> {
    const open = this.open;
    if (!open) return;
    await this.journal.clear(open.projectId);
    this.recoveryState = "none";
    if (!open.persisted) {
      this.unsavedProjects.delete(open.projectId);
    } else if (open.casToken === 0) {
      // An installed-but-never-saved import: discarding removes the record so
      // it cannot linger invisibly outside the library.
      await this.closeProject({ keepLastOpen: true });
      await this.projects.deletePermanently(open.projectId);
      void this.scheduleAssetGc("discard-unsaved-import");
    }
    this.bump();
  }

  /** Recovery banner: drop the journal and reload the last explicit save. */
  async revertToLastSave(): Promise<void> {
    const captured = this.open;
    if (!captured || !captured.persisted) return;
    await this.journal.clear(captured.projectId);
    const envelope = await this.projects.load(captured.projectId);
    const open = this.liveOpen(captured.store, captured);
    open.store = new ProjectStore(envelope, { now: this.now });
    open.doc = new DocumentApi(open.store, { readOnly: open.readOnly });
    open.title = envelope.title;
    open.casToken = envelope.savedRevision;
    open.recovered = false;
    open.neverSaved = open.casToken === 0;
    this.storeUnsubscribe?.();
    this.lastJournaledRevision = open.store.getState().revision;
    this.attachStore(open);
    this.recoveryState = "none";
    this.bump();
  }

  /** Clears the recovered banner without touching the dirty state. */
  dismissRecoveryBanner(): void {
    if (!this.open?.recovered) return;
    this.open.recovered = false;
    this.bump();
  }

  /** Rename the open project ("Rename Project" dialog). */
  async renameOpenProject(title: string): Promise<void> {
    const open = this.open;
    if (!open) return;
    const name = title.trim();
    if (!name || name === open.title) return;
    if (open.persisted && !open.neverSaved) {
      const renamed = await this.projects.rename(open.projectId, name);
      const live = this.liveOpen(open.store, open);
      live.casToken = renamed.savedRevision;
      live.title = name;
      // Rename bumps the canonical save base, which invalidates any journal
      // recorded on the old base (loadNewer's base binding). If dirty work
      // exists, re-journal it immediately on the NEW base so a crash after
      // the rename still recovers it.
      if (live.store.getState().dirty) {
        this.lastJournaledRevision = live.store.getState().revision;
        this.scheduleJournal(live);
      }
      live.ownership.notifyProjectChanged(live.casToken);
    } else {
      this.liveOpen(open.store, open).title = name;
    }
    if (this.unsavedProjects.has(open.projectId)) {
      const unsaved = this.unsavedProjects.get(open.projectId)!;
      this.unsavedProjects.set(open.projectId, { ...unsaved, title: name });
    }
    this.bump();
  }

  /* ----- project creation / import / sample ----- */

  /** New persisted empty project (savedRevision 1, title "Untitled"). */
  async createProject(): Promise<Id> {
    this.assertNotDisposed();
    const envelope = await this.projects.create("Untitled", createEmptyProjectCore());
    return envelope.id;
  }

  /** The bundled sample as an in-memory unsaved project with one layer. */
  async openSampleAsUnsaved(): Promise<Id> {
    this.assertNotDisposed();
    if (!this.sampleFactory) throw new Error("No sample artwork factory configured");
    const sample = await this.sampleFactory();
    const record = await this.assets.putBlob(sample.bytes, "raster", sample.mime, {
      width: sample.width,
      height: sample.height,
    });
    const envelope = createEmptyProject({ title: sample.title, now: this.now() });
    const layer = createLayerFromAsset(
      record.sha256,
      sample.layerName,
      { width: sample.width, height: sample.height },
      envelope.core.artboard,
    );
    // Parity with the current studio: artwork is screened immediately, so
    // the first layer opens in halftone mode rather than the factory "clean".
    layer.recipe.mode = "halftone";
    envelope.core = applyCommand(envelope.core, { type: "layer/add", layer });
    this.unsavedProjects.set(envelope.id, envelope);
    return envelope.id;
  }

  /** Registers a snapshot-duplicate (or other unsaved) envelope for opening. */
  registerUnsavedProject(envelope: ProjectEnvelopeV1): Id {
    this.unsavedProjects.set(envelope.id, envelope);
    return envelope.id;
  }

  /**
   * Validates and atomically installs a .drglitch file; opens unsaved.
   * The whole pipeline honors options.signal/timeoutMs as ONE operation
   * budget; on cancel/timeout at any stage the staging sink aborts exactly
   * once and zero rows survive anywhere.
   */
  async importProjectFile(
    bytes: Uint8Array,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: DrglitchImportProgress) => void;
    } = {},
  ): Promise<Id> {
    return traceAppOperation("app.import", () => this.runTrackedArchiveOperation(options.signal, (signal) =>
      this.importProjectBytesInner(bytes, {
        signal,
        timeoutMs: options.timeoutMs,
        onProgress: options.onProgress,
      }),
    ));
  }

  /** Untracked body used only inside one runTrackedArchiveOperation owner. */
  private async importProjectBytesInner(
    bytes: Uint8Array,
    options: {
      signal: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: DrglitchImportProgress) => void;
    },
  ): Promise<Id> {
    const sink = new StorageStagingSink(this.backend);
    const installed = await importDrglitch(bytes, {
      sink,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress,
      // In the browser this is the real createImageBitmap decoder; in
      // non-DOM environments importDrglitch's default fails closed on the
      // first raster unless a decoder was injected into this controller.
      ...(this.rasterDecoder ? { decoder: this.rasterDecoder } : {}),
    });
    // The commit just retired this staging area (and possibly repaired
    // rows): reclaim anything a failed/abandoned earlier import left behind.
    void this.scheduleAssetGc("import-commit");
    return installed.id;
  }

  /**
   * Cancellable .drglitch intake — the session-level entry point for the
   * import UI (wave F wires Cancel/progress to the returned handle; see
   * CancellableProjectImport). The pre-size gate runs BEFORE any byte of
   * the file is read, and the file read itself is covered by the same
   * cancellation signal as extraction/validation/staging/commit.
   */
  importProjectFileCancellable(
    file: ImportSourceFile,
    options: { timeoutMs?: number } = {},
  ): CancellableProjectImport {
    const controller = new AbortController();
    const listeners = new Set<(progress: DrglitchImportProgress) => void>();
    const timeoutMs = options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("The import timed out.", "TimeoutError"));
    }, timeoutMs);
    const run = (signal: AbortSignal): Promise<Id> => {
      // Size gate BEFORE reading: never materialize an oversized archive in
      // memory. Mirrors the io layer's compressed-size policy and its typed
      // error style, so the UI message matches a post-read reject.
      if (file.size > RESOURCE_POLICY.maxArchiveCompressedBytes) {
        return Promise.reject(new ArchiveValidationError(
          "archive-too-large",
          `The archive exceeds ${RESOURCE_POLICY.maxArchiveCompressedBytes} compressed bytes.`,
        ));
      }
      return readFileWithSignal(file, signal).then((bytes) => {
        const remainingMs = deadline - Date.now();
        if (timedOut || remainingMs <= 0) {
          throw new ArchiveValidationError(
            "archive-timeout",
            "Archive processing exceeded the time budget while reading the file.",
          );
        }
        return this.importProjectBytesInner(bytes, {
          signal,
          timeoutMs: remainingMs,
          onProgress: (progress) => {
            for (const listener of [...listeners]) listener(progress);
          },
        });
      });
    };
    const promise = traceAppOperation("app.import", () => this.runTrackedArchiveOperation(controller.signal, run)).catch((error: unknown) => {
      if (timedOut && error instanceof ArchiveValidationError && error.code === "archive-aborted") {
        error = new ArchiveValidationError(
          "archive-timeout",
          "Archive processing exceeded the time budget while reading the file.",
        );
      }
      // Archive trust-boundary telemetry: every typed rejection of the ONE
      // intake path reports its stable archive-* code — except explicit
      // cancellation, which is user intent, not a failure.
      if (error instanceof ArchiveValidationError && error.code !== "archive-aborted") {
        captureHandledError(stableErrorCode(error.code, "archive-invalid"), error);
      }
      throw error;
    }).finally(() => clearTimeout(timeout));
    return {
      promise,
      cancel: () => controller.abort(),
      onProgress: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
  }

  /**
   * Hardened .drpreset intake: the session-level preset entry point. The
   * size gate compares File.size (bytes) against MAX_PRESET_TEXT_LENGTH
   * BEFORE file.text() ever runs (UTF-8 byte count >= character count, so
   * the byte gate is conservative), then the hardened parser runs exactly —
   * any failure is a typed PresetValidationError and nothing is saved.
   * SEAM (wave F): PresetsSection performs the same gate in the UI; any
   * preset import path reachable from the session must call THIS method.
   */
  async importPresetFile(file: { size: number; text(): Promise<string> }): Promise<RecipePresetV1> {
    this.assertNotDisposed();
    if (file.size > MAX_PRESET_TEXT_LENGTH) {
      throw new PresetValidationError(
        "preset-too-large",
        `The preset file exceeds ${MAX_PRESET_TEXT_LENGTH} bytes.`,
      );
    }
    const preset = parsePreset(await file.text());
    await this.presets.save(preset);
    return preset;
  }

  /** Envelope selection shared by the buffered and streamed exporters. */
  private async exportEnvelopeFor(projectId: Id, signal?: AbortSignal): Promise<ProjectEnvelopeV1> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const envelope = this.open?.projectId === projectId
      ? { ...this.open.store.getEnvelope(), title: this.open.title }
      : (await this.resolveEnvelope(projectId, signal)).envelope;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return envelope;
  }

  private static drglitchFilename(title: string): string {
    return `${title.replace(/[^\w\d-]+/g, "-").replace(/^-+|-+$/g, "") || "project"}.drglitch`;
  }

  /**
   * Atomic asset/thumbnail snapshots shared by both exporters. Metadata and
   * the one-shot body reader come from one IndexedDB row clone; execution
   * applies plan/policy gates before `readBytes` allocates anything.
   */
  private drglitchSources(): Pick<ExportDrglitchOptions, "getBoundSource" | "decoder"> {
    return {
      ...(this.rasterDecoder ? { decoder: this.rasterDecoder } : {}),
      getBoundSource: async (sha256, kind, signal) => {
        const snapshot = await this.assets.openExportSnapshot(
          sha256,
          kind === "thumbnail" ? "thumbnail" : "raster",
          signal,
        );
        if (!snapshot) return undefined;
        return { record: snapshot.record, readBytes: snapshot.readBytes };
      },
    };
  }

  /** Portable .drglitch bytes for a project (saved state, or the open working state). */
  async exportProjectArchive(
    projectId: Id,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ filename: string; bytes: Uint8Array }> {
    return this.runTrackedArchiveOperation(options.signal, (signal) =>
      this.exportProjectArchiveInner(projectId, signal),
    );
  }

  private async exportProjectArchiveInner(
    projectId: Id,
    signal?: AbortSignal,
  ): Promise<{ filename: string; bytes: Uint8Array }> {
    const envelope = await this.exportEnvelopeFor(projectId, signal);
    // ONE PLAN, TWO DELIVERY MODES: the buffered packager consumes the
    // same frozen manifest as the streamed one (typed pre-read failures,
    // TOCTOU row assertions).
    const plan = await planDrglitchExport({
      envelope,
      appVersion: APP_VERSION,
      getRecord: this.drglitchPlanRecords(),
      ...(signal ? { signal } : {}),
    });
    // Defense in depth against plan A/B divergence: the BUFFERED path
    // re-applies the in-memory retention cap to ITS OWN fresh plan before
    // any bodies are read — a project that grew past the Blob cap between
    // the caller's routing decision and this call refuses typed here
    // instead of silently buffering an oversized archive.
    if (plan.estimatedBytes > RESOURCE_POLICY.maxBlobDownloadBytes) {
      throw new DrglitchError(
        "archive-too-large",
        `Cannot export buffered: the archive is estimated at ${plan.estimatedBytes} bytes, ` +
          `beyond the ${RESOURCE_POLICY.maxBlobDownloadBytes}-byte in-memory delivery cap; ` +
          "use the streamed (File System Access) delivery path.",
      );
    }
    if (plan.bufferedPeakBytes > RESOURCE_POLICY.maxRenderPeakBytes) {
      throw new DrglitchError(
        "archive-working-set",
        `Cannot export buffered: the estimated ${plan.bufferedPeakBytes}-byte peak exceeds ` +
          `the ${RESOURCE_POLICY.maxRenderPeakBytes}-byte in-memory export budget; ` +
          "use the streamed (File System Access) delivery path.",
      );
    }
    const bytes = await exportDrglitch({
      envelope,
      appVersion: APP_VERSION,
      plan,
      ...(signal ? { signal } : {}),
      ...this.drglitchSources(),
    });
    return { filename: AppSessionController.drglitchFilename(envelope.title), bytes };
  }

  /** Record source for the metadata-only archive plan (ZERO body reads). */
  private drglitchPlanRecords() {
    return async (sha256: Sha256, kind: "asset" | "thumbnail", signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const record = await raceWithExportAbort(
        this.assets.getRecord(
          sha256,
          kind === "thumbnail" ? "thumbnail" : "raster",
        ),
        signal,
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return record
        ? {
            sha256: record.sha256,
            kind: record.kind,
            byteLength: record.byteLength,
            mime: record.mime,
            width: record.width,
            height: record.height,
          }
        : undefined;
    };
  }

  /**
   * FROZEN delivery plan for a project export (planDrglitchExport):
   * metadata-only — exact UTF-8 sizes for the JSON entries and REAL record
   * byteLengths for every asset/thumbnail, no blob/body reads — with
   * missing/corrupt rows failing the plan typed (a broken project
   * surfaces pre-picker, never mid-write). The estimate includes ZIP
   * overhead and stored-size ceilings.
   */
  async planProjectExport(
    projectId: Id,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ filename: string; estimatedBytes: number; bufferedPeakBytes: number }> {
    return this.runTrackedArchiveOperation(options.signal, async (signal) => {
      const envelope = await this.exportEnvelopeFor(projectId, signal);
      const plan = await planDrglitchExport({
        envelope,
        appVersion: APP_VERSION,
        getRecord: this.drglitchPlanRecords(),
        signal,
      });
      return {
        filename: AppSessionController.drglitchFilename(envelope.title),
        estimatedBytes: plan.estimatedBytes,
        bufferedPeakBytes: plan.bufferedPeakBytes,
      };
    });
  }

  /**
   * TRUE STREAMING .drglitch export (wave G2): entries drain entry-wise
   * into the caller's sink (an FSA writable) — peak retention is one
   * validated entry plus ZIP staging, never the whole archive. On ANY
   * failure the streamed archive is aborted and this rejects; the CALLER
   * owns the writable and must abort it (transactional discard) — success
   * is the only path on which the caller may close/commit.
   */
  async exportProjectArchiveToSink(
    projectId: Id,
    sink: DrglitchByteSink,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ filename: string; bytesWritten: number }> {
    let sinkAbortPromise: Promise<void> | null = null;
    const abortSinkOnce = (reason?: unknown): Promise<void> => {
      if (!sink.abort) return Promise.resolve();
      if (!sinkAbortPromise) {
        const attempted = Promise.resolve()
          .then(() => sink.abort!(reason))
          .then(() => undefined)
          .catch(() => undefined);
        sinkAbortPromise = Promise.race([
          attempted,
          new Promise<void>((resolve) => setTimeout(resolve, 200)),
        ]);
      }
      return sinkAbortPromise;
    };
    const ownedSink: DrglitchByteSink = {
      write: (chunk, signal) => sink.write(chunk, signal),
      abort: abortSinkOnce,
    };
    return this.runTrackedArchiveOperation(options.signal, async (signal) => {
      const onAbort = () => void abortSinkOnce(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        const envelope = await this.exportEnvelopeFor(projectId, signal);
      // Freeze the plan, then execute against it (TOCTOU revalidation per
      // entry inside exportDrglitchToSink).
        const plan = await planDrglitchExport({
          envelope,
          appVersion: APP_VERSION,
          getRecord: this.drglitchPlanRecords(),
          signal,
        });
        const { bytesWritten } = await exportDrglitchToSink({
          envelope,
          appVersion: APP_VERSION,
          sink: ownedSink,
          plan,
          signal,
          ...this.drglitchSources(),
        });
        return { filename: AppSessionController.drglitchFilename(envelope.title), bytesWritten };
      } catch (error) {
        await abortSinkOnce(error);
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
  }

  /** Active imports and archive exports, all aborted/drained on dispose. */
  private readonly activeArchiveOperations = new Set<{
    abort: () => void;
    settled: Promise<unknown>;
  }>();

  /** Register before work starts, combine cancellation, and remove all listeners on settlement. */
  private runTrackedArchiveOperation<T>(
    externalSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertNotDisposed();
    const drain = new AbortController();
    const combined = new AbortController();
    const removers: Array<() => void> = [];
    for (const upstream of [drain.signal, ...(externalSignal ? [externalSignal] : [])]) {
      const forward = () => combined.abort(upstream.reason);
      if (upstream.aborted) forward();
      else {
        upstream.addEventListener("abort", forward, { once: true });
        removers.push(() => upstream.removeEventListener("abort", forward));
      }
    }
    // Deferring work by one microtask lets the active set own it before its
    // first provider call can synchronously throw or begin an await.
    const run = Promise.resolve().then(() => work(combined.signal));
    const tracked = run.finally(() => {
      for (const remove of removers) remove();
      this.activeArchiveOperations.delete(entry);
    });
    const entry: { abort: () => void; settled: Promise<unknown> } = {
      abort: () => drain.abort(new DOMException("Session disposed", "AbortError")),
      settled: tracked.catch(() => undefined),
    };
    this.activeArchiveOperations.add(entry);
    return tracked;
  }

  /* ----- home library binding ----- */

  private buildLibrary(): ProjectLibraryApi {
    const summaryOf = (summary: {
      id: Id;
      title: string;
      createdAt: number;
      updatedAt: number;
    }): ProjectSummary => ({
      id: summary.id,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      thumbnailUrl: null,
      unsaved: false,
    });
    return {
      listProjects: async () => {
        const all = await this.projects.list();
        // savedRevision 0 = installed-but-never-saved (imports): the library
        // shows only explicitly saved projects, like unsaved in-memory ones.
        return all.filter((project) => project.savedRevision > 0).map(summaryOf);
      },
      listTrash: async (): Promise<TrashSummary[]> => {
        const swept = await this.projects.sweepExpiredTrash();
        // Expired trash just lost its envelopes: their blobs are orphans now.
        if (swept > 0) void this.scheduleAssetGc("trash-expired");
        const records = await this.projects.listTrash();
        return records.map((record) => ({
          projectId: record.projectId,
          title: record.title,
          deletedAt: record.deletedAt,
          expiresAt: record.expiresAt,
        }));
      },
      createProject: () => this.createProject(),
      openProjectFile: async (file: File) => {
        // One intake path: the cancellable session import (pre-size gate,
        // one operation budget, exactly-once cleanup). The home surface
        // currently awaits it without a cancel affordance; wave F can swap
        // to importProjectFileCancellable() directly for the UI handle.
        return this.importProjectFileCancellable(file).promise;
      },
      openSample: () => this.openSampleAsUnsaved(),
      renameProject: async (id, title) => {
        await this.projects.rename(id, title);
      },
      duplicateProject: async (id) => (await this.projects.duplicate(id)).id,
      exportProject: async (id, options) => {
        const { filename, bytes } = await this.exportProjectArchive(id, options ?? {});
        // The frozen plan accounts for the returned archive and a possible
        // Blob snapshot copy; Blob construction is not assumed copy-free.
        return {
          filename,
          blob: new Blob([bytes as unknown as BlobPart], { type: "application/zip" }),
        };
      },
      planProjectExport: (id, options) => this.planProjectExport(id, options),
      exportProjectToSink: (id, sink, options) =>
        this.exportProjectArchiveToSink(id, sink, options),
      trashProject: async (id) => {
        if (this.open?.projectId === id) await this.closeProject();
        await this.projects.moveToTrash(id);
        if (this.lastOpenProjectId === id) this.clearLastOpenProject();
      },
      restoreProject: async (projectId) => {
        await this.projects.restore(projectId);
      },
      deletePermanently: async (projectId) => {
        await this.projects.deletePermanently(projectId);
        if (this.lastOpenProjectId === projectId) this.clearLastOpenProject();
        void this.scheduleAssetGc("delete-permanently");
      },
      emptyTrash: async () => {
        await this.projects.emptyTrash();
        void this.scheduleAssetGc("empty-trash");
      },
    };
  }
}
