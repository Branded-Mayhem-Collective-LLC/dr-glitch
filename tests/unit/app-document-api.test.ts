/**
 * DocumentApi: gesture transaction bracketing (scrub = one transaction,
 * Escape cancels), the read-only guard, and the history label mirror the
 * History panel renders from.
 */
import { describe, expect, it } from "vitest";
import { DocumentApi, RECOVERED_WORK_LABEL } from "../../src/app/document-api";
import {
  createEmptyProject,
  createLayerFromAsset,
  ProjectStore,
} from "../../src/project";

function setup(readOnly = false) {
  const envelope = createEmptyProject({ title: "T", now: 1000 });
  const layer = createLayerFromAsset("a".repeat(64), "art.png", { width: 10, height: 10 }, envelope.core.artboard);
  envelope.core = { ...envelope.core, layers: [layer] };
  const store = new ProjectStore(envelope, { now: () => 2000 });
  let blocked = 0;
  const doc = new DocumentApi(store, { readOnly, onBlocked: () => (blocked += 1) });
  return { store, doc, layer, blockedCount: () => blocked };
}

const angle = (value: number) =>
  ({ type: "separation/set-angle", plate: "cyan", angle: value }) as const;

describe("DocumentApi gestures", () => {
  it("coalesces every command in a gesture into ONE undo transaction", () => {
    const { store, doc } = setup();
    doc.beginGesture();
    for (const value of [20, 25, 30, 35]) doc.apply(angle(value), "Screen angle");
    doc.endGesture();

    expect(store.getEnvelope().core.separation.angles.cyan).toBe(35);
    expect(doc.undoDepth).toBe(1);
    expect(doc.getUndoLabels()).toEqual(["Screen angle"]);
    doc.undo();
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(15);
    expect(store.canUndo).toBe(false);
  });

  it("cancelGesture (Escape) restores the base state and records nothing", () => {
    const { store, doc } = setup();
    doc.beginGesture();
    doc.apply(angle(60));
    expect(doc.cancelGesture()).toBe(true);
    doc.endGesture();
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(15);
    expect(doc.undoDepth).toBe(0);
    expect(store.canUndo).toBe(false);
  });

  it("an empty gesture opens no transaction and records nothing", () => {
    const { store, doc } = setup();
    doc.beginGesture();
    doc.endGesture();
    expect(doc.undoDepth).toBe(0);
    expect(store.getState().revision).toBe(store.getEnvelope().savedRevision);
  });
});

describe("DocumentApi history mirror", () => {
  it("keeps labels in lockstep across commit, undo, and redo", () => {
    const { doc } = setup();
    doc.apply(angle(20), "First");
    doc.apply(angle(30), "Second");
    expect(doc.getUndoLabels()).toEqual(["First", "Second"]);

    doc.undo();
    expect(doc.getUndoLabels()).toEqual(["First"]);
    expect(doc.redoDepth).toBe(1);

    doc.redo();
    expect(doc.getUndoLabels()).toEqual(["First", "Second"]);
    expect(doc.redoDepth).toBe(0);
  });

  it("a no-change command records no transaction and no label", () => {
    const { doc } = setup();
    doc.apply(angle(15), "No-op"); // 15 is already the value
    expect(doc.undoDepth).toBe(0);
  });

  it("restoreSnapshot is one labeled undoable action", () => {
    const { store, doc } = setup();
    const snapshot = store.addSnapshot("Checkpoint");
    expect(snapshot).not.toBeNull();
    doc.apply(angle(70), "Angle");
    expect(doc.restoreSnapshot(snapshot!.id)).toBe(true);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(15);
    expect(doc.getUndoLabels()).toEqual(["Angle", "Restore snapshot"]);
    doc.undo();
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(70);
  });
});

