/**
 * Production RenderService: binds the orchestrator's renderer boundary to
 * the DOM-free render subsystem (src/render) for REAL multi-layer projects.
 *
 * Flow per render request: model the job process-wide (planModelForRender →
 * planRender — the honest worker+app ledger, settings-aware kernel windows,
 * plan.tiles), HARD-BLOCK before any allocation when no form fits the
 * budget, then drive the chosen form:
 *
 * - "single-shot": one RenderJobRequest over a fresh port; the composed
 *   "plates" payload converts directly to the requested output.
 * - "streamed": a full streaming session (begin-export → ack-gated
 *   bottom-to-top submit-layer per plate pass → plate bands → finalize).
 *
 * OFF-MAIN-THREAD PREP: layers travel as prep descriptors (decoded source +
 * validated crop + Float64 homography, buildLayerPrep); the WORKER crops
 * and warps banded — the main thread never allocates an artboard-sized
 * layer raster and never runs the warp. Decoded sources are transferred
 * (caller-owned by the WorkerRenderSources contract) and NEVER cached
 * across passes: each (pass, layer) decode is consumed by its transfer, so
 * app-side source retention is exactly one in-flight decode.
 *
 * TILES: plan.tiles is passed on every job/session; halftone dots
 * rasterize per tile at absolute artboard coordinates in the worker.
 *
 * CRASH/FALLBACK SEMANTICS: a worker CONSTRUCTOR throw, a postMessage
 * throw, or a mid-job crash (`worker-crashed`) reissues the frozen work
 * EXACTLY ONCE over `createFallbackPort` (else a fresh `createPort`), with
 * fresh collectors so partially folded bands can never double-apply. A
 * second failure surfaces. Cancellation and render errors never retry.
 *
 * CAPABILITY GAPS (closed BEFORE execution): without OffscreenCanvas a
 * halftone-bearing raster export is refused with a stable code before any
 * decode or allocation; diffusion/clean-only stacks succeed through the
 * typed layer-data fallback (service-side composePlate — bit-identical
 * math). Vector plates never need OffscreenCanvas.
 *
 * Output conversions (documented semantics, tested):
 * - Plate raster: ink coverage in the ALPHA channel over constant plate ink
 *   RGB (#111214) — the convention output-transforms.ts polarity operates on.
 * - Composite: plate inks fold in press order into a proof accumulator over
 *   WHITE (proofCompositeCmyk math). With a white matte the opaque proof is
 *   the result (in-session proof bands are used verbatim when the planner
 *   affords the proof-carrying streamed form; larger sheets derive the same
 *   bytes from plate bands via foldPlateRowsIntoProof/quantizeProofRows).
 *   Otherwise alpha is the composed LAYER coverage (opaque zero-ink pixels
 *   are opaque paper — knockout), the over-white proof is un-matted into
 *   straight color for transparent targets (compositing it over white
 *   reproduces the white-matte bytes), and a non-white matte is applied
 *   exactly once here. See createCompositeCollector.
 * - Selected layer: the composite pipeline over exactly one layer,
 *   visibility ignored (preflight warns), always transparent.
 * - Registration: painted last into raster outputs (engine order), built-in
 *   circle + crosshair geometry (#121416, alpha 0.7); custom registration
 *   shapes need a main-thread stamp and are refused with a stable code.
 * - SVG plates: genuine vector output — the NUMERIC work (white-flatten,
 *   coverage/glitch/diffusion fields, grid walk) runs in the worker via the
 *   forced layer-data payload, one job per layer so at most one layer's
 *   fields are resident; the main thread only formats marks, time-sliced
 *   with real yields and abort checks. Mark geometry matches the legacy
 *   svgDot table; each layer emits one black group carrying its opacity.
 *   Clean layers never reach this path (preflight blocks).
 *
 * Cancellation: options.signal → port.cancel(revision); the session/job
 * aborts at its next checkpoint — which lands DURING warp bands, kernel
 * chunks, bitmap-sort lines, grid chunks, rasterization tiles, and
 * emission bands — every waiter rejects, and the request throws
 * "export-cancelled" — the orchestrator guarantees no partial output.
 * The frozen revision travels on every port message.
 */

import { RESOURCE_POLICY } from "../core/resource-policy";
import {
  DOCUMENT_DPI,
  type DotShape,
  type Id,
  type LayerV1,
  type PlateId,
  type ProjectCoreV1,
  type RegistrationV1,
  type Sha256,
} from "../core/types";
import {
  clamp,
  composePlate,
  estimateGridCandidates,
  estimateGridPoints as estimateGridPointsRender,
  MAX_GRID_CANDIDATES,
  MAX_RASTER_GRID_POINTS,
  createProofAccumulator,
  effectiveCellSize,
  estimateGridPoints,
  foldPlateRowsIntoProof,
  glitchActive,
  noteAlloc,
  noteRelease,
  retainAllocation,
  planRender,
  STREAM_DELIVERY_BAND_WINDOW,
  quantizeProofRows,
  releaseProofAccumulator,
  supportsOffscreenCanvas,
  yieldToEventLoop,
  type LayerPlateData,
  type PlanLayerModel,
  type PlanOutputModel,
  type PlateLayerOutput,
  type ProofAccumulator,
  type RenderExportPlateBandEvent,
  type RenderExportProofBandEvent,
  type RenderJobRequest,
  type RenderLayerInput,
  type RenderPlan,
  type RenderResultPayload,
  type RenderSettings,
  type RenderWorkerEvent,
  type StreamingRenderPort,
} from "../render";
import { sanitizeSvg } from "../io/svg-sanitizer";
import { MAX_DIFFUSION_SVG_RUNS, MAX_EXPORT_GRID_POINTS } from "../studio/halftone";
import { buildLayerPrep } from "./layer-prep";
import {
  PLATE_INK_RGB,
  paintRegistrationMarks,
  plateInkRowsToRgba,
  registrationPoints,
} from "./output-transforms";
import { contributingPlates } from "./targets";
import {
  ExportError,
  type RasterData,
  type RenderRequestOptions,
  type RenderService,
} from "./orchestrator";

/** Exports render at document scale with the legacy document-export cell floor. */
const EXPORT_RENDER_SCALE = 1;
const EXPORT_MINIMUM_CELL = 0.01;
const WHITE: readonly [number, number, number] = [255, 255, 255];

/* ------------------------------------------------------------------ */
/* Sources and construction                                            */
/* ------------------------------------------------------------------ */

export type WorkerRenderSources = {
  /**
   * Decoded straight-alpha RGBA pixels of a content-addressed asset. The
   * CALLER OWNS the returned raster: its buffer may be transferred to a
   * worker (detached), so implementations must return fresh bytes per call
   * — never a shared cache entry.
   */
  resolveRaster(assetId: Sha256, signal?: AbortSignal): Promise<RasterData>;
  /**
   * Pre-rasterized custom dot stamp (main-thread prepared) for
   * dotShape === "custom"; workers cannot prepare SVG stamps themselves.
   * Ownership transfers: the render port closes the bitmap after use.
   */
  resolveCustomStamp?(assetId: Sha256, sizePx: number): Promise<ImageBitmap>;
  /** Sanitized canonical SVG text for custom-dot symbols in vector plates. */
  resolveSvgText?(assetId: Sha256): Promise<string>;
  /** Record-backed dimensions/encoded bytes for source/decode peak planning. */
  assetDimensions?(
    assetId: Sha256,
  ): { width: number; height: number; byteLength?: number } | null;
};

export type WorkerRenderServiceOptions = {
  sources: WorkerRenderSources;
  /**
   * Port factory: an export-worker client in the browser, MainThreadRenderer
   * in tests and non-Chromium fallbacks. One port is created per render
   * attempt and disposed afterwards, so revisions never collide.
   */
  createPort: () => StreamingRenderPort;
  /**
   * Fallback port factory for the exactly-once crash recovery path
   * (typically MainThreadRenderer). Defaults to `createPort`.
   */
  createFallbackPort?: () => StreamingRenderPort;
  /** Render peak budget override (tests force the streamed/derive paths). */
  renderBudgetBytes?: number;
  /** Capability override for tests; defaults to feature detection. */
  offscreenCanvas?: boolean;
};

/* ------------------------------------------------------------------ */
/* Core → kernel settings mapping                                      */
/* ------------------------------------------------------------------ */

