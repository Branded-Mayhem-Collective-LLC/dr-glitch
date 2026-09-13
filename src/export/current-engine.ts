/**
 * Compatibility RenderService binding to the CURRENT single-layer engine
 * (studio renderHalftone / renderPlateSvg), so composite, plate, and
 * selected-layer export work today. The lead rebinds RenderService to the
 * worker renderer for multi-layer knockout composition; this binding
 * intentionally supports exactly one contributing layer and refuses more
 * with a stable error code instead of producing wrong output.
 *
 * Known deviations, kept deliberately narrow:
 * - "clean" continuous-tone layers are unsupported (the current engine
 *   always screens); code "render-unsupported".
 * - Perspective quads are unsupported here (worker renderer feature).
 * - The engine clamps cells below 3 document px in the pre-warped staging
 *   path (full-artboard sources); the document placement path keeps the
 *   legacy export clamp of 0.01.
 *
 * ROUTING (legacyEngineEligible): production export routes through this
 * binding ONLY when the project is exactly the legacy single-layer shape —
 * one layer, visible, halftone or diffusion mode, uncropped, with the
 * identity transform anchored at the artboard center and a source asset
 * with KNOWN pixel dimensions that either equal the artboard exactly
 * (full-artboard) or differ from it while the artboard is an exact legacy
 * sheet — the shipped engine's document path placed natural-size sources
 * on the sheet natively (calculateArtworkPlacement), so such projects are
 * legacy-representable and this binding renders them through that same
 * document path. Everything else — multi-layer stacks, clean mode, any
 * crop/transform/perspective, unknown asset dimensions, differing sources
 * on artboards that are not exact legacy sheets — renders through the
 * WorkerRenderService. createRoutedRenderService applies the predicate per
 * request against the frozen core.
 */

import type { Id, LayerV1, PlateId, ProjectCoreV1, Sha256 } from "../core/types";
import { getSheetPixelDimensions, type DocumentSettings } from "../studio/document-model";
import { renderHalftone, renderPlateSvg, type RenderOptions } from "../studio/halftone";
import type { CustomShapeAsset } from "../studio/custom-shape-data";
import { RESOURCE_POLICY } from "../core/resource-policy";
import { retainAllocation, yieldToEventLoop } from "../render/instrumentation";
import { LEGACY_DELIVERY_ROWS, legacyCanvasPeakBytes } from "./legacy-memory";
import { documentSettingsFromCore, halftoneSettingsFromCore } from "./job-settings";
import {
  ExportError,
  type RasterData,
  type RenderRequestOptions,
  type RenderService,
} from "./orchestrator";

/* The legacy settings projection moved to job-settings.ts (the manifest
 * builder shares it); re-exported here to keep the public path stable. */
export { halftoneSettingsFromCore } from "./job-settings";

export type CurrentEngineSources = {
  assetDimensions?: AssetDimensionLookup;
  /** Resolves a content-addressed raster/SVG asset to a drawable source. */
  resolveImage(
    assetId: Sha256,
    signal?: AbortSignal,
  ): Promise<HTMLImageElement | HTMLCanvasElement>;
  /** Resolves a sanitized custom-dot/registration SVG asset. */
  resolveCustomShape?(assetId: Sha256): Promise<CustomShapeAsset>;
};

function pickSingleLayer(core: ProjectCoreV1, layerId?: Id): LayerV1 {
  if (layerId !== undefined) {
    const layer = core.layers.find(({ id }) => id === layerId);
    if (!layer) throw new ExportError("render-layer-missing", "The selected layer does not exist.");
    return layer;
  }
  const visible = core.layers.filter((layer) => layer.visible);
  if (visible.length === 0) {
    throw new ExportError("render-unsupported", "There is no visible layer to render.");
  }
  if (visible.length > 1) {
    throw new ExportError(
      "render-unsupported",
      "The compatibility renderer supports one visible layer; multi-layer export needs the worker renderer.",
    );
  }
  return visible[0];
}

