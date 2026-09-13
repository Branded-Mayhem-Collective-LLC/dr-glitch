/**
 * Snap engine: pure functions turning a proposed drag position into a
 * snapped delta plus the smart-guide lines to display. Tolerances are given
 * in SCREEN px and converted through zoom, so snapping feels identical at
 * every magnification.
 *
 * Candidate space is document px throughout. Per axis the engine picks the
 * nearest candidate within tolerance; ties within float epsilon all light
 * up as smart-guide lines.
 */

import type { GuidesV1, SnappingV1, Vec2 } from "../core/types";
import type { Bounds } from "./transform";

export type SnapCandidates = {
  /** Vertical guide x positions (doc px). */
  guidesX?: readonly number[];
  /** Horizontal guide y positions (doc px). */
  guidesY?: readonly number[];
  /** Grid spacing in doc px; null/absent disables grid candidates. */
  gridSize?: number | null;
  /** Other (non-moving) layers' doc-space bounds. */
  layerBounds?: readonly Bounds[];
  /** Artboard size; contributes edges and center lines. */
  artboard?: { width: number; height: number } | null;
};

export type SnapResult = {
  /** Correction to ADD to the proposed position/bounds. Zero when no snap. */
  delta: Vec2;
  snappedX: boolean;
  snappedY: boolean;
  /** Doc-px x positions of active vertical smart-guide lines. */
  linesX: number[];
  /** Doc-px y positions of active horizontal smart-guide lines. */
  linesY: number[];
};

const NO_SNAP = (): SnapResult => ({
  delta: { x: 0, y: 0 },
  snappedX: false,
  snappedY: false,
  linesX: [],
  linesY: [],
});

const TIE_EPS = 1e-6;

type AxisPick = { delta: number; lines: number[] };

/**
 * Nearest candidate within tolerance across every (movingValue, candidate)
 * pair on one axis. Grid candidates are generated per moving value as the
 * nearest multiple of `gridSize`.
 */
function pickAxisSnap(
  movingValues: readonly number[],
  candidates: readonly number[],
  gridSize: number | null,
  tolerance: number,
): AxisPick | null {
  let bestDist = Infinity;
  let bestDelta = 0;
  let lines: number[] = [];

  const consider = (moving: number, target: number): void => {
    const dist = Math.abs(target - moving);
    if (dist > tolerance) return;
    if (dist < bestDist - TIE_EPS) {
      bestDist = dist;
      bestDelta = target - moving;
      lines = [target];
    } else if (Math.abs(dist - bestDist) <= TIE_EPS) {
      // Same distance: only collect lines that agree with the chosen delta,
      // so displayed smart guides always match the applied correction.
      if (Math.abs(target - moving - bestDelta) <= TIE_EPS && !lines.includes(target)) {
        lines.push(target);
      }
    }
  };

  for (const moving of movingValues) {
    for (const target of candidates) consider(moving, target);
    if (gridSize != null && gridSize > 0 && Number.isFinite(gridSize)) {
      consider(moving, Math.round(moving / gridSize) * gridSize);
    }
  }

  if (!Number.isFinite(bestDist)) return null;
  // Re-collect agreeing lines now that the final delta is known.
  const finalLines: number[] = [];
  for (const moving of movingValues) {
    const snapped = moving + bestDelta;
    for (const target of candidates) {
      if (Math.abs(target - snapped) <= TIE_EPS && !finalLines.includes(target)) {
        finalLines.push(target);
      }
    }
    if (gridSize != null && gridSize > 0) {
      const g = Math.round(snapped / gridSize) * gridSize;
      if (Math.abs(g - snapped) <= TIE_EPS && !finalLines.includes(g)) {
        finalLines.push(g);
      }
    }
  }
  return { delta: bestDelta, lines: finalLines };
}

