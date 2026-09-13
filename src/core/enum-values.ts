/**
 * Runtime value lists for the schema-1 string-union enums in types.ts.
 * types.ts stays types-only; import these wherever runtime validation of
 * untrusted data (presets, archives, exports) needs to check membership.
 */
import type {
  DiffusionAlgorithm,
  DiffusionModulation,
  DotShape,
  LayerMode,
} from "./types";

export const LAYER_MODE_VALUES = ["clean", "halftone", "diffusion"] as const satisfies readonly LayerMode[];

export const DOT_SHAPE_VALUES = [
  "round",
  "square",
  "diamond",
  "line",
  "triangle",
  "cross",
  "circle-outline",
  "custom",
] as const satisfies readonly DotShape[];

export const DIFFUSION_ALGORITHM_VALUES = [
  "none",
  "floyd-steinberg",
  "jarvis-judice-ninke",
  "stucki",
  "burkes",
  "atkinson",
] as const satisfies readonly DiffusionAlgorithm[];

export const DIFFUSION_MODULATION_VALUES = [
  "none",
  "column",
  "row",
  "dispersed",
  "medium",
  "heavy",
  "circuit",
  "tilt",
  "grid",
] as const satisfies readonly DiffusionModulation[];