/**
 * Map a layer recipe plus document-global separation onto the DOM-free
 * kernel settings. Mode selection: clean → cleanEnabled, diffusion →
 * diffusionEnabled, halftone → neither. Recipe inverts are coverage-space
 * (legacy parity): diffusion mode uses diffusion.invert, clean and halftone
 * use halftone.invert. Glitch fields are present only when the layer's
 * glitch group is enabled; absent fields mean "no glitch" in the kernels.
 */
export function renderSettingsFromLayer(core: ProjectCoreV1, layer: LayerV1): RenderSettings {
  const { mode, halftone, diffusion, glitch } = layer.recipe;
  const settings: RenderSettings = {
    cellSize: halftone.cellSize,
    frayedXEdge: halftone.frayedXEdge,
    frayedYEdge: halftone.frayedYEdge,
    invert: mode === "diffusion" ? diffusion.invert : halftone.invert,
    grayscale: core.separation.mode === "grayscale",
    angles: core.separation.angles,
    visible: core.separation.visible,
  };
  if (mode === "clean") settings.cleanEnabled = true;
  if (mode === "diffusion") {
    settings.diffusionEnabled = true;
    settings.diffusionAlgorithm = diffusion.algorithm;
    settings.diffusionModulation = diffusion.modulation;
    settings.diffusionModStrength = diffusion.modStrength;
    settings.diffusionIntensity = diffusion.intensity;
    settings.diffusionLevels = diffusion.levels;
    settings.diffusionSharpenStrength = diffusion.sharpenStrength;
    settings.diffusionSharpenRadius = diffusion.sharpenRadius;
    settings.diffusionDenoise = diffusion.denoise;
    settings.brokenKernel = diffusion.brokenKernel;
    settings.directionalBias = diffusion.directionalBias;
    settings.directionalBiasAngle = diffusion.directionalBiasAngle;
    settings.errorOverflow = diffusion.errorOverflow;
    settings.diffusionReset = diffusion.reset;
    settings.crossChannelBleed = diffusion.crossChannelBleed;
  }
  if (glitch.enabled) {
    settings.sliceShift = glitch.sliceShift;
    settings.sliceSize = glitch.sliceSize;
    settings.verticalSliceShift = glitch.verticalSliceShift;
    settings.verticalSliceSize = glitch.verticalSliceSize;
    settings.gridWarp = glitch.gridWarp;
    settings.warpScale = glitch.warpScale;
    settings.smearDrag = glitch.smearDrag;
    settings.smearLength = glitch.smearLength;
    settings.smearVertical = glitch.smearVertical;
    settings.macroblockCorrupt = glitch.macroblockCorrupt;
    settings.macroblockDropout = glitch.macroblockDropout;
    settings.blockShift = glitch.blockShift;
    settings.blockShiftSize = glitch.blockShiftSize;
    settings.channelDesync = glitch.channelDesync;
    settings.bitmapSort = glitch.bitmapSort;
    settings.bitmapSortVertical = glitch.bitmapSortVertical;
  }
  return settings;
}

/* ------------------------------------------------------------------ */
/* Planner model                                                       */
/* ------------------------------------------------------------------ */

/**
 * The settings-aware planner model for a layer stack — the piece that keeps
 * planRender's process-wide estimate honest for THIS job instead of a fixed
 * ceiling. Derived from the same renderSettingsFromLayer mapping the
 * runtime uses, so the model can never drift from the kernels' behavior.
 */
export function planLayerModels(
  core: ProjectCoreV1,
  layers: LayerV1[],
  assetDimensions?: WorkerRenderSources["assetDimensions"],
): PlanLayerModel[] {
  return layers.map((layer) => {
    const settings = renderSettingsFromLayer(core, layer);
    const dimensions = assetDimensions?.(layer.assetId) ?? null;
    const model: PlanLayerModel = {
      mode: layer.recipe.mode,
      glitch: glitchActive(settings),
      ...(layer.recipe.mode === "halftone"
        ? {
            gridPoints: Math.max(
              ...contributingPlates(core.separation).map((plate) =>
                estimateGridPoints(
                  core.artboard.widthPx,
                  core.artboard.heightPx,
                  Math.max(0.01, layer.recipe.halftone.cellSize),
                  core.separation.angles[plate],
                ),
              ),
            ),
          }
        : {}),
      heavyGlitch:
        (settings.macroblockCorrupt ?? 0) > 0 ||
        (settings.blockShift ?? 0) > 0 ||
        (settings.bitmapSort ?? 0) > 0,
      fray: layer.recipe.mode === "halftone" && (settings.frayedXEdge > 0 || settings.frayedYEdge > 0),
      ...(layer.recipe.mode === "halftone" && layer.recipe.halftone.dotShape === "custom"
        ? {
            stampBytes:
              customStampSizePx(layer.recipe.halftone.cellSize) ** 2 * 4,
          }
        : {}),
      blurred:
        layer.recipe.mode === "diffusion" &&
        ((settings.diffusionDenoise ?? 0) !== 0 || (settings.diffusionSharpenStrength ?? 0) > 0),
      prep: true,
    };
    if (dimensions) {
      const decodedBytes = dimensions.width * dimensions.height * 4;
      model.sourceBytes = decodedBytes;
      if (dimensions.byteLength !== undefined) {
        const encodedBytes = dimensions.byteLength;
        // Verification holds Blob + one encoded read; native decode/readback
        // holds Blob + bitmap + canvas backing + returned ImageData.
        model.decodePeakBytes = Math.max(
          2 * encodedBytes,
          encodedBytes + 3 * decodedBytes,
        );
      }
    }
    return model;
  });
}

/* ------------------------------------------------------------------ */
/* Registration marks (raster, built-in geometry)                      */
/* ------------------------------------------------------------------ */

/* The built-in mark painter and layout moved to output-transforms.ts so
 * the orchestrator can paint marks AFTER polarity without an import cycle;
 * re-exported here for existing consumers. */
export { paintRegistrationMarks };

/* ------------------------------------------------------------------ */
/* Output assembly helpers                                             */
/* ------------------------------------------------------------------ */

function parseHexColor(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Empty plate raster: constant ink RGB, alpha (coverage) zero. */
function createPlateRaster(width: number, height: number): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  noteAlloc(data.byteLength, "raster", "plate-output");
  const [red, green, blue] = PLATE_INK_RGB;
  for (let index = 0; index < data.length; index += 4) {
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
  }
  return { data, width, height };
}

/** Write premultiplied ink rows into a plate raster's alpha channel. */
function writePlateInkRows(
  raster: RasterData,
  ink: Float32Array,
  pixelOffset: number,
  pixelCount: number,
): void {
  for (let index = 0; index < pixelCount; index += 1) {
    raster.data[(pixelOffset + index) * 4 + 3] = clamp(ink[index]) * 255;
  }
}

/**
 * Composite accumulator: proof over white in press order plus (when the
 * result is not an opaque white-matte proof) the composed LAYER coverage
 * for the output alpha.
 *
 * Alpha semantics (the shared preview/export contract, tested):
 * - Coverage is the composed layer alpha (source alpha × geometry ×
 *   opacity, Porter-Duff over across the stack), NOT the union of ink —
 *   an opaque layer with zero ink is opaque paper (knockout), never a
 *   transparent hole. Composed alpha is plate-independent, so folding each
 *   plate's alpha rows with max() reads the same field.
 * - Transparent output un-mattes the over-white proof by that coverage into
 *   STRAIGHT (non-premultiplied) color: color = (proof − white·(1−a)) / a.
 *   A consumer compositing the result over white therefore reproduces the
 *   white-matte output exactly; no white matte is ever baked in here.
 * - A non-white matte composites the straight color over the matte color
 *   exactly once: out = color·a + matte·(1−a), opaque.
 */
type CompositeCollector = {
  fold(
    plate: PlateId,
    inkRows: Float32Array,
    alphaRows: Float32Array,
    pixelOffset: number,
    pixelCount: number,
  ): void;
  finalize(): RasterData;
  /** Ledger release on abandonment (crash retry / cancellation). */
  dispose(): void;
};

