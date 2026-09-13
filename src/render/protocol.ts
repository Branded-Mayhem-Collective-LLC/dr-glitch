/**
 * Render worker protocol — message and payload types shared by the preview
 * worker, the export worker, and the main-thread fallback renderer. Types
 * only; no implementation dependencies.
 *
 * Revision discipline: every job carries a monotonic revision issued by the
 * consumer. Preview jobs are replaceable — a newer preview revision
 * supersedes any in-flight one, and stale results are discarded (bitmaps
 * closed) rather than delivered. Export jobs freeze their inputs at submit
 * time (buffers are transferred, so the worker owns an immutable copy) and
 * end only on completion, explicit cancel, or error.
 *
 * Crash replacement: workers keep no state a consumer cannot rebuild. If a
 * worker dies (error event / no heartbeat), the consumer terminates it,
 * constructs a fresh Worker, and resubmits the latest revision.
 *
 * Streaming export sessions: a single-shot export job transfers every layer
 * raster at once and retains full-resolution composed plates — fine for
 * previews and small exports, unaffordable for full sheets (see planner.ts).
 * When planRender selects the "streamed" form the consumer opens a session
 * instead: begin-export freezes the geometry/plates/revision, then layers
 * stream ONE AT A TIME — one pass per plate, bottom-to-top within the pass,
 * each submit-layer acknowledged (layer-ack) before the next is sent. The
 * worker composes each layer into band-bounded per-plate accumulators and,
 * when a pass completes, emits the composed plate band-by-band (plate-band /
 * plate-complete) so it never holds more than one plate's accumulators.
 * finalize-export emits the proof band-by-band (when paper was given) and a
 * final result event. Cancel(revision) aborts at band/layer granularity,
 * releases every session buffer, and emits cancelled — never a partial
 * result; the consumer discards any bands it already received.
 */
import type { DotShape } from "../core/types";
import type { RenderPlateId, RenderSettings } from "./settings";
import type { TileRect } from "./kernels/halftone-grid";

export type Revision = number;

export type RenderJobKind = "preview-draft" | "exact-viewport" | "export";

/** Transferable raster: RGBA bytes + dimensions. Buffer ownership transfers with the message. */
export type RasterTransfer = {
  buffer: ArrayBuffer;
  width: number;
  height: number;
};

/** Transferable Float32 field + dimensions. */
export type FieldTransfer = {
  buffer: ArrayBuffer;
  width: number;
  height: number;
};

/**
 * Off-main-thread layer preparation descriptor: the DECODED source raster
 * plus a pre-validated crop window and a Float64 homography (row-major 9
 * numbers) mapping CROPPED-source pixel space into output space. The worker
 * performs crop + banded warp itself (src/render/prep.ts), so the main
 * thread never allocates an artboard-sized layer raster. Build with
 * export/layer-prep.ts buildLayerPrep — the crop must already satisfy
 * isValidCrop and the homography must be layerOutputHomography's output,
 * which keeps worker output bit-identical to prepareLayerRaster.
 */
export type LayerPrepTransfer = {
  source: RasterTransfer;
  crop: { x: number; y: number; width: number; height: number } | null;
  homography: number[];
};

/**
 * One layer's render input, in one of two forms:
 * - `raster`: already resampled into the job's sample space
 *   (crop/transform/perspective happened upstream — the legacy main-thread
 *   prep path, still used by consumers that cache warped rasters);
 * - `prep`: source + crop + homography; the WORKER crops and warps
 *   (banded, cancellable) before running kernels. Exactly one must be set.
 * The kernels themselves are content-agnostic so screen lattices stay
 * anchored to the artboard regardless of layer motion.
 */
export type RenderLayerInput = {
  raster?: RasterTransfer;
  prep?: LayerPrepTransfer;
  /**
   * Flatten the resolved raster onto white before separation (legacy
   * single-layer parity for vector plates, where transparency must never
   * become ink). Applied in the worker, after crop/warp, before kernels.
   */
  flattenWhite?: boolean;
  /**
   * Content fingerprint for the DRAFT layer-field cache: for
   * "preview-draft" jobs the executor replays this layer's per-plate
   * ink/alpha from its port-local cache when the key matches, so a scrub
   * recomputes only the edited layer. The key must change whenever the
   * layer's pixels, prep geometry, recipe, or the document separation
   * change. Exact-viewport and export jobs ignore it entirely.
   */
  cacheKey?: string;
  settings: RenderSettings;
  /** Layer opacity 0..1; applied exactly once, at plate composition. */
  opacity: number;
  dotShape: DotShape;
  strokeWidth: number;
  /**
   * Pre-rasterized custom dot stamp (transferable), required when
   * dotShape === "custom"; workers cannot prepare SVG stamps themselves.
   */
  customStamp?: ImageBitmap;
};