function collectCandidates(
  candidates: SnapCandidates,
  snapping: SnappingV1,
): { xs: number[]; ys: number[]; grid: number | null } {
  const xs: number[] = [];
  const ys: number[] = [];
  if (snapping.toGuides) {
    if (candidates.guidesX) xs.push(...candidates.guidesX);
    if (candidates.guidesY) ys.push(...candidates.guidesY);
  }
  if (snapping.toLayers && candidates.layerBounds) {
    for (const b of candidates.layerBounds) {
      xs.push(b.x, b.x + b.width / 2, b.x + b.width);
      ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
  }
  if (snapping.toArtboard && candidates.artboard) {
    const { width, height } = candidates.artboard;
    xs.push(0, width / 2, width);
    ys.push(0, height / 2, height);
  }
  const grid =
    snapping.toGrid && candidates.gridSize != null && candidates.gridSize > 0
      ? candidates.gridSize
      : null;
  return { xs, ys, grid };
}

/**
 * Snap a moving bounds (already at its PROPOSED dragged position). Edges and
 * centers on both axes participate. Returns the correction delta and the
 * smart-guide lines that justify it.
 */
export function computeSnap(
  movingBounds: Bounds,
  candidates: SnapCandidates,
  snapping: SnappingV1,
  tolerancePx: number,
  zoom: number,
): SnapResult {
  if (!snapping.enabled || !(zoom > 0) || !(tolerancePx >= 0)) return NO_SNAP();
  const tolerance = tolerancePx / zoom;
  const { xs, ys, grid } = collectCandidates(candidates, snapping);

  const movingXs = [
    movingBounds.x,
    movingBounds.x + movingBounds.width / 2,
    movingBounds.x + movingBounds.width,
  ];
  const movingYs = [
    movingBounds.y,
    movingBounds.y + movingBounds.height / 2,
    movingBounds.y + movingBounds.height,
  ];

  const px = pickAxisSnap(movingXs, xs, grid, tolerance);
  const py = pickAxisSnap(movingYs, ys, grid, tolerance);

  return {
    delta: { x: px ? px.delta : 0, y: py ? py.delta : 0 },
    snappedX: px !== null,
    snappedY: py !== null,
    linesX: px ? px.lines : [],
    linesY: py ? py.lines : [],
  };
}

/** Snap a single point (guide dragging, corner handles). Same semantics. */
export function computePointSnap(
  point: Vec2,
  candidates: SnapCandidates,
  snapping: SnappingV1,
  tolerancePx: number,
  zoom: number,
): SnapResult {
  if (!snapping.enabled || !(zoom > 0) || !(tolerancePx >= 0)) return NO_SNAP();
  const tolerance = tolerancePx / zoom;
  const { xs, ys, grid } = collectCandidates(candidates, snapping);
  const px = pickAxisSnap([point.x], xs, grid, tolerance);
  const py = pickAxisSnap([point.y], ys, grid, tolerance);
  return {
    delta: { x: px ? px.delta : 0, y: py ? py.delta : 0 },
    snappedX: px !== null,
    snappedY: py !== null,
    linesX: px ? px.lines : [],
    linesY: py ? py.lines : [],
  };
}

export type GuideHit = {
  axis: "horizontal" | "vertical";
  index: number;
};

/**
 * Hit-test a pointer position (doc px) against draggable guides. Locked or
 * hidden guides never hit. Nearest guide within tolerance wins; vertical
 * wins exact ties (it is visually on top in the workspace).
 */
export function hitTestGuides(
  point: Vec2,
  guides: GuidesV1,
  tolerancePx: number,
  zoom: number,
): GuideHit | null {
  if (guides.locked || !guides.visible || !(zoom > 0)) return null;
  const tolerance = tolerancePx / zoom;

  let best: GuideHit | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < guides.vertical.length; i += 1) {
    const dist = Math.abs(guides.vertical[i] - point.x);
    if (dist <= tolerance && dist < bestDist) {
      best = { axis: "vertical", index: i };
      bestDist = dist;
    }
  }
  for (let i = 0; i < guides.horizontal.length; i += 1) {
    const dist = Math.abs(guides.horizontal[i] - point.y);
    if (dist <= tolerance && dist < bestDist) {
      best = { axis: "horizontal", index: i };
      bestDist = dist;
    }
  }
  return best;
}
