import { describe, expect, it } from "vitest";
import type { LayerV1, ProjectCoreV1 } from "../../src/core/types";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import {
  estimateSingleShotPeakBytes,
  estimateStreamedPeakBytes,
  planRender,
} from "../../src/render/planner";
import {
  estimateDeliveredBytes,
  estimateSvgAssemblyPeakBytes,
  estimateSvgPlateBytes,
  estimateSvgPlateFragments,
  evaluate,
  invalidQuadReason,
  invalidTransformReason,
  SVG_ASSEMBLY_BYTES_PER_FRAGMENT,
  SVG_ASSEMBLY_BYTES_PER_UTF8_BYTE,
  SVG_ASSEMBLY_FIXED_BYTES,
  SVG_ENTRY_OVERHEAD_BYTES,
  vectorPlateEligibility,
  type AssetInfo,
} from "../../src/export/preflight";
import { planLayerModels } from "../../src/export/worker-render-service";
import {
  contributingLayers,
  contributingPlates,
  MAX_BUFFERED_PLATE_PACKAGE_BYTES,
  type ExportTarget,
} from "../../src/export/targets";

const ASSET_ID = "a".repeat(64);
const SHAPE_ID = "b".repeat(64);

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
      position: { x: 0, y: 0 },
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

function makeCore(overrides: Partial<ProjectCoreV1> = {}): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: 2400, heightPx: 3000, presetId: "custom", background: "white" },
    layers: [makeLayer()],
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
    ...overrides,
  };
}

function makeAssets(): AssetInfo[] {
  return [
    { sha256: ASSET_ID, kind: "raster", ok: true, width: 1200, height: 900, byteLength: 4096 },
    { sha256: SHAPE_ID, kind: "svg", ok: true, width: 32, height: 32, byteLength: 512 },
  ];
}

const composite: ExportTarget = { kind: "composite", format: "png" };
const platePng: ExportTarget = { kind: "plate-package", format: "png" };
const plateSvg: ExportTarget = { kind: "plate-package", format: "svg" };

function codes(core: ProjectCoreV1, target: ExportTarget, assets = makeAssets()) {
  return evaluate(core, assets, target).map(({ code, severity }) => ({ code, severity }));
}

function hasBlock(core: ProjectCoreV1, target: ExportTarget, code: string, assets = makeAssets()) {
  return codes(core, target, assets).some(
    (issue) => issue.code === code && issue.severity === "block",
  );
}

function hasWarn(core: ProjectCoreV1, target: ExportTarget, code: string) {
  return codes(core, target).some((issue) => issue.code === code && issue.severity === "warn");
}

describe("preflight: clean project", () => {
  it("produces no issues for a valid single-layer project", () => {
    expect(evaluate(makeCore(), makeAssets(), composite)).toEqual([]);
    const capabilities = { offscreenCanvas: true, fileSystemAccess: true };
    expect(evaluate(makeCore(), makeAssets(), platePng, { capabilities })).toEqual([]);
    expect(evaluate(makeCore(), makeAssets(), plateSvg, { capabilities })).toEqual([]);
  });

  it("binds every issue to the supplied revision", () => {
    const core = makeCore({ output: { ...makeCore().output, polarity: "negative" } });
    const issues = evaluate(core, makeAssets(), composite, { revision: 7 });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.revision === 7)).toBe(true);
  });
});

