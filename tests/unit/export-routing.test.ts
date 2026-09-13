/**
 * Legacy-vs-worker render routing (src/export/current-engine.ts):
 * legacyEngineEligible is true ONLY for the exact legacy single-layer shape
 * — one visible halftone/diffusion layer, uncropped, identity transform
 * anchored at the artboard center, with KNOWN asset dimensions that either
 * equal the artboard (full-artboard) or differ from it while the artboard
 * is an exact legacy sheet (the legacy document path placed natural-size
 * sources on the sheet natively) — and createRoutedRenderService applies
 * it per request.
 */
import { describe, expect, it } from "vitest";
import type { LayerV1, ProjectCoreV1 } from "../../src/core/types";
import {
  createRoutedRenderService,
  legacyEngineEligible,
  type AssetDimensionLookup,
} from "../../src/export/current-engine";
import type { RasterData, RenderService } from "../../src/export/orchestrator";

const ASSET_ID = "a".repeat(64);
const WIDTH = 240;
const HEIGHT = 300;

function makeLayer(overrides: Partial<LayerV1> = {}): LayerV1 {
  return {
    id: "layer-1",
    name: "Artwork",
    assetId: ASSET_ID,
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: {
      position: { x: WIDTH / 2, y: HEIGHT / 2 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      flipH: false,
      flipV: false,
      skew: { x: 0, y: 0 },
      perspective: null,
    },
    recipe: {
      mode: "halftone",
      halftone: {
        cellSize: 12,
        dotShape: "round",
        customShapeAssetId: null,
        invert: false,
        strokeWidth: 1,
        frayedXEdge: 0,
        frayedYEdge: 0,
      },
      diffusion: {
        algorithm: "floyd-steinberg",
        modulation: "none",
        modStrength: 0.5,
        intensity: 0.5,
        levels: 8,
        sharpenStrength: 0,
        sharpenRadius: 1,
        denoise: 0,
        brokenKernel: 0,
        directionalBias: 0,
        directionalBiasAngle: 0,
        errorOverflow: 0,
        reset: 0,
        crossChannelBleed: 0,
        invert: false,
      },
      glitch: {
        enabled: false,
        sliceShift: 0,
        sliceSize: 20,
        verticalSliceShift: 0,
        verticalSliceSize: 20,
        gridWarp: 0,
        warpScale: 100,
        smearDrag: 0,
        smearLength: 24,
        smearVertical: false,
        macroblockCorrupt: 0,
        macroblockDropout: 0.25,
        blockShift: 0,
        blockShiftSize: 16,
        channelDesync: 0,
        bitmapSort: 0,
        bitmapSortVertical: false,
      },
    },
    ...overrides,
  };
}

/* The 11x15 legacy sheet at 240 DPI — the sample E2E artboard. */
const SHEET_WIDTH = 2640;
const SHEET_HEIGHT = 3600;

/** A centered-identity layer for a widthPx x heightPx artboard. */
function makeCenteredLayer(
  widthPx: number,
  heightPx: number,
  overrides: Partial<LayerV1> = {},
): LayerV1 {
  const layer = makeLayer(overrides);
  layer.transform = {
    ...layer.transform,
    position: { x: widthPx / 2, y: heightPx / 2 },
    ...(overrides.transform ?? {}),
  };
  return layer;
}

/** A core on an exact legacy sheet artboard (11x15 portrait by default). */
function makeSheetCore(
  layers?: LayerV1[],
  artboard: { widthPx: number; heightPx: number; presetId: string } = {
    widthPx: SHEET_WIDTH,
    heightPx: SHEET_HEIGHT,
    presetId: "11x15",
  },
): ProjectCoreV1 {
  const core = makeCore(layers ?? [makeCenteredLayer(artboard.widthPx, artboard.heightPx)]);
  core.artboard = { ...artboard, background: "white" };
  return core;
}

function makeCore(layers: LayerV1[] = [makeLayer()]): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: WIDTH, heightPx: HEIGHT, presetId: "custom", background: "white" },
    layers,
    separation: {
      mode: "cmyk",
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
    },
    registration: { size: null, offset: null, weight: 1, mode: "corners", customShapeAssetId: null },
    guides: { horizontal: [], vertical: [], locked: false, visible: true },
    grid: { visible: false, size: 24 },
    snapping: { enabled: true, toGuides: true, toGrid: false, toLayers: true, toArtboard: true },
    output: {
      polarity: "positive",
      pressMirror: false,
      registrationOnPlates: true,
      registrationOnComposite: false,
    },
    unitPreference: "px",
  };
}

const fullArtboardDims: AssetDimensionLookup = () => ({ width: WIDTH, height: HEIGHT });

