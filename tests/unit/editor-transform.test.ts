import { describe, expect, it } from "vitest";

import type { TransformV1 } from "../../src/core/types";
import {
  applyGroupTransform,
  composeInverseTransform,
  composeTransform,
  decomposeAffine,
  recomposeAffine,
  transformedBounds,
  transformedCorners,
  unionBounds,
} from "../../src/editor/transform";
import { mat3ApplyToPoint } from "../../src/editor/matrix";

const baseTransform = (over: Partial<TransformV1> = {}): TransformV1 => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  flipH: false,
  flipV: false,
  skew: { x: 0, y: 0 },
  perspective: null,
  ...over,
});

describe("composeTransform", () => {
  it("maps the layer center to transform.position", () => {
    const t = baseTransform({ position: { x: 200, y: 300 }, rotation: 45 });
    const m = composeTransform(t, { width: 100, height: 50 });
    const center = mat3ApplyToPoint(m, { x: 50, y: 25 });
    expect(center.x).toBeCloseTo(200, 10);
    expect(center.y).toBeCloseTo(300, 10);
  });

  it("rotates 90 degrees about the layer center", () => {
    const t = baseTransform({ position: { x: 200, y: 300 }, rotation: 90 });
    const size = { width: 100, height: 50 };
    const m = composeTransform(t, size);
    // Top-left corner (0,0): center-relative (-50,-25) -> rotated (25,-50).
    const p = mat3ApplyToPoint(m, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(225, 10);
    expect(p.y).toBeCloseTo(250, 10);
    const b = transformedBounds(t, size);
    expect(b.x).toBeCloseTo(175, 10);
    expect(b.y).toBeCloseTo(250, 10);
    expect(b.width).toBeCloseTo(50, 10);
    expect(b.height).toBeCloseTo(100, 10);
  });

  it("flipH mirrors horizontally about the center", () => {
    const t = baseTransform({ position: { x: 50, y: 25 }, flipH: true });
    const m = composeTransform(t, { width: 100, height: 50 });
    const p = mat3ApplyToPoint(m, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(100, 10);
    expect(p.y).toBeCloseTo(0, 10);
  });

  it("applies flip -> scale -> skew -> rotate order (skew after scale)", () => {
    // scale x2, then skewX 45: source (0,1) about center... use a
    // centered unit layer so center math vanishes.
    const t = baseTransform({
      position: { x: 0, y: 0 },
      scale: { x: 2, y: 1 },
      skew: { x: 45, y: 0 },
    });
    const m = composeTransform(t, { width: 0, height: 0 });
    // Point (0,1): scale -> (0,1); skewX 45 -> (1,1).
    const p = mat3ApplyToPoint(m, { x: 0, y: 1 });
    expect(p.x).toBeCloseTo(1, 10);
    expect(p.y).toBeCloseTo(1, 10);
    // Point (1,0): scale -> (2,0); skew leaves it; no rotation.
    const q = mat3ApplyToPoint(m, { x: 1, y: 0 });
    expect(q.x).toBeCloseTo(2, 10);
    expect(q.y).toBeCloseTo(0, 10);
  });

  it("inverse transform round-trips points", () => {
    const t = baseTransform({
      position: { x: 321, y: -45 },
      scale: { x: 1.5, y: 0.75 },
      rotation: 33,
      flipV: true,
      skew: { x: 12, y: -8 },
    });
    const size = { width: 640, height: 480 };
    const m = composeTransform(t, size);
    const inv = composeInverseTransform(t, size);
    expect(inv).not.toBeNull();
    const src = { x: 123, y: 456 };
    const round = mat3ApplyToPoint(inv as Float64Array, mat3ApplyToPoint(m, src));
    expect(round.x).toBeCloseTo(src.x, 8);
    expect(round.y).toBeCloseTo(src.y, 8);
  });

  it("degenerate scale has no inverse (null, no throw)", () => {
    const t = baseTransform({ scale: { x: 0, y: 1 } });
    expect(composeInverseTransform(t, { width: 10, height: 10 })).toBeNull();
  });
});

describe("decomposeAffine", () => {
  it("recovers rotation, scale, and skewX from a composed matrix", () => {
    const t = baseTransform({
      position: { x: 120, y: 80 },
      scale: { x: 2, y: 0.5 },
      rotation: 30,
      skew: { x: 15, y: 0 },
    });
    // Zero-size layer so the centering translation vanishes.
    const m = composeTransform(t, { width: 0, height: 0 });
    const d = decomposeAffine(m);
    expect(d).not.toBeNull();
    expect(d!.translation.x).toBeCloseTo(120, 10);
    expect(d!.translation.y).toBeCloseTo(80, 10);
    expect(d!.rotation).toBeCloseTo(30, 10);
    expect(d!.scale.x).toBeCloseTo(2, 10);
    expect(d!.scale.y).toBeCloseTo(0.5, 10);
    expect(d!.skewX).toBeCloseTo(15, 10);
  });

  it("matrix round-trips through decompose/recompose, including flips", () => {
    const t = baseTransform({
      position: { x: -40, y: 9 },
      scale: { x: 1.25, y: 3 },
      rotation: -70,
      flipH: true,
      skew: { x: -20, y: 0 },
    });
    const m = composeTransform(t, { width: 64, height: 32 });
    const d = decomposeAffine(m);
    expect(d).not.toBeNull();
    const back = recomposeAffine(d!);
    for (let i = 0; i < 9; i += 1) {
      expect(back[i]).toBeCloseTo(m[i], 9);
    }
  });

  it("returns null for singular and non-affine matrices", () => {
    const singular = composeTransform(
      baseTransform({ scale: { x: 0, y: 2 } }),
      { width: 10, height: 10 },
    );
    expect(decomposeAffine(singular)).toBeNull();
    const perspective = new Float64Array([1, 0, 0, 0, 1, 0, 0.01, 0, 1]);
    expect(decomposeAffine(perspective)).toBeNull();
  });
});

describe("transformed bounds", () => {
  it("uses a valid perspective quad verbatim (doc space)", () => {
    const quad: TransformV1["perspective"] = [
      { x: 10, y: 10 },
      { x: 110, y: 20 },
      { x: 100, y: 120 },
      { x: 0, y: 100 },
    ];
    const t = baseTransform({ perspective: quad });
    const corners = transformedCorners(t, { width: 500, height: 500 });
    expect(corners[0]).toEqual({ x: 10, y: 10 });
    const b = transformedBounds(t, { width: 500, height: 500 });
    expect(b).toEqual({ x: 0, y: 10, width: 110, height: 110 });
  });

  it("unionBounds merges rects and rejects empty input", () => {
    expect(unionBounds([])).toBeNull();
    expect(
      unionBounds([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 5, y: -5, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: -5, width: 15, height: 15 });
  });
});

describe("applyGroupTransform", () => {
  const layer = (
    id: string,
    locked: boolean,
    over: Partial<TransformV1> = {},
  ) => ({ id, locked, transform: baseTransform(over) });

  it("translates every unlocked layer and omits locked layers", () => {
    const result = applyGroupTransform(
      [
        layer("a", false, { position: { x: 10, y: 10 } }),
        layer("b", true, { position: { x: 50, y: 50 } }),
        layer("c", false, { position: { x: -5, y: 0 } }),
      ],
      { translate: { x: 3, y: -4 } },
      { x: 0, y: 0 },
    );
    expect(result.map((r) => r.id)).toEqual(["a", "c"]);
    expect(result[0].transform.position).toEqual({ x: 13, y: 6 });
    expect(result[1].transform.position).toEqual({ x: -2, y: -4 });
  });

  it("rotates positions about the pivot and adds to layer rotation", () => {
    const [r] = applyGroupTransform(
      [layer("a", false, { position: { x: 10, y: 0 }, rotation: 15 })],
      { rotateDeg: 90 },
      { x: 0, y: 0 },
    );
    expect(r.transform.position.x).toBeCloseTo(0, 10);
    expect(r.transform.position.y).toBeCloseTo(10, 10);
    expect(r.transform.rotation).toBe(105);
  });

  it("scales positions about the pivot and multiplies layer scale", () => {
    const [r] = applyGroupTransform(
      [
        layer("a", false, {
          position: { x: 30, y: 40 },
          scale: { x: 2, y: 0.5 },
        }),
      ],
      { scale: { x: 2, y: 2 } },
      { x: 10, y: 20 },
    );
    expect(r.transform.position).toEqual({ x: 50, y: 60 });
    expect(r.transform.scale).toEqual({ x: 4, y: 1 });
  });

  it("maps perspective quads pointwise through the delta", () => {
    const quad: TransformV1["perspective"] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const [r] = applyGroupTransform(
      [layer("a", false, { perspective: quad })],
      { translate: { x: 5, y: 5 } },
      { x: 0, y: 0 },
    );
    expect(r.transform.perspective).toEqual([
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 15 },
      { x: 5, y: 15 },
    ]);
    // Input untouched (pure).
    expect(quad[0]).toEqual({ x: 0, y: 0 });
  });

  it("preserves skew and flips", () => {
    const [r] = applyGroupTransform(
      [
        layer("a", false, {
          flipH: true,
          flipV: true,
          skew: { x: 5, y: -5 },
        }),
      ],
      { rotateDeg: 45 },
      { x: 0, y: 0 },
    );
    expect(r.transform.flipH).toBe(true);
    expect(r.transform.flipV).toBe(true);
    expect(r.transform.skew).toEqual({ x: 5, y: -5 });
  });
});
