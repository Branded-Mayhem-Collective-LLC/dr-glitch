import { describe, expect, it } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { ProjectEnvelopeV1 } from "../../src/core/types";
import { createEmptyProject } from "../../src/project/factory";
import {
  createSnapshot,
  duplicateSnapshotAsProject,
  removeSnapshot,
} from "../../src/project/snapshots";
import { ProjectStore } from "../../src/project/store";

function makeEnvelope(): ProjectEnvelopeV1 {
  return createEmptyProject({ title: "Snap host", now: 1000 });
}

describe("snapshots: create", () => {
  it("deep-copies the core so later edits never leak into the snapshot", () => {
    const store = new ProjectStore(makeEnvelope());
    const snapshot = store.addSnapshot("Checkpoint", "f".repeat(64));
    expect(snapshot).not.toBeNull();
    expect(snapshot?.thumbnailId).toBe("f".repeat(64));

    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 77 });
    const stored = store.getEnvelope().snapshots[0];
    expect(stored.core.guides.horizontal).toEqual([]);
    expect(store.getEnvelope().core.guides.horizontal).toEqual([77]);
  });

  it("enforces RESOURCE_POLICY.maxSnapshots", () => {
    let envelope = makeEnvelope();
    for (let i = 0; i < RESOURCE_POLICY.maxSnapshots; i += 1) {
      const result = createSnapshot(envelope, `Snap ${i}`, null, 1000 + i);
      expect(result).not.toBeNull();
      envelope = result!.envelope;
    }
    expect(envelope.snapshots).toHaveLength(RESOURCE_POLICY.maxSnapshots);
    expect(createSnapshot(envelope, "one too many")).toBeNull();

    const store = new ProjectStore(envelope);
    expect(store.addSnapshot("still too many")).toBeNull();
    expect(store.getState().revision).toBe(envelope.savedRevision);
  });

  it("removeSnapshot drops one snapshot and ignores unknown ids", () => {
    const base = makeEnvelope();
    const withSnap = createSnapshot(base, "A")!;
    const removed = removeSnapshot(withSnap.envelope, withSnap.snapshot.id);
    expect(removed.snapshots).toHaveLength(0);
    expect(removeSnapshot(withSnap.envelope, "missing")).toBe(withSnap.envelope);
  });
});

describe("snapshots: restore", () => {
  it("restores as one undoable transaction", () => {
    const store = new ProjectStore(makeEnvelope());
    store.dispatch({ type: "guides/add", axis: "vertical", offset: 10 });
    const snapshot = store.addSnapshot("Before mayhem")!;

    store.dispatch({ type: "guides/add", axis: "vertical", offset: 20 });
    store.dispatch({ type: "unit/set", unitPreference: "mm" });
    const dirtyCore = store.getState().envelope.core;

    expect(store.restoreSnapshot(snapshot.id)).toBe(true);
    const restored = store.getState().envelope.core;
    expect(restored.guides.vertical).toEqual([10]);
    expect(restored.unitPreference).toBe("px");

    // One undo returns the whole pre-restore state.
    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core).toBe(dirtyCore);
    // Redo re-applies the restore.
    expect(store.redo()).toBe(true);
    expect(store.getState().envelope.core.guides.vertical).toEqual([10]);
  });

  it("restore does not alias the stored snapshot core", () => {
    const store = new ProjectStore(makeEnvelope());
    const snapshot = store.addSnapshot("Base")!;
    store.restoreSnapshot(snapshot.id);
    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 5 });
    expect(store.getEnvelope().snapshots[0].core.guides.horizontal).toEqual([]);
  });

  it("returns false for unknown snapshots or during an open transaction", () => {
    const store = new ProjectStore(makeEnvelope());
    expect(store.restoreSnapshot("missing")).toBe(false);
    const snapshot = store.addSnapshot("A")!;
    store.beginTransaction();
    expect(store.restoreSnapshot(snapshot.id)).toBe(false);
    store.cancelTransaction();
  });
});

describe("snapshots: duplicate to new project", () => {
  it("creates a fresh unsaved project and leaves current work untouched", () => {
    const store = new ProjectStore(makeEnvelope());
    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 33 });
    const snapshot = store.addSnapshot("Fork point")!;
    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 66 });

    const stateBefore = store.getState();
    const duplicate = store.duplicateSnapshotToProject(snapshot.id);
    expect(duplicate).not.toBeNull();

    // Current project is untouched.
    expect(store.getState()).toBe(stateBefore);
    expect(store.getState().envelope.core.guides.horizontal).toEqual([33, 66]);

    // Fresh identity, fresh save state, fork-point content.
    expect(duplicate!.id).not.toBe(store.getEnvelope().id);
    expect(duplicate!.title).toBe("Fork point copy");
    expect(duplicate!.savedRevision).toBe(0);
    expect(duplicate!.snapshots).toEqual([]);
    expect(duplicate!.core.guides.horizontal).toEqual([33]);
    expect(duplicate!.core).not.toBe(snapshot.core);
  });

  it("returns null for an unknown snapshot id", () => {
    const envelope = makeEnvelope();
    expect(duplicateSnapshotAsProject(envelope, "missing")).toBeNull();
  });
});
