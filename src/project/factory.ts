/**
 * Factories for new projects and layers. Defaults mirror the existing studio
 * (src/studio/settings-defaults.ts, document-model.ts, HalftoneStudio.tsx)
 * so a fresh workstation project renders like the current app.
 */
import { createId } from "../core/id";
import { RESOURCE_POLICY } from "../core/resource-policy";
import { DOCUMENT_DPI } from "../core/types";
import type {
  ArtboardBackground,
  ArtboardV1,
  DiffusionRecipeV1,
  GlitchRecipeV1,
  HalftoneRecipeV1,
  Id,
  LayerRecipeV1,
  LayerV1,
  ProjectCoreV1,
  ProjectEnvelopeV1,
  Sha256,
  TransformV1,
  Vec2,
} from "../core/types";

/** 11×15 in portrait at DOCUMENT_DPI — the studio's default sheet. */
export const DEFAULT_ARTBOARD: ArtboardV1 = {
  widthPx: 11 * DOCUMENT_DPI,
  heightPx: 15 * DOCUMENT_DPI,
  presetId: "11x15",
  background: "white",
};

export function defaultHalftoneRecipe(): HalftoneRecipeV1 {
  return {
    cellSize: 12,
    dotShape: "round",
    customShapeAssetId: null,
    invert: false,
    strokeWidth: 1,
    frayedXEdge: 0,
    frayedYEdge: 0,
  };
}

export function defaultDiffusionRecipe(): DiffusionRecipeV1 {
  return {
    algorithm: "floyd-steinberg",
    modulation: "none",
    modStrength: 0.5,
    intensity: 0.5,
    levels: 8,
    sharpenStrength: 0,
    sharpenRadius: 1,
    denoise: 0,
    brokenKernel: 0,
    directionalBias: 0,
    directionalBiasAngle: 0,
    errorOverflow: 0,
    reset: 0,
    crossChannelBleed: 0,
    invert: false,
  };
}

export function defaultGlitchRecipe(): GlitchRecipeV1 {
  return {
    enabled: false,
    sliceShift: 0,
    sliceSize: 20,
    verticalSliceShift: 0,
    verticalSliceSize: 20,
    gridWarp: 0,
    warpScale: 100,
    smearDrag: 0,
    smearLength: 24,
    smearVertical: false,
    macroblockCorrupt: 0,
    macroblockDropout: 0.25,
    blockShift: 0,
    blockShiftSize: 16,
    channelDesync: 0,
    bitmapSort: 0,
    bitmapSortVertical: false,
  };
}

/** New assets start clean with Glitch off; all groups keep studio defaults. */
export function defaultLayerRecipe(): LayerRecipeV1 {
  return {
    mode: "clean",
    halftone: defaultHalftoneRecipe(),
    diffusion: defaultDiffusionRecipe(),
    glitch: defaultGlitchRecipe(),
  };
}

export function identityTransform(position: Vec2 = { x: 0, y: 0 }): TransformV1 {
  return {
    position: { x: position.x, y: position.y },
    scale: { x: 1, y: 1 },
    rotation: 0,
    flipH: false,
    flipV: false,
    skew: { x: 0, y: 0 },
    perspective: null,
  };
}

export type CreateEmptyProjectOptions = {
  id?: Id;
  title?: string;
  widthPx?: number;
  heightPx?: number;
  presetId?: string;
  background?: ArtboardBackground;
  now?: number;
};

export function createEmptyProjectCore(
  options: CreateEmptyProjectOptions = {},
): ProjectCoreV1 {
  const widthPx = options.widthPx ?? DEFAULT_ARTBOARD.widthPx;
  const heightPx = options.heightPx ?? DEFAULT_ARTBOARD.heightPx;
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx <= 0 || heightPx <= 0) {
    throw new Error(`Artboard size must be positive integer px, got ${widthPx}x${heightPx}`);
  }
  if (widthPx > RESOURCE_POLICY.maxArtboardEdge || heightPx > RESOURCE_POLICY.maxArtboardEdge) {
    throw new Error(
      `Artboard ${widthPx}x${heightPx} exceeds the ${RESOURCE_POLICY.maxArtboardEdge} px edge limit`,
    );
  }
  if (widthPx * heightPx > RESOURCE_POLICY.maxArtboardPixels) {
    throw new Error(
      `Artboard ${widthPx}x${heightPx} exceeds ${RESOURCE_POLICY.maxArtboardPixels} px`,
    );
  }
  return {
    schema: 1,
    artboard: {
      widthPx,
      heightPx,
      presetId: options.presetId ?? DEFAULT_ARTBOARD.presetId,
      background: options.background ?? DEFAULT_ARTBOARD.background,
    },
    layers: [],
    separation: {
      mode: "cmyk",
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
    },
    registration: {
      size: 120,
      offset: 120,
      weight: 2,
      mode: "corners",
      customShapeAssetId: null,
    },
    guides: { horizontal: [], vertical: [], locked: false, visible: true },
    // 120 document px = 0.5in at 240 DPI.
    grid: { visible: false, size: 120 },
    snapping: {
      enabled: true,
      toGuides: true,
      toGrid: true,
      toLayers: true,
      toArtboard: true,
    },
    output: {
      polarity: "positive",
      pressMirror: false,
      registrationOnPlates: true,
      registrationOnComposite: false,
    },
    unitPreference: "px",
  };
}

export function createEmptyProject(
  options: CreateEmptyProjectOptions = {},
): ProjectEnvelopeV1 {
  const now = options.now ?? Date.now();
  return {
    schema: 1,
    id: options.id ?? createId(),
    title: options.title ?? "Untitled",
    createdAt: now,
    updatedAt: now,
    savedRevision: 0,
    core: createEmptyProjectCore(options),
    snapshots: [],
  };
}

/**
 * New layer from an imported asset: clean mode, Glitch disabled, opacity 1,
 * no crop, identity transform with the layer anchor centered on the artboard.
 */
export function createLayerFromAsset(
  assetId: Sha256,
  name: string,
  dims: { width: number; height: number },
  artboard: ArtboardV1,
): LayerV1 {
  if (
    !Number.isFinite(dims.width) ||
    !Number.isFinite(dims.height) ||
    dims.width <= 0 ||
    dims.height <= 0
  ) {
    throw new Error(`Asset dimensions must be positive, got ${dims.width}x${dims.height}`);
  }
  return {
    id: createId(),
    name,
    assetId,
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: identityTransform({
      x: artboard.widthPx / 2,
      y: artboard.heightPx / 2,
    }),
    recipe: defaultLayerRecipe(),
  };
}
