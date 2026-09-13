import { describe, expect, it } from "vitest";

import {
  mat3ApplyToPoint,
  mat3Compose,
  mat3Determinant,
  mat3Flip,
  mat3FromValues,
  mat3Identity,
  mat3Invert,
  mat3IsAffine,
  mat3IsFinite,
  mat3Multiply,
  mat3RotateDeg,
  mat3Scale,
  mat3SkewDeg,
  mat3Translate,
} from "../../src/editor/matrix";

const expectClose = (actual: number, expected: number, digits = 10): void => {
  expect(actual).toBeCloseTo(expected, digits);
};

const expectMatClose = (actual: Float64Array, expected: number[]): void => {
  for (let i = 0; i < 9; i += 1) expectClose(actual[i], expected[i]);
};

describe("matrix algebra", () => {
  it("identity maps points to themselves", () => {
    const p = mat3ApplyToPoint(mat3Identity(), { x: 12.5, y: -7 });
    expect(p).toEqual({ x: 12.5, y: -7 });
  });

  it("multiplication matches manual composition (translate then scale)", () => {
    // scale * translate: point translated first, then scaled.
    const m = mat3Multiply(mat3Scale(2, 3), mat3Translate(1, 1));
    const p = mat3ApplyToPoint(m, { x: 1, y: 1 });
    expect(p).toEqual({ x: 4, y: 6 });
  });

  it("multiplication is associative", () => {
    const a = mat3RotateDeg(37);
    const b = mat3Translate(5, -2);
    const c = mat3Scale(0.5, 4);
    const left = mat3Multiply(mat3Multiply(a, b), c);
    const right = mat3Multiply(a, mat3Multiply(b, c));
    expectMatClose(left, Array.from(right));
  });

  it("mat3Compose left-folds in application order", () => {
    const composed = mat3Compose(mat3Translate(10, 0), mat3RotateDeg(90));
    // point (1, 0): rotate 90 (y-down clockwise) -> (0, 1), then translate.
    const p = mat3ApplyToPoint(composed, { x: 1, y: 0 });
    expectClose(p.x, 10);
    expectClose(p.y, 1);
  });

  it("determinant of known matrices", () => {
    expect(mat3Determinant(mat3Identity())).toBe(1);
    expect(mat3Determinant(mat3Scale(2, 3))).toBe(6);
    expect(mat3Determinant(mat3Flip(true, false))).toBe(-1);
    expectClose(mat3Determinant(mat3RotateDeg(123)), 1);
  });

  it("inverse round-trips: m * m^-1 = identity", () => {
    const m = mat3Compose(
      mat3Translate(30, -12),
      mat3RotateDeg(31),
      mat3SkewDeg(10, 0),
      mat3Scale(1.5, 0.25),
    );
    const inv = mat3Invert(m);
    expect(inv).not.toBeNull();
    const id = mat3Multiply(m, inv as Float64Array);
    expectMatClose(id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("inverting a singular matrix returns null, never throws", () => {
    expect(mat3Invert(mat3Scale(0, 1))).toBeNull();
    expect(mat3Invert(mat3FromValues(1, 2, 3, 2, 4, 6, 0, 0, 1))).toBeNull();
  });

  it("inverting a nonfinite matrix returns null", () => {
    expect(mat3Invert(mat3FromValues(NaN, 0, 0, 0, 1, 0, 0, 0, 1))).toBeNull();
    expect(
      mat3Invert(mat3FromValues(Infinity, 0, 0, 0, 1, 0, 0, 0, 1)),
    ).toBeNull();
  });

  it("rotation is clockwise on screen (y-down)", () => {
    const p = mat3ApplyToPoint(mat3RotateDeg(90), { x: 1, y: 0 });
    expectClose(p.x, 0);
    expectClose(p.y, 1);
  });

  it("skew shears x by y and y by x", () => {
    const p = mat3ApplyToPoint(mat3SkewDeg(45, 0), { x: 0, y: 1 });
    expectClose(p.x, 1);
    expectClose(p.y, 1);
    const q = mat3ApplyToPoint(mat3SkewDeg(0, 45), { x: 1, y: 0 });
    expectClose(q.x, 1);
    expectClose(q.y, 1);
  });

  it("flip mirrors about the origin per axis", () => {
    expect(mat3ApplyToPoint(mat3Flip(true, false), { x: 3, y: 4 })).toEqual({
      x: -3,
      y: 4,
    });
    expect(mat3ApplyToPoint(mat3Flip(false, true), { x: 3, y: 4 })).toEqual({
      x: 3,
      y: -4,
    });
  });

  it("finiteness and affinity predicates", () => {
    expect(mat3IsFinite(mat3Identity())).toBe(true);
    expect(mat3IsFinite(mat3FromValues(1, 0, 0, 0, NaN, 0, 0, 0, 1))).toBe(
      false,
    );
    expect(mat3IsAffine(mat3Translate(9, 9))).toBe(true);
    expect(mat3IsAffine(mat3FromValues(1, 0, 0, 0, 1, 0, 0.5, 0, 1))).toBe(
      false,
    );
  });
});
