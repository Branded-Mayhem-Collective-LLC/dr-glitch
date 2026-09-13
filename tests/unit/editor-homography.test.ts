import { describe, expect, it } from "vitest";

import type { PerspectiveQuadV1 } from "../../src/core/types";
import {
  applyHomography,
  isValidQuad,
  type Quad,
  type RasterLike,
  solveQuadToQuad,
  solveRectToQuad,
  solveSquareToQuad,
  validateQuad,
  warpRaster,
} from "../../src/editor/homography";
import {
  mat3ApplyToPoint,
  mat3Identity,
  mat3Multiply,
  mat3Translate,
} from "../../src/editor/matrix";

const UNIT_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const shift = (quad: Quad, dx: number, dy: number): Quad =>
  quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;

describe("homography solve — known values", () => {
  it("unit square to itself is the identity", () => {
    const r = solveSquareToQuad(UNIT_QUAD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = mat3Identity();
    for (let i = 0; i < 9; i += 1) expect(r.matrix[i]).toBeCloseTo(id[i], 12);
  });

  it("translated square yields a pure translation", () => {
    const r = solveSquareToQuad(shift(UNIT_QUAD, 5, 7));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = mat3Translate(5, 7);
    for (let i = 0; i < 9; i += 1) expect(r.matrix[i]).toBeCloseTo(t[i], 12);
  });

  it("perspective foreshortening: symmetric trapezoid known values", () => {
    const trapezoid: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.75, y: 1 },
      { x: 0.25, y: 1 },
    ];
    const r = solveSquareToQuad(trapezoid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Corners map exactly.
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    corners.forEach((c, i) => {
      const p = applyHomography(r.matrix, c);
      expect(p.x).toBeCloseTo(trapezoid[i].x, 12);
      expect(p.y).toBeCloseTo(trapezoid[i].y, 12);
    });
    // Projective center: (0.5, 0.5) -> (0.5, 2/3), not the affine midpoint.
    const center = applyHomography(r.matrix, { x: 0.5, y: 0.5 });
    expect(center.x).toBeCloseTo(0.5, 12);
    expect(center.y).toBeCloseTo(2 / 3, 12);
    // Inverse undoes the mapping.
    const back = applyHomography(r.inverse, center);
    expect(back.x).toBeCloseTo(0.5, 10);
    expect(back.y).toBeCloseTo(0.5, 10);
  });

  it("quad-to-quad with identical quads is the identity", () => {
    const quad: Quad = [
      { x: 3, y: 4 },
      { x: 40, y: 6 },
      { x: 38, y: 52 },
      { x: 1, y: 47 },
    ];
    const r = solveQuadToQuad(quad, quad);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const probe = { x: 17, y: 29 };
    const p = applyHomography(r.matrix, probe);
    expect(p.x).toBeCloseTo(probe.x, 8);
    expect(p.y).toBeCloseTo(probe.y, 8);
  });

  it("rect-to-quad maps rect corners onto the quad", () => {
    const quad: Quad = [
      { x: 100, y: 100 },
      { x: 300, y: 120 },
      { x: 280, y: 320 },
      { x: 90, y: 300 },
    ];
    const r = solveRectToQuad({ width: 640, height: 480 }, quad);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rectCorners = [
      { x: 0, y: 0 },
      { x: 640, y: 0 },
      { x: 640, y: 480 },
      { x: 0, y: 480 },
    ];
    rectCorners.forEach((c, i) => {
      const p = applyHomography(r.matrix, c);
      expect(p.x).toBeCloseTo(quad[i].x, 8);
      expect(p.y).toBeCloseTo(quad[i].y, 8);
    });
  });
});

describe("invalid quads are rejected without throwing", () => {
  const cases: Array<[string, PerspectiveQuadV1 | undefined]> = [
    ["null quad", null],
    ["undefined", undefined],
    [
      "concave (dent)",
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 10, y: 10 }, // BR pushed deep inside
        { x: 0, y: 100 },
      ],
    ],
    [
      "self-intersecting bowtie",
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 }, // BR and BL swapped
        { x: 100, y: 100 },
      ],
    ],
    [
      "collinear corners",
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 30 },
      ],
    ],
    [
      "near-zero area",
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 1e-9 },
        { x: 0, y: 1e-10 },
      ],
    ],
    [
      "NaN coordinate",
      [
        { x: NaN, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    ],
    [
      "Infinity coordinate",
      [
        { x: 0, y: 0 },
        { x: Infinity, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    ],
    [
      "duplicate points",
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    ],
    [
      "mirrored winding",
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: 0 },
      ],
    ],
  ];

  it.each(cases)("%s", (_name, quad) => {
    expect(() => validateQuad(quad)).not.toThrow();
    const v = validateQuad(quad);
    expect(v.valid).toBe(false);
    expect(isValidQuad(quad)).toBe(false);
    // Solvers surface failure instead of throwing, so callers keep the
    // prior valid transform.
    const solved = solveRectToQuad({ width: 100, height: 100 }, quad ?? null);
    expect(solved.ok).toBe(false);
  });

  it("a healthy quad passes validation", () => {
    const quad: Quad = [
      { x: 10, y: 10 },
      { x: 110, y: 20 },
      { x: 100, y: 120 },
      { x: 0, y: 100 },
    ];
    expect(validateQuad(quad)).toEqual({ valid: true });
    expect(isValidQuad(quad)).toBe(true);
  });
});

