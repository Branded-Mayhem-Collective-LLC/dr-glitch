import { DOT_SHAPES, PLATES, type DotShape, type HalftoneSettings } from "./halftone";
import { parseCustomShape } from "./custom-shape-data";

const MAX_CELL_SIZE = 256;

export type ParseResult =
  | { ok: true; value: HalftoneSettings }
  | { ok: false; field: string };

const fail = (field: string): ParseResult => ({ ok: false, field });

function clampTo(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseSettings(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null) return fail("settings");
  const raw = input as Record<string, unknown>;

  if (!isFiniteNumber(raw.cellSize) || raw.cellSize <= 0 || raw.cellSize > MAX_CELL_SIZE) {
    return fail("cellSize");
  }
  if (raw.frayedXEdge !== undefined && (!isFiniteNumber(raw.frayedXEdge) || raw.frayedXEdge < 0 || raw.frayedXEdge > 100)) return fail("frayedXEdge");
  if (raw.frayedYEdge !== undefined && (!isFiniteNumber(raw.frayedYEdge) || raw.frayedYEdge < 0 || raw.frayedYEdge > 100)) return fail("frayedYEdge");
  if (raw.diffusionEnabled !== undefined && typeof raw.diffusionEnabled !== "boolean") return fail("diffusionEnabled");
  const diffusionAlgorithms = ["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"];
  const diffusionModulations = ["none", "column", "row", "dispersed", "medium", "heavy", "circuit", "tilt", "grid"];
  if (raw.diffusionAlgorithm !== undefined && !diffusionAlgorithms.includes(String(raw.diffusionAlgorithm))) return fail("diffusionAlgorithm");
  if (raw.diffusionModulation !== undefined && !diffusionModulations.includes(String(raw.diffusionModulation))) return fail("diffusionModulation");
  for (const field of ["diffusionModStrength", "diffusionIntensity", "diffusionLevels", "diffusionSharpenStrength", "diffusionSharpenRadius", "diffusionDenoise"] as const) {
    if (raw[field] !== undefined && !isFiniteNumber(raw[field])) return fail(field);
  }
  for (const field of ["brokenKernel", "directionalBias", "directionalBiasAngle", "errorOverflow", "diffusionReset", "crossChannelBleed"] as const) {
    if (raw[field] !== undefined && !isFiniteNumber(raw[field])) return fail(field);
  }
  for (const field of ["sliceShift", "sliceSize", "verticalSliceShift", "verticalSliceSize", "gridWarp", "warpScale", "smearDrag", "smearLength", "macroblockCorrupt", "macroblockDropout", "blockShift", "blockShiftSize", "channelDesync", "bitmapSort"] as const) {
    if (raw[field] !== undefined && !isFiniteNumber(raw[field])) return fail(field);
  }
  if (!isFiniteNumber(raw.opacity)) return fail("opacity");
  if (typeof raw.invert !== "boolean") return fail("invert");
  if (raw.grayscale !== undefined && typeof raw.grayscale !== "boolean") return fail("grayscale");
  if (raw.strokeWidth !== undefined && (!isFiniteNumber(raw.strokeWidth) || raw.strokeWidth < 0.25 || raw.strokeWidth > 10)) return fail("strokeWidth");
  if (typeof raw.dotShape !== "string" || !DOT_SHAPES.includes(raw.dotShape as DotShape)) {
    return fail("dotShape");
  }
  const customShape = raw.customShape === undefined ? undefined : parseCustomShape(raw.customShape);
  if (customShape === null || (raw.dotShape === "custom" && !customShape)) return fail("customShape");
  const hasDiffusionSettings = raw.diffusionEnabled !== undefined || raw.diffusionAlgorithm !== undefined || raw.diffusionModulation !== undefined;
  const hasGlitchSettings = raw.sliceShift !== undefined || raw.verticalSliceShift !== undefined || raw.gridWarp !== undefined || raw.smearDrag !== undefined || raw.macroblockCorrupt !== undefined || raw.blockShift !== undefined || raw.channelDesync !== undefined || raw.bitmapSort !== undefined;

  if (typeof raw.angles !== "object" || raw.angles === null) return fail("angles");
  if (typeof raw.visible !== "object" || raw.visible === null) return fail("visible");

  const rawAngles = raw.angles as Record<string, unknown>;
  const rawVisible = raw.visible as Record<string, unknown>;

  const angles = {} as HalftoneSettings["angles"];
  const visible = {} as HalftoneSettings["visible"];

  for (const plate of PLATES) {
    const angle = rawAngles[plate];
    if (!isFiniteNumber(angle)) return fail(`angles.${plate}`);
    angles[plate] = ((angle % 360) + 360) % 360;

    const shown = rawVisible[plate];
    if (typeof shown !== "boolean") return fail(`visible.${plate}`);
    visible[plate] = shown;
  }

  return {
    ok: true,
    value: {
      cellSize: raw.cellSize,
      frayedXEdge: (raw.frayedXEdge as number | undefined) ?? 0,
      frayedYEdge: (raw.frayedYEdge as number | undefined) ?? 0,
      ...(hasDiffusionSettings ? {
        diffusionEnabled: (raw.diffusionEnabled as boolean | undefined) ?? false,
        diffusionAlgorithm: (raw.diffusionAlgorithm as HalftoneSettings["diffusionAlgorithm"] | undefined) ?? "floyd-steinberg",
        diffusionModulation: (raw.diffusionModulation as HalftoneSettings["diffusionModulation"] | undefined) ?? "none",
        diffusionModStrength: (raw.diffusionModStrength as number | undefined) ?? 0.5,
        diffusionIntensity: (raw.diffusionIntensity as number | undefined) ?? 0.5,
        diffusionLevels: (raw.diffusionLevels as number | undefined) ?? 8,
        diffusionSharpenStrength: (raw.diffusionSharpenStrength as number | undefined) ?? 0,
        diffusionSharpenRadius: (raw.diffusionSharpenRadius as number | undefined) ?? 1,
        diffusionDenoise: (raw.diffusionDenoise as number | undefined) ?? 0,
        brokenKernel: (raw.brokenKernel as number | undefined) ?? 0,
        directionalBias: (raw.directionalBias as number | undefined) ?? 0,
        directionalBiasAngle: (raw.directionalBiasAngle as number | undefined) ?? 0,
        errorOverflow: (raw.errorOverflow as number | undefined) ?? 0,
        diffusionReset: (raw.diffusionReset as number | undefined) ?? 0,
        crossChannelBleed: (raw.crossChannelBleed as number | undefined) ?? 0,
      } : {}),
      ...(hasGlitchSettings ? {
      sliceShift: (raw.sliceShift as number | undefined) ?? 0,
      sliceSize: (raw.sliceSize as number | undefined) ?? 20,
      verticalSliceShift: (raw.verticalSliceShift as number | undefined) ?? 0,
      verticalSliceSize: (raw.verticalSliceSize as number | undefined) ?? 20,
      gridWarp: (raw.gridWarp as number | undefined) ?? 0,
      warpScale: (raw.warpScale as number | undefined) ?? 100,
      smearDrag: (raw.smearDrag as number | undefined) ?? 0,
      smearLength: (raw.smearLength as number | undefined) ?? 24,
      smearVertical: (raw.smearVertical as boolean | undefined) ?? false,
      macroblockCorrupt: (raw.macroblockCorrupt as number | undefined) ?? 0,
      macroblockDropout: (raw.macroblockDropout as number | undefined) ?? 0.25,
      blockShift: (raw.blockShift as number | undefined) ?? 0,
      blockShiftSize: (raw.blockShiftSize as number | undefined) ?? 16,
      channelDesync: (raw.channelDesync as number | undefined) ?? 0,
      bitmapSort: (raw.bitmapSort as number | undefined) ?? 0,
      bitmapSortVertical: (raw.bitmapSortVertical as boolean | undefined) ?? false,
      } : {}),
      opacity: 1,
      dotShape: raw.dotShape as DotShape,
      invert: raw.invert,
      grayscale: (raw.grayscale as boolean | undefined) ?? false,
      strokeWidth: (raw.strokeWidth as number | undefined) ?? 1,
      ...(customShape ? { customShape } : {}),
      angles,
      visible,
    },
  };
}
