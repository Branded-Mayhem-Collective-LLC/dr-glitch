/**
 * Plate-package job manifest (job-settings.json) builder.
 *
 * The manifest is a SUPERSET of two contracts:
 *
 * 1. The legacy content contract of the shipped studio's exportArtwork()
 *    (git HEAD src/studio/HalftoneStudio.tsx — raster manifest at lines
 *    737–768, SVG manifest at lines 664–673): `source`, `document`
 *    (DocumentSettings), `settings` (the full HalftoneSettings echo,
 *    including customShape), the registration scalar fields, and the
 *    legacy `output` block ({width, height, dpi} plus, for raster
 *    packages, estimatedMarksPerPlate / worstPlate / worstAngle from the
 *    screen-load estimate). SVG packages additionally carry the legacy
 *    `plates`, `fill: "#000000"`, and `vector: true` markers. Undefined
 *    values are omitted exactly as legacy JSON.stringify dropped them
 *    (no customShape → no key; no registration SVG → no key).
 *
 * 2. The workstation contract: `schema`, `revision`, and `target` bind the
 *    manifest to the frozen project revision for revision-bound
 *    confirmations, and `omittedPlates` records hidden plates left out of
 *    the package (legacy "Omitted plates" job-ticket semantics: plates of
 *    the active color mode whose separation visibility is off — grayscale
 *    packages therefore only ever omit a hidden K, never C/M/Y). The
 *    document-level output defaults live under `outputDefaults` so the
 *    legacy `output` block keeps its name.
 *
 * Value derivation follows src/app/legacy-bridge.ts (documentFromCore /
 * sheetForArtboard) and halftoneSettingsFromCore so the manifest echoes
 * exactly what the render pipeline consumed — the migrated custom-shape
 * spec re-renders plates from this manifest and demands pixel equality.
 */

import type {
  ArtboardV1,
  LayerV1,
  PlateId,
  ProjectCoreV1,
} from "../core/types";
import type { CustomShapeAsset } from "../studio/custom-shape-data";
import {
  getSheetPixelDimensions,
  SHEET_SIZES,
  type DocumentSettings,
  type Orientation,
  type SheetSizeId,
} from "../studio/document-model";
import { estimateGridPoints, type HalftoneSettings } from "../studio/halftone";
import { GLITCH_DEFAULTS } from "../studio/settings-defaults";
import type { PlatePackageTarget } from "./targets";

/* ------------------------------------------------------------------ */
/* Core -> legacy HalftoneSettings                                     */
/* ------------------------------------------------------------------ */

/** Maps a core layer + document-global settings onto the legacy settings shape. */
export function halftoneSettingsFromCore(
  core: ProjectCoreV1,
  layer: LayerV1,
  customShape?: CustomShapeAsset,
): HalftoneSettings {
  const { halftone, diffusion, glitch, mode } = layer.recipe;
  return {
    cellSize: halftone.cellSize,
    frayedXEdge: halftone.frayedXEdge,
    frayedYEdge: halftone.frayedYEdge,
    opacity: layer.opacity,
    dotShape: halftone.dotShape,
    invert: mode === "diffusion" ? diffusion.invert : halftone.invert,
    grayscale: core.separation.mode === "grayscale",
    strokeWidth: halftone.strokeWidth,
    ...(customShape ? { customShape } : {}),
    angles: core.separation.angles,
    visible: core.separation.visible,
    diffusionEnabled: mode === "diffusion",
    diffusionAlgorithm: diffusion.algorithm,
    diffusionModulation: diffusion.modulation,
    diffusionModStrength: diffusion.modStrength,
    diffusionIntensity: diffusion.intensity,
    diffusionLevels: diffusion.levels,
    diffusionSharpenStrength: diffusion.sharpenStrength,
    diffusionSharpenRadius: diffusion.sharpenRadius,
    diffusionDenoise: diffusion.denoise,
    brokenKernel: diffusion.brokenKernel,
    directionalBias: diffusion.directionalBias,
    directionalBiasAngle: diffusion.directionalBiasAngle,
    errorOverflow: diffusion.errorOverflow,
    diffusionReset: diffusion.reset,
    crossChannelBleed: diffusion.crossChannelBleed,
    ...(glitch.enabled
      ? {
          sliceShift: glitch.sliceShift,
          sliceSize: glitch.sliceSize,
          verticalSliceShift: glitch.verticalSliceShift,
          verticalSliceSize: glitch.verticalSliceSize,
          gridWarp: glitch.gridWarp,
          warpScale: glitch.warpScale,
          smearDrag: glitch.smearDrag,
          smearLength: glitch.smearLength,
          smearVertical: glitch.smearVertical,
          macroblockCorrupt: glitch.macroblockCorrupt,
          macroblockDropout: glitch.macroblockDropout,
          blockShift: glitch.blockShift,
          blockShiftSize: glitch.blockShiftSize,
          channelDesync: glitch.channelDesync,
          bitmapSort: glitch.bitmapSort,
          bitmapSortVertical: glitch.bitmapSortVertical,
        }
      : GLITCH_DEFAULTS),
  };
}

