import { describe, expect, it } from "vitest";

import {
  generateRulerTicks,
  MM_PER_INCH,
  pxToUnit,
  unitToPx,
} from "../../src/editor/rulers";

describe("unit conversions (240 DPI)", () => {
  it("px is the identity", () => {
    expect(pxToUnit(123.5, "px")).toBe(123.5);
    expect(unitToPx(123.5, "px")).toBe(123.5);
  });

  it("known values: 240 px = 1 in = 25.4 mm", () => {
    expect(pxToUnit(240, "in")).toBe(1);
    expect(unitToPx(1, "in")).toBe(240);
    expect(pxToUnit(240, "mm")).toBe(MM_PER_INCH);
    expect(unitToPx(MM_PER_INCH, "mm")).toBeCloseTo(240, 10);
  });

  it("round-trips exactly within tolerance for all units", () => {
    const values = [0, 1, 7, 240, 1234.56, 99999];
    for (const unit of ["px", "in", "mm"] as const) {
      for (const px of values) {
        expect(unitToPx(pxToUnit(px, unit), unit)).toBeCloseTo(px, 9);
      }
      for (const v of values) {
        expect(pxToUnit(unitToPx(v, unit), unit)).toBeCloseTo(v, 9);
      }
    }
  });
});

describe("generateRulerTicks", () => {
  it("px ruler at zoom 1: minor 10, major 100, labeled majors", () => {
    const ticks = generateRulerTicks({
      unit: "px",
      zoom: 1,
      viewportStartDocPx: 0,
      viewportLengthScreenPx: 500,
    });
    expect(ticks).toHaveLength(51); // 0..500 step 10
    const majors = ticks.filter((t) => t.kind === "major");
    expect(majors.map((t) => t.docPx)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(majors.map((t) => t.label)).toEqual([
      "0",
      "100",
      "200",
      "300",
      "400",
      "500",
    ]);
    const minor = ticks.find((t) => t.docPx === 10);
    expect(minor?.kind).toBe("minor");
    expect(minor?.label).toBeNull();
    expect(minor?.screenPx).toBe(10);
  });

  it("px ruler at zoom 0.25 widens steps (major 500, minor 50)", () => {
    const ticks = generateRulerTicks({
      unit: "px",
      zoom: 0.25,
      viewportStartDocPx: 0,
      viewportLengthScreenPx: 500, // 2000 doc px visible
    });
    const majors = ticks.filter((t) => t.kind === "major");
    expect(majors.map((t) => t.docPx)).toEqual([0, 500, 1000, 1500, 2000]);
    const minors = ticks.filter((t) => t.kind === "minor");
    expect(minors[0].docPx).toBe(50);
    // Screen position respects zoom.
    expect(majors[1].screenPx).toBe(125);
  });

  it("px ruler at high zoom refines steps below 10", () => {
    const ticks = generateRulerTicks({
      unit: "px",
      zoom: 16,
      viewportStartDocPx: 0,
      viewportLengthScreenPx: 320, // 20 doc px visible
    });
    const majors = ticks.filter((t) => t.kind === "major");
    // 5 px * 16 = 80 screen px >= 56.
    expect(majors.map((t) => t.docPx)).toEqual([0, 5, 10, 15, 20]);
  });

  it("inch ruler at zoom 1 uses quarter-inch majors with binary minors", () => {
    const ticks = generateRulerTicks({
      unit: "in",
      zoom: 1,
      viewportStartDocPx: 0,
      viewportLengthScreenPx: 480, // 2 inches
    });
    const majors = ticks.filter((t) => t.kind === "major");
    // 1/4 in * 240 px = 60 screen px >= 56.
    expect(majors.map((t) => t.label)).toEqual([
      "0",
      "0.25",
      "0.5",
      "0.75",
      "1",
      "1.25",
      "1.5",
      "1.75",
      "2",
    ]);
    // Minor step is a binary fraction: 1/32 in = 7.5 px at zoom 1.
    expect(ticks[1].docPx).toBeCloseTo(unitToPx(1 / 32, "in"), 9);
  });

  it("mm ruler at zoom 1 picks 1-2-5 series steps", () => {
    const ticks = generateRulerTicks({
      unit: "mm",
      zoom: 1,
      viewportStartDocPx: 0,
      viewportLengthScreenPx: 240, // 25.4 mm
    });
    const majors = ticks.filter((t) => t.kind === "major");
    // 1 mm ~ 9.45 px; 10 mm ~ 94.5 px >= 56 -> major 10 mm.
    expect(majors.map((t) => t.label)).toEqual(["0", "10", "20"]);
    // Minor 1 mm.
    expect(pxToUnit(ticks[1].docPx, "mm")).toBeCloseTo(1, 9);
  });

  it("handles offset viewports and negative document positions", () => {
    const ticks = generateRulerTicks({
      unit: "px",
      zoom: 1,
      viewportStartDocPx: -120,
      viewportLengthScreenPx: 240,
    });
    const majors = ticks.filter((t) => t.kind === "major");
    expect(majors.map((t) => t.docPx)).toEqual([-100, 0, 100]);
    expect(majors.map((t) => t.label)).toEqual(["-100", "0", "100"]);
    expect(majors[0].screenPx).toBe(20);
  });

  it("returns [] for degenerate zoom or viewport", () => {
    expect(
      generateRulerTicks({
        unit: "px",
        zoom: 0,
        viewportStartDocPx: 0,
        viewportLengthScreenPx: 100,
      }),
    ).toEqual([]);
    expect(
      generateRulerTicks({
        unit: "px",
        zoom: NaN,
        viewportStartDocPx: 0,
        viewportLengthScreenPx: 100,
      }),
    ).toEqual([]);
    expect(
      generateRulerTicks({
        unit: "px",
        zoom: 1,
        viewportStartDocPx: 0,
        viewportLengthScreenPx: 0,
      }),
    ).toEqual([]);
  });
});
