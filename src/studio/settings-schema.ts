import { DOT_SHAPES, PLATES, type DotShape, type HalftoneSettings } from "./halftone";
import { parseCustomShape } from "./custom-shape-data";
import { DIFFUSION_DEFAULTS, GLITCH_DEFAULTS } from "./settings-defaults";

const MAX_CELL_SIZE = 256;

export type ParseResult =
  | { ok: true; value: HalftoneSettings }
  | { ok: false; field: string };

const fail = (field: string): ParseResult => ({ ok: false, field });

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
  // Validate every present field before applying shared defaults. A sparse saved
  // group (for example only diffusionIntensity) must not silently disappear.
  for (const defaults of [DIFFUSION_DEFAULTS, GLITCH_DEFAULTS]) {
    for (const [field, fallback] of Object.entries(defaults)) {
      const value = raw[field];
      if (value !== undefined && (typeof value !== typeof fallback ||
          (typeof fallback === "number" && !isFiniteNumber(value)))) return fail(field);
    }
  }
  const diffusionAlgorithms = ["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"];
  const diffusionModulations = ["none", "column", "row", "dispersed", "medium", "heavy", "circuit", "tilt", "grid"];
  if (raw.diffusionAlgorithm !== undefined && !diffusionAlgorithms.includes(raw.diffusionAlgorithm as string)) return fail("diffusionAlgorithm");
  if (raw.diffusionModulation !== undefined && !diffusionModulations.includes(raw.diffusionModulation as string)) return fail("diffusionModulation");
  if (!isFiniteNumber(raw.opacity)) return fail("opacity");
  if (typeof raw.invert !== "boolean") return fail("invert");
  if (raw.grayscale !== undefined && typeof raw.grayscale !== "boolean") return fail("grayscale");
  if (raw.strokeWidth !== undefined && (!isFiniteNumber(raw.strokeWidth) || raw.strokeWidth < 0.25 || raw.strokeWidth > 10)) return fail("strokeWidth");
  if (typeof raw.dotShape !== "string" || !DOT_SHAPES.includes(raw.dotShape as DotShape)) {
    return fail("dotShape");
  }
  const customShape = raw.customShape === undefined ? undefined : parseCustomShape(raw.customShape);
  if (customShape === null || (raw.dotShape === "custom" && !customShape)) return fail("customShape");
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
      ...savedGroup(raw, DIFFUSION_DEFAULTS),
      ...savedGroup(raw, GLITCH_DEFAULTS),
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

/** Leave legacy absent groups absent; only copy known, already-validated keys. */
function savedGroup<T extends Record<string, unknown>>(raw: Record<string, unknown>, defaults: T): Partial<T> {
  const keys = Object.keys(defaults);
  if (!keys.some((key) => raw[key] !== undefined)) return {};
  return Object.fromEntries(keys.map((key) => [key, raw[key] ?? defaults[key]])) as T;
}