export type RenderJobRequest = {
  type: "job";
  kind: RenderJobKind;
  revision: Revision;
  /** Output (artboard-space) dimensions in px. */
  outputWidth: number;
  outputHeight: number;
  /** Document render scale (output px per document px); sizes cells and strokes. */
  renderScale: number;
  /** Minimum effective cell size in output px (preview vs export policy). */
  minimumCellSize: number;
  /** Plates to compute; the consumer expands "composite" to the visible set. */
  plates: RenderPlateId[];
  /** Bottom-to-top layer stack. */
  layers: RenderLayerInput[];
  /** Restrict grid/proof output to this absolute artboard rectangle. */
  tile?: TileRect;
  /**
   * Tile schedule (plan.tiles from planRender) for halftone dot
   * rasterization: dots paint onto tile-sized canvases at absolute artboard
   * coordinates instead of one artboard-sized canvas, bounding canvas
   * memory and giving cancellation tile granularity. Omitted ⇒ the executor
   * chunks DEFAULT_TILE_EDGE tiles itself. Output bytes are DETERMINISTIC
   * PER SCHEDULE and every production path shares the canonical planner
   * schedule; against a single whole-image canvas, real canvas AA differs
   * within a small measured bound (see the executor's TILING CONTRACT and
   * the browser benchmark).
   */
  tiles?: TileRect[];
  /** Proof paper color; omitted means no proof compositing. */
  paper?: readonly [number, number, number];
  /** Prefer an ImageBitmap result when the environment supports it. */
  wantBitmap: boolean;
  /**
   * Force the raw kernel-output payload ("layer-data": fields, packed dot
   * placements, alpha) even where OffscreenCanvas could compose. Used for
   * vector plate generation, where the CONSUMER formats marks and the
   * numeric work (coverage, glitch, diffusion, grid walk) must still run
   * off the main thread.
   */
  payloadForm?: "layer-data";
};

export type RenderCancelRequest = {
  type: "cancel";
  /** Cancel this revision; preview workers also auto-supersede older revisions. */
  revision: Revision;
};

/** Release every cached resource and acknowledge with DisposedEvent. */
export type RenderDisposeRequest = { type: "dispose" };

/* ------------------------------------------------------------------ */
/* Streaming export sessions                                           */
/* ------------------------------------------------------------------ */

/**
 * Open a streaming export session (export workers and MainThreadRenderer
 * only; one session at a time, no queued/running single-shot jobs). The
 * session runs one PASS per entry of `plates`, in order; each pass receives
 * exactly `layerCount` submit-layer messages, bottom-to-top. The worker
 * answers with ExportReadyEvent, or an error event when validation fails.
 */
export type RenderExportBeginRequest = {
  type: "begin-export";
  /** Frozen project revision; every session message must carry it. */
  revision: Revision;
  /** Output (artboard-space) dimensions in px. Streamed layers must arrive
   *  at exactly these dimensions — export samples at full resolution. */
  outputWidth: number;
  outputHeight: number;
  renderScale: number;
  minimumCellSize: number;
  /**
   * Pass order. Must be a unique subset of PLATE_SEQUENCE; when `paper` is
   * set it must additionally be in press order (a PLATE_SEQUENCE
   * subsequence) so proof accumulation multiplies in the exact float order
   * of proofCompositeCmyk.
   */
  plates: RenderPlateId[];
  /** Layers per pass; every pass streams exactly this many. */
  layerCount: number;
  /** Compose/emission band height in rows (planRender().bandHeight). */
  bandHeight: number;
  /** Present ⇒ the session accumulates and emits a proof. Only when the
   *  planner approved the proof-carrying streamed form. */
  paper?: readonly [number, number, number];
  /** Tile schedule for halftone rasterization; see RenderJobRequest.tiles. */
  tiles?: TileRect[];
  /**
   * False ⇒ the session never slices or transfers plate bands (proof-only
   * composite: the consumer folds nothing, so emitting composed plate rows
   * would be pure churn — two full fields per plate of slicing/transfer).
   * plate-complete events still fire; the proof path is unchanged and
   * byte-identical. Default true.
   */
  emitPlateBands?: boolean;
  /**
   * BAND-CREDIT BACKPRESSURE (wave G2, streamed-delivery sessions). When
   * set, the session keeps at most this many emitted-but-unacknowledged
   * bands (plate AND proof) in flight: before emitting the next band it
   * waits for a band-ack, so a slow consumer (FSA writable, ZIP deflate)
   * bounds the message-queue backlog to `bandWindow` transferred band
   * buffers instead of a whole plate. The wait is cancellation-aware —
   * cancel/dispose wakes it immediately and the session aborts at that
   * checkpoint. OMITTED ⇒ credits are granted eagerly (no waiting) — the
   * in-memory consumers' current behavior and throughput, byte-identical.
   */
  bandWindow?: number;
};