function assertRenderable(layer: LayerV1): void {
  if (layer.recipe.mode === "clean") {
    throw new ExportError(
      "render-unsupported",
      "Clean continuous-tone layers need the worker renderer.",
    );
  }
  if (layer.transform.perspective !== null) {
    throw new ExportError(
      "render-unsupported",
      "Perspective transforms need the worker renderer.",
    );
  }
}

/**
 * Stages the layer source onto a white artboard-sized canvas with its
 * affine transform applied (the current engine reads white as "no ink").
 */
function stageLayer(
  core: ProjectCoreV1,
  layer: LayerV1,
  source: HTMLImageElement | HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = core.artboard.widthPx;
  canvas.height = core.artboard.heightPx;
  const context = canvas.getContext("2d");
  if (!context) throw new ExportError("export-failed", "Could not create a staging canvas");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const naturalWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const naturalHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const crop = layer.crop ?? { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
  const { transform } = layer;
  const radians = (transform.rotation * Math.PI) / 180;

  context.save();
  // Document space has a top-left origin; transform.position IS the layer
  // anchor (its center) in that space — a centered layer carries
  // (widthPx / 2, heightPx / 2), matching src/project/factory.ts.
  context.translate(transform.position.x, transform.position.y);
  context.rotate(radians);
  context.transform(
    1,
    Math.tan((transform.skew.y * Math.PI) / 180),
    Math.tan((transform.skew.x * Math.PI) / 180),
    1,
    0,
    0,
  );
  context.scale(
    transform.scale.x * (transform.flipH ? -1 : 1),
    transform.scale.y * (transform.flipV ? -1 : 1),
  );
  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    -crop.width / 2,
    -crop.height / 2,
    crop.width,
    crop.height,
  );
  context.restore();
  return canvas;
}

function registrationOptions(
  core: ProjectCoreV1,
  enabled: boolean,
  registrationShape?: CustomShapeAsset,
): RenderOptions {
  if (!enabled) return { registration: false };
  const { registration } = core;
  return {
    registration: true,
    ...(registration.size !== null ? { registrationSize: registration.size } : {}),
    ...(registration.offset !== null ? { registrationOffset: registration.offset } : {}),
    registrationWeight: registration.weight,
    registrationMode: registration.mode,
    ...(registrationShape ? { registrationShape } : {}),
  };
}

function readRaster(canvas: HTMLCanvasElement): RasterData {
  const context = canvas.getContext("2d");
  const pixels = context?.getImageData(0, 0, canvas.width, canvas.height);
  if (!pixels) throw new ExportError("export-failed", "Could not read the rendered canvas");
  return { width: pixels.width, height: pixels.height, data: pixels.data };
}

/** Resolves an asset's decoded pixel dimensions, or null when unknown. */
export type AssetDimensionLookup = (assetId: Sha256) => { width: number; height: number; byteLength?: number } | null;

/**
 * True when the layer sits uncropped at the artboard center with the exact
 * identity transform (position === (widthPx/2, heightPx/2), scale (1,1),
 * rotation 0, no flips, skew (0,0), perspective null) — the placement
 * createLayerFromAsset produces on import, and the only placement the
 * legacy document engine could represent at scale 1.
 */
function centeredIdentityLayer(core: ProjectCoreV1, layer: LayerV1): boolean {
  if (layer.crop !== null) return false;
  const { transform } = layer;
  return (
    transform.position.x === core.artboard.widthPx / 2 &&
    transform.position.y === core.artboard.heightPx / 2 &&
    transform.scale.x === 1 &&
    transform.scale.y === 1 &&
    transform.rotation === 0 &&
    !transform.flipH &&
    !transform.flipV &&
    transform.skew.x === 0 &&
    transform.skew.y === 0 &&
    transform.perspective === null
  );
}

/**
 * The legacy DocumentSettings projection for the core, but ONLY when the
 * artboard maps to an EXACT legacy sheet (identical pixel dimensions after
 * orientation); null otherwise. renderHalftone's document path derives its
 * output size from the sheet preset, so rendering through it with any
 * other artboard would resize the output — both routing and staging
 * therefore require the exact match.
 */
