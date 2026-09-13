/**
 * Plate-package job-settings.json content contract.
 *
 * The manifest must be a SUPERSET of the legacy manifest the shipped studio
 * wrote (git HEAD src/studio/HalftoneStudio.tsx exportArtwork — raster at
 * lines 737-768, SVG at 664-673) plus the workstation's schema/revision/
 * target binding. The migrated Playwright specs pin the legacy fields:
 *   desktop-parity.spec.ts:264-267  job.settings {dotShape, strokeWidth,
 *                                   grayscale}; job.output {dpi, worstPlate,
 *                                   worstAngle}
 *   desktop-parity.spec.ts:354-355  job.omittedPlates contains "magenta"
 *   custom-shape.spec.ts:147-176    job.settings parses via parseSettings,
 *                                   customShape echo, job.output.width/
 *                                   height, job.registration*, job.document
 * Expected objects below are hand-written from the legacy semantics, never
 * derived by calling the builder's own helpers.
 */

import { describe, expect, it } from "vitest";
import type { LayerV1, ProjectCoreV1 } from "../../src/core/types";
import {
  startExport,
  type ExportEncoders,
  type RasterData,
  type RenderService,
} from "../../src/export/orchestrator";
import { parseSettings } from "../../src/studio/settings-schema";

const ASSET_ID = "a".repeat(64);
const SHAPE_ID = "b".repeat(64);
const MARK_ID = "c".repeat(64);

function makeLayer(): LayerV1 {
  return {
    id: "layer-1",
    name: "Artwork",
    assetId: ASSET_ID,
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: {
      position: { x: 120, y: 150 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      flipH: false,
      flipV: false,
      skew: { x: 0, y: 0 },
      perspective: null,
    },
    recipe: {
      mode: "halftone",
      halftone: {
        cellSize: 12,
        dotShape: "round",
        customShapeAssetId: null,
        invert: false,
        strokeWidth: 1,
        frayedXEdge: 0,
        frayedYEdge: 0,
      },
      diffusion: {
        algorithm: "floyd-steinberg",
        modulation: "none",
        modStrength: 0.5,
        intensity: 0.5,
        levels: 8,
        sharpenStrength: 0,
        sharpenRadius: 1,
        denoise: 0,
        brokenKernel: 0,
        directionalBias: 0,
        directionalBiasAngle: 0,
        errorOverflow: 0,
        reset: 0,
        crossChannelBleed: 0,
        invert: false,
      },
      glitch: {
        enabled: false,
        sliceShift: 0,
        sliceSize: 20,
        verticalSliceShift: 0,
        verticalSliceSize: 20,
        gridWarp: 0,
        warpScale: 100,
        smearDrag: 0,
        smearLength: 24,
        smearVertical: false,
        macroblockCorrupt: 0,
        macroblockDropout: 0.25,
        blockShift: 0,
        blockShiftSize: 16,
        channelDesync: 0,
        bitmapSort: 0,
        bitmapSortVertical: false,
      },
    },
  };
}

function makeCore(): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: 240, heightPx: 300, presetId: "custom", background: "white" },
    layers: [makeLayer()],
    separation: {
      mode: "cmyk",
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
    },
    registration: { size: null, offset: null, weight: 1, mode: "corners", customShapeAssetId: null },
    guides: { horizontal: [], vertical: [], locked: false, visible: true },
    grid: { visible: false, size: 24 },
    snapping: { enabled: true, toGuides: true, toGrid: false, toLayers: true, toArtboard: true },
    output: {
      polarity: "positive",
      pressMirror: false,
      registrationOnPlates: true,
      registrationOnComposite: false,
    },
    unitPreference: "px",
  };
}

const raster: RasterData = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

const renderService: RenderService = {
  async renderComposite() {
    return raster;
  },
  async renderPlate() {
    return raster;
  },
  async renderPlateSvg(_core, plate) {
    return `<svg data-plate="${plate}"/>`;
  },
  async renderLayer() {
    return raster;
  },
};

