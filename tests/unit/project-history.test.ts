import { describe, expect, it } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { ProjectCoreV1 } from "../../src/core/types";
import { createEmptyProjectCore } from "../../src/project/factory";
import { ProjectHistory } from "../../src/project/history";
import { applyCommand } from "../../src/project/reducer";

function coreWithGuide(base: ProjectCoreV1, offset: number): ProjectCoreV1 {
  return applyCommand(base, { type: "guides/add", axis: "horizontal", offset });
}

describe("ProjectHistory transactions", () => {
  it("records one entry per committed transaction", () => {
    const history = new ProjectHistory();
    const base = createEmptyProjectCore();
    const next = coreWithGuide(base, 10);

    history.begin(base);
    history.update(next);
    expect(history.commit()).toBe(next);
    expect(history.undoDepth).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it("coalesces repeated updates into a single undo step", () => {
    const history = new ProjectHistory();
    const base = createEmptyProjectCore();
    let current = base;
    history.begin(base, "drag");
    for (let i = 1; i <= 25; i += 1) {
      current = coreWithGuide(base, i); // absolute update, replaces pending
      history.update(current);
    }
    history.commit();
    expect(history.undoDepth).toBe(1);
    expect(history.undo()).toBe(base);
    expect(history.redo()).toBe(current);
  });

  it("cancel restores the pre-transaction core and records nothing", () => {
    const history = new ProjectHistory();
    const base = createEmptyProjectCore();
    history.begin(base);
    history.update(coreWithGuide(base, 5));
    history.update(coreWithGuide(base, 9));
    expect(history.cancel()).toBe(base);
    expect(history.undoDepth).toBe(0);
    expect(history.isTransactionOpen).toBe(false);
  });

  it("a no-change commit records nothing", () => {
    const history = new ProjectHistory();
    const base = createEmptyProjectCore();
    history.begin(base);
    expect(history.commit()).toBeNull();
    expect(history.undoDepth).toBe(0);
  });

  it("a new commit clears the redo stack", () => {
    const history = new ProjectHistory();
    const base = createEmptyProjectCore();
    const a = coreWithGuide(base, 1);
    const b = coreWithGuide(base, 2);

    history.begin(base);
    history.update(a);
    history.commit();
    expect(history.undo()).toBe(base);
    expect(history.canRedo).toBe(true);

    history.begin(base);
    history.update(b);
    history.commit();
    expect(history.canRedo).toBe(false);
    expect(history.redoDepth).toBe(0);
  });

  it("undo/redo walk the recorded chain", () => {
    const history = new ProjectHistory();
    const cores = [createEmptyProjectCore()];
    for (let i = 1; i <= 3; i += 1) {
      const next = coreWithGuide(cores[i - 1], i * 100);
      history.begin(cores[i - 1]);
      history.update(next);
      history.commit();
      cores.push(next);
    }
    expect(history.undo()).toBe(cores[2]);
    expect(history.undo()).toBe(cores[1]);
    expect(history.undo()).toBe(cores[0]);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBe(cores[1]);
    expect(history.redo()).toBe(cores[2]);
    expect(history.redo()).toBe(cores[3]);
    expect(history.redo()).toBeNull();
  });

  it("evicts the oldest transaction past RESOURCE_POLICY.maxUndoTransactions", () => {
    const limit = RESOURCE_POLICY.maxUndoTransactions;
    expect(limit).toBe(100);
    const history = new ProjectHistory();
    const cores = [createEmptyProjectCore()];
    const total = limit + 5;
    for (let i = 1; i <= total; i += 1) {
      const next = coreWithGuide(cores[i - 1], i);
      history.begin(cores[i - 1]);
      history.update(next);
      history.commit();
      cores.push(next);
    }
    expect(history.undoDepth).toBe(limit);

    let last: ProjectCoreV1 | null = null;
    let steps = 0;
    for (;;) {
      const core = history.undo();
      if (core === null) break;
      last = core;
      steps += 1;
    }
    expect(steps).toBe(limit);
    // The 5 oldest transactions were evicted: undo bottoms out at state 5.
    expect(last).toBe(cores[total - limit]);
  });

  it("guards transaction misuse", () => {
    const history = new ProjectHistory();
    const base = createEmptyProjectCore();
    expect(() => history.update(base)).toThrow();
    expect(() => history.commit()).toThrow();
    expect(() => history.cancel()).toThrow();
    history.begin(base);
    expect(() => history.begin(base)).toThrow();
    expect(history.canUndo).toBe(false); // undo unavailable while open
    history.cancel();
  });

  it("rejects invalid limits and supports clear()", () => {
    expect(() => new ProjectHistory(0)).toThrow();
    const history = new ProjectHistory(2);
    const base = createEmptyProjectCore();
    history.begin(base);
    history.update(coreWithGuide(base, 1));
    history.commit();
    history.clear();
    expect(history.undoDepth).toBe(0);
    expect(history.canUndo).toBe(false);
  });
});
