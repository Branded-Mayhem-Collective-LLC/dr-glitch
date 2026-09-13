/**
 * Performance-gate harness (tests/e2e/perf-benchmark.spec.ts drives it).
 *
 * Eight DISTINCT synthetic 3600×5280 sources flow through the PRODUCTION
 * render path: real preview/export module workers, prep descriptors or
 * cached draft warps, planRender's tile schedule, and the production
 * WorkerRenderService for the full-sheet export. The page also hosts the
 * process ledger (app-side observed bytes) and the real-canvas tiled-vs-
 * whole rasterization identity check.
 */
import {
  createExportWorker,
  createPreviewWorker,
  StreamingWorkerRenderPort,
  WorkerRenderPort,
} from "../../src/app/worker-port";
import { AssetCache } from "../../src/app/asset-cache";
import {
  exportSuspensionActive,
  loadAssetInfos,
  planExportDelivery,
  preflightForTarget,
  registerExportSuspendable,
  startStudioExport,
} from "../../src/app/export-flow";
import { probeEnvironmentCapabilities } from "../../src/app/capabilities";
import { createStudioRenderService } from "../../src/app/studio-export";
import { PreviewService, type PreviewFrame } from "../../src/app/preview-service";
import {
  createWorkerRenderService,
  planLayerModels,
  renderSettingsFromLayer,
} from "../../src/export/worker-render-service";
import { BROWSER_EXPORT_ENCODERS } from "../../src/export/encoders";
import { buildLayerPrep } from "../../src/export/layer-prep";
import type { RasterData, RenderRequestOptions } from "../../src/export/orchestrator";
import { createBrowserRasterDecoder } from "../../src/io/raster-decoder";
import { IdbBackend, AssetRepository } from "../../src/storage";
import {
  buildCoverageField,
  collectGridDots,
  discardPayload,
  draftScaleFor,
  effectiveCellSize,
  chunkTiles,
  MemoryLedger,
  planRender,
  rasterizePlacements,
  rasterizePlacementsTiled,
  setAllocationObserver,
  visibleContentBounds,
  yieldToEventLoop,
  type AllocationKind,
  type GridGeometry,
  type RenderJobRequest,
  type RenderLayerInput,
  type RenderResultPayload,
  type RenderWorkerEvent,
} from "../../src/render";
import type {
  AssetRecordV1,
  DotShape,
  LayerV1,
  ProjectCoreV1,
  Sha256,
} from "../../src/core/types";

const WIDTH = 3600;
const HEIGHT = 5280;
const status = document.getElementById("status")!;
const say = (text: string) => {
  status.textContent = text;
};

/* ------------------------------------------------------------------ */
/* Eight distinct synthetic sources (generated per decode, never cached) */
/* ------------------------------------------------------------------ */

function assetId(index: number): Sha256 {
  return String(index).repeat(64).slice(0, 64) as Sha256;
}

/**
 * Async, event-loop-yielding source generation for the MAIN-THREAD decode
 * seam (PreviewService.resolveRaster): real production decode
 * (createImageBitmap / image pipeline) is asynchronous and does not block
 * the thread in one long task, so the synthetic stand-in must not either.
 */
async function generateSourceAsync(index: number, width = WIDTH, height = HEIGHT): Promise<RasterData> {
  const raster = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const rowsPerSlice = Math.max(1, Math.floor(1_500_000 / width));
  for (let rowStart = 0; rowStart < height; rowStart += rowsPerSlice) {
    if (rowStart > 0) await yieldToEventLoop();
    fillSourceRows(raster, index, rowStart, Math.min(height, rowStart + rowsPerSlice));
  }
  return raster;
}

function fillSourceRows(raster: RasterData, index: number, yStart: number, yEnd: number): void {
  const { data, width } = raster;
  const phase = (index + 1) * 0.37;
  const stripe = 24 + index * 7;
  for (let y = yStart; y < yEnd; y += 1) {
    const rowBase = y * width * 4;
    const wave = Math.sin(y * 0.011 + phase) * 90;
    for (let x = 0; x < width; x += 1) {
      const at = rowBase + x * 4;
      const diag = ((x + y * (index + 2)) % 510) - 255;
      data[at] = Math.abs(diag);
      data[at + 1] = (x * (index + 3) + wave) & 255;
      data[at + 2] = ((x % stripe) * 255 / stripe) & 255;
      data[at + 3] = (x + index * 300) % 2400 < 200 ? 0 : 255;
    }
  }
}

/** Deterministic, visually busy source; each index gets a distinct pattern. */
function generateSource(index: number, width = WIDTH, height = HEIGHT): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  const phase = (index + 1) * 0.37;
  const stripe = 24 + index * 7;
  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width * 4;
    const wave = Math.sin(y * 0.011 + phase) * 90;
    for (let x = 0; x < width; x += 1) {
      const at = rowBase + x * 4;
      const diag = ((x + y * (index + 2)) % 510) - 255;
      data[at] = Math.abs(diag);
      data[at + 1] = (x * (index + 3) + wave) & 255;
      data[at + 2] = ((x % stripe) * 255 / stripe) & 255;
      // A transparent band per source keeps alpha semantics honest.
      data[at + 3] = (x + index * 300) % 2400 < 200 ? 0 : 255;
    }
  }
  return { data, width, height };
}

/* ------------------------------------------------------------------ */
/* Project core: eight distinct layers                                  */
/* ------------------------------------------------------------------ */

const DOT_SHAPES: Exclude<DotShape, "custom">[] = [
  "round",
  "square",
  "diamond",
  "triangle",
  "cross",
  "circle-outline",
  "line",
  "round",
];

