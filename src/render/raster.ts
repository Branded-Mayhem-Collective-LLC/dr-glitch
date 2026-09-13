/**
 * DOM-free raster primitives. `RasterData` is structurally compatible with
 * ImageData (data/width/height) so kernels accept either, in workers or on
 * the main thread, without touching canvas APIs.
 */

export type RasterData = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

/** Parity with src/studio/halftone.ts clamp. */
export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function createRaster(width: number, height: number): RasterData {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/**
 * Nearest-neighbor field sampler with edge clamping.
 * Parity with src/studio/halftone.ts sampleCoverage.
 */
export function sampleFieldNearest(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sampleY = Math.max(0, Math.min(height - 1, Math.round(y)));
  return field[sampleY * width + sampleX];
}

/**
 * Convert 8-bit straight-alpha RGBA into premultiplied Float32 RGBA in 0..1.
 * Premultiplied storage is the canonical interchange for resampling so
 * transparent texels never bleed their (undefined) color into neighbors.
 */
export function premultiply(raster: RasterData): Float32Array {
  const { data } = raster;
  const out = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    out[index] = (data[index] / 255) * alpha;
    out[index + 1] = (data[index + 1] / 255) * alpha;
    out[index + 2] = (data[index + 2] / 255) * alpha;
    out[index + 3] = alpha;
  }
  return out;
}

/** Convert premultiplied Float32 RGBA (0..1) back to straight 8-bit RGBA. */
export function unpremultiply(premultiplied: Float32Array, width: number, height: number): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = premultiplied[index + 3];
    if (alpha > 0) {
      data[index] = (premultiplied[index] / alpha) * 255;
      data[index + 1] = (premultiplied[index + 1] / alpha) * 255;
      data[index + 2] = (premultiplied[index + 2] / alpha) * 255;
    }
    data[index + 3] = alpha * 255;
  }
  return { data, width, height };
}

/**
 * Bilinear sampler over premultiplied Float32 RGBA with edge clamping.
 * Writes RGBA into `out` starting at `outOffset`. Sampling premultiplied
 * values keeps interpolation correct across alpha edges.
 */
export function samplePremultipliedBilinear(
  premultiplied: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Float32Array,
  outOffset = 0,
): void {
  const clampedX = Math.min(width - 1, Math.max(0, x));
  const clampedY = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;
  const topLeft = (y0 * width + x0) * 4;
  const topRight = (y0 * width + x1) * 4;
  const bottomLeft = (y1 * width + x0) * 4;
  const bottomRight = (y1 * width + x1) * 4;
  for (let channel = 0; channel < 4; channel += 1) {
    const top = premultiplied[topLeft + channel] * (1 - fx) + premultiplied[topRight + channel] * fx;
    const bottom = premultiplied[bottomLeft + channel] * (1 - fx) + premultiplied[bottomRight + channel] * fx;
    out[outOffset + channel] = top * (1 - fy) + bottom * fy;
  }
}

/** Per-pixel source alpha as a Float32 field in 0..1. */
export function extractAlphaField(raster: RasterData): Float32Array {
  const { data, width, height } = raster;
  const out = new Float32Array(width * height);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = data[index * 4 + 3] / 255;
  }
  return out;
}

/**
 * Compatibility adapter: flatten straight-alpha RGBA onto white, matching the
 * legacy engine's white sample canvas. Multi-layer composition must NOT use
 * this — source alpha stays explicit and enters composePlate instead.
 */
export function flattenOntoWhite(raster: RasterData): RasterData {
  const { data, width, height } = raster;
  const out = new Uint8ClampedArray(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    out[index] = data[index] * alpha + 255 * (1 - alpha);
    out[index + 1] = data[index + 1] * alpha + 255 * (1 - alpha);
    out[index + 2] = data[index + 2] * alpha + 255 * (1 - alpha);
    out[index + 3] = 255;
  }
  return { data: out, width, height };
}
