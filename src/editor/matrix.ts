/**
 * Float64 3x3 matrix algebra for editor geometry.
 *
 * Representation: row-major Float64Array of length 9:
 *   [ m00 m01 m02
 *     m10 m11 m12
 *     m20 m21 m22 ]
 *
 * Points are column vectors (x, y, 1); mapping applies the projective
 * divide: x' = (m00*x + m01*y + m02) / w with w = m20*x + m21*y + m22.
 * Affine matrices have last row (0, 0, 1).
 */

import type { Vec2 } from "../core/types";

export type Mat3 = Float64Array;

const DEG_TO_RAD = Math.PI / 180;

/** Identity matrix (new allocation unless `out` is provided). */
export function mat3Identity(out?: Mat3): Mat3 {
  const m = out ?? new Float64Array(9);
  m[0] = 1; m[1] = 0; m[2] = 0;
  m[3] = 0; m[4] = 1; m[5] = 0;
  m[6] = 0; m[7] = 0; m[8] = 1;
  return m;
}

/** Build a matrix from row-major scalar values. */
export function mat3FromValues(
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
): Mat3 {
  const m = new Float64Array(9);
  m[0] = m00; m[1] = m01; m[2] = m02;
  m[3] = m10; m[4] = m11; m[5] = m12;
  m[6] = m20; m[7] = m21; m[8] = m22;
  return m;
}

/** Copy `m` into `out` (or a new matrix). */
export function mat3Clone(m: Mat3, out?: Mat3): Mat3 {
  const r = out ?? new Float64Array(9);
  r.set(m);
  return r;
}

/**
 * Matrix product a * b (b applied first when mapping points).
 * `out` may alias `a` or `b`.
 */
export function mat3Multiply(a: Mat3, b: Mat3, out?: Mat3): Mat3 {
  const a00 = a[0], a01 = a[1], a02 = a[2];
  const a10 = a[3], a11 = a[4], a12 = a[5];
  const a20 = a[6], a21 = a[7], a22 = a[8];
  const b00 = b[0], b01 = b[1], b02 = b[2];
  const b10 = b[3], b11 = b[4], b12 = b[5];
  const b20 = b[6], b21 = b[7], b22 = b[8];
  const m = out ?? new Float64Array(9);
  m[0] = a00 * b00 + a01 * b10 + a02 * b20;
  m[1] = a00 * b01 + a01 * b11 + a02 * b21;
  m[2] = a00 * b02 + a01 * b12 + a02 * b22;
  m[3] = a10 * b00 + a11 * b10 + a12 * b20;
  m[4] = a10 * b01 + a11 * b11 + a12 * b21;
  m[5] = a10 * b02 + a11 * b12 + a12 * b22;
  m[6] = a20 * b00 + a21 * b10 + a22 * b20;
  m[7] = a20 * b01 + a21 * b11 + a22 * b21;
  m[8] = a20 * b02 + a21 * b12 + a22 * b22;
  return m;
}

/** Left-fold a sequence of matrices: mat3Compose(a, b, c) = a * b * c. */
export function mat3Compose(...matrices: Mat3[]): Mat3 {
  const m = mat3Identity();
  for (const next of matrices) mat3Multiply(m, next, m);
  return m;
}

export function mat3Determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/**
 * Inverse of `m`, or null when singular / nonfinite. Never throws.
 * `out` may alias `m`.
 */
export function mat3Invert(m: Mat3, out?: Mat3): Mat3 | null {
  const m00 = m[0], m01 = m[1], m02 = m[2];
  const m10 = m[3], m11 = m[4], m12 = m[5];
  const m20 = m[6], m21 = m[7], m22 = m[8];

  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;

  const det = m00 * c00 + m01 * c01 + m02 * c02;
  if (!Number.isFinite(det) || det === 0) return null;

  const inv = 1 / det;
  const r = out ?? new Float64Array(9);
  r[0] = c00 * inv;
  r[1] = (m02 * m21 - m01 * m22) * inv;
  r[2] = (m01 * m12 - m02 * m11) * inv;
  r[3] = c01 * inv;
  r[4] = (m00 * m22 - m02 * m20) * inv;
  r[5] = (m02 * m10 - m00 * m12) * inv;
  r[6] = c02 * inv;
  r[7] = (m01 * m20 - m00 * m21) * inv;
  r[8] = (m00 * m11 - m01 * m10) * inv;
  if (!mat3IsFinite(r)) return null;
  return r;
}

/** Map a point through `m` with projective divide. May return nonfinite coordinates when w ~ 0; callers validate. */
export function mat3ApplyToPoint(m: Mat3, p: Vec2): Vec2 {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}

/** Allocation-free variant writing x/y into `out`. Returns the w component before divide. */
export function mat3ApplyToXY(m: Mat3, x: number, y: number, out: Vec2): number {
  const w = m[6] * x + m[7] * y + m[8];
  out.x = (m[0] * x + m[1] * y + m[2]) / w;
  out.y = (m[3] * x + m[4] * y + m[5]) / w;
  return w;
}

export function mat3Translate(tx: number, ty: number): Mat3 {
  return mat3FromValues(1, 0, tx, 0, 1, ty, 0, 0, 1);
}

export function mat3Scale(sx: number, sy: number): Mat3 {
  return mat3FromValues(sx, 0, 0, 0, sy, 0, 0, 0, 1);
}

/** Counterclockwise-in-math / clockwise-on-screen (y-down) rotation by degrees. */
export function mat3RotateDeg(deg: number): Mat3 {
  const rad = deg * DEG_TO_RAD;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return mat3FromValues(c, -s, 0, s, c, 0, 0, 0, 1);
}

/** Skew (shear) by degrees per axis: x' = x + tan(skewX)*y, y' = tan(skewY)*x + y. */
export function mat3SkewDeg(skewXDeg: number, skewYDeg: number): Mat3 {
  return mat3FromValues(
    1, Math.tan(skewXDeg * DEG_TO_RAD), 0,
    Math.tan(skewYDeg * DEG_TO_RAD), 1, 0,
    0, 0, 1,
  );
}

/** Axis flip about the origin. */
export function mat3Flip(flipH: boolean, flipV: boolean): Mat3 {
  return mat3Scale(flipH ? -1 : 1, flipV ? -1 : 1);
}

export function mat3IsFinite(m: Mat3): boolean {
  for (let i = 0; i < 9; i += 1) {
    if (!Number.isFinite(m[i])) return false;
  }
  return true;
}

/** True when the last row is (0, 0, 1) within `eps`. */
export function mat3IsAffine(m: Mat3, eps = 1e-12): boolean {
  return (
    Math.abs(m[6]) <= eps && Math.abs(m[7]) <= eps && Math.abs(m[8] - 1) <= eps
  );
}

/** Frobenius norm; used for conditioning estimates. */
export function mat3FrobeniusNorm(m: Mat3): number {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += m[i] * m[i];
  return Math.sqrt(sum);
}
