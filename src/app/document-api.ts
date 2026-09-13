/**
 * DocumentApi — the app-layer editing surface over one ProjectStore.
 *
 * Responsibilities on top of the raw store:
 * - Gesture bracketing: pointer scrubs/drags call beginGesture / endGesture /
 *   cancelGesture; every command applied while a gesture is open coalesces
 *   into ONE store transaction (Escape cancels it). The transaction is opened
 *   lazily on the first command so empty gestures record nothing.
 * - Read-only guard: on a read-only session every mutation is refused and
 *   reported through onBlocked instead of silently ignored.
 * - History label mirror: ProjectStore keeps its history private, so this
 *   class tracks committed-transaction labels in lockstep (commit push,
 *   undo/redo shuffle) for the History panel's list display. The mirror uses
 *   the same cap as the store's history ring.
 */
import { RESOURCE_POLICY } from "../core/resource-policy";
import type { Id, ProjectCoreV1, Sha256, SnapshotV1 } from "../core/types";
import type { Command } from "../project";
import { ProjectStore } from "../project";

/**
 * Structural value equality with reference short-circuit. The reducer keeps
 * untouched branches referentially identical, so comparing a core against
 * its pre-transaction base only walks the (small) rebuilt path; identical
 * values behind fresh references — e.g. a numeric field's blur re-committing
 * the value Enter already applied — are detected as no-ops.
 */
function structuralEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!structuralEquals(a[i], b[i])) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!structuralEquals(left[key], right[key])) return false;
  }
  return true;
}

/**
 * The label of the single committed transaction a recovery-adopted store
 * carries (session-controller's buildRecoveredStore). Single source of
 * truth: the store commit, the label-mirror seed, and the History panel all
 * read this constant.
 */
export const RECOVERED_WORK_LABEL = "Recovered work";

export type DocumentApiOptions = {
  readOnly?: boolean;
  /** Called when a mutation is refused because the session is read-only. */
  onBlocked?: () => void;
  /**
   * Labels (oldest first) for committed transactions that ALREADY exist in
   * the store's history when this DocumentApi is constructed. When omitted,
   * the mirror synchronizes itself against the authoritative store history:
   * a store that can already undo at construction time is, on every
   * production path, a freshly recovery-adopted store carrying exactly ONE
   * committed transaction — labeled RECOVERED_WORK_LABEL. Without this
   * seed the History panel lied after recovery (canUndo true, depth 0,
   * "Nothing to undo").
   */
  initialUndoLabels?: readonly (string | null)[];
};

export class DocumentApi {
  private blocked: () => void;
  private gestureOpen = false;
  private gestureLabel: string | null = null;
  private gestureBaseRevision = 0;
  private gestureBaseCore: ProjectCoreV1 | null = null;
  private undoLabels: (string | null)[] = [];
  private redoLabels: (string | null)[] = [];
  readOnly: boolean;