describe("DocumentApi recovered-history truth", () => {
  /** Store shaped exactly like session-controller's buildRecoveredStore. */
  function recoveredStore() {
    const envelope = createEmptyProject({ title: "T", now: 1000 });
    const store = new ProjectStore(envelope, { now: () => 2000 });
    store.beginTransaction(RECOVERED_WORK_LABEL);
    store.updateTransaction({ type: "separation/set-angle", plate: "cyan", angle: 33 });
    store.commitTransaction();
    return store;
  }

  it("synchronizes the label mirror with pre-existing store history (depth 1, Recovered work)", () => {
    const store = recoveredStore();
    const doc = new DocumentApi(store, { readOnly: false });
    // The store can undo AND the mirror agrees — the History panel is truthful.
    expect(store.canUndo).toBe(true);
    expect(doc.undoDepth).toBe(1);
    expect(doc.getUndoLabels()).toEqual([RECOVERED_WORK_LABEL]);
  });

  it("keeps mirror and store in sync across undo/redo of the recovered work", () => {
    const store = recoveredStore();
    const doc = new DocumentApi(store);
    expect(doc.undo()).toBe(true);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(15);
    expect(store.canUndo).toBe(false);
    expect(doc.undoDepth).toBe(0);
    expect(doc.redoDepth).toBe(1);

    expect(doc.redo()).toBe(true);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(33);
    expect(doc.undoDepth).toBe(1);
    expect(doc.getUndoLabels()).toEqual([RECOVERED_WORK_LABEL]);
  });

  it("explicit initialUndoLabels override the heuristic seed", () => {
    const store = recoveredStore();
    const doc = new DocumentApi(store, { initialUndoLabels: ["Imported work"] });
    expect(doc.getUndoLabels()).toEqual(["Imported work"]);
  });

  it("a fresh store still starts with an empty mirror", () => {
    const envelope = createEmptyProject({ title: "T", now: 1000 });
    const store = new ProjectStore(envelope, { now: () => 2000 });
    const doc = new DocumentApi(store);
    expect(doc.undoDepth).toBe(0);
    expect(store.canUndo).toBe(false);
  });
});

describe("DocumentApi snapshot atomicity (frozen core)", () => {
  it("addSnapshot with a frozen core stores THAT core, not the current one", async () => {
    const { store, doc } = setup();
    // Click time: freeze synchronously.
    const frozenCore = store.getEnvelope().core;
    const frozenAngle = frozenCore.separation.angles.cyan;
    // Deferred thumbnail persist: an edit lands mid-await (N -> N+1).
    await Promise.resolve();
    doc.apply(angle(77), "Mid-await edit");
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(77);

    const snapshot = doc.addSnapshot("Atomic", null, frozenCore);
    expect(snapshot).not.toBeNull();
    // The stored checkpoint represents N (the frozen click-time state).
    expect(snapshot!.core.separation.angles.cyan).toBe(frozenAngle);
    const stored = store.getEnvelope().snapshots.find((s) => s.id === snapshot!.id)!;
    expect(stored.core.separation.angles.cyan).toBe(frozenAngle);

    // Restore returns to N exactly; the mid-await edit remains undoable.
    expect(doc.restoreSnapshot(snapshot!.id)).toBe(true);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(frozenAngle);
  });

  it("without a frozen core, addSnapshot still snapshots the current state", () => {
    const { store, doc } = setup();
    doc.apply(angle(50), "Edit");
    const snapshot = doc.addSnapshot("Current");
    expect(snapshot!.core.separation.angles.cyan).toBe(50);
    expect(store.getEnvelope().snapshots).toHaveLength(1);
  });

  it("the frozen core is deep-copied: later edits never leak into the snapshot", () => {
    const { store, doc } = setup();
    const frozenCore = store.getEnvelope().core;
    const snapshot = doc.addSnapshot("Frozen", null, frozenCore);
    doc.apply(angle(80), "Later edit");
    expect(snapshot!.core.separation.angles.cyan).toBe(15);
    expect(store.getEnvelope().snapshots[0].core.separation.angles.cyan).toBe(15);
  });
});

describe("DocumentApi read-only guard", () => {
  it("refuses every mutation and reports through onBlocked", () => {
    const { store, doc, blockedCount } = setup(true);
    expect(doc.apply(angle(50))).toBe(false);
    expect(doc.undo()).toBe(false);
    expect(doc.addSnapshot("nope")).toBeNull();
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(15);
    expect(blockedCount()).toBe(3);
  });
});