describe("preflight blocks: assets", () => {
  it("blocks a missing layer asset", () => {
    expect(hasBlock(makeCore(), composite, "asset-missing", [])).toBe(true);
  });

  it("blocks a corrupt asset", () => {
    const assets = makeAssets();
    assets[0] = { ...assets[0], ok: false };
    expect(hasBlock(makeCore(), composite, "asset-corrupt", assets)).toBe(true);
  });

  it("blocks an unsafe SVG asset", () => {
    const assets = makeAssets();
    assets[0] = { ...assets[0], kind: "svg", unsafeSvg: true };
    expect(hasBlock(makeCore(), composite, "svg-unsafe", assets)).toBe(true);
  });

  it("blocks a custom dot shape with no shape asset", () => {
    const layer = makeLayer();
    layer.recipe.halftone.dotShape = "custom";
    layer.recipe.halftone.customShapeAssetId = null;
    expect(hasBlock(makeCore({ layers: [layer] }), composite, "asset-missing")).toBe(true);
  });

  it("accepts a custom dot shape whose asset resolves", () => {
    const layer = makeLayer();
    layer.recipe.halftone.dotShape = "custom";
    layer.recipe.halftone.customShapeAssetId = SHAPE_ID;
    expect(evaluate(makeCore({ layers: [layer] }), makeAssets(), composite)).toEqual([]);
  });

  it("keeps missing artwork and missing custom-dot issues distinct for the same layer", () => {
    const layer = makeLayer();
    layer.recipe.halftone.dotShape = "custom";
    layer.recipe.halftone.customShapeAssetId = SHAPE_ID;
    const issues = evaluate(makeCore({ layers: [layer] }), [], composite).filter(issue => issue.code === "asset-missing");
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map(issue => issue.id)).size).toBe(2);
  });

  it("blocks a missing registration mark asset when registration is on", () => {
    const core = makeCore();
    core.registration.customShapeAssetId = "c".repeat(64);
    expect(hasBlock(core, platePng, "asset-missing")).toBe(true);
    // Composite defaults registration off, so the mark is not required.
    expect(hasBlock(core, composite, "asset-missing")).toBe(false);
  });

  it("ignores assets of hidden layers but still warns about them", () => {
    const hidden = makeLayer({ id: "layer-2", name: "Hidden", assetId: "d".repeat(64), visible: false });
    const core = makeCore({ layers: [makeLayer(), hidden] });
    const issues = evaluate(core, makeAssets(), composite);
    expect(issues.some(({ code }) => code === "asset-missing")).toBe(false);
    expect(issues.some(({ code, severity }) => code === "layer-hidden-excluded" && severity === "warn")).toBe(true);
  });
});

describe("preflight blocks: geometry", () => {
  it("validates transforms", () => {
    expect(invalidTransformReason(makeLayer().transform)).toBeNull();
    const nan = makeLayer().transform;
    nan.position = { x: Number.NaN, y: 0 };
    expect(invalidTransformReason(nan)).not.toBeNull();
    const zero = makeLayer().transform;
    zero.scale = { x: 0, y: 1 };
    expect(invalidTransformReason(zero)).not.toBeNull();
  });

  it("blocks invalid transforms", () => {
    const layer = makeLayer();
    layer.transform.rotation = Number.POSITIVE_INFINITY;
    expect(hasBlock(makeCore({ layers: [layer] }), composite, "transform-invalid")).toBe(true);
  });

  it("validates perspective quads", () => {
    expect(invalidQuadReason(null)).toBeNull();
    const valid: NonNullable<LayerV1["transform"]["perspective"]> = [
      { x: 0, y: 0 },
      { x: 100, y: 10 },
      { x: 110, y: 120 },
      { x: -5, y: 100 },
    ];
    expect(invalidQuadReason(valid)).toBeNull();
    // Concave: one corner pushed inside the hull.
    expect(
      invalidQuadReason([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 100 },
      ]),
    ).toMatch(/concave|self-intersecting/);
    // Self-intersecting bowtie.
    expect(
      invalidQuadReason([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
      ]),
    ).toMatch(/concave|self-intersecting/);
    // Collinear corners.
    expect(
      invalidQuadReason([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ]),
    ).toMatch(/collinear/);
    // Nonfinite corner.
    expect(
      invalidQuadReason([
        { x: Number.NaN, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ]),
    ).toMatch(/finite/);
    // Near-zero area.
    expect(
      invalidQuadReason([
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 0, y: 0.5 },
      ]),
    ).toMatch(/near-zero area/);
  });

  it("blocks invalid quads", () => {
    const layer = makeLayer();
    layer.transform.perspective = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 100 },
    ];
    expect(hasBlock(makeCore({ layers: [layer] }), composite, "quad-invalid")).toBe(true);
  });
});

