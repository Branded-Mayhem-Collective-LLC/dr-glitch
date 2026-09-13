import { describe, expect, it } from "vitest";
import type { RecipePresetV1 } from "../../src/core/types";
import { parsePreset, PresetValidationError, serializePreset } from "../../src/io/drpreset";
import { sanitizeSvg } from "../../src/io/svg-sanitizer";

const DOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="black"/></svg>';

const PRESET: RecipePresetV1 = {
  schema: 1,
  id: "preset-1",
  name: "Grit Pass",
  createdAt: 42,
  mode: "halftone",
  halftone: { cellSize: 12, dotShape: "round", customShapeAssetId: null, invert: false, strokeWidth: 1, frayedXEdge: 0, frayedYEdge: 0 },
  diffusion: { algorithm: "floyd-steinberg", modulation: "none", modStrength: 0, intensity: 50, levels: 4, sharpenStrength: 0, sharpenRadius: 1, denoise: 0, brokenKernel: 0, directionalBias: 0, directionalBiasAngle: 0, errorOverflow: 0, reset: 0, crossChannelBleed: 0, invert: false },
  glitch: { enabled: true, sliceShift: 10, sliceSize: 4, verticalSliceShift: 0, verticalSliceSize: 0, gridWarp: 0, warpScale: 0, smearDrag: 0, smearLength: 0, smearVertical: false, macroblockCorrupt: 0, macroblockDropout: 0, blockShift: 0, blockShiftSize: 0, channelDesync: 0, bitmapSort: 0, bitmapSortVertical: false },
  customDotSvg: null,
};

