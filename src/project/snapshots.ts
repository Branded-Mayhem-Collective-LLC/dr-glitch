/**
 * Named snapshots: deep-copied nonrecursive document cores stored on the
 * project envelope. Restore is a single undoable command; Duplicate Snapshot
 * spawns a fresh unsaved project and leaves current work untouched.
 */
import { createId } from "../core/id";
import { RESOURCE_POLICY } from "../core/resource-policy";
import type {
  Id,
  ProjectCoreV1,
  ProjectEnvelopeV1,
  Sha256,
  SnapshotV1,
} from "../core/types";
import type { Command } from "./commands";

export function cloneCore(core: ProjectCoreV1): ProjectCoreV1 {
  return structuredClone(core);
}

export type CreateSnapshotResult = {
  envelope: ProjectEnvelopeV1;
  snapshot: SnapshotV1;
};

/**
 * Adds a named snapshot of the envelope's current core — or, when `core`
 * is given, of that FROZEN core (Create Snapshot captures core + canvas
 * synchronously at click time; the thumbnail persists asynchronously, and
 * the stored pair must both represent the click-time state). Returns null
 * when RESOURCE_POLICY.maxSnapshots is reached; the caller surfaces the
 * error.
 */
export function createSnapshot(
  envelope: ProjectEnvelopeV1,
  name: string,
  thumbnailId: Sha256 | null = null,
  now: number = Date.now(),
  core: ProjectCoreV1 = envelope.core,
): CreateSnapshotResult | null {
  if (envelope.snapshots.length >= RESOURCE_POLICY.maxSnapshots) return null;
  const snapshot: SnapshotV1 = {
    id: createId(),
    name,
    createdAt: now,
    thumbnailId,
    // Deep copy: later edits to the live core must never leak into it.
    core: cloneCore(core),
  };
  return {
    envelope: { ...envelope, snapshots: [...envelope.snapshots, snapshot] },
    snapshot,
  };
}

export function removeSnapshot(
  envelope: ProjectEnvelopeV1,
  snapshotId: Id,
): ProjectEnvelopeV1 {
  const snapshots = envelope.snapshots.filter((snapshot) => snapshot.id !== snapshotId);
  if (snapshots.length === envelope.snapshots.length) return envelope;
  return { ...envelope, snapshots };
}

/**
 * Builds the single undoable command that restores a snapshot's core.
 * The core is deep-copied so the stored snapshot stays immutable even if
 * later commands are applied on top of the restored state.
 */
export function restoreSnapshotCommand(snapshot: SnapshotV1): Command {
  return { type: "snapshot/restore", core: cloneCore(snapshot.core) };
}

/**
 * Duplicate Snapshot: a fresh unsaved project from the checkpoint. New id,
 * title "<snapshot name> copy", savedRevision 0, no snapshots. The source
 * envelope is not modified.
 */
export function duplicateSnapshotAsProject(
  envelope: ProjectEnvelopeV1,
  snapshotId: Id,
  now: number = Date.now(),
): ProjectEnvelopeV1 | null {
  const snapshot = envelope.snapshots.find((candidate) => candidate.id === snapshotId);
  if (!snapshot) return null;
  return {
    schema: 1,
    id: createId(),
    title: `${snapshot.name} copy`,
    createdAt: now,
    updatedAt: now,
    savedRevision: 0,
    core: cloneCore(snapshot.core),
    snapshots: [],
  };
}