describe("preflight blocks: impossible output", () => {
  it("blocks a zero-area artboard", () => {
    const core = makeCore();
    core.artboard.widthPx = 0;
    expect(hasBlock(core, composite, "artboard-empty")).toBe(true);
  });

  it("blocks an artboard beyond the pixel policy", () => {
    const core = makeCore();
    core.artboard.widthPx = 6000;
    core.artboard.heightPx = 4000;
    expect(hasBlock(core, composite, "artboard-pixels-exceeded")).toBe(true);
  });

  it("blocks a 32769px edge from metadata alone even when total pixels are small", () => {
    const core = makeCore({
      artboard: {
        ...makeCore().artboard,
        widthPx: RESOURCE_POLICY.maxArtboardEdge + 1,
        heightPx: 16,
      },
    });
    expect(core.artboard.widthPx * core.artboard.heightPx).toBeLessThan(
      RESOURCE_POLICY.maxArtboardPixels,
    );
    expect(hasBlock(core, composite, "artboard-edge-exceeded")).toBe(true);
  });

  it("blocks when every layer is hidden", () => {
    const core = makeCore({ layers: [makeLayer({ visible: false })] });
    expect(hasBlock(core, composite, "no-printable-layers")).toBe(true);
  });

  it("blocks when the project has no layers", () => {
    expect(hasBlock(makeCore({ layers: [] }), composite, "no-printable-layers")).toBe(true);
  });

  it("blocks a plate package with zero visible plates", () => {
    const core = makeCore();
    core.separation.visible = { cyan: false, magenta: false, yellow: false, black: false };
    expect(hasBlock(core, platePng, "no-visible-plates")).toBe(true);
    // Composite does not require plates to exist.
    expect(hasBlock(core, composite, "no-visible-plates")).toBe(false);
  });

  it("blocks a selected-layer export whose layer is gone", () => {
    const target: ExportTarget = { kind: "selected-layer", format: "png", layerId: "missing" };
    expect(hasBlock(makeCore(), target, "layer-not-found")).toBe(true);
  });
});

describe("preflight blocks: resource estimates", () => {
  it("blocks vector packages beyond the grid point cap", () => {
    const layer = makeLayer();
    layer.recipe.halftone.cellSize = 0.5;
    expect(hasBlock(makeCore({ layers: [layer] }), plateSvg, "grid-points-exceeded")).toBe(true);
    // WAVE G2: extreme density now blocks RASTER targets too — dense
    // raster jobs allocate the same placement structures, so the raster
    // grid gate (MAX_RASTER_GRID_POINTS, memory-sized) applies.
    expect(hasBlock(makeCore({ layers: [layer] }), platePng, "grid-points-exceeded")).toBe(true);
    // A density between the vector cap (2M) and the raster cap (4M)
    // still shows the split: vector blocks, raster passes.
    const moderate = makeLayer();
    moderate.recipe.halftone.cellSize = 2;
    expect(hasBlock(makeCore({ layers: [moderate] }), plateSvg, "grid-points-exceeded")).toBe(true);
    expect(hasBlock(makeCore({ layers: [moderate] }), platePng, "grid-points-exceeded")).toBe(false);
  });

  it("blocks diffusion work beyond the raster cap", () => {
    const layer = makeLayer();
    layer.recipe.mode = "diffusion";
    const core = makeCore({ layers: [layer] });
    core.artboard.widthPx = 4500;
    core.artboard.heightPx = 4400; // 19.8MP * 4 plates = 79.2M plate-pixels
    expect(hasBlock(core, platePng, "diffusion-raster-exceeded")).toBe(true);
  });

  it("blocks render peaks beyond the policy budget", () => {
    const policy = { ...RESOURCE_POLICY, maxRenderPeakBytes: 1024 };
    const issues = evaluate(makeCore(), makeAssets(), composite, { policy });
    expect(issues.some(({ code }) => code === "render-peak-exceeded")).toBe(true);
  });

  it("blocks plate packages beyond archive limits", () => {
    const tightEntries = { ...RESOURCE_POLICY, maxArchiveEntries: 2 };
    expect(
      evaluate(makeCore(), makeAssets(), platePng, { policy: tightEntries }).some(
        ({ code }) => code === "archive-entries-exceeded",
      ),
    ).toBe(true);
    const tightBytes = { ...RESOURCE_POLICY, maxArchiveUncompressedBytes: 1024 };
    expect(
      evaluate(makeCore(), makeAssets(), platePng, { policy: tightBytes }).some(
        ({ code }) => code === "archive-bytes-exceeded",
      ),
    ).toBe(true);
  });
});

