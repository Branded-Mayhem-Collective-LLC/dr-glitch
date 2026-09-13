import type { ProjectCoreV1 } from "../core/types";
import { STREAM_ENCODE_FIXED_BYTES } from "../core/stream-memory";

export const LEGACY_DELIVERY_ROWS = 32;

/**
 * Compatibility export retains one canvas while delivering bounded rows.
 * Reserve staging/sample/opacity canvases, sample readback and the legacy
 * coverage, glitch, sort and diffusion intermediates conservatively. This
 * is a canvas render followed by streaming delivery, not a band renderer.
 * The source decode envelope and SVG stamps are additional to sheet pixels.
 */
export function legacyCanvasPeakBytes(
  core: ProjectCoreV1,
  source: { width: number; height: number; byteLength?: number },
): number {
  if (![core.artboard.widthPx, core.artboard.heightPx, source.width, source.height].every((value) => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(source.byteLength ?? 0) || (source.byteLength ?? 0) < 0) return Infinity;
  return core.artboard.widthPx * core.artboard.heightPx * 48
    + source.width * source.height * 8 + (source.byteLength ?? 0) * 3
    + 48 * 1024 * 1024 + STREAM_ENCODE_FIXED_BYTES
    + core.artboard.widthPx * LEGACY_DELIVERY_ROWS * 12;
}
