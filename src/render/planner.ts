/**
 * Render planning: tile sizing, band sizing, draft-scale selection, job-form
 * selection, and ONE PROCESS-WIDE peak memory model checked against
 * RESOURCE_POLICY.maxRenderPeakBytes.
 *
 * THE LEDGER MODEL. A render's retained bytes live in two places at once and
 * the budget only means something if both are counted together:
 *
 * - WORKER side: the current layer's source (during its banded warp) and
 *   warped raster, the settings-dependent kernel window (an inactive glitch
 *   is one field copy, an active block-shift/sort chain is up to three
 *   concurrent fields — see kernelTransientFields), the halftone ink field,
 *   tile-sized rasterization canvases (never artboard-sized), the two plate
 *   accumulators, band buffers, and — for proof-carrying sessions — three
 *   Float32 proof fields.
 * - APP side, CONCURRENT with the worker: the composite collector (three
 *   proof floats + one coverage field ≈ 290 MiB at 3600×5280) or the
 *   in-session proof target / plate output raster, plus, for plate
 *   packages, the encoded blobs of already-finished plates.
 * - APP side, AFTER the worker: collector finalize (+1 RGBA) and encoder
 *   staging (canvas backing + blob).
 *
 * planRender picks single-shot when its process-wide peak fits the budget
 * and otherwise the streamed form (which requires sample space === output
 * space, always true for exports); withinBudget is false only when no
 * available form fits — the hard-reject case the render service enforces
 * BEFORE allocating anything (and preflight surfaces to the user).
 *
 * Callers with real layer/output knowledge pass `layers`/`output` for the
 * settings-aware model (the production render service always does — see
 * planModelForRender in export/worker-render-service.ts); without them the
 * model falls back to the conservative fixed kernel ceiling and a
 * worker-only view, matching legacy callers.
 *
 * tests/unit/render-ledger.test.ts compares this MODEL against OBSERVED
 * retained-allocation counters (instrumentation.ts) for real streamed runs.
 *
 * EXPLICITLY PRICED: source verification/native decode peaks; 80 B per JS
 * DotPlacement plus its overlapping 24 B packed Float64 transfer; tile
 * canvas + ImageData; warp bands; and streamed encoder/ZIP/sink staging.
 * Native codec internals and GC lag cannot be observed by the realm ledger,
 * so the fixed stream envelope is conservative and the final process gate is
 * performance.measureUserAgentSpecificMemory in the browser benchmark; the
 * allocation ledger is a PER-REALM diagnostic (see instrumentation.ts).
 * Vector SVG assembly has its own package-total preflight gate and is never
 * admitted solely by this raster plan.
 */
import { RESOURCE_POLICY } from "../core/resource-policy";
import { STREAM_ENCODE_FIXED_BYTES } from "../core/stream-memory";
import { DIFFUSION_MAX_ROW_REACH } from "./kernels/diffusion";
import type { TileRect } from "./kernels/halftone-grid";
import { PLACEMENT_BYTES_PER_DOT } from "./placement-memory";

export { PLACEMENT_BYTES_PER_DOT } from "./placement-memory";
export { STREAM_ENCODE_FIXED_BYTES } from "../core/stream-memory";

export const BYTES_PER_FIELD_PIXEL = 4; // Float32
export const BYTES_PER_RGBA_PIXEL = 4; // Uint8Clamped

/**
 * Fixed kernel-transient ceiling used when no per-layer model is provided:
 * a conservative bound over every recipe (block-shifted, sorted, denoised,
 * sharpened chains included).
 */
export const PEAK_FIELDS_PER_PLATE = 6;

/** Fields accumulated per composed plate (premultiplied ink + alpha). */
export const RETAINED_FIELDS_PER_PLATE = 2;

/** Float32 fields of a streaming proof accumulator (red + green + blue). */
export const PROOF_ACCUMULATOR_FIELDS = 3;

/** App-side composite collector: proof RGB floats + composed coverage. */
export const COLLECTOR_FIELDS = 4;

/**
 * Band-height working buffers concurrently alive in a streaming session:
 * emitted ink + alpha band copies, the diffusion carry window, and the
 * per-band alpha scratch.
 */
export const STREAM_BAND_BUFFERS = 4;

/** Preview drafts sample at most this edge; parity with the studio's 1100px cap. */
export const DRAFT_MAX_SAMPLE_EDGE = 1100;

