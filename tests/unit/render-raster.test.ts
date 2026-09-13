/**
 * Raster primitives: premultiply/unpremultiply round trips, the bilinear
 * premultiplied sampler, the nearest-neighbor field sampler, and the legacy
 * white-matte compatibility adapter.
 */
import { describe, expect, it } from "vitest";
import {
  extractAlphaField,
  flattenOntoWhite,
  premultiply,
  sampleFieldNearest,
  samplePremultipliedBilinear,
  unpremultiply,
  type RasterData,
} from "../../src/render/raster";
import { makeRaster, transparentRegionsRaster } from "../../src/render/fixtures";

describe("premultiply / unpremultiply", () => {
  it("round-trips opaque and semi-transparent pixels", () => {
    const raster = makeRaster(2, 2, (x, y) => [x * 100, y * 100, 200, x === 0 ? 255 : 128]);
    const roundTripped = unpremultiply(premultiply(raster), 2, 2);
    for (let index = 0; index < raster.data.length; index += 4) {
      expect(Math.abs(roundTripped.data[index] - raster.data[index])).toBeLessThanOrEqual(1);
      expect(Math.abs(roundTripped.data[index + 1] - raster.data[index + 1])).toBeLessThanOrEqual(1);
      expect(Math.abs(roundTripped.data[index + 2] - raster.data[index + 2])).toBeLessThanOrEqual(1);
      expect(roundTripped.data[index + 3]).toBe(raster.data[index + 3]);
    }
  });

  it("premultiplies color by alpha", () => {
    const raster = makeRaster(1, 1, () => [255, 128, 0, 128]);
    const premultiplied = premultiply(raster);
    expect(premultiplied[0]).toBeCloseTo(128 / 255, 6);
    expect(premultiplied[3]).toBeCloseTo(128 / 255, 6);
  });

  it("zeroes fully transparent pixels so they never bleed color", () => {
    const raster = makeRaster(1, 1, () => [255, 255, 255, 0]);
    const premultiplied = premultiply(raster);
    expect([...premultiplied]).toEqual([0, 0, 0, 0]);
  });
});

describe("samplePremultipliedBilinear", () => {
  const raster: RasterData = makeRaster(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const premultiplied = premultiply(raster);

  it("returns exact texel values at integer coordinates", () => {
    const out = new Float32Array(4);
    samplePremultipliedBilinear(premultiplied, 2, 1, 1, 0, out);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[3]).toBeCloseTo(1, 6);
  });

  it("averages at the midpoint", () => {
    const out = new Float32Array(4);
    samplePremultipliedBilinear(premultiplied, 2, 1, 0.5, 0, out);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[3]).toBeCloseTo(1, 6);
  });

  it("clamps outside the raster instead of wrapping", () => {
    const out = new Float32Array(4);
    samplePremultipliedBilinear(premultiplied, 2, 1, -5, 9, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[3]).toBeCloseTo(1, 6);
  });

  it("does not bleed color across a transparent edge", () => {
    const edge = makeRaster(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [255, 255, 255, 0]));
    const out = new Float32Array(4);
    samplePremultipliedBilinear(premultiply(edge), 2, 1, 0.5, 0, out);
    // Premultiplied interpolation: half red coverage, no phantom white.
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[3]).toBeCloseTo(0.5, 6);
  });
});

describe("sampleFieldNearest", () => {
  const field = new Float32Array([0, 1, 2, 3, 4, 5]);

  it("rounds then clamps like the engine sampler", () => {
    expect(sampleFieldNearest(field, 3, 2, 1.4, 0)).toBe(1);
    expect(sampleFieldNearest(field, 3, 2, 1.5, 0)).toBe(2);
    expect(sampleFieldNearest(field, 3, 2, -7, 0)).toBe(0);
    expect(sampleFieldNearest(field, 3, 2, 99, 99)).toBe(5);
  });
});

describe("alpha helpers", () => {
  it("extractAlphaField reads normalized source alpha", () => {
    const raster = transparentRegionsRaster(9, 2);
    const alpha = extractAlphaField(raster);
    expect(alpha[0]).toBe(1);
    expect(alpha[8]).toBe(0);
  });

  it("flattenOntoWhite is the explicit legacy adapter only", () => {
    const raster = makeRaster(1, 1, () => [0, 0, 0, 0]);
    const flattened = flattenOntoWhite(raster);
    expect([...flattened.data]).toEqual([255, 255, 255, 255]);
    // The original raster keeps its alpha; flattening never mutates in place.
    expect(raster.data[3]).toBe(0);
  });
});
