import { describe, expect, it } from "vitest";
import { DOCUMENT_DPI } from "../../src/core/types";
import {
  createEmptyProject,
  createEmptyProjectCore,
  createLayerFromAsset,
  DEFAULT_ARTBOARD,
  defaultLayerRecipe,
} from "../../src/project/factory";

describe("createEmptyProject", () => {
  it("defaults to the studio's 11x15 portrait sheet at 240 DPI", () => {
    const project = createEmptyProject({ now: 5000 });
    expect(DOCUMENT_DPI).toBe(240);
    expect(project.core.artboard).toEqual({
      widthPx: 2640,
      heightPx: 3600,
      presetId: "11x15",
      background: "white",
    });
    expect(project.schema).toBe(1);
    expect(project.title).toBe("Untitled");
    expect(project.createdAt).toBe(5000);
    expect(project.updatedAt).toBe(5000);
    expect(project.savedRevision).toBe(0);
    expect(project.core.layers).toEqual([]);
    expect(project.snapshots).toEqual([]);
  });

  it("matches existing studio defaults for separation and registration", () => {
    const core = createEmptyProjectCore();
    expect(core.separation.mode).toBe("cmyk");
    expect(core.separation.angles).toEqual({ cyan: 15, magenta: 75, yellow: 0, black: 45 });
    expect(core.separation.visible).toEqual({
      cyan: true,
      magenta: true,
      yellow: true,
      black: true,
    });
    expect(core.registration).toEqual({
      size: 120,
      offset: 120,
      weight: 2,
      mode: "corners",
      customShapeAssetId: null,
    });
    expect(core.output).toEqual({
      polarity: "positive",
      pressMirror: false,
      registrationOnPlates: true,
      registrationOnComposite: false,
    });
    expect(core.unitPreference).toBe("px");
    expect(core.guides).toEqual({ horizontal: [], vertical: [], locked: false, visible: true });
    expect(core.snapping.enabled).toBe(true);
  });

  it("honors custom size options and rejects invalid artboards", () => {
    const project = createEmptyProject({
      widthPx: 1920,
      heightPx: 2400,
      presetId: "8x10",
      background: "transparent",
      title: "Custom",
    });
    expect(project.core.artboard).toEqual({
      widthPx: 1920,
      heightPx: 2400,
      presetId: "8x10",
      background: "transparent",
    });
    expect(() => createEmptyProject({ widthPx: 100.5, heightPx: 100 })).toThrow();
    expect(() => createEmptyProject({ widthPx: -1, heightPx: 100 })).toThrow();
    expect(() => createEmptyProject({ widthPx: 5000, heightPx: 5000 })).toThrow();
    expect(() => createEmptyProject({ widthPx: 32769, heightPx: 16 })).toThrow(
      /edge limit/,
    );
  });
});

describe("createLayerFromAsset", () => {
  it("starts clean with Glitch off, opacity 1, identity transform centered", () => {
    const layer = createLayerFromAsset(
      "a".repeat(64),
      "Imported art",
      { width: 800, height: 600 },
      DEFAULT_ARTBOARD,
    );
    expect(layer.name).toBe("Imported art");
    expect(layer.assetId).toBe("a".repeat(64));
    expect(layer.visible).toBe(true);
    expect(layer.locked).toBe(false);
    expect(layer.opacity).toBe(1);
    expect(layer.crop).toBeNull();
    expect(layer.transform).toEqual({
      position: { x: 1320, y: 1800 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      flipH: false,
      flipV: false,
      skew: { x: 0, y: 0 },
      perspective: null,
    });
    expect(layer.recipe.mode).toBe("clean");
    expect(layer.recipe.glitch.enabled).toBe(false);
  });

  it("matches the studio's default halftone/diffusion/glitch settings", () => {
    const recipe = defaultLayerRecipe();
    expect(recipe.halftone).toMatchObject({
      cellSize: 12,
      dotShape: "round",
      invert: false,
      strokeWidth: 1,
      frayedXEdge: 0,
      frayedYEdge: 0,
      customShapeAssetId: null,
    });
    expect(recipe.diffusion).toMatchObject({
      algorithm: "floyd-steinberg",
      modulation: "none",
      modStrength: 0.5,
      intensity: 0.5,
      levels: 8,
      sharpenRadius: 1,
    });
    expect(recipe.glitch).toMatchObject({
      enabled: false,
      sliceSize: 20,
      verticalSliceSize: 20,
      warpScale: 100,
      smearLength: 24,
      macroblockDropout: 0.25,
      blockShiftSize: 16,
    });
  });

  it("gives each layer a unique id and rejects invalid dimensions", () => {
    const a = createLayerFromAsset("a".repeat(64), "A", { width: 10, height: 10 }, DEFAULT_ARTBOARD);
    const b = createLayerFromAsset("a".repeat(64), "B", { width: 10, height: 10 }, DEFAULT_ARTBOARD);
    expect(a.id).not.toBe(b.id);
    expect(() =>
      createLayerFromAsset("a".repeat(64), "Bad", { width: 0, height: 10 }, DEFAULT_ARTBOARD),
    ).toThrow();
    expect(() =>
      createLayerFromAsset("a".repeat(64), "Bad", { width: Number.NaN, height: 10 }, DEFAULT_ARTBOARD),
    ).toThrow();
  });
});
