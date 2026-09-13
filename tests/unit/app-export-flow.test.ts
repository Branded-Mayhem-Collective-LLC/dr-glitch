/**
 * Studio export flow — the UI-level pipeline binding: asset info loading
 * (MemoryBackend), preflight with explicit probed capabilities,
 * revision-bound warning acknowledgement, orchestrated start with a frozen
 * core/revision, cancel without delivery, the legacy-vs-worker routing
 * predicate, the custom-registration wrapper, and the dev delay seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSentryInitOptions,
  initTelemetry,
  resetTelemetryForTests,
  type SentryEventLike,
  type SentryModuleLike,
} from "../../src/telemetry/sentry";
import {
  collectReferencedAssetIds,
  createWarningGate,
  deliverStudioExport,
  loadAssetInfos,
  preflightForTarget,
  registrationLayout,
  startStudioExport,
  withCustomRegistration,
  withRenderStepDelay,
} from "../../src/app/export-flow";
import { probeEnvironmentCapabilities } from "../../src/app/capabilities";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { PreflightIssue, ProjectCoreV1 } from "../../src/core/types";
import { createRoutedRenderService } from "../../src/export/current-engine";
import {
  ExportCancelledError,
  ExportError,
  type ExportEncoders,
  type RasterData,
  type RenderService,
} from "../../src/export/orchestrator";
import { applyCommand, createEmptyProjectCore, createLayerFromAsset } from "../../src/project";
import { AssetRepository } from "../../src/storage/asset-repository";
import { MemoryBackend } from "../../src/storage/memory-backend";

const ENV_FULL = probeEnvironmentCapabilities({
  Worker: function Worker() {},
  OffscreenCanvas: function OffscreenCanvas() {},
  createImageBitmap: () => Promise.resolve({}),
  showSaveFilePicker: () => Promise.resolve({}),
});
const ENV_BARE = probeEnvironmentCapabilities({});

const ASSET_A = "a".repeat(64);
const ASSET_SHAPE = "b".repeat(64);

function coreWithLayer(assetId = ASSET_A): ProjectCoreV1 {
  let core = createEmptyProjectCore({ widthPx: 640, heightPx: 480, presetId: "custom" });
  const layer = createLayerFromAsset(
    assetId,
    "art.png",
    { width: core.artboard.widthPx, height: core.artboard.heightPx },
    core.artboard,
  );
  core = applyCommand(core, { type: "layer/add", layer });
  core = applyCommand(core, {
    type: "layer/set-mode",
    layerId: core.layers[0].id,
    mode: "halftone",
  });
  return core;
}

function raster(width = 2, height = 2): RasterData {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

function fakeService(overrides: Partial<Record<keyof RenderService, unknown>> = {}): {
  service: RenderService;
  calls: string[];
} {
  const calls: string[] = [];
  const service: RenderService = {
    renderComposite: vi.fn(async () => {
      calls.push("composite");
      return raster();
    }),
    renderPlate: vi.fn(async () => {
      calls.push("plate");
      return raster();
    }),
    renderPlateSvg: vi.fn(async () => {
      calls.push("svg");
      return "<svg><circle/></svg>";
    }),
    renderLayer: vi.fn(async () => {
      calls.push("layer");
      return raster();
    }),
    ...(overrides as Partial<RenderService>),
  };
  return { service, calls };
}

const FAKE_ENCODERS: ExportEncoders = {
  encodePng: async () => new Blob(["png"], { type: "image/png" }),
  encodeJpeg: async () => new Blob(["jpg"], { type: "image/jpeg" }),
  encodeTiff: async () => new Blob(["tiff"], { type: "image/tiff" }),
  zip: async (entries) => new Blob([`zip:${entries.length}`], { type: "application/zip" }),
};

/* ------------------------------------------------------------------ */
/* Referenced assets + MemoryBackend info loading                      */
/* ------------------------------------------------------------------ */

