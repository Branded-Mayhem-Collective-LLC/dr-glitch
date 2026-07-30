import { describe, expect, it } from "vitest";
import {
  DOCUMENT_DPI,
  SHEET_SIZES,
  calculateArtworkPlacement,
  getSheetPixelDimensions,
} from "../../src/studio/document-model";

describe("Dave-parity document dimensions", () => {
  it("keeps the original eight sheet sizes", () => {
    expect(SHEET_SIZES).toEqual([
      { id: "letter", label: "Letter (8.5×11)", widthInches: 8.5, heightInches: 11 },
      { id: "a4", label: "A4", widthInches: 8.27, heightInches: 11.69 },
      { id: "8x10", label: "8×10 in", widthInches: 8, heightInches: 10 },
      { id: "9x12", label: "9×12 in", widthInches: 9, heightInches: 12 },
      { id: "11x15", label: "11×15 in", widthInches: 11, heightInches: 15 },
      { id: "11x17", label: "11×17 in", widthInches: 11, heightInches: 17 },
      { id: "13x19", label: "13×19 in", widthInches: 13, heightInches: 19 },
      { id: "15x22", label: "15×22 in", widthInches: 15, heightInches: 22 },
    ]);
    expect(DOCUMENT_DPI).toBe(240);
  });

  it.each([
    ["letter", 2040, 2640],
    ["a4", 1985, 2806],
    ["8x10", 1920, 2400],
    ["9x12", 2160, 2880],
    ["11x15", 2640, 3600],
    ["11x17", 2640, 4080],
    ["13x19", 3120, 4560],
    ["15x22", 3600, 5280],
  ] as const)(
    "calculates %s at 240 DPI in portrait and landscape",
    (sheetId, portraitWidth, portraitHeight) => {
      expect(getSheetPixelDimensions(sheetId, "portrait")).toEqual({
        width: portraitWidth,
        height: portraitHeight,
      });
      expect(getSheetPixelDimensions(sheetId, "landscape")).toEqual({
        width: portraitHeight,
        height: portraitWidth,
      });
    },
  );
});

describe("Dave-parity artwork placement", () => {
  it("centers the source at 100% scale", () => {
    expect(
      calculateArtworkPlacement({
        sourceWidth: 1000,
        sourceHeight: 500,
        sheetWidth: 2400,
        sheetHeight: 3000,
        scalePercent: 100,
        offsetX: 0,
        offsetY: 0,
      }),
    ).toEqual({ x: 700, y: 1250, width: 1000, height: 500 });
  });

  it("scales source pixels before centering and applies offsets afterward", () => {
    expect(
      calculateArtworkPlacement({
        sourceWidth: 1000,
        sourceHeight: 500,
        sheetWidth: 2400,
        sheetHeight: 3000,
        scalePercent: 50,
        offsetX: 100,
        offsetY: -75,
      }),
    ).toEqual({ x: 1050, y: 1300, width: 500, height: 250 });
  });

  it("uses integer source dimensions and integer centering like the desktop tool", () => {
    expect(
      calculateArtworkPlacement({
        sourceWidth: 101,
        sourceHeight: 51,
        sheetWidth: 401,
        sheetHeight: 301,
        scalePercent: 50,
        offsetX: 0,
        offsetY: 0,
      }),
    ).toEqual({ x: 175, y: 138, width: 50, height: 25 });
  });
});
