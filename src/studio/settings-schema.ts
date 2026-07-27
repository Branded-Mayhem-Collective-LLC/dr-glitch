import { PLATES, type DotShape, type HalftoneSettings } from "./halftone";

const DOT_SHAPES: DotShape[] = ["round", "square", "diamond", "line"];

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
  if (!isFiniteNumber(raw.contrast)) return fail("contrast");
  if (!isFiniteNumber(raw.exposure)) return fail("exposure");
  if (!isFiniteNumber(raw.opacity)) return fail("opacity");
  if (typeof raw.invert !== "boolean") return fail("invert");
  if (typeof raw.dotShape !== "string" || !DOT_SHAPES.includes(raw.dotShape as DotShape)) {
    return fail("dotShape");
  }

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
      contrast: clampTo(raw.contrast, 0, 4),
      exposure: clampTo(raw.exposure, -1, 1),
      opacity: clampTo(raw.opacity, 0, 1),
      dotShape: raw.dotShape as DotShape,
      invert: raw.invert,
      angles,
      visible,
    },
  };
}
