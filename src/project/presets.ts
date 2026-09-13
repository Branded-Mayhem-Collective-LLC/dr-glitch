/**
 * Device-global portable recipe presets (.drpreset payload).
 *
 * A preset carries only mode, the three setting groups, and the canonical
 * custom-dot SVG inlined for portability. Transform, opacity, plates,
 * registration, and output never enter a preset.
 *
 * SECURITY: parsing DELEGATES to the hardened src/io/drpreset.ts parser —
 * the single .drpreset trust boundary. It performs full reconstructive
 * validation (bounded numeric ranges, enum checks, size cap), re-sanitizes
 * any inlined custom-dot SVG through the custom-dot profile, strips
 * device-local asset ids, and assigns a fresh local id, so the UI import
 * path (PresetsSection → importPresetFile → parsePreset) can never persist
 * or prime unsanitized markup. The legacy lenient parser that previously
 * lived here accepted unbounded/unsanitized customDotSvg and is gone.
 */
import { createId } from "../core/id";
import type { Id, LayerV1, RecipePresetV1, Sha256 } from "../core/types";
import {
  parsePreset as parsePresetHardened,
  serializePreset as serializePresetCanonical,
  PresetValidationError,
} from "../io/drpreset";
import type { Command } from "./commands";

/* Runtime enum value lists live in the shared contract; re-exported here
 * so existing consumers of this module keep working. */
export {
  DIFFUSION_ALGORITHM_VALUES,
  DIFFUSION_MODULATION_VALUES,
  DOT_SHAPE_VALUES,
  LAYER_MODE_VALUES,
} from "../core/enum-values";

/**
 * Builds a preset from a layer's recipe. `customDotSvg` is the canonical
 * sanitized SVG source resolved by the caller (asset store lookup) when the
 * halftone dot shape is "custom"; pass null otherwise.
 */
export function createPresetFromLayer(
  layer: LayerV1,
  name: string,
  customDotSvg: string | null = null,
  now: number = Date.now(),
): RecipePresetV1 {
  const recipe = structuredClone(layer.recipe);
  return {
    schema: 1,
    id: createId(),
    name,
    createdAt: now,
    mode: recipe.mode,
    halftone: recipe.halftone,
    diffusion: recipe.diffusion,
    glitch: recipe.glitch,
    customDotSvg,
  };
}

/**
 * Builds the single undoable command applying a preset to a layer.
 * When the preset inlines a custom dot SVG, the caller installs those bytes
 * in the local asset store first and passes the resulting content address as
 * `customShapeAssetId`; otherwise the preset's stored id is kept as-is.
 */
export function applyPresetCommand(
  preset: RecipePresetV1,
  layerId: Id,
  customShapeAssetId?: Sha256 | null,
): Command {
  const halftone = structuredClone(preset.halftone);
  if (customShapeAssetId !== undefined) halftone.customShapeAssetId = customShapeAssetId;
  return {
    type: "recipe/apply-preset",
    layerId,
    mode: preset.mode,
    halftone,
    diffusion: structuredClone(preset.diffusion),
    glitch: structuredClone(preset.glitch),
  };
}

/**
 * Canonical .drpreset serialization for the UI export/download path.
 * Delegates to the hardened io serializer, which is reconstructive: the
 * emitted file NEVER carries a device-local customShapeAssetId (asset ids
 * don't travel), unknown fields are dropped, ranges are enforced, and the
 * inline custom-dot SVG is re-sanitized — or the export is refused with a
 * typed PresetValidationError — before a single byte is produced. Stored
 * presets are already canonical (PresetRepository validates on read), so
 * this cannot throw on the production path.
 */
export function serializePreset(preset: RecipePresetV1): string {
  return serializePresetCanonical(preset);
}

export type PresetParseResult =
  | { ok: true; preset: RecipePresetV1 }
  | { ok: false; error: string };

/**
 * Parses untrusted .drpreset text through the hardened io parser, adapting
 * its typed PresetValidationError into the result shape the UI notice flow
 * consumes ("Preset rejected: <error>"). Imported presets receive a fresh
 * local id; the file's id/createdAt are never trusted.
 */
export function parsePreset(json: string): PresetParseResult {
  try {
    return { ok: true, preset: parsePresetHardened(json) };
  } catch (error) {
    if (error instanceof PresetValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
