/**
 * Guide drag state machine: create (preview-only until one commit command),
 * move (live commands, clamped), cancel, locked/hidden refusal, snapping,
 * and explicit removal.
 */
import { describe, expect, it } from "vitest";
import {
  beginGuideCreate,
  beginGuideMove,
  cancelGuideDrag,
  commitGuideDrag,
  GUIDE_IDLE,
  guideRemoveCommand,
  updateGuideDrag,
  type GuideDragContext,
} from "../../src/workspace/canvas/guide-drag";
import type { GuidesV1, SnappingV1 } from "../../src/core/types";

const SNAPPING_OFF: SnappingV1 = {
  enabled: false,
  toGuides: true,
  toGrid: true,
  toLayers: true,
  toArtboard: true,
};

const SNAPPING_GRID: SnappingV1 = { ...SNAPPING_OFF, enabled: true };

function context(overrides: Partial<GuideDragContext> = {}): GuideDragContext {
  return {
    artboard: { width: 1000, height: 800 },
    snapping: SNAPPING_OFF,
    gridSize: null,
    zoom: 1,
    ...overrides,
  };
}

function guides(overrides: Partial<GuidesV1> = {}): GuidesV1 {
  return { horizontal: [200], vertical: [100], locked: false, visible: true, ...overrides };
}

describe("guide creation", () => {
  it("previews without commands and commits exactly one guides/add", () => {
    let state = beginGuideCreate("vertical");
    const update = updateGuideDrag(state, { x: 250.4, y: 300 }, context());
    state = update.state;
    expect(update.command).toBeNull();
    expect(state).toMatchObject({ phase: "create", offset: 250, valid: true });
    expect(commitGuideDrag(state)).toEqual({
      type: "guides/add",
      axis: "vertical",
      offset: 250,
    });
  });

  it("horizontal guides track the y axis", () => {
    let state = beginGuideCreate("horizontal");
    state = updateGuideDrag(state, { x: 5, y: 640 }, context()).state;
    expect(commitGuideDrag(state)).toEqual({
      type: "guides/add",
      axis: "horizontal",
      offset: 640,
    });
  });

  it("releasing outside the artboard commits nothing", () => {
    let state = beginGuideCreate("vertical");
    state = updateGuideDrag(state, { x: -40, y: 300 }, context()).state;
    expect(state).toMatchObject({ valid: false });
    expect(commitGuideDrag(state)).toBeNull();
    state = updateGuideDrag(state, { x: 1400, y: 300 }, context()).state;
    expect(commitGuideDrag(state)).toBeNull();
  });

  it("Escape cancels back to idle with no command", () => {
    let state = beginGuideCreate("vertical");
    state = updateGuideDrag(state, { x: 250, y: 300 }, context()).state;
    state = cancelGuideDrag();
    expect(state).toEqual(GUIDE_IDLE);
    expect(commitGuideDrag(state)).toBeNull();
  });

  it("snaps to grid multiples when snapping is enabled", () => {
    let state = beginGuideCreate("vertical");
    state = updateGuideDrag(
      state,
      { x: 248, y: 300 },
      context({ snapping: SNAPPING_GRID, gridSize: 50 }),
    ).state;
    expect(state).toMatchObject({ offset: 250 });
  });

  it("never snaps to grid when snapping is disabled", () => {
    let state = beginGuideCreate("vertical");
    state = updateGuideDrag(state, { x: 248, y: 300 }, context({ gridSize: 50 })).state;
    expect(state).toMatchObject({ offset: 248 });
  });
});

describe("guide moving", () => {
  it("hit-tests the nearest guide and emits live guides/move commands", () => {
    let state = beginGuideMove({ x: 102, y: 400 }, guides(), 1);
    expect(state).toMatchObject({ phase: "move", axis: "vertical", index: 0, offset: 100 });

    const update = updateGuideDrag(state, { x: 340, y: 400 }, context());
    state = update.state;
    expect(update.command).toEqual({
      type: "guides/move",
      axis: "vertical",
      index: 0,
      offset: 340,
    });
  });

  it("emits no command when the offset has not changed", () => {
    let state = beginGuideMove({ x: 100, y: 400 }, guides(), 1);
    const first = updateGuideDrag(state, { x: 340, y: 400 }, context());
    state = first.state;
    const second = updateGuideDrag(state, { x: 340.2, y: 400 }, context());
    expect(second.command).toBeNull();
  });

  it("clamps moves to the artboard instead of removing", () => {
    let state = beginGuideMove({ x: 100, y: 400 }, guides(), 1);
    const update = updateGuideDrag(state, { x: -500, y: 400 }, context());
    expect(update.command).toEqual({
      type: "guides/move",
      axis: "vertical",
      index: 0,
      offset: 0,
    });
    state = update.state;
    const far = updateGuideDrag(state, { x: 5000, y: 400 }, context());
    expect(far.command).toMatchObject({ offset: 1000 });
  });

  it("moves emit nothing at commit (updates were live in the gesture)", () => {
    let state = beginGuideMove({ x: 100, y: 400 }, guides(), 1);
    state = updateGuideDrag(state, { x: 340, y: 400 }, context()).state;
    expect(commitGuideDrag(state)).toBeNull();
  });

  it("locked or hidden guides never begin a move", () => {
    expect(beginGuideMove({ x: 100, y: 400 }, guides({ locked: true }), 1)).toEqual(GUIDE_IDLE);
    expect(beginGuideMove({ x: 100, y: 400 }, guides({ visible: false }), 1)).toEqual(
      GUIDE_IDLE,
    );
  });

  it("misses when nothing is within tolerance", () => {
    expect(beginGuideMove({ x: 60, y: 400 }, guides(), 1)).toEqual(GUIDE_IDLE);
  });

  it("prefers horizontal guides when the pointer is nearer to one", () => {
    const state = beginGuideMove({ x: 500, y: 201 }, guides(), 1);
    expect(state).toMatchObject({ phase: "move", axis: "horizontal", index: 0 });
  });
});

describe("guide removal", () => {
  it("builds the explicit removal command", () => {
    expect(guideRemoveCommand("horizontal", 2)).toEqual({
      type: "guides/remove",
      axis: "horizontal",
      index: 2,
    });
  });
});

describe("idle updates", () => {
  it("idle state ignores updates", () => {
    const update = updateGuideDrag(GUIDE_IDLE, { x: 10, y: 10 }, context());
    expect(update.state).toEqual(GUIDE_IDLE);
    expect(update.command).toBeNull();
  });
});
