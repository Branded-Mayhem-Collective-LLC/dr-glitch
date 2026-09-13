/**
 * .drpreset portable recipe files (RecipePresetV1 as JSON).
 *
 * Serialize writes the current schema only, RECONSTRUCTIVELY: only schema
 * fields in a stable order are emitted (unknown fields on the input object
 * can never leak into the file), the device-local customShapeAssetId content
 * hash is always nulled on the way OUT (a sha256 of user artwork is a
 * correlatable fingerprint and must not travel), and any inline customDotSvg
 * is sanitized through the custom-dot profile BEFORE emission — serializing
 * unsafe markup is a typed error, not a shipped file. Parse performs the
 * same full structural validation with reconstruction, rejects future
 * schemas with a safe typed error, and re-sanitizes inline SVG on the way in
 * (defense in depth for files written by other tools). Imported presets
 * receive a fresh local id; the id/createdAt in the file are discarded on
 * import.
 */
import type { Id, RecipePresetV1 } from "../core/types";
import { sanitizeSvg, SvgValidationError } from "./svg-sanitizer";
import {
  SchemaViolation,
  validateDiffusionRecipe,
  validateGlitchRecipe,
  validateHalftoneRecipe,
  validateLayerMode,
} from "./validate";

export const DRPRESET_SCHEMA = 1;

/**
 * Upper bound on the .drpreset text accepted for parsing. The custom-dot SVG
 * profile allows 1 MB of markup; 4 MiB leaves room for JSON escaping and the
 * rest of the preset while keeping unbounded uploads out of JSON.parse.
 */
export const MAX_PRESET_TEXT_LENGTH = 4 * 1024 * 1024;

export type PresetErrorCode =
  | "preset-invalid-json"
  | "preset-too-large"
  | "preset-invalid"
  | "future-schema"
  | "preset-svg-invalid";

export class PresetValidationError extends Error {
  readonly code: PresetErrorCode;
  constructor(code: PresetErrorCode, message: string) {
    super(message);
    this.name = "PresetValidationError";
    this.code = code;
  }
}

function fail(code: PresetErrorCode, message: string): never {
  throw new PresetValidationError(code, message);
}

/**
 * Serialize the current schema only; the result is a complete .drpreset file.
 * Reconstructive and canonical: unknown fields are dropped, recipe groups are
 * re-validated, the device-local customShapeAssetId never travels, and the
 * inline SVG is sanitized (or the export refused) before a single byte is
 * emitted. Throws PresetValidationError.
 */
export function serializePreset(preset: RecipePresetV1): string {
  if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > 255) {
    fail("preset-invalid", "Cannot export: the preset needs a name up to 255 characters.");
  }
  let mode: RecipePresetV1["mode"];
  let halftone: RecipePresetV1["halftone"];
  let diffusion: RecipePresetV1["diffusion"];
  let glitch: RecipePresetV1["glitch"];
  try {
    mode = validateLayerMode("preset.mode", preset.mode);
    halftone = validateHalftoneRecipe("preset.halftone", preset.halftone);
    diffusion = validateDiffusionRecipe("preset.diffusion", preset.diffusion);
    glitch = validateGlitchRecipe("preset.glitch", preset.glitch);
  } catch (error) {
    if (error instanceof SchemaViolation) fail("preset-invalid", `Cannot export: ${error.message}`);
    throw error;
  }
  let customDotSvg: string | null = null;
  if (preset.customDotSvg !== null && preset.customDotSvg !== undefined) {
    if (typeof preset.customDotSvg !== "string") fail("preset-invalid", "Cannot export: customDotSvg must be a string or null.");
    try {
      customDotSvg = sanitizeSvg(preset.customDotSvg, "custom-dot").svg;
    } catch (error) {
      if (error instanceof SvgValidationError) {
        fail("preset-svg-invalid", `Cannot export: the custom dot SVG was rejected (${error.code}): ${error.message}`);
      }
      throw error;
    }
  }
  if (halftone.dotShape === "custom" && !customDotSvg) {
    fail("preset-invalid", "Cannot export: a custom dot shape preset must inline its customDotSvg.");
  }
  // Same stable field order as parsePreset's reconstruction.
  const canonical: RecipePresetV1 = {
    schema: DRPRESET_SCHEMA,
    id: preset.id,
    name: preset.name.trim(),
    createdAt: preset.createdAt,
    mode,
    // Asset ids are device-local content hashes and never travel in presets;
    // the inlined canonical SVG is the only portable form of a custom dot.
    halftone: { ...halftone, customShapeAssetId: null },
    diffusion,
    glitch,
    customDotSvg,
  };
  return JSON.stringify(canonical, null, 2);
}

