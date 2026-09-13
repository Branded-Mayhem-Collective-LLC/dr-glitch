/**
 * Reduced-path preview compositing math: field resampling, per-mode ink
 * derivation (clean = field-as-ink pointwise), knockout composition parity
 * with composePlate, proof folding, and the monochrome plate view raster.
 */
import { describe, expect, it, vi } from "vitest";
import {
  composeLayerDataPlates,
  layerDataAlpha,
  layerDataInk,
  plateViewRaster,
  PLATE_VIEW_INK,
  proofRasterFromComposed,
  resampleFieldNearest,
} from "../../src/workspace/canvas/layer-data-compose";
import {
  composePlate,
  proofCompositeCmyk,
  type LayerPlateData,
  type RenderResultPayload,
} from "../../src/render";

function fieldTransfer(values: number[], width: number, height: number) {
  return { buffer: Float32Array.from(values).buffer as ArrayBuffer, width, height };
}

function layerData(
  mode: LayerPlateData["mode"],
  field: number[],
  alpha: number[],
  width: number,
  height: number,
  layerIndex = 0,
  plate: LayerPlateData["plate"] = "black",
): LayerPlateData {
  return {
    plate,
    layerIndex,
    mode,
    field: fieldTransfer(field, width, height),
    alpha: fieldTransfer(alpha, width, height),
  };
}

const noRasterizer = () => {
  throw new Error("halftone rasterizer must not be called");
};

describe("resampleFieldNearest", () => {
  it("returns the same array when dimensions match", () => {
    const field = Float32Array.from([1, 2, 3, 4]);
    expect(resampleFieldNearest(field, 2, 2, 2, 2)).toBe(field);
  });

  it("upsamples with the executor's exact nearest-neighbor mapping", () => {
    const field = Float32Array.from([0, 1]);
    const out = resampleFieldNearest(field, 2, 1, 4, 1);
    // round((x / width) * sampleWidth), clamped — matches the executor.
    expect(Array.from(out)).toEqual([0, 1, 1, 1]);
  });
});

describe("layerDataInk", () => {
  it("clean mode uses the field pointwise as ink, clamped to 0..1", () => {
    const layer = layerData("clean", [0.25, 1.5, -0.5, 0.75], [1, 1, 1, 1], 2, 2);
    const ink = layerDataInk(layer, 2, 2, noRasterizer);
    expect(Array.from(ink)).toEqual([0.25, 1, 0, 0.75]);
  });

  it("clean mode never mutates the payload's own field buffer", () => {
    const layer = layerData("clean", [1.5], [1], 1, 1);
    layerDataInk(layer, 1, 1, noRasterizer);
    expect(new Float32Array(layer.field.buffer)[0]).toBe(1.5);
  });

  it("diffusion mode thresholds at 0.5 (renderDiffusionPlate parity)", () => {
    const layer = layerData("diffusion", [0.49, 0.5, 0.51, 0], [1, 1, 1, 1], 2, 2);
    const ink = layerDataInk(layer, 2, 2, noRasterizer);
    expect(Array.from(ink)).toEqual([0, 1, 1, 0]);
  });

  it("halftone mode delegates to the injected rasterizer", () => {
    const rasterizer = vi.fn(() => Float32Array.from([0.5]));
    const layer = layerData("halftone", [0], [1], 1, 1);
    const ink = layerDataInk(layer, 1, 1, rasterizer);
    expect(rasterizer).toHaveBeenCalledWith(layer, 1, 1);
    expect(Array.from(ink)).toEqual([0.5]);
  });

  it("resamples sample-space fields up to output size", () => {
    const layer = layerData("clean", [1, 0], [1, 1], 2, 1);
    const ink = layerDataInk(layer, 4, 1, noRasterizer);
    expect(Array.from(ink)).toEqual([1, 0, 0, 0]);
  });
});

describe("composeLayerDataPlates", () => {
  it("matches composePlate exactly, including knockout and opacity", () => {
    // Bottom layer: full ink, opaque. Top layer: NO ink, opaque at 50%.
    const payload: Extract<RenderResultPayload, { form: "layer-data" }> = {
      form: "layer-data",
      width: 1,
      height: 1,
      layers: [
        layerData("clean", [1], [1], 1, 1, 0),
        layerData("clean", [0], [1], 1, 1, 1),
      ],
    };
    const composed = composeLayerDataPlates(payload, ["black"], [1, 0.5], noRasterizer);
    const oracle = composePlate(
      [
        { ink: Float32Array.from([1]), alpha: Float32Array.from([1]), opacity: 1 },
        { ink: Float32Array.from([0]), alpha: Float32Array.from([1]), opacity: 0.5 },
      ],
      1,
    );
    expect(composed.black).toBeDefined();
    expect(Array.from(composed.black!.inkPremultiplied)).toEqual(
      Array.from(oracle.inkPremultiplied),
    );
    expect(Array.from(composed.black!.alpha)).toEqual(Array.from(oracle.alpha));
  });

  it("a fully opaque zero-ink top layer knocks out lower ink", () => {
    const payload: Extract<RenderResultPayload, { form: "layer-data" }> = {
      form: "layer-data",
      width: 1,
      height: 1,
      layers: [
        layerData("clean", [1], [1], 1, 1, 0),
        layerData("clean", [0], [1], 1, 1, 1),
      ],
    };
    const composed = composeLayerDataPlates(payload, ["black"], [1, 1], noRasterizer);
    expect(composed.black!.inkPremultiplied[0]).toBe(0);
    expect(composed.black!.alpha[0]).toBe(1);
  });

  it("splits payload entries by plate and preserves stack order", () => {
    const payload: Extract<RenderResultPayload, { form: "layer-data" }> = {
      form: "layer-data",
      width: 1,
      height: 1,
      layers: [
        layerData("clean", [1], [1], 1, 1, 0, "cyan"),
        layerData("clean", [0.25], [1], 1, 1, 0, "black"),
      ],
    };
    const composed = composeLayerDataPlates(payload, ["cyan", "black"], [1], noRasterizer);
    expect(composed.cyan!.inkPremultiplied[0]).toBe(1);
    expect(composed.black!.inkPremultiplied[0]).toBe(0.25);
  });
});

