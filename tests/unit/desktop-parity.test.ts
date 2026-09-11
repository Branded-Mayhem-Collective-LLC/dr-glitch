import { describe, expect, it, vi } from "vitest";
import { coverageFor, drawDot, processPlates, type HalftoneSettings } from "../../src/studio/halftone";
import { parseSettings } from "../../src/studio/settings-schema";

const settings: HalftoneSettings = {
  cellSize: 12, frayedXEdge: 0, frayedYEdge: 0, opacity: 1, dotShape: "round", invert: false,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
};

describe("desktop halftone parity", () => {
  it("reads older settings as CMYK with a one-pixel outline", () => {
    expect(parseSettings({ ...settings, contrast: 1, exposure: 0 })).toEqual({ ok: true, value: { ...settings, grayscale: false, strokeWidth: 1 } });
  });
  it.each(["triangle", "cross", "circle-outline"])("round-trips %s and new settings", (dotShape) => {
    const input = { ...settings, dotShape, grayscale: true, strokeWidth: 2.5 };
    expect(parseSettings(input)).toEqual({ ok: true, value: input });
  });
  it.each([0, 0.24, 10.01, NaN, Infinity, "1", null])("rejects invalid stroke width %s", (strokeWidth) => {
    expect(parseSettings({ ...settings, strokeWidth })).toEqual({ ok: false, field: "strokeWidth" });
  });
  it.each([0.25, 1, 10])("accepts stroke width %s", (strokeWidth) => {
    expect(parseSettings({ ...settings, strokeWidth }).ok).toBe(true);
  });
  it("rejects non-boolean grayscale", () => {
    expect(parseSettings({ ...settings, grayscale: "true" })).toEqual({ ok: false, field: "grayscale" });
  });
  it("matches desktop gamma on a controlled grayscale ramp", () => {
    for (const gray of [0, 32, 64, 128, 192, 249]) {
      expect(coverageFor("black", gray, gray, gray, { ...settings, grayscale: true }))
        .toBeCloseTo((1 - gray / 255) ** 0.75, 10);
      expect(coverageFor("black", gray, gray, gray, { ...settings, grayscale: true, invert: true }))
        .toBeCloseTo((gray / 255) ** 0.75, 10);
    }
    // Intentional web white-paper cutoff, including inverted output.
    for (const invert of [false, true]) {
      expect(coverageFor("black", 255, 255, 255, { ...settings, grayscale: true, invert })).toBe(0);
    }
  });
  it("uses luminance rather than the CMYK minimum for colored artwork", () => {
    expect(coverageFor("black", 255, 0, 0, { ...settings, grayscale: true }))
      .toBeCloseTo((1 - 76 / 255) ** 0.75, 10);
    expect(coverageFor("black", 255, 0, 0, settings)).toBe(0);
    for (const plate of ["cyan", "magenta", "yellow"] as const) {
      expect(coverageFor(plate, 128, 128, 128, { ...settings, grayscale: true, invert: true })).toBe(0);
    }
    expect(processPlates({ ...settings, grayscale: true })).toEqual(["black"]);
  });
  it("uses the desktop triangle vertices and 28%-width cross bars", () => {
    const context = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), rect: vi.fn(), fill: vi.fn() };
    drawDot(context as unknown as CanvasRenderingContext2D, 50, 50, 100, "triangle");
    expect(context.moveTo).toHaveBeenCalledWith(50, 0);
    expect(context.lineTo.mock.calls).toEqual([[100, 100], [0, 100]]);
    drawDot(context as unknown as CanvasRenderingContext2D, 50, 50, 100, "cross");
    const expected = [[36, 0, 28, 100], [0, 36, 100, 28]];
    context.rect.mock.calls.forEach((call, index) => {
      call.forEach((value, coordinate) => expect(value).toBeCloseTo(expected[index][coordinate], 10));
    });
  });
  it("keeps outlines inside their footprint and fills a ring whose hole closes", () => {
    const context = { beginPath: vi.fn(), arc: vi.fn(), moveTo: vi.fn(), fill: vi.fn() };
    drawDot(context as unknown as CanvasRenderingContext2D, 10, 10, 20, "circle-outline", 2.5);
    expect(context.arc.mock.calls.map((call) => call[2])).toEqual([10, 7.5]);
    context.arc.mockClear();
    drawDot(context as unknown as CanvasRenderingContext2D, 10, 10, 4, "circle-outline", 10);
    expect(context.arc.mock.calls.map((call) => call[2])).toEqual([2]);
  });
});
