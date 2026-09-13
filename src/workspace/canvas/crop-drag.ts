/**
 * Crop interaction state machine — pure, React-free.
 *
 * Crop mode shows the layer's UNCROPPED source extent with an 8-handle crop
 * rectangle in SOURCE-asset pixel space, mapped through the layer transform.
 * The mapping is FROZEN at drag start (sourceToDoc below) so the artwork
 * never jumps while handles move.
 *
 * Anchor compensation: transform.position is the cropped-source CENTER, so
 * changing the crop alone would shift the artwork on the artboard. Every
 * update therefore emits TWO commands — layer/set-crop plus a
 * layer/set-transform position patch that pins the new crop's center to its
 * frozen document location — keeping the visible pixels stationary. Both
 * apply live inside the pointer gesture: one undo transaction, Escape
 * cancels (DocumentApi rolls the store back).
 *
 * Rects are clamped through clampCrop, so every emitted crop is a valid
 * integer rectangle inside the asset. Crop is non-destructive: clearing it
 * (clearCropCommands) restores the full source, again with position
 * compensation so the remaining pixels stay put.
 *
 * Perspective note: crop editing maps through the layer's AFFINE transform
 * (composeTransform) for its overlay geometry, but a stored perspective
 * quad is remapped with every emitted crop (cropPerspectiveQuad): the quad
 * the NEW crop occupied under the OLD homography becomes the new quad, so
 * cropping REMOVES content without stretching the warp, and Clear Crop
 * extrapolates the same homography outward. An unresolvable remap keeps
 * the prior valid quad (PerspectiveQuadV1 contract).
 */

import type { CropV1, Id, PerspectiveQuadV1, TransformV1, Vec2 } from "../../core/types";
import type { Command } from "../../project";
import {
  clampCrop,
  composeTransform,
  croppedSize,
  mat3ApplyToPoint,
  mat3Invert,
  mat3Multiply,
  mat3Translate,
  type Mat3,
} from "../../editor";
import { cropPerspectiveQuad } from "./transform-compose";

export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

export type CropDragLayer = {
  id: Id;
  crop: CropV1 | null;
  transform: TransformV1;
};

export type AssetSize = { width: number; height: number };

export type CropDragState = {
  layerId: Id;
  handle: CropHandle;
  assetSize: AssetSize;
  /** Crop at drag start (full asset when null/invalid). */
  crop0: CropV1;
  /** Stored perspective at drag start; remapped with every emitted crop. */
  perspective0: PerspectiveQuadV1;
  /** Frozen source-px → document-px mapping. */
  sourceToDoc: Mat3;
  docToSource: Mat3;
  /** Pointer at drag start, in source px. */
  startSource: Vec2;
  /** Current candidate rect (always clampCrop-valid). */
  rect: CropV1;
};

/** Frozen source→doc mapping for a layer: M(t, croppedSize) ∘ T(−crop origin). */
export function sourceToDocMatrix(layer: CropDragLayer, assetSize: AssetSize): Mat3 {
  const size = croppedSize(layer.crop, assetSize.width, assetSize.height);
  const crop = effectiveCrop(layer.crop, assetSize);
  return mat3Multiply(
    composeTransform(layer.transform, size),
    mat3Translate(-crop.x, -crop.y),
  );
}

function effectiveCrop(crop: CropV1 | null, assetSize: AssetSize): CropV1 {
  if (crop) return clampCrop(crop, assetSize.width, assetSize.height);
  return { x: 0, y: 0, width: assetSize.width, height: assetSize.height };
}

export function beginCropDrag(
  handle: CropHandle,
  layer: CropDragLayer,
  assetSize: AssetSize,
  pointDoc: Vec2,
): CropDragState | null {
  const sourceToDoc = sourceToDocMatrix(layer, assetSize);
  const docToSource = mat3Invert(sourceToDoc);
  if (!docToSource) return null;
  const crop0 = effectiveCrop(layer.crop, assetSize);
  return {
    layerId: layer.id,
    handle,
    assetSize,
    crop0,
    perspective0: layer.transform.perspective,
    sourceToDoc,
    docToSource,
    startSource: mat3ApplyToPoint(docToSource, pointDoc),
    rect: crop0,
  };
}

