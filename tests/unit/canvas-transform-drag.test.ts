/**
 * Transform drag state machine: move (with smart-guide snapping), scale
 * (corner/edge, Shift constraints, no-flip clamp), rotate (Shift 15°),
 * group transforms, locked-layer exclusion, layer hit-testing, and
 * perspective corner editing gated by validateQuad.
 */
import { describe, expect, it } from "vitest";
import {
  beginPerspectiveDrag,
  beginTransformDrag,
  dragSelectionBounds,
  hitTestLayers,
  transformDragCommand,
  updatePerspectiveDrag,
  updateTransformDrag,
  type SnapContext,
  type TransformDragLayer,
} from "../../src/workspace/canvas/transform-drag";
import { identityTransform } from "../../src/project";
import type { SnappingV1, TransformV1 } from "../../src/core/types";

const SNAPPING_ALL: SnappingV1 = {
  enabled: true,
  toGuides: true,
  toGrid: true,
  toLayers: true,
  toArtboard: true,
};
const SNAPPING_OFF: SnappingV1 = { ...SNAPPING_ALL, enabled: false };

function snapContext(overrides: Partial<SnapContext> = {}): SnapContext {
  return {
    snapping: SNAPPING_OFF,
    candidates: {},
    zoom: 1,
    ...overrides,
  };
}

/** 100×100 layer whose bounds are exactly (0,0)-(100,100). */
function layer(id = "layer-1", overrides: Partial<TransformDragLayer> = {}): TransformDragLayer {
  return {
    id,
    locked: false,
    transform: identityTransform({ x: 50, y: 50 }),
    size: { width: 100, height: 100 },
    ...overrides,
  };
}

describe("move", () => {
  it("translates by the pointer delta when nothing snaps", () => {
    const state = beginTransformDrag("move", [layer()], { x: 10, y: 10 })!;
    const update = updateTransformDrag(state, { x: 40, y: 25 }, {}, snapContext());
    expect(update.entries).toHaveLength(1);
    expect(update.entries[0].transform.position).toEqual({ x: 80, y: 65 });
    expect(update.linesX).toEqual([]);
  });

  it("snaps edges to guide candidates within tolerance and reports lines", () => {
    const state = beginTransformDrag("move", [layer()], { x: 0, y: 0 })!;
    // Proposed left edge lands at 33; a vertical guide at 30 is within 6px.
    const update = updateTransformDrag(
      state,
      { x: 33, y: 0 },
      {},
      snapContext({ snapping: SNAPPING_ALL, candidates: { guidesX: [30] } }),
    );
    expect(update.entries[0].transform.position.x).toBe(80); // 50 + 33 - 3
    expect(update.linesX).toEqual([30]);
  });

  it("moves every unlocked layer of a group and skips locked ones", () => {
    const layers = [
      layer("a"),
      layer("b", { transform: identityTransform({ x: 250, y: 50 }) }),
      layer("locked", { locked: true }),
    ];
    const state = beginTransformDrag("move", layers, { x: 0, y: 0 })!;
    const update = updateTransformDrag(state, { x: 10, y: 0 }, {}, snapContext());
    expect(update.entries.map((entry) => entry.layerId)).toEqual(["a", "b"]);
    expect(update.entries[1].transform.position).toEqual({ x: 260, y: 50 });
  });

  it("returns null when every layer is locked", () => {
    expect(beginTransformDrag("move", [layer("a", { locked: true })], { x: 0, y: 0 })).toBeNull();
  });

  it("wraps entries in one layers/set-transforms command", () => {
    const state = beginTransformDrag("move", [layer()], { x: 0, y: 0 })!;
    const update = updateTransformDrag(state, { x: 5, y: 5 }, {}, snapContext());
    const command = transformDragCommand(update)!;
    expect(command.type).toBe("layers/set-transforms");
    expect(transformDragCommand({ entries: [], linesX: [], linesY: [] })).toBeNull();
  });
});

