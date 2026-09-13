/**
 * PreviewService — drives the multi-layer canvas preview through a
 * RenderPort (preview worker in Chromium, MainThreadRenderer elsewhere).
 *
 * Contract (plan: "Rendering architecture and performance"):
 * - Draft-then-exact: document/session changes submit a REPLACEABLE draft
 *   job at draftScaleFor scale (minimum cell 3 px, the legacy preview
 *   policy); gesture end / idle submits the exact viewport job at the
 *   measured viewport scale. Both carry monotonic revisions — the protocol
 *   supersedes older previews and this service additionally discards any
 *   result older than the newest submitted revision (bitmaps closed).
 * - Layers are prepared via prepareLayerRaster (crop → affine/perspective →
 *   Float64 warp) exactly like the export path, so preview and export can
 *   never diverge geometrically. Decoded sources are cached per assetId and
 *   warped rasters per layer fingerprint; buffers are copied per submit
 *   because worker transfer consumes them.
 * - Custom dot stamps are main-thread prepared ImageBitmaps resolved through
 *   `sources.resolveCustomStamp` (workers cannot rasterize SVG).
 * - Jobs carry ONLY artboard/separation/layer data. Guides, grid, and
 *   rulers are workspace overlays and never enter a render payload.
 * - Registration marks are drawn by the presenter on the main thread (the
 *   engine's final pass), which is also what lets CUSTOM registration
 *   shapes appear in the preview without worker support.
 *
 * Crash replacement: a `worker-crashed` error (revision null) rebuilds and
 * resubmits the latest request up to `maxCrashResubmits` times; beyond that
 * the error surfaces through onError and the owner may swap the port
 * factory (e.g. to MainThreadRenderer).
 *
 * React-free and DOM-free: fully unit-testable with a fake port.
 */

import type { Id, LayerV1, PlateId, ProjectCoreV1, SeparationV1, Sha256 } from "../core/types";
import {
  discardPayload,
  downsampleRasterToEdge,
  draftScaleFor,
  DRAFT_MAX_SAMPLE_EDGE,
  effectiveCellSize,
  PLATE_SEQUENCE,
  previewDraftIsApproximate,
  warpRasterBanded,
  yieldToEventLoop,
  type LayerPrepTransfer,
  type RenderJobRequest,
  type RenderLayerInput,
  type RenderPlateId,
  type RenderPort,
  type RenderResultPayload,
  type Revision,
} from "../render";
/* Direct module imports (not the export index) keep node unit tests from
 * pulling browser-only encoder modules — same rule as legacy-bridge. */
import {
  buildLayerPrepFromProxy,
  cropSourceRaster,
  layerOutputHomography,
  prepareLayerRaster,
} from "../export/layer-prep";
import { croppedSize } from "../editor";
import { mat3FromValues } from "../editor/matrix";
import { renderSettingsFromLayer } from "../export/worker-render-service";
import type { RasterData } from "../export/orchestrator";
import { captureAppError, startAppSpan } from "../telemetry/sentry";

/** Legacy preview cell floor (renderHalftone preview policy). */
export const PREVIEW_MINIMUM_CELL = 3;

/** Proof paper colors, matching the legacy preview chrome exactly. */
export const PREVIEW_PAPER: Record<"white" | "black", readonly [number, number, number]> = {
  white: [0xf4, 0xf1, 0xe9], // #F4F1E9 cream
  black: [0x11, 0x12, 0x14], // #111214
};

export type PreviewView = "composite" | PlateId;

export type PreviewKind = "preview-draft" | "exact-viewport";

export type PreviewRequestInput = {
  core: ProjectCoreV1;
  view: PreviewView;
  /** Output px per document px for the EXACT viewport job (0 < scale ≤ 1). */
  viewportScale: number;
};

export type PreviewFrame = {
  revision: Revision;
  kind: PreviewKind;
  view: PreviewView;
  payload: RenderResultPayload;
  /** Output px per document px the payload was rendered at. */
  renderScale: number;
  /** Proof paper; null for plate views (the presenter paints monochrome). */
  paper: readonly [number, number, number] | null;
};

