/**
 * Perspective ∘ affine composition for UI transform edits — pure, React-free.
 *
 * The engine contract (src/editor/transform.ts + src/export/layer-prep.ts)
 * realises a valid PerspectiveQuadV1 as THE layer geometry: the cropped
 * source rect maps onto the quad (solveRectToQuad) and the decomposed
 * affine fields do not additionally move the pixels. Editing position /
 * scale / rotation / skew / flip on a warped layer therefore did nothing
 * visible ("inert numerics").
 *
 * This module makes those edits COMPOSE instead of being swallowed: every
 * affine patch on a perspective-carrying layer also maps the stored quad
 * pointwise through the DELTA affine between the old and new decomposed
 * transforms. The delta is size-independent — with M(t) = A(t)·T(-c)
 * (composeTransform), A(t) = T·R·K·S·F, the centering terms cancel:
 * M_new·M_old⁻¹ = A_new·A_old⁻¹ — so no asset dimensions are needed.
 *
 * Crop under perspective: the stored homography semantics map the CROPPED
 * source rect onto the quad, so changing the crop alone would stretch the
 * quad's content. cropPerspectiveQuad computes the sub-quad the NEW crop
 * occupied under the OLD homography, so cropping REMOVES content while
 * every remaining pixel keeps its exact document position (and clearing a
 * crop extrapolates the same homography outward).
 *
 * Invalid mapped quads (extrapolation across the horizon, degenerate
 * areas) keep the PRIOR valid quad, matching the PerspectiveQuadV1
 * contract — the affine fields still update.
 */

import type {
  CropV1,
  PerspectiveQuadV1,
  TransformV1,
  Vec2,
} from "../../core/types";
import type { TransformPatch } from "../../project/commands";
import {
  applyHomography,
  isValidQuad,
  mat3Compose,
  mat3Flip,
  mat3Invert,
  mat3Multiply,
  mat3RotateDeg,
  mat3Scale,
  mat3SkewDeg,
  mat3Translate,
  solveRectToQuad,
  type Mat3,
  type Quad,
} from "../../editor";

/** A(t) = T(position)·R(rotation)·K(skew)·S(scale)·F(flip) — no centering. */
function affinePart(t: TransformV1): Mat3 {
  return mat3Compose(
    mat3Translate(t.position.x, t.position.y),
    mat3RotateDeg(t.rotation),
    mat3SkewDeg(t.skew.x, t.skew.y),
    mat3Scale(t.scale.x, t.scale.y),
    mat3Flip(t.flipH, t.flipV),
  );
}

/** Merge an affine patch (perspective ignored) onto a prior transform. */
export function mergeAffinePatch(prior: TransformV1, patch: TransformPatch): TransformV1 {
  return {
    position: patch.position ?? prior.position,
    scale: patch.scale ?? prior.scale,
    rotation: patch.rotation ?? prior.rotation,
    flipH: patch.flipH ?? prior.flipH,
    flipV: patch.flipV ?? prior.flipV,
    skew: patch.skew ?? prior.skew,
    perspective: prior.perspective,
  };
}

/**
 * Document-space delta affine turning the OLD placement into the NEW one:
 * A(new)·A(old)⁻¹. Null when the old affine is singular (zero scale).
 */
export function affineDeltaMatrix(oldT: TransformV1, newT: TransformV1): Mat3 | null {
  const inverse = mat3Invert(affinePart(oldT));
  if (!inverse) return null;
  return mat3Multiply(affinePart(newT), inverse);
}

function mapQuad(matrix: Mat3, quad: Quad): Quad {
  return [
    applyHomography(matrix, quad[0]),
    applyHomography(matrix, quad[1]),
    applyHomography(matrix, quad[2]),
    applyHomography(matrix, quad[3]),
  ];
}

/**
 * Extend an affine TransformPatch for a layer so a stored perspective quad
 * travels with the edit. Returns the patch unchanged when the layer has no
 * quad or the patch already sets perspective explicitly; keeps the prior
 * quad when the mapped candidate would be invalid.
 */
export function composeTransformPatch(
  transform: TransformV1,
  patch: TransformPatch,
): TransformPatch {
  if (patch.perspective !== undefined) return patch;
  const quad = transform.perspective;
  if (!quad || !isValidQuad(quad)) return patch;
  const next = mergeAffinePatch(transform, patch);
  const delta = affineDeltaMatrix(transform, next);
  if (!delta) return patch;
  const mapped = mapQuad(delta, quad as Quad);
  if (!isValidQuad(mapped)) return patch; // keep the prior valid quad
  return { ...patch, perspective: mapped };
}

/** Translate a quad by (dx, dy) — the delta affine of a pure move. */
export function translateQuad(
  quad: NonNullable<PerspectiveQuadV1>,
  dx: number,
  dy: number,
): Quad {
  return [
    { x: quad[0].x + dx, y: quad[0].y + dy },
    { x: quad[1].x + dx, y: quad[1].y + dy },
    { x: quad[2].x + dx, y: quad[2].y + dy },
    { x: quad[3].x + dx, y: quad[3].y + dy },
  ];
}

/**
 * The quad the NEW crop rect occupies under the OLD crop's homography.
 *
 * `oldCrop`/`newCrop` are source-asset px rects; `quad` is the stored
 * perspective the OLD cropped rect maps onto. Every source pixel inside
 * both crops keeps its exact document position — cropping removes content
 * without stretching, and clearing a crop extrapolates outward. Null when
 * the old homography cannot be solved or the mapped quad is invalid (the
 * caller then keeps the prior quad).
 */
export function cropPerspectiveQuad(
  oldCrop: CropV1,
  quad: NonNullable<PerspectiveQuadV1>,
  newCrop: CropV1,
): Quad | null {
  const solved = solveRectToQuad(
    { width: oldCrop.width, height: oldCrop.height },
    quad,
  );
  if (!solved.ok) return null;
  const corner = (x: number, y: number): Vec2 =>
    applyHomography(solved.matrix, { x: x - oldCrop.x, y: y - oldCrop.y });
  const mapped: Quad = [
    corner(newCrop.x, newCrop.y),
    corner(newCrop.x + newCrop.width, newCrop.y),
    corner(newCrop.x + newCrop.width, newCrop.y + newCrop.height),
    corner(newCrop.x, newCrop.y + newCrop.height),
  ];
  return isValidQuad(mapped) ? mapped : null;
}
