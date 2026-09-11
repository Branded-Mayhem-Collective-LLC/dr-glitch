import type { HalftoneSettings } from "./halftone";

export const DIFFUSION_DEFAULTS = {
  diffusionEnabled: false,
  diffusionAlgorithm: "floyd-steinberg" as NonNullable<HalftoneSettings["diffusionAlgorithm"]>,
  diffusionModulation: "none" as NonNullable<HalftoneSettings["diffusionModulation"]>,
  diffusionModStrength: 0.5,
  diffusionIntensity: 0.5,
  diffusionLevels: 8,
  diffusionSharpenStrength: 0,
  diffusionSharpenRadius: 1,
  diffusionDenoise: 0,
  brokenKernel: 0,
  directionalBias: 0,
  directionalBiasAngle: 0,
  errorOverflow: 0,
  diffusionReset: 0,
  crossChannelBleed: 0,
};

export const GLITCH_DEFAULTS = {
  sliceShift: 0, sliceSize: 20,
  verticalSliceShift: 0, verticalSliceSize: 20,
  gridWarp: 0, warpScale: 100,
  smearDrag: 0, smearLength: 24, smearVertical: false,
  macroblockCorrupt: 0, macroblockDropout: 0.25,
  blockShift: 0, blockShiftSize: 16,
  channelDesync: 0, bitmapSort: 0, bitmapSortVertical: false,
};

export const DEFAULT_SETTINGS: HalftoneSettings = {
  cellSize: 12,
  frayedXEdge: 0,
  frayedYEdge: 0,
  opacity: 1,
  dotShape: "round",
  invert: false,
  grayscale: false,
  strokeWidth: 1,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
  ...DIFFUSION_DEFAULTS,
  ...GLITCH_DEFAULTS,
};
