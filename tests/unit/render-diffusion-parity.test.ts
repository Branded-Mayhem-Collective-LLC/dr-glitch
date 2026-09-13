/**
 * Parity oracle: src/render diffusion kernels versus the current engine's
 * exported buildDiffusionField (src/studio/halftone.ts). Bit-identical
 * Float32Array outputs are required — this transitively proves the glitch
 * datamosh chain (buildGlitchField, bitmapSortField, macroblocks, smear,
 * block shift, channel desync), the preprocess chain (box blur, denoise,
 * deterministic noise, sharpen), and the serpentine error-diffusion loop.
 */
import { describe, expect, it } from "vitest";
import {
  buildDiffusionField as originalBuildDiffusionField,
  type HalftoneSettings,
} from "../../src/studio/halftone";
import { buildDiffusionField } from "../../src/render/kernels/diffusion";
import type { RasterData } from "../../src/render/raster";
import { gradientRaster, hardEdgeRaster, noiseRaster, transparentRegionsRaster } from "../../src/render/fixtures";

const PLATES = ["cyan", "magenta", "yellow", "black"] as const;

function settings(overrides: Partial<HalftoneSettings> = {}): HalftoneSettings {
  return {
    cellSize: 8,
    frayedXEdge: 0,
    frayedYEdge: 0,
    opacity: 1,
    dotShape: "round",
    invert: false,
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
    visible: { cyan: true, magenta: true, yellow: true, black: true },
    diffusionEnabled: true,
    diffusionAlgorithm: "floyd-steinberg",
    diffusionIntensity: 0.8,
    diffusionLevels: 4,
    ...overrides,
  };
}

function asImageData(raster: RasterData): ImageData {
  return { data: raster.data, width: raster.width, height: raster.height, colorSpace: "srgb" } as ImageData;
}

function expectBitIdentical(raster: RasterData, plate: (typeof PLATES)[number], config: HalftoneSettings) {
  const expected = originalBuildDiffusionField(asImageData(raster), plate, config);
  const actual = buildDiffusionField(raster, plate, config);
  expect(actual.length).toBe(expected.length);
  expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));
}

const gradient = gradientRaster(24, 17);
const hardEdge = hardEdgeRaster(16, 16);
const noise = noiseRaster(33, 9, 5);
const oddSmall = gradientRaster(7, 21);

describe("buildDiffusionField parity", () => {
  it("matches for every plate on the gradient fixture", () => {
    for (const plate of PLATES) expectBitIdentical(gradient, plate, settings());
  });

  it("matches for grayscale and invert combinations", () => {
    expectBitIdentical(gradient, "black", settings({ grayscale: true }));
    expectBitIdentical(gradient, "black", settings({ grayscale: true, invert: true }));
    expectBitIdentical(gradient, "cyan", settings({ invert: true }));
  });

  it.each([
    "none",
    "floyd-steinberg",
    "jarvis-judice-ninke",
    "stucki",
    "burkes",
    "atkinson",
  ] as const)("matches for the %s algorithm on every fixture", (algorithm) => {
    for (const raster of [gradient, hardEdge, noise, oddSmall]) {
      expectBitIdentical(raster, "black", settings({ diffusionAlgorithm: algorithm }));
    }
  });

  it.each([
    "none",
    "column",
    "row",
    "dispersed",
    "medium",
    "heavy",
    "circuit",
    "tilt",
    "grid",
  ] as const)("matches for the %s modulation", (modulation) => {
    expectBitIdentical(gradient, "magenta", settings({ diffusionModulation: modulation, diffusionModStrength: 0.9 }));
  });

  it("matches under sharpen, denoise, and noise injection", () => {
    expectBitIdentical(gradient, "black", settings({ diffusionSharpenStrength: 0.8, diffusionSharpenRadius: 1 }));
    expectBitIdentical(gradient, "black", settings({ diffusionSharpenStrength: 0.8, diffusionSharpenRadius: 3 }));
    expectBitIdentical(noise, "black", settings({ diffusionDenoise: 1 }));
    expectBitIdentical(gradient, "black", settings({ diffusionDenoise: -1 }));
  });

  it("matches under glitch parameter sweeps (datamosh chain)", () => {
    const sweeps: Array<Partial<HalftoneSettings>> = [
      { smearDrag: 0.6, smearLength: 12 },
      { smearDrag: 0.6, smearVertical: true },
      { blockShift: 0.5, blockShiftSize: 8 },
      { channelDesync: 0.7 },
      { macroblockCorrupt: 0.6, macroblockDropout: 0.5 },
      { bitmapSort: 0.5 },
      { bitmapSort: 0.5, bitmapSortVertical: true },
      { brokenKernel: 0.7 },
      { directionalBias: 0.8, directionalBiasAngle: 30 },
      { errorOverflow: 0.9 },
      { diffusionReset: 0.8 },
      { crossChannelBleed: 0.6 },
      {
        smearDrag: 0.4,
        blockShift: 0.3,
        channelDesync: 0.4,
        macroblockCorrupt: 0.5,
        bitmapSort: 0.4,
        brokenKernel: 0.3,
        errorOverflow: 0.4,
        diffusionReset: 0.5,
      },
    ];
    for (const sweep of sweeps) {
      for (const plate of ["cyan", "black"] as const) {
        expectBitIdentical(hardEdge, plate, settings(sweep));
      }
    }
  });

  it("matches on rasters carrying transparency (coverage ignores alpha by design)", () => {
    expectBitIdentical(transparentRegionsRaster(18, 12), "black", settings());
  });

  it("matches on odd dimensions and intensity/level extremes", () => {
    expectBitIdentical(oddSmall, "yellow", settings({ diffusionIntensity: 1, diffusionLevels: 2 }));
    expectBitIdentical(noise, "black", settings({ diffusionIntensity: 0, diffusionLevels: 32 }));
  });
});
