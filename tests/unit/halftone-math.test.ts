import { describe, expect, it } from "vitest";
import { clamp, coverageFor, type HalftoneSettings } from "../../src/studio/halftone";

const base: HalftoneSettings = {
  cellSize: 12,
  contrast: 1,
  exposure: 0,
  opacity: 0.84,
  dotShape: "round",
  invert: false,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
};

describe("clamp", () => {
  it("bounds to 0..1 by default", () => {
    expect(clamp(-5)).toBe(0);
    expect(clamp(5)).toBe(1);
    expect(clamp(0.42)).toBeCloseTo(0.42);
  });

  it("honors explicit bounds", () => {
    expect(clamp(50, 0, 10)).toBe(10);
  });
});

describe("coverageFor", () => {
  it("reads cyan from the red channel", () => {
    expect(coverageFor("cyan", 0, 255, 255, base)).toBeCloseTo(1);
    expect(coverageFor("cyan", 255, 0, 0, base)).toBeCloseTo(0);
  });

  it("takes black as the minimum ink across channels", () => {
    expect(coverageFor("black", 0, 0, 0, base)).toBeCloseTo(1);
    expect(coverageFor("black", 255, 0, 0, base)).toBeCloseTo(0);
  });

  it("inverts when invert is set", () => {
    const inverted = { ...base, invert: true };
    expect(coverageFor("cyan", 255, 0, 0, inverted)).toBeCloseTo(1);
  });

  it("clamps exposure overdrive into range", () => {
    const hot = { ...base, exposure: 5 };
    expect(coverageFor("cyan", 128, 128, 128, hot)).toBe(1);
  });
});