export type PreviewError = { code: string; message: string };

export type PreviewSources = {
  /** Decoded straight-alpha RGBA pixels of a content-addressed asset. */
  resolveRaster(assetId: Sha256): Promise<RasterData>;
  /** Main-thread prepared custom dot stamp (dotShape === "custom"). */
  resolveCustomStamp?(assetId: Sha256, sizePx: number): Promise<ImageBitmap>;
};

export type PreviewServiceOptions = {
  /** Port factory: worker client or MainThreadRenderer. One persistent port. */
  createPort: () => RenderPort;
  sources: PreviewSources;
  /** Prefer transferable ImageBitmap proofs (probe createImageBitmap). */
  wantBitmap?: boolean;
  /** Draft sampling cap in output px (default DRAFT_MAX_SAMPLE_EDGE). */
  maxDraftEdge?: number;
  maxCrashResubmits?: number;
  /** Injectable layer warp for tests; defaults to prepareLayerRaster. */
  prepareLayer?: typeof prepareLayerRaster;
  /** Idle window before the exact viewport job may follow a delivered draft. */
  exactIdleMs?: number;
  /** Injectable timer for the idle window (tests); defaults to setTimeout. */
  timer?: PreviewTimerHost;
};

/** Idle window (ms since the latest requestPreview) gating the exact job. */
export const EXACT_IDLE_MS = 180;

export type PreviewTimerHost = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const systemPreviewTimer: PreviewTimerHost = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/* ------------------------------------------------------------------ */
/* Pure job math (exported for tests)                                  */
/* ------------------------------------------------------------------ */

/** Plates a preview job computes for the given proof view. */
export function previewPlates(separation: SeparationV1, view: PreviewView): RenderPlateId[] {
  if (view !== "composite") {
    return [separation.mode === "grayscale" ? "black" : view];
  }
  if (separation.mode === "grayscale") {
    return separation.visible.black ? ["black"] : [];
  }
  return PLATE_SEQUENCE.filter((plate) => separation.visible[plate]);
}

/**
 * Proof paper for an artboard background. TRANSPARENT returns null — the
 * proof keeps real alpha (no paper compositing in the render job; the
 * presenter composes an alpha-preserving proof raster instead).
 */
export function previewPaper(
  background: ProjectCoreV1["artboard"]["background"],
): readonly [number, number, number] | null {
  if (background === "transparent") return null;
  return background === "black" ? PREVIEW_PAPER.black : PREVIEW_PAPER.white;
}

/** Draft render scale: the viewport scale capped by the draft sample edge. */
export function previewDraftScale(
  core: ProjectCoreV1,
  viewportScale: number,
  maxEdge: number = DRAFT_MAX_SAMPLE_EDGE,
): number {
  const cap = draftScaleFor(core.artboard.widthPx, core.artboard.heightPx, maxEdge);
  return Math.min(Math.max(1e-6, viewportScale), cap);
}

/** Stamp resolution for a custom dot at this render scale (2 samples/px). */
export function customStampSizeFor(cellSize: number, renderScale: number): number {
  const cell = effectiveCellSize(cellSize, renderScale, PREVIEW_MINIMUM_CELL);
  return Math.min(2048, Math.max(16, Math.ceil(cell * 1.04 * 2)));
}

export type PreviewJobLayer = {
  layer: LayerV1;
  /** Pre-warped raster (exact jobs, injected-prep tests). */
  raster?: RasterData;
  /** Draft prep descriptor (production drafts: the WORKER warps). */
  prep?: LayerPrepTransfer;
  customStamp?: ImageBitmap;
};

/**
 * Assemble the protocol job. Pure: contains ONLY artboard geometry,
 * separation-derived settings, and the prepared layer rasters — guides,
 * grid, snapping, and selection never appear in a render payload.
 */
