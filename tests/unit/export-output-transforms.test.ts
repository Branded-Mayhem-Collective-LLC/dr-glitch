/**
 * Output polarity + press mirror (src/export/output-transforms.ts) and
 * their orchestrator wiring: polarity inverts plate ink only (plate
 * packages), press mirror flips every export raster and SVG plate —
 * registration marks flip with the sheet because they are rendered into it
 * before the transform. Negative polarity on vector plates is refused.
 */
import { describe, expect, it } from "vitest";
import type { LayerV1, ProjectCoreV1 } from "../../src/core/types";
import {
  invertPlateInk,
  mirrorRasterHorizontal,
  mirrorSvgHorizontal,
  PLATE_INK_RGB,
  polarityApplies,
  transformExportRaster,
} from "../../src/export/output-transforms";
import {
  startExport,
  type ExportEncoders,
  type RasterData,
  type RenderService,
} from "../../src/export/orchestrator";
import type { ExportTarget } from "../../src/export/targets";

function makeLayer(): LayerV1 {
  return {
    id: "layer-1",
    name: "Artwork",
    assetId: "a".repeat(64),
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

function makeCore(overrides: Partial<ProjectCoreV1["output"]> = {}): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: 240, heightPx: 300, presetId: "custom", background: "white" },
    layers: [makeLayer()],
    separation: {
      mode: "cmyk",
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: false, yellow: false, black: false },
    },
    registration: { size: null, offset: null, weight: 1, mode: "corners", customShapeAssetId: null },
    guides: { horizontal: [], vertical: [], locked: false, visible: true },
    grid: { visible: false, size: 24 },
    snapping: { enabled: true, toGuides: true, toGrid: false, toLayers: true, toArtboard: true },
    output: {
      polarity: "positive",
      pressMirror: false,
      registrationOnPlates: false,
      registrationOnComposite: false,
      ...overrides,
    },
    unitPreference: "px",
  };
}

/** 2x1 marker raster: left pixel opaque red, right transparent. */
function markerRaster(): RasterData {
  const data = new Uint8ClampedArray(8);
  data.set([255, 0, 0, 255, 0, 0, 0, 0]);
  return { width: 2, height: 1, data };
}

describe("invertPlateInk", () => {
  it("inverts coverage in alpha and forces the plate ink RGB everywhere", () => {
    const data = new Uint8ClampedArray(12);
    data.set([0, 0, 0, 0, 99, 99, 99, 255, 1, 2, 3, 102]);
    const out = invertPlateInk({ width: 3, height: 1, data });
    const [red, green, blue] = PLATE_INK_RGB;
    for (const pixel of [0, 1, 2]) {
      expect(out.data[pixel * 4]).toBe(red);
      expect(out.data[pixel * 4 + 1]).toBe(green);
      expect(out.data[pixel * 4 + 2]).toBe(blue);
    }
    expect(out.data[3]).toBe(255); // open area becomes full ink
    expect(out.data[7]).toBe(0); // full ink becomes clear
    expect(out.data[11]).toBe(153); // partial (registration ghost) inverts
  });
});

