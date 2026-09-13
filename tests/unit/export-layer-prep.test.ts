/**
 * Layer raster preparation (src/export/layer-prep.ts): crop → affine or
 * perspective → warp into output space. Deterministic Float64 math; the
 * matrix here covers identity losslessness, translate, scale, crop,
 * perspective, invalid-quad fallback to the prior (affine) transform, and
 * out-of-bounds transparency.
 */
import { describe, expect, it } from "vitest";
import type { TransformV1 } from "../../src/core/types";
import {
  cropSourceRaster,
  layerOutputHomography,
  prepareLayerRaster,
} from "../../src/export/layer-prep";
import type { RasterData } from "../../src/export/orchestrator";
import { applyHomography } from "../../src/editor";

function makeRaster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = alpha;
    }
  }
  return { data, width, height };
}

function identityTransform(position: { x: number; y: number }): TransformV1 {
  return {
    position,
    scale: { x: 1, y: 1 },
    rotation: 0,
    flipH: false,
    flipV: false,
    skew: { x: 0, y: 0 },
    perspective: null,
  };
}

function pixelAt(raster: RasterData, x: number, y: number): [number, number, number, number] {
  const index = (y * raster.width + x) * 4;
  return [
    raster.data[index],
    raster.data[index + 1],
    raster.data[index + 2],
    raster.data[index + 3],
  ];
}

const OUT = { outputWidth: 16, outputHeight: 12, renderScale: 1 };

describe("cropSourceRaster", () => {
  it("extracts a valid crop window", () => {
    const source = makeRaster(8, 6, (x, y) => [x * 10, y * 10, 0, 255]);
    const cropped = cropSourceRaster(source, { x: 2, y: 1, width: 3, height: 4 });
    expect(cropped.width).toBe(3);
    expect(cropped.height).toBe(4);
    expect(pixelAt(cropped, 0, 0)).toEqual([20, 10, 0, 255]);
    expect(pixelAt(cropped, 2, 3)).toEqual([40, 40, 0, 255]);
  });

  it("falls back to the full asset for null or invalid crops", () => {
    const source = makeRaster(4, 4, () => [1, 2, 3, 255]);
    expect(cropSourceRaster(source, null)).toBe(source);
    expect(cropSourceRaster(source, { x: 2, y: 2, width: 9, height: 9 })).toBe(source);
  });
});

