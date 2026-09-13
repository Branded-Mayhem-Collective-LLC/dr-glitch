import { describe, expect, it, vi } from "vitest";
import type { LayerV1, PlateId, ProjectCoreV1 } from "../../src/core/types";
import {
  deliverExportFiles,
  ExportCancelledError,
  ExportError,
  startExport,
  totalExportBytes,
  type ExportEncoders,
  type ExportFile,
  type ExportProgress,
  type RasterData,
  type RenderRequestOptions,
  type RenderService,
} from "../../src/export/orchestrator";
import { MAX_BUFFERED_PLATE_PACKAGE_BYTES } from "../../src/export/targets";

const ASSET_ID = "a".repeat(64);

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
      position: { x: 0, y: 0 },
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

type RenderCall = {
  method: string;
  plate?: PlateId;
  layerId?: string;
  core: ProjectCoreV1;
  options: RenderRequestOptions;
};

function makeRenderService(overrides: Partial<RenderService> = {}) {
  const calls: RenderCall[] = [];
  const service: RenderService = {
    async renderComposite(core, options) {
      calls.push({ method: "renderComposite", core, options });
      return raster;
    },
    async renderPlate(core, plate, options) {
      calls.push({ method: "renderPlate", plate, core, options });
      return raster;
    },
    async renderPlateSvg(core, plate, options) {
      calls.push({ method: "renderPlateSvg", plate, core, options });
      return `<svg data-plate="${plate}"/>`;
    },
    async renderLayer(core, layerId, options) {
      calls.push({ method: "renderLayer", layerId, core, options });
      return raster;
    },
    ...overrides,
  };
  return { service, calls };
}

function makeEncoders() {
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
  return { encoders, zipCalls };
}

