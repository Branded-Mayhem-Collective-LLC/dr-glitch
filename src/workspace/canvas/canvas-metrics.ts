/**
 * Canvas measurement helpers — the single doc↔screen mapping used by
 * rulers, guides, and transform overlays. The visible canvas is CSS-scaled
 * (artboard-wrap width tracks the zoom control), so screen px per document
 * px is simply displayedWidth / artboard.widthPx.
 */

import type { Vec2 } from "../../core/types";

export type CanvasMetrics = {
  /** Screen px per document px. */
  scale: number;
  /** Canvas rect in viewport coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
};

export function measureCanvas(
  canvas: HTMLElement | null,
  artboardWidthPx: number,
): CanvasMetrics | null {
  if (!canvas || artboardWidthPx <= 0) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return {
    scale: rect.width / artboardWidthPx,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Client (viewport) coordinates → document px. */
export function docPointFromClient(
  metrics: CanvasMetrics,
  clientX: number,
  clientY: number,
): Vec2 {
  return {
    x: (clientX - metrics.left) / metrics.scale,
    y: (clientY - metrics.top) / metrics.scale,
  };
}
