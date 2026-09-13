/**
 * Custom artboard size validation: unit conversion at 240 DPI, integer
 * rounding, minimum edge, and the ResourcePolicy pixel budget.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_ARTBOARD_EDGE_PX,
  validateArtboardSize,
} from "../../src/workspace/canvas/artboard-size";

describe("validateArtboardSize", () => {
  it("accepts pixel values verbatim", () => {
    expect(validateArtboardSize("2640", "3600", "px")).toEqual({
      ok: true,
      widthPx: 2640,
      heightPx: 3600,
    });
  });

  it("converts inches and millimeters at the fixed 240 DPI", () => {
    expect(validateArtboardSize("11", "15", "in")).toEqual({
      ok: true,
      widthPx: 2640,
      heightPx: 3600,
    });
    expect(validateArtboardSize("25.4", "50.8", "mm")).toEqual({
      ok: true,
      widthPx: 240,
      heightPx: 480,
    });
  });

  it("rounds converted values to integer pixels", () => {
    const result = validateArtboardSize("1.001", "2.0021", "in");
    expect(result).toEqual({ ok: true, widthPx: 240, heightPx: 481 });
  });

  it("rejects empty, non-numeric, zero, and negative input", () => {
    for (const [w, h] of [
      ["", "100"],
      ["100", ""],
      ["abc", "100"],
      ["0", "100"],
      ["-5", "100"],
      ["Infinity", "100"],
    ] as const) {
      const result = validateArtboardSize(w, h, "px");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid-number");
    }
  });

  it("rejects sides below the minimum edge", () => {
    const result = validateArtboardSize(String(MIN_ARTBOARD_EDGE_PX - 1), "100", "px");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too-small");
    // Tiny unit values that round below the floor are also refused.
    const tiny = validateArtboardSize("0.01", "10", "in");
    expect(tiny.ok).toBe(false);
  });

  it("enforces the artboard pixel budget with the numbers in the message", () => {
    const result = validateArtboardSize("10000", "10000", "px");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("exceeds-pixel-budget");
      expect(result.message).toContain("100,000,000");
      expect(result.message).toContain("20,000,000");
    }
  });

  it("rejects an extreme single edge even when total pixels fit", () => {
    const result = validateArtboardSize("32769", "16", "px");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("exceeds-edge-budget");
      expect(result.message).toContain("32,768");
    }
  });

  it("accepts a size exactly at the budget", () => {
    expect(validateArtboardSize("4000", "5000", "px")).toEqual({
      ok: true,
      widthPx: 4000,
      heightPx: 5000,
    });
  });

  it("accepts numeric (non-string) input", () => {
    expect(validateArtboardSize(2640, 3600, "px")).toMatchObject({ ok: true });
  });
});
