/**
 * The process-wide memory ledger: OBSERVED retained-allocation counters from
 * REAL streamed renders (instrumentation.ts MemoryLedger installed as the
 * global observer) compared against the planner MODEL for the same job —
 * not arithmetic-only assertions. Also proves disposal: after completion
 * the only retained tracked bytes are the delivered output raster; after
 * cancellation, nothing.
 *
 * The deterministic OffscreenCanvas stand-in mirrors the one in
 * render-streaming-equivalence.test.ts (alpha-coverage rasterization only).
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import { planRender } from "../../src/render/planner";
import { executeRenderJob } from "../../src/render/executor";
import type { RenderLayerInput } from "../../src/render/protocol";
import { createWorkerRenderService, planLayerModels } from "../../src/export/worker-render-service";
import type { RenderRequestOptions } from "../../src/export/orchestrator";
import type { LayerV1, ProjectCoreV1, Sha256 } from "../../src/core/types";

/* Minimal deterministic OffscreenCanvas stand-in (binary coverage). */
class FakeContext {
  fillStyle = "";
  private readonly alpha: Uint8Array;
  private shapes: Array<{ x: number; y: number; r: number }> = [];
  constructor(private readonly width: number, private readonly height: number) {
    this.alpha = new Uint8Array(width * height);
  }
  beginPath(): void {
    this.shapes = [];
  }
  arc(x: number, y: number, r: number): void {
    this.shapes.push({ x, y, r });
  }
  rect(): void {}
  roundRect(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  fill(): void {
    for (let py = 0; py < this.height; py += 1) {
      for (let px = 0; px < this.width; px += 1) {
        for (const { x, y, r } of this.shapes) {
          if (Math.hypot(px + 0.5 - x, py + 0.5 - y) <= r) {
            this.alpha[py * this.width + px] = 255;
            break;
          }
        }
      }
    }
  }
  getImageData(_x: number, _y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) data[index * 4 + 3] = this.alpha[index];
    return { data, width, height };
  }
}
class FakeOffscreenCanvas {
  private readonly context: FakeContext;
  constructor(public width: number, public height: number) {
    this.context = new FakeContext(width, height);
  }
  getContext(): FakeContext {
    return this.context;
  }
}

const globalScope = globalThis as { OffscreenCanvas?: unknown };
beforeAll(() => {
  globalScope.OffscreenCanvas = FakeOffscreenCanvas;
});
afterAll(() => {
  delete globalScope.OffscreenCanvas;
});
afterEach(() => {
  setAllocationObserver(null);
});

const WIDTH = 48;
const HEIGHT = 32;
const FIELD = WIDTH * HEIGHT * 4;
const ASSET: Sha256 = "e".repeat(64);

