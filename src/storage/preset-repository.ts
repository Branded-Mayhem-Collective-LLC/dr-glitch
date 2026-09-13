/**
 * Device-global recipe presets (.drpreset content lives in the presets
 * store). Presets are small, keyed by id, and never enter project files.
 *
 * At-rest rows are revalidated on every read through the hardened .drpreset
 * validator (numeric ranges, enums, canonical custom-dot SVG
 * re-sanitization): a corrupt row is skipped from list() with a console
 * warning and load() reports it as a typed CorruptRecordError, so damaged or
 * poisoned rows can never reach the UI or prime the asset cache.
 */
import type { Id, RecipePresetV1 } from "../core/types";
import type { StorageBackend } from "./backend";
import { CorruptRecordError, NotFoundError } from "./errors";
import { validateStoredPreset } from "./validate";

export class PresetRepository {
  constructor(private readonly backend: StorageBackend) {}

  async list(): Promise<RecipePresetV1[]> {
    const keys = await this.backend.getAllKeys("presets");
    const presets: RecipePresetV1[] = [];
    for (const key of keys) {
      const raw = await this.backend.get<unknown>("presets", key);
      if (raw === undefined) continue;
      try {
        presets.push(validateStoredPreset(key, raw));
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        console.warn(`Skipping corrupt preset record "${key}":`, error.cause ?? error);
      }
    }
    return presets.sort((a, b) => b.createdAt - a.createdAt);
  }

  async load(id: Id): Promise<RecipePresetV1> {
    const preset = await this.backend.get<unknown>("presets", id);
    if (preset === undefined) throw new NotFoundError("preset", id);
    return validateStoredPreset(id, preset);
  }

  async save(preset: RecipePresetV1): Promise<void> {
    await this.backend.put("presets", preset.id, preset);
  }

  async delete(id: Id): Promise<void> {
    await this.backend.delete("presets", id);
  }
}
