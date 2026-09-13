/**
 * Streaming export session — the bounded-memory export path selected by
 * planRender's "streamed" form. Shared by the export worker harness and
 * MainThreadRenderer so both stay in exact behavioral agreement.
 *
 * DESIGN (plate-pass streaming): the session runs one PASS per plate; within
 * a pass, layers arrive ONE AT A TIME (submit-layer, acked before the next
 * is sent) and fold into exactly two full-resolution Float32 accumulators —
 * premultiplied ink and composited alpha for the CURRENT plate only. Because
 * Porter-Duff source-over is a per-pixel recurrence over the bottom-to-top
 * stack, folding layers as they arrive (accumulateLayerBand) is op-for-op
 * identical to composePlate over the whole stack. When a pass completes the
 * composed plate is emitted band-by-band as transferables, optionally folded
 * into the Float32 proof accumulators (press order ⇒ float-op order matches
 * proofCompositeCmyk), and the accumulators are released before the next
 * pass allocates.
 *
 * MEMORY SHAPE (why this form is bounded): layers arrive as prep
 * descriptors (source + crop + homography) or pre-warped rasters; a
 * descriptor's source is resident only during the banded worker-side warp
 * and is dropped the moment the warped raster exists. Resident at the worst
 * moment is the two plate accumulators, one layer's warped raster, and the
 * settings-dependent kernel window (see planner.ts kernelTransientFields —
 * an inactive glitch is ONE field copy, not a fixed six-field ceiling).
 * Halftone ink rasterizes TILE BY TILE (job tile schedule, absolute artboard
 * coordinates) into one ink field — never onto an artboard-sized canvas.
 * Composed plates are NEVER all resident: each is emitted and freed before
 * the next pass allocates. Diffusion runs ONCE per (layer, plate) through
 * the banded scan, carrying only the 2-row error window. Layer alpha is
 * extracted per band directly from the retained layer raster, so no
 * full-resolution alpha field exists. A layer-sequential design (all-plate
 * accumulators, each layer sent once) was rejected: 4 plates × 2 accumulator
 * fields = 8 full fields resident THROUGH the kernel transient, which can
 * never fit maxRenderPeakBytes at full-sheet size; plate passes trade
 * re-transferring sources (plateCount×) for a working set that fits.
 *
 * PARITY CONTRACT: streamed output (plate bands, proof bands) is
 * bit-identical to executeRenderJob's single-shot "plates" payload for every
 * band height; tests/unit/render-streaming-*.test.ts enforce it.
 *
 * CANCELLATION: observable DURING every heavy phase, not just at layer
 * boundaries — warp bands, coverage/glitch/preprocess chunks, bitmap-sort
 * line chunks, grid-collection chunks, rasterization tiles, diffusion scan
 * bands, and emission bands all run through checkpoints that poll the hook
 * and yield a real macrotask so a busy worker still receives the cancel
 * message. Abort releases all session buffers (including a mid-layer custom
 * stamp), emits exactly one cancelled event, and never emits a result — the
 * consumer discards any bands it already received.
 */
import {
  accumulateLayerBand,
  createProofAccumulator,
  foldPlateIntoProof,
  quantizeProofRows,
  releaseProofAccumulator,
  type ComposedPlate,
  type ProofAccumulator,
} from "./compose";
import {
  jobTiles,
  layerPlateVisible,
  rasterizePlacementsTiled,
  RenderJobError,
  resolveLayerInputRaster,
  supportsOffscreenCanvas,
} from "./executor";
import {
  buildCleanFieldCoop,
  buildCoverageBaseCoop,
  buildCoverageFieldCoop,
  visibleContentBounds,
} from "./kernels/coverage";
import {
  preprocessDiffusionFieldCoop,
  processBandedDiffusionCoop,
} from "./kernels/diffusion";
import {
  collectGridDotsCoop,
  effectiveCellSize,
  type GridGeometry,
  type TileRect,
} from "./kernels/halftone-grid";
import {
  allocField,
  noteRasterRelease,
  releaseField,
  type Checkpoint,
} from "./instrumentation";
import type {
  RenderExportBeginRequest,
  RenderExportFinalizeRequest,
  RenderExportLayerRequest,
  RenderLayerInput,
  RenderProgressPhase,
  RenderWorkerEvent,
  Revision,
} from "./protocol";
import { clamp, type RasterData } from "./raster";
import { plateChannelIndex, PLATE_SEQUENCE, type RenderPlateId } from "./settings";