function makeLayer(id: string, mode: LayerV1["recipe"]["mode"]): LayerV1 {
  return {
    id,
    name: id,
    assetId: ASSET,
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: {
      position: { x: WIDTH / 2, y: HEIGHT / 2 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      flipH: false,
      flipV: false,
      skew: { x: 0, y: 0 },
      perspective: null,
    },
    recipe: {
      mode,
      halftone: {
        cellSize: 6,
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
        intensity: 0.8,
        levels: 3,
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

function makeCore(layers: LayerV1[]): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: WIDTH, heightPx: HEIGHT, presetId: "custom", background: "white" },
    layers,
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
    ...( {} as Partial<ProjectCoreV1> ),
  };
}

function freshSource() {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    data[index * 4] = (index * 13) % 200;
    data[index * 4 + 1] = (index * 7) % 200;
    data[index * 4 + 2] = (index * 3) % 200;
    data[index * 4 + 3] = 255;
  }
  return { data, width: WIDTH, height: HEIGHT };
}

function makeService(budget: number) {
  return createWorkerRenderService({
    sources: {
      resolveRaster: async () => freshSource(),
      assetDimensions: () => ({ width: WIDTH, height: HEIGHT }),
    },
    createPort: () => new MainThreadRenderer(false),
    renderBudgetBytes: budget,
  });
}

function options(overrides: Partial<RenderRequestOptions> = {}): RenderRequestOptions {
  return {
    revision: 3,
    registration: false,
    matte: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A budget that admits only the streamed (non-proof) form for this fixture. */
function streamedOnlyBudget(core: ProjectCoreV1): number {
  const layers = planLayerModels(core, core.layers, () => ({ width: WIDTH, height: HEIGHT }));
  const streamed = planRender(
    {
      sampleWidth: WIDTH,
      sampleHeight: HEIGHT,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      plateCount: 4,
      layerCount: core.layers.length,
      layers,
      output: { kind: "composite", whiteMatte: false },
    },
    Number.MAX_SAFE_INTEGER,
  ).streamedPeakBytes;
  return streamed + FIELD; // over the streamed floor, far under single-shot
}

describe("memory ledger: model vs observed", () => {
  it("streamed composite: observed peak within the model, disposal on completion", async () => {
    const core = makeCore([
      makeLayer("layer-a", "halftone"),
      makeLayer("layer-b", "diffusion"),
      makeLayer("layer-c", "clean"),
    ]);
    const budget = streamedOnlyBudget(core);
    const plan = planRender(
      {
        sampleWidth: WIDTH,
        sampleHeight: HEIGHT,
        outputWidth: WIDTH,
        outputHeight: HEIGHT,
        plateCount: 4,
        layerCount: 3,
        layers: planLayerModels(core, core.layers, () => ({ width: WIDTH, height: HEIGHT })),
        output: { kind: "composite", whiteMatte: false },
      },
      budget,
    );
    expect(plan.form).toBe("streamed");

    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    const service = makeService(budget);
    const raster = await service.renderComposite(core, options());
    setAllocationObserver(null);

    expect(raster.width).toBe(WIDTH);
    // MODEL vs OBSERVED: the plan is a true upper bound on observed
    // retention (its tile-canvas constant models the production tile edge,
    // so the bound is not tight at fixture scale — the browser benchmark
    // reports the tight comparison at the real sheet size).
    expect(ledger.peakBytes).toBeLessThanOrEqual(plan.streamedPeakBytes);
    // ...and the observed peak really contains the structural floor: the
    // two plate accumulators plus the app-side collector (3 proof fields +
    // coverage) were concurrently retained.
    expect(ledger.peakByKind.get("accumulator")).toBe(2 * FIELD);
    expect(ledger.peakByKind.get("proof")).toBe(3 * FIELD);
    expect(ledger.peakByKind.get("collector")).toBe(FIELD);
    expect(ledger.peakBytes).toBeGreaterThanOrEqual(6 * FIELD);
    // Disposal on completion: everything tracked was released except the
    // delivered output raster.
    expect(ledger.currentBytes).toBe(raster.data.byteLength);
    expect(ledger.currentByKind.get("accumulator")).toBe(0);
    expect(ledger.currentByKind.get("proof")).toBe(0);
    expect(ledger.currentByKind.get("collector")).toBe(0);
    expect(ledger.currentByKind.get("field")).toBe(0);
    expect(ledger.currentByKind.get("band")).toBe(0);
    expect(ledger.currentByKind.get("canvas")).toBe(0);
  });

  it("streamed plate render: disposal on completion", async () => {
    const core = makeCore([makeLayer("layer-a", "halftone"), makeLayer("layer-b", "diffusion")]);
    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    const service = makeService(streamedOnlyBudget(core));
    const raster = await service.renderPlate(core, "black", options());
    setAllocationObserver(null);
    expect(ledger.currentBytes).toBe(raster.data.byteLength);
  });

  it("cancellation mid-render releases every tracked buffer", async () => {
    const core = makeCore([
      makeLayer("layer-a", "halftone"),
      makeLayer("layer-b", "diffusion"),
      makeLayer("layer-c", "halftone"),
    ]);
    const controller = new AbortController();
    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    const service = makeService(streamedOnlyBudget(core));
    let progressEvents = 0;
    const pending = service.renderComposite(
      core,
      options({
        signal: controller.signal,
        onProgress: (fraction) => {
          progressEvents += 1;
          if (fraction > 0.05) controller.abort();
        },
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: "export-cancelled" });
    // Allow the port's cancelled event/dispose microtasks to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    setAllocationObserver(null);
    expect(ledger.peakBytes).toBeGreaterThan(0);
    expect(ledger.currentBytes).toBe(0);
    // Progress STOPS with the rejection: no further callbacks trickle in.
    const settledCount = progressEvents;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(progressEvents).toBe(settledCount);
  });

  it("single-shot cancellation releases completed layers waiting for plate composition", async () => {
    const settings: RenderLayerInput["settings"] = {
      cellSize: 6,
      frayedXEdge: 0,
      frayedYEdge: 0,
      invert: false,
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
      cleanEnabled: true,
    };
    const input = (): RenderLayerInput => ({
      raster: {
        buffer: freshSource().data.buffer as ArrayBuffer,
        width: WIDTH,
        height: HEIGHT,
      },
      settings,
      opacity: 1,
      dotShape: "round",
      strokeWidth: 1,
    });
    const ledger = new MemoryLedger();
    let cancelled = false;
    setAllocationObserver(ledger);
    const payload = await executeRenderJob(
      {
        type: "job",
        kind: "export",
        revision: 91,
        outputWidth: WIDTH,
        outputHeight: HEIGHT,
        renderScale: 1,
        minimumCellSize: 0.01,
        plates: ["black"],
        layers: [input(), input()],
        wantBitmap: false,
      },
      {
        isCancelled: () => cancelled,
        onProgress: (phase) => {
          if (phase === "coverage") cancelled = true;
        },
        yieldPoint: () => undefined,
      },
    );
    setAllocationObserver(null);

    expect(payload).toBeNull();
    expect(ledger.currentBytes).toBe(0);
    expect(ledger.liveAllocations).toBe(0);
  });

  it("hard-blocks over-budget jobs BEFORE any tracked allocation", async () => {
    const core = makeCore([makeLayer("layer-a", "halftone")]);
    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    const service = makeService(1024); // absurd budget
    await expect(service.renderComposite(core, options())).rejects.toMatchObject({
      code: "render-peak-exceeded",
    });
    setAllocationObserver(null);
    expect(ledger.peakBytes).toBe(0);
    expect(ledger.liveAllocations).toBe(0);
  });
});

describe("deterministic allocation-timing regressions (memory audit)", () => {
  type OrderedEvent = { op: "alloc" | "release"; label?: string };

  async function observeStreamedWhiteMatte(): Promise<OrderedEvent[]> {
    const core = makeCore([
      makeLayer("layer-a", "halftone"),
      makeLayer("layer-b", "diffusion"),
    ]);
    // Give layer-a a crop so the prep path derives a crop window.
    core.layers[0].crop = { x: 2, y: 2, width: WIDTH - 8, height: HEIGHT - 6 };
    const events: OrderedEvent[] = [];
    setAllocationObserver({
      alloc: (_bytes, _kind, label) => void events.push({ op: "alloc", label }),
      release: (_bytes, _kind, label) => void events.push({ op: "release", label }),
    });
    // Budget between streamed-with-proof and single-shot forces the
    // proof-carrying streamed session.
    const layers = planLayerModels(core, core.layers, () => ({ width: WIDTH, height: HEIGHT }));
    const plan = planRender(
      {
        sampleWidth: WIDTH,
        sampleHeight: HEIGHT,
        outputWidth: WIDTH,
        outputHeight: HEIGHT,
        plateCount: 4,
        layerCount: 2,
        wantsProof: true,
        layers,
        output: { kind: "composite", whiteMatte: true },
      },
      Number.MAX_SAFE_INTEGER,
    );
    const service = makeService(plan.streamedPeakBytes + FIELD);
    await service.renderComposite(core, options({ matte: "#ffffff" }));
    setAllocationObserver(null);
    return events;
  }

  it("proof staging allocates LAZILY: after every source decode, never during plate passes", async () => {
    const events = await observeStreamedWhiteMatte();
    const proofTargetAt = events.findIndex(
      (event) => event.op === "alloc" && event.label === "proof-target",
    );
    const lastDecodeAt = events.reduce(
      (last, event, index) =>
        event.op === "alloc" && event.label === "decoded-source" ? index : last,
      -1,
    );
    expect(proofTargetAt).toBeGreaterThan(-1);
    expect(lastDecodeAt).toBeGreaterThan(-1);
    // Streamed proof bands arrive at finalize, after every (pass, layer)
    // decode — the staging buffer must not exist before then.
    expect(proofTargetAt).toBeGreaterThan(lastDecodeAt);
  });

  it("streaming session: a transferred prep source never survives into kernel work", async () => {
    const events = await observeStreamedWhiteMatte();
    let liveSources = 0;
    for (const event of events) {
      if (event.label === "prep-source") liveSources += event.op === "alloc" ? 1 : -1;
      if (event.op === "alloc" && event.label === "coverage-base") {
        // By the time any kernel field allocates, the transferred source
        // bytes of that layer are already released (consume-and-clear in
        // resolvePrepRaster + the session severing request references).
        expect(liveSources).toBe(0);
      }
    }
  });

  it("proof-only streamed composites emit no plate bands and stay byte-identical", async () => {
    // Byte identity of the suppressed path against the derived-collector
    // path (different pipelines, same bytes).
    const core = makeCore([makeLayer("layer-a", "halftone"), makeLayer("layer-b", "diffusion")]);
    const layers = planLayerModels(core, core.layers, () => ({ width: WIDTH, height: HEIGHT }));
    const withProof = planRender(
      {
        sampleWidth: WIDTH,
        sampleHeight: HEIGHT,
        outputWidth: WIDTH,
        outputHeight: HEIGHT,
        plateCount: 4,
        layerCount: 2,
        wantsProof: true,
        layers,
        output: { kind: "composite", whiteMatte: true },
      },
      Number.MAX_SAFE_INTEGER,
    );
    const inSession = await makeService(withProof.streamedPeakBytes + FIELD).renderComposite(
      core,
      options({ matte: "#ffffff" }),
    );
    const derived = await makeService(streamedOnlyBudget(core)).renderComposite(
      core,
      options({ matte: "#ffffff" }),
    );
    expect(Buffer.from(inSession.data).equals(Buffer.from(derived.data))).toBe(true);
  });
});