function makeLayer(index: number): LayerV1 {
  return {
    id: `layer-${index}`,
    name: `Layer ${index}`,
    assetId: assetId(index),
    visible: true,
    locked: false,
    opacity: index === 5 ? 0.7 : 1,
    crop: index === 6 ? { x: 200, y: 200, width: 3000, height: 4600 } : null,
    transform: {
      position: { x: WIDTH / 2 + (index - 4) * 60, y: HEIGHT / 2 + (index - 4) * 40 },
      scale: { x: 1 - index * 0.02, y: 1 - index * 0.02 },
      rotation: index * 3,
      flipH: index === 3,
      flipV: false,
      skew: { x: index === 4 ? 4 : 0, y: 0 },
      perspective: null,
    },
    recipe: {
      mode: "halftone",
      halftone: {
        cellSize: 10 + index,
        dotShape: DOT_SHAPES[index],
        customShapeAssetId: null,
        invert: false,
        strokeWidth: 2,
        frayedXEdge: index === 7 ? 6 : 0,
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

const core: ProjectCoreV1 = {
  schema: 1,
  artboard: { widthPx: WIDTH, heightPx: HEIGHT, presetId: "custom", background: "white" },
  layers: Array.from({ length: 8 }, (_, index) => makeLayer(index)),
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

/* ------------------------------------------------------------------ */
/* Long-task observation                                                */
/* ------------------------------------------------------------------ */

let longTasks: number[] = [];
let longTaskObserver: PerformanceObserver | null = null;

function startLongTaskWatch(): void {
  longTasks = [];
  longTaskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  longTaskObserver.observe({ type: "longtask", buffered: false });
}

function stopLongTaskWatch(): number[] {
  // Flush pending entries before disconnecting — the observer callback is
  // asynchronous and entries can still sit in the delivery queue.
  if (longTaskObserver) {
    for (const entry of longTaskObserver.takeRecords()) longTasks.push(entry.duration);
    longTaskObserver.disconnect();
  }
  longTaskObserver = null;
  return longTasks;
}

/* ------------------------------------------------------------------ */
/* Draft scrub loop                                                     */
/* ------------------------------------------------------------------ */

type ScrubResult = {
  samples: number[];
  p95: number;
  median: number;
  /** Cold-start samples (worker/JIT warm-up + first cache fill), reported
   *  separately: production pays these once per opened document, not per
   *  interaction (executor draft cache + engine warm-up persist across the
   *  session on the preview worker). */
  coldSamples: number[];
  coldMax: number;
  longTasks: number[];
  draftWidth: number;
  draftHeight: number;
  /** The exact settle after the scrub: fired through the REAL idle plan. */
  exactDelivered: boolean;
  settleMs: number;
};

/**
 * THE PRODUCTION PATH, end to end: the REAL PreviewService (state-mutated
 * core per interaction → requestPreview → prep-descriptor draft job → real
 * preview module worker → adaptive executor + draft field cache → delivered
 * frame), timed from the state mutation to the presented frame. Inside the
 * timed window per interaction: core clone + mutation, decode-cache lookup,
 * proxy copy + homography per layer, submit, worker render, frame delivery.
 * ONE-TIME work outside it (with its production counterpart): source decode
 * (PreviewService decode cache), draft proxy build (per-asset cache),
 * worker boot, and the three COLD samples — which are REPORTED, not hidden.
 * After the loop the armed idle plan fires and the EXACT viewport settle
 * must arrive (the adaptive-draft gate keeps it scheduled even at equal
 * public scales).
 */
async function runScrub(iterations: number): Promise<ScrubResult> {
  // Fit-view of the 5280px sheet in a ~1000px canvas.
  const viewportScale = 0.19;
  const scale = Math.min(viewportScale, draftScaleFor(WIDTH, HEIGHT));
  const draftWidth = Math.round(WIDTH * scale);
  const draftHeight = Math.round(HEIGHT * scale);
  say(`scrub: production PreviewService at draft ${draftWidth}×${draftHeight}…`);

  const timers: Array<() => void> = [];
  const service = new PreviewService({
    createPort: () => new WorkerRenderPort(createPreviewWorker),
    sources: {
      resolveRaster: (id: Sha256) => generateSourceAsync(Number.parseInt(id[0]!, 10)),
    },
    wantBitmap: true,
    timer: {
      // Continuous-scrub semantics: the idle window never elapses between
      // interactions (each new input clears the plan); the LAST armed plan
      // fires after the loop to exercise the real exact settle.
      set: (callback) => {
        timers.push(callback);
        return timers.length - 1;
      },
      clear: () => undefined,
    },
  });
  const frames: PreviewFrame[] = [];
  service.onFrame((frame) => frames.push(frame));
  const serviceErrors: string[] = [];
  service.onError((error) => serviceErrors.push(`${error.code}: ${error.message}`));

  const waitForFrame = (predicate: (frame: PreviewFrame) => boolean, label: string) =>
    new Promise<PreviewFrame>((resolve, reject) => {
      const deadline = performance.now() + 120_000;
      const poll = () => {
        const found = frames.find(predicate);
        if (found) return resolve(found);
        if (serviceErrors.length > 0) return reject(new Error(serviceErrors.join(" | ")));
        if (performance.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
        setTimeout(poll, 2);
      };
      poll();
    });

  const samples: number[] = [];
  const coldSamples: number[] = [];
  const WARMUP = 3;
  let exactDelivered = false;
  let settleMs = 0;
  try {
    startLongTaskWatch();
    for (let iteration = 0; iteration < iterations + WARMUP; iteration += 1) {
      const started = performance.now();
      // PRODUCTION STATE MUTATION per interaction: a fresh core whose
      // edited layer rotated — exactly what a transform scrub produces.
      const mutated: ProjectCoreV1 = structuredClone(core);
      mutated.layers[0].transform.rotation = iteration * 0.7;
      const revision = service.requestPreview({ core: mutated, view: "composite", viewportScale });
      const frame = await waitForFrame(
        (candidate) => candidate.revision === revision && candidate.kind === "preview-draft",
        `draft ${revision}`,
      );
      discardPayload(frame.payload);
      (iteration >= WARMUP ? samples : coldSamples).push(performance.now() - started);
      say(`scrub ${iteration + 1}/${iterations + WARMUP}: ${(performance.now() - started).toFixed(0)}ms`);
    }
    // Scrub released: fire the armed idle plan; the exact settle must land.
    const settleStart = performance.now();
    for (const fire of timers.splice(0)) fire();
    const exact = await waitForFrame((candidate) => candidate.kind === "exact-viewport", "exact settle");
    settleMs = performance.now() - settleStart;
    exactDelivered = exact.kind === "exact-viewport";
    discardPayload(exact.payload);
  } finally {
    service.dispose();
  }
  if (serviceErrors.length > 0) throw new Error(serviceErrors.join(" | "));
  const observed = stopLongTaskWatch();
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    median: sorted[Math.floor(sorted.length / 2)],
    coldSamples,
    coldMax: Math.max(...coldSamples),
    longTasks: observed,
    draftWidth,
    draftHeight,
    exactDelivered,
    settleMs,
  };
}

/* ------------------------------------------------------------------ */
/* Exact-settle parity at probe scale                                   */
/* ------------------------------------------------------------------ */

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

async function runJobOn(
  port: WorkerRenderPort,
  job: RenderJobRequest,
): Promise<RenderResultPayload> {
  return new Promise((resolve, reject) => {
    const unsubscribe = port.onEvent((event: RenderWorkerEvent) => {
      if (event.type === "result" && event.revision === job.revision) {
        unsubscribe();
        resolve(event.payload);
      } else if (event.type === "error") {
        unsubscribe();
        reject(new Error(`${event.code}: ${event.message}`));
      }
    });
    port.submit(job);
  });
}

/**
 * Exact settle vs single-shot export parity, hash-compared at probe scale
 * 0.25 (900×1320). Justification: the FULL sheet has no runnable
 * single-shot form at all (planner: ~3.3 GiB — that is why the streamed
 * form exists), and streamed-vs-single-shot full-resolution bit-identity
 * is proven per band height in tests/unit/render-streaming-equivalence.
 * The probe proves the same identity through REAL workers and REAL canvas
 * rasterization end to end.
 */
async function runSettleParity(): Promise<{ exact: string; single: string; equal: boolean }> {
  const scale = 0.25;
  const probeWidth = Math.round(WIDTH * scale);
  const probeHeight = Math.round(HEIGHT * scale);
  const buildJob = (kind: "exact-viewport" | "export", revision: number): RenderJobRequest => ({
    type: "job",
    kind,
    revision,
    outputWidth: probeWidth,
    outputHeight: probeHeight,
    renderScale: scale,
    minimumCellSize: 0.01,
    plates: ["cyan", "magenta", "yellow", "black"],
    layers: core.layers.map((layer, index) => {
      const source = generateSource(index);
      const prep = buildLayerPrep(layer, source, {
        outputWidth: probeWidth,
        outputHeight: probeHeight,
        renderScale: scale,
      });
      return {
        prep,
        settings: renderSettingsFromLayer(core, layer),
        opacity: layer.opacity,
        dotShape: layer.recipe.halftone.dotShape,
        strokeWidth: layer.recipe.halftone.strokeWidth,
      };
    }),
    tiles: chunkTiles(probeWidth, probeHeight, 512),
    paper: [255, 255, 255],
    wantBitmap: false,
  });

  say("settle parity: exact viewport via preview worker…");
  const previewPort = new WorkerRenderPort(createPreviewWorker);
  const exactPayload = await runJobOn(previewPort, buildJob("exact-viewport", 1));
  previewPort.dispose();
  if (exactPayload.form !== "plates" || !exactPayload.proof) throw new Error("exact settle: expected plates+proof");
  const exact = fnv1a(new Uint8Array(exactPayload.proof.buffer));

  say("settle parity: single-shot via export worker…");
  const exportPort = new WorkerRenderPort(createExportWorker);
  const singlePayload = await runJobOn(exportPort, buildJob("export", 2));
  exportPort.dispose();
  if (singlePayload.form !== "plates" || !singlePayload.proof) throw new Error("single shot: expected plates+proof");
  const single = fnv1a(new Uint8Array(singlePayload.proof.buffer));

  return { exact, single, equal: exact === single };
}

/* ------------------------------------------------------------------ */
/* Real-canvas tiled-vs-whole rasterization identity                    */
/* ------------------------------------------------------------------ */

type TiledShapeReport = {
  shape: string;
  cell: number;
  angle: number;
  dots: number;
  deterministic: boolean;
  maxDelta: number;
  mismatchFraction: number;
};

/**
 * Canonical-schedule tiling contract, real canvas, EVERY built-in dot
 * shape at mixed cells/angles plus an adversarial odd tile edge: two runs
 * of the canonical schedule must be byte-identical (the production
 * contract), and the deviation against a single artboard-sized canvas —
 * a non-production reference whose AA tessellation shifts under
 * translation — is measured and bounded per shape.
 */
async function runTiledIdentity(): Promise<{ shapes: TiledShapeReport[] }> {
  const width = 1440;
  const height = 1080;
  const raster = generateSource(2, width, height);
  const settings = renderSettingsFromLayer(core, core.layers[1]);
  const cases: Array<{ shape: Exclude<DotShape, "custom">; cell: number; angle: number; edge: number }> = [
    { shape: "round", cell: 9, angle: 45, edge: 512 },
    { shape: "square", cell: 7, angle: 15, edge: 512 },
    { shape: "diamond", cell: 11, angle: 75, edge: 333 },
    { shape: "triangle", cell: 9, angle: 0, edge: 512 },
    { shape: "cross", cell: 12, angle: 45, edge: 333 },
    { shape: "circle-outline", cell: 9, angle: 45, edge: 512 },
    { shape: "line", cell: 10, angle: 15, edge: 333 },
  ];
  const shapes: TiledShapeReport[] = [];
  for (const testCase of cases) {
    const field = buildCoverageField(raster, "black", settings);
    const geometry: GridGeometry = {
      width,
      height,
      sourceWidth: width,
      sourceHeight: height,
      cell: effectiveCellSize(testCase.cell, 1, 0.01),
      angleDegrees: testCase.angle,
    };
    const placements = collectGridDots(field, geometry, visibleContentBounds(raster));
    const layer: RenderLayerInput = {
      raster: { buffer: raster.data.buffer as ArrayBuffer, width, height },
      settings,
      opacity: 1,
      dotShape: testCase.shape,
      strokeWidth: 2,
    };
    const schedule = chunkTiles(width, height, testCase.edge);
    const runA = await rasterizePlacementsTiled(placements, layer, width, height, 1, schedule, undefined);
    const runB = await rasterizePlacementsTiled(placements, layer, width, height, 1, schedule, undefined);
    let deterministic = true;
    for (let index = 0; index < runA.length; index += 1) {
      if (runA[index] !== runB[index]) {
        deterministic = false;
        break;
      }
    }
    const whole = rasterizePlacements(placements, layer, width, height, 1);
    let maxDelta = 0;
    let mismatches = 0;
    for (let index = 0; index < whole.length; index += 1) {
      const delta = Math.abs(whole[index] - runA[index]);
      if (delta > 0) {
        mismatches += 1;
        if (delta > maxDelta) maxDelta = delta;
      }
    }
    shapes.push({
      shape: testCase.shape,
      cell: testCase.cell,
      angle: testCase.angle,
      dots: placements.length,
      deterministic,
      maxDelta,
      mismatchFraction: mismatches / whole.length,
    });
    say(`tiled ${testCase.shape}: det=${String(deterministic)} maxΔ=${maxDelta.toFixed(4)}`);
    await yieldToEventLoop();
  }
  return { shapes };
}

/**
 * REAL-SERVICE streamed-vs-single-shot parity: the production
 * WorkerRenderService renders the same 8-layer composite twice over real
 * export workers — once in the single-shot form (default budget at probe
 * artboard size) and once with the budget forced just above the streamed
 * floor — and the delivered composite bytes must be identical. This is the
 * full service→session→worker integration, not an executor determinism
 * check (band-height-exhaustive bit-identity is proven in
 * tests/unit/render-streaming-equivalence.test.ts).
 */
async function runServiceStreamParity(): Promise<{
  singleHash: string;
  streamedHash: string;
  equal: boolean;
  forms: [string, string];
}> {
  const probeScale = 0.25;
  const probeWidth = Math.round(WIDTH * probeScale);
  const probeHeight = Math.round(HEIGHT * probeScale);
  const probeCore: ProjectCoreV1 = structuredClone(core);
  probeCore.artboard = { ...probeCore.artboard, widthPx: probeWidth, heightPx: probeHeight };
  for (let index = 0; index < probeCore.layers.length; index += 1) {
    const transform = probeCore.layers[index].transform;
    transform.position = { x: transform.position.x * probeScale, y: transform.position.y * probeScale };
    const crop = probeCore.layers[index].crop;
    if (crop) {
      probeCore.layers[index].crop = {
        x: Math.round(crop.x * probeScale),
        y: Math.round(crop.y * probeScale),
        width: Math.round(crop.width * probeScale),
        height: Math.round(crop.height * probeScale),
      };
    }
  }
  const sources = {
    resolveRaster: async (id: Sha256) => {
      const index = Number.parseInt(id[0]!, 10);
      return generateSource(index, probeWidth, probeHeight);
    },
    assetDimensions: () => ({ width: probeWidth, height: probeHeight }),
  };
  const layers = planLayerModels(probeCore, probeCore.layers, () => ({ width: probeWidth, height: probeHeight }));
  const singlePlan = planRender({
    sampleWidth: probeWidth,
    sampleHeight: probeHeight,
    outputWidth: probeWidth,
    outputHeight: probeHeight,
    plateCount: 4,
    layerCount: 8,
    wantsProof: true,
    layers,
    output: { kind: "composite", whiteMatte: true },
  });
  const options = (): RenderRequestOptions => ({
    revision: 5,
    registration: false,
    matte: "#ffffff",
    signal: new AbortController().signal,
  });
  const run = async (budget?: number) => {
    const service = createWorkerRenderService({
      sources,
      createPort: () => new StreamingWorkerRenderPort(createExportWorker),
      ...(budget !== undefined ? { renderBudgetBytes: budget } : {}),
    });
    return service.renderComposite(probeCore, options());
  };
  say("service parity: single-shot form…");
  const single = await run();
  say("service parity: streamed form…");
  const streamedBudget = Math.floor((singlePlan.streamedPeakBytes + singlePlan.singleShotPeakBytes) / 2);
  const streamed = await run(streamedBudget);
  const singleHash = fnv1a(new Uint8Array(single.data.buffer, single.data.byteOffset, single.data.byteLength));
  const streamedHash = fnv1a(new Uint8Array(streamed.data.buffer, streamed.data.byteOffset, streamed.data.byteLength));
  return {
    singleHash,
    streamedHash,
    equal: singleHash === streamedHash,
    forms: [singlePlan.form, "streamed"],
  };
}

/* ------------------------------------------------------------------ */
/* Full-sheet export through the production service                     */
/* ------------------------------------------------------------------ */

type MemorySample = {
  at: number;
  uaBytes: number | null;
  heapBytes: number | null;
  breakdown?: unknown;
};

type LedgerSnapshot = {
  peakBytes: number;
  currentBytes: number;
  liveAllocations: number;
  byKind: Record<string, number>;
};

function snapshotLedger(ledger: MemoryLedger): LedgerSnapshot {
  return { ...ledger.snapshot(), liveAllocations: ledger.liveAllocations };
}

type AllocationTrace = {
  bytes: number;
  kind: AllocationKind;
  label: string | null;
};

class TracingMemoryLedger extends MemoryLedger {
  private readonly outstanding: AllocationTrace[] = [];

  override alloc(bytes: number, kind: AllocationKind, label?: string): void {
    super.alloc(bytes, kind);
    this.outstanding.push({ bytes, kind, label: label ?? null });
  }

  override release(bytes: number, kind: AllocationKind, label?: string): void {
    super.release(bytes, kind);
    let index = -1;
    for (let at = this.outstanding.length - 1; at >= 0; at -= 1) {
      const entry = this.outstanding[at]!;
      if (entry.bytes === bytes && entry.kind === kind && entry.label === (label ?? null)) {
        index = at;
        break;
      }
    }
    if (index >= 0) this.outstanding.splice(index, 1);
  }

  outstandingAllocations(): AllocationTrace[] {
    return this.outstanding.map((entry) => ({ ...entry }));
  }
}

type ProductionExportRunResult = {
  ok: boolean;
  ms: number;
  width: number;
  height: number;
  runtime: {
    crossOriginIsolated: boolean;
    moduleWorkers: boolean;
    offscreenCanvas: boolean;
    compressionStream: boolean;
    opfsHandleTag: string;
  };
  delivery: {
    mode: "buffered" | "stream";
    estimatedBytes: number;
    bufferedDeliverCalls: number;
    resultBlobWasNull: boolean;
    writes: number;
    acceptedBytes: number;
    maxRetainedWriteBytes: number;
    maxConcurrentWrites: number;
    closes: number;
    aborts: number;
  };
  artifact: {
    name: string;
    size: number;
    firstEntryName: string;
    zipLocalHeader: number[];
    pngSignature: number[];
    hasEocd: boolean;
  };
  storage: {
    records: number;
    encodedBytes: number[];
    decodeSnapshotsBeforeExport: number;
    decodeSnapshotsDuringExport: number;
  };
  suspension: {
    suspends: number;
    resumes: number;
    epochDelta: number;
    imageCacheBefore: number;
    rasterCacheBefore: number;
    imageCacheAtSuspend: number;
    rasterCacheAtSuspend: number;
    notifications: number;
    readsTriggeredByNotification: number;
    activeAtFirstProgress: boolean;
    imageCacheAtFirstProgress: number;
    rasterCacheAtFirstProgress: number;
  };
  preflightBlockCodes: string[];
  plan: {
    form: string;
    estimatedPeakBytes: number;
    streamedPeakBytes: number;
    workerPeakBytes: number;
    appPeakBytes: number;
    withinBudget: boolean;
    budgetBytes: number;
  };
  /** PAGE-REALM diagnostic accounting only — the worker realm is not
   *  instrumented here; the memory gate uses `memory` (UASM) exclusively. */
  ledger: LedgerSnapshot;
  memory: {
    api: "measureUserAgentSpecificMemory" | "usedJSHeapSize" | "none";
    baselineBytes: number | null;
    peakBytes: number | null;
    samples: number;
  };
  progressEvents: number;
};

async function sampleMemory(): Promise<MemorySample> {
  let uaBytes: number | null = null;
  const scope = performance as unknown as {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  let breakdown: unknown;
  if (crossOriginIsolated && scope.measureUserAgentSpecificMemory) {
    try {
      const measured = (await scope.measureUserAgentSpecificMemory()) as {
        bytes: number;
        breakdown?: unknown;
      };
      uaBytes = measured.bytes;
      breakdown = measured.breakdown;
    } catch {
      uaBytes = null;
    }
  }
  return {
    at: performance.now(),
    uaBytes,
    heapBytes: scope.memory ? scope.memory.usedJSHeapSize : null,
    breakdown,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLedgerDrain(
  ledger: MemoryLedger,
  timeoutMs = 5_000,
): Promise<{ drained: boolean; waitMs: number }> {
  const started = performance.now();
  while (
    (ledger.currentBytes !== 0 || ledger.liveAllocations !== 0) &&
    performance.now() - started < timeoutMs
  ) {
    await delay(10);
  }
  return {
    drained: ledger.currentBytes === 0 && ledger.liveAllocations === 0,
    waitMs: performance.now() - started,
  };
}

/**
 * Build a real, browser-encoded PNG without allocating an artboard-sized JS
 * pixel array. The patterns are deliberately structured (small stored files,
 * useful tone variation) and distinct per layer. The canvas backing is shrunk
 * immediately after encode so fixture construction cannot leak into the gate.
 */
async function createCompressedSource(index: number, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the production-fixture canvas");
  const hue = (index * 43) % 360;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 85% 18%)`);
  gradient.addColorStop(0.48, `hsl(${(hue + 95) % 360} 72% 67%)`);
  gradient.addColorStop(1, `hsl(${(hue + 210) % 360} 80% 28%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  const stripes = 96;
  for (let stripe = 0; stripe < stripes; stripe += 1) {
    const x = (stripe * width) / stripes;
    context.fillStyle = `hsla(${(hue + stripe * 7) % 360} 90% 55% / ${0.08 + (stripe % 5) * 0.025})`;
    context.fillRect(x, 0, Math.max(2, width / 260), height);
  }
  context.globalCompositeOperation = "screen";
  for (let mark = 0; mark < 36; mark += 1) {
    const x = ((mark * 977 + index * 431) % 4096) / 4096 * width;
    const y = ((mark * 1597 + index * 733) % 4096) / 4096 * height;
    const radius = Math.max(18, Math.min(width, height) * (0.018 + (mark % 7) * 0.004));
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = `hsla(${(hue + mark * 13) % 360} 100% 72% / 0.32)`;
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
  context.fillStyle = `rgba(${index + 1}, ${index * 17}, ${255 - index}, 1)`;
  context.fillRect(index * 3, index * 3, 11, 11); // hash-distinct sentinel
  try {
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function coreForRecords(
  records: readonly AssetRecordV1[],
  width: number,
  height: number,
): ProjectCoreV1 {
  const result = structuredClone(core);
  result.artboard = {
    ...result.artboard,
    widthPx: width,
    heightPx: height,
    presetId: "production-proof",
  };
  result.layers = records.map((record, index) => {
    const layer = structuredClone(core.layers[index % core.layers.length]!);
    layer.id = `production-layer-${index}`;
    layer.assetId = record.sha256;
    layer.name = `production-source-${index}.png`;
    layer.transform.position = {
      x: width / 2 + (index - records.length / 2) * Math.min(60, width / 40),
      y: height / 2 + (index - records.length / 2) * Math.min(40, height / 50),
    };
    if (width !== WIDTH || height !== HEIGHT) {
      layer.crop = null;
      layer.transform.rotation = 0;
      layer.transform.scale = { x: 1, y: 1 };
      layer.transform.skew = { x: 0, y: 0 };
    }
    return layer;
  });
  result.output.registrationOnPlates = false;
  return result;
}

async function persistSources(
  repository: AssetRepository,
  count: number,
  width: number,
  height: number,
): Promise<AssetRecordV1[]> {
  const records: AssetRecordV1[] = [];
  for (let index = 0; index < count; index += 1) {
    say(`production fixture: storing source ${index + 1}/${count}…`);
    const blob = await createCompressedSource(index, width, height);
    records.push(await repository.putBlob(blob, "raster", "image/png", { width, height }));
    await yieldToEventLoop();
  }
  return records;
}

function observeDecodeSnapshots(repository: AssetRepository): { calls: () => number } {
  let calls = 0;
  const original = repository.openArtworkDecodeSnapshot.bind(repository);
  repository.openArtworkDecodeSnapshot = ((...args: Parameters<typeof original>) => {
    calls += 1;
    return original(...args);
  }) as typeof repository.openArtworkDecodeSnapshot;
  return { calls: () => calls };
}

type OpfsCapture = {
  writes: number;
  acceptedBytes: number;
  maxRetainedWriteBytes: number;
  concurrentWrites: number;
  maxConcurrentWrites: number;
  closes: number;
  aborts: number;
};

async function createDelayedOpfsDestination(name: string, writeDelayMs: number) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name).catch(() => undefined);
  const nativeHandle = await root.getFileHandle(name, { create: true });
  const capture: OpfsCapture = {
    writes: 0,
    acceptedBytes: 0,
    maxRetainedWriteBytes: 0,
    concurrentWrites: 0,
    maxConcurrentWrites: 0,
    closes: 0,
    aborts: 0,
  };
  const pickerHandle = {
    async createWritable() {
      const writable = await nativeHandle.createWritable();
      return {
        async write(data: Uint8Array | Blob) {
          const bytes = data instanceof Blob ? data.size : data.byteLength;
          const retained =
            data instanceof Blob ? data.size : Math.max(data.byteLength, data.buffer.byteLength);
          capture.concurrentWrites += 1;
          capture.maxConcurrentWrites = Math.max(
            capture.maxConcurrentWrites,
            capture.concurrentWrites,
          );
          try {
            if (writeDelayMs > 0) await delay(writeDelayMs);
            await writable.write(
              data instanceof Blob ? data : (data as Uint8Array<ArrayBuffer>),
            );
            capture.writes += 1;
            capture.acceptedBytes += bytes;
            capture.maxRetainedWriteBytes = Math.max(capture.maxRetainedWriteBytes, retained);
          } finally {
            capture.concurrentWrites -= 1;
          }
        },
        async close() {
          capture.closes += 1;
          await writable.close();
        },
        async abort(reason?: unknown) {
          capture.aborts += 1;
          await writable.abort(reason);
        },
      };
    },
  };
  return {
    root,
    nativeHandle,
    pickerHandle,
    capture,
    cleanup: () => root.removeEntry(name).catch(() => undefined),
  };
}

async function inspectZipHeadAndTail(handle: FileSystemFileHandle) {
  const file = await handle.getFile();
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
  const nameLength = (head[26] ?? 0) | ((head[27] ?? 0) << 8);
  const extraLength = (head[28] ?? 0) | ((head[29] ?? 0) << 8);
  const dataOffset = 30 + nameLength + extraLength;
  const firstEntryName = new TextDecoder().decode(head.subarray(30, 30 + nameLength));
  const tailLength = Math.min(file.size, 65_557);
  const tail = new Uint8Array(await file.slice(file.size - tailLength).arrayBuffer());
  let hasEocd = false;
  for (let index = tail.length - 4; index >= 0; index -= 1) {
    if (
      tail[index] === 0x50 &&
      tail[index + 1] === 0x4b &&
      tail[index + 2] === 0x05 &&
      tail[index + 3] === 0x06
    ) {
      hasEocd = true;
      break;
    }
  }
  return {
    size: file.size,
    firstEntryName,
    zipLocalHeader: [...head.slice(0, 4)],
    pngSignature: [...head.slice(dataOffset, dataOffset + 8)],
    hasEocd,
  };
}

async function warmOneAsset(cache: AssetCache, asset: Sha256): Promise<void> {
  await cache.getRasterData(asset);
}

async function runProductionExport(): Promise<ProductionExportRunResult> {
  const backend = await IdbBackend.open();
  const repository = new AssetRepository(backend, {
    rasterDecoder: createBrowserRasterDecoder(),
  });
  const decodeSnapshots = observeDecodeSnapshots(repository);
  const cache = new AssetCache(repository);
  const ledger = new MemoryLedger();
  let unregisterSuspension: (() => void) | null = null;
  let unsubscribeCache: (() => void) | null = null;
  let destination: Awaited<ReturnType<typeof createDelayedOpfsDestination>> | null = null;
  let sampling = false;
  let sampler: Promise<void> = Promise.resolve();
  try {
    const records = await persistSources(repository, 8, WIDTH, HEIGHT);
    const productionCore = coreForRecords(records, WIDTH, HEIGHT);
    const target = { kind: "plate-package", format: "png", registration: false } as const;
    const env = { ...probeEnvironmentCapabilities(), fileSystemAccess: true };
    const infos = await loadAssetInfos(productionCore, repository);
    const recordDimensions = (id: Sha256) => {
      const info = infos.get(id);
      return info && info.ok && info.kind === "raster"
        ? { width: info.width, height: info.height, byteLength: info.byteLength }
        : null;
    };
    const preflightBlockCodes = preflightForTarget(
      productionCore,
      (id) => infos.get(id) ?? null,
      target,
      99,
      env,
    )
      .filter((issue) => issue.severity === "block")
      .map((issue) => issue.code);
    const deliveryPlan = planExportDelivery(productionCore, target);
    const layers = planLayerModels(productionCore, productionCore.layers, recordDimensions);
    const plan = planRender({
      sampleWidth: WIDTH,
      sampleHeight: HEIGHT,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      plateCount: 4,
      layerCount: productionCore.layers.length,
      wantsProof: false,
      layers,
      output: { kind: "plate", streamedSink: true },
    });
    const service = createStudioRenderService(cache, env, recordDimensions);

    // Warm both decoded owners for one asset. The returned raster stays only
    // inside this short frame; the cache is its sole owner before suspension.
    await warmOneAsset(cache, records[0]!.sha256);
    const imageCacheBefore = cache.imageCacheSize;
    const rasterCacheBefore = cache.rasterCacheSize;
    const epochBefore = cache.rasterSuspendEpoch;
    let suspends = 0;
    let resumes = 0;
    let imageCacheAtSuspend = -1;
    let rasterCacheAtSuspend = -1;
    let notificationProbe = false;
    let notifications = 0;
    let readsTriggeredByNotification = 0;
    unsubscribeCache = cache.subscribe(() => {
      if (!notificationProbe) return;
      notifications += 1;
      const before = decodeSnapshots.calls();
      // This is what a render-scope consumer does on cache invalidation. The
      // getImage entry guard must return before repository/decode work starts.
      cache.getImage(records[0]!.sha256);
      readsTriggeredByNotification += decodeSnapshots.calls() - before;
    });
    unregisterSuspension = registerExportSuspendable({
      suspendForExport() {
        suspends += 1;
        notificationProbe = true;
        cache.suspendRasters();
        notificationProbe = false;
        imageCacheAtSuspend = cache.imageCacheSize;
        rasterCacheAtSuspend = cache.rasterCacheSize;
      },
      resumeAfterExport() {
        resumes += 1;
        cache.resumeRasters();
      },
    });

    const decodeSnapshotsBeforeExport = decodeSnapshots.calls();
    destination = await createDelayedOpfsDestination("drglitch-production-memory.zip", 1);
    let bufferedDeliverCalls = 0;
    let progressEvents = 0;
    let activeAtFirstProgress = false;
    let imageCacheAtFirstProgress = -1;
    let rasterCacheAtFirstProgress = -1;
    setAllocationObserver(ledger);
    const baseline = await sampleMemory();
    const samples: MemorySample[] = [];
    const run = startStudioExport({
      core: productionCore,
      revision: 99,
      sourceName: "production-proof.png",
      target,
      render: service,
      encoders: BROWSER_EXPORT_ENCODERS,
      deliver: async () => {
        bufferedDeliverCalls += 1;
      },
      saveFilePicker: async () => destination!.pickerHandle,
      onProgress(progress) {
        progressEvents += 1;
        if (imageCacheAtFirstProgress < 0) {
          activeAtFirstProgress = exportSuspensionActive();
          imageCacheAtFirstProgress = cache.imageCacheSize;
          rasterCacheAtFirstProgress = cache.rasterCacheSize;
        }
        say(`production export: ${(progress.fraction * 100).toFixed(1)}%`);
      },
    });
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        samples.push(await sampleMemory());
        await delay(400);
      }
    })();
    const started = performance.now();
    let files: Awaited<typeof run.done>;
    try {
      files = await run.done;
    } finally {
      sampling = false;
      await sampler;
    }
    const ms = performance.now() - started;
    await delay(300);
    samples.push(await sampleMemory());
    const artifact = await inspectZipHeadAndTail(destination.nativeHandle);
    const ledgerSnapshot = snapshotLedger(ledger);

    const allSamples = [baseline, ...samples];
    const uaSamples = allSamples
      .map((sample) => sample.uaBytes)
      .filter((bytes): bytes is number => bytes !== null);
    const heapSamples = allSamples
      .map((sample) => sample.heapBytes)
      .filter((bytes): bytes is number => bytes !== null);
    const api =
      uaSamples.length > 0
        ? "measureUserAgentSpecificMemory"
        : heapSamples.length > 0
          ? "usedJSHeapSize"
          : "none";
    const peakSample = allSamples.reduce<MemorySample | null>(
      (best, sample) =>
        sample.uaBytes !== null && (best?.uaBytes == null || sample.uaBytes > best.uaBytes)
          ? sample
          : best,
      null,
    );
    if (peakSample?.breakdown) {
      console.log("[production-peak-breakdown]", JSON.stringify(peakSample.breakdown));
    }
    const peakBytes =
      api === "measureUserAgentSpecificMemory"
        ? Math.max(...uaSamples)
        : api === "usedJSHeapSize"
          ? Math.max(...heapSamples)
          : null;
    const baselineBytes =
      api === "measureUserAgentSpecificMemory"
        ? baseline.uaBytes
        : api === "usedJSHeapSize"
          ? baseline.heapBytes
          : null;
    const decodeSnapshotsDuringExport = decodeSnapshots.calls() - decodeSnapshotsBeforeExport;

    return {
      ok:
        files.length === 1 &&
        files[0]!.blob === null &&
        artifact.size === destination.capture.acceptedBytes,
      ms,
      width: WIDTH,
      height: HEIGHT,
      runtime: {
        crossOriginIsolated,
        moduleWorkers: env.moduleWorkers,
        offscreenCanvas: env.offscreenCanvas,
        compressionStream: typeof CompressionStream === "function",
        opfsHandleTag: Object.prototype.toString.call(destination.nativeHandle),
      },
      delivery: {
        mode: deliveryPlan.mode,
        estimatedBytes: deliveryPlan.estimatedBytes,
        bufferedDeliverCalls,
        resultBlobWasNull: files[0]!.blob === null,
        writes: destination.capture.writes,
        acceptedBytes: destination.capture.acceptedBytes,
        maxRetainedWriteBytes: destination.capture.maxRetainedWriteBytes,
        maxConcurrentWrites: destination.capture.maxConcurrentWrites,
        closes: destination.capture.closes,
        aborts: destination.capture.aborts,
      },
      artifact: { name: files[0]!.name, ...artifact },
      storage: {
        records: records.length,
        encodedBytes: records.map((record) => record.byteLength),
        decodeSnapshotsBeforeExport,
        decodeSnapshotsDuringExport,
      },
      suspension: {
        suspends,
        resumes,
        epochDelta: cache.rasterSuspendEpoch - epochBefore,
        imageCacheBefore,
        rasterCacheBefore,
        imageCacheAtSuspend,
        rasterCacheAtSuspend,
        notifications,
        readsTriggeredByNotification,
        activeAtFirstProgress,
        imageCacheAtFirstProgress,
        rasterCacheAtFirstProgress,
      },
      preflightBlockCodes,
      plan: {
        form: plan.form,
        estimatedPeakBytes: plan.estimatedPeakBytes,
        streamedPeakBytes: plan.streamedPeakBytes,
        workerPeakBytes: plan.workerPeakBytes,
        appPeakBytes: plan.appPeakBytes,
        withinBudget: plan.withinBudget,
        budgetBytes: plan.budgetBytes,
      },
      ledger: ledgerSnapshot,
      memory: {
        api,
        baselineBytes,
        peakBytes,
        samples: allSamples.length,
      },
      progressEvents,
    };
  } finally {
    sampling = false;
    await sampler.catch(() => undefined);
    setAllocationObserver(null);
    unregisterSuspension?.();
    unsubscribeCache?.();
    cache.dispose();
    await destination?.cleanup();
    backend.close();
  }
}

type ProductionEdgeResult = {
  noFsa: {
    preflightBlockCodes: string[];
    exportCode: string;
    decodeSnapshots: number;
    suspends: number;
    resumes: number;
    deliverCalls: number;
  };
  blockedWrite: {
    exportCode: string;
    cancelMs: number;
    opfsHandleTag: string;
    aborts: number;
    closes: number;
    preservedText: string;
    ledgerWhileHostileWriteRetained: LedgerSnapshot;
    outstandingWhileHostileWriteRetained: AllocationTrace[];
    ledgerAfterHostileWriteSettled: LedgerSnapshot;
    outstandingAfterHostileWriteSettled: AllocationTrace[];
    ledgerDrained: boolean;
    ledgerDrainMs: number;
  };
  closeRace: {
    exportCode: string;
    cancelMs: number;
    aborts: number;
    closeCalls: number;
    preservedText: string;
    ledger: LedgerSnapshot;
    ledgerDrained: boolean;
    ledgerDrainMs: number;
  };
  decodeSnapshotsAfterEdges: number;
  suspendsAfterEdges: number;
  resumesAfterEdges: number;
};

function stableCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : error instanceof Error
      ? error.name
      : String(error);
}

async function seedOpfsFile(name: string, text: string) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name).catch(() => undefined);
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return { root, handle, cleanup: () => root.removeEntry(name).catch(() => undefined) };
}

async function runProductionEdges(): Promise<ProductionEdgeResult> {
  const backend = await IdbBackend.open();
  const repository = new AssetRepository(backend, {
    rasterDecoder: createBrowserRasterDecoder(),
  });
  const decodeSnapshots = observeDecodeSnapshots(repository);
  const cache = new AssetCache(repository);
  let suspends = 0;
  let resumes = 0;
  const unregister = registerExportSuspendable({
    suspendForExport() {
      suspends += 1;
      cache.suspendRasters();
    },
    resumeAfterExport() {
      resumes += 1;
      cache.resumeRasters();
    },
  });
  let blockedFile: Awaited<ReturnType<typeof seedOpfsFile>> | null = null;
  let closeFile: Awaited<ReturnType<typeof seedOpfsFile>> | null = null;
  try {
    const records = await persistSources(repository, 1, 512, 512);
    const smallCore = coreForRecords(records, 512, 512);
    const largeCore = coreForRecords(records, WIDTH, HEIGHT);
    const target = { kind: "plate-package", format: "png", registration: false } as const;
    const infos = await loadAssetInfos(largeCore, repository);
    const noFsaEnv = { ...probeEnvironmentCapabilities(), fileSystemAccess: false };
    const preflightBlockCodes = preflightForTarget(
      largeCore,
      (id) => infos.get(id) ?? null,
      target,
      201,
      noFsaEnv,
    )
      .filter((issue) => issue.severity === "block")
      .map((issue) => issue.code);
    const recordDimensions = (id: Sha256) => {
      const info = infos.get(id);
      return info && info.ok && info.kind === "raster"
        ? { width: info.width, height: info.height, byteLength: info.byteLength }
        : null;
    };
    const service = createStudioRenderService(cache, noFsaEnv, recordDimensions);
    let noFsaDeliverCalls = 0;
    const noFsaSuspendsBefore = suspends;
    const noFsaResumesBefore = resumes;
    const noFsaDecodesBefore = decodeSnapshots.calls();
    const noFsaRun = startStudioExport({
      core: largeCore,
      revision: 201,
      sourceName: "edge-proof.png",
      target,
      render: service,
      encoders: BROWSER_EXPORT_ENCODERS,
      deliver: async () => {
        noFsaDeliverCalls += 1;
      },
      saveFilePicker: null,
    });
    let noFsaCode = "resolved";
    try {
      await noFsaRun.done;
    } catch (error) {
      noFsaCode = stableCode(error);
    }
    const noFsa = {
      preflightBlockCodes,
      exportCode: noFsaCode,
      decodeSnapshots: decodeSnapshots.calls() - noFsaDecodesBefore,
      suspends: suspends - noFsaSuspendsBefore,
      resumes: resumes - noFsaResumesBefore,
      deliverCalls: noFsaDeliverCalls,
    };

    // A real OPFS transactional writable whose first write never settles
    // until this harness releases it. Cancellation must settle independently,
    // abort the native writable, and preserve the pre-existing file.
    blockedFile = await seedOpfsFile("drglitch-blocked-write.zip", "sentinel-write");
    let writeEnteredResolve!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      writeEnteredResolve = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let blockFirstWrite = true;
    let blockedAborts = 0;
    let blockedCloses = 0;
    const pendingWrites = new Set<Promise<void>>();
    const blockedPickerHandle = {
      async createWritable() {
        const writable = await blockedFile!.handle.createWritable();
        return {
          write(data: Uint8Array | Blob): Promise<void> {
            const pending = (async () => {
              if (blockFirstWrite) {
                blockFirstWrite = false;
                writeEnteredResolve();
                await writeGate;
              }
              await writable.write(
                data instanceof Blob ? data : (data as Uint8Array<ArrayBuffer>),
              );
            })();
            pendingWrites.add(pending);
            void pending.then(
              () => pendingWrites.delete(pending),
              () => pendingWrites.delete(pending),
            );
            return pending;
          },
          async close() {
            blockedCloses += 1;
            await writable.close();
          },
          async abort(reason?: unknown) {
            blockedAborts += 1;
            await writable.abort(reason);
          },
        };
      },
    };
    const blockedLedger = new TracingMemoryLedger();
    setAllocationObserver(blockedLedger);
    const blockedRun = startStudioExport({
      core: smallCore,
      revision: 202,
      sourceName: "edge-proof.png",
      target,
      render: service,
      encoders: BROWSER_EXPORT_ENCODERS,
      deliver: async () => undefined,
      maxBlobBytes: 1,
      saveFilePicker: async () => blockedPickerHandle,
    });
    await writeEntered;
    const blockedCancelStarted = performance.now();
    blockedRun.cancel();
    let blockedCode = "resolved";
    try {
      await blockedRun.done;
    } catch (error) {
      blockedCode = stableCode(error);
    }
    const blockedCancelMs = performance.now() - blockedCancelStarted;
    const ledgerWhileHostileWriteRetained = snapshotLedger(blockedLedger);
    const outstandingWhileHostileWriteRetained = blockedLedger.outstandingAllocations();
    const preservedWriteText = await (await blockedFile.handle.getFile()).text();
    const writesToDrain = [...pendingWrites];
    releaseWrite();
    await Promise.allSettled(writesToDrain);
    const blockedDrain = await waitForLedgerDrain(blockedLedger);
    const ledgerAfterHostileWriteSettled = snapshotLedger(blockedLedger);
    const outstandingAfterHostileWriteSettled = blockedLedger.outstandingAllocations();
    setAllocationObserver(null);

    // Close arbitration against a native OPFS commit. All bytes have reached
    // the transactional temp file, but close itself is held. Abort must win,
    // the late close must be contained, and the original target must survive.
    closeFile = await seedOpfsFile("drglitch-close-race.zip", "sentinel-close");
    let closeEnteredResolve!: () => void;
    const closeEntered = new Promise<void>((resolve) => {
      closeEnteredResolve = resolve;
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeAborts = 0;
    let closeCalls = 0;
    const closeSettlements: Promise<void>[] = [];
    const closePickerHandle = {
      async createWritable() {
        const writable = await closeFile!.handle.createWritable();
        return {
          write(data: Uint8Array | Blob) {
            return writable.write(
              data instanceof Blob ? data : (data as Uint8Array<ArrayBuffer>),
            );
          },
          close() {
            closeCalls += 1;
            closeEnteredResolve();
            const pendingClose = (async () => {
              await closeGate;
              await writable.close();
            })();
            closeSettlements.push(pendingClose);
            pendingClose.catch(() => undefined);
            return pendingClose;
          },
          async abort(reason?: unknown) {
            closeAborts += 1;
            await writable.abort(reason);
          },
        };
      },
    };
    const closeLedger = new MemoryLedger();
    setAllocationObserver(closeLedger);
    const closeRun = startStudioExport({
      core: smallCore,
      revision: 203,
      sourceName: "edge-proof.png",
      target,
      render: service,
      encoders: BROWSER_EXPORT_ENCODERS,
      deliver: async () => undefined,
      maxBlobBytes: 1,
      saveFilePicker: async () => closePickerHandle,
    });
    await closeEntered;
    const closeCancelStarted = performance.now();
    closeRun.cancel();
    let closeCode = "resolved";
    try {
      await closeRun.done;
    } catch (error) {
      closeCode = stableCode(error);
    }
    const closeCancelMs = performance.now() - closeCancelStarted;
    const preservedCloseText = await (await closeFile.handle.getFile()).text();
    releaseClose();
    await Promise.allSettled(closeSettlements);
    const closeDrain = await waitForLedgerDrain(closeLedger);
    const closeLedgerSnapshot = snapshotLedger(closeLedger);
    setAllocationObserver(null);

    return {
      noFsa,
      blockedWrite: {
        exportCode: blockedCode,
        cancelMs: blockedCancelMs,
        opfsHandleTag: Object.prototype.toString.call(blockedFile.handle),
        aborts: blockedAborts,
        closes: blockedCloses,
        preservedText: preservedWriteText,
        ledgerWhileHostileWriteRetained,
        outstandingWhileHostileWriteRetained,
        ledgerAfterHostileWriteSettled,
        outstandingAfterHostileWriteSettled,
        ledgerDrained: blockedDrain.drained,
        ledgerDrainMs: blockedDrain.waitMs,
      },
      closeRace: {
        exportCode: closeCode,
        cancelMs: closeCancelMs,
        aborts: closeAborts,
        closeCalls,
        preservedText: preservedCloseText,
        ledger: closeLedgerSnapshot,
        ledgerDrained: closeDrain.drained,
        ledgerDrainMs: closeDrain.waitMs,
      },
      decodeSnapshotsAfterEdges: decodeSnapshots.calls(),
      suspendsAfterEdges: suspends,
      resumesAfterEdges: resumes,
    };
  } finally {
    setAllocationObserver(null);
    unregister();
    cache.dispose();
    await blockedFile?.cleanup();
    await closeFile?.cleanup();
    backend.close();
  }
}

/* ------------------------------------------------------------------ */
/* Page API                                                             */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    perfReady: boolean;
    perfApi: {
      crossOriginIsolated(): boolean;
      scrub(iterations: number): Promise<ScrubResult>;
      settleParity(): Promise<{ exact: string; single: string; equal: boolean }>;
      tiledIdentity(): Promise<{ shapes: TiledShapeReport[] }>;
      serviceStreamParity(): Promise<{
        singleHash: string;
        streamedHash: string;
        equal: boolean;
        forms: [string, string];
      }>;
      productionEdges(): Promise<ProductionEdgeResult>;
      runProductionExport(): Promise<ProductionExportRunResult>;
    };
  }
}

window.perfApi = {
  crossOriginIsolated: () => crossOriginIsolated,
  scrub: runScrub,
  settleParity: runSettleParity,
  tiledIdentity: runTiledIdentity,
  serviceStreamParity: runServiceStreamParity,
  productionEdges: runProductionEdges,
  runProductionExport,
};
window.perfReady = true;
say(`ready (crossOriginIsolated=${String(crossOriginIsolated)})`);