/** Default streaming band target: bounded well under the peak budget. */
export const DEFAULT_BAND_BYTES = 32 * 1024 * 1024;

/** Default tile edge for absolute-coordinate halftone tiling. */
export const DEFAULT_TILE_EDGE = 1024;

/** Tile rasterization staging: canvas backing + read-back ImageData. */
export const TILE_CANVAS_BYTES = 2 * DEFAULT_TILE_EDGE * DEFAULT_TILE_EDGE * 4;

/** Default encoded-output estimate (bytes per pixel) for retained blobs. */
export const DEFAULT_ENCODE_BYTES_PER_PIXEL = 1;

/**
 * Band-credit window for streamed-delivery sessions: the worker keeps at
 * most this many emitted-but-unacked bands in flight (protocol bandWindow),
 * so a slow sink bounds the transferred backlog to
 * window × bandHeight × width × 8 bytes (ink + alpha Float32 rows).
 */
export const STREAM_DELIVERY_BAND_WINDOW = 2;

/**
 * FIXED overhead of the streamed-delivery packager: the deflate window,
 * pending compressor output, and ZIP/writable chunk staging. The
 * band-shaped terms (RGBA conversion band, PNG filtered band) are NOT in
 * this constant — estimateStreamedSinkBytes derives them from the chosen
 * band geometry so the model equals the runtime allocation shape exactly.
 */
export type RenderJobForm = "single-shot" | "streamed";

/** Per-layer inputs to the settings-aware kernel-transient model. */
export type PlanLayerModel = {
  mode: "halftone" | "diffusion" | "clean";
  /** Worst-plate halftone grid-point estimate (packed placement pricing). */
  gridPoints?: number;
  /** Custom-dot stamp bitmap backing bytes (RGBA), when the layer has one. */
  stampBytes?: number;
  /** Any glitch op active (glitchActive of the layer's settings). */
  glitch?: boolean;
  /** Macroblock/block-shift or bitmap sort active (extra field snapshot). */
  heavyGlitch?: boolean;
  /** Frayed edges active (halftone only; one extra field copy). */
  fray?: boolean;
  /** Diffusion denoise != 0 or sharpen > 0 (blur scratch fields). */
  blurred?: boolean;
  /** Decoded source RGBA bytes; defaults to one output-sized raster. */
  sourceBytes?: number;
  /** Peak while verifying + natively decoding this source in the app realm. */
  decodePeakBytes?: number;
  /** Layer arrives as a prep descriptor (worker warps source → raster). */
  prep?: boolean;
};

/** What the app retains around the render (collector / outputs / encoding). */
export type PlanOutputModel = {
  kind: "composite" | "plate" | "layer";
  /** Composite matte: "#ffffff" ⇒ opaque proof target; else collector. */
  whiteMatte?: boolean;
  /** Encoded blobs retained until packaging (plate packages). */
  retainedEncodes?: number;
  encodeBytesPerPixel?: number;
  /**
   * TRUE STREAMING DELIVERY (wave G2): plate bands flow through a bounded
   * band-credit queue into an incremental encoder and a WritableStream —
   * the app retains NO full output raster and NO encoded blobs. The
   * app-side share becomes: the credit window of transferred band buffers
   * (STREAM_DELIVERY_BAND_WINDOW × band ink+alpha floats), one RGBA band
   * conversion, and the constant encoder/ZIP/writable staging
   * (STREAM_ENCODE_FIXED_BYTES). Only meaningful for kind "plate".
   */
  streamedSink?: boolean;
};

export type RenderPlanInput = {
  /** Sample-space dimensions the kernels run at. */
  sampleWidth: number;
  sampleHeight: number;
  /** Output/artboard dimensions. */
  outputWidth: number;
  outputHeight: number;
  plateCount: number;
  layerCount: number;
  /** Job composes a proof (paper set); adds proof accumulators to both forms. */
  wantsProof?: boolean;
  /** Settings-aware per-layer model; length may differ from layerCount
   *  (layerCount governs pass structure, layers[] the kernel window). */
  layers?: PlanLayerModel[];
  /** App-side retention model; omitted ⇒ worker-only view (legacy callers). */
  output?: PlanOutputModel;
};

