/**
 * Quad homographies and premultiplied bilinear warping.
 *
 * All solves are Float64 and total: invalid input NEVER throws — every
 * entry point returns a validity result so callers keep the prior valid
 * transform (contract from PerspectiveQuadV1 in src/core/types.ts).
 *
 * Quad convention: [top-left, top-right, bottom-right, bottom-left] in a
 * y-down space (document px). A valid quad is finite, strictly convex,
 * non-self-intersecting, winding-consistent with that corner order
 * (positive orientation in y-down space), has area above epsilon, and
 * yields a nonsingular, well-conditioned matrix.
 */

import type { PerspectiveQuadV1, Vec2 } from "../core/types";
import {
  type Mat3,
  mat3ApplyToPoint,
  mat3FromValues,
  mat3FrobeniusNorm,
  mat3Invert,
  mat3IsFinite,
  mat3Multiply,
} from "./matrix";

export type Quad = [Vec2, Vec2, Vec2, Vec2];

export type HomographyResult =
  | { ok: true; matrix: Mat3; inverse: Mat3 }
  | { ok: false; reason: HomographyFailure };

export type HomographyFailure =
  | "quad-nonfinite"
  | "quad-duplicate-points"
  | "quad-not-convex"
  | "quad-degenerate-area"
  | "matrix-singular"
  | "matrix-ill-conditioned";

/** Minimum absolute shoelace area (px^2) for a usable quad. */
export const MIN_QUAD_AREA = 1e-6;

/** Minimum squared corner separation (px^2). */
const MIN_CORNER_DISTANCE_SQ = 1e-12;

/** Maximum Frobenius condition estimate for a usable homography. */
const MAX_CONDITION = 1e12;

function isFiniteVec(p: Vec2 | undefined | null): p is Vec2 {
  return (
    p != null &&
    typeof p.x === "number" &&
    typeof p.y === "number" &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y)
  );
}

/** Signed shoelace area; positive for the TL,TR,BR,BL order in y-down space. */
export function quadSignedArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export type QuadValidation =
  | { valid: true }
  | { valid: false; reason: HomographyFailure };

/**
 * Full validity check for a perspective quad. Never throws, accepts any
 * shape of input. `null` (no perspective) is NOT a valid quad here —
 * callers treat null as "perspective off" before asking.
 */
export function validateQuad(quad: PerspectiveQuadV1 | undefined): QuadValidation {
  if (!quad || quad.length !== 4) {
    return { valid: false, reason: "quad-nonfinite" };
  }
  for (let i = 0; i < 4; i += 1) {
    if (!isFiniteVec(quad[i])) return { valid: false, reason: "quad-nonfinite" };
  }
  const q = quad as Quad;

  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      const dx = q[i].x - q[j].x;
      const dy = q[i].y - q[j].y;
      if (dx * dx + dy * dy < MIN_CORNER_DISTANCE_SQ) {
        return { valid: false, reason: "quad-duplicate-points" };
      }
    }
  }

  // Strict convexity + consistent (positive, y-down) winding: the cross
  // product at every corner must be strictly positive. Mixed signs mean
  // concave or self-intersecting ("bowtie"); zeros mean collinear corners.
  // This also rejects mirrored (negative-winding) quads, which the
  // perspective handles never produce.
  for (let i = 0; i < 4; i += 1) {
    const p0 = q[i];
    const p1 = q[(i + 1) % 4];
    const p2 = q[(i + 2) % 4];
    const cross =
      (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (!(cross > 0)) return { valid: false, reason: "quad-not-convex" };
  }

  if (Math.abs(quadSignedArea(q)) < MIN_QUAD_AREA) {
    return { valid: false, reason: "quad-degenerate-area" };
  }

  // Conditioning of the induced square->quad homography.
  const solved = solveSquareToQuad(q);
  if (!solved.ok) return { valid: false, reason: solved.reason };
  return { valid: true };
}

/** Boolean convenience over validateQuad. */
export function isValidQuad(quad: PerspectiveQuadV1 | undefined): quad is Quad {
  return validateQuad(quad).valid;
}

/**
 * Closed-form (Heckbert) projective mapping of the unit square
 * (0,0),(1,0),(1,1),(0,1) onto quad corners TL,TR,BR,BL.
 * Geometry-only solve; conditioning is checked by the callers below.
 */
function squareToQuadMatrix(quad: Quad): Mat3 | null {
  const [p0, p1, p2, p3] = quad;
  const px = p0.x - p1.x + p2.x - p3.x;
  const py = p0.y - p1.y + p2.y - p3.y;

  let g = 0;
  let h = 0;
  if (px !== 0 || py !== 0) {
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    if (den === 0 || !Number.isFinite(den)) return null;
    g = (px * dy2 - py * dx2) / den;
    h = (dx1 * py - dy1 * px) / den;
  }

  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  const m = mat3FromValues(a, b, c, d, e, f, g, h, 1);
  return mat3IsFinite(m) ? m : null;
}

function finishSolve(matrix: Mat3 | null): HomographyResult {
  if (!matrix) return { ok: false, reason: "matrix-singular" };
  const inverse = mat3Invert(matrix);
  if (!inverse) return { ok: false, reason: "matrix-singular" };
  const condition = mat3FrobeniusNorm(matrix) * mat3FrobeniusNorm(inverse);
  if (!Number.isFinite(condition) || condition > MAX_CONDITION) {
    return { ok: false, reason: "matrix-ill-conditioned" };
  }
  return { ok: true, matrix, inverse };
}

