/**
 * Project library boundary for the start/home surface. HomeScreen renders
 * against this interface only; the lead binds it to the storage agent's
 * ProjectRepository/Trash implementation. A self-contained in-memory demo
 * binding for the dev route lives in demo-library.ts.
 */

import type { Id } from "../core/types";

export type ProjectSummary = {
  id: Id;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Object URL or data URI for the card thumbnail; null when none exists. */
  thumbnailUrl: string | null;
  /**
   * True for projects that exist only in memory (sample or imported files
   * opened unsaved) — they vanish unless explicitly saved.
   */
  unsaved: boolean;
};

export type TrashSummary = {
  projectId: Id;
  title: string;
  deletedAt: number;
  /** deletedAt + 30 days; permanent removal after this. */
  expiresAt: number;
};

/** Coarse .drglitch import progress (mirrors io's DrglitchImportProgress). */
export type ProjectImportProgress = {
  phase: "extract" | "validate" | "stage" | "commit";
  /** Assets + thumbnails staged so far / total (0/0 before the plan exists). */
  assetsDone: number;
  assetsTotal: number;
};

/**
 * Handle for a cancellable .drglitch import. cancel() aborts the WHOLE
 * operation at its next checkpoint (typed "archive-aborted" rejection,
 * exactly-once cleanup, zero installed rows); onProgress subscribes to the
 * coarse phase/asset counters and returns the unsubscribe function.
 */
export type ProjectImportHandle = {
  promise: Promise<Id>;
  cancel(): void;
  onProgress(listener: (progress: ProjectImportProgress) => void): () => void;
};

/**
 * Everything the home surface can do. All methods reject with typed storage
 * errors (src/storage/errors.ts) on failure; none silently overwrite.
 */
export type ProjectLibraryApi = {
  listProjects(): Promise<ProjectSummary[]>;
  listTrash(): Promise<TrashSummary[]>;
  /** Creates a new empty project and returns its id. */
  createProject(): Promise<Id>;
  /** Validates and stages a portable .drglitch file; opens unsaved. */
  openProjectFile(file: File): Promise<Id>;
  /**
   * Cancellable variant with progress (the app binding wires this to
   * AppSessionController.importProjectFileCancellable). Optional so demo /
   * test bindings without a cancellation seam keep working; the home
   * surface falls back to openProjectFile when absent.
   */
  importProjectFileCancellable?(file: File): ProjectImportHandle;
  /** Opens the bundled sample as a new unsaved project. */
  openSample(): Promise<Id>;
  renameProject(id: Id, title: string): Promise<void>;
  duplicateProject(id: Id): Promise<Id>;
  /** Portable .drglitch export of the project's current saved state.
   *  `signal` (optional) genuinely cancels the buffered build. */
  exportProject(id: Id, options?: { signal?: AbortSignal }): Promise<{ filename: string; blob: Blob }>;
  /**
   * Delivery plan for a portable export: filename + a conservative
   * record-backed size estimate, computed WITHOUT reading blobs, so the
   * home surface decides buffered-vs-streamed delivery before spending the
   * user's gesture. Optional: demo/test bindings without it always take
   * the buffered path.
   */
  planProjectExport?(
    id: Id,
    options?: { signal?: AbortSignal },
  ): Promise<{ filename: string; estimatedBytes: number; bufferedPeakBytes?: number }>;
  /**
   * TRUE STREAMING export (wave G2) into a caller-owned byte sink (an FSA
   * writable): entries drain entry-wise, nothing whole-archive is ever
   * resident. On rejection the caller must abort its writable (the
   * transactional temp write discards; a pre-existing picked file
   * survives). Optional alongside planProjectExport.
   */
  exportProjectToSink?(
    id: Id,
    sink: {
      write(chunk: Uint8Array, signal?: AbortSignal): void | Promise<void>;
      abort?(reason?: unknown): void | Promise<void>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ filename: string; bytesWritten: number }>;
  trashProject(id: Id): Promise<void>;
  restoreProject(projectId: Id): Promise<void>;
  deletePermanently(projectId: Id): Promise<void>;
  emptyTrash(): Promise<void>;
};
