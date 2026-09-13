import { describe, expect, it } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { LayerV1, ProjectCoreV1 } from "../../src/core/types";
import type { Command } from "../../src/project/commands";
import {
  createEmptyProjectCore,
  createLayerFromAsset,
} from "../../src/project/factory";
import {
  applyCommand,
  isValidPerspectiveQuad,
  sanitizeTransform,
} from "../../src/project/reducer";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function makeLayer(name = "Layer 1"): LayerV1 {
  return createLayerFromAsset("a".repeat(64), name, { width: 800, height: 600 }, {
    widthPx: 2640,
    heightPx: 3600,
    presetId: "11x15",
    background: "white",
  });
}

function makeCore(layerCount = 1): { core: ProjectCoreV1; layers: LayerV1[] } {
  let core = createEmptyProjectCore();
  const layers: LayerV1[] = [];
  for (let i = 0; i < layerCount; i += 1) {
    const layer = makeLayer(`Layer ${i + 1}`);
    layers.push(layer);
    core = applyCommand(core, { type: "layer/add", layer });
  }
  return { core, layers };
}

/** Applies a command against a deep-frozen core to prove non-mutation. */
function apply(core: ProjectCoreV1, command: Command): ProjectCoreV1 {
  return applyCommand(deepFreeze(core), command);
}

const VALID_QUAD: NonNullable<
  import("../../src/core/types").PerspectiveQuadV1
> = [
  { x: 0, y: 0 },
  { x: 100, y: 10 },
  { x: 110, y: 120 },
  { x: -10, y: 100 },
];

describe("project reducer: layers", () => {
  it("adds a layer at the end and at an index", () => {
    const { core, layers } = makeCore(2);
    const extra = makeLayer("Extra");
    const appended = apply(core, { type: "layer/add", layer: extra });
    expect(appended.layers.map((l) => l.id)).toEqual([layers[0].id, layers[1].id, extra.id]);

    const inserted = apply(core, { type: "layer/add", layer: extra, index: 0 });
    expect(inserted.layers[0].id).toBe(extra.id);
  });

  it("rejects adding beyond RESOURCE_POLICY.maxLayers", () => {
    const { core } = makeCore(RESOURCE_POLICY.maxLayers);
    expect(core.layers).toHaveLength(RESOURCE_POLICY.maxLayers);
    const next = apply(core, { type: "layer/add", layer: makeLayer("Over cap") });
    expect(next).toBe(core);
  });

  it("rejects adding a duplicate layer id", () => {
    const { core, layers } = makeCore(1);
    const next = apply(core, { type: "layer/add", layer: layers[0] });
    expect(next).toBe(core);
  });

  it("removes a layer and ignores unknown ids", () => {
    const { core, layers } = makeCore(2);
    const next = apply(core, { type: "layer/remove", layerId: layers[0].id });
    expect(next.layers.map((l) => l.id)).toEqual([layers[1].id]);
    expect(apply(core, { type: "layer/remove", layerId: "nope" })).toBe(core);
  });

  it("duplicates a layer above the source with the full recipe", () => {
    const { core, layers } = makeCore(2);
    const tuned = apply(core, {
      type: "recipe/update-halftone",
      layerId: layers[0].id,
      patch: { cellSize: 33, dotShape: "diamond" },
    });
    const next = apply(tuned, {
      type: "layer/duplicate",
      layerId: layers[0].id,
      newLayerId: "dup-1",
    });
    expect(next.layers).toHaveLength(3);
    expect(next.layers[1].id).toBe("dup-1");
    expect(next.layers[1].name).toBe("Layer 1 copy");
    expect(next.layers[1].recipe).toEqual(next.layers[0].recipe);
    expect(next.layers[1].recipe).not.toBe(next.layers[0].recipe);
  });

  it("rejects duplicate at the layer cap", () => {
    const { core, layers } = makeCore(RESOURCE_POLICY.maxLayers);
    const next = apply(core, {
      type: "layer/duplicate",
      layerId: layers[0].id,
      newLayerId: "dup-1",
    });
    expect(next).toBe(core);
  });

  it("reorders layers and clamps the target index", () => {
    const { core, layers } = makeCore(3);
    const next = apply(core, { type: "layer/reorder", layerId: layers[0].id, toIndex: 2 });
    expect(next.layers.map((l) => l.id)).toEqual([layers[1].id, layers[2].id, layers[0].id]);
    const clamped = apply(core, { type: "layer/reorder", layerId: layers[2].id, toIndex: 99 });
    expect(clamped).toBe(core); // already last after clamping
  });

  it("renames, toggles visibility, and toggles lock", () => {
    const { core, layers } = makeCore(1);
    const id = layers[0].id;
    let next = apply(core, { type: "layer/rename", layerId: id, name: "Skull" });
    next = apply(next, { type: "layer/set-visibility", layerId: id, visible: false });
    next = apply(next, { type: "layer/set-locked", layerId: id, locked: true });
    expect(next.layers[0]).toMatchObject({ name: "Skull", visible: false, locked: true });
  });

  it("clamps opacity into 0..1 and rejects nonfinite values", () => {
    const { core, layers } = makeCore(1);
    const id = layers[0].id;
    expect(apply(core, { type: "layer/set-opacity", layerId: id, opacity: 2 }).layers[0].opacity).toBe(1);
    expect(apply(core, { type: "layer/set-opacity", layerId: id, opacity: -1 }).layers[0].opacity).toBe(0);
    expect(apply(core, { type: "layer/set-opacity", layerId: id, opacity: 0.4 }).layers[0].opacity).toBe(0.4);
    expect(apply(core, { type: "layer/set-opacity", layerId: id, opacity: Number.NaN })).toBe(core);
  });

  it("sets and clears crop, rejecting invalid rectangles", () => {
    const { core, layers } = makeCore(1);
    const id = layers[0].id;
    const crop = { x: 10, y: 20, width: 100, height: 50 };
    const set = apply(core, { type: "layer/set-crop", layerId: id, crop });
    expect(set.layers[0].crop).toEqual(crop);
    const cleared = apply(set, { type: "layer/set-crop", layerId: id, crop: null });
    expect(cleared.layers[0].crop).toBeNull();
    expect(
      apply(core, { type: "layer/set-crop", layerId: id, crop: { x: 0, y: 0, width: 0, height: 5 } }),
    ).toBe(core);
    expect(
      apply(core, {
        type: "layer/set-crop",
        layerId: id,
        crop: { x: Number.NaN, y: 0, width: 5, height: 5 },
      }),
    ).toBe(core);
  });
});