/* ------------------------------------------------------------------ */
/* Core -> legacy DocumentSettings                                     */
/* ------------------------------------------------------------------ */

/**
 * Sheet preset + orientation matching the artboard, defaulting to 11x15.
 * Parity clone of sheetForArtboard in src/app/legacy-bridge.ts (that module
 * sits above this layer and cannot be imported without a cycle; the
 * legacy-bridge unit suite pins both to the same behavior).
 */
function sheetForArtboard(artboard: ArtboardV1): {
  sheetSize: SheetSizeId;
  orientation: Orientation;
} {
  const orientation: Orientation =
    artboard.widthPx > artboard.heightPx ? "landscape" : "portrait";
  const byPreset = SHEET_SIZES.find(({ id }) => id === artboard.presetId);
  if (byPreset) return { sheetSize: byPreset.id, orientation };
  const byDims = SHEET_SIZES.find(({ id }) => {
    const portrait = getSheetPixelDimensions(id, "portrait");
    return (
      (portrait.width === artboard.widthPx && portrait.height === artboard.heightPx) ||
      (portrait.width === artboard.heightPx && portrait.height === artboard.widthPx)
    );
  });
  return { sheetSize: byDims?.id ?? "11x15", orientation };
}

/**
 * Legacy DocumentSettings projection (documentFromCore parity —
 * src/app/legacy-bridge.ts). scalePercent and mirror live on the primary
 * layer's transform; with no layer the defaults apply.
 */
