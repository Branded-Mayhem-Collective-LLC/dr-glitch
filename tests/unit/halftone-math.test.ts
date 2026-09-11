import { describe, expect, it } from "vitest";
import {
  MAX_EXPORT_GRID_POINTS,
  clamp,
  coverageFor,
  estimateGridPoints,
  applyDiffusion,
  rgbToCmyk,
  type HalftoneSettings,
} from "../../src/studio/halftone";

const base: HalftoneSettings = {
  cellSize: 12,
  frayedXEdge: 0,
  frayedYEdge: 0,
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

  it.each([
    ["paper white", 255, 255, 255],
    ["near-white paper", 250, 250, 250],
    ["warm near-white paper", 255, 249, 255],
  ] as const)(
    "keeps %s at zero on every inverted plate",
    (_name, red, green, blue) => {
      const inverted = { ...base, invert: true };

      for (const plate of ["cyan", "magenta", "yellow", "black"] as const) {
        expect(coverageFor(plate, red, green, blue, inverted)).toBe(0);
      }
    },
  );

  it("still inverts a zero channel on non-white artwork", () => {
    const inverted = { ...base, invert: true };
    expect(coverageFor("cyan", 255, 0, 0, inverted)).toBe(1);
  });

  it("does not reintroduce process color into neutral gray", () => {
    for (const plate of ["cyan", "magenta", "yellow"] as const) {
      expect(coverageFor(plate, 128, 128, 128, base)).toBe(0);
    }
  });

  it("reads magenta from the green channel", () => {
    expect(coverageFor("magenta", 255, 0, 255, base)).toBeCloseTo(1);
    expect(coverageFor("magenta", 0, 255, 0, base)).toBeCloseTo(0);
  });

  it("reads yellow from the blue channel", () => {
    expect(coverageFor("yellow", 255, 255, 0, base)).toBeCloseTo(1);
    expect(coverageFor("yellow", 0, 0, 255, base)).toBeCloseTo(0);
  });

  it("uses unadjusted process coverage", () => {
    expect(coverageFor("cyan", 0, 255, 255, base)).toBeCloseTo(1);
    expect(coverageFor("cyan", 191, 255, 255, base)).toBeCloseTo(1 - 191 / 255);
  });
});

describe("applyDiffusion", () => {
  const diffusion = { ...base, diffusionEnabled: true, diffusionIntensity: 1, diffusionLevels: 4 };

  it("changes output when the selected algorithm changes", () => {
    const floyd = applyDiffusion(0.5, 3, 4, { ...diffusion, diffusionAlgorithm: "floyd-steinberg" });
    const burkes = applyDiffusion(0.5, 3, 4, { ...diffusion, diffusionAlgorithm: "burkes" });
    expect(floyd).not.toBe(burkes);
  });

  it("uses sharpen radius as part of the sharpening response", () => {
    const narrow = applyDiffusion(0.35, 3, 4, { ...diffusion, diffusionSharpenStrength: 0.8, diffusionSharpenRadius: 1 });
    const wide = applyDiffusion(0.35, 3, 4, { ...diffusion, diffusionSharpenStrength: 0.8, diffusionSharpenRadius: 8 });
    expect(narrow).not.toBe(wide);
  });
});

describe("rgbToCmyk", () => {
  it("uses maximum GCR for black, neutral gray, and white", () => {
    expect(rgbToCmyk(0, 0, 0)).toEqual({
      cyan: 0,
      magenta: 0,
      yellow: 0,
      black: 1,
    });

    const gray = rgbToCmyk(128, 128, 128);
    expect(gray.cyan).toBe(0);
    expect(gray.magenta).toBe(0);
    expect(gray.yellow).toBe(0);
    expect(gray.black).toBeCloseTo(1 - 128 / 255);

    expect(rgbToCmyk(255, 255, 255)).toEqual({
      cyan: 0,
      magenta: 0,
      yellow: 0,
      black: 0,
    });
  });

  it.each([
    ["red", [255, 0, 0], [0, 1, 1, 0]],
    ["green", [0, 255, 0], [1, 0, 1, 0]],
    ["blue", [0, 0, 255], [1, 1, 0, 0]],
    ["cyan", [0, 255, 255], [1, 0, 0, 0]],
    ["magenta", [255, 0, 255], [0, 1, 0, 0]],
    ["yellow", [255, 255, 0], [0, 0, 1, 0]],
  ] as const)("separates saturated %s correctly", (_name, rgb, cmyk) => {
    const result = rgbToCmyk(rgb[0], rgb[1], rgb[2]);
    expect([
      result.cyan,
      result.magenta,
      result.yellow,
      result.black,
    ]).toEqual(cmyk);
  });
});

describe("estimateGridPoints", () => {
  it.each([
    ["unrotated bounds", 100, 50, 10, 0, 50],
    ["rotated effective bounds", 100, 50, 10, 45, 121],
    ["Dave parity at a right angle", 100, 50, 10, 90, 60],
    ["minimum one point", 0, 0, 0, 30, 1],
  ] as const)(
    "matches Dave's estimator for %s",
    (_name, width, height, cellSize, angle, expected) => {
      expect(estimateGridPoints(width, height, cellSize, angle)).toBe(expected);
    },
  );

  it("flags a dense 15×22 sheet above the export budget", () => {
    const points = estimateGridPoints(3600, 5280, 4, 45);

    expect(points).toBe(2_464_900);
    expect(points).toBeGreaterThan(MAX_EXPORT_GRID_POINTS);
    expect(MAX_EXPORT_GRID_POINTS).toBe(2_000_000);
  });
});