describe("legacyEngineEligible", () => {
  it("accepts the exact legacy shape (halftone and diffusion)", () => {
    expect(legacyEngineEligible(makeCore(), fullArtboardDims)).toBe(true);
    const diffusion = makeLayer();
    diffusion.recipe.mode = "diffusion";
    expect(legacyEngineEligible(makeCore([diffusion]), fullArtboardDims)).toBe(true);
  });

  it("rejects everything outside the legacy shape", () => {
    const eligible = () => makeLayer();

    // Multi-layer.
    expect(
      legacyEngineEligible(makeCore([eligible(), makeLayer({ id: "layer-2" })]), fullArtboardDims),
    ).toBe(false);
    // Zero layers.
    expect(legacyEngineEligible(makeCore([]), fullArtboardDims)).toBe(false);
    // Hidden.
    expect(legacyEngineEligible(makeCore([makeLayer({ visible: false })]), fullArtboardDims)).toBe(false);
    // Clean mode.
    const clean = eligible();
    clean.recipe.mode = "clean";
    expect(legacyEngineEligible(makeCore([clean]), fullArtboardDims)).toBe(false);
    // Crop.
    expect(
      legacyEngineEligible(
        makeCore([makeLayer({ crop: { x: 0, y: 0, width: 10, height: 10 } })]),
        fullArtboardDims,
      ),
    ).toBe(false);
    // Off-center, scaled, rotated, flipped, skewed, perspective.
    const transforms: Partial<LayerV1["transform"]>[] = [
      { position: { x: 0, y: 0 } },
      { scale: { x: 2, y: 2 } },
      { rotation: 10 },
      { flipH: true },
      { skew: { x: 5, y: 0 } },
      {
        perspective: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
    ];
    for (const partial of transforms) {
      const layer = eligible();
      layer.transform = { ...layer.transform, ...partial };
      expect(legacyEngineEligible(makeCore([layer]), fullArtboardDims), JSON.stringify(partial)).toBe(false);
    }
    // Asset dimensions unknown.
    expect(legacyEngineEligible(makeCore(), () => null)).toBe(false);
    expect(legacyEngineEligible(makeCore(), undefined)).toBe(false);
    // Dimensions differing from an artboard that is NOT an exact legacy
    // sheet (240x300 maps to no preset): document placement cannot
    // reproduce the output size, so the worker renders.
    expect(legacyEngineEligible(makeCore(), () => ({ width: 100, height: 100 }))).toBe(false);
  });

  it("accepts centered-identity sources whose dimensions differ from a sheet artboard", () => {
    // The sample E2E shape: 1200x900 demo artwork on the 2640x3600 (11x15
    // portrait) artboard — legacy document placement handled this natively.
    const sample = () => ({ width: 1200, height: 900 });
    expect(legacyEngineEligible(makeSheetCore(), sample)).toBe(true);
    // Any other differing dimensions on the same sheet.
    expect(legacyEngineEligible(makeSheetCore(), () => ({ width: 501, height: 4213 }))).toBe(true);
    // Diffusion mode is legacy-representable too.
    const diffusion = makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT);
    diffusion.recipe.mode = "diffusion";
    expect(legacyEngineEligible(makeSheetCore([diffusion]), sample)).toBe(true);
    // Landscape sheet artboard (11x15 rotated).
    const landscape = makeSheetCore([makeCenteredLayer(SHEET_HEIGHT, SHEET_WIDTH)], {
      widthPx: SHEET_HEIGHT,
      heightPx: SHEET_WIDTH,
      presetId: "11x15",
    });
    expect(legacyEngineEligible(landscape, sample)).toBe(true);
    // Sheet resolved by exact pixel dimensions when the preset id is custom.
    const byDims = makeSheetCore([makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT)], {
      widthPx: SHEET_WIDTH,
      heightPx: SHEET_HEIGHT,
      presetId: "custom",
    });
    expect(legacyEngineEligible(byDims, sample)).toBe(true);
    // Full-artboard sources remain eligible on the sheet as before.
    expect(
      legacyEngineEligible(makeSheetCore(), () => ({ width: SHEET_WIDTH, height: SHEET_HEIGHT })),
    ).toBe(true);
  });

  it("still rejects non-legacy shapes when source dimensions differ from the sheet", () => {
    const sample = () => ({ width: 1200, height: 900 });

    // Unknown dimensions.
    expect(legacyEngineEligible(makeSheetCore(), () => null)).toBe(false);
    // Multi-layer.
    expect(
      legacyEngineEligible(
        makeSheetCore([
          makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT),
          makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT, { id: "layer-2" }),
        ]),
        sample,
      ),
    ).toBe(false);
    // Hidden.
    expect(
      legacyEngineEligible(
        makeSheetCore([makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT, { visible: false })]),
        sample,
      ),
    ).toBe(false);
    // Clean mode.
    const clean = makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT);
    clean.recipe.mode = "clean";
    expect(legacyEngineEligible(makeSheetCore([clean]), sample)).toBe(false);
    // Crop.
    expect(
      legacyEngineEligible(
        makeSheetCore([
          makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT, {
            crop: { x: 0, y: 0, width: 600, height: 450 },
          }),
        ]),
        sample,
      ),
    ).toBe(false);
    // Any non-identity transform.
    const transforms: Partial<LayerV1["transform"]>[] = [
      { position: { x: 10, y: 10 } },
      { scale: { x: 2, y: 2 } },
      { rotation: 10 },
      { flipH: true },
      { flipV: true },
      { skew: { x: 0, y: 5 } },
      {
        perspective: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
    ];
    for (const partial of transforms) {
      const layer = makeCenteredLayer(SHEET_WIDTH, SHEET_HEIGHT);
      layer.transform = { ...layer.transform, ...partial };
      expect(legacyEngineEligible(makeSheetCore([layer]), sample), JSON.stringify(partial)).toBe(
        false,
      );
    }
  });
});