export type StreamingSessionHooks = {
  /** Polled at layer/band boundaries; true aborts with a cancelled event. */
  isCancelled: () => boolean;
  emit: (event: RenderWorkerEvent, transfer?: Transferable[]) => void;
  /** Awaited between bands of compose/emission work. */
  yieldPoint: () => void | Promise<void>;
  /** Called exactly once when the session ends for any reason after start(). */
  onEnd: () => void;
};

/** Internal control-flow sentinel thrown at cancellation checkpoints. */
const SESSION_ABORT = Symbol("streaming-export-abort");

export class StreamingExportSession {
  private readonly config: RenderExportBeginRequest;
  private readonly hooks: StreamingSessionHooks;
  private readonly bandHeight: number;
  private readonly checkpoint: Checkpoint;
  private accumulator: ComposedPlate | null = null;
  private proof: ProofAccumulator | null = null;
  private alphaScratch: Float32Array | null = null;
  private passIndex = 0;
  private nextLayerIndex = 0;
  private lastRatio = 0;
  private busy = false;
  private ended = false;
  /** Emitted-but-unacked bands (only meaningful with config.bandWindow). */
  private outstandingBands = 0;
  /** Pending credit wait; woken by ackBand, requestCancel, and destroy. */
  private creditWaiter: (() => void) | null = null;

  constructor(config: RenderExportBeginRequest, hooks: StreamingSessionHooks) {
    this.config = config;
    this.hooks = hooks;
    this.bandHeight = Math.max(1, Math.floor(config.bandHeight));
    this.checkpoint = async () => {
      if (this.hooks.isCancelled()) throw SESSION_ABORT;
      await this.hooks.yieldPoint();
    };
  }

  get revision(): Revision {
    return this.config.revision;
  }

  /**
   * Validate the configuration, allocate proof accumulators, and emit
   * export-ready. Returns false (after an error event) when begin fails;
   * the caller must not treat the session as active then.
   */
  start(): boolean {
    const { config } = this;
    const failStart = (code: string, message: string): false => {
      this.hooks.emit({ type: "error", revision: config.revision, code, message });
      this.ended = true;
      return false;
    };
    if (!Number.isInteger(config.outputWidth) || config.outputWidth < 1 ||
        !Number.isInteger(config.outputHeight) || config.outputHeight < 1) {
      return failStart("export-geometry-invalid", "Streaming export needs positive integer output dimensions.");
    }
    if (!Number.isInteger(config.layerCount) || config.layerCount < 1) {
      return failStart("export-layer-count-invalid", "Streaming export needs at least one layer per pass.");
    }
    if (config.plates.length === 0) {
      return failStart("export-plates-empty", "Streaming export needs at least one plate pass.");
    }
    const sequenceIndices = config.plates.map((plate) => PLATE_SEQUENCE.indexOf(plate));
    if (sequenceIndices.some((index) => index < 0) || new Set(config.plates).size !== config.plates.length) {
      return failStart("export-plates-invalid", "Streaming export plates must be a unique subset of the press sequence.");
    }
    if (config.paper && sequenceIndices.some((index, position) => position > 0 && index <= sequenceIndices[position - 1])) {
      return failStart(
        "export-plates-order",
        "Proof-carrying sessions must pass plates in press order so proof floats multiply in proofCompositeCmyk's order.",
      );
    }
    if (config.bandWindow !== undefined &&
        (!Number.isInteger(config.bandWindow) || config.bandWindow < 1)) {
      return failStart("export-band-window-invalid", "Streaming export bandWindow must be a positive integer when set.");
    }
    if (config.paper) {
      this.proof = createProofAccumulator(config.outputWidth, config.outputHeight, config.paper);
    }
    this.hooks.emit({ type: "export-ready", revision: config.revision });
    return true;
  }