/** Runs one plate-package export and returns the parsed manifest + entries. */
async function exportManifest(
  core: ProjectCoreV1,
  format: "png" | "svg",
  extras: { resolveCustomShape?: (assetId: string) => Promise<{ filename: string; svg: string }> } = {},
) {
  const zipCalls: { name: string; data: Blob | string }[][] = [];
  const encoders: ExportEncoders = {
    async encodePng() {
      return new Blob(["png"], { type: "image/png" });
    },
    async encodeJpeg() {
      return new Blob(["jpeg"], { type: "image/jpeg" });
    },
    async encodeTiff() {
      return new Blob(["tiff"], { type: "image/tiff" });
    },
    async zip(entries) {
      zipCalls.push(entries);
      return new Blob(["zip"], { type: "application/zip" });
    },
  };
  const job = startExport({
    core,
    revision: 7,
    sourceName: "DR.GLITCH sample artwork",
    target: { kind: "plate-package", format },
    render: renderService,
    encoders,
    ...extras,
  });
  const files = await job.result;
  const entries = zipCalls[0];
  const manifestEntry = entries[entries.length - 1];
  return {
    files,
    entryNames: entries.map(({ name }) => name),
    manifestName: manifestEntry.name,
    manifest: JSON.parse(manifestEntry.data as string) as Record<string, unknown>,
  };
}

/**
 * The full legacy HalftoneSettings echo for the default fixture layer —
 * hand-written to the legacy shape (DEFAULT_SETTINGS semantics: diffusion
 * defaults spelled out, glitch defaults spelled out when the pass is off).
 */
const EXPECTED_DEFAULT_SETTINGS = {
  cellSize: 12,
  frayedXEdge: 0,
  frayedYEdge: 0,
  opacity: 1,
  dotShape: "round",
  invert: false,
  grayscale: false,
  strokeWidth: 1,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
  diffusionEnabled: false,
  diffusionAlgorithm: "floyd-steinberg",
  diffusionModulation: "none",
  diffusionModStrength: 0.5,
  diffusionIntensity: 0.5,
  diffusionLevels: 8,
  diffusionSharpenStrength: 0,
  diffusionSharpenRadius: 1,
  diffusionDenoise: 0,
  brokenKernel: 0,
  directionalBias: 0,
  directionalBiasAngle: 0,
  errorOverflow: 0,
  diffusionReset: 0,
  crossChannelBleed: 0,
  sliceShift: 0,
  sliceSize: 20,
  verticalSliceShift: 0,
  verticalSliceSize: 20,
  gridWarp: 0,
  warpScale: 100,
  smearDrag: 0,
  smearLength: 24,
  smearVertical: false,
  macroblockCorrupt: 0,
  macroblockDropout: 0.25,
  blockShift: 0,
  blockShiftSize: 16,
  channelDesync: 0,
  bitmapSort: 0,
  bitmapSortVertical: false,
};

