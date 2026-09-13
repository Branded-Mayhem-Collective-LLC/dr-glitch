/**
 * Crop drag state machine: frozen source↔doc mapping, per-handle rect
 * editing with clampCrop, position compensation that keeps visible pixels
 * stationary, commit/cancel semantics, and Clear Crop.
 */
import { describe, expect, it } from "vitest";
import {
  beginCropDrag,
  clearCropCommands,
  commitCropDrag,
  sourceToDocMatrix,
  updateCropDrag,
  type CropDragLayer,
} from "../../src/workspace/canvas/crop-drag";
import { identityTransform } from "../../src/project";
import { mat3ApplyToPoint } from "../../src/editor";

const ASSET = { width: 200, height: 100 };

/** Uncropped 200×100 layer laid out 1:1 — source space equals doc space. */
function identityLayer(overrides: Partial<CropDragLayer> = {}): CropDragLayer {
  return {
    id: "layer-1",
    crop: null,
    transform: identityTransform({ x: 100, y: 50 }),
    ...overrides,
  };
}

describe("sourceToDocMatrix", () => {
  it("is identity for an uncropped, untransformed layer at its natural center", () => {
    const m = sourceToDocMatrix(identityLayer(), ASSET);
    expect(mat3ApplyToPoint(m, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(mat3ApplyToPoint(m, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 });
  });

  it("accounts for the crop origin so source coordinates stay absolute", () => {
    // Crop {60,0,100,100}, position (100,50): the crop center (110,50) in
    // source space must land on the layer anchor.
    const layer = identityLayer({
      crop: { x: 60, y: 0, width: 100, height: 100 },
      transform: identityTransform({ x: 100, y: 50 }),
    });
    const m = sourceToDocMatrix(layer, ASSET);
    expect(mat3ApplyToPoint(m, { x: 110, y: 50 })).toEqual({ x: 100, y: 50 });
  });
});

describe("begin / update", () => {
  it("edge handle drags resize the rect and emit crop + position compensation", () => {
    const state = beginCropDrag("e", identityLayer(), ASSET, { x: 200, y: 50 })!;
    const update = updateCropDrag(state, { x: 120, y: 50 });
    expect(update.state.rect).toEqual({ x: 0, y: 0, width: 120, height: 100 });
    expect(update.commands).toEqual([
      {
        type: "layer/set-crop",
        layerId: "layer-1",
        crop: { x: 0, y: 0, width: 120, height: 100 },
      },
      {
        type: "layer/set-transform",
        layerId: "layer-1",
        patch: { position: { x: 60, y: 50 } },
      },
    ]);
  });

  it("clamps the rect to the asset and keeps at least 1px", () => {
    const state = beginCropDrag("e", identityLayer(), ASSET, { x: 200, y: 50 })!;
    const outside = updateCropDrag(state, { x: 900, y: 50 });
    expect(outside.state.rect).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    const crossed = updateCropDrag(state, { x: -500, y: 50 });
    expect(crossed.state.rect.width).toBeGreaterThanOrEqual(1);
    expect(crossed.state.rect.x).toBe(0);
  });

  it("corner handles move both edges", () => {
    const state = beginCropDrag("nw", identityLayer(), ASSET, { x: 0, y: 0 })!;
    const update = updateCropDrag(state, { x: 40, y: 20 });
    expect(update.state.rect).toEqual({ x: 40, y: 20, width: 160, height: 80 });
  });

  it("move handle translates the rect at constant size, clamped inside", () => {
    const layer = identityLayer({ crop: { x: 20, y: 10, width: 100, height: 50 } });
    const state = beginCropDrag("move", layer, ASSET, { x: 100, y: 50 })!;
    const update = updateCropDrag(state, { x: 130, y: 60 });
    expect(update.state.rect).toEqual({ x: 50, y: 20, width: 100, height: 50 });
    const pushed = updateCropDrag(state, { x: 1000, y: 1000 });
    expect(pushed.state.rect).toEqual({ x: 100, y: 50, width: 100, height: 50 });
  });

  it("no-change updates emit no commands", () => {
    const state = beginCropDrag("e", identityLayer(), ASSET, { x: 200, y: 50 })!;
    const same = updateCropDrag(state, { x: 200, y: 50 });
    expect(same.commands).toEqual([]);
    expect(same.state).toBe(state);
  });

  it("maps pointer input through the frozen transform (scale 2 layer)", () => {
    // 100×100 asset at scale 2 centered at (100,100): doc x 160 → source x 80.
    const layer: CropDragLayer = {
      id: "scaled",
      crop: null,
      transform: {
        ...identityTransform({ x: 100, y: 100 }),
        scale: { x: 2, y: 2 },
      },
    };
    const asset = { width: 100, height: 100 };
    const state = beginCropDrag("e", layer, asset, { x: 200, y: 100 })!;
    const update = updateCropDrag(state, { x: 160, y: 100 });
    expect(update.state.rect).toEqual({ x: 0, y: 0, width: 80, height: 100 });
    // Compensated position pins the new crop center: source (40,50) → doc (80,100).
    expect(update.commands[1]).toMatchObject({
      patch: { position: { x: 80, y: 100 } },
    });
  });
});

describe("commit / cancel semantics", () => {
  it("commit returns the final commands, or [] when nothing changed", () => {
    const state = beginCropDrag("e", identityLayer(), ASSET, { x: 200, y: 50 })!;
    expect(commitCropDrag(state)).toEqual([]);
    const dragged = updateCropDrag(state, { x: 150, y: 50 }).state;
    const commands = commitCropDrag(dragged);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "layer/set-crop",
      crop: { x: 0, y: 0, width: 150, height: 100 },
    });
  });
});