describe("prepareLayerRaster", () => {
  it("identity placement is lossless (centered full-output layer)", () => {
    const source = makeRaster(16, 12, (x, y) => [(x * 16) % 256, (y * 21) % 256, x + y, 255]);
    const layer = {
      crop: null,
      transform: identityTransform({ x: 8, y: 6 }),
    };
    const out = prepareLayerRaster(layer, source, OUT);
    expect(out.width).toBe(16);
    expect(out.height).toBe(12);
    expect([...out.data]).toEqual([...source.data]);
  });

  it("translates by integer offsets exactly", () => {
    const source = makeRaster(4, 4, () => [200, 100, 50, 255]);
    // 4x4 source with center placed at (5, 4): occupies x 3..6, y 2..5.
    const layer = { crop: null, transform: identityTransform({ x: 5, y: 4 }) };
    const out = prepareLayerRaster(layer, source, OUT);
    expect(pixelAt(out, 3, 2)).toEqual([200, 100, 50, 255]);
    expect(pixelAt(out, 6, 5)).toEqual([200, 100, 50, 255]);
    expect(pixelAt(out, 2, 2)[3]).toBe(0); // outside is transparent
    expect(pixelAt(out, 7, 5)[3]).toBe(0);
  });

  it("scales about the layer center", () => {
    const source = makeRaster(2, 2, () => [10, 20, 30, 255]);
    const transform = identityTransform({ x: 8, y: 6 });
    transform.scale = { x: 4, y: 4 };
    const out = prepareLayerRaster({ crop: null, transform }, source, OUT);
    // 2x2 scaled by 4 = 8x8 centered at (8,6): x 4..11, y 2..9. Interior
    // pixels are opaque; the rim antialiases against transparent taps.
    expect(pixelAt(out, 6, 4)).toEqual([10, 20, 30, 255]);
    expect(pixelAt(out, 9, 7)).toEqual([10, 20, 30, 255]);
    expect(pixelAt(out, 4, 2)[3]).toBeGreaterThan(0); // soft rim
    expect(pixelAt(out, 4, 2)[3]).toBeLessThan(255);
    // The bilinear rim extrapolates half a source texel (2 output px here);
    // beyond that everything is fully transparent.
    expect(pixelAt(out, 1, 6)[3]).toBe(0);
    expect(pixelAt(out, 14, 6)[3]).toBe(0);
  });

  it("applies crop before the transform", () => {
    const source = makeRaster(6, 6, (x) => (x < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    // Crop the blue right half, place its center mid-output.
    const layer = {
      crop: { x: 3, y: 0, width: 3, height: 6 },
      transform: identityTransform({ x: 8, y: 6 }),
    };
    const out = prepareLayerRaster(layer, source, OUT);
    expect(pixelAt(out, 8, 6)).toEqual([0, 0, 255, 255]); // blue only
    let redSeen = 0;
    for (let index = 0; index < out.data.length; index += 4) {
      if (out.data[index] > 0 && out.data[index + 3] > 0) redSeen += 1;
    }
    expect(redSeen).toBe(0);
  });

  it("maps a valid perspective quad through rect-to-quad", () => {
    const source = makeRaster(4, 4, () => [50, 150, 250, 255]);
    const quad: TransformV1["perspective"] = [
      { x: 2, y: 2 },
      { x: 12, y: 3 },
      { x: 13, y: 10 },
      { x: 3, y: 9 },
    ];
    const transform = identityTransform({ x: 0, y: 0 });
    transform.perspective = quad;
    const homography = layerOutputHomography({ transform }, { width: 4, height: 4 }, 1);
    // Source corners land exactly on the quad corners.
    expect(applyHomography(homography, { x: 0, y: 0 }).x).toBeCloseTo(2, 9);
    expect(applyHomography(homography, { x: 0, y: 0 }).y).toBeCloseTo(2, 9);
    expect(applyHomography(homography, { x: 4, y: 0 }).x).toBeCloseTo(12, 9);
    expect(applyHomography(homography, { x: 4, y: 4 }).y).toBeCloseTo(10, 9);
    const out = prepareLayerRaster({ crop: null, transform }, source, OUT);
    // Center of the quad is inside the warped content.
    expect(pixelAt(out, 7, 6)[3]).toBe(255);
    // Far corners of the artboard stay transparent.
    expect(pixelAt(out, 0, 11)[3]).toBe(0);
    expect(pixelAt(out, 15, 0)[3]).toBe(0);
  });

  it("an invalid quad keeps the prior (affine) placement instead of destroying it", () => {
    const source = makeRaster(4, 4, () => [200, 100, 50, 255]);
    const affineOnly = { crop: null, transform: identityTransform({ x: 8, y: 6 }) };
    const reference = prepareLayerRaster(affineOnly, source, OUT);
    const bowtie: TransformV1["perspective"] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const withBadQuad = {
      crop: null,
      transform: { ...identityTransform({ x: 8, y: 6 }), perspective: bowtie },
    };
    const out = prepareLayerRaster(withBadQuad, source, OUT);
    expect([...out.data]).toEqual([...reference.data]);
  });

  it("renderScale scales document geometry into output pixels", () => {
    const source = makeRaster(4, 4, () => [10, 10, 10, 255]);
    // Document 32x24 at scale 0.5 → output 16x12; doc-center (16,12) → (8,6).
    const layer = { crop: null, transform: identityTransform({ x: 16, y: 12 }) };
    const out = prepareLayerRaster(layer, source, {
      outputWidth: 16,
      outputHeight: 12,
      renderScale: 0.5,
    });
    // 4x4 doc px at 0.5 scale = 2x2 output px centered at (8,6): x 7..8, y 5..6.
    expect(pixelAt(out, 7, 5)[3]).toBe(255);
    expect(pixelAt(out, 8, 6)[3]).toBe(255);
    expect(pixelAt(out, 5, 5)[3]).toBe(0);
    expect(pixelAt(out, 10, 6)[3]).toBe(0);
  });

  it("out-of-artboard placement clips to transparent output bounds", () => {
    const source = makeRaster(4, 4, () => [255, 255, 255, 255]);
    const layer = { crop: null, transform: identityTransform({ x: -10, y: -10 }) };
    const out = prepareLayerRaster(layer, source, OUT);
    expect(out.width).toBe(16);
    expect(out.height).toBe(12);
    expect(out.data.every((value) => value === 0)).toBe(true);
  });
});

describe("buildLayerPrep (off-main-thread descriptor)", () => {
  it("packs the source, a validated crop, and the exact layerOutputHomography", async () => {
    const { buildLayerPrep } = await import("../../src/export/layer-prep");
    const source = makeRaster(8, 6, (x, y) => [x * 20, y * 30, 0, 255]);
    const layer = {
      crop: { x: 1, y: 1, width: 5, height: 4 },
      transform: identityTransform({ x: 8, y: 6 }),
    };
    const prep = buildLayerPrep(layer, source, OUT);
    expect(prep.source.width).toBe(8);
    expect(prep.source.height).toBe(6);
    expect(prep.source.buffer).toBe(source.data.buffer);
    expect(prep.crop).toEqual(layer.crop);
    const expected = layerOutputHomography(layer, { width: 5, height: 4 }, OUT.renderScale);
    expect(prep.homography).toEqual(Array.from(expected));
  });

  it("nulls out an invalid crop (worker falls back to the full asset, like prepareLayerRaster)", async () => {
    const { buildLayerPrep } = await import("../../src/export/layer-prep");
    const source = makeRaster(8, 6, () => [0, 0, 0, 255]);
    const layer = {
      crop: { x: 4, y: 4, width: 50, height: 50 },
      transform: identityTransform({ x: 8, y: 6 }),
    };
    const prep = buildLayerPrep(layer, source, OUT);
    expect(prep.crop).toBeNull();
    const expected = layerOutputHomography(layer, { width: 8, height: 6 }, OUT.renderScale);
    expect(prep.homography).toEqual(Array.from(expected));
  });
});