export type RenderPlan = {
  tiles: TileRect[];
  tileEdge: number;
  bandHeight: number;
  /** Selected job form: single-shot when it fits the budget, else streamed. */
  form: RenderJobForm;
  /** True when the streamed form is available (sample space === output space). */
  streamable: boolean;
  /** Process-wide peak estimate of the SELECTED form. */
  estimatedPeakBytes: number;
  singleShotPeakBytes: number;
  streamedPeakBytes: number;
  /** Worker-side share of the selected form's peak (ledger comparison). */
  workerPeakBytes: number;
  /** App-side share concurrent with the worker (collector/outputs/blobs). */
  appPeakBytes: number;
  /** False only when no available form fits — hard-reject in preflight. */
  withinBudget: boolean;
  budgetBytes: number;
};

/** Draft scale for interactive scrubs; parity with `min(1, 1100 / max(w, h))`. */
export function draftScaleFor(width: number, height: number, maxEdge = DRAFT_MAX_SAMPLE_EDGE): number {
  return Math.min(1, maxEdge / Math.max(1, Math.max(width, height)));
}

/** Floor for the adaptive draft edge; drafts never drop below this. */
export const MIN_DRAFT_EDGE = 256;

/**
 * CONSTANT-WORK draft edge: the legacy engine's interactive budget was one
 * layer × four plates sampled at an 1100px edge. Deeper stacks multiply the
 * per-draft kernel passes (layers × plates), so the draft edge shrinks to
 * keep passes × area at that same budget — an 8-layer CMYK scrub drafts at
 * ~389px and still settles to the exact viewport on release. Single-layer
 * documents keep the full legacy 1100px draft.
 */
export function adaptiveDraftEdge(
  layerCount: number,
  plateCount: number,
  baseEdge = DRAFT_MAX_SAMPLE_EDGE,
): number {
  const passes = Math.max(1, layerCount) * Math.max(1, plateCount);
  return Math.max(MIN_DRAFT_EDGE, Math.round(baseEdge * Math.sqrt(Math.min(1, 4 / passes))));
}

/**
 * True when a preview-draft at the given output dims will render INTERNALLY
 * below the requested resolution (the executor's adaptive shrink) — i.e.
 * the delivered draft is an approximation even if the public draft scale
 * equals the viewport scale. The exact-viewport settle must ALWAYS be
 * scheduled when this holds; consumers use this predicate (the same policy
 * the executor applies) for that gate, and the result payload additionally
 * carries the executed `draftScaleDown` for presentation-side checks.
 */
export function previewDraftIsApproximate(
  layerCount: number,
  plateCount: number,
  outputWidth: number,
  outputHeight: number,
): boolean {
  return Math.max(outputWidth, outputHeight) > adaptiveDraftEdge(layerCount, plateCount);
}

/** Bytes for one Float32 field at the given dimensions. */
export function estimateFieldBytes(width: number, height: number): number {
  return width * height * BYTES_PER_FIELD_PIXEL;
}

/** The streamed form needs kernels to run at output resolution (exports do). */
export function isStreamable(input: RenderPlanInput): boolean {
  return input.sampleWidth === input.outputWidth && input.sampleHeight === input.outputHeight;
}

/**
 * Settings-aware concurrent kernel window (in field-equivalents) for one
 * layer, matching the instrumented allocation shape of the kernels:
 *
 * - inactive glitch is ONE field copy; an active remap holds input + output
 *   (2), and block ops / bitmap sort add one snapshot (3);
 * - fraying copies the chain output once (2 concurrent when no glitch);
 * - diffusion retains its coverage base through the preprocess, whose blur
 *   stages hold up to three fields at once (input + blur scratch + output);
 * - clean is the glitch chain alone.
 */
export function kernelTransientFields(layer: PlanLayerModel): number {
  const glitchChain = layer.glitch ? 2 + (layer.heavyGlitch ? 1 : 0) : 1;
  if (layer.mode === "clean") return glitchChain;
  if (layer.mode === "diffusion") {
    const stage = layer.blurred ? 3 : layer.glitch ? 1 + (layer.heavyGlitch ? 1 : 0) : 1;
    return 1 + stage; // base retained through preprocess + worst stage
  }
  return Math.max(glitchChain, layer.fray ? 2 : 1);
}

const DEFAULT_LAYER: PlanLayerModel = { mode: "halftone" };

function layerModels(input: RenderPlanInput): PlanLayerModel[] {
  if (input.layers && input.layers.length > 0) return input.layers;
  return [DEFAULT_LAYER];
}

