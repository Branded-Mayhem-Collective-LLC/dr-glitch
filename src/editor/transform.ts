/**
 * Layer transform composition and decomposition.
 *
 * Decomposition order (STABLE CONTRACT — renderer and UI both depend on it):
 *
 *   source (cropped) space -> document space applies, in order:
 *     1. crop        — handled upstream: `layerSize` is the cropped source size
 *     2. center      — translate cropped source so its center is the origin
 *     3. flip        — axis flips about the center
 *     4. scale       — scale.x / scale.y
 *     5. skew        — shear by skew.x / skew.y degrees
 *     6. rotate      — rotation degrees (clockwise on screen, y-down)
 *     7. translate   — move the layer center to transform.position (doc px)
 *
 *   M = T(position) * R(rotation) * K(skew) * S(scale) * F(flip) * T(-cx, -cy)
 *
 * Perspective is NOT part of this affine matrix: a valid PerspectiveQuadV1
 * replaces the mapped corner geometry entirely and is realised via
 * homography.ts (rectToQuad on the cropped source rect).
 */

import type { PerspectiveQuadV1, TransformV1, Vec2 } from "../core/types";
import {
  type Mat3,
  mat3ApplyToXY,
  mat3Compose,
  mat3Flip,
  mat3Invert,
  mat3IsAffine,
  mat3IsFinite,
  mat3RotateDeg,
  mat3Scale,
  mat3SkewDeg,
  mat3Translate,
} from "./matrix";

export type Size = { width: number; height: number };

export type Bounds = { x: number; y: number; width: number; height: number };

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Affine matrix mapping cropped-source space ([0..w] x [0..h], y-down) to
 * document pixel space, excluding perspective (see module header).
 */
export function composeTransform(t: TransformV1, layerSize: Size): Mat3 {
  const cx = layerSize.width / 2;
  const cy = layerSize.height / 2;
  return mat3Compose(
    mat3Translate(t.position.x, t.position.y),
    mat3RotateDeg(t.rotation),
    mat3SkewDeg(t.skew.x, t.skew.y),
    mat3Scale(t.scale.x, t.scale.y),
    mat3Flip(t.flipH, t.flipV),
    mat3Translate(-cx, -cy),
  );
}

/** Inverse mapping (document -> cropped source), or null when degenerate. */
export function composeInverseTransform(
  t: TransformV1,
  layerSize: Size,
): Mat3 | null {
  return mat3Invert(composeTransform(t, layerSize));
}

export type AffineDecomposition = {
  /** Translation column (m02, m12). */
  translation: Vec2;
  /** Rotation in degrees. */
  rotation: number;
  /** Signed scales; a negative component encodes a flip. */
  scale: Vec2;
  /** X-shear in degrees (applied between rotation and scale). */
  skewX: number;
};

/**
 * QR-style decomposition of an affine matrix into
 * M = T(translation) * R(rotation) * ShearX(skewX) * S(scale).
 * Returns null for non-affine, nonfinite, or singular matrices.
 *
 * Round-trip contract: recomposition reproduces the matrix exactly (within
 * float tolerance). Parameters equal the authoring TransformV1 fields when
 * skew.y === 0 and flips are folded into signed scale.
 */
export function decomposeAffine(m: Mat3): AffineDecomposition | null {
  if (!mat3IsFinite(m) || !mat3IsAffine(m, 1e-9)) return null;
  const a = m[0]; // x-basis x
  const b = m[3]; // x-basis y
  const c = m[1]; // y-basis x
  const d = m[4]; // y-basis y
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;

  const scaleX = Math.hypot(a, b);
  if (scaleX === 0) return null;
  const rotation = Math.atan2(b, a);
  // With M = R * ShearX(s) * S, the linear part is R * [[sx, sy*tan(s)], [0, sy]],
  // so tan(s) = (col0 . col1) / (sx * sy) = (col0 . col1) / det.
  const shearTan = (a * c + b * d) / det;
  const scaleY = det / scaleX;

  return {
    translation: { x: m[2], y: m[5] },
    rotation: rotation * RAD_TO_DEG,
    scale: { x: scaleX, y: scaleY },
    skewX: Math.atan(shearTan) * RAD_TO_DEG,
  };
}

