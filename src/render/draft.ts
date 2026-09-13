/**
 * Draft-path acceleration: the pieces that make an 8-layer scrub deliver a
 * visible draft inside the 150ms p95 budget without touching the
 * parity-critical exact/export pipeline.
 *
 * 1. DraftFieldCache — a byte-bounded LRU of per-(layer, plate) ink/alpha
 *    fields keyed by a CONSUMER-SUPPLIED content fingerprint
 *    (RenderLayerInput.cacheKey). During a scrub only the edited layer's
 *    fields recompute; the other layers' plate contributions replay from
 *    cache and only the (cheap) composition and proof re-run. The cache
 *    lives per worker/renderer instance, applies to "preview-draft" jobs
 *    ONLY, and is cleared on dispose. Entries are draft-scale fields
 *    (≤1100px edge), so the 96 MiB cap holds ~28 layer-plates at the
 *    largest draft size — far above the 32 the deepest legal stack needs.
 *
 * 2. splatterPlacements — a typed-array dot rasterizer for drafts: analytic
 *    coverage for round dots, 2×2 supersampled inside-tests (the exact
 *    paintDot geometry) for the other shapes. No canvas, no getImageData
 *    readback. Draft output is an APPROXIMATION by contract ("render a
 *    responsive lower-resolution draft; on commit render the exact
 *    viewport") — the exact-viewport and export paths keep the canvas
 *    rasterizer and its bit-parity guarantees. Custom stamps cannot be
 *    sampled without a canvas, so custom-shape layers fall back to the
 *    canvas rasterizer even in drafts.
 *
 * Cached fields are treated as IMMUTABLE by every consumer (composition
 * reads, never writes); the cache accounts its bytes in the allocation
 * ledger under "draft-cache".
 */
import type { DotShape } from "../core/types";
import { noteAlloc, noteRelease } from "./instrumentation";
import type { DotPlacement } from "./kernels/halftone-grid";
import { clamp } from "./raster";

/* ------------------------------------------------------------------ */
/* Draft field cache                                                    */
/* ------------------------------------------------------------------ */

export type DraftFields = {
  /** Rasterized ink coverage (halftone) or mode field ink at output size. */
  ink: Float32Array;
  /** Layer source alpha resampled to output size. */
  alpha: Float32Array;
};

export const DRAFT_CACHE_MAX_BYTES = 96 * 1024 * 1024;

export class DraftFieldCache {
  private readonly entries = new Map<string, DraftFields>();
  private bytes = 0;

  constructor(private readonly maxBytes = DRAFT_CACHE_MAX_BYTES) {}

  get sizeBytes(): number {
    return this.bytes;
  }

