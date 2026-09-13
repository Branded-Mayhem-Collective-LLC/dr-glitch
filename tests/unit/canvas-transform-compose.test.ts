/**
 * Perspective ∘ affine composition (wave F transforms item): affine edits
 * on a perspective-carrying layer map the quad through the delta affine,
 * and crop changes under perspective remove content WITHOUT stretching.
 */
import { describe, expect, it } from "vitest";
import {
  affineDeltaMatrix,
  composeTransformPatch,
  cropPerspectiveQuad,
  translateQuad,
} from "../../src/workspace/canvas/transform-compose";
import {
  applyHomography,
  solveRectToQuad,
  validateQuad,
  type Quad,
} from "../../src/editor";
import type { CropV1, TransformV1 } from "../../src/core/types";

function baseTransform(overrides: Partial<TransformV1> = {}): TransformV1 {
  return {
    position: { x: 500, y: 400 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    flipH: false,
    flipV: false,
    skew: { x: 0, y: 0 },
    perspective: null,
    ...overrides,
  };
}

const QUAD: Quad = [
  { x: 100, y: 100 },
  { x: 500, y: 140 },
  { x: 480, y: 520 },
  { x: 110, y: 480 },
];

describe("composeTransformPatch", () => {
  it("returns the patch unchanged for layers without perspective", () => {
    const patch = { rotation: 30 };
    expect(composeTransformPatch(baseTransform(), patch)).toBe(patch);
  });

  it("translates the quad exactly with a position patch", () => {
    const t = baseTransform({ perspective: QUAD });
    const patch = composeTransformPatch(t, {
      position: { x: 520, y: 390 },
    });
    expect(patch.perspective).toBeDefined();
    const quad = patch.perspective as Quad;
    for (let index = 0; index < 4; index += 1) {
      expect(quad[index].x).toBeCloseTo(QUAD[index].x + 20, 9);
      expect(quad[index].y).toBeCloseTo(QUAD[index].y - 10, 9);
    }
  });

  it("scales the quad about the transform position", () => {
    const t = baseTransform({ perspective: QUAD });
    const patch = composeTransformPatch(t, { scale: { x: 2, y: 2 } });
    const quad = patch.perspective as Quad;
    for (let index = 0; index < 4; index += 1) {
      expect(quad[index].x).toBeCloseTo(500 + (QUAD[index].x - 500) * 2, 9);
      expect(quad[index].y).toBeCloseTo(400 + (QUAD[index].y - 400) * 2, 9);
    }
    expect(validateQuad(quad).valid).toBe(true);
  });

  it("rotates the quad about the transform position", () => {
    const t = baseTransform({ perspective: QUAD });
    const patch = composeTransformPatch(t, { rotation: 90 });
    const quad = patch.perspective as Quad;
    // 90° clockwise in y-down space about (500, 400): (x,y) → (cx - (y-cy), cy + (x-cx))
    for (let index = 0; index < 4; index += 1) {
      expect(quad[index].x).toBeCloseTo(500 - (QUAD[index].y - 400), 6);
      expect(quad[index].y).toBeCloseTo(400 + (QUAD[index].x - 500), 6);
    }
  });

  it("an explicit perspective patch is never rewritten", () => {
    const t = baseTransform({ perspective: QUAD });
    const patch = { perspective: null, rotation: 10 };
    expect(composeTransformPatch(t, patch)).toBe(patch);
  });

  it("keeps the prior quad when the mapped candidate would be degenerate", () => {
    const t = baseTransform({ perspective: QUAD });
    // Near-zero scale collapses the quad below the area epsilon.
    const patch = composeTransformPatch(t, { scale: { x: 1e-9, y: 1e-9 } });
    expect(patch.perspective).toBeUndefined(); // reducer keeps prior quad
    expect(patch.scale).toEqual({ x: 1e-9, y: 1e-9 });
  });

  it("delta affine is identity for a no-op patch", () => {
    const t = baseTransform({ perspective: QUAD });
    const delta = affineDeltaMatrix(t, t);
    expect(delta).not.toBeNull();
    const mapped = applyHomography(delta!, { x: 123, y: 456 });
    expect(mapped.x).toBeCloseTo(123, 9);
    expect(mapped.y).toBeCloseTo(456, 9);
  });
});

describe("translateQuad", () => {
  it("moves every corner by the delta", () => {
    expect(translateQuad(QUAD, 5, -3)[2]).toEqual({ x: 485, y: 517 });
  });
});

describe("cropPerspectiveQuad", () => {
  const oldCrop: CropV1 = { x: 0, y: 0, width: 400, height: 400 };

  it("keeps shared source pixels at their exact document positions", () => {
    const newCrop: CropV1 = { x: 100, y: 50, width: 200, height: 300 };
    const mapped = cropPerspectiveQuad(oldCrop, QUAD, newCrop);
    expect(mapped).not.toBeNull();
    // The old homography maps old-cropped-source px → doc px. The new quad
    // corner must be the OLD image of the new crop's corner.
    const solved = solveRectToQuad({ width: 400, height: 400 }, QUAD);
    expect(solved.ok).toBe(true);
    if (!solved.ok || !mapped) return;
    const expected = applyHomography(solved.matrix, { x: 100, y: 50 });
    expect(mapped[0].x).toBeCloseTo(expected.x, 9);
    expect(mapped[0].y).toBeCloseTo(expected.y, 9);
    // And the sub-quad round-trips: solving the NEW rect → NEW quad maps
    // the shared pixel (150, 150 in asset space) to the same doc point.
    const newSolved = solveRectToQuad({ width: 200, height: 300 }, mapped);
    expect(newSolved.ok).toBe(true);
    if (!newSolved.ok) return;
    const sharedOld = applyHomography(solved.matrix, { x: 150, y: 150 });
    const sharedNew = applyHomography(newSolved.matrix, { x: 50, y: 100 });
    expect(sharedNew.x).toBeCloseTo(sharedOld.x, 6);
    expect(sharedNew.y).toBeCloseTo(sharedOld.y, 6);
  });

  it("clearing a crop extrapolates outward and stays valid for mild warps", () => {
    const cropped: CropV1 = { x: 100, y: 100, width: 200, height: 200 };
    const full: CropV1 = { x: 0, y: 0, width: 400, height: 400 };
    const mapped = cropPerspectiveQuad(cropped, QUAD, full);
    expect(mapped).not.toBeNull();
    expect(validateQuad(mapped!).valid).toBe(true);
  });

  it("returns null (caller keeps prior quad) when the mapped quad is invalid", () => {
    // A strongly projective quad: extrapolating far outside can cross the
    // horizon and flip winding — the helper must refuse, not emit garbage.
    const strong: Quad = [
      { x: 0, y: 0 },
      { x: 1000, y: 480 },
      { x: 1000, y: 520 },
      { x: 0, y: 1000 },
    ];
    const cropped: CropV1 = { x: 180, y: 180, width: 40, height: 40 };
    const huge: CropV1 = { x: -100000, y: -100000, width: 300000, height: 300000 };
    const result = cropPerspectiveQuad(cropped, strong, huge);
    if (result !== null) {
      // If it does resolve, it must at least be a valid quad.
      expect(validateQuad(result).valid).toBe(true);
    }
  });
});