describe("scale", () => {
  it("corner handle scales both axes about the opposite corner", () => {
    const state = beginTransformDrag("scale-se", [layer()], { x: 100, y: 100 })!;
    expect(state.pivot).toEqual({ x: 0, y: 0 });
    const update = updateTransformDrag(state, { x: 200, y: 150 }, {}, snapContext());
    const transform = update.entries[0].transform;
    expect(transform.scale.x).toBeCloseTo(2, 10);
    expect(transform.scale.y).toBeCloseTo(1.5, 10);
    // The layer center orbits the pivot: (50,50) → (100,75).
    expect(transform.position.x).toBeCloseTo(100, 10);
    expect(transform.position.y).toBeCloseTo(75, 10);
  });

  it("Shift on a corner constrains aspect via diagonal projection", () => {
    const state = beginTransformDrag("scale-se", [layer()], { x: 100, y: 100 })!;
    const update = updateTransformDrag(state, { x: 200, y: 200 }, { shift: true }, snapContext());
    const transform = update.entries[0].transform;
    expect(transform.scale.x).toBeCloseTo(2, 10);
    expect(transform.scale.y).toBeCloseTo(2, 10);
  });

  it("edge handle scales one axis; Shift makes it uniform", () => {
    const state = beginTransformDrag("scale-e", [layer()], { x: 100, y: 50 })!;
    expect(state.pivot).toEqual({ x: 0, y: 50 });
    const plain = updateTransformDrag(state, { x: 150, y: 50 }, {}, snapContext());
    expect(plain.entries[0].transform.scale).toEqual({ x: 1.5, y: 1 });
    const uniform = updateTransformDrag(state, { x: 150, y: 50 }, { shift: true }, snapContext());
    expect(uniform.entries[0].transform.scale.x).toBeCloseTo(1.5, 10);
    expect(uniform.entries[0].transform.scale.y).toBeCloseTo(1.5, 10);
  });

  it("clamps at the minimum factor — handles never flip a layer", () => {
    const state = beginTransformDrag("scale-se", [layer()], { x: 100, y: 100 })!;
    const update = updateTransformDrag(state, { x: -300, y: -300 }, {}, snapContext());
    expect(update.entries[0].transform.scale.x).toBe(0.01);
    expect(update.entries[0].transform.scale.y).toBe(0.01);
  });

  it("snaps the dragged handle point before deriving factors", () => {
    const state = beginTransformDrag("scale-se", [layer()], { x: 100, y: 100 })!;
    const update = updateTransformDrag(
      state,
      { x: 197, y: 100 },
      {},
      snapContext({ snapping: SNAPPING_ALL, candidates: { guidesX: [200] } }),
    );
    expect(update.entries[0].transform.scale.x).toBeCloseTo(2, 10);
    expect(update.linesX).toEqual([200]);
  });
});

describe("rotate", () => {
  it("rotates about the selection center by the pointer angle delta", () => {
    const state = beginTransformDrag("rotate", [layer()], { x: 100, y: 50 })!;
    const update = updateTransformDrag(state, { x: 50, y: 100 }, {}, snapContext());
    expect(update.entries[0].transform.rotation).toBeCloseTo(90, 10);
  });

  it("Shift snaps rotation to 15° increments", () => {
    const state = beginTransformDrag("rotate", [layer()], { x: 100, y: 50 })!;
    // 40° raw → 45° snapped.
    const rad = (40 * Math.PI) / 180;
    const point = { x: 50 + 50 * Math.cos(rad), y: 50 + 50 * Math.sin(rad) };
    const update = updateTransformDrag(state, point, { shift: true }, snapContext());
    expect(update.entries[0].transform.rotation).toBeCloseTo(45, 10);
  });
});