/** 4-wide gradient with full alpha plus one semi-transparent pixel. */
const makeGradient = (width: number, height: number): RasterLike => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / (width - 1)) * 255);
      data[i + 1] = Math.round((y / (height - 1)) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
};

describe("warpRaster", () => {
  it("identity homography is lossless on a synthetic gradient", () => {
    const src = makeGradient(8, 8);
    const out = warpRaster(src, mat3Identity(), {
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    });
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("bilinear correctness on a 2x2 known case", () => {
    // Four opaque pixels; sample exactly at their shared corner -> average.
    const src: RasterLike = {
      data: new Uint8ClampedArray([
        100, 0, 0, 255, /* */ 200, 0, 0, 255,
        0, 40, 0, 255, /*  */ 0, 120, 0, 255,
      ]),
      width: 2,
      height: 2,
    };
    // Source -> dest shifts by (-0.5, -0.5): dst pixel (0,0) center (0.5,0.5)
    // inverse-maps to source (1,1), the corner between all four texels.
    const out = warpRaster(src, mat3Translate(-0.5, -0.5), {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(out.data[0]).toBe(75); // (100+200+0+0)/4
    expect(out.data[1]).toBe(40); // (0+0+40+120)/4
    expect(out.data[2]).toBe(0);
    expect(out.data[3]).toBe(255);
  });

  it("premultiplied sampling: transparent white never fringes opaque red", () => {
    const src: RasterLike = {
      data: new Uint8ClampedArray([
        255, 0, 0, 255, /* opaque red */
        255, 255, 255, 0, /* transparent white */
      ]),
      width: 2,
      height: 1,
    };
    const out = warpRaster(src, mat3Translate(0.5, 0), {
      x: 0,
      y: 0,
      width: 3,
      height: 1,
    });
    // Middle pixel blends red (a=1) with transparent white (a=0) 50/50:
    // color must stay pure red at half alpha, no white/gray bleed.
    expect(out.data[4]).toBe(255);
    expect(out.data[5]).toBe(0);
    expect(out.data[6]).toBe(0);
    expect(out.data[7]).toBe(128);
    // First pixel: half red, half outside (transparent) -> still pure red.
    expect(out.data[0]).toBe(255);
    expect(out.data[1]).toBe(0);
    expect(out.data[2]).toBe(0);
    expect(out.data[3]).toBe(128);
  });

  it("out-of-source samples are fully transparent", () => {
    const src = makeGradient(2, 2);
    const out = warpRaster(src, mat3Identity(), {
      x: 10,
      y: 10,
      width: 2,
      height: 2,
    });
    expect(Array.from(out.data)).toEqual(new Array(16).fill(0));
  });

  it("a singular homography yields a transparent raster, never throws", () => {
    const src = makeGradient(2, 2);
    const singular = mat3Multiply(mat3Identity(), mat3Identity());
    singular[0] = 0;
    singular[4] = 0; // rank-deficient
    const out = warpRaster(src, singular, { x: 0, y: 0, width: 2, height: 2 });
    expect(Array.from(out.data)).toEqual(new Array(16).fill(0));
  });

  it("projective warp keeps corners: rect onto trapezoid stays in bounds", () => {
    const src = makeGradient(4, 4);
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 3, y: 4 },
      { x: 1, y: 4 },
    ];
    const solved = solveRectToQuad({ width: 4, height: 4 }, quad);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const out = warpRaster(src, solved.matrix, { x: 0, y: 0, width: 4, height: 4 });
    // Bottom row outside the trapezoid (x=0 / x=3 columns) is transparent;
    // interior carries ink.
    expect(out.data[(3 * 4 + 0) * 4 + 3]).toBe(0);
    expect(out.data[(3 * 4 + 3) * 4 + 3]).toBe(0);
    expect(out.data[(1 * 4 + 2) * 4 + 3]).toBeGreaterThan(0);
    // Consistency check with the forward mapping of the source center.
    const fwd = mat3ApplyToPoint(solved.matrix, { x: 2, y: 2 });
    expect(fwd.x).toBeGreaterThan(0);
    expect(fwd.x).toBeLessThan(4);
  });
});