function createCompositeCollector(
  width: number,
  height: number,
  matte: string | null,
): CompositeCollector {
  // The proof fields self-report ("proof" kind, createProofAccumulator);
  // the collector additionally retains the composed-coverage field.
  const proof: ProofAccumulator = createProofAccumulator(width, height, WHITE);
  const coverage = matte === "#ffffff" ? null : new Float32Array(width * height);
  const coverageBytes = coverage ? coverage.byteLength : 0;
  if (coverage) noteAlloc(coverageBytes, "collector", "composite-coverage");
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    releaseProofAccumulator(proof);
    if (coverage) noteRelease(coverageBytes, "collector", "composite-coverage");
  };
  return {
    fold(plate, inkRows, alphaRows, pixelOffset, pixelCount) {
      foldPlateRowsIntoProof(proof, plate, inkRows, pixelOffset, pixelCount);
      if (!coverage) return;
      for (let index = 0; index < pixelCount; index += 1) {
        const at = pixelOffset + index;
        const alpha = clamp(alphaRows[index]);
        if (alpha > coverage[at]) coverage[at] = alpha;
      }
    },
    finalize() {
      const data = quantizeProofRows(proof, 0, height);
      noteAlloc(data.byteLength, "raster", "composite-output");
      if (coverage) {
        const matteRgb = matte ? parseHexColor(matte) : null;
        const { red, green, blue } = proof;
        for (let index = 0; index < coverage.length; index += 1) {
          const alpha = coverage[index];
          const at = index * 4;
          if (alpha <= 0) {
            if (matteRgb) {
              data[at] = matteRgb[0];
              data[at + 1] = matteRgb[1];
              data[at + 2] = matteRgb[2];
              data[at + 3] = 255;
            } else {
              data[at] = 255;
              data[at + 1] = 255;
              data[at + 2] = 255;
              data[at + 3] = 0;
            }
            continue;
          }
          const straightRed = (red[index] - (1 - alpha)) / alpha;
          const straightGreen = (green[index] - (1 - alpha)) / alpha;
          const straightBlue = (blue[index] - (1 - alpha)) / alpha;
          if (matteRgb) {
            data[at] = (straightRed * alpha + (matteRgb[0] / 255) * (1 - alpha)) * 255;
            data[at + 1] = (straightGreen * alpha + (matteRgb[1] / 255) * (1 - alpha)) * 255;
            data[at + 2] = (straightBlue * alpha + (matteRgb[2] / 255) * (1 - alpha)) * 255;
            data[at + 3] = 255;
          } else {
            data[at] = straightRed * 255;
            data[at + 1] = straightGreen * 255;
            data[at + 2] = straightBlue * 255;
            data[at + 3] = alpha * 255;
          }
        }
      }
      dispose();
      return { data, width, height };
    },
    dispose,
  };
}

/* ------------------------------------------------------------------ */
/* Port drivers                                                        */
/* ------------------------------------------------------------------ */

function cancelledError(): ExportError {
  return new ExportError("export-cancelled", "Export cancelled");
}

/** Worker-level failure (crash/channel), eligible for the one-shot fallback. */
const CRASH_CODES = new Set(["worker-crashed"]);

function isCrashFailure(error: unknown): boolean {
  if (error instanceof ExportError) return CRASH_CODES.has(error.code);
  // A synchronous postMessage/constructor throw surfaces as a plain Error.
  return error instanceof Error;
}