describe("project reducer: transforms and perspective", () => {
  it("applies partial transform patches", () => {
    const { core, layers } = makeCore(1);
    const next = apply(core, {
      type: "layer/set-transform",
      layerId: layers[0].id,
      patch: { rotation: 45, flipH: true, scale: { x: 2, y: 0.5 } },
    });
    const t = next.layers[0].transform;
    expect(t.rotation).toBe(45);
    expect(t.flipH).toBe(true);
    expect(t.scale).toEqual({ x: 2, y: 0.5 });
    expect(t.position).toEqual(layers[0].transform.position);
    expect(t.skew).toEqual({ x: 0, y: 0 });
  });

  it("accepts a valid convex quad and clears with null", () => {
    const { core, layers } = makeCore(1);
    const withQuad = apply(core, {
      type: "layer/set-transform",
      layerId: layers[0].id,
      patch: { perspective: VALID_QUAD },
    });
    expect(withQuad.layers[0].transform.perspective).toEqual(VALID_QUAD);
    const cleared = apply(withQuad, {
      type: "layer/set-transform",
      layerId: layers[0].id,
      patch: { perspective: null },
    });
    expect(cleared.layers[0].transform.perspective).toBeNull();
  });

  it("rejects invalid quads and keeps the prior valid perspective", () => {
    const { core, layers } = makeCore(1);
    const id = layers[0].id;
    const withQuad = apply(core, {
      type: "layer/set-transform",
      layerId: id,
      patch: { perspective: VALID_QUAD },
    });
    const invalidQuads = [
      // Concave (dent at corner 2).
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 100 }],
      // Self-intersecting (bowtie).
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }],
      // Collinear / zero area.
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 0 }],
      // Nonfinite corner.
      [{ x: Number.NaN, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    ] as const;
    for (const quad of invalidQuads) {
      const next = apply(withQuad, {
        type: "layer/set-transform",
        layerId: id,
        patch: {
          perspective: quad as unknown as NonNullable<
            import("../../src/core/types").PerspectiveQuadV1
          >,
        },
      });
      expect(next.layers[0].transform.perspective).toEqual(VALID_QUAD);
    }
  });

  it("keeps prior fields for nonfinite patch values but applies valid ones", () => {
    const { core, layers } = makeCore(1);
    const next = apply(core, {
      type: "layer/set-transform",
      layerId: layers[0].id,
      patch: { rotation: Number.POSITIVE_INFINITY, position: { x: 5, y: 6 } },
    });
    expect(next.layers[0].transform.rotation).toBe(0);
    expect(next.layers[0].transform.position).toEqual({ x: 5, y: 6 });
  });

  it("validates quads directly", () => {
    expect(isValidPerspectiveQuad(VALID_QUAD)).toBe(true);
    expect(
      isValidPerspectiveQuad([
        { x: 0, y: 0 },
        { x: 1e-4, y: 0 },
        { x: 1e-4, y: 1e-4 },
        { x: 0, y: 1e-4 },
      ]),
    ).toBe(false); // near-zero area
  });

  it("sanitizeTransform never mutates the prior transform", () => {
    const { layers } = makeCore(1);
    const prior = deepFreeze(structuredClone(layers[0].transform));
    const next = sanitizeTransform(prior, { rotation: 90 });
    expect(next.rotation).toBe(90);
    expect(prior.rotation).toBe(0);
  });

  it("applies group transforms to unlocked layers only, in one command", () => {
    const { core, layers } = makeCore(3);
    const locked = apply(core, {
      type: "layer/set-locked",
      layerId: layers[1].id,
      locked: true,
    });
    const moved = apply(locked, {
      type: "layers/set-transforms",
      entries: layers.map((layer, i) => ({
        layerId: layer.id,
        transform: { ...layer.transform, position: { x: i * 10, y: i * 10 } },
      })),
    });
    expect(moved.layers[0].transform.position).toEqual({ x: 0, y: 0 });
    expect(moved.layers[1].transform.position).toEqual(layers[1].transform.position);
    expect(moved.layers[2].transform.position).toEqual({ x: 20, y: 20 });
  });
});

