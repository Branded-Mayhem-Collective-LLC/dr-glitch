/**
 * Render planning: tile chunking, band sizing, draft-scale parity with the
 * engine's 1100px preview cap, and the PROCESS-WIDE peak model (worker
 * kernels + app-side collector/outputs) against the central resource policy.
 *
 * The exact-arithmetic cases mirror the planner formulas on purpose: any
 * model change must be justified here, next to the scenario it prices.
 * tests/unit/render-ledger.test.ts separately checks the MODEL against
 * OBSERVED allocation counters from real streamed runs.
 */
import { describe, expect, it } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import {
  chooseBandHeight,
  chunkTiles,
  COLLECTOR_FIELDS,
  draftScaleFor,
  estimateAppConcurrentBytes,
  estimateAppFinalizeBytes,
  estimateRenderPeakBytes,
  estimateSingleShotPeakBytes,
  estimateStreamedPeakBytes,
  isStreamable,
  kernelTransientFields,
  planRender,
  TILE_CANVAS_BYTES,
  type PlanLayerModel,
} from "../../src/render/planner";

/** One Float32 field / RGBA frame at the 15×22in 240dpi gate sheet. */
const FIELD = 3600 * 5280 * 4;
const GATE = {
  sampleWidth: 3600,
  sampleHeight: 5280,
  outputWidth: 3600,
  outputHeight: 5280,
  plateCount: 4,
  layerCount: 8,
};
/** planRender's band height for the gate sheet: floor(32MiB / (3600·4·2·4)). */
const GATE_BAND = 291;
const GATE_BAND_BYTES = (4 * GATE_BAND + 2) * 3600 * 4;

describe("draftScaleFor", () => {
  it("matches the engine preview cap min(1, 1100 / maxEdge)", () => {
    expect(draftScaleFor(2640, 3600)).toBe(Math.min(1, 1100 / 3600));
    expect(draftScaleFor(800, 600)).toBe(1);
    expect(draftScaleFor(1100, 1100)).toBe(1);
  });
});

describe("chunkTiles", () => {
  it("covers the region exactly once, honoring origin offsets", () => {
    const tiles = chunkTiles(100, 50, 32, -8, -8);
    let area = 0;
    for (const tile of tiles) {
      area += tile.width * tile.height;
      expect(tile.x).toBeGreaterThanOrEqual(-8);
      expect(tile.y).toBeGreaterThanOrEqual(-8);
      expect(tile.x + tile.width).toBeLessThanOrEqual(-8 + 100);
      expect(tile.y + tile.height).toBeLessThanOrEqual(-8 + 50);
    }
    expect(area).toBe(100 * 50);
  });

  it("emits row-major full-then-remainder tiles", () => {
    const tiles = chunkTiles(70, 40, 32);
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 32, height: 32 });
    expect(tiles[2]).toEqual({ x: 64, y: 0, width: 6, height: 32 });
    expect(tiles.at(-1)).toEqual({ x: 64, y: 32, width: 6, height: 8 });
  });
});

describe("chooseBandHeight", () => {
  it("keeps band plus carry window under the byte budget", () => {
    const width = 3600;
    const bandHeight = chooseBandHeight(width, 1024 * 1024);
    expect(bandHeight).toBeGreaterThan(0);
    expect((bandHeight + 2) * width * 4).toBeLessThanOrEqual(1024 * 1024);
  });

  it("never returns less than one row", () => {
    expect(chooseBandHeight(100_000_000, 1024)).toBe(1);
  });
});

describe("settings-aware kernel windows", () => {
  it("prices an inactive glitch as one copy and heavy chains higher", () => {
    expect(kernelTransientFields({ mode: "halftone" })).toBe(1);
    expect(kernelTransientFields({ mode: "halftone", fray: true })).toBe(2);
    expect(kernelTransientFields({ mode: "halftone", glitch: true })).toBe(2);
    expect(kernelTransientFields({ mode: "halftone", glitch: true, heavyGlitch: true })).toBe(3);
    expect(kernelTransientFields({ mode: "clean" })).toBe(1);
    expect(kernelTransientFields({ mode: "clean", glitch: true, heavyGlitch: true })).toBe(3);
    expect(kernelTransientFields({ mode: "diffusion" })).toBe(2);
    expect(kernelTransientFields({ mode: "diffusion", blurred: true })).toBe(4);
  });
});