/** Recompose a decomposition back into a matrix (inverse of decomposeAffine). */
export function recomposeAffine(d: AffineDecomposition): Mat3 {
  return mat3Compose(
    mat3Translate(d.translation.x, d.translation.y),
    mat3RotateDeg(d.rotation),
    mat3SkewDeg(d.skewX, 0),
    mat3Scale(d.scale.x, d.scale.y),
  );
}

/** Axis-aligned hull of the four transformed corners of the cropped source rect. */
export function transformedCorners(t: TransformV1, layerSize: Size): [Vec2, Vec2, Vec2, Vec2] {
  if (t.perspective) {
    const [p0, p1, p2, p3] = t.perspective;
    return [
      { x: p0.x, y: p0.y },
      { x: p1.x, y: p1.y },
      { x: p2.x, y: p2.y },
      { x: p3.x, y: p3.y },
    ];
  }
  const m = composeTransform(t, layerSize);
  const w = layerSize.width;
  const h = layerSize.height;
  const out: [Vec2, Vec2, Vec2, Vec2] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  mat3ApplyToXY(m, 0, 0, out[0]);
  mat3ApplyToXY(m, w, 0, out[1]);
  mat3ApplyToXY(m, w, h, out[2]);
  mat3ApplyToXY(m, 0, h, out[3]);
  return out;
}

/**
 * Document-space axis-aligned bounds of a transformed layer. A valid
 * perspective quad wins over the affine mapping (quads live in doc space).
 */
export function transformedBounds(t: TransformV1, layerSize: Size): Bounds {
  const corners = transformedCorners(t, layerSize);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Union of several bounds; null for an empty list. */
export function unionBounds(list: readonly Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* ------------------------------------------------------------------ */
/* Group transforms                                                    */
/* ------------------------------------------------------------------ */

export type GroupTransformDelta = {
  translate?: Vec2;
  /** Componentwise scale about the pivot. */
  scale?: Vec2;
  /** Rotation about the pivot in degrees. */
  rotateDeg?: number;
};

export type GroupTransformLayer = {
  id: string;
  locked: boolean;
  transform: TransformV1;
};

export type GroupTransformResult = {
  id: string;
  transform: TransformV1;
};

/**
 * Apply a group transform delta about `pivot` (doc px) to every UNLOCKED
 * layer, returning new TransformV1 values. Locked layers are omitted.
 * Pure: inputs are never mutated.
 *
 * Semantics on the decomposed form:
 * - position orbits the pivot through scale-then-rotate, then translates;
 * - rotation adds rotateDeg;
 * - scale multiplies componentwise (exact for uniform group scale; a
 *   nonuniform group scale of a rotated layer is approximated on the
 *   decomposed axes, matching standard editor behavior);
 * - skew and flips are preserved;
 * - a perspective quad is mapped pointwise through the same delta affine
 *   so warped layers travel with the group.
 */
export function applyGroupTransform(
  layers: readonly GroupTransformLayer[],
  delta: GroupTransformDelta,
  pivot: Vec2,
): GroupTransformResult[] {
  const tx = delta.translate?.x ?? 0;
  const ty = delta.translate?.y ?? 0;
  const sx = delta.scale?.x ?? 1;
  const sy = delta.scale?.y ?? 1;
  const rot = delta.rotateDeg ?? 0;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const mapPoint = (p: Vec2): Vec2 => {
    const dx = (p.x - pivot.x) * sx;
    const dy = (p.y - pivot.y) * sy;
    return {
      x: pivot.x + dx * cos - dy * sin + tx,
      y: pivot.y + dx * sin + dy * cos + ty,
    };
  };

  const results: GroupTransformResult[] = [];
  for (const layer of layers) {
    if (layer.locked) continue;
    const t = layer.transform;
    const perspective: PerspectiveQuadV1 = t.perspective
      ? [
          mapPoint(t.perspective[0]),
          mapPoint(t.perspective[1]),
          mapPoint(t.perspective[2]),
          mapPoint(t.perspective[3]),
        ]
      : null;
    results.push({
      id: layer.id,
      transform: {
        position: mapPoint(t.position),
        scale: { x: t.scale.x * sx, y: t.scale.y * sy },
        rotation: t.rotation + rot,
        flipH: t.flipH,
        flipV: t.flipV,
        skew: { x: t.skew.x, y: t.skew.y },
        perspective,
      },
    });
  }
  return results;
}