/** Transient field count for a layer, honoring the legacy fixed ceiling. */
function transientFields(input: RenderPlanInput, layer: PlanLayerModel): number {
  return input.layers && input.layers.length > 0
    ? kernelTransientFields(layer)
    : PEAK_FIELDS_PER_PLATE;
}

function layerSourceBytes(input: RenderPlanInput, layer: PlanLayerModel): number {
  return layer.sourceBytes ?? input.outputWidth * input.outputHeight * BYTES_PER_RGBA_PIXEL;
}

/**
 * Streamed-delivery sink share: the band-credit window of transferred
 * ink+alpha Float32 band rows, one RGBA band conversion, and the constant
 * encoder/ZIP/writable staging. Bounded and independent of output height.
 */
export function estimateStreamedSinkBytes(input: RenderPlanInput): number {
  const bandHeight = Math.min(chooseComposeBandHeight(input), Math.max(1, input.outputHeight));
  const bandPixels = bandHeight * Math.max(1, input.outputWidth);
  const creditQueue =
    STREAM_DELIVERY_BAND_WINDOW * bandPixels * BYTES_PER_FIELD_PIXEL * RETAINED_FIELDS_PER_PLATE;
  // One RGBA conversion band plus one PNG filtered band (RGBA + one filter
  // byte per scanline) — the exact runtime staging shape of the packager.
  const rgbaBand = bandPixels * BYTES_PER_RGBA_PIXEL;
  const filteredBand = bandPixels * BYTES_PER_RGBA_PIXEL + bandHeight;
  return creditQueue + rgbaBand + filteredBand + STREAM_ENCODE_FIXED_BYTES;
}

/** App-side bytes retained CONCURRENTLY with the render (see PlanOutputModel). */
export function estimateAppConcurrentBytes(input: RenderPlanInput): number {
  const output = input.output;
  if (!output) return 0;
  const field = estimateFieldBytes(input.outputWidth, input.outputHeight);
  const raster = input.outputWidth * input.outputHeight * BYTES_PER_RGBA_PIXEL;
  const blobs =
    (output.retainedEncodes ?? 0) *
    input.outputWidth *
    input.outputHeight *
    (output.encodeBytesPerPixel ?? DEFAULT_ENCODE_BYTES_PER_PIXEL);
  if (output.kind === "plate") {
    // True streaming: no full plate raster, no retained encodes — only the
    // bounded credit queue and packager staging (see PlanOutputModel).
    if (output.streamedSink) return estimateStreamedSinkBytes(input);
    return raster + blobs;
  }
  return (output.whiteMatte ? raster : COLLECTOR_FIELDS * field) + blobs;
}

/** App-side peak AFTER the worker: collector finalize and encoder staging. */
export function estimateAppFinalizeBytes(input: RenderPlanInput): number {
  const output = input.output;
  if (!output) return 0;
  if (output.kind === "plate" && output.streamedSink) {
    // Streamed delivery has no finalize spike: encode/package staging is
    // the same bounded sink share that ran concurrently with the render.
    return estimateStreamedSinkBytes(input);
  }
  const field = estimateFieldBytes(input.outputWidth, input.outputHeight);
  const raster = input.outputWidth * input.outputHeight * BYTES_PER_RGBA_PIXEL;
  const blobBytes =
    input.outputWidth * input.outputHeight * (output.encodeBytesPerPixel ?? DEFAULT_ENCODE_BYTES_PER_PIXEL);
  const retained = (output.retainedEncodes ?? 0) * blobBytes;
  const collectorFinalize =
    output.kind !== "plate" && !output.whiteMatte ? COLLECTOR_FIELDS * field + raster : raster;
  // Encoding: output raster + canvas backing + the encoded blob.
  const encode = raster + raster + blobBytes;
  return Math.max(collectorFinalize, encode) + retained;
}

/**
 * Process-wide peak of the single-shot executor: every layer's warped
 * raster and alpha field resident at once, the worst layer's source during
 * its warp, the kernel window, per-plate layer ink/alpha fields coexisting
 * until composePlate, every composed plate retained, the proof working set
 * when proofing, tile canvases, and the app-side concurrent retention.
 */