describe("startExport: composite", () => {
  it("renders, encodes, and reports monotonic progress to completion", async () => {
    const { service, calls } = makeRenderService();
    const { encoders } = makeEncoders();
    const progress: ExportProgress[] = [];
    const job = startExport({
      core: makeCore(),
      revision: 12,
      sourceName: "Print Loud",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders,
      onProgress: (update) => progress.push(update),
    });
    const files = await job.result;
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("print-loud-halftone.png");
    expect(calls.map(({ method }) => method)).toEqual(["renderComposite"]);
    expect(calls[0].options.registration).toBe(false);
    expect(calls[0].options.matte).toBe("#ffffff");
    const fractions = progress.map(({ fraction }) => fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it("freezes the project revision: later mutations never reach the renderer", async () => {
    const { service, calls } = makeRenderService();
    const { encoders } = makeEncoders();
    const core = makeCore();
    const job = startExport({
      core,
      revision: 5,
      sourceName: "t",
      target: { kind: "composite", format: "tiff" },
      render: service,
      encoders,
    });
    // Mutate after the job started; the frozen clone must be unaffected.
    core.artboard.widthPx = 9999;
    core.layers.pop();
    await job.result;
    expect(job.revision).toBe(5);
    expect(calls[0].core.artboard.widthPx).toBe(240);
    expect(calls[0].core.layers).toHaveLength(1);
    expect(calls[0].options.revision).toBe(5);
  });
});

describe("startExport: plate package", () => {
  it("preserves the stored custom-dot SVG in a diffusion job manifest", async () => {
    const core = makeCore();
    core.layers[0].recipe.mode = "diffusion";
    core.layers[0].recipe.halftone.dotShape = "custom";
    core.layers[0].recipe.halftone.customShapeAssetId = "b".repeat(64);
    const shape = { filename: "retained-dot.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' };
    const { service } = makeRenderService();
    const { encoders, zipCalls } = makeEncoders();
    const job = startExport({ core, revision: 1, sourceName: "Diffusion", target: { kind: "plate-package", format: "png" },
      render: service, encoders, resolveCustomShape: async () => shape });
    await job.result;
    const manifest = JSON.parse(zipCalls[0].find(entry => entry.name === "job-settings.json")!.data as string);
    expect(manifest.settings.diffusionEnabled).toBe(true);
    expect(manifest.settings.customShape).toEqual(shape);
  });
  it("packages every visible plate plus a job manifest, registration on by default", async () => {
    const { service, calls } = makeRenderService();
    const { encoders, zipCalls } = makeEncoders();
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "Print Loud",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    });
    const files = await job.result;
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("print-loud-CMYK-plates.zip");
    expect(calls.map(({ plate }) => plate)).toEqual(["cyan", "magenta", "yellow", "black"]);
    expect(calls.every(({ options }) => options.registration === true)).toBe(true);
    expect(zipCalls).toHaveLength(1);
    expect(zipCalls[0].map(({ name }) => name)).toEqual([
      "print-loud-C-plate.png",
      "print-loud-M-plate.png",
      "print-loud-Y-plate.png",
      "print-loud-K-plate.png",
      "job-settings.json",
    ]);
    const manifest = JSON.parse(zipCalls[0][4].data as string);
    expect(manifest.revision).toBe(1);
    expect(manifest.registration).toBe(true);
    expect(manifest.dpi).toBe(240);
  });

  it("uses the vector renderer for SVG packages", async () => {
    const { service, calls } = makeRenderService();
    const { encoders, zipCalls } = makeEncoders();
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "svg" },
      render: service,
      encoders,
    });
    const files = await job.result;
    expect(calls.every(({ method }) => method === "renderPlateSvg")).toBe(true);
    expect(zipCalls[0][0].data).toContain("<svg");
    // Legacy vector package shape: folder-shaped ZIP, entries in the folder.
    expect(files[0].name).toBe("t_SVG_Plates.zip");
    expect(zipCalls[0].map(({ name }) => name)).toEqual([
      "t_SVG_Plates/C.svg",
      "t_SVG_Plates/M.svg",
      "t_SVG_Plates/Y.svg",
      "t_SVG_Plates/K.svg",
      "t_SVG_Plates/job-settings.json",
    ]);
  });

  it("rejects cumulative actual SVG entry bytes above the buffered cap before ZIP", async () => {
    const payload = "x".repeat(Math.floor(MAX_BUFFERED_PLATE_PACKAGE_BYTES / 4));
    const { service } = makeRenderService({
      renderPlateSvg: async (_core, plate) => `<svg data-plate="${plate}">${payload}</svg>`,
    });
    const zip = vi.fn(async () => new Blob(["zip"], { type: "application/zip" }));
    const encoders: ExportEncoders = { ...makeEncoders().encoders, zip };
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "svg" },
      render: service,
      encoders,
    });

    await expect(job.result).rejects.toMatchObject({ code: "delivery-exceeded" });
    expect(zip).not.toHaveBeenCalled();
  });

  it("rejects cumulative actual PNG entry bytes above the buffered cap before ZIP", async () => {
    const { service } = makeRenderService();
    const oversizedQuarter = {
      size: Math.floor(MAX_BUFFERED_PLATE_PACKAGE_BYTES / 4) + 1,
    } as Blob;
    const zip = vi.fn(async () => new Blob(["zip"], { type: "application/zip" }));
    const base = makeEncoders().encoders;
    const encoders: ExportEncoders = {
      ...base,
      encodePng: async () => oversizedQuarter,
      zip,
    };
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    });

    await expect(job.result).rejects.toMatchObject({ code: "delivery-exceeded" });
    expect(zip).not.toHaveBeenCalled();
  });

  it("rejects a ZIP encoder result above the buffered archive-return cap", async () => {
    const { service } = makeRenderService();
    const oversizedArchive = { size: MAX_BUFFERED_PLATE_PACKAGE_BYTES + 1 } as Blob;
    const zip = vi.fn(async () => oversizedArchive);
    const encoders: ExportEncoders = { ...makeEncoders().encoders, zip };
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    });

    await expect(job.result).rejects.toMatchObject({ code: "delivery-exceeded" });
    expect(zip).toHaveBeenCalledOnce();
  });

  it("emits nothing when a plate render fails midway", async () => {
    let plateCount = 0;
    const { service } = makeRenderService({
      async renderPlate(core, plate, options) {
        plateCount += 1;
        if (plateCount === 2) throw new Error("renderer crashed");
        void core;
        void plate;
        void options;
        return raster;
      },
    });
    const { encoders, zipCalls } = makeEncoders();
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    });
    await expect(job.result).rejects.toMatchObject({ code: "export-failed" });
    expect(zipCalls).toHaveLength(0); // no partial archive was ever assembled
  });
});

describe("startExport: selected layer", () => {
  it("renders the requested layer transparent with registration off", async () => {
    const { service, calls } = makeRenderService();
    const { encoders } = makeEncoders();
    const job = startExport({
      core: makeCore(),
      revision: 3,
      sourceName: "Print Loud",
      target: { kind: "selected-layer", format: "tiff", layerId: "layer-1" },
      render: service,
      encoders,
    });
    const files = await job.result;
    expect(files[0].name).toBe("print-loud-layer.tiff");
    expect(calls[0].method).toBe("renderLayer");
    expect(calls[0].layerId).toBe("layer-1");
    expect(calls[0].options.registration).toBe(false);
    expect(calls[0].options.matte).toBeNull();
  });
});