/** One layer of the current pass. The raster buffer transfers with the message. */
export type RenderExportLayerRequest = {
  type: "submit-layer";
  revision: Revision;
  /** Current pass plate; must equal the session's expected plate. */
  plate: RenderPlateId;
  /** Strictly sequential within the pass: 0 .. layerCount - 1. */
  layerIndex: number;
  layer: RenderLayerInput;
};

/** All passes complete: emit proof bands (when paper) and the final result. */
export type RenderExportFinalizeRequest = {
  type: "finalize-export";
  revision: Revision;
};

/**
 * Return one band credit to a windowed session (RenderExportBeginRequest
 * `bandWindow`): the consumer's sink accepted one plate-band/proof-band, so
 * the session may emit the next. Ignored by sessions without a window and
 * by stale revisions; never required for eager (windowless) sessions.
 */
export type RenderExportBandAckRequest = {
  type: "band-ack";
  revision: Revision;
};

export type RenderWorkerRequest =
  | RenderJobRequest
  | RenderCancelRequest
  | RenderDisposeRequest
  | RenderExportBeginRequest
  | RenderExportLayerRequest
  | RenderExportFinalizeRequest
  | RenderExportBandAckRequest;

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** Per-layer, per-plate kernel output for consumers that composite themselves. */
export type LayerPlateData = {
  plate: RenderPlateId;
  layerIndex: number;
  mode: "halftone" | "diffusion" | "clean";
  /** Coverage, diffusion, or clean-ink field in sample space. */
  field: FieldTransfer;
  /** Halftone mode: packed [x, y, size] triplets in output space. */
  placements?: { buffer: ArrayBuffer; count: number };
  /** Source alpha field in sample space (never white-matted). */
  alpha: FieldTransfer;
};

export type ComposedPlateData = {
  plate: RenderPlateId;
  inkPremultiplied: FieldTransfer;
  alpha: FieldTransfer;
};

export type RenderResultPayload =
  /** Fully composed proof as a transferable ImageBitmap (OffscreenCanvas path).
   *  `draftScaleDown` < 1 marks an adaptive preview-draft that rendered
   *  internally below the requested resolution (upscaled for delivery); the
   *  consumer MUST still schedule the exact-viewport settle then, even when
   *  the public draft scale equals the viewport scale. */
  | { form: "bitmap"; bitmap: ImageBitmap; width: number; height: number; draftScaleDown?: number }
  /** Composed plates + optional proof raster (no ImageBitmap support). */
  | { form: "plates"; width: number; height: number; plates: ComposedPlateData[]; proof?: RasterTransfer; draftScaleDown?: number }
  /** Reduced path: raw kernel outputs; the consumer's canvas draws/composites. */
  | { form: "layer-data"; width: number; height: number; layers: LayerPlateData[] }
  /** Streaming session summary; the data already streamed via plate-band/proof-band. */
  | { form: "streamed"; width: number; height: number; plates: RenderPlateId[] };

export type RenderProgressPhase =
  | "coverage"
  | "glitch"
  | "diffusion"
  | "grid"
  | "compose"
  | "proof"
  | "encode";

export type RenderProgressEvent = {
  type: "progress";
  revision: Revision;
  phase: RenderProgressPhase;
  plate?: RenderPlateId;
  /** Monotonic 0..1 within the job. */
  ratio: number;
};

export type RenderResultEvent = {
  type: "result";
  revision: Revision;
  kind: RenderJobKind;
  payload: RenderResultPayload;
};

export type RenderErrorEvent = {
  type: "error";
  revision: Revision | null;
  /** Stable machine code, e.g. "custom-stamp-missing", "job-failed". */
  code: string;
  message: string;
};

export type RenderCancelledEvent = { type: "cancelled"; revision: Revision };

export type RenderDisposedEvent = { type: "disposed" };

/** The session accepted begin-export; the first submit-layer may be sent. */
export type RenderExportReadyEvent = { type: "export-ready"; revision: Revision };

/**
 * The submitted layer is fully composed and its buffers released; the
 * consumer must wait for this before transferring the next layer.
 */
