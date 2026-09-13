/**
 * Browser glue for the studio export pipeline: builds the production
 * RenderService (routed legacy/worker), the main-thread custom-registration
 * painter, and the delivery sink from an AssetCache plus the environment
 * probe. HalftoneStudio owns exactly ONE of these per session.
 *
 * Routing: createRoutedRenderService applies legacyEngineEligible per
 * request — the tested predicate is the only parity gate; nothing here
 * special-cases the legacy engine. Multi-layer stacks, clean layers,
 * crops, transforms, and perspective all flow through the
 * WorkerRenderService (export worker in worker-capable engines,
 * MainThreadRenderer elsewhere).
 *
 * Dev-only: withRenderStepDelay installs the Playwright progress/cancel
 * seam (localStorage drglitch.debug.export-tile-delay-ms). Production
 * builds never read the key.
 */

import type { Sha256 } from "../core/types";
import { prepareRegistrationRows } from "./registration-rows";
import { MainThreadRenderer } from "../render";
/* Direct module imports keep parity with the rest of src/app. */
import {
  createCurrentEngineRenderService,
  createRoutedRenderService,
} from "../export/current-engine";
import { createWorkerRenderService } from "../export/worker-render-service";
import type { RenderService } from "../export/orchestrator";
import type { AssetCache } from "./asset-cache";
import type { EnvironmentCapabilities } from "./capabilities";
import {
  registrationLayout,
  withCustomRegistration,
  withRenderStepDelay,
  type CustomRegistrationPainter,
} from "./export-flow";
import { createExportWorker, StreamingWorkerRenderPort } from "./worker-port";

export const EXPORT_DELAY_STORAGE_KEY = "drglitch.debug.export-tile-delay-ms";

/** Dev-build-only per-step delay; production builds always return 0. */
export function readDevExportDelay(): number {
  if (!import.meta.env.DEV) return 0;
  try {
    const value = Number.parseInt(
      window.localStorage.getItem(EXPORT_DELAY_STORAGE_KEY) ?? "",
      10,
    );
    return Number.isFinite(value) ? Math.min(2000, Math.max(0, value)) : 0;
  } catch {
    return 0;
  }
}

/** Main-thread custom registration marks (legacy drawRegistration parity). */
export function createRegistrationPainter(cache: AssetCache): CustomRegistrationPainter {
  const prepareRows: CustomRegistrationPainter["prepareRows"] = async (registration, width, height, signal) => {
    const shapeId = registration.customShapeAssetId;
    if (shapeId === null) throw new Error("Custom registration shape is missing.");
    const shape = await cache.customShapeWhenReady(shapeId);
    signal?.throwIfAborted();
    return prepareRegistrationRows(shape, registration, width, height, signal);
  };
  return {
    prepareRows,
    async paintRaster(raster, registration) {
      if (registration.customShapeAssetId === null) return;
      const painter = await prepareRows(registration, raster.width, raster.height);
      try { await painter.paintRows(raster.data, 0, raster.height); }
      finally { painter.dispose(); }
    },
    async svgFragment(registration, width, height) {
      const shapeId = registration.customShapeAssetId;
      if (shapeId === null) return "";
      const shape = await cache.customShapeWhenReady(shapeId);
      // preserveAspectRatio="none": marks stretch to their square stamp box
      // exactly like the raster drawImage path (canonical stored SVG carries
      // no stretch attribute of its own).
      const symbol = shape.svg
        .replace(/^\s*<svg\b/, '<symbol id="registration-shape" preserveAspectRatio="none"')
        .replace(/<\/svg>\s*$/, "</symbol>");
      const { points, size } = registrationLayout(registration, width, height);
      const uses = points
        .map(
          ([x, y]) =>
            `<use href="#registration-shape" x="${x - size / 2}" y="${y - size / 2}" ` +
            `width="${size}" height="${size}"/>`,
        )
        .join("");
      return `<defs>${symbol}</defs><g opacity="0.7">${uses}</g>`;
    },
  };
}

/** The production RenderService for one open project session. */
export function createStudioRenderService(
  cache: AssetCache,
  env: EnvironmentCapabilities,
  /**
   * Record-backed decoded dimensions (AssetRecordV1 width/height — the
   * SAME source preflight plans with), so runtime plans equal preflight
   * plans even on a cold image cache and no HTMLImageElement is retained
   * for planning. Falls back to the warm image cache when absent.
   */
  recordAssetDimensions?: (
    assetId: Sha256,
  ) => { width: number; height: number; byteLength?: number } | null,
): RenderService {
  const assetDimensions = (
    assetId: Sha256,
  ): { width: number; height: number; byteLength?: number } | null => {
    const fromRecords = recordAssetDimensions?.(assetId);
    if (fromRecords) return fromRecords;
    const image = cache.getImage(assetId);
    return image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
  };
  const worker = createWorkerRenderService({
    sources: {
      // CALLER-OWNED bytes: the worker path transfers (detaches) the
      // resolved buffer with each submit, so it must NEVER receive a
      // cached entry — getTransferableRasterData copies/decodes fresh
      // (detached-cache poisoning regression, wave G2 audit).
      resolveRaster: (assetId, signal) => cache.getTransferableRasterData(assetId, signal),
      resolveCustomStamp: (assetId, sizePx) => cache.getCustomStampBitmap(assetId, sizePx),
      resolveSvgText: async (assetId) => (await cache.customShapeWhenReady(assetId)).svg,
      // Real decoded dimensions feed the planner's settings-aware
      // source-byte model (planLayerModels) — without them plans fall back
      // to output-sized source estimates.
      assetDimensions,
    },
    createPort: () =>
      env.moduleWorkers
        ? new StreamingWorkerRenderPort(createExportWorker)
        : new MainThreadRenderer(false),
  });
  const routed = createRoutedRenderService({
    legacy: createCurrentEngineRenderService({
      assetDimensions,
      resolveImage: (assetId, signal) => cache.imageWhenReady(assetId, signal),
      resolveCustomShape: (assetId) => cache.customShapeWhenReady(assetId),
    }),
    // Custom registration marks are a main-thread pass over the WORKER
    // service only — the legacy engine draws them natively.
    worker: withCustomRegistration(worker, createRegistrationPainter(cache)),
    assetDimensions,
  });
  return withRenderStepDelay(routed, readDevExportDelay);
}
