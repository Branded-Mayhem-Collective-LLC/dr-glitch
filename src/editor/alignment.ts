/**
 * Alignment and distribution over document-space bounds. Pure: callers pass
 * each participating (unlocked) layer's doc-space bounds and receive
 * per-layer position deltas to feed into a transform transaction.
 */

import type { Vec2 } from "../core/types";
import { type Bounds, unionBounds } from "./transform";

export type AlignMode =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

export type DistributeAxis = "horizontal" | "vertical";

export type AlignItem = {
  id: string;
  bounds: Bounds;
};

export type AlignDelta = {
  id: string;
  delta: Vec2;
};

/** Hull of the selection; null for an empty selection. */
export function selectionBounds(items: readonly AlignItem[]): Bounds | null {
  return unionBounds(items.map((item) => item.bounds));
}

/**
 * Align items to a reference rect (selection hull or artboard rect).
 * Returns one delta per item; unaffected axes are zero. With a single item
 * and a selection reference the delta is zero by construction.
 */
export function alignBounds(
  items: readonly AlignItem[],
  mode: AlignMode,
  reference: Bounds,
): AlignDelta[] {
  return items.map(({ id, bounds }) => {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = reference.x - bounds.x;
        break;
      case "centerX":
        dx =
          reference.x + reference.width / 2 - (bounds.x + bounds.width / 2);
        break;
      case "right":
        dx = reference.x + reference.width - (bounds.x + bounds.width);
        break;
      case "top":
        dy = reference.y - bounds.y;
        break;
      case "centerY":
        dy =
          reference.y + reference.height / 2 - (bounds.y + bounds.height / 2);
        break;
      case "bottom":
        dy = reference.y + reference.height - (bounds.y + bounds.height);
        break;
    }
    return { id, delta: { x: dx, y: dy } };
  });
}

/** Align relative to the selection hull. Empty selection yields []. */
export function alignToSelection(
  items: readonly AlignItem[],
  mode: AlignMode,
): AlignDelta[] {
  const reference = selectionBounds(items);
  if (!reference) return [];
  return alignBounds(items, mode, reference);
}

/**
 * Distribute items with EQUAL GAPS along one axis.
 *
 * - reference null (selection): the outermost items stay fixed; the space
 *   between them is divided so every adjacent gap is identical. Requires at
 *   least 3 items; fewer yields zero deltas.
 * - reference rect (artboard): the first item is pinned to the reference
 *   start, the last to the reference end, gaps equalized between. Requires
 *   at least 2 items.
 *
 * Items are ordered by their leading edge; equal edges fall back to id
 * order for determinism. Gaps may be negative when items overfill the span
 * (consistent with standard editors).
 */
export function distributeBounds(
  items: readonly AlignItem[],
  axis: DistributeAxis,
  reference: Bounds | null = null,
): AlignDelta[] {
  const horizontal = axis === "horizontal";
  const pos = (b: Bounds): number => (horizontal ? b.x : b.y);
  const size = (b: Bounds): number => (horizontal ? b.width : b.height);

  const zero = (): AlignDelta[] =>
    items.map(({ id }) => ({ id, delta: { x: 0, y: 0 } }));

  const minCount = reference ? 2 : 3;
  if (items.length < minCount) return zero();

  const sorted = [...items].sort(
    (a, b) => pos(a.bounds) - pos(b.bounds) || a.id.localeCompare(b.id),
  );

  let spanStart: number;
  let spanEnd: number;
  if (reference) {
    spanStart = pos(reference);
    spanEnd = pos(reference) + size(reference);
  } else {
    spanStart = pos(sorted[0].bounds);
    const last = sorted[sorted.length - 1];
    spanEnd = pos(last.bounds) + size(last.bounds);
  }

  let totalSize = 0;
  for (const item of sorted) totalSize += size(item.bounds);
  const gap = (spanEnd - spanStart - totalSize) / (sorted.length - 1);

  const deltas = new Map<string, number>();
  let cursor = spanStart;
  for (const item of sorted) {
    deltas.set(item.id, cursor - pos(item.bounds));
    cursor += size(item.bounds) + gap;
  }

  return items.map(({ id }) => {
    const d = deltas.get(id) ?? 0;
    return { id, delta: horizontal ? { x: d, y: 0 } : { x: 0, y: d } };
  });
}