function runSingleShot(
  port: StreamingRenderPort,
  job: RenderJobRequest,
  options: RenderRequestOptions,
  onSubmitted?: () => void,
): Promise<RenderResultPayload> {
  return new Promise((resolve, reject) => {
    const unsubscribe = port.onEvent((event: RenderWorkerEvent) => {
      if (event.type === "progress" && event.revision === job.revision) {
        options.onProgress?.(event.ratio);
        return;
      }
      if (event.type === "result" && event.revision === job.revision) {
        unsubscribe();
        resolve(event.payload);
        return;
      }
      if (event.type === "error" && (event.revision === job.revision || event.revision === null)) {
        unsubscribe();
        reject(new ExportError(event.code, event.message));
        return;
      }
      if (event.type === "cancelled" && event.revision === job.revision) {
        unsubscribe();
        reject(cancelledError());
      }
    });
    if (options.signal.aborted) {
      unsubscribe();
      reject(cancelledError());
      return;
    }
    options.signal.addEventListener("abort", () => port.cancel(job.revision), { once: true });
    try {
      port.submit(job);
      // Ownership transferred with the submit (worker port detaches the
      // buffers; a same-realm port takes them over) — the caller's ledger
      // release hook fires HERE, never before.
      onSubmitted?.();
    } catch (error) {
      unsubscribe();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Ledger release for one layer input's TRANSFERRED buffers (decoded prep
 * source / pre-warped raster). Charged at decode; released exactly once —
 * at successful ownership transfer, or at final disposal on failure paths.
 */
function trackSourceRelease(input: RenderLayerInput): () => void {
  const bytes =
    (input.prep?.source.buffer.byteLength ?? 0) + (input.raster?.buffer.byteLength ?? 0);
  const stampBytes = input.customStamp ? stampBitmapBytes(input.customStamp) : 0;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (bytes > 0) noteRelease(bytes, "raster", "decoded-source");
    if (stampBytes > 0) noteRelease(stampBytes, "bitmap", "custom-stamp");
  };
}

/** Stamp resolution used by BOTH the runtime and the planner model. */
export function customStampSizePx(cellSize: number): number {
  return Math.min(2048, Math.max(16, Math.ceil(cellSize * 1.04 * 2)));
}

/** RGBA backing bytes of a custom-stamp ImageBitmap. */
function stampBitmapBytes(stamp: { width: number; height: number }): number {
  return Math.max(1, stamp.width) * Math.max(1, stamp.height) * 4;
}

type StreamedRunArgs = {
  port: StreamingRenderPort;
  revision: number;
  outputWidth: number;
  outputHeight: number;
  bandHeight: number;
  tiles: RenderPlan["tiles"];
  plates: PlateId[];
  layerCount: number;
  /** False for proof-only composites: the worker never slices/transfers
   *  plate bands nobody consumes (~2 fields × plates of avoided churn). */
  emitPlateBands?: boolean;
  paper?: readonly [number, number, number];
  /**
   * Band-credit window (protocol bandWindow) for SINK-BACKED consumers:
   * the session emits at most this many unacked bands, and each band is
   * acked only after `onPlateBand`/`onProofBand` resolves — end-to-end
   * backpressure into the FSA/ZIP writable. Omitted ⇒ eager credits
   * (in-memory consumers, current throughput, byte-identical behavior).
   */
  bandWindow?: number;
  /** Called once per (pass, layer) — sources are re-decoded per pass. */
  produceLayer(layerIndex: number, signal: AbortSignal): Promise<RenderLayerInput>;
  /** May return a promise; bands are consumed strictly in arrival order. */
  onPlateBand(event: RenderExportPlateBandEvent, signal: AbortSignal): void | Promise<void>;
  /** All bands of this plate consumed (runs in the same ordered chain). */
  onPlateComplete?(plate: PlateId, signal: AbortSignal): void | Promise<void>;
  onProofBand?(event: RenderExportProofBandEvent, signal: AbortSignal): void | Promise<void>;
  options: RenderRequestOptions;
};

/** Drive one full ack-gated streaming session over the port. */
async function runStreamed(args: StreamedRunArgs): Promise<void> {
  const { port, revision, options } = args;
  type Waiter = {
    match: (event: RenderWorkerEvent) => boolean;
    resolve: (event: RenderWorkerEvent) => void;
    reject: (error: Error) => void;
  };
  let failure: Error | null = null;
  const waiters: Waiter[] = [];
  const backlog: RenderWorkerEvent[] = [];
  // INTERNAL FAILURE CONTROLLER: raced against the producer awaits below,
  // so a failure landing while the NEXT layer's decode hangs (or while the
  // final band is in flight) settles the run bounded instead of
  // deadlocking on work that will never finish.
  const runAbort = new AbortController();
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    runAbort.abort(error);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  // A throwing port.cancel must never mask the original failure or skip
  // disposal.
  const safeCancel = () => {
    try {
      port.cancel(revision);
    } catch {
      /* contained */
    }
  };
  // ORDERED BAND CHAIN: plate/proof bands and plate-complete boundaries are
  // consumed strictly in arrival order; sink-backed consumers return
  // promises, and each band's CREDIT is returned (band-ack) only after its
  // consumer settled — the end-to-end backpressure contract. A consumer
  // failure fails the run AND cancels the worker so a stalled sink never
  // leaves the session waiting for credits that will not come.
  let bandChain: Promise<void> = Promise.resolve();
  const chainBand = (
    work: () => void | Promise<void>,
    ackAfter: boolean,
    receiptBytes = 0,
  ) => {
    // RECEIVER LEDGER: transferred band buffers are charged AT RECEIPT.
    // The receipt captures its observer because hostile/non-cooperative
    // consumer work can settle after the run and its test observer ended.
    const releaseReceipt = retainAllocation(
      receiptBytes,
      "band",
      "stream-band-receipt",
    );
    bandChain = bandChain
      .then(async () => {
        if (failure) {
          // This queued band never entered its consumer. No detached work
          // can retain the transferred buffers, so ownership ends here.
          releaseReceipt();
          return;
        }

        // The WORK PROMISE owns the receipt charge. Cancellation may settle
        // this run promptly, but it cannot pretend a non-cooperative sink
        // stopped retaining the event buffers: release only when work itself
        // actually settles. Production sinks receive the abort signal and
        // must use it to make that settlement bounded.
        const workPromise = Promise.resolve().then(() => {
          if (runAbort.signal.aborted) throw failure ?? cancelledError();
          return work();
        });
        void workPromise.then(releaseReceipt, releaseReceipt);
        await new Promise<void>((resolve, reject) => {
          if (runAbort.signal.aborted) {
            reject(failure ?? cancelledError());
            return;
          }
          const onRunFail = () => reject(failure ?? cancelledError());
          runAbort.signal.addEventListener("abort", onRunFail, { once: true });
          workPromise.then(
            () => {
              runAbort.signal.removeEventListener("abort", onRunFail);
              resolve();
            },
            (error: unknown) => {
              runAbort.signal.removeEventListener("abort", onRunFail);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
        if (runAbort.signal.aborted) throw failure ?? cancelledError();
        if (ackAfter && args.bandWindow !== undefined) {
          port.ackBand({ type: "band-ack", revision });
        }
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
        safeCancel();
      });
  };
  // Receipt charging only applies to windowed (sink-backed) sessions; the
  // in-memory paths keep their existing ledger shape and throughput.
  const receiptBytesFor = (bytes: number) => (args.bandWindow !== undefined ? bytes : 0);
  const unsubscribe = port.onEvent((event: RenderWorkerEvent) => {
    switch (event.type) {
      case "progress":
        if (event.revision === revision) options.onProgress?.(event.ratio);
        return;
      case "plate-band":
        if (event.revision === revision) {
          chainBand(
            () => args.onPlateBand(event, runAbort.signal),
            true,
            receiptBytesFor(
              event.inkPremultiplied.buffer.byteLength + event.alpha.buffer.byteLength,
            ),
          );
        }
        return;
      case "plate-complete":
        if (event.revision === revision && args.onPlateComplete) {
          const plate = event.plate;
          chainBand(() => args.onPlateComplete!(plate, runAbort.signal), false);
        }
        return;
      case "proof-band":
        if (event.revision === revision && args.onProofBand) {
          chainBand(
            () => args.onProofBand!(event, runAbort.signal),
            true,
            receiptBytesFor(event.rgba.buffer.byteLength),
          );
        }
        return;
      case "error":
        if (event.revision === revision || event.revision === null) {
          fail(new ExportError(event.code, event.message));
        }
        return;
      case "cancelled":
        if (event.revision === revision) fail(cancelledError());
        return;
      default: {
        // REVISION FILTER on control events (export-ready / layer-ack /
        // result / plate-complete): a PREVIOUS session's late event must
        // never satisfy this run's waiters — wrong ack pairing or phantom
        // completion. Non-matching events drop, contained.
        if ("revision" in event && event.revision !== revision) return;
        const index = waiters.findIndex((waiter) => waiter.match(event));
        if (index >= 0) waiters.splice(index, 1)[0].resolve(event);
        else backlog.push(event);
      }
    }
  });
  const waitFor = (match: (event: RenderWorkerEvent) => boolean): Promise<RenderWorkerEvent> => {
    if (failure) return Promise.reject(failure);
    const index = backlog.findIndex(match);
    if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
    return new Promise((resolve, reject) => waiters.push({ match, resolve, reject }));
  };
  const onAbort = () => {
    // LOCAL-FIRST cancellation: fail the local waiters immediately — a
    // crashed/hostile worker that swallows the cancel message must not
    // leave the run pending on a "cancelled" event that never comes. Late
    // events after teardown are dropped by the unsubscribe in finally.
    safeCancel();
    fail(cancelledError());
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal.aborted) throw cancelledError();
    port.beginExport({
      type: "begin-export",
      revision,
      outputWidth: args.outputWidth,
      outputHeight: args.outputHeight,
      renderScale: EXPORT_RENDER_SCALE,
      minimumCellSize: EXPORT_MINIMUM_CELL,
      plates: args.plates,
      layerCount: args.layerCount,
      bandHeight: args.bandHeight,
      tiles: args.tiles,
      ...(args.emitPlateBands === false ? { emitPlateBands: false } : {}),
      ...(args.bandWindow !== undefined ? { bandWindow: args.bandWindow } : {}),
      ...(args.paper ? { paper: args.paper } : {}),
    });
    await waitFor((event) => event.type === "export-ready");
    for (const plate of args.plates) {
      for (let layerIndex = 0; layerIndex < args.layerCount; layerIndex += 1) {
        // INNER CANCEL RACE: produceLayer (decode + prep + stamp awaits)
        // is raced against cancellation; a LATE result is contained —
        // its buffers released from the ledger and its stamp closed —
        // with no state mutation.
        const layerPromise = Promise.resolve(args.produceLayer(layerIndex, runAbort.signal));
        layerPromise.catch(() => undefined);
        let layer: RenderLayerInput;
        try {
          layer = await new Promise<RenderLayerInput>((resolve, reject) => {
            if (options.signal.aborted) {
              reject(cancelledError());
              return;
            }
            if (failure) {
              reject(failure);
              return;
            }
            const onProduceAbort = () => reject(cancelledError());
            const onRunFail = () => reject(failure ?? cancelledError());
            options.signal.addEventListener("abort", onProduceAbort, { once: true });
            runAbort.signal.addEventListener("abort", onRunFail, { once: true });
            const settle = () => {
              options.signal.removeEventListener("abort", onProduceAbort);
              runAbort.signal.removeEventListener("abort", onRunFail);
            };
            layerPromise.then(
              (value) => {
                settle();
                resolve(value);
              },
              (error: unknown) => {
                settle();
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
          });
        } catch (error) {
          void layerPromise
            .then((late) => {
              trackSourceRelease(late)();
              late.customStamp?.close();
            })
            .catch(() => undefined);
          throw error;
        }
        const releaseSource = trackSourceRelease(layer);
        let submitted = false;
        try {
          if (failure) throw failure;
          if (options.signal.aborted) throw cancelledError();
          port.submitLayer({ type: "submit-layer", revision, plate, layerIndex, layer });
          submitted = true;
        } finally {
          // Transferred (worker port detaches; a same-realm port takes
          // ownership) or disposed on the failure path — either way the
          // app realm no longer owns the bytes past this point. An
          // UNTRANSFERRED stamp is closed here too (partial ownership).
          releaseSource();
          if (!submitted) layer.customStamp?.close();
        }
        await waitFor(
          (event) =>
            event.type === "layer-ack" && event.plate === plate && event.layerIndex === layerIndex,
        );
      }
    }
    port.finalizeExport({ type: "finalize-export", revision });
    await waitFor((event) => event.type === "result");
    // Drain the ordered band chain: trailing sink writes must complete (or
    // surface their failure) before the run resolves.
    await bandChain;
    if (failure) throw failure;
  } finally {
    unsubscribe();
    options.signal.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------------------ */
/* SVG plate generation                                                */
/* ------------------------------------------------------------------ */

/** Legacy svgDot geometry (characterization §6); parity with the studio table. */
function svgDotMark(
  x: number,
  y: number,
  size: number,
  shape: Exclude<DotShape, "custom">,
  strokeWidth: number,
): string {
  const radius = size / 2;
  if (shape === "square") {
    return `<rect x="${x - radius}" y="${y - radius}" width="${size}" height="${size}"/>`;
  }
  if (shape === "diamond") {
    return `<path d="M ${x} ${y - radius} L ${x + radius} ${y} L ${x} ${y + radius} L ${x - radius} ${y} Z"/>`;
  }
  if (shape === "triangle") {
    return `<path d="M ${x} ${y - radius} L ${x + radius} ${y + radius} L ${x - radius} ${y + radius} Z"/>`;
  }
  if (shape === "cross") {
    const bar = size * 0.14;
    return `<path d="M ${x - bar} ${y - radius} H ${x + bar} V ${y + radius} H ${x - bar} Z M ${x - radius} ${y - bar} H ${x + radius} V ${y + bar} H ${x - radius} Z"/>`;
  }
  if (shape === "line") {
    return `<rect x="${x - radius}" y="${y - size * 0.16}" width="${size}" height="${size * 0.32}" rx="${size * 0.16}"/>`;
  }
  if (shape === "circle-outline" && strokeWidth < radius) {
    return `<circle cx="${x}" cy="${y}" r="${Math.max(0, radius - strokeWidth / 2)}" fill="none" stroke="#000000" stroke-width="${strokeWidth}"/>`;
  }
  return `<circle cx="${x}" cy="${y}" r="${radius}"/>`;
}

/**
 * Turn stored custom-dot SVG text into a reusable <symbol>.
 *
 * INJECTION GATE (poisoned-storage defense): stored bytes reach a
 * DOWNLOADED SVG file verbatim here, so they are accepted ONLY when they
 * are a strict-sanitizer fixed point for the custom-dot role — canonical
 * intake guarantees that for every legitimately imported shape; anything
 * else (tampered IndexedDB rows, legacy non-canonical bytes) fails closed.
 *
 * The symbol carries preserveAspectRatio="none": custom dots stretch to
 * the square dot cell, matching the raster stamp path (drawImage stretch).
 */
function svgSymbolFromText(svgText: string, id: string): string {
  let canonical: string;
  try {
    canonical = sanitizeSvg(svgText, "custom-dot").svg;
  } catch (error) {
    throw new ExportError(
      "svg-unsafe",
      "The stored custom dot SVG failed the safety sanitizer; re-import the shape.",
      { cause: error },
    );
  }
  if (canonical !== svgText) {
    throw new ExportError(
      "svg-unsafe",
      "The stored custom dot SVG is not in canonical sanitized form; re-import the shape.",
    );
  }
  return svgText
    .replace(/^\s*<svg\b/, `<symbol id="${id}" preserveAspectRatio="none"`)
    .replace(/<\/svg>\s*$/, "</symbol>");
}

function svgUse(id: string, x: number, y: number, size: number): string {
  return `<use href="#${id}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"/>`;
}

function svgRegistration(registration: RegistrationV1, width: number, height: number): string {
  const { points, size, weight } = registrationPoints(registration, width, height);
  const radius = size * 0.58;
  const marks = points
    .map(
      ([x, y]) =>
        `<g opacity="0.7"><circle cx="${x}" cy="${y}" r="${radius}"/><path d="M ${x - size} ${y} h ${2 * size} M ${x} ${y - size} v ${2 * size}"/></g>`,
    )
    .join("");
  return `<g fill="none" stroke="#000000" stroke-width="${weight}">${marks}</g>`;
}

/** Marks appended per time-slice while formatting vector output. */
const SVG_MARKS_PER_SLICE = 20_000;

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function createWorkerRenderService(serviceOptions: WorkerRenderServiceOptions): RenderService {
  const { sources, createPort } = serviceOptions;
  const createFallbackPort = serviceOptions.createFallbackPort ?? createPort;
  const budget = serviceOptions.renderBudgetBytes ?? RESOURCE_POLICY.maxRenderPeakBytes;
  const offscreenCapable = () => serviceOptions.offscreenCanvas ?? supportsOffscreenCanvas();

  /**
   * Decode one asset for one consumption. NOT cached: the returned raster's
   * buffer transfers with the submit that consumes it (the streamed form
   * re-decodes per pass by design — retaining eight decoded full sheets is
   * exactly the unbounded source cache the ledger forbids). The ledger
   * notes the bytes; the transfer's consumer notes the release.
   */
  async function decode(assetId: Sha256, signal?: AbortSignal): Promise<RasterData> {
    const raster = await sources.resolveRaster(assetId, signal);
    noteAlloc(raster.data.byteLength, "raster", "decoded-source");
    return raster;
  }

  function assertBuiltInRegistration(core: ProjectCoreV1, registration: boolean): void {
    if (registration && core.registration.customShapeAssetId !== null) {
      throw new ExportError(
        "registration-shape-unsupported",
        "Custom registration marks need a main-thread prepared stamp; the worker renderer " +
          "draws built-in marks only. Clear the custom registration shape to export.",
      );
    }
  }

  /**
   * RUNTIME candidate gate, enforced BEFORE any source decode on every
   * path that reaches the lattice walker (raster AND vector): an
   * extreme-aspect artboard can pass the dot-count caps yet scan billions
   * of candidates — refuse the traversal itself.
   */
  function assertGridBudget(core: ProjectCoreV1, layers: LayerV1[]): void {
    const { widthPx, heightPx } = core.artboard;
    for (const layer of layers) {
      if (layer.recipe.mode !== "halftone") continue;
      const cell = effectiveCellSize(
        layer.recipe.halftone.cellSize,
        EXPORT_RENDER_SCALE,
        EXPORT_MINIMUM_CELL,
      );
      if (estimateGridCandidates(widthPx, heightPx, cell) > MAX_GRID_CANDIDATES) {
        throw new ExportError(
          "grid-points-exceeded",
          "The halftone screen lattice is too dense to traverse; increase cell size.",
        );
      }
      // Raster placement-memory cap, enforced pre-decode for DIRECT
      // service callers too (UI preflight enforces the same cap earlier).
      for (const plate of contributingPlates(core.separation)) {
        if (
          estimateGridPointsRender(widthPx, heightPx, cell, core.separation.angles[plate]) >
          MAX_RASTER_GRID_POINTS
        ) {
          throw new ExportError(
            "grid-points-exceeded",
            "The halftone screen produces too many dots to place; increase cell size.",
          );
        }
      }
    }
  }

  function assertCapabilities(layers: LayerV1[], vector: boolean): void {
    if (vector || offscreenCapable()) return;
    if (layers.some((layer) => layer.recipe.mode === "halftone")) {
      // BEFORE execution: without OffscreenCanvas no path (worker,
      // main-thread, single-shot, streamed) can rasterize halftone dots for
      // an export; refuse before any decode or allocation instead of
      // rendering layer-data and failing afterwards.
      throw new ExportError(
        "render-environment-unsupported",
        "Raster export of halftone layers needs OffscreenCanvas, which this browser lacks. " +
          "Export from Chrome or Edge, or export vector plates.",
      );
    }
  }

  /**
   * Produce one layer's transferable render input: decoded source + crop +
   * homography (prep descriptor). The worker warps; the main thread never
   * holds a warped artboard raster. The decoded buffer is consumed by the
   * transfer, so nothing stays cached here.
   */
  async function produceLayerInput(
    core: ProjectCoreV1,
    layer: LayerV1,
    width: number,
    height: number,
    flattenWhite = false,
    needStamp = true,
    signal?: AbortSignal,
  ): Promise<RenderLayerInput> {
    // STAMP FIRST (ordering-leak fix): the cheap custom-stamp resolution
    // happens BEFORE the expensive source decode, so a rejecting or
    // hanging stamp source can never strand a charged decoded raster.
    let customStamp: ImageBitmap | undefined;
    const { halftone: halftoneRecipe } = layer.recipe;
    const wantsCustomStamp =
      layer.recipe.mode === "halftone" && halftoneRecipe.dotShape === "custom" && needStamp;
    if (wantsCustomStamp) {
      if (halftoneRecipe.customShapeAssetId === null || !sources.resolveCustomStamp) {
        throw new ExportError(
          "custom-stamp-unavailable",
          "This layer uses a custom dot shape but no prepared stamp source is available.",
        );
      }
      const stampSize = customStampSizePx(halftoneRecipe.cellSize);
      customStamp = await sources.resolveCustomStamp(halftoneRecipe.customShapeAssetId, stampSize);
      // Ledger: stamp bitmap backing charged at creation; released at
      // ownership transfer or disposal (trackSourceRelease).
      noteAlloc(stampBitmapBytes(customStamp), "bitmap", "custom-stamp");
    }
    let source: RasterData;
    let prep: ReturnType<typeof buildLayerPrep>;
    try {
      source = await decode(layer.assetId, signal);
      try {
        prep = buildLayerPrep(layer, source, {
          outputWidth: width,
          outputHeight: height,
          renderScale: EXPORT_RENDER_SCALE,
        });
      } catch (error) {
        // Decode succeeded but prep failed: the charged source is disposed.
        noteRelease(source.data.byteLength, "raster", "decoded-source");
        throw error;
      }
    } catch (error) {
      // Partial ownership on ANY post-stamp failure: the resolved,
      // untransferred stamp is closed (and its charge released) before
      // the error surfaces.
      if (customStamp) {
        noteRelease(stampBitmapBytes(customStamp), "bitmap", "custom-stamp");
        customStamp.close();
      }
      throw error;
    }
    // NOTE (release-at-transfer, wave G2 audit): the decoded source stays
    // CHARGED on the ledger through the optional custom-stamp await below
    // and until the submit that actually transfers it — the caller
    // releases via trackSourceRelease at ownership transfer or disposal.
    const { halftone } = layer.recipe;
    const input: RenderLayerInput = {
      prep,
      settings: renderSettingsFromLayer(core, layer),
      opacity: layer.opacity,
      dotShape: layer.recipe.mode === "halftone" ? halftone.dotShape : "round",
      strokeWidth: halftone.strokeWidth,
    };
    if (flattenWhite) input.flattenWhite = true;
    if (customStamp) input.customStamp = customStamp;
    return input;
  }

  function contributing(core: ProjectCoreV1): LayerV1[] {
    return core.layers.filter((layer) => layer.visible);
  }

  function plan(
    core: ProjectCoreV1,
    layers: LayerV1[],
    plateCount: number,
    wantsProof: boolean,
    output?: PlanOutputModel,
  ): RenderPlan {
    const { widthPx, heightPx } = core.artboard;
    return planRender(
      {
        sampleWidth: widthPx,
        sampleHeight: heightPx,
        outputWidth: widthPx,
        outputHeight: heightPx,
        plateCount: Math.max(1, plateCount),
        layerCount: Math.max(1, layers.length),
        wantsProof,
        layers: planLayerModels(core, layers, sources.assetDimensions?.bind(sources)),
        ...(output ? { output } : {}),
      },
      budget,
    );
  }

  /**
   * Run `attempt` with the exactly-once crash fallback: worker constructor
   * throws, synchronous postMessage throws, and mid-job crashes
   * (`worker-crashed`) reissue the FROZEN work once over the fallback port
   * factory with completely fresh state (the attempt closure re-creates its
   * collectors and re-produces its inputs). Render errors, cancellations,
   * and a second crash surface unchanged.
   */
  async function withPortFallback<T>(
    options: RenderRequestOptions,
    attempt: (port: StreamingRenderPort) => Promise<T>,
  ): Promise<T> {
    let port: StreamingRenderPort | null = null;
    try {
      port = createPort();
      return await attempt(port);
    } catch (error) {
      if (options.signal.aborted || !isCrashFailure(error)) throw error;
      port?.dispose();
      port = null;
      const fallback = createFallbackPort();
      try {
        return await attempt(fallback);
      } finally {
        fallback.dispose();
      }
    } finally {
      port?.dispose();
    }
  }

  /** Service-side compose of the typed layer-data fallback (no OffscreenCanvas). */
  function foldLayerData(
    layerData: LayerPlateData[],
    plates: PlateId[],
    width: number,
    height: number,
    layerOpacity: (layerIndex: number) => number,
    fold: (
      plate: PlateId,
      ink: Float32Array,
      alpha: Float32Array,
      pixelOffset: number,
      pixelCount: number,
    ) => void,
  ): void {
    const pixelCount = width * height;
    for (const plate of plates) {
      const plateLayers: PlateLayerOutput[] = layerData
        .filter((entry) => entry.plate === plate)
        .sort((left, right) => left.layerIndex - right.layerIndex)
        .map((entry) => {
          const field = new Float32Array(entry.field.buffer);
          if (entry.mode === "diffusion") {
            // Parity with diffusionInkField's >= 0.5 presentation threshold.
            const ink = field.slice();
            for (let index = 0; index < ink.length; index += 1) {
              ink[index] = ink[index] < 0.5 ? 0 : 1;
            }
            return { ink, alpha: new Float32Array(entry.alpha.buffer), opacity: layerOpacity(entry.layerIndex) };
          }
          return { ink: field, alpha: new Float32Array(entry.alpha.buffer), opacity: layerOpacity(entry.layerIndex) };
        });
      const composed = composePlate(plateLayers, pixelCount);
      fold(plate, composed.inkPremultiplied, composed.alpha, 0, pixelCount);
    }
  }

  /**
   * Run the chosen job form and feed every composed plate's premultiplied
   * ink to `fold` (full arrays for single-shot, bands for streamed; both in
   * press order). Returns the proof bands' target when in-session proofing.
   */
  async function renderPlates(
    core: ProjectCoreV1,
    layers: LayerV1[],
    plates: PlateId[],
    options: RenderRequestOptions,
    chosen: RenderPlan,
    port: StreamingRenderPort,
    fold: (
      plate: PlateId,
      ink: Float32Array,
      alpha: Float32Array,
      pixelOffset: number,
      pixelCount: number,
    ) => void,
    wantsProof: boolean,
  ): Promise<Uint8ClampedArray | null> {
    const { widthPx: width, heightPx: height } = core.artboard;
    // LAZY proof staging: nothing is allocated until proof bytes actually
    // arrive — for streamed sessions that is after every plate pass, so no
    // idle 4-bytes-per-pixel buffer inflates the peak through the passes.
    let proofTarget: Uint8ClampedArray | null = null;
    const proofStage = (): Uint8ClampedArray => {
      if (!proofTarget) {
        proofTarget = new Uint8ClampedArray(width * height * 4);
        noteAlloc(proofTarget.byteLength, "raster", "proof-target");
      }
      return proofTarget;
    };
    if (chosen.form === "single-shot") {
      // Every input is resident until the ONE submit transfers them —
      // exactly the sum the planner's single-shot source term models; the
      // ledger releases at transfer (or at disposal on failure).
      const layerInputs: RenderLayerInput[] = [];
      const releases: (() => void)[] = [];
      let payload: RenderResultPayload;
      let submitted = false;
      try {
        for (const layer of layers) {
          const input = await produceLayerInput(
            core,
            layer,
            width,
            height,
            false,
            true,
            options.signal,
          );
          layerInputs.push(input);
          releases.push(trackSourceRelease(input));
        }
        payload = await runSingleShot(
          port,
          {
            type: "job",
            kind: "export",
            revision: options.revision,
            outputWidth: width,
            outputHeight: height,
            renderScale: EXPORT_RENDER_SCALE,
            minimumCellSize: EXPORT_MINIMUM_CELL,
            plates,
            layers: layerInputs,
            tiles: chosen.tiles,
            ...(wantsProof ? { paper: WHITE } : {}),
            wantBitmap: false,
          },
          options,
          () => {
            submitted = true;
            for (const release of releases) release();
          },
        );
      } finally {
        for (const release of releases) release();
        // Never-submitted inputs still own their stamps (partial-ownership
        // matrix): close them; transferred stamps belong to the port.
        if (!submitted) {
          for (const input of layerInputs) input.customStamp?.close();
        }
      }
      if (payload.form === "layer-data") {
        // Typed fallback: diffusion/clean stacks compose here with the same
        // composePlate math (halftone was refused before execution).
        foldLayerData(
          payload.layers,
          plates,
          width,
          height,
          (layerIndex) => layers[layerIndex]?.opacity ?? 1,
          fold,
        );
        if (wantsProof) {
          throw new ExportError(
            "render-proof-missing",
            "The reduced renderer cannot produce an in-session proof; derive it from plates.",
          );
        }
        return null;
      }
      if (payload.form !== "plates") {
        throw new ExportError(
          "render-environment-unsupported",
          "The export renderer could not compose plates in this environment.",
        );
      }
      for (const plate of payload.plates) {
        fold(
          plate.plate,
          new Float32Array(plate.inkPremultiplied.buffer),
          new Float32Array(plate.alpha.buffer),
          0,
          width * height,
        );
      }
      if (wantsProof && payload.proof) {
        // Adopt the payload's transferred proof bytes outright — no copy,
        // no separate staging buffer.
        const adopted = new Uint8ClampedArray(payload.proof.buffer);
        noteAlloc(adopted.byteLength, "raster", "proof-target");
        return adopted;
      }
      if (wantsProof) {
        throw new ExportError("render-proof-missing", "The renderer returned no proof raster.");
      }
      return null;
    }
    await runStreamed({
      port,
      revision: options.revision,
      outputWidth: width,
      outputHeight: height,
      bandHeight: chosen.bandHeight,
      tiles: chosen.tiles,
      plates,
      layerCount: layers.length,
      // Proof-only composites consume no plate bands: suppress their
      // slicing/transfer entirely inside the session.
      ...(wantsProof ? { emitPlateBands: false, paper: WHITE } : {}),
      produceLayer: (layerIndex, signal) =>
        produceLayerInput(core, layers[layerIndex], width, height, false, true, signal),
      onPlateBand: (event) => {
        fold(
          event.plate,
          new Float32Array(event.inkPremultiplied.buffer),
          new Float32Array(event.alpha.buffer),
          event.rowStart * width,
          event.rowCount * width,
        );
      },
      ...(wantsProof
        ? {
            onProofBand: (event: RenderExportProofBandEvent) => {
              proofStage().set(
                new Uint8ClampedArray(event.rgba.buffer),
                event.rowStart * width * 4,
              );
            },
          }
        : {}),
      options,
    }).catch((error: unknown) => {
      if (proofTarget) noteRelease(proofTarget.byteLength, "raster", "proof-target");
      throw error;
    });
    return proofTarget;
  }

  /** Shared composite pipeline for renderComposite and renderLayer. */
  async function renderCompositeOf(
    core: ProjectCoreV1,
    layers: LayerV1[],
    options: RenderRequestOptions,
  ): Promise<RasterData> {
    assertBuiltInRegistration(core, options.registration);
    const { widthPx: width, heightPx: height } = core.artboard;
    const plates = contributingPlates(core.separation);
    if (layers.length === 0) {
      throw new ExportError("no-printable-layers", "There is no layer to render.");
    }
    assertCapabilities(layers, false);
    assertGridBudget(core, layers);
    // In-session/opaque proof only serves the white-matte result; every
    // other matte or transparency needs plate coverages for the alpha model.
    const opaqueWhite = options.matte === "#ffffff";
    const outputModel: PlanOutputModel = { kind: "composite", whiteMatte: opaqueWhite };
    const proofPlan = opaqueWhite ? plan(core, layers, plates.length, true, outputModel) : null;
    const useRendererProof =
      proofPlan !== null && proofPlan.withinBudget && offscreenCapable();
    const chosen = useRendererProof
      ? proofPlan
      : plan(core, layers, plates.length, false, { ...outputModel, whiteMatte: false });
    if (!chosen.withinBudget) {
      // TRUTHFUL HARD BLOCK before any decode/allocation: the honest
      // process-wide model (worker + collector + finalize) fits no form.
      throw new ExportError(
        "render-peak-exceeded",
        `This export needs about ${Math.round(chosen.estimatedPeakBytes / (1024 * 1024))} MiB across ` +
          `render and assembly; the budget is ${Math.round(chosen.budgetBytes / (1024 * 1024))} MiB. ` +
          "Reduce the artboard size or layer complexity.",
      );
    }
    const raster = await withPortFallback(options, async (port) => {
      if (useRendererProof) {
        const proofTarget = await renderPlates(
          core,
          layers,
          plates,
          options,
          chosen,
          port,
          () => undefined,
          true,
        );
        if (!proofTarget) {
          throw new ExportError("render-proof-missing", "The renderer returned no proof raster.");
        }
        return { data: proofTarget, width, height };
      }
      const collector = createCompositeCollector(width, height, options.matte);
      try {
        await renderPlates(core, layers, plates, options, chosen, port, collector.fold, false);
      } catch (error) {
        collector.dispose();
        throw error;
      }
      return collector.finalize();
    });
    if (options.registration) paintRegistrationMarks(raster, core.registration);
    options.onProgress?.(1);
    return raster;
  }

  /** Time-sliced consumer loop for vector mark formatting. */
  async function sliceMarks(
    options: RenderRequestOptions,
    count: number,
    emit: (index: number) => void,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      if (index > 0 && index % SVG_MARKS_PER_SLICE === 0) {
        if (options.signal.aborted) throw cancelledError();
        await yieldToEventLoop();
      }
      emit(index);
    }
  }

  return {
    renderComposite(core, options) {
      return renderCompositeOf(core, contributing(core), options);
    },

    async renderPlate(core, plate, options) {
      assertBuiltInRegistration(core, options.registration);
      const { widthPx: width, heightPx: height } = core.artboard;
      const layers = contributing(core);
      if (layers.length === 0) {
        throw new ExportError("no-printable-layers", "There is no layer to render.");
      }
      assertCapabilities(layers, false);
      assertGridBudget(core, layers);
      const chosen = plan(core, layers, 1, false, { kind: "plate" });
      if (!chosen.withinBudget) {
        throw new ExportError(
          "render-peak-exceeded",
          `This export needs about ${Math.round(chosen.estimatedPeakBytes / (1024 * 1024))} MiB across ` +
            `render and assembly; the budget is ${Math.round(chosen.budgetBytes / (1024 * 1024))} MiB. ` +
            "Reduce the artboard size or layer complexity.",
        );
      }
      const raster = await withPortFallback(options, async (port) => {
        const target = createPlateRaster(width, height);
        try {
          await renderPlates(
            core,
            layers,
            [plate],
            options,
            chosen,
            port,
            (_plate, ink, _alpha, pixelOffset, pixelCount) =>
              writePlateInkRows(target, ink, pixelOffset, pixelCount),
            false,
          );
        } catch (error) {
          noteRelease(target.data.byteLength, "raster", "plate-output");
          throw error;
        }
        return target;
      });
      if (options.registration) paintRegistrationMarks(raster, core.registration);
      options.onProgress?.(1);
      return raster;
    },

    async renderLayer(core, layerId: Id, options) {
      const layer = core.layers.find(({ id }) => id === layerId);
      if (!layer) {
        throw new ExportError("render-layer-missing", "The selected layer does not exist.");
      }
      // Selected-layer exports include the layer even when hidden (preflight
      // warns); always transparent, placement preserved.
      return renderCompositeOf(core, [layer], options);
    },

    /**
     * TRUE STREAMING plate delivery (wave G2): ONE band-credited streaming
     * session over every plate; each composed plate's Float32 ink bands
     * convert to RGBA plate rows and are pushed into `delivery` in strict
     * row order, acked only after the sink accepted them
     * (STREAM_DELIVERY_BAND_WINDOW bounds the in-flight backlog). No full
     * plate raster exists on this path, no encoded output is retained, and
     * the planner models the sink share via PlanOutputModel.streamedSink.
     *
     * NO CRASH FALLBACK here, deliberately: bands already externalized to
     * the sink cannot be replayed without buffering the output (which the
     * memory contract forbids) — a worker crash surfaces as a typed export
     * failure and the caller aborts/removes the partial file. Registration
     * must be requested OFF; marks are the orchestrator's band-wise final
     * pass (custom registration shapes are refused upstream).
     */
    async streamPlates(core, plates, options, delivery) {
      if (options.registration) {
        throw new ExportError(
          "stream-registration-misrouted",
          "streamPlates renders without registration; marks are the caller's band-wise final pass.",
        );
      }
      assertBuiltInRegistration(core, false);
      const { widthPx: width, heightPx: height } = core.artboard;
      const layers = contributing(core);
      if (layers.length === 0) {
        throw new ExportError("no-printable-layers", "There is no layer to render.");
      }
      assertCapabilities(layers, false);
      assertGridBudget(core, layers);
      const chosen = plan(core, layers, plates.length, false, {
        kind: "plate",
        streamedSink: true,
      });
      // ADMIT-SHAPE === EXECUTE-SHAPE: this path always runs the streamed
      // session, so admission gates on the STREAMED estimate explicitly —
      // never on a smaller single-shot plan the execution will not use.
      if (!chosen.streamable || chosen.streamedPeakBytes > chosen.budgetBytes) {
        throw new ExportError(
          "render-peak-exceeded",
          `This export needs about ${Math.round(chosen.streamedPeakBytes / (1024 * 1024))} MiB across ` +
            `render and streamed delivery; the budget is ${Math.round(chosen.budgetBytes / (1024 * 1024))} MiB. ` +
            "Reduce the artboard size or layer complexity.",
        );
      }
      const port = createPort();
      // HOSTILE-RECEIVER VALIDATION: the band stream is validated like
      // untrusted input — exact plate order (the begin-export sequence),
      // gapless contiguous coverage, positive in-bounds row counts, exact
      // Float32 byte lengths for ink AND alpha, and exactly-once plate
      // completion. Any violation is a typed failure; the job fails closed
      // and the caller abandons its sink.
      let plateIndex = -1;
      let expectedRow = 0;
      let plateOpen = false;
      const violation = (message: string): never => {
        throw new ExportError("stream-protocol-violation", message);
      };
      try {
        await runStreamed({
          port,
          revision: options.revision,
          outputWidth: width,
          outputHeight: height,
          bandHeight: chosen.bandHeight,
          tiles: chosen.tiles,
          plates,
          layerCount: layers.length,
          bandWindow: STREAM_DELIVERY_BAND_WINDOW,
          produceLayer: (layerIndex, signal) =>
            produceLayerInput(core, layers[layerIndex], width, height, false, true, signal),
          onPlateBand: async (event, bandSignal) => {
            if (!plateOpen) {
              const expectedPlate = plates[plateIndex + 1];
              if (event.plate !== expectedPlate) {
                violation(
                  `Plate ${event.plate} bands arrived out of sequence (expected ${expectedPlate ?? "no further plates"}).`,
                );
              }
              plateIndex += 1;
              plateOpen = true;
              expectedRow = 0;
              await delivery.beginPlate(event.plate, bandSignal);
            } else if (event.plate !== plates[plateIndex]) {
              violation(
                `Plate ${event.plate} bands interleaved into the ${plates[plateIndex]} pass.`,
              );
            }
            if (!Number.isInteger(event.rowCount) || event.rowCount < 1) {
              violation(`Plate ${event.plate} band carries an invalid rowCount (${event.rowCount}).`);
            }
            if (event.rowStart !== expectedRow || expectedRow + event.rowCount > height) {
              violation(
                `Plate ${event.plate} bands are not contiguous (row ${event.rowStart} × ${event.rowCount}, expected ${expectedRow} of ${height}).`,
              );
            }
            const pixels = event.rowCount * width;
            if (
              event.inkPremultiplied.buffer.byteLength !== pixels * 4 ||
              event.alpha.buffer.byteLength !== pixels * 4
            ) {
              violation(
                `Plate ${event.plate} band byte lengths do not match ${event.rowCount} rows × ${width} px.`,
              );
            }
            expectedRow += event.rowCount;
            const rows = plateInkRowsToRgba(new Float32Array(event.inkPremultiplied.buffer), pixels);
            const releaseRows = retainAllocation(
              rows.byteLength,
              "encode",
              "stream-plate-band",
            );
            try {
              await delivery.writeBand(
                event.plate,
                event.rowStart,
                event.rowCount,
                rows,
                bandSignal,
              );
            } finally {
              releaseRows();
            }
          },
          onPlateComplete: async (plate, bandSignal) => {
            if (!plateOpen || plate !== plates[plateIndex]) {
              violation(`Plate ${plate} completed out of sequence or twice.`);
            }
            if (expectedRow !== height) {
              violation(`Plate ${plate} completed after ${expectedRow} of ${height} rows.`);
            }
            plateOpen = false;
            await delivery.endPlate(plate, bandSignal);
          },
          options,
        });
        if (plateIndex !== plates.length - 1 || plateOpen) {
          violation("The session ended before every plate's bands were delivered.");
        }
      } finally {
        port.dispose();
      }
      options.onProgress?.(1);
    },

    async renderPlateSvg(core, plate, options) {
      assertBuiltInRegistration(core, options.registration);
      const { widthPx: width, heightPx: height } = core.artboard;
      const layers = contributing(core);
      if (layers.some((layer) => layer.recipe.mode === "clean")) {
        throw new ExportError(
          "vector-ineligible",
          "Clean continuous-tone layers have no vector representation; export raster plates instead.",
        );
      }
      if (layers.length > 1 && layers.some((layer) => layer.recipe.mode === "diffusion")) {
        throw new ExportError(
          "vector-ineligible",
          "Diffusion layers export vector plates only as a single layer; use raster plates for mixed stacks.",
        );
      }
      // Grid budget gate before ANY numeric work (legacy pre-gate parity),
      // plus the runtime candidate-traversal gate.
      assertGridBudget(core, layers);
      for (const layer of layers) {
        if (layer.recipe.mode !== "halftone") continue;
        const settings = renderSettingsFromLayer(core, layer);
        const cell = effectiveCellSize(settings.cellSize, EXPORT_RENDER_SCALE, EXPORT_MINIMUM_CELL);
        if (estimateGridPoints(width, height, cell, settings.angles[plate]) > MAX_EXPORT_GRID_POINTS) {
          throw new ExportError(
            "grid-points-exceeded",
            "SVG export exceeds the vector mark limit. Increase cell size.",
          );
        }
      }
      const definitions: string[] = [];
      const groups: string[] = [];
      // One worker job PER LAYER (forced layer-data payload): the numeric
      // work — white-flatten, coverage/glitch/diffusion fields, grid walk —
      // runs off the main thread, and at most one layer's fields are
      // resident here while its marks are formatted (time-sliced below).
      for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
        if (options.signal.aborted) throw cancelledError();
        const layer = layers[layerIndex];
        const payload = await withPortFallback(options, async (port) => {
          // Vector output needs no raster stamp — the <symbol> comes from
          // the sanitized SVG text below.
          const input = await produceLayerInput(
            core,
            layer,
            width,
            height,
            true,
            false,
            options.signal,
          );
          const releaseSource = trackSourceRelease(input);
          try {
            return await runSingleShot(
              port,
              {
                type: "job",
                kind: "export",
                revision: options.revision,
                outputWidth: width,
                outputHeight: height,
                renderScale: EXPORT_RENDER_SCALE,
                minimumCellSize: EXPORT_MINIMUM_CELL,
                plates: [plate],
                layers: [input],
                wantBitmap: false,
                payloadForm: "layer-data",
              },
              options,
              releaseSource,
            );
          } finally {
            releaseSource();
          }
        });
        if (payload.form !== "layer-data") {
          throw new ExportError("render-environment-unsupported", "Vector plate generation expected kernel layer data.");
        }
        const entry = payload.layers.find((candidate) => candidate.plate === plate);
        const shapes: string[] = [];
        if (entry && layer.recipe.mode === "diffusion") {
          const field = new Float32Array(entry.field.buffer);
          let runs = 0;
          for (let y = 0; y < height; y += 1) {
            if (y % 64 === 0) {
              if (options.signal.aborted) throw cancelledError();
              if (y > 0) await yieldToEventLoop();
            }
            for (let x = 0; x < width; ) {
              if (field[y * width + x] < 0.5) {
                x += 1;
                continue;
              }
              const from = x;
              x += 1;
              while (x < width && field[y * width + x] >= 0.5) x += 1;
              runs += 1;
              if (runs > MAX_DIFFUSION_SVG_RUNS) {
                throw new ExportError(
                  "diffusion-runs-exceeded",
                  "SVG export exceeds the diffusion run limit.",
                );
              }
              shapes.push(`<rect x="${from}" y="${y}" width="${x - from + 0.25}" height="1.25"/>`);
            }
          }
        } else if (entry && entry.placements) {
          const packed = new Float64Array(entry.placements.buffer);
          const count = entry.placements.count;
          const { halftone } = layer.recipe;
          const shape = halftone.dotShape;
          if (shape === "custom") {
            if (halftone.customShapeAssetId === null || !sources.resolveSvgText) {
              throw new ExportError(
                "custom-stamp-unavailable",
                "This layer uses a custom dot shape but no sanitized SVG source is available.",
              );
            }
            const symbolId = `dot-shape-${layerIndex}`;
            definitions.push(
              svgSymbolFromText(await sources.resolveSvgText(halftone.customShapeAssetId), symbolId),
            );
            await sliceMarks(options, count, (index) => {
              shapes.push(svgUse(symbolId, packed[index * 3], packed[index * 3 + 1], packed[index * 3 + 2]));
            });
          } else {
            await sliceMarks(options, count, (index) => {
              shapes.push(
                svgDotMark(
                  packed[index * 3],
                  packed[index * 3 + 1],
                  packed[index * 3 + 2],
                  shape,
                  halftone.strokeWidth * EXPORT_RENDER_SCALE,
                ),
              );
            });
          }
        }
        groups.push(
          `<g fill="#000000" stroke="none" opacity="${clamp(layer.opacity)}">${shapes.join("")}</g>`,
        );
      }
      const registration = options.registration
        ? svgRegistration(core.registration, width, height)
        : "";
      options.onProgress?.(1);
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${(width / DOCUMENT_DPI).toFixed(4)}in" ` +
        `height="${(height / DOCUMENT_DPI).toFixed(4)}in" viewBox="0 0 ${width} ${height}">` +
        `<defs>${definitions.join("")}</defs>${groups.join("")}${registration}</svg>`
      );
    },
  };
}
