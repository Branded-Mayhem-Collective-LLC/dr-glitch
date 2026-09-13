/**
 * Plate-stack composition semantics: premultiplied Porter-Duff source-over
 * with knockout, opacity applied exactly once, explicit source alpha (never
 * white-matted), and the pure CMYK-multiply proof model.
 */
import { describe, expect, it } from "vitest";
import {
  composePlate,
  opaqueAlphaField,
  plateInkCoverage,
  proofCompositeCmyk,
  type PlateLayerOutput,
} from "../../src/render/compose";
import { extractAlphaField } from "../../src/render/raster";
import { transparentRegionsRaster } from "../../src/render/fixtures";

function layer(ink: number[], alpha: number[], opacity = 1): PlateLayerOutput {
  return { ink: new Float32Array(ink), alpha: new Float32Array(alpha), opacity };
}

describe("composePlate knockout truth table", () => {
  it("transparent upper pixels reveal lower ink", () => {
    const lower = layer([1], [1]);
    const upper = layer([1], [0]); // fully transparent regardless of ink value
    const composed = composePlate([lower, upper], 1);
    expect(composed.inkPremultiplied[0]).toBe(1);
    expect(composed.alpha[0]).toBe(1);
  });

  it("opaque upper pixels with zero ink knock lower ink out", () => {
    const lower = layer([1], [1]);
    const upper = layer([0], [1]);
    const composed = composePlate([lower, upper], 1);
    expect(composed.inkPremultiplied[0]).toBe(0);
    expect(composed.alpha[0]).toBe(1);
  });

  it("partial upper alpha blends ink proportionally", () => {
    const lower = layer([1], [1]);
    const upper = layer([0], [0.25]);
    const composed = composePlate([lower, upper], 1);
    // 0.25 of the pixel is knocked out, 0.75 keeps lower ink.
    expect(composed.inkPremultiplied[0]).toBeCloseTo(0.75, 6);
    expect(composed.alpha[0]).toBe(1);
  });

  it("upper ink over lower ink stays fully inked", () => {
    const composed = composePlate([layer([1], [1]), layer([1], [0.5])], 1);
    expect(composed.inkPremultiplied[0]).toBe(1);
  });
});

describe("layer opacity", () => {
  it("multiplies alpha exactly once", () => {
    const single = composePlate([layer([1], [0.8], 0.5)], 1);
    expect(single.inkPremultiplied[0]).toBeCloseTo(0.8 * 0.5, 6);
    expect(single.alpha[0]).toBeCloseTo(0.8 * 0.5, 6);
    // Straight ink stays 1: opacity thins coverage, not ink density twice.
    expect(plateInkCoverage(single)[0]).toBeCloseTo(1, 6);
  });

  it("half-opacity knockout removes only half the lower ink", () => {
    const composed = composePlate([layer([1], [1]), layer([0], [1], 0.5)], 1);
    expect(composed.inkPremultiplied[0]).toBeCloseTo(0.5, 6);
  });
});

describe("source alpha stays explicit", () => {
  it("uses raster alpha as layer coverage — never a white matte", () => {
    const raster = transparentRegionsRaster(9, 3);
    const alpha = extractAlphaField(raster);
    const pixelCount = raster.width * raster.height;
    const lower = layer(Array(pixelCount).fill(1), Array(pixelCount).fill(1));
    const upper: PlateLayerOutput = { ink: new Float32Array(pixelCount), alpha, opacity: 1 };
    const composed = composePlate([lower, upper], pixelCount);
    // Right third is fully transparent: lower ink survives untouched.
    const transparentIndex = raster.width - 1;
    expect(composed.inkPremultiplied[transparentIndex]).toBe(1);
    // Left third is opaque with zero ink: full knockout.
    expect(composed.inkPremultiplied[0]).toBe(0);
    // Middle third: knockout proportional to the pixel's own alpha (128/255 here).
    const middleIndex = raster.width + 4;
    expect(alpha[middleIndex]).toBeGreaterThan(0);
    expect(alpha[middleIndex]).toBeLessThan(1);
    expect(composed.inkPremultiplied[middleIndex]).toBeCloseTo(1 - alpha[middleIndex], 5);
  });
});

describe("empty and ordering behavior", () => {
  it("an empty stack composes to no ink and no coverage", () => {
    const composed = composePlate([], 4);
    expect([...composed.inkPremultiplied]).toEqual([0, 0, 0, 0]);
    expect([...composed.alpha]).toEqual([0, 0, 0, 0]);
  });

  it("order matters: ink-over-knockout differs from knockout-over-ink", () => {
    const inked = layer([1], [1]);
    const knockout = layer([0], [1]);
    expect(composePlate([inked, knockout], 1).inkPremultiplied[0]).toBe(0);
    expect(composePlate([knockout, inked], 1).inkPremultiplied[0]).toBe(1);
  });

  it("rejects mismatched field lengths", () => {
    expect(() => composePlate([layer([1, 1], [1, 1])], 3)).toThrow(/pixelCount/);
  });
});

describe("proofCompositeCmyk", () => {
  it("leaves paper untouched where no plate has ink", () => {
    const proof = proofCompositeCmyk({}, 2, 1, [238, 234, 224]);
    expect([...proof.data.slice(0, 4)]).toEqual([238, 234, 224, 255]);
  });

  it("multiplies plate color over paper at full coverage (PLATE_META parity)", () => {
    const composed = { inkPremultiplied: new Float32Array([1]), alpha: opaqueAlphaField(1) };
    const proof = proofCompositeCmyk({ cyan: composed }, 1, 1, [255, 255, 255]);
    // Full cyan over white paper = the cyan plate color #00a9c8.
    expect([...proof.data]).toEqual([0, 169, 200, 255]);
  });

  it("interpolates between paper and multiplied color by coverage", () => {
    const composed = { inkPremultiplied: new Float32Array([0.5]), alpha: opaqueAlphaField(1) };
    const proof = proofCompositeCmyk({ black: composed }, 1, 1, [200, 200, 200]);
    // channel = paper * (1 - c * (1 - plate/255)) with plate black #202226.
    expect(proof.data[0]).toBe(Math.round(200 * (1 - 0.5 * (1 - 32 / 255))));
    expect(proof.data[1]).toBe(Math.round(200 * (1 - 0.5 * (1 - 34 / 255))));
    expect(proof.data[2]).toBe(Math.round(200 * (1 - 0.5 * (1 - 38 / 255))));
  });

  it("applies plates multiplicatively in press order", () => {
    const full = { inkPremultiplied: new Float32Array([1]), alpha: opaqueAlphaField(1) };
    const proof = proofCompositeCmyk({ cyan: full, magenta: full }, 1, 1, [255, 255, 255]);
    expect(proof.data[0]).toBe(Math.round(255 * (0 / 255) * (229 / 255)));
    expect(proof.data[1]).toBe(Math.round(255 * (169 / 255) * (53 / 255)));
    expect(proof.data[2]).toBe(Math.round(255 * (200 / 255) * (120 / 255)));
  });
});