describe("plate-package job-settings.json: CMYK raster", () => {
  it("writes the complete legacy manifest plus the workstation binding, field for field", async () => {
    const { manifest, manifestName, entryNames } = await exportManifest(makeCore(), "png");
    expect(manifestName).toBe("job-settings.json");
    expect(entryNames).toEqual([
      "dr-C-plate.png",
      "dr-M-plate.png",
      "dr-Y-plate.png",
      "dr-K-plate.png",
      "job-settings.json",
    ]);
    expect(manifest).toEqual({
      // Workstation binding (revision-bound confirmations).
      schema: 1,
      revision: 7,
      target: { kind: "plate-package", format: "png" },
      // Legacy content contract.
      source: "DR.GLITCH sample artwork",
      document: {
        sheetSize: "11x15",
        orientation: "portrait",
        scalePercent: 100,
        background: "white",
        mirrorImage: false,
        mirrorDirection: "horizontal",
      },
      settings: EXPECTED_DEFAULT_SETTINGS,
      plates: ["cyan", "magenta", "yellow", "black"],
      omittedPlates: [],
      registration: true,
      registrationWeight: 1,
      registrationMode: "corners",
      // 240x300 at cell 12: K at 45° is the worst screen (32x32 = 1024).
      output: {
        width: 240,
        height: 300,
        dpi: 240,
        estimatedMarksPerPlate: 1024,
        worstPlate: "black",
        worstAngle: 45,
      },
      // Workstation additions carried over from the first manifest schema.
      layers: [{
        source: "Artwork",
        visible: true,
        mode: "halftone",
        opacity: 1,
        dotShape: "round",
        cellSize: 12,
      }],
      dpi: 240,
      artboard: { widthPx: 240, heightPx: 300 },
      separation: {
        mode: "cmyk",
        angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
        visible: { cyan: true, magenta: true, yellow: true, black: true },
      },
      outputDefaults: {
        polarity: "positive",
        pressMirror: false,
        registrationOnPlates: true,
        registrationOnComposite: false,
      },
    });
    // Legacy JSON.stringify semantics: auto registration size/offset and
    // absent shapes drop their keys entirely (never null placeholders).
    expect(manifest).not.toHaveProperty("registrationSize");
    expect(manifest).not.toHaveProperty("registrationOffset");
    expect(manifest).not.toHaveProperty("registrationShape");
  });

  it("lists hidden plates in omittedPlates and keeps them out of the package", async () => {
    const core = makeCore();
    core.separation.visible.magenta = false;
    const { manifest, entryNames } = await exportManifest(core, "png");
    expect(entryNames).toEqual([
      "dr-C-plate.png",
      "dr-Y-plate.png",
      "dr-K-plate.png",
      "job-settings.json",
    ]);
    expect(manifest.plates).toEqual(["cyan", "yellow", "black"]);
    expect(manifest.omittedPlates).toEqual(["magenta"]);
    // desktop-parity.spec.ts:355 — expect(job.omittedPlates).toContain("magenta")
    expect(manifest.omittedPlates).toContain("magenta");
  });

  it("echoes explicit registration customization the way the legacy manifest did", async () => {
    const core = makeCore();
    core.registration = {
      size: 240,
      offset: 100,
      weight: 2.5,
      mode: "centered",
      customShapeAssetId: null,
    };
    const { manifest } = await exportManifest(core, "png");
    expect(manifest.registrationSize).toBe(240);
    expect(manifest.registrationOffset).toBe(100);
    expect(manifest.registrationWeight).toBe(2.5);
    expect(manifest.registrationMode).toBe("centered");
  });
});

describe("plate-package job-settings.json: grayscale raster", () => {
  function grayscaleCore(): ProjectCoreV1 {
    // Mirrors the desktop-parity grayscale flow: circle-outline dots,
    // stroke 2.5, grayscale separation (C/M/Y hidden by the mode switch).
    const core = makeCore();
    core.separation.mode = "grayscale";
    core.layers[0].recipe.halftone.dotShape = "circle-outline";
    core.layers[0].recipe.halftone.strokeWidth = 2.5;
    return core;
  }

  it("packages only K and satisfies the desktop-parity settings/output oracle", async () => {
    const { manifest, entryNames } = await exportManifest(grayscaleCore(), "png");
    expect(entryNames).toEqual(["dr-K-plate.png", "job-settings.json"]);
    // desktop-parity.spec.ts:264-267 oracles, verbatim semantics:
    expect(manifest.settings).toMatchObject({
      dotShape: "circle-outline",
      strokeWidth: 2.5,
      grayscale: true,
    });
    expect(manifest.output).toMatchObject({ dpi: 240, worstPlate: "black", worstAngle: 45 });
    expect(manifest.output).toEqual({
      width: 240,
      height: 300,
      dpi: 240,
      estimatedMarksPerPlate: 1024,
      worstPlate: "black",
      worstAngle: 45,
    });
    expect(manifest.plates).toEqual(["black"]);
  });

  it("reproduces legacy grayscale omittedPlates semantics: C/M/Y are inapplicable, not omitted", async () => {
    const core = grayscaleCore();
    // Even with the CMY visibility flags off (as the legacy mode switch
    // left them), grayscale's applicable plate set is just K, so nothing
    // is omitted while K stays visible.
    core.separation.visible = { cyan: false, magenta: false, yellow: false, black: true };
    const { manifest } = await exportManifest(core, "png");
    expect(manifest.omittedPlates).toEqual([]);
  });
});

