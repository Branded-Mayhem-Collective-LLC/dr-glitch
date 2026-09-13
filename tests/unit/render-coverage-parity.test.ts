/**
 * Parity oracle: the DOM-free coverage kernels in src/render must be
 * numerically bit-identical to the current engine in src/studio/halftone.ts.
 */
import { describe, expect, it } from "vitest";
import {
  coverageFor as originalCoverageFor,
  rgbToCmyk as originalRgbToCmyk,
  type HalftoneSettings,
} from "../../src/studio/halftone";
import {
  buildCoverageBase,
  buildCoverageField,
  coverageFor,
  rgbToCmyk,
  visibleContentBounds,
} from "../../src/render/kernels/coverage";
import { gradientRaster, hardEdgeRaster, makeRaster, noiseRaster } from "../../src/render/fixtures";

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
    ...overrides,
  };
}

describe("coverageFor parity", () => {
  const variants: Array<[string, HalftoneSettings]> = [
    ["cmyk", settings()],
    ["cmyk invert", settings({ invert: true })],
    ["grayscale", settings({ grayscale: true })],
    ["grayscale invert", settings({ grayscale: true, invert: true })],
  ];
  const samples: Array<[number, number, number]> = [];
  for (let red = 0; red <= 255; red += 51) {
    for (let green = 0; green <= 255; green += 51) {
      for (let blue = 0; blue <= 255; blue += 51) samples.push([red, green, blue]);
    }
  }
  samples.push([249, 250, 251], [250, 250, 250], [255, 249, 255], [1, 2, 3]);

  it.each(variants)("matches the original for every plate under %s settings", (_name, config) => {
    for (const plate of PLATES) {
      for (const [red, green, blue] of samples) {
        const expected = originalCoverageFor(plate, red, green, blue, config);
        const actual = coverageFor(plate, red, green, blue, config);
        expect(Object.is(actual, expected), `${plate} rgb(${red},${green},${blue})`).toBe(true);
      }
    }
  });
});

describe("rgbToCmyk parity", () => {
  it("matches the original across a channel sweep", () => {
    for (let red = 0; red <= 255; red += 17) {
      for (let green = 0; green <= 255; green += 34) {
        for (let blue = 0; blue <= 255; blue += 51) {
          expect(rgbToCmyk(red, green, blue)).toEqual(originalRgbToCmyk(red, green, blue));
        }
      }
    }
  });
});

describe("buildCoverageBase parity", () => {
  const rasters = [gradientRaster(24, 17), hardEdgeRaster(16, 16), noiseRaster(33, 9, 7)];

  it("equals the original coverageFor applied per pixel", () => {
    for (const raster of rasters) {
      for (const plate of PLATES) {
        for (const config of [settings(), settings({ invert: true }), settings({ grayscale: true })]) {
          const base = buildCoverageBase(raster, plate, config);
          for (let y = 0; y < raster.height; y += 1) {
            for (let x = 0; x < raster.width; x += 1) {
              const index = (y * raster.width + x) * 4;
              const expected = originalCoverageFor(
                plate,
                raster.data[index],
                raster.data[index + 1],
                raster.data[index + 2],
                config,
              );
              expect(Object.is(base[y * raster.width + x], Math.fround(expected))).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe("buildCoverageField", () => {
  it("reduces to the base field when glitch and fray are neutral", () => {
    const raster = gradientRaster(20, 15);
    const config = settings();
    const base = buildCoverageBase(raster, "magenta", config);
    const field = buildCoverageField(raster, "magenta", config);
    expect(new Uint32Array(field.buffer)).toEqual(new Uint32Array(base.buffer));
  });

  it("is deterministic under glitch and fray parameters", () => {
    const raster = hardEdgeRaster(24, 24);
    const config = settings({
      frayedXEdge: 4,
      frayedYEdge: 3,
      sliceShift: 3,
      gridWarp: 2,
      smearDrag: 0.4,
      blockShift: 0.3,
      macroblockCorrupt: 0.4,
      bitmapSort: 0.5,
    });
    const first = buildCoverageField(raster, "cyan", config);
    const second = buildCoverageField(raster, "cyan", config);
    expect(new Uint32Array(first.buffer)).toEqual(new Uint32Array(second.buffer));
    const plain = buildCoverageField(raster, "cyan", settings());
    expect([...first]).not.toEqual([...plain]);
  });
});

describe("visibleContentBounds", () => {
  it("tracks the dark content block and ignores near-white paper", () => {
    const raster = hardEdgeRaster(16, 16);
    expect(visibleContentBounds(raster)).toEqual({ minX: 4, minY: 4, maxX: 11, maxY: 11 });
  });

  it("falls back to the full raster when everything is paper", () => {
    const raster = makeRaster(5, 4, () => [255, 255, 255, 255]);
    expect(visibleContentBounds(raster)).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 3 });
  });
});
