/**
 * Non-destructive crop math. Crop rectangles live in SOURCE-ASSET pixel
 * space (CropV1); the cropped size feeds composeTransform / solveRectToQuad
 * as the layer's source size. All functions are total — bad input is
 * sanitized, never thrown on.
 */

import type { CropV1 } from "../core/types";

export type SourceSize = { width: number; height: number };

/** True when `crop` is an integer rect fully inside a width x height asset. */
export function isValidCrop(
  crop: CropV1,
  assetWidth: number,
  assetHeight: number,
): boolean {
  return (
    Number.isInteger(crop.x) &&
    Number.isInteger(crop.y) &&
    Number.isInteger(crop.width) &&
    Number.isInteger(crop.height) &&
    crop.width >= 1 &&
    crop.height >= 1 &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.x + crop.width <= assetWidth &&
    crop.y + crop.height <= assetHeight
  );
}

/**
 * Clamp an arbitrary crop rect to a valid integer rect inside the asset:
 * nonfinite fields fall back to the full asset; the rect is rounded,
 * clamped to the asset, and kept at least 1x1. Assumes asset dims >= 1.
 */
export function clampCrop(
  crop: CropV1,
  assetWidth: number,
  assetHeight: number,
): CropV1 {
  const maxW = Math.max(1, Math.floor(assetWidth));
  const maxH = Math.max(1, Math.floor(assetHeight));

  let x = Number.isFinite(crop.x) ? Math.round(crop.x) : 0;
  let y = Number.isFinite(crop.y) ? Math.round(crop.y) : 0;
  let w = Number.isFinite(crop.width) ? Math.round(crop.width) : maxW;
  let h = Number.isFinite(crop.height) ? Math.round(crop.height) : maxH;

  w = Math.min(Math.max(1, w), maxW);
  h = Math.min(Math.max(1, h), maxH);
  x = Math.min(Math.max(0, x), maxW - w);
  y = Math.min(Math.max(0, y), maxH - h);

  return { x, y, width: w, height: h };
}

/**
 * Effective source dimensions after crop. A null crop (or an invalid one)
 * means the full asset; a valid crop yields its own size. This is the
 * `layerSize` input for composeTransform and solveRectToQuad.
 */
export function croppedSize(
  crop: CropV1 | null,
  assetWidth: number,
  assetHeight: number,
): SourceSize {
  if (crop && isValidCrop(crop, assetWidth, assetHeight)) {
    return { width: crop.width, height: crop.height };
  }
  return { width: assetWidth, height: assetHeight };
}