  constructor(
    readonly store: ProjectStore,
    options: DocumentApiOptions = {},
  ) {
    this.readOnly = options.readOnly ?? false;
    this.blocked = options.onBlocked ?? (() => undefined);
    // Synchronize the label mirror with pre-existing store history (see
    // DocumentApiOptions.initialUndoLabels). Depth and labels must agree
    // with the store from the first render, or recovered sessions report
    // canUndo without anything for the History panel to show.
    if (options.initialUndoLabels !== undefined) {
      this.undoLabels = [...options.initialUndoLabels];
    } else if (store.canUndo) {
      this.undoLabels = [RECOVERED_WORK_LABEL];
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  get undoDepth(): number {
    return this.undoLabels.length;
  }

  get redoDepth(): number {
    return this.redoLabels.length;
  }

  /** Most recent last; parallel to the store's private undo stack. */
  getUndoLabels(): readonly (string | null)[] {
    return this.undoLabels;
  }

  private guard(): boolean {
    if (!this.readOnly) return true;
    this.blocked();
    return false;
  }

  private recordCommit(label: string | null, baseRevision: number): void {
    if (this.store.getState().revision > baseRevision) {
      this.undoLabels.push(label);
      if (this.undoLabels.length > RESOURCE_POLICY.maxUndoTransactions) {
        this.undoLabels.shift();
      }
      this.redoLabels = [];
    }
  }

  /* ----- gestures ----- */

  beginGesture(): void {
    if (this.readOnly) return;
    this.gestureOpen = true;
  }

  endGesture(): void {
    const hadTransaction = this.store.isTransactionOpen;
    this.gestureOpen = false;
    if (!hadTransaction) return;
    const base = this.gestureBaseRevision;
    const baseCore = this.gestureBaseCore;
    const label = this.gestureLabel;
    this.gestureLabel = null;
    this.gestureBaseCore = null;
    // Value-level no-op: a gesture that ends exactly where it began (drag
    // out and back, scrub to the same value) must not enter the undo stack
    // even when the reducer rebuilt references along the way.
    if (baseCore && structuralEquals(baseCore, this.store.getEnvelope().core)) {
      this.store.cancelTransaction();
      return;
    }
    this.store.commitTransaction();
    this.recordCommit(label, base);
  }

  cancelGesture(): boolean {
    this.gestureOpen = false;
    this.gestureLabel = null;
    this.gestureBaseCore = null;
    if (!this.store.isTransactionOpen) return false;
    this.store.cancelTransaction();
    return true;
  }

  get isGestureOpen(): boolean {
    return this.gestureOpen;
  }

  /* ----- commands ----- */

  /**
   * Applies one or more commands as a single undoable transaction — or, when
   * a gesture is open, coalesces them into the gesture's transaction.
   */
  apply(commands: Command | Command[], label?: string): boolean {
    if (!this.guard()) return false;
    const list = Array.isArray(commands) ? commands : [commands];
    if (list.length === 0) return false;

    if (this.gestureOpen) {
      if (!this.store.isTransactionOpen) {
        this.gestureBaseRevision = this.store.getState().revision;
        this.gestureBaseCore = this.store.getEnvelope().core;
        this.gestureLabel = label ?? null;
        this.store.beginTransaction(label);
      }
      for (const command of list) this.store.updateTransaction(command);
      return true;
    }

    const base = this.store.getState().revision;
    const baseCore = this.store.getEnvelope().core;
    this.store.beginTransaction(label);
    for (const command of list) this.store.updateTransaction(command);
    // Value-level no-op suppression: re-applying the current values (e.g. a
    // numeric input's blur commit right after its Enter commit) produces a
    // structurally identical core behind fresh references. Recording it
    // would make the next Undo a visible no-op — cancel instead.
    if (structuralEquals(baseCore, this.store.getEnvelope().core)) {
      this.store.cancelTransaction();
      return true;
    }
    this.store.commitTransaction();
    this.recordCommit(label ?? null, base);
    return true;
  }

  /* ----- history ----- */

  undo(): boolean {
    if (!this.guard()) return false;
    if (!this.store.undo()) return false;
    const label = this.undoLabels.pop() ?? null;
    this.redoLabels.push(label);
    return true;
  }

  redo(): boolean {
    if (!this.guard()) return false;
    if (!this.store.redo()) return false;
    const label = this.redoLabels.pop() ?? null;
    this.undoLabels.push(label);
    return true;
  }

  /* ----- snapshots ----- */

  /**
   * Adds a named snapshot. `core` (optional) is the FROZEN core captured
   * synchronously at click time: passing it makes the stored checkpoint
   * represent exactly the state the paired thumbnail was rendered from,
   * even when an edit lands while the thumbnail blob is persisting.
   */
  addSnapshot(
    name: string,
    thumbnailId: Sha256 | null = null,
    core?: ProjectCoreV1,
  ): SnapshotV1 | null {
    if (!this.guard()) return null;
    return this.store.addSnapshot(name, thumbnailId, core);
  }

  deleteSnapshot(snapshotId: Id): boolean {
    if (!this.guard()) return false;
    return this.store.deleteSnapshot(snapshotId);
  }

  /** Restore is one undoable action; mirrored with a stable label. */
  restoreSnapshot(snapshotId: Id): boolean {
    if (!this.guard()) return false;
    const base = this.store.getState().revision;
    if (!this.store.restoreSnapshot(snapshotId)) return false;
    this.recordCommit("Restore snapshot", base);
    return true;
  }
}
