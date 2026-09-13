/**
 * Session-only undo history built on transactions.
 *
 * One user gesture (drag, scrub, crop, transform, single click edit) is one
 * transaction: begin captures the base core, repeated updates coalesce by
 * replacing the pending core, commit records {before, after} when they
 * differ, and cancel (Escape) restores the base without recording anything.
 *
 * Entries store full cores; the reducer's structural sharing keeps that
 * memory-cheap. A ring of at most `limit` committed transactions evicts the
 * oldest entry first. Nothing here is persisted.
 */
import { RESOURCE_POLICY } from "../core/resource-policy";
import type { ProjectCoreV1 } from "../core/types";

export type HistoryTransaction = {
  label: string | null;
  before: ProjectCoreV1;
  after: ProjectCoreV1;
};

type OpenTransaction = {
  label: string | null;
  before: ProjectCoreV1;
  pending: ProjectCoreV1;
};

export class ProjectHistory {
  private readonly limit: number;
  private undoStack: HistoryTransaction[] = [];
  private redoStack: HistoryTransaction[] = [];
  private open: OpenTransaction | null = null;

  constructor(limit: number = RESOURCE_POLICY.maxUndoTransactions) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`History limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
  }

  get isTransactionOpen(): boolean {
    return this.open !== null;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  get canUndo(): boolean {
    return this.open === null && this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.open === null && this.redoStack.length > 0;
  }

  begin(core: ProjectCoreV1, label?: string): void {
    if (this.open !== null) {
      throw new Error("A history transaction is already open");
    }
    this.open = { label: label ?? null, before: core, pending: core };
  }

  /** Coalesces: the latest core replaces the transaction's pending state. */
  update(core: ProjectCoreV1): void {
    if (this.open === null) {
      throw new Error("No open history transaction to update");
    }
    this.open.pending = core;
  }

  /**
   * Commits the open transaction. Returns the committed core when a change
   * was recorded, or null for a no-op commit (nothing entered history).
   */
  commit(): ProjectCoreV1 | null {
    if (this.open === null) {
      throw new Error("No open history transaction to commit");
    }
    const { label, before, pending } = this.open;
    this.open = null;
    if (pending === before) return null;
    this.undoStack.push({ label, before, after: pending });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return pending;
  }

  /** Cancels the open transaction and returns the pre-transaction core. */
  cancel(): ProjectCoreV1 {
    if (this.open === null) {
      throw new Error("No open history transaction to cancel");
    }
    const { before } = this.open;
    this.open = null;
    return before;
  }

  /** Returns the core to restore, or null when undo is unavailable. */
  undo(): ProjectCoreV1 | null {
    if (!this.canUndo) return null;
    const entry = this.undoStack.pop() as HistoryTransaction;
    this.redoStack.push(entry);
    return entry.before;
  }

  /** Returns the core to restore, or null when redo is unavailable. */
  redo(): ProjectCoreV1 | null {
    if (!this.canRedo) return null;
    const entry = this.redoStack.pop() as HistoryTransaction;
    this.undoStack.push(entry);
    return entry.after;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
  }
}
