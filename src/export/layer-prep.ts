/**
 * Layer raster preparation — the "layers arrive pre-resampled in sample
 * space" producer the render protocol requires (src/render/protocol.ts,
 * RenderLayerInput). From a LayerV1 plus its decoded source RasterData this
 * module applies, in engine order: crop → affine transform (or four-corner
 * perspective) → inverse-mapped Float64 bilinear warp into output space.
 *
 * Space conventions (project-wide contract, see src/project/factory.ts):
 * document space is y-down pixels with TOP-LEFT origin; transform.position
 * is the layer anchor (cropped-source center) in that space, so a layer
 * centered on the artboard has position (widthPx/2, heightPx/2). Perspective
 * quads live in the same space. Output space is document space scaled by
 * `renderScale` (output px per document px; 1 for exports).
 *
 * Totality: this function never throws on bad geometry. An invalid
 * perspective quad falls back to the layer's affine transform — the
 * "reject without destroying the prior valid transform" contract from
 * PerspectiveQuadV1 (preflight independently hard-blocks invalid quads
 * before an export ever renders). An invalid crop falls back to the full
 * asset (croppedSize semantics). A degenerate affine yields a fully
 * transparent raster (warpRaster's contract).
 *
 * Determinism: pure Float64 math end to end (composeTransform,
 * solveRectToQuad, warpRaster) — identical inputs produce identical bytes on
 * every platform, which the streamed export path depends on when it
 * re-produces the same layer raster once per plate pass.
 */

import type { LayerV1 } from "../core/types";
import {
  composeTransform,
  croppedSize,
  isValidCrop,
  isValidQuad,
  mat3Multiply,
  mat3Scale,
  solveRectToQuad,
  warpRaster,
  type Mat3,
} from "../editor";
import type { RasterData } from "./orchestrator";

export type LayerPrepOptions = {
  /** Output raster dimensions: artboard document px × renderScale. */
  outputWidth: number;
  outputHeight: number;
  /** Output px per document px; 1 for exports, <1 for drafts. */
  renderScale: number;
};

/** Extract the layer's crop window; an invalid/null crop is the full asset. */
export function cropSourceRaster(source: RasterData, crop: LayerV1["crop"]): RasterData {
  if (!crop || !isValidCrop(crop, source.width, source.height)) return source;
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row += 1) {
    const from = ((crop.y + row) * source.width + crop.x) * 4;
    data.set(source.data.subarray(from, from + crop.width * 4), row * crop.width * 4);
  }
  return { data, width: crop.width, height: crop.height };
}

/**
 * Cropped-source → output-space homography for a layer. A valid perspective
 * quad replaces the affine mapping entirely (rect-to-quad, engine contract);
 * anything else uses composeTransform. The result maps source pixel space
 * ([0..w] × [0..h]) into output pixels.
 */
export function layerOutputHomography(
  layer: Pick<LayerV1, "transform">,
  sourceSize: { width: number; height: number },
  renderScale: number,
): Mat3 {
  const scale = mat3Scale(renderScale, renderScale);
  const quad = layer.transform.perspective;
  if (quad !== null && isValidQuad(quad)) {
    const solved = solveRectToQuad(sourceSize, quad);
    if (solved.ok) return mat3Multiply(scale, solved.matrix);
    // Unreachable when isValidQuad passed; kept total for safety.
  }
  return mat3Multiply(scale, composeTransform(layer.transform, sourceSize));
}

/**
 * Build the OFF-MAIN-THREAD prep descriptor for a layer: the decoded source
 * transfers as-is together with its validated crop window and the Float64
 * homography (cropped-source px → output px). The WORKER then crops and
 * warps (src/render/prep.ts resolvePrepRaster), producing bytes identical
 * to prepareLayerRaster below — only the cheap 3×3 matrix math runs here.
 *
 * OWNERSHIP: `source.data.buffer` is listed in the message transferables,
 * so the caller must own the raster (WorkerRenderSources.resolveRaster
 * returns caller-owned pixels) — after submit the buffer is detached.
 */