function rejects(text: string, code: string) {
  try {
    parsePreset(text);
  } catch (error) {
    expect(error).toBeInstanceOf(PresetValidationError);
    expect((error as PresetValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected preset rejection ${code}`);
}

describe("drpreset round trip", () => {
  it("serializes and reparses the current schema with a fresh local identity", () => {
    const parsed = parsePreset(serializePreset(PRESET), { newId: () => "fresh-id", now: () => 99 });
    expect(parsed).toEqual({ ...PRESET, id: "fresh-id", createdAt: 99 });
  });

  it("re-sanitizes an inlined custom dot SVG to canonical form", () => {
    const messy = '<svg xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 10 10"><circle id="x" cx="5" cy="5" r="4" fill="#FF0000"/></svg>';
    const text = serializePreset({ ...PRESET, halftone: { ...PRESET.halftone, dotShape: "custom" }, customDotSvg: messy });
    const parsed = parsePreset(text, { newId: () => "i", now: () => 0 });
    expect(parsed.customDotSvg).toBe(sanitizeSvg(messy, "custom-dot").svg);
    expect(parsed.customDotSvg).not.toContain('id="x"');
    // Canonical output is stable through another parse.
    const again = parsePreset(serializePreset(parsed), { newId: () => "i", now: () => 0 });
    expect(again.customDotSvg).toBe(parsed.customDotSvg);
  });

  it("never lets device-local asset ids travel", () => {
    const text = serializePreset({
      ...PRESET,
      customDotSvg: DOT_SVG,
      halftone: { ...PRESET.halftone, customShapeAssetId: "a".repeat(64) },
    });
    expect(parsePreset(text).halftone.customShapeAssetId).toBeNull();
  });

  it("strips the device-local content hash from the serialized JSON itself", () => {
    // createPresetFromLayer copies the layer's customShapeAssetId (a sha256 of
    // user artwork) into the preset; the SERIALIZED file must not carry it.
    const text = serializePreset({
      ...PRESET,
      halftone: { ...PRESET.halftone, dotShape: "custom", customShapeAssetId: "ab12".repeat(16) },
      customDotSvg: DOT_SVG,
    });
    expect(/[0-9a-f]{64}/i.test(text)).toBe(false);
    expect(JSON.parse(text).halftone.customShapeAssetId).toBeNull();
    // Still a valid portable preset after the strip.
    expect(parsePreset(text, { newId: () => "i", now: () => 0 }).customDotSvg).toBe(sanitizeSvg(DOT_SVG, "custom-dot").svg);
  });

  it("refuses to serialize unsafe or missing inline SVG instead of shipping it", () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>fetch("https://x")</script><rect width="1" height="1"/></svg>';
    let unsafe: unknown;
    try { serializePreset({ ...PRESET, customDotSvg: evil }); } catch (thrown) { unsafe = thrown; }
    expect(unsafe).toBeInstanceOf(PresetValidationError);
    expect((unsafe as PresetValidationError).code).toBe("preset-svg-invalid");
    // Custom dot shape without an inline SVG is refused too (parser parity).
    let missing: unknown;
    try {
      serializePreset({ ...PRESET, halftone: { ...PRESET.halftone, dotShape: "custom" }, customDotSvg: null });
    } catch (thrown) { missing = thrown; }
    expect(missing).toBeInstanceOf(PresetValidationError);
    expect((missing as PresetValidationError).code).toBe("preset-invalid");
  });

  it("serialization is reconstructive: unknown input fields never reach the file", () => {
    const text = serializePreset({ ...PRESET, secretNote: "do not ship" } as unknown as RecipePresetV1);
    expect(text).not.toContain("secretNote");
    expect(text).not.toContain("do not ship");
  });

  it("strips unknown fields", () => {
    const text = JSON.stringify({ ...PRESET, __proto__: { evil: true }, extra: "field" });
    const parsed = parsePreset(text, { newId: () => "i", now: () => 0 });
    expect("extra" in parsed).toBe(false);
    expect("evil" in parsed).toBe(false);
  });
});

describe("drpreset attacks", () => {
  it("rejects invalid JSON and non-object roots", () => {
    rejects("not json {", "preset-invalid-json");
    rejects("[1,2,3]", "preset-invalid");
    rejects("null", "preset-invalid");
  });

  it("rejects oversized preset files before JSON parsing", () => {
    const padded = JSON.stringify({ ...PRESET, extra: "x".repeat(5 * 1024 * 1024) });
    rejects(padded, "preset-too-large");
  });

  it("neutralizes pathologically deep preset JSON: typed rejection or stripped, never a crash", () => {
    const depth = 200_000;
    const deep = `{"junk":${"[".repeat(depth)}${"]".repeat(depth)},${JSON.stringify(PRESET).slice(1)}`;
    try {
      // Engines with iterative JSON.parse accept the depth; reconstruction
      // must then strip the deep unknown field.
      const parsed = parsePreset(deep, { newId: () => "i", now: () => 0 });
      expect("junk" in parsed).toBe(false);
    } catch (error) {
      // Engines with recursive JSON.parse overflow inside the guarded parse
      // and must surface the stable typed code instead of a raw RangeError.
      expect(error).toBeInstanceOf(PresetValidationError);
      expect((error as PresetValidationError).code).toBe("preset-invalid-json");
    }
  });

  it("rejects future schemas with a safe typed error", () => {
    rejects(JSON.stringify({ ...PRESET, schema: 2 }), "future-schema");
    rejects(JSON.stringify({ ...PRESET, schema: "1" }), "preset-invalid");
  });

  it("rejects invalid modes, enums, and ranges", () => {
    rejects(JSON.stringify({ ...PRESET, mode: "photoshop" }), "preset-invalid");
    rejects(JSON.stringify({ ...PRESET, halftone: { ...PRESET.halftone, cellSize: 0 } }), "preset-invalid");
    rejects(JSON.stringify({ ...PRESET, halftone: { ...PRESET.halftone, cellSize: Number.NaN } }), "preset-invalid");
    rejects(JSON.stringify({ ...PRESET, diffusion: { ...PRESET.diffusion, algorithm: "made-up" } }), "preset-invalid");
    rejects(JSON.stringify({ ...PRESET, glitch: { ...PRESET.glitch, enabled: "yes" } }), "preset-invalid");
    rejects(JSON.stringify({ ...PRESET, name: "" }), "preset-invalid");
  });

  it("rejects missing recipe groups", () => {
    const { glitch, ...withoutGlitch } = PRESET;
    void glitch;
    rejects(JSON.stringify(withoutGlitch), "preset-invalid");
  });

  it("rejects unsafe custom dot SVG", () => {
    for (const evil of [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>fetch("https://x")</script><rect width="1" height="1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="url(#g)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    ]) {
      rejects(JSON.stringify({ ...PRESET, customDotSvg: evil }), "preset-svg-invalid");
    }
  });

  it("requires an inlined SVG when the dot shape is custom", () => {
    rejects(JSON.stringify({ ...PRESET, halftone: { ...PRESET.halftone, dotShape: "custom" }, customDotSvg: null }), "preset-invalid");
  });
});