describe("clearCropCommands", () => {
  it("restores the full source with position compensation", () => {
    const layer = identityLayer({
      crop: { x: 60, y: 0, width: 100, height: 100 },
      transform: identityTransform({ x: 100, y: 50 }),
    });
    const commands = clearCropCommands(layer, ASSET);
    expect(commands[0]).toEqual({ type: "layer/set-crop", layerId: "layer-1", crop: null });
    // Full-source center (100,50) sits 10px left of the crop center in
    // source space, so the anchor compensates to (90,50).
    expect(commands[1]).toEqual({
      type: "layer/set-transform",
      layerId: "layer-1",
      patch: { position: { x: 90, y: 50 } },
    });
  });

  it("is a no-op position-wise for an already-uncropped layer", () => {
    const commands = clearCropCommands(identityLayer(), ASSET);
    expect(commands[1]).toMatchObject({ patch: { position: { x: 100, y: 50 } } });
  });
});

describe("perspective composition under crop (wave F transforms item)", () => {
  const QUAD: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] = [
    { x: 10, y: 10 },
    { x: 210, y: 30 },
    { x: 200, y: 120 },
    { x: 20, y: 100 },
  ];

  function warpedLayer(): CropDragLayer {
    return identityLayer({
      transform: { ...identityTransform({ x: 100, y: 50 }), perspective: QUAD },
    });
  }

  it("cropping a warped layer remaps the quad to the crop's sub-quad (no stretch)", async () => {
    const { solveRectToQuad, applyHomography } = await import("../../src/editor");
    const state = beginCropDrag("e", warpedLayer(), ASSET, { x: 200, y: 50 })!;
    const update = updateCropDrag(state, { x: 120, y: 50 });
    const transform = update.commands.find(
      (command) => command.type === "layer/set-transform",
    );
    expect(transform).toBeDefined();
    const patch = (transform as { patch: { perspective?: unknown } }).patch;
    expect(patch.perspective).toBeDefined();
    // The new quad's TL must equal the OLD homography's image of the new
    // crop origin (identical here: crop origin unchanged) and the right
    // edge must equal the old image of x=120 — content REMOVED, geometry
    // of the remaining pixels unchanged.
    const solved = solveRectToQuad({ width: 200, height: 100 }, QUAD);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const quad = patch.perspective as Array<{ x: number; y: number }>;
    const expectedTr = applyHomography(solved.matrix, { x: 120, y: 0 });
    expect(quad[0].x).toBeCloseTo(QUAD[0].x, 6);
    expect(quad[0].y).toBeCloseTo(QUAD[0].y, 6);
    expect(quad[1].x).toBeCloseTo(expectedTr.x, 6);
    expect(quad[1].y).toBeCloseTo(expectedTr.y, 6);
  });

  it("Clear Crop on a warped cropped layer extrapolates the quad outward", async () => {
    const { solveRectToQuad, applyHomography } = await import("../../src/editor");
    const layer = identityLayer({
      crop: { x: 50, y: 25, width: 100, height: 50 },
      transform: { ...identityTransform({ x: 100, y: 50 }), perspective: QUAD },
    });
    const commands = clearCropCommands(layer, ASSET);
    const transform = commands.find((command) => command.type === "layer/set-transform");
    const patch = (transform as { patch: { perspective?: unknown } }).patch;
    expect(patch.perspective).toBeDefined();
    // Previously visible pixels stay put: the point that was the cropped
    // origin (source 50,25) must map to the OLD quad's TL under the NEW
    // full-source homography.
    const quad = patch.perspective as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const solvedNew = solveRectToQuad({ width: 200, height: 100 }, quad);
    expect(solvedNew.ok).toBe(true);
    if (!solvedNew.ok) return;
    const mapped = applyHomography(solvedNew.matrix, { x: 50, y: 25 });
    expect(mapped.x).toBeCloseTo(QUAD[0].x, 5);
    expect(mapped.y).toBeCloseTo(QUAD[0].y, 5);
  });

  it("unwarped layers emit no perspective patch (prior behavior preserved)", () => {
    const state = beginCropDrag("e", identityLayer(), ASSET, { x: 200, y: 50 })!;
    const update = updateCropDrag(state, { x: 150, y: 50 });
    const transform = update.commands.find(
      (command) => command.type === "layer/set-transform",
    );
    const patch = (transform as { patch: { perspective?: unknown } }).patch;
    expect("perspective" in patch).toBe(false);
  });
});