/** Unit square -> quad homography (geometry checks included). */
export function solveSquareToQuad(quad: Quad): HomographyResult {
  return finishSolve(squareToQuadMatrix(quad));
}

/**
 * Source rect [0..width] x [0..height] -> quad. This is the mapping the
 * renderer uses for a layer's perspective: cropped source pixels onto
 * the document-space quad.
 */
export function solveRectToQuad(
  size: { width: number; height: number },
  quad: PerspectiveQuadV1,
): HomographyResult {
  const check = validateQuad(quad);
  if (!check.valid) return { ok: false, reason: check.reason };
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return { ok: false, reason: "matrix-singular" };
  }
  const sq = solveSquareToQuad(quad as Quad);
  if (!sq.ok) return sq;
  // (square->quad) * scale(1/w, 1/h)
  const norm = mat3FromValues(1 / size.width, 0, 0, 0, 1 / size.height, 0, 0, 0, 1);
  return finishSolve(mat3Multiply(sq.matrix, norm));
}

/** General quad -> quad homography via the unit square. */
export function solveQuadToQuad(src: PerspectiveQuadV1, dst: PerspectiveQuadV1): HomographyResult {
  const cs = validateQuad(src);
  if (!cs.valid) return { ok: false, reason: cs.reason };
  const cd = validateQuad(dst);
  if (!cd.valid) return { ok: false, reason: cd.reason };
  const s = solveSquareToQuad(src as Quad);
  if (!s.ok) return s;
  const d = solveSquareToQuad(dst as Quad);
  if (!d.ok) return d;
  return finishSolve(mat3Multiply(d.matrix, s.inverse));
}

/** Map a point through a homography (projective divide). */
export function applyHomography(m: Mat3, p: Vec2): Vec2 {
  return mat3ApplyToPoint(m, p);
}

/* ------------------------------------------------------------------ */
/* Warp                                                                */
/* ------------------------------------------------------------------ */

export type RasterLike = {
  /** RGBA8, straight (non-premultiplied) alpha, row-major. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type WarpBounds = { x: number; y: number; width: number; height: number };

/**
 * Inverse-mapped bilinear warp with premultiplied filtering.
 *
 * `homography` maps SOURCE pixel space ([0..srcW] x [0..srcH], y-down) to
 * destination/document space; the inverse is taken internally. `dstBounds`
 * selects the destination pixels to produce (integer origin/size in the
 * destination space); the result raster is dstBounds.width x dstBounds.height
 * with straight alpha.
 *
 * Sampling: each destination pixel center is inverse-mapped; the four
 * neighboring source texels are premultiplied, blended bilinearly, then
 * unpremultiplied — so transparent neighbors can never bleed their RGB
 * (no dark/light fringing). Out-of-source taps are fully transparent.
 * An identity mapping with aligned bounds is lossless.
 *
 * Never throws: a singular/nonfinite homography yields a transparent raster.
 */
export function warpRaster(
  src: RasterLike,
  homography: Mat3,
  dstBounds: WarpBounds,
): RasterLike {
  const dw = Math.max(0, Math.floor(dstBounds.width));
  const dh = Math.max(0, Math.floor(dstBounds.height));
  const out = new Uint8ClampedArray(dw * dh * 4);
  const result: RasterLike = { data: out, width: dw, height: dh };
  if (dw === 0 || dh === 0) return result;

  const inv = mat3Invert(homography);
  if (!inv) return result; // transparent output, prior transform stays with caller

  const i00 = inv[0], i01 = inv[1], i02 = inv[2];
  const i10 = inv[3], i11 = inv[4], i12 = inv[5];
  const i20 = inv[6], i21 = inv[7], i22 = inv[8];

  const sw = src.width;
  const sh = src.height;
  const sdata = src.data;

  let o = 0;
  for (let dy = 0; dy < dh; dy += 1) {
    const y = dstBounds.y + dy + 0.5;
    for (let dx = 0; dx < dw; dx += 1) {
      const x = dstBounds.x + dx + 0.5;
      const w = i20 * x + i21 * y + i22;
      if (!(Math.abs(w) > 1e-12)) {
        o += 4;
        continue;
      }
      const sx = (i00 * x + i01 * y + i02) / w;
      const sy = (i10 * x + i11 * y + i12) / w;

      // Texel space: source pixel i has its center at i + 0.5.
      const u = sx - 0.5;
      const v = sy - 0.5;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;

      // Four taps, premultiplied; out-of-range taps contribute nothing.
      for (let t = 0; t < 4; t += 1) {
        const tx = t & 1 ? x1 : x0;
        const ty = t & 2 ? y1 : y0;
        if (tx < 0 || ty < 0 || tx >= sw || ty >= sh) continue;
        const wgt = (t & 1 ? fx : 1 - fx) * (t & 2 ? fy : 1 - fy);
        if (wgt === 0) continue;
        const si = (ty * sw + tx) * 4;
        const a = sdata[si + 3] / 255;
        const wa = wgt * a;
        pr += sdata[si] * wa;
        pg += sdata[si + 1] * wa;
        pb += sdata[si + 2] * wa;
        pa += wgt * a;
      }

      if (pa > 0) {
        out[o] = pr / pa;
        out[o + 1] = pg / pa;
        out[o + 2] = pb / pa;
        out[o + 3] = pa * 255;
      }
      o += 4;
    }
  }
  return result;
}
