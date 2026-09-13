import { describe, expect, it } from "vitest";

import { clampCrop, croppedSize, isValidCrop } from "../../src/editor/crop";

describe("isValidCrop", () => {
  it("accepts an in-bounds integer rect", () => {
    expect(isValidCrop({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)).toBe(
      true,
    );
    expect(isValidCrop({ x: 0, y: 0, width: 100, height: 100 }, 100, 100)).toBe(
      true,
    );
  });

  it("rejects out-of-bounds, zero-size, negative, and fractional rects", () => {
    expect(isValidCrop({ x: 80, y: 0, width: 30, height: 10 }, 100, 100)).toBe(
      false,
    );
    expect(isValidCrop({ x: 0, y: 0, width: 0, height: 10 }, 100, 100)).toBe(
      false,
    );
    expect(isValidCrop({ x: -1, y: 0, width: 10, height: 10 }, 100, 100)).toBe(
      false,
    );
    expect(
      isValidCrop({ x: 0.5, y: 0, width: 10, height: 10 }, 100, 100),
    ).toBe(false);
    expect(
      isValidCrop({ x: NaN, y: 0, width: 10, height: 10 }, 100, 100),
    ).toBe(false);
  });
});

describe("clampCrop", () => {
  it("passes through a valid rect unchanged", () => {
    expect(clampCrop({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)).toEqual(
      { x: 10, y: 20, width: 30, height: 40 },
    );
  });

  it("rounds fractional values", () => {
    expect(
      clampCrop({ x: 1.4, y: 1.6, width: 10.2, height: 9.8 }, 100, 100),
    ).toEqual({ x: 1, y: 2, width: 10, height: 10 });
  });

  it("clamps overflow back inside the asset", () => {
    expect(clampCrop({ x: 90, y: 95, width: 30, height: 30 }, 100, 100)).toEqual(
      { x: 70, y: 70, width: 30, height: 30 },
    );
  });

  it("enforces a minimum 1x1 and non-negative origin", () => {
    expect(
      clampCrop({ x: -10, y: -10, width: 0, height: -5 }, 100, 100),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("sanitizes nonfinite input to the full asset instead of throwing", () => {
    expect(
      clampCrop({ x: NaN, y: Infinity, width: NaN, height: -Infinity }, 64, 32),
    ).toEqual({ x: 0, y: 0, width: 64, height: 32 });
  });
});

describe("croppedSize", () => {
  it("null crop means full asset", () => {
    expect(croppedSize(null, 640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("valid crop yields the crop size", () => {
    expect(
      croppedSize({ x: 10, y: 10, width: 100, height: 50 }, 640, 480),
    ).toEqual({ width: 100, height: 50 });
  });

  it("invalid crop falls back to the full asset (defensive)", () => {
    expect(
      croppedSize({ x: 600, y: 0, width: 100, height: 50 }, 640, 480),
    ).toEqual({ width: 640, height: 480 });
  });
});