  /** Route a session request; callers serialize invocations. */
  async handle(request: RenderExportLayerRequest | RenderExportFinalizeRequest): Promise<void> {
    if (request.type === "submit-layer") return this.submitLayer(request);
    return this.finalize(request);
  }

  /** Abort promptly when idle; a busy session aborts at its next checkpoint. */
  requestCancel(): void {
    // Wake a blocked band-credit wait so the cancellation checkpoint runs
    // immediately instead of after a sink that may never accept again.
    this.wakeCreditWaiter();
    if (!this.busy) this.cancelNow();
  }

  /** Dispose path: release everything without emitting session events. */
  destroy(): void {
    this.wakeCreditWaiter();
    this.release();
    this.ended = true;
  }

  /**
   * One band credit returned by the consumer's sink (band-ack). No-op for
   * eager (windowless) sessions beyond bookkeeping; wakes a blocked emit.
   */
  ackBand(): void {
    if (this.outstandingBands > 0) this.outstandingBands -= 1;
    this.wakeCreditWaiter();
  }

  private wakeCreditWaiter(): void {
    const waiter = this.creditWaiter;
    this.creditWaiter = null;
    waiter?.();
  }

  /**
   * Windowed sessions wait here before emitting a band: at most bandWindow
   * emitted-and-unacked bands exist at any moment, so a slow sink bounds
   * the transferred backlog. Cancellation-aware — requestCancel/destroy
   * wake the wait and the checkpoint aborts the session.
   */
  private async awaitBandCredit(): Promise<void> {
    const window = this.config.bandWindow;
    if (window === undefined) return;
    while (this.outstandingBands >= window) {
      this.checkCancelled();
      await new Promise<void>((resolve) => {
        this.creditWaiter = resolve;
      });
      this.checkCancelled();
    }
    this.outstandingBands += 1;
  }

  private async submitLayer(request: RenderExportLayerRequest): Promise<void> {
    try {
      await this.submitLayerInner(request);
    } finally {
      // The stamp transferred with THIS message; every outcome — ack,
      // protocol violation, stale revision, cancellation — disposes it.
      request.layer.customStamp?.close();
    }
  }