describe("hitTestLayers", () => {
  const stack = [
    { ...layer("bottom"), visible: true },
    {
      ...layer("top", { transform: identityTransform({ x: 100, y: 100 }) }),
      visible: true,
    },
  ];

  it("returns the topmost visible layer under the point", () => {
    expect(hitTestLayers({ x: 90, y: 90 }, stack)?.id).toBe("top");
    expect(hitTestLayers({ x: 10, y: 10 }, stack)?.id).toBe("bottom");
    expect(hitTestLayers({ x: 400, y: 400 }, stack)).toBeNull();
  });

  it("skips invisible layers", () => {
    const hidden = [{ ...stack[0] }, { ...stack[1], visible: false }];
    expect(hitTestLayers({ x: 90, y: 90 }, hidden)?.id).toBe("bottom");
  });

  it("respects rotated geometry", () => {
    const rotated: TransformV1 = {
      ...identityTransform({ x: 50, y: 50 }),
      rotation: 45,
    };
    const target = [{ ...layer("rot", { transform: rotated }), visible: true }];
    // The unrotated corner (2,2) is outside a 45°-rotated square.
    expect(hitTestLayers({ x: 2, y: 2 }, target)).toBeNull();
    expect(hitTestLayers({ x: 50, y: 50 }, target)?.id).toBe("rot");
  });
});

describe("dragSelectionBounds", () => {
  it("unions unlocked layer bounds and ignores locked layers", () => {
    const bounds = dragSelectionBounds([
      layer("a"),
      layer("b", { transform: identityTransform({ x: 250, y: 50 }) }),
      layer("c", { locked: true, transform: identityTransform({ x: 900, y: 900 }) }),
    ]);
    expect(bounds).toEqual({ x: 0, y: 0, width: 300, height: 100 });
  });
});

describe("perspective corner editing", () => {
  it("starts from the affine corners when no quad is stored", () => {
    const state = beginPerspectiveDrag(layer(), 2)!;
    expect(state.startQuad).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
    expect(state.lastValid).toEqual(state.startQuad);
  });

  it("valid corner drags emit a perspective patch and update lastValid", () => {
    const state = beginPerspectiveDrag(layer(), 2)!;
    const update = updatePerspectiveDrag(state, { x: 120, y: 130 }, snapContext());
    expect(update.valid).toBe(true);
    expect(update.command).toEqual({
      type: "layer/set-transform",
      layerId: "layer-1",
      patch: {
        perspective: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 120, y: 130 },
          { x: 0, y: 100 },
        ],
      },
    });
    expect(update.state.lastValid[2]).toEqual({ x: 120, y: 130 });
  });

  it("invalid quads emit nothing and keep the prior valid quad", () => {
    let state = beginPerspectiveDrag(layer(), 2)!;
    state = updatePerspectiveDrag(state, { x: 120, y: 130 }, snapContext()).state;

    // Nonfinite corner → validateQuad rejects.
    const nonfinite = updatePerspectiveDrag(state, { x: Number.NaN, y: 50 }, snapContext());
    expect(nonfinite.valid).toBe(false);
    expect(nonfinite.command).toBeNull();
    expect(nonfinite.state.lastValid[2]).toEqual({ x: 120, y: 130 });

    // Self-intersecting: corner 2 dragged across the top edge.
    const crossed = updatePerspectiveDrag(state, { x: 50, y: -200 }, snapContext());
    expect(crossed.valid).toBe(false);
    expect(crossed.command).toBeNull();
  });

  it("refuses to start on locked layers and uses a stored quad when present", () => {
    expect(beginPerspectiveDrag(layer("a", { locked: true }), 0)).toBeNull();
    const quad: TransformV1["perspective"] = [
      { x: 5, y: 5 },
      { x: 95, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const warped = layer("warped", {
      transform: { ...identityTransform({ x: 50, y: 50 }), perspective: quad },
    });
    const state = beginPerspectiveDrag(warped, 0)!;
    expect(state.startQuad[0]).toEqual({ x: 5, y: 5 });
  });

  it("corner points snap to guide candidates", () => {
    const state = beginPerspectiveDrag(layer(), 2)!;
    const update = updatePerspectiveDrag(
      state,
      { x: 118, y: 130 },
      snapContext({ snapping: SNAPPING_ALL, candidates: { guidesX: [120] } }),
    );
    expect(update.valid).toBe(true);
    expect(update.state.lastValid[2].x).toBe(120);
  });
});