describe("process-wide peak estimation against the resource policy", () => {
  it("keeps the eight-layer 3600x5280 full-sheet job inside budget", () => {
    const plan = planRender(GATE);
    expect(plan.budgetBytes).toBe(RESOURCE_POLICY.maxRenderPeakBytes);
    expect(plan.withinBudget).toBe(true);
    expect(plan.estimatedPeakBytes).toBeLessThanOrEqual(RESOURCE_POLICY.maxRenderPeakBytes);
    expect(plan.tiles.length).toBeGreaterThan(1);
    expect(plan.bandHeight).toBe(GATE_BAND);
  });

  it("flags absurd jobs as over budget instead of attempting them", () => {
    const absurd = {
      sampleWidth: 20000,
      sampleHeight: 20000,
      outputWidth: 20000,
      outputHeight: 20000,
      plateCount: 4,
      layerCount: 32,
    };
    expect(estimateRenderPeakBytes(absurd)).toBeGreaterThan(RESOURCE_POLICY.maxRenderPeakBytes);
    expect(planRender(absurd).withinBudget).toBe(false);
  });

  it("performance gate (legacy view): conservative kernel ceiling, exact arithmetic", () => {
    const plan = planRender(GATE);
    // Single-shot is honestly modeled and correctly rejected: 8 rasters +
    // 8 alpha fields + 6 kernel-transient fields + 8·2 per-plate layer
    // fields + 4·2 retained composed fields = 46 field-equivalents plus the
    // tile rasterization staging.
    expect(plan.singleShotPeakBytes).toBe(46 * FIELD + TILE_CANVAS_BYTES);
    expect(plan.singleShotPeakBytes).toBeGreaterThan(plan.budgetBytes);
    expect(plan.form).toBe("streamed");
    // Streamed, without a layer model: retained layer raster (1) + fixed
    // 6-field ceiling + 2 accumulators + band buffers + tile staging.
    const expectedStreamed = FIELD + 8 * FIELD + GATE_BAND_BYTES + TILE_CANVAS_BYTES;
    expect(plan.streamedPeakBytes).toBe(expectedStreamed);
    expect(expectedStreamed).toBe(709_467_008); // ≈ 676.6 MiB
    expect(plan.estimatedPeakBytes).toBe(expectedStreamed);
    expect(plan.withinBudget).toBe(true);
  });

  it("performance gate (production view): prep + collector stay inside budget for plain recipes", () => {
    // The REAL benchmark stack: prep descriptors (source resident during the
    // banded warp), no glitch, transparent composite → app-side collector.
    const layers: PlanLayerModel[] = Array.from({ length: 8 }, () => ({
      mode: "halftone" as const,
      prep: true,
      sourceBytes: FIELD,
    }));
    const plan = planRender({
      ...GATE,
      layers,
      output: { kind: "composite", whiteMatte: false },
    });
    expect(plan.form).toBe("streamed");
    // Worst layer: max(source + warped during warp, warped + 1 kernel field)
    // = 2 fields; + 2 accumulators + bands + tile staging + 4 collector
    // fields on the app side.
    const expected =
      2 * FIELD + 2 * FIELD + GATE_BAND_BYTES + TILE_CANVAS_BYTES + COLLECTOR_FIELDS * FIELD;
    expect(plan.streamedPeakBytes).toBe(expected);
    expect(plan.appPeakBytes).toBe(COLLECTOR_FIELDS * FIELD);
    expect(plan.workerPeakBytes).toBe(expected - COLLECTOR_FIELDS * FIELD);
    // Finalize (collector 4 fields + output RGBA) and encode stay below.
    expect(estimateAppFinalizeBytes({ ...GATE, layers, output: { kind: "composite" } })).toBe(
      COLLECTOR_FIELDS * FIELD + FIELD,
    );
    expect(plan.estimatedPeakBytes).toBe(expected);
    expect(plan.withinBudget).toBe(true);
    expect(expected).toBeLessThan(768 * 1024 * 1024);
  });

  it("white-matte gate sheet carries the in-session proof inside budget", () => {
    const layers: PlanLayerModel[] = Array.from({ length: 8 }, () => ({
      mode: "halftone" as const,
      prep: true,
      sourceBytes: FIELD,
    }));
    const plan = planRender({
      ...GATE,
      wantsProof: true,
      layers,
      output: { kind: "composite", whiteMatte: true },
    });
    // + 3 proof fields in the worker, + 1 RGBA proof target on the app side.
    const expected =
      2 * FIELD + 2 * FIELD + 3 * FIELD + GATE_BAND_BYTES + TILE_CANVAS_BYTES + FIELD;
    expect(plan.streamedPeakBytes).toBe(expected);
    expect(plan.form).toBe("streamed");
    expect(plan.withinBudget).toBe(true);
  });

  it("truthfully blocks heavy recipes the honest model cannot fit", () => {
    // Eight denoised diffusion layers + collector: warped + (1+3) kernel
    // fields + 2 accumulators + 4 collector fields exceeds the budget at the
    // gate sheet — the service must hard-block BEFORE allocation rather than
    // pretend the old 6-field view applies.
    const layers: PlanLayerModel[] = Array.from({ length: 8 }, () => ({
      mode: "diffusion" as const,
      blurred: true,
      prep: true,
      sourceBytes: FIELD,
    }));
    const plan = planRender({
      ...GATE,
      layers,
      output: { kind: "composite", whiteMatte: false },
    });
    const expected =
      FIELD + (1 + 3) * FIELD + 2 * FIELD + GATE_BAND_BYTES + COLLECTOR_FIELDS * FIELD;
    expect(plan.streamedPeakBytes).toBe(expected);
    expect(plan.withinBudget).toBe(false);
  });

  it("selects single-shot while it fits and flips to streamed just past the budget", () => {
    // 2000×2000, 4 plates: single-shot = (4·L + 14) fields of 16 MB each
    // plus tile staging; 8 layers fits the 768 MiB budget, 9 does not.
    const base = {
      sampleWidth: 2000,
      sampleHeight: 2000,
      outputWidth: 2000,
      outputHeight: 2000,
      plateCount: 4,
    };
    const under = planRender({ ...base, layerCount: 8 });
    expect(under.singleShotPeakBytes).toBe(736_000_000 + TILE_CANVAS_BYTES);
    expect(under.form).toBe("single-shot");
    expect(under.withinBudget).toBe(true);
    const over = planRender({ ...base, layerCount: 9 });
    expect(over.singleShotPeakBytes).toBe(800_000_000 + TILE_CANVAS_BYTES);
    expect(over.form).toBe("streamed");
    expect(over.withinBudget).toBe(true);
    // The streamed peak is layer-count-independent.
    expect(over.streamedPeakBytes).toBe(under.streamedPeakBytes);
  });

  it("streamed feasibility flips at the sheet size the arithmetic predicts", () => {
    // Streamed legacy view ≈ 9 field-equivalents + band buffers + tile
    // staging. At width 3600 the budget crosses between 6010 and 6020 rows.
    const base = { sampleWidth: 3600, outputWidth: 3600, plateCount: 4, layerCount: 8 };
    const under = planRender({ ...base, sampleHeight: 6010, outputHeight: 6010 });
    expect(under.form).toBe("streamed");
    expect(under.streamedPeakBytes).toBe(
      9 * 3600 * 6010 * 4 + (4 * 291 + 2) * 3600 * 4 + TILE_CANVAS_BYTES,
    );
    expect(under.withinBudget).toBe(true);
    const over = planRender({ ...base, sampleHeight: 6020, outputHeight: 6020 });
    expect(over.withinBudget).toBe(false);
  });

  it("hard-rejects only what no available form can run", () => {
    // Streamable but too big for any form.
    const absurd = planRender({
      sampleWidth: 20000,
      sampleHeight: 20000,
      outputWidth: 20000,
      outputHeight: 20000,
      plateCount: 4,
      layerCount: 32,
    });
    expect(absurd.form).toBe("streamed");
    expect(absurd.withinBudget).toBe(false);
    // Not streamable (draft-scaled sampling) and single-shot over budget:
    // the streamed form cannot rescue it, so it is rejected as single-shot.
    const mismatched = {
      sampleWidth: 1100,
      sampleHeight: 1100,
      outputWidth: 20000,
      outputHeight: 20000,
      plateCount: 4,
      layerCount: 32,
    };
    expect(isStreamable(mismatched)).toBe(false);
    const unscalable = planRender(mismatched);
    expect(unscalable.streamable).toBe(false);
    expect(unscalable.form).toBe("single-shot");
    expect(unscalable.withinBudget).toBe(false);
  });

  it("models plate outputs and retained package blobs on the app side", () => {
    const layers: PlanLayerModel[] = [{ mode: "halftone", prep: true, sourceBytes: FIELD }];
    const withBlobs = estimateAppConcurrentBytes({
      ...GATE,
      layers,
      output: { kind: "plate", retainedEncodes: 3, encodeBytesPerPixel: 1 },
    });
    // Plate output RGBA + three retained plate blobs at 1 byte/px.
    expect(withBlobs).toBe(FIELD + 3 * 3600 * 5280);
  });

  it("per-form estimators agree with the feasibility helper", () => {
    expect(estimateRenderPeakBytes(GATE)).toBe(
      Math.min(estimateSingleShotPeakBytes(GATE), estimateStreamedPeakBytes(GATE)),
    );
  });

  it("draft scaling brings interactive scrubs far under budget", () => {
    const scale = draftScaleFor(3600, 5280);
    const width = Math.round(3600 * scale);
    const height = Math.round(5280 * scale);
    const bytes = estimateRenderPeakBytes({
      sampleWidth: width,
      sampleHeight: height,
      outputWidth: width,
      outputHeight: height,
      plateCount: 4,
      layerCount: 8,
    });
    expect(bytes).toBeLessThan(RESOURCE_POLICY.maxRenderPeakBytes / 8);
  });
});