describe("createRoutedRenderService", () => {
  const raster: RasterData = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

  function marker(name: string): { service: RenderService; calls: string[] } {
    const calls: string[] = [];
    const service: RenderService = {
      async renderComposite() {
        calls.push(`${name}:composite`);
        return raster;
      },
      async renderPlate(_core, plate) {
        calls.push(`${name}:plate:${plate}`);
        return raster;
      },
      async renderPlateSvg(_core, plate) {
        calls.push(`${name}:svg:${plate}`);
        return "<svg/>";
      },
      async renderLayer(_core, layerId) {
        calls.push(`${name}:layer:${layerId}`);
        return raster;
      },
    };
    return { service, calls };
  }

  function makeOptions() {
    return {
      revision: 1,
      registration: false,
      matte: null,
      signal: new AbortController().signal,
    };
  }

  it("routes eligible projects to the legacy engine, others to the worker", async () => {
    const legacy = marker("legacy");
    const worker = marker("worker");
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker: worker.service,
      assetDimensions: fullArtboardDims,
    });
    await routed.renderComposite(makeCore(), makeOptions());
    await routed.renderPlate(makeCore(), "cyan", makeOptions());
    await routed.renderPlateSvg(makeCore(), "black", makeOptions());
    expect(legacy.calls).toEqual(["legacy:composite", "legacy:plate:cyan", "legacy:svg:black"]);

    const multi = makeCore([makeLayer(), makeLayer({ id: "layer-2" })]);
    await routed.renderComposite(multi, makeOptions());
    expect(worker.calls).toEqual(["worker:composite"]);
  });

  it("selected-layer requests use legacy only for the single legacy layer itself", async () => {
    const legacy = marker("legacy");
    const worker = marker("worker");
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker: worker.service,
      assetDimensions: fullArtboardDims,
    });
    await routed.renderLayer(makeCore(), "layer-1", makeOptions());
    expect(legacy.calls).toEqual(["legacy:layer:layer-1"]);
    await routed.renderLayer(makeCore(), "layer-other", makeOptions());
    expect(worker.calls).toEqual(["worker:layer:layer-other"]);
  });

  it("routes unequal-dimension sources by whether the artboard is an exact sheet", async () => {
    const legacy = marker("legacy");
    const worker = marker("worker");
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker: worker.service,
      assetDimensions: () => ({ width: 1200, height: 900 }),
    });
    // Sheet artboard: legacy document placement is representable.
    await routed.renderComposite(makeSheetCore(), makeOptions());
    await routed.renderPlate(makeSheetCore(), "black", makeOptions());
    expect(legacy.calls).toEqual(["legacy:composite", "legacy:plate:black"]);
    // Non-sheet artboard (240x300): worker path.
    await routed.renderComposite(makeCore(), makeOptions());
    expect(worker.calls).toEqual(["worker:composite"]);
  });

  it("routes to the worker when asset dimensions are unavailable", async () => {
    const legacy = marker("legacy");
    const worker = marker("worker");
    const routed = createRoutedRenderService({ legacy: legacy.service, worker: worker.service });
    await routed.renderComposite(makeCore(), makeOptions());
    expect(legacy.calls).toEqual([]);
    expect(worker.calls).toEqual(["worker:composite"]);
  });
});