describe("preflight: vector eligibility", () => {
  it("marks clean layers ineligible and halftone/diffusion eligible", () => {
    expect(vectorPlateEligibility(makeCore()).eligible).toBe(true);
    const diffusionLayer = makeLayer();
    diffusionLayer.recipe.mode = "diffusion";
    expect(vectorPlateEligibility(makeCore({ layers: [diffusionLayer] })).eligible).toBe(true);
    const cleanLayer = makeLayer();
    cleanLayer.recipe.mode = "clean";
    const result = vectorPlateEligibility(makeCore({ layers: [cleanLayer] }));
    expect(result.eligible).toBe(false);
    expect(result.ineligibleLayers[0].layerId).toBe("layer-1");
    expect(result.ineligibleLayers[0].reason).toMatch(/continuous-tone/);
  });

  it("ignores hidden clean layers", () => {
    const cleanLayer = makeLayer({ id: "layer-2", visible: false });
    cleanLayer.recipe.mode = "clean";
    const core = makeCore({ layers: [makeLayer(), cleanLayer] });
    expect(vectorPlateEligibility(core).eligible).toBe(true);
  });

  it("blocks SVG plate packages with a clean layer but allows raster", () => {
    const cleanLayer = makeLayer();
    cleanLayer.recipe.mode = "clean";
    const core = makeCore({ layers: [cleanLayer] });
    expect(hasBlock(core, plateSvg, "vector-ineligible")).toBe(true);
    expect(hasBlock(core, platePng, "vector-ineligible")).toBe(false);
  });
});

