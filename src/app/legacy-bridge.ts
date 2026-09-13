/**
 * Legacy bridge: maps between ProjectCoreV1 (the canonical document) and the
 * legacy single-artwork studio shapes (HalftoneSettings / DocumentSettings)
 * that the render engine and panels still speak.
 *
 * Direction 1 (read) reuses halftoneSettingsFromCore from src/export so the
 * studio preview and the export path can never diverge. Direction 2 (write)
 * lives here: every legacy setting key maps to project commands against the
 * primary layer or the document-global sections.
 *
 * This module is pure and side-effect free so it is unit-testable in node.
 */
import type { Command } from "../project";
import {
  defaultDiffusionRecipe,
  defaultGlitchRecipe,
  defaultHalftoneRecipe,
} from "../project";
import type {
  ArtboardV1,
  GlitchRecipeV1,
  Id,
  LayerV1,
  PlateId,
  ProjectCoreV1,
} from "../core/types";
import { PLATE_IDS } from "../core/types";
import type { HalftoneSettings } from "../studio/halftone";
import {
  getSheetPixelDimensions,
  SHEET_SIZES,
  type DocumentSettings,
  type Orientation,
  type SheetSizeId,
} from "../studio/document-model";

/* Direct module import (not the export index) keeps node unit tests from
 * pulling browser-only encoder modules. */
export { halftoneSettingsFromCore } from "../export/current-engine";

/* ------------------------------------------------------------------ */
/* Core -> legacy DocumentSettings                                     */
/* ------------------------------------------------------------------ */

