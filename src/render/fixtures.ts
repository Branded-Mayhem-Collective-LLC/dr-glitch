/**
 * Deterministic synthetic raster fixtures for parity tests and the dev
 * component lab. No randomness beyond seeded integer hashes; every call is
 * reproducible bit-for-bit. Not exported from index.ts.
 */
import type { RasterData } from "./raster";

export type PixelFn = (x: number, y: number) => readonly [number, number, number, number];

export function makeRaster(width: number, height: number, pixel: PixelFn): RasterData {
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

/** Smooth RGB gradient exercising all four process plates. */
export function gradientRaster(width: number, height: number): RasterData {
  return makeRaster(width, height, (x, y) => [
    Math.round((x / Math.max(1, width - 1)) * 255),
    Math.round((y / Math.max(1, height - 1)) * 255),
    Math.round(((x + y) / Math.max(1, width + height - 2)) * 255),
    255,
  ]);
}

/** Hard-edged dark block over near-white paper, offset by (offsetX, offsetY). */
export function hardEdgeRaster(
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): RasterData {
  const blockX = Math.floor(width / 4) + offsetX;
  const blockY = Math.floor(height / 4) + offsetY;
  const blockWidth = Math.max(2, Math.floor(width / 2));
  const blockHeight = Math.max(2, Math.floor(height / 2));
  return makeRaster(width, height, (x, y) => {
    const inside = x >= blockX && x < blockX + blockWidth && y >= blockY && y < blockY + blockHeight;
    return inside ? [40, 70, 120, 255] : [255, 255, 255, 255];
  });
}

/** Content with fully and partially transparent regions (alpha matters). */
export function transparentRegionsRaster(width: number, height: number): RasterData {
  return makeRaster(width, height, (x, y) => {
    if (x < width / 3) return [30, 30, 30, 255];
    if (x < (2 * width) / 3) return [30, 30, 30, Math.round((y / Math.max(1, height - 1)) * 255)];
    return [0, 0, 0, 0];
  });
}

/** Seeded integer-hash noise raster; identical across runs. */
export function noiseRaster(width: number, height: number, seed = 1): RasterData {
  const hash = (x: number, y: number, channel: number) => {
    let state = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed + channel, 2246822519)) >>> 0;
    state = Math.imul(state ^ (state >>> 15), 2654435761) >>> 0;
    return (state >>> 8) % 256;
  };
  return makeRaster(width, height, (x, y) => [hash(x, y, 0), hash(x, y, 1), hash(x, y, 2), 255]);
}
