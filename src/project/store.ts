/**
 * React binding for the project document. The ProjectStore class is
 * framework-free (subscribe/getState); useProjectStore is the only React
 * touchpoint in src/project.
 *
 * Revision model: `revision` is a monotonic session counter starting at the
 * envelope's savedRevision. It increments on every committed core change —
 * committed transactions, undo, redo, snapshot create/remove — so
 * `dirty === revision > savedRevision`. markSaved(revision) records the
 * revision an explicit Save persisted.
 */
import { useSyncExternalStore } from "react";
import type { Id, ProjectCoreV1, ProjectEnvelopeV1, Sha256, SnapshotV1 } from "../core/types";
import type { Command } from "./commands";
import { ProjectHistory } from "./history";
import { applyCommand } from "./reducer";
import {
  createSnapshot,
  duplicateSnapshotAsProject,
  removeSnapshot,
  restoreSnapshotCommand,
} from "./snapshots";

export type ProjectStoreState = {
  envelope: ProjectEnvelopeV1;
  revision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  transactionOpen: boolean;
};

export type ProjectStoreOptions = {
  now?: () => number;
};

export class ProjectStore {
  private envelope: ProjectEnvelopeV1;
  private readonly history = new ProjectHistory();
  private readonly now: () => number;
  private revision: number;
  private state: ProjectStoreState;
  private readonly listeners = new Set<() => void>();

  constructor(envelope: ProjectEnvelopeV1, options: ProjectStoreOptions = {}) {
    this.envelope = envelope;
    this.now = options.now ?? Date.now;
    this.revision = envelope.savedRevision;
    this.state = this.buildState();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): ProjectStoreState => this.state;

  getEnvelope(): ProjectEnvelopeV1 {
    return this.envelope;
  }

  get isTransactionOpen(): boolean {
    return this.history.isTransactionOpen;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /**
   * Applies one command. Outside a transaction it is its own one-command
   * transaction; inside an open transaction it coalesces into it.
   */
  dispatch(command: Command): void {
    if (this.history.isTransactionOpen) {
      this.updateTransaction(command);
      return;
    }
    this.beginTransaction();
    this.updateTransaction(command);
    this.commitTransaction();
  }

  /** Starts a gesture-scoped transaction (drag, scrub, crop, transform). */
  beginTransaction(label?: string): void {
    this.history.begin(this.envelope.core, label);
    this.refresh();
  }

  /** Applies a command to the pending state; repeated updates coalesce. */
  updateTransaction(command: Command): void {
    if (!this.history.isTransactionOpen) {
      throw new Error("No open transaction; call beginTransaction first");
    }
    const next = applyCommand(this.envelope.core, command);
    this.history.update(next);
    if (next !== this.envelope.core) {
      this.envelope = { ...this.envelope, core: next };
    }
    this.refresh();
  }

  /** Commits the open transaction; a no-change commit records nothing. */
  commitTransaction(): void {
    if (!this.history.isTransactionOpen) return;
    const committed = this.history.commit();
    if (committed !== null) {
      this.revision += 1;
      this.envelope = { ...this.envelope, core: committed, updatedAt: this.now() };
    }
    this.refresh();
  }

  /** Escape: restores the pre-transaction state and records nothing. */
  cancelTransaction(): void {
    if (!this.history.isTransactionOpen) return;
    const before = this.history.cancel();
    if (before !== this.envelope.core) {
      this.envelope = { ...this.envelope, core: before };
    }
    this.refresh();
  }

  undo(): boolean {
    const core = this.history.undo();
    if (core === null) return false;
    this.revision += 1;
    this.envelope = { ...this.envelope, core, updatedAt: this.now() };
    this.refresh();
    return true;
  }

  redo(): boolean {
    const core = this.history.redo();
    if (core === null) return false;
    this.revision += 1;
    this.envelope = { ...this.envelope, core, updatedAt: this.now() };
    this.refresh();
    return true;
  }

  /** Records the revision an explicit Save persisted; clears the dirty flag. */
  markSaved(revision: number): void {
    if (revision === this.envelope.savedRevision) return;
    this.envelope = { ...this.envelope, savedRevision: revision };
    this.refresh();
  }

  /**
   * Adds a named snapshot; returns null when the snapshot cap is reached.
   * `core` (optional) snapshots a FROZEN core captured before an async
   * thumbnail persist instead of the current one — see createSnapshot.
   */
  addSnapshot(
    name: string,
    thumbnailId: Sha256 | null = null,
    core?: ProjectCoreV1,
  ): SnapshotV1 | null {
    const result = createSnapshot(
      this.envelope,
      name,
      thumbnailId,
      this.now(),
      core ?? this.envelope.core,
    );
    if (result === null) return null;
    this.envelope = { ...result.envelope, updatedAt: this.now() };
    this.revision += 1;
    this.refresh();
    return result.snapshot;
  }

  deleteSnapshot(snapshotId: Id): boolean {
    const next = removeSnapshot(this.envelope, snapshotId);
    if (next === this.envelope) return false;
    this.envelope = { ...next, updatedAt: this.now() };
    this.revision += 1;
    this.refresh();
    return true;
  }

  /** Restores a snapshot's core as one undoable transaction. */
  restoreSnapshot(snapshotId: Id): boolean {
    if (this.history.isTransactionOpen) return false;
    const snapshot = this.envelope.snapshots.find((candidate) => candidate.id === snapshotId);
    if (!snapshot) return false;
    this.beginTransaction("Restore snapshot");
    this.updateTransaction(restoreSnapshotCommand(snapshot));
    this.commitTransaction();
    return true;
  }

  /** Fresh unsaved project from a snapshot; this store is not modified. */
  duplicateSnapshotToProject(snapshotId: Id): ProjectEnvelopeV1 | null {
    return duplicateSnapshotAsProject(this.envelope, snapshotId, this.now());
  }

  private buildState(): ProjectStoreState {
    return {
      envelope: this.envelope,
      revision: this.revision,
      dirty: this.revision > this.envelope.savedRevision,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      transactionOpen: this.history.isTransactionOpen,
    };
  }

  private refresh(): void {
    this.state = this.buildState();
    for (const listener of this.listeners) listener();
  }
}

/** React subscription to a ProjectStore via useSyncExternalStore. */
export function useProjectStore(store: ProjectStore): ProjectStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