export function buildPreviewJob(args: {
  revision: Revision;
  kind: PreviewKind;
  core: ProjectCoreV1;
  view: PreviewView;
  scale: number;
  layers: PreviewJobLayer[];
  wantBitmap: boolean;
}): RenderJobRequest {
  const { core, view, scale } = args;
  const outputWidth = Math.max(1, Math.round(core.artboard.widthPx * scale));
  const outputHeight = Math.max(1, Math.round(core.artboard.heightPx * scale));
  const composite = view === "composite";
  const layers: RenderLayerInput[] = args.layers.map(({ layer, raster, prep, customStamp }) => {
    const { halftone } = layer.recipe;
    const input: RenderLayerInput = {
      settings: renderSettingsFromLayer(core, layer),
      opacity: layer.opacity,
      dotShape: layer.recipe.mode === "halftone" ? halftone.dotShape : "round",
      strokeWidth: halftone.strokeWidth,
    };
    if (raster) {
      input.raster = {
        buffer: raster.data.buffer as ArrayBuffer,
        width: raster.width,
        height: raster.height,
      };
    } else if (prep) {
      input.prep = prep;
    }
    if (customStamp) input.customStamp = customStamp;
    return input;
  });
  // Plate views composite client-side in monochrome ink; only the papered
  // composite proof asks the renderer for a proof. A TRANSPARENT background
  // sends no paper at all — the presenter folds the plates into an
  // alpha-preserving proof raster on the main thread.
  const paper = composite ? previewPaper(core.artboard.background) : null;
  return {
    type: "job",
    kind: args.kind,
    revision: args.revision,
    outputWidth,
    outputHeight,
    renderScale: scale,
    minimumCellSize: PREVIEW_MINIMUM_CELL,
    plates: previewPlates(core.separation, view),
    layers,
    ...(paper ? { paper } : {}),
    wantBitmap: args.wantBitmap && composite && paper !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

type FrameMeta = {
  kind: PreviewKind;
  view: PreviewView;
  renderScale: number;
  paper: readonly [number, number, number] | null;
};

export class PreviewService {
  private readonly createPort: () => RenderPort;
  private readonly sources: PreviewSources;
  private readonly wantBitmap: boolean;
  private readonly maxDraftEdge: number;
  private readonly maxCrashResubmits: number;
  private readonly prepareLayer: typeof prepareLayerRaster;
  private readonly exactIdleMs: number;
  private readonly timer: PreviewTimerHost;

  private port: RenderPort | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  private revisionCounter = 0;
  /** Newest revision whose build has started; older builds never submit. */
  private latestRequested: Revision = 0;
  private latestSubmitted: Revision = 0;
  private readonly previewSpans = new Map<Revision, (error?: unknown) => void>();
  private finishPreview(revision: Revision, error?: unknown): void {
    this.previewSpans.get(revision)?.(error);
    this.previewSpans.delete(revision);
  }
  private cancelPreviewSpans(): void {
    for (const revision of this.previewSpans.keys()) this.finishPreview(revision, new DOMException("Cancelled", "AbortError"));
  }
  private readonly pendingMeta = new Map<Revision, FrameMeta>();

  private lastRequest: { kind: PreviewKind; input: PreviewRequestInput } | null = null;
  private crashResubmits = 0;
  /**
   * Exact follow-up armed by requestPreview for ONE generation (its draft
   * revision). The exact viewport job fires at most once per generation and
   * only when BOTH gates open: the generation's own draft frame delivered,
   * AND the idle window elapsed with no newer input. Any new public request
   * invalidates the plan.
   */
  private exactPlan: {
    generation: Revision;
    input: PreviewRequestInput;
    draftDelivered: boolean;
    idle: boolean;
    timerHandle: unknown;
  } | null = null;

  private readonly decodeCache = new Map<Sha256, Promise<RasterData>>();
  private readonly preparedCache = new Map<Id, { fingerprint: string; raster: RasterData }>();
  /** Draft-scale source proxies, one per asset (decode-derived, prunable). */
  private readonly proxyCache = new Map<Sha256, RasterData>();
  /** Nested export-suspension count; >0 ⇒ requests defer, caches stay empty. */
  private suspendCount = 0;
  /** Bumped per suspension: in-flight builds from before the eviction see a
   *  stale epoch and DROP their results instead of repopulating a cache. */
  private suspendEpoch = 0;
  /** Latest request that arrived while suspended; replayed on resume. */
  private pendingWhileSuspended: { kind: PreviewKind; input: PreviewRequestInput } | null = null;
  /** True when tests injected a synchronous prepareLayer (legacy raster path). */
  private readonly injectedPrep: boolean;

  private readonly frameListeners = new Set<(frame: PreviewFrame) => void>();
  private readonly errorListeners = new Set<(error: PreviewError) => void>();

  constructor(options: PreviewServiceOptions) {
    this.createPort = options.createPort;
    this.sources = options.sources;
    this.wantBitmap = options.wantBitmap ?? false;
    this.maxDraftEdge = options.maxDraftEdge ?? DRAFT_MAX_SAMPLE_EDGE;
    this.maxCrashResubmits = options.maxCrashResubmits ?? 2;
    this.prepareLayer = options.prepareLayer ?? prepareLayerRaster;
    this.injectedPrep = options.prepareLayer !== undefined;
    this.exactIdleMs = options.exactIdleMs ?? EXACT_IDLE_MS;
    this.timer = options.timer ?? systemPreviewTimer;
  }

  /**
   * True once dispose() ran. A disposed service silently ignores requests,
   * so owners holding a service in a ref (HalftoneStudio) MUST check this
   * and construct a fresh instance — under React StrictMode the unmount
   * cleanup runs between two setup passes while refs are preserved.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  onFrame(listener: (frame: PreviewFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => void this.frameListeners.delete(listener);
  }

  onError(listener: (error: PreviewError) => void): () => void {
    this.errorListeners.add(listener);
    return () => void this.errorListeners.delete(listener);
  }

  /** Submit a draft or exact preview. Returns the assigned revision. */
  request(kind: PreviewKind, input: PreviewRequestInput): Revision {
    if (this.disposed) return this.revisionCounter;
    if (this.suspendCount > 0) {
      // Export in flight: defer instead of rebuilding the caches the
      // suspension just evicted; the latest request replays on resume.
      this.pendingWhileSuspended = { kind, input };
      this.lastRequest = { kind, input };
      return this.revisionCounter;
    }
    this.cancelPreviewSpans();
    const revision = ++this.revisionCounter;
    this.previewSpans.set(revision, startAppSpan("app.preview", { layerCount: input.core.layers.length, pixelCount: input.core.artboard.widthPx * input.core.artboard.heightPx }));
    this.latestRequested = revision;
    this.lastRequest = { kind, input };
    void this.buildAndSubmit(revision, kind, input).catch((error: unknown) => {
      this.finishPreview(revision, error);
      this.emitError({
        code: error instanceof PreviewBuildError ? error.code : "preview-build-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return revision;
  }

  requestDraft(input: PreviewRequestInput): Revision {
    this.clearExactPlan();
    return this.request("preview-draft", input);
  }

  requestExact(input: PreviewRequestInput): Revision {
    this.clearExactPlan();
    return this.request("exact-viewport", input);
  }

  /**
   * Draft-then-exact with double gating: submits a draft immediately; the
   * exact viewport job follows only once (a) THAT draft's frame has been
   * delivered AND (b) the idle window (exactIdleMs since this — the latest
   * — input) has elapsed. At most one exact fires per generation, and when
   * the draft already renders at the exact viewport scale no exact is
   * scheduled at all (it would duplicate the same render).
   *
   * This replaces the old unconditional 180ms exact timer, which superseded
   * the in-flight draft whenever the draft took longer than the window — on
   * a complex document the draft was cancelled before any frame landed,
   * over and over, so all feedback degraded to exact-render latency (or
   * never arrived under churn). Delivery gating means a slow draft always
   * paints first; idle gating means fast drafts during a continuous scrub
   * don't repeatedly launch exact work that the next edit cancels anyway.
   */
  requestPreview(input: PreviewRequestInput): Revision {
    this.clearExactPlan();
    const revision = this.request("preview-draft", input);
    if (this.disposed) return revision;
    const draftScale = previewDraftScale(input.core, input.viewportScale, this.maxDraftEdge);
    const exactScale = Math.min(1, Math.max(1e-6, input.viewportScale));
    // Equal public scales skip the exact ONLY when the draft truly executes
    // at that scale: deep stacks render internally at the adaptive edge
    // (the same centralized policy previewDraftIsApproximate exposes; the
    // delivered payload also carries draftScaleDown), so an adaptive draft
    // is an approximation and the exact settle must still follow.
    const draftWidth = Math.max(1, Math.round(input.core.artboard.widthPx * draftScale));
    const draftHeight = Math.max(1, Math.round(input.core.artboard.heightPx * draftScale));
    const visibleLayers = input.core.layers.filter((layer) => layer.visible).length;
    const plateCount = Math.max(1, previewPlates(input.core.separation, input.view).length);
    if (
      exactScale === draftScale &&
      !previewDraftIsApproximate(visibleLayers, plateCount, draftWidth, draftHeight)
    ) {
      return revision;
    }
    const plan = {
      generation: revision,
      input,
      draftDelivered: false,
      idle: false,
      timerHandle: null as unknown,
    };
    plan.timerHandle = this.timer.set(() => {
      plan.timerHandle = null;
      plan.idle = true;
      this.maybeFireExact(plan);
    }, this.exactIdleMs);
    this.exactPlan = plan;
    return revision;
  }

  private clearExactPlan(): void {
    const plan = this.exactPlan;
    if (!plan) return;
    if (plan.timerHandle !== null) this.timer.clear(plan.timerHandle);
    this.exactPlan = null;
  }

  private maybeFireExact(plan: NonNullable<PreviewService["exactPlan"]>): void {
    if (this.exactPlan !== plan || this.disposed) return;
    if (!plan.draftDelivered || !plan.idle) return;
    this.exactPlan = null;
    this.request("exact-viewport", plan.input);
  }

  /**
   * EXPORT SUSPENSION (audit residual 1): evict the decode/warp/proxy
   * caches AND the preview worker's draft field cache (the port disposes —
   * the dispose message clears DraftFieldCache and the worker terminates)
   * for the duration of an export; everything rebuilds lazily afterwards.
   * Requests arriving while suspended defer; the newest replays on resume
   * so the preview recovers with a correct frame. Re-entrant; each
   * suspension bumps the epoch so an in-flight build resolving late can
   * never repopulate a cache (the repopulation guard in prepared/draftPrep).
   */
  suspendForExport(): void {
    if (this.disposed) return;
    this.suspendCount += 1;
    if (this.suspendCount > 1) return;
    this.suspendEpoch += 1;
    this.clearExactPlan();
    // Preserve the LATEST semantic intent: whatever the user was viewing
    // replays on resume — suspension defers, never loses, view state.
    if (this.lastRequest) this.pendingWhileSuspended = { ...this.lastRequest };
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.port?.dispose();
    this.port = null;
    this.cancelPreviewSpans();
    this.pendingMeta.clear();
    this.decodeCache.clear();
    this.preparedCache.clear();
    this.proxyCache.clear();
  }

  resumeAfterExport(): void {
    if (this.disposed || this.suspendCount === 0) return;
    this.suspendCount -= 1;
    if (this.suspendCount > 0) return;
    const pending = this.pendingWhileSuspended;
    this.pendingWhileSuspended = null;
    if (pending) this.request(pending.kind, pending.input);
  }

  /** Test/diagnostic seam for the suspension contract. */
  get cacheStats(): { decode: number; prepared: number; proxy: number; suspended: boolean } {
    return {
      decode: this.decodeCache.size,
      prepared: this.preparedCache.size,
      proxy: this.proxyCache.size,
      suspended: this.suspendCount > 0,
    };
  }

  /** Drop cached data for assets/layers that left the document. */
  pruneCaches(core: ProjectCoreV1): void {
    const liveLayers = new Set(core.layers.map((layer) => layer.id));
    const liveAssets = new Set(core.layers.map((layer) => layer.assetId));
    for (const key of [...this.preparedCache.keys()]) {
      if (!liveLayers.has(key)) this.preparedCache.delete(key);
    }
    for (const key of [...this.decodeCache.keys()]) {
      if (!liveAssets.has(key)) this.decodeCache.delete(key);
    }
    for (const key of [...this.proxyCache.keys()]) {
      if (!liveAssets.has(key)) this.proxyCache.delete(key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearExactPlan();
    this.disposed = true;
    this.unsubscribe?.();
    this.port?.dispose();
    this.port = null;
    this.cancelPreviewSpans();
    this.pendingMeta.clear();
    this.decodeCache.clear();
    this.preparedCache.clear();
    this.proxyCache.clear();
    this.frameListeners.clear();
    this.errorListeners.clear();
  }

  /* ----- internals ----- */

  private emitError(error: PreviewError): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  private ensurePort(): RenderPort {
    if (this.port) return this.port;
    const port = this.createPort();
    this.unsubscribe = port.onEvent((event) => {
      if (this.disposed) return;
      if (event.type === "result") {
        this.finishPreview(event.revision);
        const meta = this.pendingMeta.get(event.revision);
        this.pendingMeta.delete(event.revision);
        // Stale gate against latestREQUESTED (the newest intent): a result
        // for revision N must never present while N+1 is still building
        // asynchronously (N+1 not yet submitted) — it would clobber the
        // presenter with superseded state.
        if (!meta || event.revision < this.latestRequested) {
          discardPayload(event.payload);
          return;
        }
        this.crashResubmits = 0;
        const frame: PreviewFrame = {
          revision: event.revision,
          kind: meta.kind,
          view: meta.view,
          payload: event.payload,
          renderScale: meta.renderScale,
          paper: meta.paper,
        };
        for (const listener of [...this.frameListeners]) listener(frame);
        // Exact follow-up, delivery gate: only the plan's OWN generation
        // opens it — a stale draft can never arm exact for a newer one.
        const plan = this.exactPlan;
        if (plan && meta.kind === "preview-draft" && event.revision === plan.generation) {
          plan.draftDelivered = true;
          this.maybeFireExact(plan);
        }
        return;
      }
      if (event.type === "cancelled") {
        this.finishPreview(event.revision, new DOMException("Cancelled", "AbortError"));
        this.pendingMeta.delete(event.revision);
        return;
      }
      if (event.type === "error") {
        if (event.revision !== null) this.finishPreview(event.revision, new Error("preview-failed"));
        else this.cancelPreviewSpans();
        if (event.revision !== null) this.pendingMeta.delete(event.revision);
        if (event.code === "worker-crashed" && this.lastRequest) {
          if (this.crashResubmits < this.maxCrashResubmits) {
            this.crashResubmits += 1;
            const { kind, input } = this.lastRequest;
            if (kind === "preview-draft" && this.exactPlan !== null) {
              // The crashed draft belonged to a requestPreview generation;
              // re-arm the delivery/idle-gated exact for the resubmission.
              this.requestPreview(input);
            } else {
              this.request(kind, input);
            }
            return;
          }
        }
        if (event.code === "worker-crashed") {
          // Crash replacement EXHAUSTED (resubmits above return early):
          // exactly one scrubbed stable-code event per exhaustion; the
          // owner's fallback swap (MainThreadRenderer) happens via onError.
          const core = this.lastRequest?.input.core;
          captureAppError("preview-worker-crash", {
            ...(core
              ? {
                  layerCount: core.layers.length,
                  pixelCount: core.artboard.widthPx * core.artboard.heightPx,
                }
              : {}),
          });
        }
        this.emitError({ code: event.code, message: event.message });
      }
    });
    this.port = port;
    return port;
  }

  private decode(assetId: Sha256): Promise<RasterData> {
    // Suspended: pass-through, never cached (in-flight builds only).
    if (this.suspendCount > 0) return this.sources.resolveRaster(assetId);
    let pending = this.decodeCache.get(assetId);
    if (!pending) {
      const fresh = this.sources.resolveRaster(assetId);
      pending = fresh;
      this.decodeCache.set(assetId, fresh);
      // Identity-guarded cleanup: a stale rejection settling after a
      // suspend/resume cycle must not evict a newer entry.
      fresh.catch(() => {
        if (this.decodeCache.get(assetId) === fresh) this.decodeCache.delete(assetId);
      });
    }
    return pending;
  }

  /**
   * Warp cache: reuse the prepared raster while the fingerprint holds.
   * The production warp runs BANDED with real event-loop yields
   * (warpRasterBanded — byte-identical to prepareLayerRaster), so even the
   * exact-settle preparation never blocks the main thread beyond a band;
   * an injected prepareLayer (tests) keeps the legacy synchronous call.
   */
  private async prepared(
    layer: LayerV1,
    outputWidth: number,
    outputHeight: number,
    renderScale: number,
  ): Promise<RasterData> {
    const fingerprint = JSON.stringify([
      layer.assetId,
      layer.crop,
      layer.transform,
      outputWidth,
      outputHeight,
    ]);
    const cached = this.preparedCache.get(layer.id);
    if (cached && cached.fingerprint === fingerprint) return cached.raster;
    const epoch = this.suspendEpoch;
    const source = await this.decode(layer.assetId);
    let raster: RasterData;
    if (this.injectedPrep) {
      raster = this.prepareLayer(layer, source, { outputWidth, outputHeight, renderScale });
    } else {
      const cropped = cropSourceRaster(source, layer.crop);
      const size = croppedSize(layer.crop, source.width, source.height);
      const homography = layerOutputHomography(layer, size, renderScale);
      raster = await warpRasterBanded(
        cropped,
        mat3FromValues(
          homography[0], homography[1], homography[2],
          homography[3], homography[4], homography[5],
          homography[6], homography[7], homography[8],
        ),
        outputWidth,
        outputHeight,
        () => yieldToEventLoop(),
        // Small bands: even a viewport-sized settle warp yields multiple
        // times per layer, so an 8-layer prepare loop never forms one
        // long main-thread task.
        Math.max(1, Math.floor(250_000 / Math.max(1, outputWidth))),
      );
    }
    // Repopulation guard: a build that started before a suspension (or
    // while suspended) drops its result instead of caching it.
    if (epoch === this.suspendEpoch && this.suspendCount === 0) {
      this.preparedCache.set(layer.id, { fingerprint, raster });
    }
    return raster;
  }

  /**
   * Draft prep descriptor over the per-asset draft proxy: the interaction
   * path never warps on this thread — the WORKER performs the transform
   * from a few-megabyte proxy (buildLayerPrepFromProxy composes the
   * proxy→full scale into the homography, preserving placement exactly).
   */
  private async draftPrep(
    layer: LayerV1,
    outputWidth: number,
    outputHeight: number,
    renderScale: number,
  ): Promise<LayerPrepTransfer> {
    const epoch = this.suspendEpoch;
    const source = await this.decode(layer.assetId);
    let proxy = this.proxyCache.get(layer.assetId);
    if (!proxy) {
      proxy = downsampleRasterToEdge(source, this.maxDraftEdge);
      // Repopulation guard (see prepared()).
      if (epoch === this.suspendEpoch && this.suspendCount === 0) {
        this.proxyCache.set(layer.assetId, proxy);
      }
    }
    // Transfer consumes the buffer; the proxy cache keeps the original.
    return buildLayerPrepFromProxy(
      layer,
      { data: proxy.data.slice(), width: proxy.width, height: proxy.height },
      { width: source.width, height: source.height },
      { outputWidth, outputHeight, renderScale },
    );
  }

  private async buildAndSubmit(
    revision: Revision,
    kind: PreviewKind,
    input: PreviewRequestInput,
  ): Promise<void> {
    // SUSPEND-EPOCH GUARD, entry: a build that starts while suspended (or
    // that started before a suspension — see stale() below) drops out.
    const buildEpoch = this.suspendEpoch;
    if (this.suspendCount > 0) return;
    const { core, view } = input;
    const scale =
      kind === "preview-draft"
        ? previewDraftScale(core, input.viewportScale, this.maxDraftEdge)
        : Math.min(1, Math.max(1e-6, input.viewportScale));
    const outputWidth = Math.max(1, Math.round(core.artboard.widthPx * scale));
    const outputHeight = Math.max(1, Math.round(core.artboard.heightPx * scale));

    const jobLayers: PreviewJobLayer[] = [];
    for (const layer of core.layers) {
      if (!layer.visible) continue;
      let entry: PreviewJobLayer;
      if (kind === "preview-draft" && !this.injectedPrep) {
        // Production drafts ship prep descriptors — no main-thread warp on
        // the interaction path; the worker warps (and its draft field
        // cache replays unchanged layers without touching the pixels).
        entry = { layer, prep: await this.draftPrep(layer, outputWidth, outputHeight, scale) };
      } else {
        const raster = await this.prepared(layer, outputWidth, outputHeight, scale);
        if (this.buildIsStale(revision, buildEpoch)) return;
        entry = {
          layer,
          // Transfer consumes the buffer; the cache keeps the original.
          raster: { data: raster.data.slice(), width: raster.width, height: raster.height },
        };
      }
      if (this.buildIsStale(revision, buildEpoch)) return;
      // Real macrotask boundary between layers: per-layer prep (proxy
      // copies, cache-hit warps) must never coalesce into one long task.
      if (!this.injectedPrep) await yieldToEventLoop();
      if (this.buildIsStale(revision, buildEpoch)) return;
      const { halftone } = layer.recipe;
      if (layer.recipe.mode === "halftone" && halftone.dotShape === "custom") {
        if (halftone.customShapeAssetId === null || !this.sources.resolveCustomStamp) {
          throw new PreviewBuildError(
            "custom-stamp-unavailable",
            "This layer uses a custom dot shape but no prepared stamp source is available.",
          );
        }
        entry.customStamp = await this.sources.resolveCustomStamp(
          halftone.customShapeAssetId,
          customStampSizeFor(halftone.cellSize, scale),
        );
        if (this.buildIsStale(revision, buildEpoch)) return;
      }
      jobLayers.push(entry);
    }
    if (this.buildIsStale(revision, buildEpoch)) return;

    const job = buildPreviewJob({
      revision,
      kind,
      core,
      view,
      scale,
      layers: jobLayers,
      wantBitmap: this.wantBitmap,
    });
    this.pendingMeta.set(revision, {
      kind,
      view,
      renderScale: scale,
      paper: job.paper ?? null,
    });
    this.latestSubmitted = revision;
    this.ensurePort().submit(job);
  }

  /**
   * A build crossing a suspend boundary must not recreate the port, write
   * a cache, or submit — its work is dropped and the latest intent replays
   * on resume (pendingWhileSuspended).
   */
  private buildIsStale(revision: Revision, buildEpoch: number): boolean {
    return (
      this.disposed ||
      revision !== this.latestRequested ||
      this.suspendCount > 0 ||
      buildEpoch !== this.suspendEpoch
    );
  }
}

class PreviewBuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