describe("preflight warnings", () => {
  it("warns on unusual screen angles", () => {
    const core = makeCore();
    core.separation.angles.cyan = 20;
    expect(hasWarn(core, composite, "angle-unusual")).toBe(true);
  });

  it("warns when two visible plates share an angle lattice", () => {
    const core = makeCore();
    core.separation.angles.magenta = 15;
    expect(hasWarn(core, composite, "angle-duplicate")).toBe(true);
  });

  it("does not warn about hidden plates' angles", () => {
    const core = makeCore();
    core.separation.angles.magenta = 15;
    core.separation.visible.magenta = false;
    expect(hasWarn(core, composite, "angle-duplicate")).toBe(false);
  });

  it("warns on negative polarity", () => {
    const core = makeCore();
    core.output.polarity = "negative";
    expect(hasWarn(core, composite, "polarity-negative")).toBe(true);
  });

  it("warns about hidden plates excluded from a package", () => {
    const core = makeCore();
    core.separation.visible.yellow = false;
    expect(hasWarn(core, platePng, "plate-hidden-excluded")).toBe(true);
    expect(hasWarn(core, composite, "plate-hidden-excluded")).toBe(false);
  });

  it("warns when registration is off for a plate package", () => {
    const core = makeCore();
    expect(hasWarn(core, { ...platePng, registration: false }, "registration-off-plates")).toBe(true);
    expect(hasWarn(core, platePng, "registration-off-plates")).toBe(false);
  });

  it("warns when registration is on for a composite", () => {
    const core = makeCore();
    expect(hasWarn(core, { ...composite, registration: true }, "registration-on-composite")).toBe(true);
    expect(hasWarn(core, composite, "registration-on-composite")).toBe(false);
  });

  it("warns when a selected layer is hidden", () => {
    const core = makeCore({ layers: [makeLayer({ visible: false })] });
    const target: ExportTarget = { kind: "selected-layer", format: "png", layerId: "layer-1" };
    expect(hasWarn(core, target, "selected-layer-hidden")).toBe(true);
  });

  it("warns when the artboard is smaller than its named preset", () => {
    const core = makeCore();
    core.artboard.presetId = "letter";
    core.artboard.widthPx = 1000;
    core.artboard.heightPx = 1000;
    expect(hasWarn(core, composite, "artboard-below-preset")).toBe(true);
  });

  it("accepts a preset artboard in either orientation", () => {
    const core = makeCore();
    core.artboard.presetId = "letter";
    core.artboard.widthPx = 2640;
    core.artboard.heightPx = 2040;
    expect(hasWarn(core, composite, "artboard-below-preset")).toBe(false);
  });

  it("warns about partial opacity on printing layers", () => {
    const core = makeCore({ layers: [makeLayer({ opacity: 0.5 })] });
    expect(hasWarn(core, composite, "opacity-below-one")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Render-binding additions: planner peak, streaming, vector, delivery */
/* ------------------------------------------------------------------ */

describe("preflight: planner-modeled peak and streaming limits", () => {
  it("uses the 32 MiB plate-package boundary and rejects an over-cap package without FSA", () => {
    const core = makeCore({
      artboard: { ...makeCore().artboard, widthPx: 1500, heightPx: 1500 },
    });
    const estimatedBytes = estimateDeliveredBytes(core, platePng);
    expect(estimatedBytes).toBeGreaterThan(MAX_BUFFERED_PLATE_PACKAGE_BYTES);
    expect(estimatedBytes).toBeLessThan(RESOURCE_POLICY.maxBlobDownloadBytes);

    const withoutFsa = evaluate(core, makeAssets(), platePng, {
      capabilities: { offscreenCanvas: true, fileSystemAccess: false },
    });
    expect(withoutFsa).toContainEqual(
      expect.objectContaining({ code: "delivery-exceeded", severity: "block" }),
    );

    const withFsa = evaluate(core, makeAssets(), platePng, {
      capabilities: { offscreenCanvas: true, fileSystemAccess: true },
    });
    expect(withFsa.some(({ code }) => code === "delivery-exceeded")).toBe(false);
  });

  it("streams an over-32 MiB SVG package without requiring OffscreenCanvas", () => {
    const layer = makeLayer();
    layer.recipe.halftone.cellSize = 8;
    const core = makeCore({ layers: [layer] });
    expect(estimateDeliveredBytes(core, plateSvg)).toBeGreaterThan(
      MAX_BUFFERED_PLATE_PACKAGE_BYTES,
    );

    const issues = evaluate(core, makeAssets(), plateSvg, {
      capabilities: { offscreenCanvas: false, fileSystemAccess: true },
    });
    expect(issues.some(({ code }) => code === "streaming-unsupported")).toBe(false);
    expect(issues.some(({ code }) => code === "delivery-exceeded")).toBe(false);
  });

  it("models SVG fragment/string residency and admits the exact peak boundary", () => {
    expect(estimateSvgAssemblyPeakBytes(1_234, 56)).toBe(
      1_234 * SVG_ASSEMBLY_BYTES_PER_UTF8_BYTE +
        56 * SVG_ASSEMBLY_BYTES_PER_FRAGMENT +
        SVG_ASSEMBLY_FIXED_BYTES,
    );

    const layer = makeLayer();
    layer.recipe.halftone.cellSize = 8;
    const core = makeCore({ layers: [layer] });
    const layers = contributingLayers(core, plateSvg);
    const plates = contributingPlates(core.separation);
    const pixels = core.artboard.widthPx * core.artboard.heightPx;
    const asset = makeAssets()[0];
    const models = planLayerModels(core, layers, (assetId) =>
      assetId === asset.sha256
        ? { width: asset.width, height: asset.height, byteLength: asset.byteLength }
        : null,
    );
    const renderPeak = Math.max(
      ...models.map(
        (model) =>
          planRender(
            {
              sampleWidth: core.artboard.widthPx,
              sampleHeight: core.artboard.heightPx,
              outputWidth: core.artboard.widthPx,
              outputHeight: core.artboard.heightPx,
              plateCount: 1,
              layerCount: 1,
              wantsProof: false,
              layers: [model],
            },
            RESOURCE_POLICY.maxRenderPeakBytes,
          ).singleShotPeakBytes,
      ),
    );
    const assemblyPeak = Math.max(
      ...plates.map((plate) =>
        estimateSvgAssemblyPeakBytes(
          estimateSvgPlateBytes(core, layers, plate) + SVG_ENTRY_OVERHEAD_BYTES,
          estimateSvgPlateFragments(core, layers, plate),
        ),
      ),
    );
    const exactPeak = renderPeak + assemblyPeak;
    const capabilities = { offscreenCanvas: false, fileSystemAccess: true };
    const atBoundary = evaluate(core, makeAssets(), plateSvg, {
      capabilities,
      policy: { ...RESOURCE_POLICY, maxRenderPeakBytes: exactPeak },
    });
    expect(atBoundary.some(({ code }) => code === "render-peak-exceeded")).toBe(false);

    const belowBoundary = evaluate(core, makeAssets(), plateSvg, {
      capabilities,
      policy: { ...RESOURCE_POLICY, maxRenderPeakBytes: exactPeak - 1 },
    });
    expect(belowBoundary).toContainEqual(
      expect.objectContaining({ code: "render-peak-exceeded", severity: "block" }),
    );
  });

  it("uses the planner's per-form model: streamed-capable jobs pass budgets the single-shot form busts", () => {
    const core = makeCore();
    const input = {
      sampleWidth: core.artboard.widthPx,
      sampleHeight: core.artboard.heightPx,
      outputWidth: core.artboard.widthPx,
      outputHeight: core.artboard.heightPx,
      plateCount: 4,
      layerCount: 1,
    };
    const singleShot = estimateSingleShotPeakBytes(input);
    const streamed = estimateStreamedPeakBytes(input);
    expect(streamed).toBeLessThan(singleShot);
    const between = Math.floor((streamed + singleShot) / 2);
    // The old 24-bytes-per-pixel heuristic would also pass here; the point
    // is the planner keeps the job runnable via the streamed form while a
    // budget below the streamed floor still hard-blocks.
    const policy = { ...RESOURCE_POLICY, maxRenderPeakBytes: between };
    const capabilities = { offscreenCanvas: true, fileSystemAccess: true };
    expect(
      evaluate(core, makeAssets(), composite, { policy, capabilities }).some(
        ({ code }) => code === "render-peak-exceeded",
      ),
    ).toBe(false);
    const tiny = { ...RESOURCE_POLICY, maxRenderPeakBytes: Math.floor(streamed / 2) };
    expect(
      evaluate(core, makeAssets(), composite, { policy: tiny, capabilities }).some(
        ({ code }) => code === "render-peak-exceeded",
      ),
    ).toBe(true);
  });

  it("blocks streamed halftone exports without OffscreenCanvas, allows diffusion", () => {
    const core = makeCore();
    const input = {
      sampleWidth: core.artboard.widthPx,
      sampleHeight: core.artboard.heightPx,
      outputWidth: core.artboard.widthPx,
      outputHeight: core.artboard.heightPx,
      plateCount: 4,
      layerCount: 1,
    };
    const between = Math.floor(
      (estimateStreamedPeakBytes(input) + estimateSingleShotPeakBytes(input)) / 2,
    );
    const policy = { ...RESOURCE_POLICY, maxRenderPeakBytes: between };
    const without = { offscreenCanvas: false, fileSystemAccess: true };
    expect(
      evaluate(core, makeAssets(), composite, { policy, capabilities: without }).some(
        ({ code }) => code === "streaming-unsupported",
      ),
    ).toBe(true);
    // With OffscreenCanvas the same plan is fine.
    expect(
      evaluate(core, makeAssets(), composite, {
        policy,
        capabilities: { offscreenCanvas: true, fileSystemAccess: true },
      }).some(({ code }) => code === "streaming-unsupported"),
    ).toBe(false);
    // Diffusion/clean stacks stream without OffscreenCanvas.
    const diffusionLayer = makeLayer();
    diffusionLayer.recipe.mode = "diffusion";
    expect(
      evaluate(makeCore({ layers: [diffusionLayer] }), makeAssets(), composite, {
        policy,
        capabilities: without,
      }).some(({ code }) => code === "streaming-unsupported"),
    ).toBe(false);
    // Single-shot-affordable jobs never trip the rule.
    expect(
      evaluate(core, makeAssets(), composite, { capabilities: without }).some(
        ({ code }) => code === "streaming-unsupported",
      ),
    ).toBe(false);
  });

  it("blocks TIFFs that neither delivery path can carry", () => {
    const core = makeCore();
    const tiff: ExportTarget = { kind: "composite", format: "tiff" };
    const policy = { ...RESOURCE_POLICY, maxBlobDownloadBytes: 1024 };
    expect(
      evaluate(core, makeAssets(), tiff, {
        policy,
        capabilities: { offscreenCanvas: true, fileSystemAccess: false },
      }).some(({ code }) => code === "delivery-exceeded"),
    ).toBe(true);
    // File System Access streams it fine.
    expect(
      evaluate(core, makeAssets(), tiff, {
        policy,
        capabilities: { offscreenCanvas: true, fileSystemAccess: true },
      }).some(({ code }) => code === "delivery-exceeded"),
    ).toBe(false);
    // WAVE G2 BOUNDARY MOVE (documented): delivery is planned on the
    // conservative raw-byte contract for EVERY format — a compressed PNG
    // might have fit under the cap, but without File System Access an
    // over-estimate hard-blocks BEFORE render rather than gambling on
    // compression. (Previously compressed formats were never blocked.)
    expect(
      evaluate(core, makeAssets(), composite, {
        policy,
        capabilities: { offscreenCanvas: true, fileSystemAccess: false },
      }).some(({ code }) => code === "delivery-exceeded"),
    ).toBe(true);
    // With File System Access the PNG streams chunk-wise instead.
    expect(
      evaluate(core, makeAssets(), composite, {
        policy,
        capabilities: { offscreenCanvas: true, fileSystemAccess: true },
      }).some(({ code }) => code === "delivery-exceeded"),
    ).toBe(false);
  });
});

describe("preflight: vector polarity and knockout rules", () => {
  it("blocks negative-polarity vector packages, raster plates unaffected", () => {
    const core = makeCore();
    core.output.polarity = "negative";
    expect(hasBlock(core, plateSvg, "polarity-vector-unsupported")).toBe(true);
    expect(hasBlock(core, platePng, "polarity-vector-unsupported")).toBe(false);
  });

  it("blocks overlapping multi-layer vector packages, allows separated layers", () => {
    const makeAt = (id: string, x: number, y: number) => {
      const layer = makeLayer({ id });
      layer.transform = { ...layer.transform, position: { x, y } };
      return layer;
    };
    // Asset is 1200x900 (makeAssets); bounds are centered on position.
    const overlapping = makeCore({
      layers: [makeAt("layer-1", 600, 450), makeAt("layer-2", 700, 500)],
    });
    expect(hasBlock(overlapping, plateSvg, "vector-knockout-unsupported")).toBe(true);
    expect(hasBlock(overlapping, platePng, "vector-knockout-unsupported")).toBe(false);
    const separated = makeCore({
      layers: [makeAt("layer-1", 600, 450), makeAt("layer-2", 1810, 2400)],
    });
    expect(hasBlock(separated, plateSvg, "vector-knockout-unsupported")).toBe(false);
  });

  it("marks diffusion layers vector-ineligible only in multi-layer stacks", () => {
    const diffusionLayer = makeLayer({ id: "layer-2" });
    diffusionLayer.recipe.mode = "diffusion";
    diffusionLayer.transform = { ...diffusionLayer.transform, position: { x: 1810, y: 2400 } };
    const multi = makeCore({ layers: [makeLayer(), diffusionLayer] });
    expect(vectorPlateEligibility(multi).eligible).toBe(false);
    expect(hasBlock(multi, plateSvg, "vector-ineligible")).toBe(true);
    const solo = makeCore({ layers: [diffusionLayer] });
    expect(vectorPlateEligibility(solo).eligible).toBe(true);
  });
});