describe("project reducer: recipes and modes", () => {
  it("switches mode preserving inactive settings", () => {
    const { core, layers } = makeCore(1);
    const id = layers[0].id;
    let next = apply(core, {
      type: "recipe/update-halftone",
      layerId: id,
      patch: { cellSize: 24, dotShape: "cross" },
    });
    next = apply(next, {
      type: "recipe/update-diffusion",
      layerId: id,
      patch: { algorithm: "atkinson", levels: 4 },
    });
    next = apply(next, { type: "layer/set-mode", layerId: id, mode: "diffusion" });
    expect(next.layers[0].recipe.mode).toBe("diffusion");
    expect(next.layers[0].recipe.halftone.cellSize).toBe(24);
    expect(next.layers[0].recipe.halftone.dotShape).toBe("cross");
    next = apply(next, { type: "layer/set-mode", layerId: id, mode: "halftone" });
    expect(next.layers[0].recipe.diffusion.algorithm).toBe("atkinson");
    expect(next.layers[0].recipe.diffusion.levels).toBe(4);
  });

  it("merges recipe patches and drops nonfinite numbers", () => {
    const { core, layers } = makeCore(1);
    const id = layers[0].id;
    const next = apply(core, {
      type: "recipe/update-glitch",
      layerId: id,
      patch: { enabled: true, sliceShift: 12, gridWarp: Number.NaN },
    });
    expect(next.layers[0].recipe.glitch.enabled).toBe(true);
    expect(next.layers[0].recipe.glitch.sliceShift).toBe(12);
    expect(next.layers[0].recipe.glitch.gridWarp).toBe(0);
  });
});

describe("project reducer: artboard, separation, registration", () => {
  it("resizes the artboard with integer px and a preset id", () => {
    const { core } = makeCore(0);
    const next = apply(core, {
      type: "artboard/resize",
      widthPx: 1920,
      heightPx: 2400,
      presetId: "8x10",
    });
    expect(next.artboard).toMatchObject({ widthPx: 1920, heightPx: 2400, presetId: "8x10" });
  });

  it("rejects non-integer and oversized artboards", () => {
    const { core } = makeCore(0);
    expect(
      apply(core, { type: "artboard/resize", widthPx: 100.5, heightPx: 200, presetId: "custom" }),
    ).toBe(core);
    expect(
      apply(core, { type: "artboard/resize", widthPx: 0, heightPx: 200, presetId: "custom" }),
    ).toBe(core);
    expect(
      apply(core, { type: "artboard/resize", widthPx: 5000, heightPx: 5000, presetId: "custom" }),
    ).toBe(core); // 25MP > 20MP policy
    expect(
      apply(core, { type: "artboard/resize", widthPx: 32769, heightPx: 16, presetId: "custom" }),
    ).toBe(core); // extreme row/column scratch is bounded independently
  });

  it("sets background, separation mode, angles, and plate visibility", () => {
    const { core } = makeCore(0);
    let next = apply(core, { type: "artboard/set-background", background: "transparent" });
    next = apply(next, { type: "separation/set-mode", mode: "grayscale" });
    next = apply(next, { type: "separation/set-angle", plate: "cyan", angle: 22.5 });
    next = apply(next, { type: "separation/set-plate-visibility", plate: "yellow", visible: false });
    expect(next.artboard.background).toBe("transparent");
    expect(next.separation.mode).toBe("grayscale");
    expect(next.separation.angles.cyan).toBe(22.5);
    expect(next.separation.visible.yellow).toBe(false);
    expect(apply(next, { type: "separation/set-angle", plate: "cyan", angle: Number.NaN })).toBe(next);
  });

  it("updates registration settings", () => {
    const { core } = makeCore(0);
    const next = apply(core, {
      type: "registration/update",
      patch: { size: 200, offset: null, weight: 3, mode: "centered" },
    });
    expect(next.registration).toEqual({
      size: 200,
      offset: null,
      weight: 3,
      mode: "centered",
      customShapeAssetId: null,
    });
    expect(
      apply(core, { type: "registration/update", patch: { weight: Number.NaN } }).registration.weight,
    ).toBe(2);
  });
});