  get(key: string): DraftFields | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // LRU touch.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, fields: DraftFields): void {
    const entryBytes = fields.ink.byteLength + fields.alpha.byteLength;
    if (entryBytes > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.ink.byteLength + existing.alpha.byteLength;
      noteRelease(existing.ink.byteLength + existing.alpha.byteLength, "field", "draft-cache");
    }
    this.entries.set(key, fields);
    this.bytes += entryBytes;
    noteAlloc(entryBytes, "field", "draft-cache");
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      const evictedBytes = evicted.ink.byteLength + evicted.alpha.byteLength;
      this.bytes -= evictedBytes;
      noteRelease(evictedBytes, "field", "draft-cache");
    }
  }

  clear(): void {
    if (this.bytes > 0) noteRelease(this.bytes, "field", "draft-cache");
    this.entries.clear();
    this.bytes = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Canvas-free draft dot rasterization                                  */
/* ------------------------------------------------------------------ */

/** Shapes the splatter can rasterize; custom stamps need a canvas. */
export function splatterSupports(shape: DotShape): shape is Exclude<DotShape, "custom"> {
  return shape !== "custom";
}

const SQRT1_2 = Math.SQRT1_2;
const INV_SQRT5 = 1 / Math.sqrt(5);

/**
 * Analytic antialiased coverage of one pixel (center at dx, dy relative to
 * the dot center) for paintDot's shape geometry: a signed-distance edge
 * with a 1px smoothing band (round/diamond/triangle/annulus/capsule) or
 * exact box-overlap area (square/cross). Draft-only approximation.
 */
function shapeCoverage(
  shape: Exclude<DotShape, "custom">,
  dx: number,
  dy: number,
  size: number,
  strokeWidth: number,
): number {
  const radius = size / 2;
  switch (shape) {
    case "square": {
      const overlapX = Math.min(radius, dx + 0.5) - Math.max(-radius, dx - 0.5);
      const overlapY = Math.min(radius, dy + 0.5) - Math.max(-radius, dy - 0.5);
      return overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0;
    }
    case "diamond":
      return clamp(0.5 + (radius - (Math.abs(dx) + Math.abs(dy))) * SQRT1_2);
    case "triangle": {
      // Vertices (0,-r), (r,r), (-r,r): inner distance to the three edges.
      const bottom = radius - dy;
      const right = -(2 * dx - dy - radius) * INV_SQRT5;
      const left = -(-2 * dx - dy - radius) * INV_SQRT5;
      return clamp(0.5 + Math.min(bottom, right, left));
    }
    case "cross": {
      const halfBar = size * 0.14;
      const vx = Math.min(halfBar, dx + 0.5) - Math.max(-halfBar, dx - 0.5);
      const vy = Math.min(radius, dy + 0.5) - Math.max(-radius, dy - 0.5);
      const hx = Math.min(radius, dx + 0.5) - Math.max(-radius, dx - 0.5);
      const hy = Math.min(halfBar, dy + 0.5) - Math.max(-halfBar, dy - 0.5);
      const vertical = vx > 0 && vy > 0 ? vx * vy : 0;
      const horizontal = hx > 0 && hy > 0 ? hx * hy : 0;
      const overlap = vx > 0 && hy > 0 ? vx * hy : 0;
      return clamp(vertical + horizontal - overlap);
    }
    case "circle-outline": {
      const distance = Math.hypot(dx, dy);
      const inner = Math.max(0, radius - strokeWidth);
      return clamp(Math.min(clamp(0.5 + radius - distance) - clamp(0.5 + inner - distance), 1));
    }
    case "line": {
      // Horizontal capsule: half-height 0.16·size, caps at ±(radius − rx).
      const halfHeight = size * 0.16;
      const capX = Math.max(0, radius - halfHeight);
      const qx = Math.max(0, Math.abs(dx) - capX);
      return clamp(0.5 + halfHeight - Math.hypot(qx, dy));
    }
    default:
      return clamp(0.5 + radius - Math.hypot(dx, dy));
  }
}

/**
 * Rasterize dot placements into an ink coverage field without a canvas:
 * analytic per-shape antialiased coverage (shapeCoverage). Overlapping dots
 * compose with source-over alpha, like the canvas path. Draft-only — the
 * exact/export paths keep the canvas rasterizer's bit parity.
 */
export function splatterPlacements(
  placements: DotPlacement[],
  shape: Exclude<DotShape, "custom">,
  strokeWidth: number,
  width: number,
  height: number,
): Float32Array {
  const ink = new Float32Array(width * height);
  noteAlloc(ink.byteLength, "field", "draft-splat");
  for (const dot of placements) {
    if (dot.size <= 0.12) continue;
    const radius = dot.size / 2;
    const reach = radius + 1;
    const left = Math.max(0, Math.floor(dot.x - reach));
    const right = Math.min(width - 1, Math.ceil(dot.x + reach));
    const top = Math.max(0, Math.floor(dot.y - reach));
    const bottom = Math.min(height - 1, Math.ceil(dot.y + reach));
    for (let y = top; y <= bottom; y += 1) {
      const dy = y + 0.5 - dot.y;
      const rowBase = y * width;
      for (let x = left; x <= right; x += 1) {
        const coverage = shapeCoverage(shape, x + 0.5 - dot.x, dy, dot.size, strokeWidth);
        if (coverage <= 0) continue;
        const at = rowBase + x;
        ink[at] = coverage + ink[at] * (1 - coverage);
      }
    }
  }
  return ink;
}
