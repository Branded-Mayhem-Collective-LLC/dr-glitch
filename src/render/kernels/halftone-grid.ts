/**
 * Halftone screen-grid kernel — the rotated lattice walk shared by
 * renderPlateDots and renderPlateSvg in src/studio/halftone.ts, extracted as
 * a pure iterator of dot placements.
 *
 * SCREEN ANCHORING: the lattice is anchored to the artboard center
 * (width / 2, height / 2) with document-global angles. Lattice coordinates
 * depend only on width, height, cell, and angle — never on artwork content
 * or its position — so moving or warping artwork never moves the physical
 * screen. Content bounds only gate which lattice points emit ink.
 *
 * PARITY CONTRACT: placements are bit-identical (same doubles, same order)
 * to the studio walk. The u/v loops intentionally accumulate by repeated
 * addition to reproduce the original floating-point sequence exactly.
 *
 * TILING: `tile` restricts emission to dots whose centers land inside the
 * half-open rectangle [x, x + width) × [y, y + height) in absolute artboard
 * coordinates. Because the lattice enumeration is identical regardless of
 * tile, the union of dots over any exact partition of the plane equals the
 * untiled result.
 */
import { sampleFieldNearest } from "../raster";
import { retainAllocation, type Checkpoint } from "../instrumentation";
import { JS_PLACEMENT_BYTES_PER_DOT } from "../placement-memory";
import type { ContentBounds } from "./coverage";

export type DotPlacement = { x: number; y: number; size: number };

/** A cooperative collection owns an explicit logical-memory receipt. */
export type TrackedDotPlacements = DotPlacement[] & { release(): void };

export type TileRect = { x: number; y: number; width: number; height: number };

export type GridGeometry = {
  /** Output (artboard-space) dimensions in px. */
  width: number;
  height: number;
  /** Coverage-field (sample) dimensions in px. */
  sourceWidth: number;
  sourceHeight: number;
  /** Effective cell size in output px (already clamped; see effectiveCellSize). */
  cell: number;
  /** Document-global screen angle in degrees. */
  angleDegrees: number;
};

/** Dots at or below this size never render; parity with drawDot/renderPlateSvg. */
export const MIN_DOT_SIZE = 0.12;

/** Parity with the studio's `Math.max(minimumCellSize, settings.cellSize * scale)`. */
export function effectiveCellSize(cellSize: number, scale: number, minimumCellSize: number): number {
  return Math.max(minimumCellSize, cellSize * scale);
}