  private async submitLayerInner(request: RenderExportLayerRequest): Promise<void> {
    if (this.ended) return;
    if (request.revision !== this.config.revision) {
      // Stale message for another revision: report, keep this session alive.
      this.hooks.emit({
        type: "error",
        revision: request.revision,
        code: "export-session-revision",
        message: "submit-layer revision does not match the open export session.",
      });
      return;
    }
    if (this.hooks.isCancelled()) {
      this.cancelNow();
      return;
    }
    if (this.busy) {
      this.fail("export-layer-overlap", "submit-layer arrived before the previous layer was acknowledged.");
      return;
    }
    if (this.passIndex >= this.config.plates.length) {
      this.fail("export-layer-after-complete", "submit-layer arrived after every plate pass completed.");
      return;
    }
    const plate = this.config.plates[this.passIndex];
    if (request.plate !== plate || request.layerIndex !== this.nextLayerIndex) {
      this.fail(
        "export-layer-order",
        `Expected plate ${plate} layer ${this.nextLayerIndex}, received plate ${request.plate} layer ${request.layerIndex}.`,
      );
      return;
    }
    this.busy = true;
    const { layer } = request;
    try {
      if (this.nextLayerIndex === 0) {
        const pixelCount = this.config.outputWidth * this.config.outputHeight;
        this.accumulator = {
          inkPremultiplied: allocField(pixelCount, "accumulator", "plate-ink"),
          alpha: allocField(pixelCount, "accumulator", "plate-alpha"),
        };
      }
      if (layerPlateVisible(layer, plate)) {
        // Prep descriptors warp HERE (banded, checkpointed) — off the main
        // thread; the source buffer dies as soon as the warp finishes.
        const raster = await resolveLayerInputRaster(
          layer,
          this.config.outputWidth,
          this.config.outputHeight,
          this.checkpoint,
        );
        try {
          // Sever the request's reference to the transferred SOURCE buffer:
          // without this the prep source stays reachable through the whole
          // kernel run (until the ack drops the request), inflating the true
          // peak by a full source raster beyond the model.
          layer.prep = undefined;
          layer.raster = undefined;
          if (raster.width !== this.config.outputWidth || raster.height !== this.config.outputHeight) {
            throw new RenderJobError(
              "export-layer-size",
              "Streamed layers must arrive at exactly the output dimensions; resample upstream.",
            );
          }
          if (layer.settings.cleanEnabled) {
            await this.processCleanLayer(raster, layer, plate);
          } else if (layer.settings.diffusionEnabled) {
            await this.processDiffusionLayer(raster, layer, plate);
          } else {
            await this.processHalftoneLayer(raster, layer, plate);
          }
        } finally {
          noteRasterRelease(raster.data.byteLength, "layer-raster");
        }
      }
      this.nextLayerIndex += 1;
      if (this.nextLayerIndex === this.config.layerCount) {
        await this.emitPlate(plate);
        this.passIndex += 1;
        this.nextLayerIndex = 0;
      }
      this.hooks.emit({
        type: "layer-ack",
        revision: this.config.revision,
        plate,
        layerIndex: request.layerIndex,
      });
    } catch (error) {
      if (error === SESSION_ABORT) {
        this.cancelNow();
      } else {
        const code = error instanceof RenderJobError ? error.code : "export-layer-failed";
        const message = error instanceof Error ? error.message : String(error);
        this.fail(code, message);
      }
    } finally {
      this.busy = false;
    }
  }

