/**
 * Kernel-facing settings contract.
 *
 * `RenderSettings` is structurally compatible with the studio engine's
 * `HalftoneSettings` (src/studio/halftone.ts) for every field the DOM-free
 * kernels consume, so the same settings object drives both the parity oracle
 * and the extracted kernels. Kernels never import from src/studio.
 */
import type { PlateId } from "../core/types";

export type RenderPlateId = PlateId;

/** Plate processing order; channel indices for glitch/noise seeds derive from it. */
export const PLATE_SEQUENCE: RenderPlateId[] = ["cyan", "magenta", "yellow", "black"];

/** Proof colors matching src/studio/halftone.ts PLATE_META. */
export const PLATE_PROOF_COLORS: Record<RenderPlateId, readonly [number, number, number]> = {
  cyan: [0, 169, 200],
  magenta: [229, 53, 120],
  yellow: [240, 212, 34],
  black: [32, 34, 38],
};

export type DiffusionAlgorithmSetting =
  | "none"
  | "floyd-steinberg"
  | "jarvis-judice-ninke"
  | "stucki"
  | "burkes"
  | "atkinson";

export type DiffusionModulationSetting =
  | "none"
  | "column"
  | "row"
  | "dispersed"
  | "medium"
  | "heavy"
  | "circuit"
  | "tilt"
  | "grid";

export type RenderSettings = {
  cellSize: number;
  frayedXEdge: number;
  frayedYEdge: number;
  invert: boolean;
  grayscale?: boolean;
  angles: Record<RenderPlateId, number>;
  visible: Record<RenderPlateId, boolean>;
  /**
   * Clean continuous-tone mode: the layer's (glitched) separation coverage
   * contributes directly as plate ink — no screening, no diffusion. Takes
   * precedence over diffusionEnabled; the mapper never sets both.
   */
  cleanEnabled?: boolean;
  diffusionEnabled?: boolean;
  diffusionAlgorithm?: DiffusionAlgorithmSetting;
  diffusionModulation?: DiffusionModulationSetting;
  diffusionModStrength?: number;
  diffusionIntensity?: number;
  diffusionLevels?: number;
  diffusionSharpenStrength?: number;
  diffusionSharpenRadius?: number;
  diffusionDenoise?: number;
  brokenKernel?: number;
  directionalBias?: number;
  directionalBiasAngle?: number;
  errorOverflow?: number;
  diffusionReset?: number;
  crossChannelBleed?: number;
  sliceShift?: number;
  sliceSize?: number;
  verticalSliceShift?: number;
  verticalSliceSize?: number;
  gridWarp?: number;
  warpScale?: number;
  smearDrag?: number;
  smearLength?: number;
  smearVertical?: boolean;
  macroblockCorrupt?: number;
  macroblockDropout?: number;
  blockShift?: number;
  blockShiftSize?: number;
  channelDesync?: number;
  bitmapSort?: number;
  bitmapSortVertical?: boolean;
};

/** Channel index used by glitch hashing and deterministic noise; parity with PLATES.indexOf. */
export function plateChannelIndex(plate: RenderPlateId): number {
  return PLATE_SEQUENCE.indexOf(plate);
}

/** Plates a settings object actually processes; parity with processPlates. */
export function activePlates(settings: RenderSettings): RenderPlateId[] {
  return settings.grayscale ? ["black"] : PLATE_SEQUENCE;
}