describe("project reducer: guides, grid, snapping, output, units", () => {
  it("adds, moves, removes, and clears guides", () => {
    const { core } = makeCore(0);
    let next = apply(core, { type: "guides/add", axis: "horizontal", offset: 100 });
    next = apply(next, { type: "guides/add", axis: "vertical", offset: 50 });
    expect(next.guides.horizontal).toEqual([100]);
    expect(next.guides.vertical).toEqual([50]);
    next = apply(next, { type: "guides/move", axis: "horizontal", index: 0, offset: 120 });
    expect(next.guides.horizontal).toEqual([120]);
    next = apply(next, { type: "guides/remove", axis: "vertical", index: 0 });
    expect(next.guides.vertical).toEqual([]);
    next = apply(next, { type: "guides/clear" });
    expect(next.guides.horizontal).toEqual([]);
  });

  it("locked guides reject add/move/remove/clear but allow unlock", () => {
    const { core } = makeCore(0);
    let next = apply(core, { type: "guides/add", axis: "horizontal", offset: 100 });
    next = apply(next, { type: "guides/set-locked", locked: true });
    expect(apply(next, { type: "guides/add", axis: "horizontal", offset: 10 })).toBe(next);
    expect(apply(next, { type: "guides/move", axis: "horizontal", index: 0, offset: 10 })).toBe(next);
    expect(apply(next, { type: "guides/remove", axis: "horizontal", index: 0 })).toBe(next);
    expect(apply(next, { type: "guides/clear" })).toBe(next);
    const unlocked = apply(next, { type: "guides/set-locked", locked: false });
    expect(unlocked.guides.locked).toBe(false);
  });

  it("updates grid, snapping, output defaults, and unit preference", () => {
    const { core } = makeCore(0);
    let next = apply(core, { type: "grid/update", patch: { visible: true, size: 60 } });
    expect(next.grid).toEqual({ visible: true, size: 60 });
    expect(apply(next, { type: "grid/update", patch: { size: -5 } }).grid.size).toBe(60);
    next = apply(next, { type: "snapping/update", patch: { toGrid: false } });
    expect(next.snapping.toGrid).toBe(false);
    expect(next.snapping.enabled).toBe(true);
    next = apply(next, {
      type: "output/update",
      patch: { polarity: "negative", pressMirror: true },
    });
    expect(next.output.polarity).toBe("negative");
    expect(next.output.pressMirror).toBe(true);
    next = apply(next, { type: "unit/set", unitPreference: "mm" });
    expect(next.unitPreference).toBe("mm");
  });
});

describe("project reducer: structural sharing", () => {
  it("keeps untouched branches referentially identical", () => {
    const { core, layers } = makeCore(2);
    const next = applyCommand(core, {
      type: "layer/rename",
      layerId: layers[0].id,
      name: "Renamed",
    });
    expect(next).not.toBe(core);
    expect(next.separation).toBe(core.separation);
    expect(next.guides).toBe(core.guides);
    expect(next.artboard).toBe(core.artboard);
    expect(next.registration).toBe(core.registration);
    expect(next.layers[1]).toBe(core.layers[1]);
    expect(next.layers[0].recipe).toBe(core.layers[0].recipe);
  });

  it("restores a snapshot core wholesale", () => {
    const { core } = makeCore(1);
    const other = createEmptyProjectCore({ widthPx: 1920, heightPx: 2400, presetId: "8x10" });
    const next = apply(core, { type: "snapshot/restore", core: other });
    expect(next).toBe(other);
  });
});