describe("proofRasterFromComposed", () => {
  it("is proofCompositeCmyk verbatim (paper through plate absorption)", () => {
    const plates = {
      black: {
        inkPremultiplied: Float32Array.from([1, 0]),
        alpha: Float32Array.from([1, 0]),
      },
    };
    const raster = proofRasterFromComposed(plates, 2, 1, [244, 241, 233]);
    const oracle = proofCompositeCmyk(plates, 2, 1, [244, 241, 233]);
    expect(Array.from(raster.data)).toEqual(Array.from(oracle.data));
    // Uninked pixel shows the paper.
    expect(raster.data[4]).toBe(244);
    expect(raster.data[5]).toBe(241);
    expect(raster.data[6]).toBe(233);
  });
});

describe("plateViewRaster", () => {
  it("mixes monochrome #111214 ink over paper by coverage, opaque alpha", () => {
    const raster = plateViewRaster(Float32Array.from([0, 1, 0.5]), 3, 1, [200, 200, 200]);
    // Coverage 0 → paper.
    expect([raster.data[0], raster.data[1], raster.data[2], raster.data[3]]).toEqual([
      200, 200, 200, 255,
    ]);
    // Coverage 1 → plate ink.
    expect([raster.data[4], raster.data[5], raster.data[6]]).toEqual([...PLATE_VIEW_INK]);
    // Coverage 0.5 → midpoint (Uint8ClampedArray half-to-even rounding).
    expect(raster.data[8]).toBe(108); // (17 + 200) / 2 = 108.5 → 108
    expect(raster.data[11]).toBe(255);
  });

  it("null ink yields plain paper", () => {
    const raster = plateViewRaster(null, 2, 1, [10, 20, 30]);
    expect(Array.from(raster.data)).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
  });
});

describe("layerDataAlpha", () => {
  it("resamples the alpha field to output size", () => {
    const layer = layerData("clean", [1, 1], [0, 1], 2, 1);
    expect(Array.from(layerDataAlpha(layer, 4, 1))).toEqual([0, 1, 1, 1]);
  });
});

describe("proofCompositeTransparent (real-alpha proofs)", () => {
  it("uncovered pixels are genuinely transparent; covered pixels carry film color", async () => {
    const { proofCompositeTransparent } = await import(
      "../../src/workspace/canvas/layer-data-compose"
    );
    // 2×1: pixel 0 fully covered with full K ink; pixel 1 uncovered.
    const composed = {
      black: {
        inkPremultiplied: Float32Array.from([1, 0]),
        alpha: Float32Array.from([1, 0]),
      },
    };
    const raster = proofCompositeTransparent(composed, 2, 1);
    // Pixel 1: alpha 0 (real transparency, not white paper).
    expect(raster.data[7]).toBe(0);
    // Pixel 0: alpha 255, color = full K ink over white light.
    expect(raster.data[3]).toBe(255);
    const overWhite = proofCompositeCmyk(composed, 2, 1, [255, 255, 255]);
    expect(raster.data[0]).toBe(overWhite.data[0]);
    expect(raster.data[1]).toBe(overWhite.data[1]);
    expect(raster.data[2]).toBe(overWhite.data[2]);
  });

  it("partial coverage unpremultiplies ink so edges keep straight-alpha color", async () => {
    const { proofCompositeTransparent } = await import(
      "../../src/workspace/canvas/layer-data-compose"
    );
    // Half-covered pixel whose covered part carries FULL ink:
    // inkPremultiplied = ink(1) × alpha(0.5).
    const composed = {
      black: {
        inkPremultiplied: Float32Array.from([0.5]),
        alpha: Float32Array.from([0.5]),
      },
    };
    const raster = proofCompositeTransparent(composed, 1, 1);
    expect(raster.data[3]).toBe(Math.round(0.5 * 255));
    // Straight color equals FULL-ink film color (not a half-ink wash):
    const fullInk = proofCompositeCmyk(
      { black: { inkPremultiplied: Float32Array.from([1]), alpha: Float32Array.from([1]) } },
      1,
      1,
      [255, 255, 255],
    );
    expect(raster.data[0]).toBe(fullInk.data[0]);
  });

  it("proofRasterFromComposed routes null paper to the transparent compose", async () => {
    const { proofRasterFromComposed: route } = await import(
      "../../src/workspace/canvas/layer-data-compose"
    );
    const composed = {
      black: {
        inkPremultiplied: Float32Array.from([0]),
        alpha: Float32Array.from([0]),
      },
    };
    expect(route(composed, 1, 1, null).data[3]).toBe(0);
    expect(route(composed, 1, 1, [255, 255, 255]).data[3]).toBe(255);
  });
});