describe("startExport: cancellation", () => {
  it("cancel is explicit, rejects with ExportCancelledError, and emits nothing", async () => {
    const { service } = makeRenderService({
      renderPlate(core, plate, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const { encoders, zipCalls } = makeEncoders();
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    });
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ExportCancelledError);
    expect(zipCalls).toHaveLength(0);
  });

  it("a job left alone completes without any implicit cancellation", async () => {
    const { service } = makeRenderService();
    const { encoders } = makeEncoders();
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "composite", format: "jpeg" },
      render: service,
      encoders,
    });
    await expect(job.result).resolves.toHaveLength(1);
  });
});

describe("deliverExportFiles", () => {
  const smallFile: ExportFile = { name: "a.png", blob: new Blob(["12345"]) };

  it("falls back to Blob downloads under the size cap", async () => {
    const saved: string[] = [];
    const mode = await deliverExportFiles([smallFile], {
      saveBlob: (file) => saved.push(file.name),
      maxBlobBytes: 1024,
    });
    expect(mode).toBe("blob-download");
    expect(saved).toEqual(["a.png"]);
  });

  it("refuses oversized Blob downloads without File System Access", async () => {
    await expect(
      deliverExportFiles([smallFile], { saveBlob: () => {}, maxBlobBytes: 2 }),
    ).rejects.toMatchObject({ code: "export-too-large" });
  });

  it("streams through File System Access when available", async () => {
    const written: string[] = [];
    const mode = await deliverExportFiles([smallFile], {
      saveBlob: () => {
        throw new Error("saveBlob must not be used when a picker exists");
      },
      maxBlobBytes: 2, // too large for Blob fallback — streaming must win
      showSaveFilePicker: async (options) => ({
        createWritable: async () => ({
          write: async () => {
            written.push(options?.suggestedName ?? "?");
          },
          close: async () => {},
        }),
      }),
    });
    expect(mode).toBe("file-system-access");
    expect(written).toEqual(["a.png"]);
  });

  it("sums export bytes", () => {
    expect(totalExportBytes([smallFile, smallFile])).toBe(10);
  });

  it("exposes typed error codes", () => {
    const error = new ExportError("export-failed", "boom");
    expect(error.code).toBe("export-failed");
    expect(new ExportCancelledError().code).toBe("export-cancelled");
  });
});

describe("startExport: cancellation during encode (wave G1)", () => {
  it("cancel during a HUNG encoder rejects within 250ms and emits nothing", async () => {
    const { service } = makeRenderService();
    // Instrumented slow fixture: an encoder that never settles until long
    // after the latency budget — the orchestrator must not wait for it.
    let encoderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encoderStarted = resolve;
    });
    const encoders: ExportEncoders = {
      async encodePng() {
        encoderStarted();
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return new Blob(["late"], { type: "image/png" });
      },
      async encodeJpeg() {
        throw new Error("unused");
      },
      async encodeTiff() {
        throw new Error("unused");
      },
      async zip() {
        throw new Error("never packaged after cancel");
      },
    };
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders,
    });
    await started; // the encode phase is running now
    const cancelledAt = Date.now();
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ExportCancelledError);
    expect(Date.now() - cancelledAt).toBeLessThanOrEqual(250);
  });

  it("cancel during ZIP packaging rejects promptly without partial output", async () => {
    const { service } = makeRenderService();
    let zipStarted!: () => void;
    let zipSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      zipStarted = resolve;
    });
    const encoders: ExportEncoders = {
      async encodePng() {
        return new Blob(["png"], { type: "image/png" });
      },
      async encodeJpeg() {
        throw new Error("unused");
      },
      async encodeTiff() {
        throw new Error("unused");
      },
      async zip(_entries, signal) {
        zipSignal = signal;
        zipStarted();
        return new Promise<Blob>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("ZIP aborted")), {
            once: true,
          });
        });
      },
    };
    const job = startExport({
      core: makeCore(),
      revision: 1,
      sourceName: "t",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders,
    });
    await started;
    const cancelledAt = Date.now();
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ExportCancelledError);
    expect(Date.now() - cancelledAt).toBeLessThanOrEqual(250);
    expect(zipSignal).toBeDefined();
    expect(zipSignal?.aborted).toBe(true);
  });
});
