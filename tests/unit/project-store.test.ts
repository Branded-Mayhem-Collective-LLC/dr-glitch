import { describe, expect, it } from "vitest";
import type { LayerV1 } from "../../src/core/types";
import {
  createEmptyProject,
  createLayerFromAsset,
} from "../../src/project/factory";
import { ProjectStore } from "../../src/project/store";

function makeStore() {
  const envelope = createEmptyProject({ title: "Test", now: 1000 });
  let clock = 2000;
  const store = new ProjectStore(envelope, { now: () => (clock += 1) });
  return { store, envelope };
}

function makeLayer(store: ProjectStore, name = "Layer"): LayerV1 {
  return createLayerFromAsset(
    "b".repeat(64),
    name,
    { width: 100, height: 100 },
    store.getEnvelope().core.artboard,
  );
}

describe("ProjectStore dispatch and dirty tracking", () => {
  it("starts clean at the envelope's saved revision", () => {
    const { store } = makeStore();
    const state = store.getState();
    expect(state.revision).toBe(0);
    expect(state.dirty).toBe(false);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.transactionOpen).toBe(false);
  });

  it("dispatch commits one transaction, bumps revision, marks dirty", () => {
    const { store } = makeStore();
    store.dispatch({ type: "unit/set", unitPreference: "in" });
    const state = store.getState();
    expect(state.envelope.core.unitPreference).toBe("in");
    expect(state.revision).toBe(1);
    expect(state.dirty).toBe(true);
    expect(state.canUndo).toBe(true);
  });

  it("a rejected command records no history and stays clean", () => {
    const { store } = makeStore();
    store.dispatch({ type: "layer/remove", layerId: "missing" });
    expect(store.getState().revision).toBe(0);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().canUndo).toBe(false);
  });

  it("markSaved clears the dirty flag at the saved revision", () => {
    const { store } = makeStore();
    store.dispatch({ type: "unit/set", unitPreference: "mm" });
    store.dispatch({ type: "guides/add", axis: "vertical", offset: 12 });
    const { revision } = store.getState();
    store.markSaved(revision);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().envelope.savedRevision).toBe(revision);
    store.dispatch({ type: "guides/add", axis: "vertical", offset: 24 });
    expect(store.getState().dirty).toBe(true);
  });

  it("undo after save marks the document dirty again", () => {
    const { store } = makeStore();
    store.dispatch({ type: "unit/set", unitPreference: "mm" });
    store.markSaved(store.getState().revision);
    expect(store.getState().dirty).toBe(false);
    expect(store.undo()).toBe(true);
    expect(store.getState().dirty).toBe(true);
  });

  it("notifies subscribers with a fresh state object", () => {
    const { store } = makeStore();
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState().revision));
    const before = store.getState();
    store.dispatch({ type: "unit/set", unitPreference: "in" });
    expect(store.getState()).not.toBe(before);
    // Notified through begin/update/commit; the final state carries revision 1.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    const count = seen.length;
    unsubscribe();
    store.dispatch({ type: "unit/set", unitPreference: "px" });
    expect(seen.length).toBe(count);
  });
});

describe("ProjectStore transactions", () => {
  it("one gesture is one undo step and renders live during the drag", () => {
    const { store } = makeStore();
    const layer = makeLayer(store);
    store.dispatch({ type: "layer/add", layer });

    store.beginTransaction("move");
    expect(store.getState().transactionOpen).toBe(true);
    for (let i = 1; i <= 10; i += 1) {
      store.updateTransaction({
        type: "layer/set-transform",
        layerId: layer.id,
        patch: { position: { x: i * 10, y: 0 } },
      });
      expect(store.getState().envelope.core.layers[0].transform.position.x).toBe(i * 10);
    }
    // Live updates do not bump the committed revision.
    expect(store.getState().revision).toBe(1);
    store.commitTransaction();
    expect(store.getState().revision).toBe(2);

    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core.layers[0].transform.position).toEqual(
      layer.transform.position,
    );
  });

  it("Escape cancels the whole gesture", () => {
    const { store } = makeStore();
    const layer = makeLayer(store);
    store.dispatch({ type: "layer/add", layer });
    const preCore = store.getState().envelope.core;

    store.beginTransaction("scrub");
    store.updateTransaction({
      type: "recipe/update-halftone",
      layerId: layer.id,
      patch: { cellSize: 99 },
    });
    expect(store.getState().envelope.core.layers[0].recipe.halftone.cellSize).toBe(99);
    store.cancelTransaction();

    expect(store.getState().envelope.core).toBe(preCore);
    expect(store.getState().revision).toBe(1);
    expect(store.getState().canRedo).toBe(false);
    // Nothing new entered history: undo removes only the layer add.
    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core.layers).toHaveLength(0);
    expect(store.undo()).toBe(false);
  });

  it("dispatch during an open transaction coalesces into it", () => {
    const { store } = makeStore();
    store.beginTransaction();
    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 1 });
    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 2 });
    store.commitTransaction();
    expect(store.getState().envelope.core.guides.horizontal).toEqual([1, 2]);
    expect(store.getState().revision).toBe(1);
    store.undo();
    expect(store.getState().envelope.core.guides.horizontal).toEqual([]);
  });

  it("commit and cancel are safe no-ops without an open transaction", () => {
    const { store } = makeStore();
    store.commitTransaction();
    store.cancelTransaction();
    expect(store.getState().revision).toBe(0);
    expect(() => store.updateTransaction({ type: "guides/clear" })).toThrow();
  });
});

describe("ProjectStore undo coverage", () => {
  it("guides, registration, artboard, and separation edits are all undoable", () => {
    const { store } = makeStore();
    const original = store.getState().envelope.core;

    store.dispatch({ type: "guides/add", axis: "horizontal", offset: 240 });
    store.dispatch({ type: "registration/update", patch: { weight: 5 } });
    store.dispatch({ type: "artboard/resize", widthPx: 1920, heightPx: 2400, presetId: "8x10" });
    store.dispatch({ type: "separation/set-angle", plate: "black", angle: 60 });

    expect(store.getState().revision).toBe(4);
    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core.separation.angles.black).toBe(45);
    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core.artboard.widthPx).toBe(2640);
    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core.registration.weight).toBe(2);
    expect(store.undo()).toBe(true);
    expect(store.getState().envelope.core).toBe(original);
    expect(store.getState().canUndo).toBe(false);

    expect(store.redo()).toBe(true);
    expect(store.getState().envelope.core.guides.horizontal).toEqual([240]);
    // Revision keeps rising monotonically through undo/redo.
    expect(store.getState().revision).toBe(9);
  });

  it("undo is unavailable while a transaction is open", () => {
    const { store } = makeStore();
    store.dispatch({ type: "unit/set", unitPreference: "in" });
    store.beginTransaction();
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    store.cancelTransaction();
    expect(store.undo()).toBe(true);
  });
});