  private async finalize(request: RenderExportFinalizeRequest): Promise<void> {
    if (this.ended) return;
    if (request.revision !== this.config.revision) {
      this.hooks.emit({
        type: "error",
        revision: request.revision,
        code: "export-session-revision",
        message: "finalize-export revision does not match the open export session.",
      });
      return;
    }
    if (this.hooks.isCancelled()) {
      this.cancelNow();
      return;
    }
    if (this.busy) {
      this.fail("export-layer-overlap", "finalize-export arrived before the previous layer was acknowledged.");
      return;
    }
    if (this.passIndex < this.config.plates.length) {
      this.fail("export-finalize-early", "finalize-export arrived before every plate pass completed.");
      return;
    }
    this.busy = true;
    try {
      const { outputWidth: width, outputHeight: height } = this.config;
      if (this.proof) {
        const unit = this.totalUnits() - 1;
        const totalBands = Math.ceil(height / this.bandHeight);
        let bandsDone = 0;
        for (let rowStart = 0; rowStart < height; rowStart += this.bandHeight) {
          await this.hooks.yieldPoint();
          this.checkCancelled();
          await this.awaitBandCredit();
          const rowCount = Math.min(this.bandHeight, height - rowStart);
          const rgba = quantizeProofRows(this.proof, rowStart, rowCount);
          this.hooks.emit(
            {
              type: "proof-band",
              revision: this.config.revision,
              rowStart,
              rowCount,
              rgba: { buffer: rgba.buffer as ArrayBuffer, width, height: rowCount },
            },
            [rgba.buffer as ArrayBuffer],
          );
          bandsDone += 1;
          this.progress("proof", undefined, unit, bandsDone / totalBands);
        }
      }
      this.hooks.emit({
        type: "result",
        revision: this.config.revision,
        kind: "export",
        payload: { form: "streamed", width, height, plates: [...this.config.plates] },
      });
      this.release();
      this.ended = true;
      this.hooks.onEnd();
    } catch (error) {
      if (error === SESSION_ABORT) {
        this.cancelNow();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.fail("export-finalize-failed", message);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Diffusion layers: coverage and preprocess run through the checkpointed
   * kernels, then the banded scan streams each band straight into the plate
   * accumulator while carrying only the 2-row error window — the scan runs
   * ONCE per (layer, plate) and cancellation lands between chunks and bands.
   */
  private async processDiffusionLayer(raster: RasterData, layer: RenderLayerInput, plate: RenderPlateId): Promise<void> {
    const unit = this.layerUnit();
    this.progress("diffusion", plate, unit, 0);
    const { settings } = layer;
    const base = await buildCoverageBaseCoop(raster, plate, settings, this.checkpoint);
    let source: Float32Array | null = null;
    // CANCEL/THROW SAFETY: the finally releases whichever kernel fields
    // are still owned, so an abort mid-preprocess or mid-scan strands no
    // charged bytes; success releases the same fields exactly once.
    try {
      source = await preprocessDiffusionFieldCoop(
        base,
        raster.width,
        raster.height,
        settings,
        plateChannelIndex(plate),
        this.checkpoint,
      );
      if (source !== base) releaseField(base, "field", "coverage-base");
      const opacity = clamp(layer.opacity);
      const width = raster.width;
      const totalBands = Math.ceil(raster.height / this.bandHeight);
      let bandsDone = 0;
      await processBandedDiffusionCoop(
        source,
        width,
        raster.height,
        settings,
        this.bandHeight,
        (rowStart, rowCount, rows) => {
          // Parity with diffusionInkField's >= 0.5 presentation threshold.
          for (let index = 0; index < rows.length; index += 1) {
            rows[index] = rows[index] < 0.5 ? 0 : 1;
          }
          const alphaRows = this.extractAlphaRows(raster, rowStart, rowCount);
          accumulateLayerBand(this.accumulator!, rows, 0, alphaRows, 0, opacity, rowStart * width, rowCount * width);
          bandsDone += 1;
          this.progress("compose", plate, unit, bandsDone / totalBands);
        },
        this.checkpoint,
      );
    } finally {
      if (source === null) releaseField(base, "field", "coverage-base");
      else releaseField(source, "field", "preprocess-result");
    }
  }

  /**
   * Clean continuous-tone layers contribute their glitched coverage field
   * directly as ink — the SAME clean-field kernel the single-shot executor
   * uses, composed band-by-band with yield points. Pointwise (no threshold,
   * no cross-band state), so any band partition is bit-identical to the
   * single-shot compose. Needs no OffscreenCanvas.
   */
  private async processCleanLayer(
    raster: RasterData,
    layer: RenderLayerInput,
    plate: RenderPlateId,
  ): Promise<void> {
    const unit = this.layerUnit();
    this.progress("coverage", plate, unit, 0);
    const ink = await buildCleanFieldCoop(raster, plate, layer.settings, this.checkpoint);
    try {
      this.checkCancelled();
      const opacity = clamp(layer.opacity);
      const width = raster.width;
      const height = raster.height;
      const totalBands = Math.ceil(height / this.bandHeight);
      let bandsDone = 0;
      for (let rowStart = 0; rowStart < height; rowStart += this.bandHeight) {
        await this.hooks.yieldPoint();
        this.checkCancelled();
        const rowCount = Math.min(this.bandHeight, height - rowStart);
        const alphaRows = this.extractAlphaRows(raster, rowStart, rowCount);
        accumulateLayerBand(this.accumulator!, ink, rowStart * width, alphaRows, 0, opacity, rowStart * width, rowCount * width);
        bandsDone += 1;
        this.progress("compose", plate, unit, bandsDone / totalBands);
      }
    } finally {
      // CANCEL/THROW SAFETY: the clean-ink field never strands.
      releaseField(ink, "field", "clean-ink");
    }
  }

  /**
   * Halftone layers reuse the single-shot kernels verbatim — checkpointed
   * coverage chain, chunked grid collection, TILED dot rasterization over
   * the session's tile schedule — then compose band-by-band so cancellation
   * lands at chunk/tile/band granularity throughout.
   */
  private async processHalftoneLayer(
    raster: RasterData,
    layer: RenderLayerInput,
    plate: RenderPlateId,
  ): Promise<void> {
    const unit = this.layerUnit();
    const { settings } = layer;
    const { outputWidth: width, outputHeight: height } = this.config;
    this.progress("coverage", plate, unit, 0);
    const field = await buildCoverageFieldCoop(raster, plate, settings, this.checkpoint);
    let placements;
    try {
      this.progress("grid", plate, unit, 0.25);
      const geometry: GridGeometry = {
        width,
        height,
        sourceWidth: raster.width,
        sourceHeight: raster.height,
        cell: effectiveCellSize(settings.cellSize, this.config.renderScale, this.config.minimumCellSize),
        angleDegrees: settings.angles[plate],
      };
      placements = await collectGridDotsCoop(field, geometry, visibleContentBounds(raster), this.checkpoint);
    } finally {
      // CANCEL/THROW SAFETY: the coverage field never strands.
      releaseField(field, "field", "coverage-field");
    }
    let ink: Float32Array;
    try {
      if (!supportsOffscreenCanvas()) {
        throw new RenderJobError(
          "stream-compose-unavailable",
          "Streaming export composition needs OffscreenCanvas to rasterize halftone dots.",
        );
      }
      const tiles: TileRect[] = jobTiles(this.config.tiles, width, height);
      ink = await rasterizePlacementsTiled(
        placements,
        layer,
        width,
        height,
        this.config.renderScale,
        tiles,
        this.checkpoint,
      );
    } finally {
      // JS placement objects are no longer needed once rasterization settles
      // (success, cancellation, or throw).
      placements.release();
    }
    try {
      const opacity = clamp(layer.opacity);
      const totalBands = Math.ceil(height / this.bandHeight);
      let bandsDone = 0;
      for (let rowStart = 0; rowStart < height; rowStart += this.bandHeight) {
        await this.hooks.yieldPoint();
        this.checkCancelled();
        const rowCount = Math.min(this.bandHeight, height - rowStart);
        const alphaRows = this.extractAlphaRows(raster, rowStart, rowCount);
        accumulateLayerBand(this.accumulator!, ink, rowStart * width, alphaRows, 0, opacity, rowStart * width, rowCount * width);
        bandsDone += 1;
        this.progress("compose", plate, unit, 0.25 + 0.75 * (bandsDone / totalBands));
      }
    } finally {
      // CANCEL/THROW SAFETY: the rasterized ink field never strands.
      releaseField(ink, "field", "halftone-ink");
    }
  }

  /** Emit the finished plate band-by-band, fold the proof, free accumulators. */
  private async emitPlate(plate: RenderPlateId): Promise<void> {
    const accumulator = this.accumulator!;
    const { outputWidth: width, outputHeight: height } = this.config;
    const unit = this.passIndex * (this.config.layerCount + 1) + this.config.layerCount;
    const totalBands = Math.ceil(height / this.bandHeight);
    const emitSpan = this.proof ? 0.5 : 1;
    let bandsDone = 0;
    if (this.config.emitPlateBands !== false) {
      for (let rowStart = 0; rowStart < height; rowStart += this.bandHeight) {
        await this.hooks.yieldPoint();
        this.checkCancelled();
        await this.awaitBandCredit();
        const rowCount = Math.min(this.bandHeight, height - rowStart);
        const ink = accumulator.inkPremultiplied.slice(rowStart * width, (rowStart + rowCount) * width);
        const alpha = accumulator.alpha.slice(rowStart * width, (rowStart + rowCount) * width);
        this.hooks.emit(
          {
            type: "plate-band",
            revision: this.config.revision,
            plate,
            rowStart,
            rowCount,
            inkPremultiplied: { buffer: ink.buffer as ArrayBuffer, width, height: rowCount },
            alpha: { buffer: alpha.buffer as ArrayBuffer, width, height: rowCount },
          },
          [ink.buffer as ArrayBuffer, alpha.buffer as ArrayBuffer],
        );
        bandsDone += 1;
        this.progress("compose", plate, unit, emitSpan * (bandsDone / totalBands));
      }
    }
    if (this.proof) {
      bandsDone = 0;
      for (let rowStart = 0; rowStart < height; rowStart += this.bandHeight) {
        await this.hooks.yieldPoint();
        this.checkCancelled();
        const rowCount = Math.min(this.bandHeight, height - rowStart);
        foldPlateIntoProof(this.proof, plate, accumulator.inkPremultiplied, rowStart * width, (rowStart + rowCount) * width);
        bandsDone += 1;
        this.progress("proof", plate, unit, 0.5 + 0.5 * (bandsDone / totalBands));
      }
    }
    releaseField(accumulator.inkPremultiplied, "accumulator", "plate-ink");
    releaseField(accumulator.alpha, "accumulator", "plate-alpha");
    this.accumulator = null;
    this.hooks.emit({ type: "plate-complete", revision: this.config.revision, plate });
  }

  /** Progress unit of the layer currently being processed. */
  private layerUnit(): number {
    return this.passIndex * (this.config.layerCount + 1) + this.nextLayerIndex;
  }

  /** Units: per pass, layerCount layers + 1 emission; plus 1 proof-encode unit. */
  private totalUnits(): number {
    return this.config.plates.length * (this.config.layerCount + 1) + (this.config.paper ? 1 : 0);
  }

  /** Monotonic 0..1 progress across layer × plate × band. */
  private progress(
    phase: RenderProgressPhase,
    plate: RenderPlateId | undefined,
    unit: number,
    fraction: number,
  ): void {
    const ratio = Math.min(1, (unit + clamp(fraction)) / this.totalUnits());
    this.lastRatio = Math.max(this.lastRatio, ratio);
    this.hooks.emit({
      type: "progress",
      revision: this.config.revision,
      phase,
      plate,
      ratio: this.lastRatio,
    });
  }

  /** Extract layer alpha for a band straight from the source raster (parity with extractAlphaField). */
  private extractAlphaRows(raster: RasterData, rowStart: number, rowCount: number): Float32Array {
    const width = raster.width;
    const capacity = this.bandHeight * width;
    if (!this.alphaScratch || this.alphaScratch.length < capacity) {
      if (this.alphaScratch) releaseField(this.alphaScratch, "band", "alpha-scratch");
      this.alphaScratch = allocField(capacity, "band", "alpha-scratch");
    }
    const pixelBase = rowStart * width;
    for (let index = 0; index < rowCount * width; index += 1) {
      this.alphaScratch[index] = raster.data[(pixelBase + index) * 4 + 3] / 255;
    }
    return this.alphaScratch;
  }

  private checkCancelled(): void {
    if (this.hooks.isCancelled()) throw SESSION_ABORT;
  }

  /** Protocol violation or kernel failure: report, release, end the session. */
  private fail(code: string, message: string): void {
    if (this.ended) return;
    this.hooks.emit({ type: "error", revision: this.config.revision, code, message });
    this.release();
    this.ended = true;
    this.hooks.onEnd();
  }

  /** Cancel: release buffers promptly, emit exactly one cancelled event. */
  private cancelNow(): void {
    if (this.ended) return;
    this.release();
    this.ended = true;
    this.hooks.emit({ type: "cancelled", revision: this.config.revision });
    this.hooks.onEnd();
  }

  private release(): void {
    if (this.accumulator) {
      releaseField(this.accumulator.inkPremultiplied, "accumulator", "plate-ink");
      releaseField(this.accumulator.alpha, "accumulator", "plate-alpha");
    }
    if (this.alphaScratch) releaseField(this.alphaScratch, "band", "alpha-scratch");
    if (this.proof) releaseProofAccumulator(this.proof);
    this.accumulator = null;
    this.proof = null;
    this.alphaScratch = null;
  }
}