describe("mirrorRasterHorizontal", () => {
  it("reverses each row's pixels", () => {
    const out = mirrorRasterHorizontal(markerRaster());
    expect([...out.data.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...out.data.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it("is an involution", () => {
    const raster = markerRaster();
    const twice = mirrorRasterHorizontal(mirrorRasterHorizontal(raster));
    expect([...twice.data]).toEqual([...raster.data]);
  });
});

describe("mirrorSvgHorizontal", () => {
  it("wraps root content, marks included, in a flip group", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300"><g fill="#000000"><circle cx="10" cy="10" r="4"/></g><g stroke="#000000">marks</g></svg>`;
    const mirrored = mirrorSvgHorizontal(svg, 240);
    expect(mirrored).toContain('<g transform="translate(240 0) scale(-1 1)">');
    expect(mirrored.indexOf("translate(240 0)")).toBeLessThan(mirrored.indexOf("<circle"));
    expect(mirrored.indexOf("marks")).toBeLessThan(mirrored.lastIndexOf("</g></svg>"));
    expect(mirrored.startsWith("<svg ")).toBe(true);
    expect(mirrored.endsWith("</svg>")).toBe(true);
  });
});

describe("transformExportRaster", () => {
  const plateTarget: ExportTarget = { kind: "plate-package", format: "png" };
  const compositeTarget: ExportTarget = { kind: "composite", format: "png" };
  const layerTarget: ExportTarget = { kind: "selected-layer", format: "tiff", layerId: "x" };

  it("polarity applies to plate packages only", () => {
    expect(polarityApplies(plateTarget)).toBe(true);
    expect(polarityApplies(compositeTarget)).toBe(false);
    expect(polarityApplies(layerTarget)).toBe(false);
    const output = makeCore({ polarity: "negative" }).output;
    const raster = markerRaster();
    const plate = transformExportRaster(raster, plateTarget, output);
    expect(plate.data[3]).toBe(0); // inverted
    const composite = transformExportRaster(raster, compositeTarget, output);
    expect([...composite.data]).toEqual([...raster.data]); // untouched
  });

  it("press mirror applies to every target, after polarity", () => {
    const output = makeCore({ polarity: "negative", pressMirror: true }).output;
    const raster = markerRaster();
    const plate = transformExportRaster(raster, plateTarget, output);
    // Inverted then mirrored: left pixel was transparent → full ink, now on the right.
    expect(plate.data[7]).toBe(0); // originally-opaque pixel, inverted, mirrored to left
    expect(plate.data[3]).toBe(255);
    const layer = transformExportRaster(raster, layerTarget, output);
    expect([...layer.data.slice(4, 8)]).toEqual([255, 0, 0, 255]); // mirror only
  });
});

/* ------------------------------------------------------------------ */
/* Orchestrator wiring                                                 */
/* ------------------------------------------------------------------ */

function makeService(raster: RasterData): { service: RenderService; svg: string } {
  const svg = `<svg viewBox="0 0 240 300"><g fill="#000000"><rect x="1" y="1" width="2" height="2"/></g></svg>`;
  const service: RenderService = {
    async renderComposite() {
      return raster;
    },
    async renderPlate() {
      return raster;
    },
    async renderPlateSvg() {
      return svg;
    },
    async renderLayer() {
      return raster;
    },
  };
  return { service, svg };
}

function captureEncoders(): { encoders: ExportEncoders; rasters: RasterData[]; dpis: number[] } {
  const rasters: RasterData[] = [];
  const dpis: number[] = [];
  const encoders: ExportEncoders = {
    async encodePng(raster, dpi) {
      rasters.push(raster);
      dpis.push(dpi);
      return new Blob(["png"], { type: "image/png" });
    },
    async encodeJpeg(raster) {
      rasters.push(raster);
      return new Blob(["jpeg"], { type: "image/jpeg" });
    },
    async encodeTiff(raster, dpi) {
      rasters.push(raster);
      dpis.push(dpi);
      return new Blob(["tiff"], { type: "image/tiff" });
    },
    async zip(entries) {
      void entries;
      return new Blob(["zip"], { type: "application/zip" });
    },
  };
  return { encoders, rasters, dpis };
}

describe("orchestrator output-transform wiring", () => {
  it("mirrors composite and selected-layer rasters (polarity exempt) at 240 DPI", async () => {
    const core = makeCore({ pressMirror: true, polarity: "negative" });
    const { service } = makeService(markerRaster());
    for (const target of [
      { kind: "composite", format: "png" } as const,
      { kind: "selected-layer", format: "tiff", layerId: "layer-1" } as const,
    ]) {
      const { encoders, rasters, dpis } = captureEncoders();
      await startExport({ core, revision: 1, sourceName: "t", target, render: service, encoders }).result;
      expect(rasters).toHaveLength(1);
      // Mirrored: red pixel moved right; polarity did NOT invert alpha.
      expect([...rasters[0].data.slice(4, 8)]).toEqual([255, 0, 0, 255]);
      expect([...rasters[0].data.slice(0, 4)]).toEqual([0, 0, 0, 0]);
      expect(dpis[0]).toBe(240);
    }
  });

  it("applies polarity then mirror to raster plate packages", async () => {
    const core = makeCore({ pressMirror: true, polarity: "negative" });
    const { service } = makeService(markerRaster());
    const { encoders, rasters } = captureEncoders();
    await startExport({
      core,
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    }).result;
    expect(rasters).toHaveLength(1); // one visible plate (cyan)
    const [red, green, blue] = PLATE_INK_RGB;
    // Left pixel: originally transparent → inverted to full ink → mirrored from the right.
    expect([...rasters[0].data.slice(0, 4)]).toEqual([red, green, blue, 255]);
    expect(rasters[0].data[7]).toBe(0);
  });

  it("mirrors SVG plate documents as a string transform", async () => {
    const core = makeCore({ pressMirror: true });
    const { service } = makeService(markerRaster());
    const { encoders } = captureEncoders();
    const entries: { name: string; data: Blob | string }[][] = [];
    encoders.zip = async (zipEntries) => {
      entries.push(zipEntries);
      return new Blob(["zip"], { type: "application/zip" });
    };
    await startExport({
      core,
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "svg" },
      render: service,
      encoders,
    }).result;
    const svgEntry = entries[0][0].data as string;
    expect(svgEntry).toContain('transform="translate(240 0) scale(-1 1)"');
  });

  it("refuses negative-polarity vector plate packages", async () => {
    const core = makeCore({ polarity: "negative" });
    const { service } = makeService(markerRaster());
    const { encoders } = captureEncoders();
    const job = startExport({
      core,
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "svg" },
      render: service,
      encoders,
    });
    await expect(job.result).rejects.toMatchObject({ code: "polarity-vector-unsupported" });
  });
});