describe("plate-package job-settings.json: SVG package", () => {
  it("writes the in-folder manifest with the legacy vector markers", async () => {
    const { files, manifest, manifestName, entryNames } = await exportManifest(makeCore(), "svg");
    expect(files[0].name).toBe("dr_SVG_Plates.zip");
    expect(manifestName).toBe("dr_SVG_Plates/job-settings.json");
    expect(entryNames).toEqual([
      "dr_SVG_Plates/C.svg",
      "dr_SVG_Plates/M.svg",
      "dr_SVG_Plates/Y.svg",
      "dr_SVG_Plates/K.svg",
      "dr_SVG_Plates/job-settings.json",
    ]);
    expect(manifest).toEqual({
      schema: 1,
      revision: 7,
      target: { kind: "plate-package", format: "svg" },
      source: "DR.GLITCH sample artwork",
      document: {
        sheetSize: "11x15",
        orientation: "portrait",
        scalePercent: 100,
        background: "white",
        mirrorImage: false,
        mirrorDirection: "horizontal",
      },
      settings: EXPECTED_DEFAULT_SETTINGS,
      plates: ["cyan", "magenta", "yellow", "black"],
      omittedPlates: [],
      registration: true,
      registrationWeight: 1,
      registrationMode: "corners",
      // Legacy SVG output block: dimensions + dpi only (no screen load).
      output: { width: 240, height: 300, dpi: 240 },
      // Legacy vector markers.
      fill: "#000000",
      vector: true,
      layers: [{
        source: "Artwork",
        visible: true,
        mode: "halftone",
        opacity: 1,
        dotShape: "round",
        cellSize: 12,
      }],
      dpi: 240,
      artboard: { widthPx: 240, heightPx: 300 },
      separation: {
        mode: "cmyk",
        angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
        visible: { cyan: true, magenta: true, yellow: true, black: true },
      },
      outputDefaults: {
        polarity: "positive",
        pressMirror: false,
        registrationOnPlates: true,
        registrationOnComposite: false,
      },
    });
  });
});

describe("plate-package job-settings.json: custom shape echoes", () => {
  it("embeds the resolved custom dot shape and registration mark, and the settings echo round-trips through parseSettings", async () => {
    const core = makeCore();
    core.layers[0].recipe.halftone.dotShape = "custom";
    core.layers[0].recipe.halftone.customShapeAssetId = SHAPE_ID;
    core.registration.customShapeAssetId = MARK_ID;
    const ringSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">' +
      '<path fill-rule="evenodd" d="M0 0H100V100H0Z M25 25V75H75V25Z"/></svg>';
    const resolved: string[] = [];
    const { manifest } = await exportManifest(core, "png", {
      resolveCustomShape: async (assetId) => {
        resolved.push(assetId);
        return assetId === SHAPE_ID
          ? { filename: "ring.svg", svg: ringSvg }
          : { filename: "mark.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' };
      },
    });
    expect(resolved).toEqual([SHAPE_ID, MARK_ID]);
    // custom-shape.spec.ts:148-149 oracles:
    expect(manifest.settings).toMatchObject({
      dotShape: "custom",
      grayscale: false,
      customShape: { filename: "ring.svg" },
    });
    expect(
      (manifest.settings as { customShape: { svg: string } }).customShape.svg,
    ).toContain('preserveAspectRatio="none"');
    expect(manifest.registrationShape).toEqual({
      filename: "mark.svg",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
    });
    // custom-shape.spec.ts re-renders plates from parseSettings(job.settings):
    // the echo must be a valid legacy settings document.
    const parsed = parseSettings(manifest.settings);
    expect(parsed.ok).toBe(true);
  });

  it("omits the customShape key when no resolver is provided (legacy undefined-drop semantics)", async () => {
    const core = makeCore();
    core.layers[0].recipe.halftone.dotShape = "custom";
    core.layers[0].recipe.halftone.customShapeAssetId = SHAPE_ID;
    const { manifest } = await exportManifest(core, "png");
    expect(manifest.settings).toMatchObject({ dotShape: "custom" });
    expect(manifest.settings).not.toHaveProperty("customShape");
    expect(manifest).not.toHaveProperty("registrationShape");
  });
});