export function documentSettingsFromCore(
  core: ProjectCoreV1,
  layer: LayerV1 | null,
): DocumentSettings {
  const { sheetSize, orientation } = sheetForArtboard(core.artboard);
  const scale = layer ? layer.transform.scale.x : 1;
  const flipH = layer?.transform.flipH ?? false;
  const flipV = layer?.transform.flipV ?? false;
  return {
    sheetSize,
    orientation,
    scalePercent: Math.min(400, Math.max(10, Math.round(scale * 100))),
    background: core.artboard.background === "black" ? "black" : "white",
    mirrorImage: flipH || flipV,
    mirrorDirection: flipV && !flipH ? "vertical" : "horizontal",
  };
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

/**
 * The layer whose recipe the manifest echoes: the topmost visible layer
 * (the studio's default primary layer), falling back to the topmost layer.
 * Matches the single-layer legacy shape exactly when only one layer exists.
 */
export function manifestLayer(core: ProjectCoreV1): LayerV1 | null {
  for (let index = core.layers.length - 1; index >= 0; index -= 1) {
    if (core.layers[index].visible) return core.layers[index];
  }
  return core.layers[core.layers.length - 1] ?? null;
}

/** Plates of the active color mode (legacy processPlates over the core). */
function modePlates(core: ProjectCoreV1): PlateId[] {
  return core.separation.mode === "grayscale"
    ? ["black"]
    : ["cyan", "magenta", "yellow", "black"];
}

/**
 * Legacy omittedPlates semantics: plates that belong to the active color
 * mode but are hidden, and therefore left out of the package. Grayscale
 * never lists C/M/Y — they are not applicable plates, not omissions.
 */
export function omittedPlates(core: ProjectCoreV1): PlateId[] {
  return modePlates(core).filter((plate) => !core.separation.visible[plate]);
}

/**
 * Legacy screen-load estimate (HalftoneStudio screenLoad): the worst
 * exported plate by estimated grid marks at the output dimensions.
 */
function screenLoad(
  core: ProjectCoreV1,
  plates: PlateId[],
  cellSize: number,
): { marks: number; plate: PlateId | null } {
  return plates.reduce<{ marks: number; plate: PlateId | null }>(
    (worst, plate) => {
      const marks = estimateGridPoints(
        core.artboard.widthPx,
        core.artboard.heightPx,
        cellSize,
        core.separation.angles[plate],
      );
      return marks > worst.marks ? { marks, plate } : worst;
    },
    { marks: 0, plate: null },
  );
}

export type PlateJobSettingsOptions = {
  core: ProjectCoreV1;
  revision: number;
  target: PlatePackageTarget;
  /**
   * The ARTWORK SOURCE name (primary layer's original filename) — the
   * legacy manifest's `source` field. NOT the project title: renaming a
   * project never changes press artifacts.
   */
  sourceName: string;
  /** Registration marks resolved for this job (resolveRegistration). */
  registration: boolean;
  /** Plates the package actually contains, in export order. */
  plates: PlateId[];
  dpi: number;
  /** Resolved custom dot shape when the primary recipe uses one. */
  customShape?: CustomShapeAsset | undefined;
  /** Resolved custom registration mark SVG when the document has one. */
  registrationShape?: CustomShapeAsset | undefined;
};

/**
 * Serialized job-settings.json for a plate package (raster and SVG get the
 * same content treatment; SVG adds the legacy vector markers). Formatted
 * with the legacy 2-space indent.
 */
export function buildPlateJobSettings(options: PlateJobSettingsOptions): string {
  const { core, target, sourceName, registration, plates, dpi } = options;
  const layer = manifestLayer(core);
  const settings = layer
    ? halftoneSettingsFromCore(core, layer, options.customShape)
    : undefined;
  const width = core.artboard.widthPx;
  const height = core.artboard.heightPx;
  const load =
    target.format === "svg" || !settings
      ? null
      : screenLoad(core, plates, settings.cellSize);

  const manifest = {
    /* Workstation contract: revision-bound confirmations. */
    schema: 1,
    revision: options.revision,
    target: { kind: target.kind, format: target.format },
    /* Legacy content contract (shipped exportArtwork manifest). */
    source: sourceName,
    document: documentSettingsFromCore(core, layer),
    ...(settings ? { settings } : {}),
    plates,
    omittedPlates: omittedPlates(core),
    registration,
    ...(core.registration.size !== null ? { registrationSize: core.registration.size } : {}),
    ...(core.registration.offset !== null
      ? { registrationOffset: core.registration.offset }
      : {}),
    registrationWeight: core.registration.weight,
    ...(options.registrationShape ? { registrationShape: options.registrationShape } : {}),
    registrationMode: core.registration.mode,
    output:
      load === null
        ? { width, height, dpi }
        : {
            width,
            height,
            dpi,
            estimatedMarksPerPlate: load.marks,
            worstPlate: load.plate,
            worstAngle: load.plate === null ? null : core.separation.angles[load.plate],
          },
    ...(target.format === "svg" ? { fill: "#000000", vector: true } : {}),
    /* Workstation additions preserved from the first manifest schema. */
    /* Truthful multi-layer listing: the legacy single-layer echo above
     * (`source`/`settings`) reflects the PRIMARY layer for compatibility;
     * this lists every layer the package actually composed, in stack
     * order, so multi-layer manifests are not silently single-layer. */
    layers: core.layers.map((entry) => ({
      source: entry.name,
      visible: entry.visible,
      mode: entry.recipe.mode,
      opacity: entry.opacity,
      dotShape: entry.recipe.halftone.dotShape,
      cellSize: entry.recipe.halftone.cellSize,
    })),
    dpi,
    artboard: { widthPx: width, heightPx: height },
    separation: core.separation,
    outputDefaults: core.output,
  };
  return JSON.stringify(manifest, null, 2);
}