export type ParsePresetOptions = {
  /** Injectable for tests; defaults to crypto.randomUUID. */
  newId?: () => Id;
  now?: () => number;
};

/** Parse and fully validate untrusted .drpreset text. Throws PresetValidationError. */
export function parsePreset(text: string, options: ParsePresetOptions = {}): RecipePresetV1 {
  if (text.length > MAX_PRESET_TEXT_LENGTH) {
    fail("preset-too-large", `The preset file exceeds ${MAX_PRESET_TEXT_LENGTH} characters.`);
  }
  let raw: unknown;
  try {
    // The catch also absorbs engine RangeErrors from pathologically deep
    // input, so deep-data attacks land here as a typed rejection.
    raw = JSON.parse(text);
  } catch {
    fail("preset-invalid-json", "The preset file is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("preset-invalid", "The preset must be an object.");
  const record = raw as Record<string, unknown>;
  const schema = record.schema;
  if (typeof schema !== "number" || !Number.isSafeInteger(schema) || schema < 1) {
    fail("preset-invalid", "The preset declares an invalid schema.");
  }
  if (schema > DRPRESET_SCHEMA) {
    fail("future-schema", `This preset uses schema ${schema}; this app supports up to ${DRPRESET_SCHEMA}. Update DR.GLITCH to use it.`);
  }
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > 255) {
    fail("preset-invalid", "The preset needs a name up to 255 characters.");
  }
  let mode: RecipePresetV1["mode"];
  let halftone: RecipePresetV1["halftone"];
  let diffusion: RecipePresetV1["diffusion"];
  let glitch: RecipePresetV1["glitch"];
  try {
    mode = validateLayerMode("preset.mode", record.mode);
    halftone = validateHalftoneRecipe("preset.halftone", record.halftone);
    diffusion = validateDiffusionRecipe("preset.diffusion", record.diffusion);
    glitch = validateGlitchRecipe("preset.glitch", record.glitch);
  } catch (error) {
    if (error instanceof SchemaViolation) fail("preset-invalid", error.message);
    throw error;
  }
  let customDotSvg: string | null = null;
  if (record.customDotSvg !== null && record.customDotSvg !== undefined) {
    if (typeof record.customDotSvg !== "string") fail("preset-invalid", "customDotSvg must be a string or null.");
    try {
      customDotSvg = sanitizeSvg(record.customDotSvg, "custom-dot").svg;
    } catch (error) {
      if (error instanceof SvgValidationError) {
        fail("preset-svg-invalid", `The preset's custom dot SVG was rejected (${error.code}): ${error.message}`);
      }
      throw error;
    }
  }
  if (halftone.dotShape === "custom" && !customDotSvg) {
    fail("preset-invalid", "A custom dot shape preset must inline its customDotSvg.");
  }
  return {
    schema: DRPRESET_SCHEMA,
    id: (options.newId ?? (() => crypto.randomUUID()))(),
    name: record.name.trim(),
    createdAt: (options.now ?? Date.now)(),
    mode,
    // Asset ids are device-local and never travel in presets; the inlined
    // canonical SVG is the only portable form of a custom dot.
    halftone: { ...halftone, customShapeAssetId: null },
    diffusion,
    glitch,
    customDotSvg,
  };
}