export function estimateSingleShotPeakBytes(input: RenderPlanInput): number {
  const sampleField = estimateFieldBytes(input.sampleWidth, input.sampleHeight);
  const outputField = estimateFieldBytes(input.outputWidth, input.outputHeight);
  const layers = Math.max(1, input.layerCount);
  const plates = Math.max(1, input.plateCount);
  const models = layerModels(input);
  const rasters = layers * input.sampleWidth * input.sampleHeight * BYTES_PER_RGBA_PIXEL;
  // SINGLE-SHOT PRE-SUBMIT PEAK: every layer's decoded source is built and
  // retained until the one submit transfers them together, so the honest
  // term is the SUM of prep sources — not the worst one (wave G2 audit).
  const prepSourceExtra = input.layers
    ? models.reduce(
        (total, layer) =>
          total + (layer.prep ? layerSourceBytes(input, layer) : 0) + (layer.stampBytes ?? 0),
        0,
      ) +
      Math.max(
        0,
        ...models.map((layer) =>
          Math.max(0, (layer.decodePeakBytes ?? layerSourceBytes(input, layer)) - layerSourceBytes(input, layer)),
        ),
      )
    : 0;
  const alphas = layers * sampleField;
  const kernelTransient =
    sampleField * Math.max(...models.map((layer) => transientFields(input, layer))) +
    // Worst layer's packed dot placements, resident while its tiles paint.
    Math.max(...models.map((layer) => (layer.gridPoints ?? 0) * PLACEMENT_BYTES_PER_DOT));
  const plateLayerFields = layers * RETAINED_FIELDS_PER_PLATE * outputField;
  const composedPlates = plates * RETAINED_FIELDS_PER_PLATE * outputField;
  const proof = input.wantsProof
    ? PROOF_ACCUMULATOR_FIELDS * outputField + input.outputWidth * input.outputHeight * BYTES_PER_RGBA_PIXEL
    : 0;
  const tileCanvas = models.some((layer) => layer.mode === "halftone") ? TILE_CANVAS_BYTES : 0;
  return (
    rasters +
    prepSourceExtra +
    alphas +
    kernelTransient +
    plateLayerFields +
    composedPlates +
    proof +
    tileCanvas +
    estimateAppConcurrentBytes(input)
  );
}

/**
 * Process-wide peak of the streaming session: the worst single layer's
 * working set (source + warped during its banded warp, or warped + kernel
 * window), the current plate's two accumulators, band buffers, tile
 * canvases, the proof accumulators when the session carries the proof, and
 * the app-side collector/output retention running concurrently. Independent
 * of layerCount and plateCount.
 */
export function estimateStreamedPeakBytes(input: RenderPlanInput, bandHeight?: number): number {
  const outputField = estimateFieldBytes(input.outputWidth, input.outputHeight);
  const outputRaster = input.outputWidth * input.outputHeight * BYTES_PER_RGBA_PIXEL;
  const band = Math.max(1, bandHeight ?? chooseComposeBandHeight(input));
  const bandRowBytes = input.outputWidth * BYTES_PER_FIELD_PIXEL;
  // Four band-shaped buffers plus the diffusion window's fixed carry rows.
  // The carry is material for legal extreme-aspect jobs whose selected band
  // height is one row, so it cannot be rounded into the band multiplier.
  const bandBuffers =
    (STREAM_BAND_BUFFERS * band + DIFFUSION_MAX_ROW_REACH) * bandRowBytes;
  const proof = input.wantsProof ? PROOF_ACCUMULATOR_FIELDS * outputField : 0;
  const models = layerModels(input);
  const worstLayer = Math.max(
    ...models.map((layer) => {
      const source = layerSourceBytes(input, layer);
      const decodePeak = layer.decodePeakBytes ?? source;
      const retainedRaster = layer.prep ? outputRaster : source;
      const warpPeak = layer.prep ? source + outputRaster : source;
      // Packed dot placements are retained alongside the ink field while
      // tiles rasterize (the JS-object collection transient is capped by
      // the grid-point admission gates and documented above); the layer's
      // custom stamp bitmap is resident through its pass too.
      const placements = (layer.gridPoints ?? 0) * PLACEMENT_BYTES_PER_DOT;
      const kernelPeak =
        retainedRaster +
        transientFields(input, layer) * outputField +
        placements +
        (layer.stampBytes ?? 0);
      return Math.max(decodePeak, warpPeak, kernelPeak);
    }),
  );
  const tileCanvas = models.some((layer) => layer.mode === "halftone") ? TILE_CANVAS_BYTES : 0;
  return (
    worstLayer +
    RETAINED_FIELDS_PER_PLATE * outputField +
    bandBuffers +
    proof +
    tileCanvas +
    estimateAppConcurrentBytes(input)
  );
}