function rectFromHandle(state: CropDragState, pointSource: Vec2): CropV1 {
  const { crop0, handle } = state;
  if (handle === "move") {
    return {
      x: crop0.x + (pointSource.x - state.startSource.x),
      y: crop0.y + (pointSource.y - state.startSource.y),
      width: crop0.width,
      height: crop0.height,
    };
  }
  let left = crop0.x;
  let top = crop0.y;
  let right = crop0.x + crop0.width;
  let bottom = crop0.y + crop0.height;
  if (handle.includes("w")) left = Math.min(pointSource.x, right - 1);
  if (handle.includes("e")) right = Math.max(pointSource.x, left + 1);
  if (handle.includes("n")) top = Math.min(pointSource.y, bottom - 1);
  if (handle.includes("s")) bottom = Math.max(pointSource.y, top + 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export type CropDragUpdate = {
  state: CropDragState;
  /** Live commands (set-crop + position compensation); [] when unchanged. */
  commands: Command[];
};

/** Commands pinning `rect` (source px) in place under the frozen mapping. */
export function cropCommands(state: CropDragState, rect: CropV1): Command[] {
  const center = mat3ApplyToPoint(state.sourceToDoc, {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  // Perspective composition: the new crop's sub-quad under the drag-start
  // homography, so remaining pixels never stretch. Unresolvable remaps
  // (extrapolation past the horizon) keep the prior valid quad.
  const remapped = state.perspective0
    ? cropPerspectiveQuad(state.crop0, state.perspective0, rect)
    : null;
  return [
    { type: "layer/set-crop", layerId: state.layerId, crop: rect },
    {
      type: "layer/set-transform",
      layerId: state.layerId,
      patch: {
        position: { x: center.x, y: center.y },
        ...(remapped ? { perspective: remapped } : {}),
      },
    },
  ];
}

export function updateCropDrag(state: CropDragState, pointDoc: Vec2): CropDragUpdate {
  const pointSource = mat3ApplyToPoint(state.docToSource, pointDoc);
  const rect = clampCrop(
    rectFromHandle(state, pointSource),
    state.assetSize.width,
    state.assetSize.height,
  );
  if (
    rect.x === state.rect.x &&
    rect.y === state.rect.y &&
    rect.width === state.rect.width &&
    rect.height === state.rect.height
  ) {
    return { state, commands: [] };
  }
  return { state: { ...state, rect }, commands: cropCommands(state, rect) };
}

/** Final commands at pointer release; [] when the rect never changed. */
export function commitCropDrag(state: CropDragState): Command[] {
  const unchanged =
    state.rect.x === state.crop0.x &&
    state.rect.y === state.crop0.y &&
    state.rect.width === state.crop0.width &&
    state.rect.height === state.crop0.height;
  return unchanged ? [] : cropCommands(state, state.rect);
}

/**
 * Clear Crop: restore the full source, compensating position so the
 * previously visible pixels stay exactly where they were.
 */
export function clearCropCommands(layer: CropDragLayer, assetSize: AssetSize): Command[] {
  const sourceToDoc = sourceToDocMatrix(layer, assetSize);
  const center = mat3ApplyToPoint(sourceToDoc, {
    x: assetSize.width / 2,
    y: assetSize.height / 2,
  });
  const fullRect: CropV1 = { x: 0, y: 0, width: assetSize.width, height: assetSize.height };
  // Perspective: extrapolate the stored homography over the full source so
  // the previously visible pixels keep their exact document positions.
  const remapped = layer.transform.perspective
    ? cropPerspectiveQuad(
        effectiveCrop(layer.crop, assetSize),
        layer.transform.perspective,
        fullRect,
      )
    : null;
  return [
    { type: "layer/set-crop", layerId: layer.id, crop: null },
    {
      type: "layer/set-transform",
      layerId: layer.id,
      patch: {
        position: { x: center.x, y: center.y },
        ...(remapped ? { perspective: remapped } : {}),
      },
    },
  ];
}
