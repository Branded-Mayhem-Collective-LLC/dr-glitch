/**
 * Worker-side layer preparation: crop + inverse-mapped Float64 bilinear warp
 * from a transferred SOURCE raster into output (artboard) space.
 *
 * WHY THIS LIVES IN src/render: transform/crop/warp used to run
 * synchronously on the main thread (export/layer-prep.ts) before every
 * worker submit, allocating whole artboard-sized rasters there. The
 * protocol's `prep` descriptor form (protocol.ts, LayerPrepTransfer) instead
 * ships the decoded source plus a crop rect and a precomputed 3x3 homography
 * (cheap Float64 math, still main-thread); the WORKER performs the expensive
 * warp here, band by band, with a cancellation checkpoint between bands.
 *
 * WHY FULL-RESOLUTION (not per tile): every downstream kernel that consumes
 * the warped raster is whole-image by parity contract — glitch slice shifts,
 * bitmap sort, diffusion preprocess, visibleContentBounds, and per-band
 * alpha extraction all read arbitrary rows of the layer raster. Warping per
 * tile would force either re-warping the same rows per consumer (N× the
 * Float64 work) or retaining the tiles anyway (same memory). One warped
 * raster per layer IS the bounded shape; the ledger models source + warped
 * as the prep peak and the source is released the moment the warp finishes.
 *
 * PARITY: warpRaster computes each destination pixel independently from its
 * ABSOLUTE destination coordinate, so warping row bands [y0, y1) with
 * dstBounds {x: 0, y: y0} and stitching is bit-identical to one whole-image
 * call — which is exactly what export/layer-prep.ts prepareLayerRaster does.
 * tests/unit/render-prep.test.ts asserts both equivalences.
 */

import { warpRaster, type WarpBounds } from "../editor/homography";
import { mat3FromValues } from "../editor/matrix";
import {
  chunkRowsFor,
  noteRasterAlloc,
  noteRasterRelease,
  retainAllocation,
  type Checkpoint,
} from "./instrumentation";
import type { LayerPrepTransfer } from "./protocol";
import type { RasterData } from "./raster";

/**
 * Nearest-neighbor downsample so the longer edge fits `maxEdge` — the
 * decode-derived DRAFT PROXY a preview consumer caches once per asset and
 * ships in draft prep descriptors (buildLayerPrepFromProxy). Returns the
 * input unchanged when it already fits.
 */
export function downsampleRasterToEdge(source: RasterData, maxEdge: number): RasterData {
  const longest = Math.max(source.width, source.height);
  if (longest <= maxEdge) return source;
  const scale = maxEdge / longest;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.round((y / height) * source.height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.round((x / width) * source.width));
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      data[to] = source.data[from];
      data[to + 1] = source.data[from + 1];
      data[to + 2] = source.data[from + 2];
      data[to + 3] = source.data[from + 3];
    }
  }
  return { data, width, height };
}

/** Extract a crop window; the rect must be pre-validated (see LayerPrepTransfer). */
export function cropRaster(
  source: RasterData,
  crop: { x: number; y: number; width: number; height: number },
): RasterData {
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  noteRasterAlloc(data.byteLength, "prep-crop");
  try {
    for (let row = 0; row < crop.height; row += 1) {
      const from = ((crop.y + row) * source.width + crop.x) * 4;
      data.set(source.data.subarray(from, from + crop.width * 4), row * crop.width * 4);
    }
    return { data, width: crop.width, height: crop.height };
  } catch (error) {
    noteRasterRelease(data.byteLength, "prep-crop");
    throw error;
  }
}

/**
 * Banded warp: identical bytes to a single warpRaster call over the full
 * bounds, produced in row bands with `checkpoint` awaited between bands so
 * cancellation lands mid-warp even inside a busy worker.
 */
export async function warpRasterBanded(
  source: RasterData,
  homography: Float64Array,
  outputWidth: number,
  outputHeight: number,
  checkpoint: Checkpoint,
  bandRows = chunkRowsFor(outputWidth),
): Promise<RasterData> {
  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  noteRasterAlloc(data.byteLength, "prep-warped");
  let completed = false;
  const rowsPerBand = Math.max(1, Math.floor(bandRows));
  try {
    for (let rowStart = 0; rowStart < outputHeight; rowStart += rowsPerBand) {
      if (rowStart > 0 && checkpoint) await checkpoint();
      const bounds: WarpBounds = {
        x: 0,
        y: rowStart,
        width: outputWidth,
        height: Math.min(rowsPerBand, outputHeight - rowStart),
      };
      const band = warpRaster(source, homography, bounds);
      const releaseBand = retainAllocation(
        band.data.byteLength,
        "band",
        "prep-warp-band",
      );
      try {
        data.set(band.data, rowStart * outputWidth * 4);
      } finally {
        releaseBand();
      }
    }
    completed = true;
    return { data, width: outputWidth, height: outputHeight };
  } finally {
    if (!completed) noteRasterRelease(data.byteLength, "prep-warped");
  }
}

/**
 * Resolve a prep descriptor into the layer's sample-space raster: crop, then
 * banded Float64 warp. Bit-identical to export/layer-prep.ts
 * prepareLayerRaster for the same crop/homography. The SOURCE (and crop
 * window) references are dropped on return; only the warped raster remains.
 */
export async function resolvePrepRaster(
  prep: LayerPrepTransfer,
  outputWidth: number,
  outputHeight: number,
  checkpoint: Checkpoint,
): Promise<RasterData> {
  // CONSUME the descriptor: every reference to the transferred source buffer
  // is severed as soon as a derived buffer exists, so a cropped input never
  // transiently retains original + crop + warped together, and the request
  // object that carried the descriptor cannot keep the source alive through
  // the banded warp's awaits (the audit-measured retention gap).
  let source: RasterData | null = {
    data: new Uint8ClampedArray(prep.source.buffer),
    width: prep.source.width,
    height: prep.source.height,
  };
  const sourceBytes = source.data.byteLength;
  noteRasterAlloc(sourceBytes, "prep-source");
  (prep as { source: LayerPrepTransfer["source"] | null }).source = null;
  let working: RasterData | null = null;
  let workingLabel = "prep-source";
  try {
    if (prep.crop) {
      working = cropRaster(source, prep.crop);
      workingLabel = "prep-crop";
      noteRasterRelease(sourceBytes, "prep-source");
      source = null;
    } else {
      working = source;
      source = null;
    }
    const homography = mat3FromValues(
      prep.homography[0], prep.homography[1], prep.homography[2],
      prep.homography[3], prep.homography[4], prep.homography[5],
      prep.homography[6], prep.homography[7], prep.homography[8],
    );
    return await warpRasterBanded(
      working,
      homography,
      outputWidth,
      outputHeight,
      checkpoint,
    );
  } finally {
    if (source) noteRasterRelease(source.data.byteLength, "prep-source");
    if (working) noteRasterRelease(working.data.byteLength, workingLabel);
  }
}