/** Sheet preset + orientation matching the artboard, defaulting to 11x15. */
export function sheetForArtboard(artboard: ArtboardV1): {
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
 * Legacy DocumentSettings projection. scalePercent and mirror live on the
 * primary layer's transform (uniform scale, flipH/flipV); with no layer the
 * defaults apply.
 */
export function documentFromCore(
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
/* Legacy writes -> commands                                           */
/* ------------------------------------------------------------------ */

const HALFTONE_KEYS = {
  cellSize: "cellSize",
  frayedXEdge: "frayedXEdge",
  frayedYEdge: "frayedYEdge",
  strokeWidth: "strokeWidth",
  dotShape: "dotShape",
} as const;

const DIFFUSION_KEYS = {
  diffusionAlgorithm: "algorithm",
  diffusionModulation: "modulation",
  diffusionModStrength: "modStrength",
  diffusionIntensity: "intensity",
  diffusionLevels: "levels",
  diffusionSharpenStrength: "sharpenStrength",
  diffusionSharpenRadius: "sharpenRadius",
  diffusionDenoise: "denoise",
  brokenKernel: "brokenKernel",
  directionalBias: "directionalBias",
  directionalBiasAngle: "directionalBiasAngle",
  errorOverflow: "errorOverflow",
  diffusionReset: "reset",
  crossChannelBleed: "crossChannelBleed",
} as const;

const GLITCH_KEYS = [
  "sliceShift",
  "sliceSize",
  "verticalSliceShift",
  "verticalSliceSize",
  "gridWarp",
  "warpScale",
  "smearDrag",
  "smearLength",
  "smearVertical",
  "macroblockCorrupt",
  "macroblockDropout",
  "blockShift",
  "blockShiftSize",
  "channelDesync",
  "bitmapSort",
  "bitmapSortVertical",
] as const;

type GlitchKey = (typeof GLITCH_KEYS)[number];

/** Amount-style glitch fields: any of them nonzero means the pass is live. */
const GLITCH_AMOUNT_KEYS: GlitchKey[] = [
  "sliceShift",
  "verticalSliceShift",
  "gridWarp",
  "smearDrag",
  "macroblockCorrupt",
  "blockShift",
  "channelDesync",
  "bitmapSort",
];

export function glitchIsActive(glitch: GlitchRecipeV1): boolean {
  return GLITCH_AMOUNT_KEYS.some((key) => (glitch[key] as number) > 0);
}

function glitchPatch(
  layer: LayerV1,
  patch: Partial<GlitchRecipeV1>,
): Command {
  const merged = { ...layer.recipe.glitch, ...patch };
  return {
    type: "recipe/update-glitch",
    layerId: layer.id,
    patch: { ...patch, enabled: glitchIsActive(merged) },
  };
}

/**
 * Commands for one legacy updateSetting(key, value) call against the primary
 * layer. Returns [] for keys the studio handles specially (customShape) or
 * that need no document change.
 */
export function commandsForSetting(
  core: ProjectCoreV1,
  layer: LayerV1 | null,
  key: keyof HalftoneSettings,
  value: HalftoneSettings[keyof HalftoneSettings],
): Command[] {
  if (key === "grayscale") {
    return [{ type: "separation/set-mode", mode: value ? "grayscale" : "cmyk" }];
  }
  if (key === "angles") {
    const angles = value as Record<PlateId, number>;
    return PLATE_IDS.filter(
      (plate) => core.separation.angles[plate] !== angles[plate],
    ).map((plate) => ({
      type: "separation/set-angle",
      plate,
      angle: angles[plate],
    }));
  }
  if (key === "visible") {
    const visible = value as Record<PlateId, boolean>;
    return PLATE_IDS.filter(
      (plate) => core.separation.visible[plate] !== visible[plate],
    ).map((plate) => ({
      type: "separation/set-plate-visibility",
      plate,
      visible: visible[plate],
    }));
  }

  if (!layer) return [];
  const layerId = layer.id;

  if (key === "opacity") {
    return [{ type: "layer/set-opacity", layerId, opacity: value as number }];
  }
  if (key === "diffusionEnabled") {
    return [
      { type: "layer/set-mode", layerId, mode: value ? "diffusion" : "halftone" },
    ];
  }
  if (key === "invert") {
    // Legacy `invert` acts in coverage space regardless of mode; keep both
    // recipe inverts in step so mode switches never flip the output.
    const invert = Boolean(value);
    return [
      { type: "recipe/update-halftone", layerId, patch: { invert } },
      { type: "recipe/update-diffusion", layerId, patch: { invert } },
    ];
  }
  if (key in HALFTONE_KEYS) {
    const target = HALFTONE_KEYS[key as keyof typeof HALFTONE_KEYS];
    return [
      { type: "recipe/update-halftone", layerId, patch: { [target]: value } },
    ];
  }
  if (key in DIFFUSION_KEYS) {
    const target = DIFFUSION_KEYS[key as keyof typeof DIFFUSION_KEYS];
    return [
      { type: "recipe/update-diffusion", layerId, patch: { [target]: value } },
    ];
  }
  if ((GLITCH_KEYS as readonly string[]).includes(key)) {
    return [glitchPatch(layer, { [key]: value } as Partial<GlitchRecipeV1>)];
  }
  // customShape and unknown keys are handled by the studio (asset install).
  return [];
}

/** Commands for a legacy updateDocument(patch) call. */
export function commandsForDocumentPatch(
  core: ProjectCoreV1,
  layer: LayerV1 | null,
  patch: Partial<DocumentSettings>,
): Command[] {
  const commands: Command[] = [];
  const current = documentFromCore(core, layer);
  const next = { ...current, ...patch };

  if (
    next.sheetSize !== current.sheetSize ||
    next.orientation !== current.orientation
  ) {
    const dims = getSheetPixelDimensions(next.sheetSize, next.orientation);
    commands.push({
      type: "artboard/resize",
      widthPx: dims.width,
      heightPx: dims.height,
      presetId: next.sheetSize,
    });
  }
  if (patch.background !== undefined && patch.background !== current.background) {
    commands.push({ type: "artboard/set-background", background: patch.background });
  }
  if (layer) {
    const transformPatch: {
      scale?: { x: number; y: number };
      flipH?: boolean;
      flipV?: boolean;
    } = {};
    if (patch.scalePercent !== undefined) {
      const scale = Math.min(400, Math.max(10, patch.scalePercent)) / 100;
      transformPatch.scale = { x: scale, y: scale };
    }
    if (patch.mirrorImage !== undefined || patch.mirrorDirection !== undefined) {
      transformPatch.flipH =
        next.mirrorImage && next.mirrorDirection === "horizontal";
      transformPatch.flipV =
        next.mirrorImage && next.mirrorDirection === "vertical";
    }
    if (Object.keys(transformPatch).length > 0) {
      commands.push({
        type: "layer/set-transform",
        layerId: layer.id,
        patch: transformPatch,
      });
    }
  }
  return commands;
}

/* ------------------------------------------------------------------ */
/* Reset command groups (labels mirror the legacy reset buttons)       */
/* ------------------------------------------------------------------ */

export function resetHalftoneCommands(core: ProjectCoreV1, layer: LayerV1 | null): Command[] {
  const commands: Command[] = [];
  if (layer) {
    const defaults = defaultHalftoneRecipe();
    commands.push({
      type: "recipe/update-halftone",
      layerId: layer.id,
      patch: { ...defaults, customShapeAssetId: layer.recipe.halftone.customShapeAssetId },
    });
  }
  commands.push({ type: "separation/set-mode", mode: "cmyk" });
  const angles: Record<PlateId, number> = { cyan: 15, magenta: 75, yellow: 0, black: 45 };
  for (const plate of PLATE_IDS) {
    if (core.separation.angles[plate] !== angles[plate]) {
      commands.push({ type: "separation/set-angle", plate, angle: angles[plate] });
    }
    if (!core.separation.visible[plate]) {
      commands.push({ type: "separation/set-plate-visibility", plate, visible: true });
    }
  }
  return commands;
}

export function resetDiffusionCommands(layer: LayerV1 | null): Command[] {
  if (!layer) return [];
  const { invert: _invert, ...defaults } = defaultDiffusionRecipe();
  return [{ type: "recipe/update-diffusion", layerId: layer.id, patch: defaults }];
}

export function resetGlitchCommands(layer: LayerV1 | null): Command[] {
  if (!layer) return [];
  return [{ type: "recipe/update-glitch", layerId: layer.id, patch: defaultGlitchRecipe() }];
}

/**
 * Reset Output — canonical output ownership (P0 prepress contract):
 * resets ONLY the document's OutputDefaultsV1 (polarity, press mirror,
 * registration output defaults) plus registration mark geometry. It never
 * touches layer recipes (halftone/diffusion invert) or layer opacity —
 * those are artwork state, not output state. One undoable transaction.
 */
export function resetOutputCommands(): Command[] {
  return [
    {
      type: "output/update",
      patch: {
        polarity: "positive",
        pressMirror: false,
        registrationOnPlates: true,
        registrationOnComposite: false,
      },
    },
    {
      type: "registration/update",
      patch: { size: 120, offset: 120, weight: 2, mode: "corners" },
    },
  ];
}

/** Extension of DrglitchAssetExt from a stored asset mime type. */
export function assetExtForMime(mime: string): "png" | "jpg" | "webp" | "svg" {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "svg";
}

export type { DocumentSettings } from "../studio/document-model";
export type { Id };