function exactSheetDocument(core: ProjectCoreV1, layer: LayerV1): DocumentSettings | null {
  const settings = documentSettingsFromCore(core, layer);
  const sheet = getSheetPixelDimensions(settings.sheetSize, settings.orientation);
  return sheet.width === core.artboard.widthPx && sheet.height === core.artboard.heightPx
    ? settings
    : null;
}

/**
 * The exact legacy-vs-worker routing predicate (see module header). True
 * ONLY for: exactly one layer; visible; mode halftone or diffusion; no
 * crop; identity transform anchored at the artboard center; and a source
 * asset whose KNOWN dimensions either equal the artboard, or differ from
 * it while the artboard is an exact legacy sheet (the legacy document
 * path placed natural-size sources on the sheet natively). Unknown
 * dimensions are NOT eligible — the worker renderer is the production
 * path and handles everything.
 */
export function legacyEngineEligible(
  core: ProjectCoreV1,
  assetDimensions?: AssetDimensionLookup,
): boolean {
  if (core.layers.length !== 1) return false;
  const layer = core.layers[0];
  if (!layer.visible) return false;
  if (layer.recipe.mode === "clean") return false;
  if (!centeredIdentityLayer(core, layer)) return false;
  const dimensions = assetDimensions?.(layer.assetId) ?? null;
  if (!dimensions) return false;
  if (
    dimensions.width === core.artboard.widthPx &&
    dimensions.height === core.artboard.heightPx
  ) {
    return true;
  }
  // Source dimensions that merely differ from the artboard are still
  // legacy-representable: the shipped engine staged the source at its
  // natural size and let renderHalftone's document placement
  // (calculateArtworkPlacement) center it on the sheet. Byte-safe only
  // when the artboard IS that sheet.
  return exactSheetDocument(core, layer) !== null;
}

/**
 * PROOF routing predicate — deliberately WIDER than legacyEngineEligible.
 *
 * The live proof (HalftoneStudio render()) draws through the ORIGINAL
 * renderHalftone path with a DocumentSettings projection, which places and
 * scales the artwork onto the sheet itself (scalePercent / mirror). The
 * legacy studio proved EVERY single-artwork project this way, synchronously
 * on the next animation frame — the migrated pixel-parity specs depend on
 * that latency and on the legacy paper/ink math. Export routing keeps the
 * strict legacyEngineEligible (byte parity requires source == artboard);
 * the proof only needs the layer to be EXACTLY representable by
 * DocumentSettings:
 * - one visible screened (halftone/diffusion) layer, uncropped,
 * - anchored at the artboard center (documentFromCore drops position),
 * - uniform scale on a whole scalePercent inside the legacy 10–400% range,
 * - no rotation/skew/perspective, at most one mirror axis
 *   (mirrorDirection is a single choice).
 * Anything else previews through the worker renderer.
 */
export function legacyProofEligible(core: ProjectCoreV1): boolean {
  if (core.layers.length !== 1) return false;
  const layer = core.layers[0];
  if (!layer.visible) return false;
  if (layer.recipe.mode === "clean") return false;
  if (layer.crop !== null) return false;
  const { transform } = layer;
  const scalePercent = transform.scale.x * 100;
  return (
    transform.position.x === core.artboard.widthPx / 2 &&
    transform.position.y === core.artboard.heightPx / 2 &&
    transform.scale.x === transform.scale.y &&
    Number.isInteger(scalePercent) &&
    scalePercent >= 10 &&
    scalePercent <= 400 &&
    transform.rotation === 0 &&
    !(transform.flipH && transform.flipV) &&
    transform.skew.x === 0 &&
    transform.skew.y === 0 &&
    transform.perspective === null
  );
}

export type RoutedRenderServiceOptions = {
  legacy: RenderService;
  worker: RenderService;
  assetDimensions?: AssetDimensionLookup;
};