/** Parity with src/studio/halftone.ts estimateGridPoints. */
export function estimateGridPoints(
  width: number,
  height: number,
  cellSize: number,
  angleDegrees: number,
): number {
  const angle = (angleDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const effectiveWidth = width * cos + height * sin;
  const effectiveHeight = width * sin + height * cos;
  const cell = Math.max(1e-6, cellSize);
  const columns = Math.max(1, Math.ceil(effectiveWidth / cell));
  const rows = Math.max(1, Math.ceil(effectiveHeight / cell));

  return columns * rows;
}

/**
 * Candidates the WALKER actually visits: the u/v lattice spans the
 * artboard DIAGONAL (rotation-safe square), not the rotated rectangle —
 * an extreme-aspect artboard can estimate few POINTS yet visit a huge
 * candidate lattice, so admission gates on this number too (the point
 * estimate prices memory; the candidate estimate prices traversal).
 */
/**
 * Grid caps for RASTER halftone targets and for lattice traversal (wave
 * G2). MAX_RASTER_GRID_POINTS bounds placement MEMORY (4M dots ×
 * PLACEMENT_BYTES_PER_DOT ≈ 416 MiB transient worst case, priced in the
 * planner); MAX_GRID_CANDIDATES bounds traversal TIME on the diagonal²
 * candidate lattice for EVERY halftone target — vector included — and is
 * enforced both in preflight admission and at runtime BEFORE any source
 * decode (worker-render-service.assertGridBudget).
 */
export const MAX_RASTER_GRID_POINTS = 4_000_000;
export const MAX_GRID_CANDIDATES = 64_000_000;

export function estimateGridCandidates(width: number, height: number, cellSize: number): number {
  const cell = Math.max(1e-6, cellSize);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const span = diagonal + 2 * cell;
  const steps = Math.max(1, Math.ceil(span / cell) + 1);
  return steps * steps;
}

/**
 * Walk the rotated screen lattice and yield every dot placement whose size
 * clears MIN_DOT_SIZE and whose center falls inside the artwork content
 * bounds (given in source/sample pixels, as from visibleContentBounds).
 */
export function* iterateGridDots(
  field: Float32Array,
  geometry: GridGeometry,
  content: ContentBounds,
  tile?: TileRect,
): Generator<DotPlacement> {
  const { width, height, sourceWidth, sourceHeight, cell } = geometry;
  const angle = (geometry.angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const half = diagonal / 2 + cell;
  const centerX = width / 2;
  const centerY = height / 2;
  const contentMinX = content.minX / sourceWidth * width;
  const contentMinY = content.minY / sourceHeight * height;
  const contentMaxX = content.maxX / sourceWidth * width;
  const contentMaxY = content.maxY / sourceHeight * height;

  for (let u = -half; u <= half; u += cell) {
    for (let v = -half; v <= half; v += cell) {
      const x = centerX + u * cos - v * sin;
      const y = centerY + u * sin + v * cos;
      if (x < -cell || y < -cell || x > width + cell || y > height + cell) continue;
      if (x < contentMinX || x > contentMaxX || y < contentMinY || y > contentMaxY) continue;
      if (tile && (x < tile.x || x >= tile.x + tile.width || y < tile.y || y >= tile.y + tile.height)) continue;
      const coverage = sampleFieldNearest(field, sourceWidth, sourceHeight, (x / width) * sourceWidth, (y / height) * sourceHeight);
      const size = cell * Math.sqrt(coverage) * 1.04;
      if (size <= MIN_DOT_SIZE) continue;
      yield { x, y, size };
    }
  }
}

/** Convenience: collect the walk into an array (tests, small viewports). */
export function collectGridDots(
  field: Float32Array,
  geometry: GridGeometry,
  content: ContentBounds,
  tile?: TileRect,
): DotPlacement[] {
  return [...iterateGridDots(field, geometry, content, tile)];
}

/**
 * Cooperative collectGridDots: the same walk in the same order
 * (bit-identical placements — a parity test pins this loop against
 * iterateGridDots), awaiting `checkpoint` every `dotsPerChunk` emitted
 * dots AND every `candidatesPerChunk` visited lattice CANDIDATES. The
 * candidate checkpoint is the cancellation guarantee for dense lattices
 * that emit little or nothing (zero-coverage / minimum-cell full sheets):
 * emission-only checkpoints would never fire there and the traversal
 * would be an uncancellable busy loop.
 */
export async function collectGridDotsCoop(
  field: Float32Array,
  geometry: GridGeometry,
  content: ContentBounds,
  checkpoint: Checkpoint,
  tile?: TileRect,
  dotsPerChunk = 65_536,
  candidatesPerChunk = 262_144,
): Promise<TrackedDotPlacements> {
  const placements = [] as unknown as TrackedDotPlacements;
  const receipts: Array<() => void> = [];
  let pendingCharge = 0;
  let released = false;
  const flushCharge = () => {
    if (pendingCharge === 0) return;
    receipts.push(
      retainAllocation(
        pendingCharge * JS_PLACEMENT_BYTES_PER_DOT,
        "placements",
        "grid-dot-objects",
      ),
    );
    pendingCharge = 0;
  };
  const release = () => {
    if (released) return;
    released = true;
    placements.length = 0;
    for (const receipt of receipts.splice(0)) receipt();
  };
  Object.defineProperty(placements, "release", {
    value: release,
    enumerable: false,
  });
  let dotsSinceCheckpoint = 0;
  let candidatesSinceCheckpoint = 0;

  // Verbatim iterateGridDots math (kept in lockstep by the parity test);
  // inlined so the candidate counter can await between chunks.
  const { width, height, sourceWidth, sourceHeight, cell } = geometry;
  const angle = (geometry.angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const half = diagonal / 2 + cell;
  const centerX = width / 2;
  const centerY = height / 2;
  const contentMinX = content.minX / sourceWidth * width;
  const contentMinY = content.minY / sourceHeight * height;
  const contentMaxX = content.maxX / sourceWidth * width;
  const contentMaxY = content.maxY / sourceHeight * height;

  try {
    for (let u = -half; u <= half; u += cell) {
      for (let v = -half; v <= half; v += cell) {
        candidatesSinceCheckpoint += 1;
        if (candidatesSinceCheckpoint >= candidatesPerChunk) {
          candidatesSinceCheckpoint = 0;
          flushCharge();
          if (checkpoint) await checkpoint();
        }
        const x = centerX + u * cos - v * sin;
        const y = centerY + u * sin + v * cos;
        if (x < -cell || y < -cell || x > width + cell || y > height + cell) continue;
        if (x < contentMinX || x > contentMaxX || y < contentMinY || y > contentMaxY) continue;
        if (tile && (x < tile.x || x >= tile.x + tile.width || y < tile.y || y >= tile.y + tile.height)) continue;
        const coverage = sampleFieldNearest(field, sourceWidth, sourceHeight, (x / width) * sourceWidth, (y / height) * sourceHeight);
        const size = cell * Math.sqrt(coverage) * 1.04;
        if (size <= MIN_DOT_SIZE) continue;
        placements.push({ x, y, size });
        pendingCharge += 1;
        dotsSinceCheckpoint += 1;
        if (pendingCharge >= 4_096) flushCharge();
        if (dotsSinceCheckpoint >= dotsPerChunk) {
          dotsSinceCheckpoint = 0;
          flushCharge();
          if (checkpoint) await checkpoint();
        }
      }
    }
    flushCharge();
    return placements;
  } catch (error) {
    // Record the partial collection's true peak before dropping it.
    flushCharge();
    release();
    throw error;
  }
}
