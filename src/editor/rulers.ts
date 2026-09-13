/**
 * Unit-aware ruler math at the fixed document DPI (240).
 *
 * Storage is always document px; px/in/mm are reversible display units.
 * Tick generation picks a major step whose on-screen spacing clears a
 * readable minimum, then divides it into minors, so minor ticks always
 * subdivide majors exactly.
 */

import { DOCUMENT_DPI, type UnitPreference } from "../core/types";

export const MM_PER_INCH = 25.4;

/** Convert document px to the display unit (exact, reversible). */
export function pxToUnit(
  px: number,
  unit: UnitPreference,
  dpi: number = DOCUMENT_DPI,
): number {
  switch (unit) {
    case "px":
      return px;
    case "in":
      return px / dpi;
    case "mm":
      return (px / dpi) * MM_PER_INCH;
  }
}

/** Convert a display-unit value to document px (exact, reversible). */
export function unitToPx(
  value: number,
  unit: UnitPreference,
  dpi: number = DOCUMENT_DPI,
): number {
  switch (unit) {
    case "px":
      return value;
    case "in":
      return value * dpi;
    case "mm":
      return (value / MM_PER_INCH) * dpi;
  }
}

export type RulerTick = {
  /** Position in document px. */
  docPx: number;
  /** Position in screen px relative to the viewport origin. */
  screenPx: number;
  kind: "major" | "minor";
  /** Formatted unit value; only major ticks carry labels. */
  label: string | null;
};

export type RulerTickOptions = {
  unit: UnitPreference;
  /** Screen px per document px. */
  zoom: number;
  /** Document px at the viewport's ruler origin. */
  viewportStartDocPx: number;
  /** Ruler length in screen px. */
  viewportLengthScreenPx: number;
  dpi?: number;
  /** Minimum screen px between minor ticks (default 6). */
  minMinorSpacingPx?: number;
  /** Minimum screen px between major (labeled) ticks (default 56). */
  minMajorSpacingPx?: number;
};

/** 1-2-5 decade series for px and mm. */
function decimalSteps(): number[] {
  const steps: number[] = [];
  for (let decade = 0.001; decade <= 1_000_000; decade *= 10) {
    steps.push(decade, decade * 2, decade * 5);
  }
  return steps;
}

/** Binary fractions then 1-2-5 whole values for inches. */
function inchSteps(): number[] {
  const steps: number[] = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2];
  for (let decade = 1; decade <= 1_000_000; decade *= 10) {
    steps.push(decade, decade * 2, decade * 5);
  }
  return steps;
}

/** Minor subdivisions tried largest-first; inches subdivide in halves. */
const DECIMAL_DIVISORS = [10, 5, 4, 2, 1];
const INCH_DIVISORS = [8, 4, 2, 1];

function formatUnitValue(value: number): string {
  // Snap float noise; String() never prints trailing zeros.
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * Generate ruler ticks covering the viewport. Deterministic and pure.
 * Returns [] when zoom or viewport are degenerate.
 */
export function generateRulerTicks(options: RulerTickOptions): RulerTick[] {
  const {
    unit,
    zoom,
    viewportStartDocPx,
    viewportLengthScreenPx,
    dpi = DOCUMENT_DPI,
    minMinorSpacingPx = 6,
    minMajorSpacingPx = 56,
  } = options;

  if (
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    !Number.isFinite(viewportStartDocPx) ||
    !Number.isFinite(viewportLengthScreenPx) ||
    viewportLengthScreenPx <= 0
  ) {
    return [];
  }

  const steps = unit === "in" ? inchSteps() : decimalSteps();

  // Screen px per unit value of 1.
  const unitScreenScale = unitToPx(1, unit, dpi) * zoom;

  let majorStep = steps[steps.length - 1];
  for (const step of steps) {
    if (step * unitScreenScale >= minMajorSpacingPx) {
      majorStep = step;
      break;
    }
  }

  const divisors = unit === "in" ? INCH_DIVISORS : DECIMAL_DIVISORS;
  let divisor = 1;
  for (const d of divisors) {
    if ((majorStep / d) * unitScreenScale >= minMinorSpacingPx) {
      divisor = d;
      break;
    }
  }
  const minorStep = majorStep / divisor;

  const startUnit = pxToUnit(viewportStartDocPx, unit, dpi);
  const endUnit = pxToUnit(
    viewportStartDocPx + viewportLengthScreenPx / zoom,
    unit,
    dpi,
  );

  const kStart = Math.ceil(startUnit / minorStep - 1e-9);
  const kEnd = Math.floor(endUnit / minorStep + 1e-9);

  const ticks: RulerTick[] = [];
  for (let k = kStart; k <= kEnd; k += 1) {
    const value = k * minorStep + 0; // + 0 normalizes -0

    const docPx = unitToPx(value, unit, dpi);
    const isMajor = ((k % divisor) + divisor) % divisor === 0;
    ticks.push({
      docPx,
      screenPx: (docPx - viewportStartDocPx) * zoom,
      kind: isMajor ? "major" : "minor",
      label: isMajor ? formatUnitValue(value) : null,
    });
  }
  return ticks;
}