/**
 * RenderService that applies legacyEngineEligible per request: eligible
 * projects keep byte-exact legacy output through the compatibility binding;
 * everything else renders through the worker service. Selected-layer
 * requests additionally require the requested layer to BE the single legacy
 * layer.
 */
export function createRoutedRenderService(options: RoutedRenderServiceOptions): RenderService {
  const pick = (core: ProjectCoreV1): RenderService =>
    legacyEngineEligible(core, options.assetDimensions) ? options.legacy : options.worker;
  const routed: RenderService = {
    renderComposite: (core, requestOptions) => pick(core).renderComposite(core, requestOptions),
    renderPlate: (core, plate, requestOptions) => pick(core).renderPlate(core, plate, requestOptions),
    renderPlateSvg: (core, plate, requestOptions) =>
      pick(core).renderPlateSvg(core, plate, requestOptions),
    renderLayer: (core, layerId, requestOptions) => {
      const eligible =
        legacyEngineEligible(core, options.assetDimensions) && core.layers[0]?.id === layerId;
      const service = eligible ? options.legacy : options.worker;
      return service.renderLayer(core, layerId, requestOptions);
    },
  };
  // Delivery size must never change the renderer or the resulting pixels.
  if (options.worker.streamPlates || options.legacy.streamPlates) {
    routed.streamRegistration = (core) => pick(core).streamRegistration?.(core) ?? false;
    routed.streamPlates = (core, plates, requestOptions, delivery) => {
      const service = pick(core);
      if (!service.streamPlates) throw new ExportError("stream-unsupported", "The selected renderer cannot stream delivery.");
      return service.streamPlates(core, plates, requestOptions, delivery);
    };
  }
  return routed;
}