export type RenderExportLayerAckEvent = {
  type: "layer-ack";
  revision: Revision;
  plate: RenderPlateId;
  layerIndex: number;
};

/** One band of a finished composed plate. Buffers transfer with the event. */
export type RenderExportPlateBandEvent = {
  type: "plate-band";
  revision: Revision;
  plate: RenderPlateId;
  /** Absolute output-space row of the band's first row. */
  rowStart: number;
  rowCount: number;
  /** Premultiplied ink rows (rowCount × outputWidth Float32). */
  inkPremultiplied: FieldTransfer;
  /** Composited coverage rows (rowCount × outputWidth Float32). */
  alpha: FieldTransfer;
};

/** Every band of this plate has been emitted; its accumulators are freed. */
export type RenderExportPlateCompleteEvent = {
  type: "plate-complete";
  revision: Revision;
  plate: RenderPlateId;
};

/** One band of the finished proof (RGBA bytes; buffer transfers with the event). */
export type RenderExportProofBandEvent = {
  type: "proof-band";
  revision: Revision;
  rowStart: number;
  rowCount: number;
  rgba: RasterTransfer;
};

export type RenderWorkerEvent =
  | RenderProgressEvent
  | RenderResultEvent
  | RenderErrorEvent
  | RenderCancelledEvent
  | RenderDisposedEvent
  | RenderExportReadyEvent
  | RenderExportLayerAckEvent
  | RenderExportPlateBandEvent
  | RenderExportPlateCompleteEvent
  | RenderExportProofBandEvent;

/* ------------------------------------------------------------------ */
/* Transfer helpers and port interface                                 */
/* ------------------------------------------------------------------ */

/** Transferables of one layer input (raster or prep source, plus stamp). */
export function layerTransferables(layer: RenderLayerInput): Transferable[] {
  const transferables: Transferable[] = [];
  if (layer.raster) transferables.push(layer.raster.buffer);
  if (layer.prep) transferables.push(layer.prep.source.buffer);
  if (layer.customStamp) transferables.push(layer.customStamp);
  return transferables;
}

/** Transferables to pass alongside a job request (rasters + stamps). */
export function jobTransferables(job: RenderJobRequest): Transferable[] {
  const transferables: Transferable[] = [];
  for (const layer of job.layers) transferables.push(...layerTransferables(layer));
  return transferables;
}

/** Transferables to pass alongside a submit-layer request (raster + stamp). */
export function exportLayerTransferables(request: RenderExportLayerRequest): Transferable[] {
  return layerTransferables(request.layer);
}

/** Transferables inside a result payload (buffers + bitmaps). */
export function payloadTransferables(payload: RenderResultPayload): Transferable[] {
  if (payload.form === "bitmap") return [payload.bitmap];
  if (payload.form === "streamed") return [];
  if (payload.form === "plates") {
    const transferables: Transferable[] = [];
    for (const plate of payload.plates) {
      transferables.push(plate.inkPremultiplied.buffer, plate.alpha.buffer);
    }
    if (payload.proof) transferables.push(payload.proof.buffer);
    return transferables;
  }
  const transferables: Transferable[] = [];
  for (const layer of payload.layers) {
    transferables.push(layer.field.buffer, layer.alpha.buffer);
    if (layer.placements) transferables.push(layer.placements.buffer);
  }
  return transferables;
}

/** Discard a stale result, closing bitmaps so GPU memory frees promptly. */
export function discardPayload(payload: RenderResultPayload): void {
  if (payload.form === "bitmap") payload.bitmap.close();
}

/**
 * The interface both worker clients and the main-thread fallback implement.
 * Consumers depend on this, never on Worker directly, so environments
 * without module workers degrade transparently.
 */
export interface RenderPort {
  submit(job: RenderJobRequest): void;
  cancel(revision: Revision): void;
  dispose(): void;
  /** Subscribe to events; returns an unsubscribe function. */
  onEvent(listener: (event: RenderWorkerEvent) => void): () => void;
}

/**
 * A RenderPort that also runs streaming export sessions. MainThreadRenderer
 * implements this directly; worker consumers get the same contract by
 * postMessage-ing the request objects (with exportLayerTransferables for
 * submit-layer) to an export worker.
 */
export interface StreamingRenderPort extends RenderPort {
  beginExport(request: RenderExportBeginRequest): void;
  submitLayer(request: RenderExportLayerRequest): void;
  finalizeExport(request: RenderExportFinalizeRequest): void;
  /** Return one band credit to a windowed session (see bandWindow). */
  ackBand(request: RenderExportBandAckRequest): void;
}
