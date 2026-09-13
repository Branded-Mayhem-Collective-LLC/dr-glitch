/**
 * Environment capability probe — the ONE place the app feature-detects the
 * platform APIs the render/export stack cares about. Consumers receive a
 * plain data object instead of sniffing globals themselves:
 *
 * - PreviewService / worker-port: `moduleWorkers` picks the preview worker
 *   vs the MainThreadRenderer fallback; `offscreenCanvas` predicts whether
 *   results arrive composed ("bitmap"/"plates") or as reduced "layer-data".
 * - Preflight / export: `preflightCapabilitiesFrom` feeds the probe into
 *   src/export/preflight's `capabilities` option so rules bind to REAL
 *   detected values rather than preflight's internal fallback sniffing.
 *
 * Pure: `probeEnvironmentCapabilities` reads only the scope it is given
 * (defaults to globalThis), so node tests can exercise every combination.
 */

import type { PreflightCapabilities } from "../export/preflight";

export type EnvironmentCapabilities = {
  /** `Worker` constructor exists (Vite module workers are usable). */
  moduleWorkers: boolean;
  /** OffscreenCanvas exists — workers can compose plates off-thread. */
  offscreenCanvas: boolean;
  /** createImageBitmap exists — proof results can transfer as bitmaps. */
  createImageBitmap: boolean;
  /** File System Access save picker exists (Chromium large-export streaming). */
  fileSystemAccess: boolean;
};

type ProbeScope = Record<string, unknown>;

/** Feature-detect the given scope (globalThis by default). Never throws. */
export function probeEnvironmentCapabilities(
  scope: ProbeScope = globalThis as ProbeScope,
): EnvironmentCapabilities {
  return {
    moduleWorkers: typeof scope["Worker"] === "function",
    offscreenCanvas: typeof scope["OffscreenCanvas"] !== "undefined",
    createImageBitmap: typeof scope["createImageBitmap"] === "function",
    fileSystemAccess: typeof scope["showSaveFilePicker"] === "function",
  };
}

/** Projection for src/export/preflight's `capabilities` option. */
export function preflightCapabilitiesFrom(
  env: EnvironmentCapabilities,
): Required<PreflightCapabilities> {
  return {
    offscreenCanvas: env.offscreenCanvas,
    fileSystemAccess: env.fileSystemAccess,
  };
}

/** Which render port the preview should construct in this environment. */
export function previewPortKindFor(
  env: EnvironmentCapabilities,
): "worker" | "main-thread" {
  return env.moduleWorkers ? "worker" : "main-thread";
}