export function createCurrentEngineRenderService(sources: CurrentEngineSources): RenderService {
  async function prepare(core: ProjectCoreV1, layerId?: Id, signal?: AbortSignal) {
    const layer = pickSingleLayer(core, layerId);
    assertRenderable(layer);
    const image = await sources.resolveImage(layer.assetId, signal);
    const customShapeId =
      layer.recipe.halftone.dotShape === "custom"
        ? layer.recipe.halftone.customShapeAssetId
        : null;
    const customShape =
      customShapeId !== null && sources.resolveCustomShape
        ? await sources.resolveCustomShape(customShapeId)
        : undefined;
    const registrationShape =
      core.registration.customShapeAssetId !== null && sources.resolveCustomShape
        ? await sources.resolveCustomShape(core.registration.customShapeAssetId)
        : undefined;
    // Legacy-representable sources whose dimensions differ from the artboard
    // go to renderHalftone UNSTAGED at their natural size, with the legacy
    // DocumentSettings, so the engine's own document placement
    // (calculateArtworkPlacement) reproduces shipped semantics byte-exactly.
    // Full-artboard sources (and every other shape reachable through direct
    // calls) keep the pre-warped staging path unchanged.
    const naturalWidth = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    const naturalHeight = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    const fullArtboard =
      naturalWidth === core.artboard.widthPx && naturalHeight === core.artboard.heightPx;
    const documentSettings =
      !fullArtboard && centeredIdentityLayer(core, layer)
        ? exactSheetDocument(core, layer)
        : null;
    return {
      layer,
      staged: documentSettings ? image : stageLayer(core, layer, image),
      ownsStaged: !documentSettings,
      documentSettings,
      settings: halftoneSettingsFromCore(core, layer, customShape),
      registrationShape,
    };
  }

  async function renderRaster(
    core: ProjectCoreV1,
    options: RenderRequestOptions,
    renderOptions: RenderOptions,
    layerId?: Id,
  ): Promise<RasterData> {
    if (options.signal.aborted) throw new ExportError("export-cancelled", "Export cancelled");
    const { staged, ownsStaged, documentSettings, settings, registrationShape } = await prepare(
      core,
      layerId,
      options.signal,
    );
    const target = document.createElement("canvas");
    try {
      options.signal.throwIfAborted();
      renderHalftone(staged, target, settings, {
      width: core.artboard.widthPx,
      height: core.artboard.heightPx,
      ...(documentSettings ? { document: documentSettings } : {}),
      ...renderOptions,
      ...registrationOptions(core, renderOptions.registration ?? false, registrationShape),
      cacheCustomStamps: false,
    });
    options.onProgress?.(1);
    return readRaster(target);
    } finally {
      target.width = target.height = 0;
      if (ownsStaged) staged.width = staged.height = 0;
    }
  }

  return {
    streamRegistration: () => true,
    async streamPlates(core, plates, options, delivery) {
      options.signal.throwIfAborted();
      const source = sources.assetDimensions?.(core.layers[0]?.assetId);
      if (!source || legacyCanvasPeakBytes(core, source) > RESOURCE_POLICY.maxRenderPeakBytes) {
        throw new ExportError("render-peak-exceeded", "The compatibility canvas export exceeds its memory budget. Reduce the artboard or source size.");
      }
      const prepared = await prepare(core, undefined, options.signal);
      const { staged, ownsStaged, settings, documentSettings, registrationShape } = prepared;
      const { widthPx: width, heightPx: height } = core.artboard;
      const releaseStaging = ownsStaged ? retainAllocation(width * height * 4, "canvas", "legacy-staging") : () => undefined;
      try {
        for (const plate of plates) {
          await yieldToEventLoop();
          options.signal.throwIfAborted();
          const target = document.createElement("canvas");
          const releaseCanvas = retainAllocation(width * height * 4, "canvas", "legacy-plate");
          try {
            renderHalftone(staged, target, settings, {
              width, height, ...(documentSettings ? { document: documentSettings } : {}),
              plate, monochromePlate: true, transparent: true,
              cacheCustomStamps: false,
              ...registrationOptions(core, options.registration, registrationShape),
            });
            await delivery.beginPlate(plate, options.signal);
            const context = target.getContext("2d");
            if (!context) throw new ExportError("export-failed", "Could not read the rendered canvas.");
            for (let row = 0; row < height; row += LEGACY_DELIVERY_ROWS) {
              await yieldToEventLoop();
              options.signal.throwIfAborted();
              const count = Math.min(LEGACY_DELIVERY_ROWS, height - row);
              const releaseRows = retainAllocation(width * count * 4, "band", "legacy-delivery");
              try {
                await delivery.writeBand(plate, row, count, context.getImageData(0, row, width, count).data, options.signal);
              } finally { releaseRows(); }
            }
            await delivery.endPlate(plate, options.signal);
          } finally {
            target.width = target.height = 0;
            releaseCanvas();
          }
        }
      } finally {
        if (ownsStaged) staged.width = staged.height = 0;
        releaseStaging();
      }
    },
    renderComposite(core, options) {
      return renderRaster(core, options, {
        plate: "composite",
        registration: options.registration,
        transparent: options.matte === null,
        ...(options.matte !== null ? { paper: options.matte } : {}),
      });
    },
    renderPlate(core, plate: PlateId, options) {
      return renderRaster(core, options, {
        plate,
        registration: options.registration,
        monochromePlate: true,
        transparent: true,
      });
    },
    async renderPlateSvg(core, plate: PlateId, options) {
      if (options.signal.aborted) throw new ExportError("export-cancelled", "Export cancelled");
      const { staged, documentSettings, settings, registrationShape } = await prepare(
        core,
        undefined,
        options.signal,
      );
      const svg = renderPlateSvg(staged, settings, plate, {
        width: core.artboard.widthPx,
        height: core.artboard.heightPx,
        ...(documentSettings ? { document: documentSettings } : {}),
        ...registrationOptions(core, options.registration, registrationShape),
      });
      options.onProgress?.(1);
      return svg;
    },
    renderLayer(core, layerId, options) {
      return renderRaster(
        core,
        options,
        { plate: "composite", registration: options.registration, transparent: true },
        layerId,
      );
    },
  };
}