/**
 * Peak of the cheapest form able to run the job — the feasibility number to
 * compare against the budget. Per-form estimates: estimateSingleShotPeakBytes
 * / estimateStreamedPeakBytes; the selected form comes from planRender.
 */
export function estimateRenderPeakBytes(input: RenderPlanInput, bandHeight?: number): number {
  const singleShot = estimateSingleShotPeakBytes(input);
  return isStreamable(input)
    ? Math.min(singleShot, estimateStreamedPeakBytes(input, bandHeight))
    : singleShot;
}

/**
 * Band height (rows) for streamed diffusion so the emitted band plus the
 * carry window stays under `bandBytes`.
 */
export function chooseBandHeight(width: number, bandBytes = DEFAULT_BAND_BYTES): number {
  const rowBytes = Math.max(1, width) * BYTES_PER_FIELD_PIXEL;
  return Math.max(1, Math.floor(bandBytes / rowBytes) - 2);
}

/**
 * Band height for the compose/proof accumulators so ink + alpha bands across
 * every plate together stay under `bandBytes`.
 */
export function chooseComposeBandHeight(input: RenderPlanInput, bandBytes = DEFAULT_BAND_BYTES): number {
  const rowBytes =
    Math.max(1, input.outputWidth) * BYTES_PER_FIELD_PIXEL * RETAINED_FIELDS_PER_PLATE * Math.max(1, input.plateCount);
  return Math.max(1, Math.floor(bandBytes / rowBytes));
}

/** Row-major tiles exactly covering [x0, x0+width) × [y0, y0+height). */
export function chunkTiles(
  width: number,
  height: number,
  tileEdge: number,
  x0 = 0,
  y0 = 0,
): TileRect[] {
  const edge = Math.max(1, Math.floor(tileEdge));
  const tiles: TileRect[] = [];
  for (let y = y0; y < y0 + height; y += edge) {
    for (let x = x0; x < x0 + width; x += edge) {
      tiles.push({
        x,
        y,
        width: Math.min(edge, x0 + width - x),
        height: Math.min(edge, y0 + height - y),
      });
    }
  }
  return tiles;
}

/**
 * Plan a render: pick tile and band sizes, model both job forms process-wide,
 * select the form (single-shot whenever it fits; otherwise streamed), and
 * check the selected peak against the resource policy. Callers reduce draft
 * scale (draftScaleFor) or refuse the job when `withinBudget` is false —
 * nothing else can run it either. `budget` defaults to the resource policy
 * and is overridable so preflight/tests can plan against a caller-supplied
 * policy.
 */
export function planRender(
  input: RenderPlanInput,
  budget: number = RESOURCE_POLICY.maxRenderPeakBytes,
): RenderPlan {
  // One band height drives streamed diffusion, compose accumulation, and
  // band emission; never taller than the image itself.
  const bandHeight = Math.max(
    1,
    Math.min(chooseBandHeight(input.sampleWidth), chooseComposeBandHeight(input), input.outputHeight),
  );
  const streamable = isStreamable(input);
  const singleShotPeakBytes = estimateSingleShotPeakBytes(input);
  const streamedPeakBytes = estimateStreamedPeakBytes(input, bandHeight);
  const appPeakBytes = estimateAppConcurrentBytes(input);
  const budgetBytes = budget;
  const form: RenderJobForm =
    singleShotPeakBytes <= budgetBytes || !streamable ? "single-shot" : "streamed";
  const estimatedPeakBytes = form === "streamed" ? streamedPeakBytes : singleShotPeakBytes;
  const finalizeBytes = estimateAppFinalizeBytes(input);
  return {
    tiles: chunkTiles(input.outputWidth, input.outputHeight, DEFAULT_TILE_EDGE),
    tileEdge: DEFAULT_TILE_EDGE,
    bandHeight,
    form,
    streamable,
    estimatedPeakBytes: Math.max(estimatedPeakBytes, finalizeBytes),
    singleShotPeakBytes,
    streamedPeakBytes,
    workerPeakBytes: estimatedPeakBytes - appPeakBytes,
    appPeakBytes,
    withinBudget: Math.max(estimatedPeakBytes, finalizeBytes) <= budgetBytes,
    budgetBytes,
  };
}