describe("collectReferencedAssetIds", () => {
  it("gathers layer assets, custom dot shapes, and registration shapes once", () => {
    let core = coreWithLayer();
    core = applyCommand(core, {
      type: "recipe/update-halftone",
      layerId: core.layers[0].id,
      patch: { dotShape: "custom", customShapeAssetId: ASSET_SHAPE },
    });
    core = applyCommand(core, {
      type: "registration/update",
      patch: { customShapeAssetId: ASSET_SHAPE },
    });
    expect(collectReferencedAssetIds(core).sort()).toEqual([ASSET_A, ASSET_SHAPE].sort());
  });
});

describe("loadAssetInfos (MemoryBackend)", () => {
  it("resolves records for raster and svg assets; missing ids are omitted", async () => {
    const repository = new AssetRepository(new MemoryBackend());
    const rasterRecord = await repository.putBlob(
      new TextEncoder().encode("raster-bytes"),
      "raster",
      "image/png",
      { width: 640, height: 480 },
    );
    const svgRecord = await repository.putBlob(
      new TextEncoder().encode("<svg/>"),
      "svg",
      "image/svg+xml",
      { width: 100, height: 100 },
    );

    let core = coreWithLayer(rasterRecord.sha256);
    core = applyCommand(core, {
      type: "recipe/update-halftone",
      layerId: core.layers[0].id,
      patch: { dotShape: "custom", customShapeAssetId: svgRecord.sha256 },
    });
    core = applyCommand(core, {
      type: "registration/update",
      patch: { customShapeAssetId: "f".repeat(64) },
    });

    const infos = await loadAssetInfos(core, repository);
    expect(infos.get(rasterRecord.sha256)).toMatchObject({
      kind: "raster",
      ok: true,
      width: 640,
      height: 480,
    });
    expect(infos.get(svgRecord.sha256)).toMatchObject({ kind: "svg", ok: true });
    expect(infos.has("f".repeat(64))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Preflight with explicit capabilities                                */
/* ------------------------------------------------------------------ */

describe("preflightForTarget", () => {
  const core = coreWithLayer();
  const lookup = (assetId: string) =>
    assetId === ASSET_A
      ? {
          sha256: ASSET_A,
          kind: "raster" as const,
          ok: true,
          width: core.artboard.widthPx,
          height: core.artboard.heightPx,
          byteLength: 1000,
        }
      : null;

  it("reports missing assets as hard blocks when the lookup is empty", () => {
    const issues = preflightForTarget(
      core,
      () => null,
      { kind: "composite", format: "png" },
      1,
      ENV_FULL,
    );
    expect(issues.some((issue) => issue.code === "asset-missing")).toBe(true);
  });

  it("binds issues to the given revision", () => {
    const issues = preflightForTarget(
      core,
      lookup,
      { kind: "composite", format: "png" },
      42,
      ENV_FULL,
    );
    expect(issues.every((issue) => issue.revision === 42)).toBe(true);
  });

  it("passes the PROBED capabilities into evaluate (delivery rules flip)", () => {
    const tinyPolicy = { ...RESOURCE_POLICY, maxBlobDownloadBytes: 16 };
    const target = { kind: "composite", format: "tiff" } as const;
    const withPicker = preflightForTarget(core, lookup, target, 1, ENV_FULL, tinyPolicy);
    const withoutPicker = preflightForTarget(core, lookup, target, 1, ENV_BARE, tinyPolicy);
    expect(withPicker.some((issue) => issue.code === "delivery-exceeded")).toBe(false);
    expect(withoutPicker.some((issue) => issue.code === "delivery-exceeded")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Warning gate (revision-bound acknowledgement)                       */
/* ------------------------------------------------------------------ */

describe("createWarningGate", () => {
  const warn = (id: string, revision: number): PreflightIssue => ({
    id,
    severity: "warn",
    code: "angle-duplicate",
    message: "angles collide",
    revision,
  });
  const block = (id: string, revision: number): PreflightIssue => ({
    id,
    severity: "block",
    code: "asset-missing",
    message: "missing",
    revision,
  });

  it("requires confirmation once, then admits the identical warn set", () => {
    const gate = createWarningGate();
    const issues = [warn("w1", 5), warn("w2", 5)];
    expect(gate.unconfirmed(issues)).toHaveLength(2);
    gate.confirm(issues);
    expect(gate.unconfirmed(issues)).toEqual([]);
  });

  it("re-demands confirmation when the revision advances", () => {
    const gate = createWarningGate();
    gate.confirm([warn("w1", 5)]);
    expect(gate.unconfirmed([warn("w1", 6)])).toHaveLength(1);
  });

  it("re-demands confirmation of the WHOLE set when the warn set changes", () => {
    const gate = createWarningGate();
    gate.confirm([warn("w1", 5)]);
    expect(gate.unconfirmed([warn("w1", 5), warn("w2", 5)])).toHaveLength(2);
  });

  it("ignores blocks and passes clean sets straight through", () => {
    const gate = createWarningGate();
    expect(gate.unconfirmed([block("b1", 5)])).toEqual([]);
    expect(gate.unconfirmed([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* startStudioExport: frozen revision/core, delivery, cancel           */
/* ------------------------------------------------------------------ */

describe("startStudioExport", () => {
  it("freezes the core and carries the session revision on every render", async () => {
    const seen: { revision: number; layers: number }[] = [];
    const { service } = fakeService({
      renderComposite: vi.fn(async (core: ProjectCoreV1, options: { revision: number }) => {
        seen.push({ revision: options.revision, layers: core.layers.length });
        return raster();
      }),
    });
    const core = coreWithLayer();
    const deliver = vi.fn(async () => undefined);
    const run = startStudioExport({
      core,
      revision: 7,
      sourceName: "Frozen",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver,
    });
    // Mutating the caller's core after start must not reach the renderer.
    core.layers.length = 0;
    const files = await run.done;
    expect(seen).toEqual([{ revision: 7, layers: 1 }]);
    expect(deliver).toHaveBeenCalledWith(files);
    expect(files[0].name).toBe("frozen-halftone.png");
  });

  it("cancel mid-export rejects with ExportCancelledError and never delivers", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = fakeService({
      renderPlate: vi.fn(async (_core: unknown, _plate: unknown, options: { signal: AbortSignal }) => {
        await gate;
        if (options.signal.aborted) throw new ExportCancelledError();
        return raster();
      }),
    });
    const deliver = vi.fn(async () => undefined);
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 3,
      sourceName: "Cancelled",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver,
    });
    run.cancel();
    release!();
    await expect(run.done).rejects.toBeInstanceOf(ExportCancelledError);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports monotonic progress through the orchestrator", async () => {
    const { service } = fakeService();
    const fractions: number[] = [];
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "Progress",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
      onProgress: (progress) => fractions.push(progress.fraction),
    });
    await run.done;
    expect(fractions.length).toBeGreaterThan(2);
    for (let index = 1; index < fractions.length; index += 1) {
      expect(fractions[index]).toBeGreaterThanOrEqual(fractions[index - 1]);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Routing: the legacy predicate is the only parity gate               */
/* ------------------------------------------------------------------ */

describe("routing through createRoutedRenderService", () => {
  const dims = new Map([[ASSET_A, { width: 640, height: 480 }]]);
  const lookup = (assetId: string) => dims.get(assetId) ?? null;

  it("a legacy-eligible single-layer project renders through the legacy engine verbatim", async () => {
    const legacyRaster = raster(4, 4);
    legacyRaster.data.fill(123);
    const legacy = fakeService({ renderComposite: vi.fn(async () => legacyRaster) });
    const worker = fakeService();
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker: worker.service,
      assetDimensions: lookup,
    });
    const encodedRasters: RasterData[] = [];
    const encoders: ExportEncoders = {
      ...FAKE_ENCODERS,
      encodePng: async (input) => {
        encodedRasters.push(input);
        return new Blob(["png"]);
      },
    };
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "Legacy",
      target: { kind: "composite", format: "png" },
      render: routed,
      encoders,
      deliver: async () => undefined,
    });
    await run.done;
    expect(legacy.service.renderComposite).toHaveBeenCalledTimes(1);
    expect(worker.calls).toEqual([]);
    // Byte-identical delegation: the encoder received the legacy engine's
    // exact pixels (mirror is off, so the transform pass is identity).
    expect(encodedRasters[0].data).toEqual(legacyRaster.data);
  });

  it("a multi-layer stack routes to the worker service for every plate", async () => {
    let core = coreWithLayer();
    const second = createLayerFromAsset(
      ASSET_A,
      "art-2.png",
      { width: 2640, height: 3600 },
      core.artboard,
    );
    core = applyCommand(core, { type: "layer/add", layer: second });

    const legacy = fakeService();
    const worker = fakeService();
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker: worker.service,
      assetDimensions: lookup,
    });
    const run = startStudioExport({
      core,
      revision: 1,
      sourceName: "Stack",
      target: { kind: "plate-package", format: "png" },
      render: routed,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    await run.done;
    expect(legacy.calls).toEqual([]);
    expect(worker.calls).toEqual(["plate", "plate", "plate", "plate"]);
  });

  it("a transformed single layer also leaves the legacy engine", async () => {
    let core = coreWithLayer();
    core = applyCommand(core, {
      type: "layer/set-transform",
      layerId: core.layers[0].id,
      patch: { rotation: 12 },
    });
    const legacy = fakeService();
    const worker = fakeService();
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker: worker.service,
      assetDimensions: lookup,
    });
    const run = startStudioExport({
      core,
      revision: 1,
      sourceName: "Warped",
      target: { kind: "composite", format: "png" },
      render: routed,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    await run.done;
    expect(legacy.calls).toEqual([]);
    expect(worker.calls).toEqual(["composite"]);
  });
});

/* ------------------------------------------------------------------ */
/* Multi-layer route through the REAL WorkerRenderService (vector)     */
/* ------------------------------------------------------------------ */

describe("multi-layer export through the real worker service", () => {
  it("renders a two-layer halftone stack to genuine vector plates with press mirror applied", async () => {
    // Small artboard; two visible halftone layers side by side.
    let core = createEmptyProjectCore({ widthPx: 64, heightPx: 64, presetId: "custom" });
    const left = createLayerFromAsset(ASSET_A, "left.png", { width: 16, height: 16 }, core.artboard);
    left.transform.position = { x: 16, y: 32 };
    const right = createLayerFromAsset(ASSET_A, "right.png", { width: 16, height: 16 }, core.artboard);
    right.transform.position = { x: 48, y: 32 };
    core = applyCommand(core, { type: "layer/add", layer: left });
    core = applyCommand(core, { type: "layer/add", layer: right });
    for (const layer of core.layers) {
      core = applyCommand(core, { type: "layer/set-mode", layerId: layer.id, mode: "halftone" });
      core = applyCommand(core, {
        type: "recipe/update-halftone",
        layerId: layer.id,
        patch: { cellSize: 8 },
      });
    }
    core = applyCommand(core, { type: "separation/set-mode", mode: "grayscale" });
    core = applyCommand(core, { type: "output/update", patch: { pressMirror: true } });

    // Solid dark source: every cell prints a dot.
    const dark = (): RasterData => {
      const data = new Uint8ClampedArray(16 * 16 * 4);
      for (let index = 0; index < data.length; index += 4) data[index + 3] = 255;
      return { data, width: 16, height: 16 };
    };
    const { createWorkerRenderService } = await import(
      "../../src/export/worker-render-service"
    );
    // Vector plates now run their numeric work (flatten/coverage/grid walk)
    // through the render port as a forced layer-data job — off the main
    // thread in production; MainThreadRenderer here. Only mark FORMATTING
    // stays with the service.
    const { MainThreadRenderer } = await import("../../src/render/main-thread-renderer");
    const worker = createWorkerRenderService({
      sources: { resolveRaster: async () => dark() },
      createPort: () => new MainThreadRenderer(false),
    });
    const legacy = fakeService();
    const routed = createRoutedRenderService({
      legacy: legacy.service,
      worker,
      assetDimensions: () => ({ width: 16, height: 16 }),
    });

    const zipped: { name: string; data: Blob | string }[][] = [];
    const encoders: ExportEncoders = {
      ...FAKE_ENCODERS,
      zip: async (entries) => {
        zipped.push(entries);
        return new Blob(["zip"]);
      },
    };
    const run = startStudioExport({
      core,
      revision: 9,
      sourceName: "Stack Vector",
      target: { kind: "plate-package", format: "svg" },
      render: routed,
      encoders,
      deliver: async () => undefined,
    });
    await run.done;

    expect(legacy.calls).toEqual([]); // multi-layer never touches the legacy engine
    const entries = zipped[0];
    const svgEntry = entries.find((entry) => entry.name.endsWith(".svg"));
    expect(svgEntry).toBeDefined();
    const svg = svgEntry!.data as string;
    // Two layer groups with real geometry, never embedded raster.
    expect(svg.match(/<g fill="#000000"/g)?.length).toBe(2);
    expect(svg).toMatch(/<circle|<rect|<path/);
    expect(svg).not.toContain("<image");
    // Press mirror applied by the orchestrator's output transform pass.
    expect(svg).toContain('transform="translate(64 0) scale(-1 1)"');
  });
});

/* ------------------------------------------------------------------ */
/* Custom registration wrapper                                         */
/* ------------------------------------------------------------------ */

describe("withCustomRegistration", () => {
  function customRegistrationCore(): ProjectCoreV1 {
    return applyCommand(coreWithLayer(), {
      type: "registration/update",
      patch: { customShapeAssetId: ASSET_SHAPE },
    });
  }
  const options = {
    revision: 1,
    registration: true,
    matte: null,
    signal: new AbortController().signal,
  };

  it("renders without registration and paints the marks afterwards", async () => {
    const inner = fakeService();
    const paintRaster = vi.fn(async () => undefined);
    const wrapped = withCustomRegistration(inner.service, {
      prepareRows: async () => ({ paintRows: async () => undefined, dispose: () => undefined }),
      paintRaster,
      svgFragment: async () => "",
    });
    await wrapped.renderComposite(customRegistrationCore(), options);
    const call = (inner.service.renderComposite as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].registration).toBe(false);
    expect(paintRaster).toHaveBeenCalledTimes(1);
  });

  it("passes built-in registration through untouched", async () => {
    const inner = fakeService();
    const paintRaster = vi.fn(async () => undefined);
    const wrapped = withCustomRegistration(inner.service, {
      prepareRows: async () => ({ paintRows: async () => undefined, dispose: () => undefined }),
      paintRaster,
      svgFragment: async () => "",
    });
    await wrapped.renderComposite(coreWithLayer(), options);
    const call = (inner.service.renderComposite as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].registration).toBe(true);
    expect(paintRaster).not.toHaveBeenCalled();
  });

  it("appends the SVG fragment as the final group", async () => {
    const inner = fakeService();
    const wrapped = withCustomRegistration(inner.service, {
      prepareRows: async () => ({ paintRows: async () => undefined, dispose: () => undefined }),
      paintRaster: async () => undefined,
      svgFragment: async () => '<g id="marks"/>',
    });
    const svg = await wrapped.renderPlateSvg(customRegistrationCore(), "black", options);
    expect(svg).toBe('<svg><circle/><g id="marks"/></svg>');
  });

  it("registrationLayout mirrors the legacy geometry", () => {
    const layout = registrationLayout(
      { size: 120, offset: 100, weight: 2, mode: "corners", customShapeAssetId: null },
      1000,
      800,
    );
    expect(layout.points).toEqual([
      [100, 100],
      [900, 100],
      [100, 700],
      [900, 700],
    ]);
    const centered = registrationLayout(
      { size: null, offset: null, weight: 0.1, mode: "centered", customShapeAssetId: null },
      1000,
      800,
    );
    expect(centered.points).toHaveLength(2);
    expect(centered.weight).toBe(0.5);
    expect(centered.size).toBe(Math.max(7, Math.round(800 * 0.014)));
  });
});

/* ------------------------------------------------------------------ */
/* Dev delay seam + delivery policy                                    */
/* ------------------------------------------------------------------ */

describe("withRenderStepDelay", () => {
  it("consults the delay before every render step and stays pass-through at 0", async () => {
    const inner = fakeService();
    const delay = vi.fn(() => 0);
    const wrapped = withRenderStepDelay(inner.service, delay);
    const options = {
      revision: 1,
      registration: false,
      matte: null,
      signal: new AbortController().signal,
    };
    await wrapped.renderComposite(coreWithLayer(), options);
    await wrapped.renderPlate(coreWithLayer(), "cyan", options);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(inner.calls).toEqual(["composite", "plate"]);
  });

  it("an abort during the delay releases the wait immediately", async () => {
    const inner = fakeService();
    const wrapped = withRenderStepDelay(inner.service, () => 60_000);
    const controller = new AbortController();
    const pending = wrapped.renderComposite(coreWithLayer(), {
      revision: 1,
      registration: false,
      matte: null,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBeDefined();
  });
});

describe("deliverStudioExport", () => {
  it("uses blob downloads when the payload fits under the cap", async () => {
    const saveBlob = vi.fn();
    const mode = await deliverStudioExport(
      [{ name: "a.png", blob: new Blob(["x"]) }],
      { saveBlob, maxBlobBytes: 100 },
    );
    expect(mode).toBe("blob-download");
    expect(saveBlob).toHaveBeenCalledTimes(1);
  });

  it("fails loudly for oversized payloads without File System Access", async () => {
    await expect(
      deliverStudioExport([{ name: "big.tiff", blob: new Blob(["xxxxxxxx"]) }], {
        saveBlob: vi.fn(),
        maxBlobBytes: 2,
      }),
    ).rejects.toMatchObject({ code: "export-too-large" });
  });

  it("NEVER opens a post-render picker: oversized buffered payloads fail loudly even with FSA (wave G2)", async () => {
    // A picker opened after the render has no user activation left, so
    // routing must have decided buffered-vs-streamed BEFORE render on the
    // conservative estimate; a buffered payload past the cap is a routing
    // bug and fails typed rather than popping an activation-less dialog.
    const picker = vi.fn();
    await expect(
      deliverStudioExport(
        [{ name: "big.tiff", blob: new Blob(["xxxxxxxx"], { type: "image/tiff" }) }],
        { saveBlob: vi.fn(), maxBlobBytes: 2, showSaveFilePicker: picker },
      ),
    ).rejects.toMatchObject({ code: "export-too-large" });
    expect(picker).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* startStudioExport: resolveCustomShape forwarding                    */
/* ------------------------------------------------------------------ */

describe("startStudioExport custom-shape forwarding", () => {
  it("forwards resolveCustomShape to the orchestrator (plate-package manifest)", async () => {
    // A registration custom shape makes the plate-package job build call the
    // resolver while assembling job-settings.json — proving the option
    // travels from StartStudioExportOptions into startExport.
    let core = coreWithLayer();
    core = applyCommand(core, {
      type: "registration/update",
      patch: { customShapeAssetId: ASSET_SHAPE },
    });
    const { service } = fakeService();
    const resolveCustomShape = vi.fn(async () => ({
      filename: "mark.svg",
      svg: "<svg viewBox=\"0 0 8 8\"><circle cx=\"4\" cy=\"4\" r=\"3\"/></svg>",
    }));
    const run = startStudioExport({
      core,
      revision: 3,
      sourceName: "Marked",
      target: { kind: "plate-package", format: "png", registration: true },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
      resolveCustomShape,
    });
    await run.done;
    expect(resolveCustomShape).toHaveBeenCalledWith(ASSET_SHAPE);
  });
});

/* ------------------------------------------------------------------ */
/* Telemetry: export failure boundary                                  */
/* ------------------------------------------------------------------ */

describe("telemetry — export failures", () => {
  afterEach(() => resetTelemetryForTests());

  function fakeTransport() {
    const captured: SentryEventLike[] = [];
    const sentry: SentryModuleLike = {
      init: () => undefined,
      captureEvent: (event) => void captured.push(event),
    };
    return { sentry, captured };
  }

  const telemetryEnv = {
    dsn: "https://public@example.ingest.invalid/1",
    release: "dr-glitch@0.1.0",
    environment: "production",
    privateValidation: false,
  };

  it("a failing export reports exactly one scrubbed event with the typed code", async () => {
    const { sentry, captured } = fakeTransport();
    await initTelemetry({ env: telemetryEnv, loadSentry: async () => sentry });
    const { service } = fakeService({
      renderComposite: vi.fn(async () => {
        throw new ExportError("worker-crashed", "The export worker crashed at /Users/x/secret.png");
      }),
    });
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "Secret Client Artwork",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    await expect(run.done).rejects.toBeInstanceOf(ExportError);
    expect(captured).toHaveLength(1);
    expect(captured[0].tags).toMatchObject({
      error_code: "worker-crashed",
      layer_count_bucket: "1",
    });
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain("Secret");
    expect(serialized).not.toContain("secret.png");
    expect(serialized).not.toContain("/Users");
  });

  it("uses the typed ExportError code when it is shaped like a stable code", async () => {
    const { sentry, captured } = fakeTransport();
    await initTelemetry({ env: telemetryEnv, loadSentry: async () => sentry });
    const { service } = fakeService({
      renderComposite: vi.fn(async () => {
        throw new ExportError("export-too-large", "too big");
      }),
    });
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "x",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    await expect(run.done).rejects.toBeInstanceOf(ExportError);
    expect(captured).toHaveLength(1);
    expect(captured[0].tags!.error_code).toBe("export-too-large");
  });

  it("explicit cancellation reports nothing", async () => {
    const { sentry, captured } = fakeTransport();
    await initTelemetry({ env: telemetryEnv, loadSentry: async () => sentry });
    const { service } = fakeService({
      renderPlate: vi.fn(async (_c: unknown, _p: unknown, options: { signal: AbortSignal }) => {
        if (options.signal.aborted) throw new ExportCancelledError();
        throw new ExportCancelledError();
      }),
    });
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "x",
      target: { kind: "plate-package", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    run.cancel();
    await expect(run.done).rejects.toBeInstanceOf(ExportCancelledError);
    expect(captured).toHaveLength(0);
  });

  it("the same failure cannot double-report through the global handler (dedupe mark)", async () => {
    const { sentry, captured } = fakeTransport();
    await initTelemetry({ env: telemetryEnv, loadSentry: async () => sentry });
    const failure = new ExportError("export-failed", "boom");
    const { service } = fakeService({
      renderComposite: vi.fn(async () => {
        throw failure;
      }),
    });
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "x",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    await expect(run.done).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    // Simulate the SDK's global handler receiving the escaped rejection.
    const beforeSend = buildSentryInitOptions({
      dsn: telemetryEnv.dsn,
      release: telemetryEnv.release,
      environment: telemetryEnv.environment,
      privateValidation: false,
    }).beforeSend as (
      event: SentryEventLike,
      hint?: { originalException?: unknown },
    ) => SentryEventLike | null;
    expect(beforeSend({ exception: { values: [] } }, { originalException: failure })).toBeNull();
  });

  it("reports nothing without a DSN", async () => {
    const { service } = fakeService({
      renderComposite: vi.fn(async () => {
        throw new ExportError("export-failed", "boom");
      }),
    });
    const run = startStudioExport({
      core: coreWithLayer(),
      revision: 1,
      sourceName: "x",
      target: { kind: "composite", format: "png" },
      render: service,
      encoders: FAKE_ENCODERS,
      deliver: async () => undefined,
    });
    await expect(run.done).rejects.toBeInstanceOf(ExportError);
    // resetTelemetryForTests in afterEach keeps state pristine; nothing to
    // assert beyond "no crash": with no DSN there is no transport at all.
  });
});