export function buildLayerPrep(
  layer: Pick<LayerV1, "crop" | "transform">,
  source: RasterData,
  options: LayerPrepOptions,
): {
  source: { buffer: ArrayBuffer; width: number; height: number };
  crop: { x: number; y: number; width: number; height: number } | null;
  homography: number[];
} {
  const crop =
    layer.crop && isValidCrop(layer.crop, source.width, source.height)
      ? { x: layer.crop.x, y: layer.crop.y, width: layer.crop.width, height: layer.crop.height }
      : null;
  const size = croppedSize(layer.crop, source.width, source.height);
  const homography = layerOutputHomography(layer, size, options.renderScale);
  return {
    source: { buffer: source.data.buffer as ArrayBuffer, width: source.width, height: source.height },
    crop,
    homography: Array.from(homography),
  };
}

/**
 * Draft-proxy prep descriptor: like buildLayerPrep, but over a DOWNSAMPLED
 * source proxy (downsampleRasterToEdge) so an interactive draft ships a few
 * megabytes instead of the full decode. The homography composes the layer's
 * full-source mapping with the proxy→full scale, and the crop window scales
 * into proxy coordinates, so document-space placement is preserved exactly;
 * only sampling density is reduced — a DRAFT-ONLY approximation (the
 * exact-viewport settle uses full-resolution sources).
 */
export function buildLayerPrepFromProxy(
  layer: Pick<LayerV1, "crop" | "transform">,
  proxy: RasterData,
  fullSize: { width: number; height: number },
  options: LayerPrepOptions,
): {
  source: { buffer: ArrayBuffer; width: number; height: number };
  crop: { x: number; y: number; width: number; height: number } | null;
  homography: number[];
} {
  const scaleX = fullSize.width / proxy.width;
  const scaleY = fullSize.height / proxy.height;
  const validCrop = layer.crop && isValidCrop(layer.crop, fullSize.width, fullSize.height) ? layer.crop : null;
  const crop = validCrop
    ? {
        x: Math.max(0, Math.min(proxy.width - 1, Math.round(validCrop.x / scaleX))),
        y: Math.max(0, Math.min(proxy.height - 1, Math.round(validCrop.y / scaleY))),
        width: 1,
        height: 1,
      }
    : null;
  if (crop && validCrop) {
    crop.width = Math.max(1, Math.min(proxy.width - crop.x, Math.round(validCrop.width / scaleX)));
    crop.height = Math.max(1, Math.min(proxy.height - crop.y, Math.round(validCrop.height / scaleY)));
  }
  const fullCropped = croppedSize(layer.crop, fullSize.width, fullSize.height);
  // Full-source homography, then proxy-cropped px → full-cropped px scale.
  const base = layerOutputHomography(layer, fullCropped, options.renderScale);
  const proxyCropped = crop ?? { width: proxy.width, height: proxy.height };
  const toFull = mat3Scale(fullCropped.width / proxyCropped.width, fullCropped.height / proxyCropped.height);
  const homography = mat3Multiply(base, toFull);
  return {
    source: { buffer: proxy.data.buffer as ArrayBuffer, width: proxy.width, height: proxy.height },
    crop,
    homography: Array.from(homography),
  };
}

/**
 * Produce a layer's render-input raster at output dimensions: crop, then
 * affine or perspective placement, warped with premultiplied bilinear
 * filtering (straight-alpha result). This is the exact raster a
 * RenderJobRequest layer or a streaming submit-layer message carries.
 */
export function prepareLayerRaster(
  layer: Pick<LayerV1, "crop" | "transform">,
  source: RasterData,
  options: LayerPrepOptions,
): RasterData {
  const cropped = cropSourceRaster(source, layer.crop);
  const size = croppedSize(layer.crop, source.width, source.height);
  const homography = layerOutputHomography(layer, size, options.renderScale);
  const warped = warpRaster(cropped, homography, {
    x: 0,
    y: 0,
    width: options.outputWidth,
    height: options.outputHeight,
  });
  return { data: warped.data, width: warped.width, height: warped.height };
}
