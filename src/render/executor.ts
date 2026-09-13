/**
 * Shared render-job executor. Runs the DOM-free kernels for a job request
 * and produces a protocol payload. Used verbatim by preview.worker.ts,
 * export.worker.ts, and main-thread-renderer.ts so all three stay in exact
 * behavioral agreement.
 *
 * Capability tiers (feature-detected, never assumed):
 * - OffscreenCanvas available: halftone dots rasterize off-thread, plates
 *   compose with knockout, and the proof returns as pixels (and an
 *   ImageBitmap when createImageBitmap exists and the job asked for one).
 * - Otherwise: the executor returns per-layer kernel outputs (fields, dot
 *   placements, alpha) and the consumer's visible canvas draws them — the
 *   reduced-performance typed-array path for non-Chromium engines.
 *
 * TILING CONTRACT (canonical schedule): halftone dot rasterization consumes
 * the job's tile schedule (`job.tiles`, normally planRender().tiles) — dots
 * paint onto tile-sized canvases at absolute artboard coordinates, never
 * onto an artboard-sized canvas, so CANVAS STAGING is bounded by the tile
 * edge and cancellation lands at tile granularity. (The assembled INK FIELD
 * is still one full output-sized Float32Array — the planner's memory model
 * counts it.) Jobs without a schedule (e.g. preview drafts built by the app
 * shell) are chunked with DEFAULT_TILE_EDGE here. The output contract is
 * DETERMINISM UNDER THE CANONICAL SCHEDULE: for a fixed schedule the bytes
 * are reproducible and every production path (single-shot, streamed,
 * preview exact) shares the same schedule, so cross-path outputs agree
 * byte-for-byte. Rasterizing the SAME placements on a single artboard-sized
 * canvas instead is NOT byte-identical on real canvas implementations —
 * Skia's antialiased fills (arcs especially) are coordinate-dependent under
 * translation; the browser benchmark measures and bounds that deviation per
 * dot shape (tests/e2e/perf-benchmark.spec.ts), and the deterministic unit
 * rasterizer proves the schedule-independent LOGICAL equivalence (dot
 * inclusion/clipping — tests/unit/render-tiling.test.ts).
 *
 * PREP: layers may arrive as pre-warped rasters OR as prep descriptors
 * (source + crop + homography); descriptors are resolved here through the
 * banded worker-side warp (src/render/prep.ts), off the main thread.
 *
 * Cancellation is cooperative AND observable mid-phase: every whole-image
 * kernel runs through its *Coop variant with a checkpoint that polls
 * `isCancelled` and awaits `yieldPoint` — a real macrotask — so a busy
 * worker still processes cancel/supersede messages DURING warp, coverage,
 * glitch (including bitmap sort), diffusion preprocess, grid collection,
 * and dot rasterization, not just between layers.
 */
import type { DotShape } from "../core/types";
import { composePlate, proofCompositeCmyk, type PlateLayerOutput } from "./compose";
import { splatterPlacements, splatterSupports, type DraftFieldCache } from "./draft";
import {
  buildCleanFieldCoop,
  buildCoverageFieldCoop,
  visibleContentBounds,
  type ContentBounds,
} from "./kernels/coverage";
import { buildDiffusionFieldCoop } from "./kernels/diffusion";
import {
  collectGridDotsCoop,
  effectiveCellSize,
  type DotPlacement,
  type GridGeometry,
  type TileRect,
} from "./kernels/halftone-grid";
import {
  noteAlloc,
  noteRelease,
  retainAllocation,
  releaseField,
  type Checkpoint,
} from "./instrumentation";
import { adaptiveDraftEdge, chunkTiles, DEFAULT_TILE_EDGE } from "./planner";
import { PACKED_PLACEMENT_BYTES_PER_DOT } from "./placement-memory";
import { resolvePrepRaster } from "./prep";
import type {
  ComposedPlateData,
  LayerPlateData,
  RenderJobRequest,
  RenderLayerInput,
  RenderProgressPhase,
  RenderResultPayload,
} from "./protocol";
import { extractAlphaField, flattenOntoWhite, type RasterData } from "./raster";
import type { RenderPlateId } from "./settings";

export type ExecutorHooks = {
  isCancelled: () => boolean;
  onProgress: (phase: RenderProgressPhase, plate: RenderPlateId | undefined, ratio: number) => void;
  /** Awaited between units of work; lets callers time-slice or stay async. */
  yieldPoint: () => void | Promise<void>;
  /**
   * Per-port draft layer-field cache; consulted ONLY for "preview-draft"
   * jobs whose layers carry a cacheKey. Exact-viewport and export jobs
   * never read or write it (bit-parity path).
   */
  draftCache?: DraftFieldCache;
};

export class RenderJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Internal control-flow sentinel thrown at cancellation checkpoints. */
const JOB_ABORT = Symbol("render-job-abort");

export function supportsOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== "undefined";
}

export function supportsCreateImageBitmap(): boolean {
  return typeof createImageBitmap === "function";
}

function rasterFromTransfer(transfer: { buffer: ArrayBuffer; width: number; height: number }): RasterData {
  return {
    data: new Uint8ClampedArray(transfer.buffer),
    width: transfer.width,
    height: transfer.height,
  };
}

/**
 * Resolve a layer input to its sample-space raster: either the pre-warped
 * transfer, or the prep descriptor cropped + warped in this thread (banded,
 * checkpointed). Shared by the single-shot executor and the streaming
 * session so both produce bit-identical layer rasters. The returned bytes
 * are noted as retained in the allocation ledger either way; the consumer
 * notes the release when it drops the raster.
 */
export async function resolveLayerInputRaster(
  layer: RenderLayerInput,
  outputWidth: number,
  outputHeight: number,
  checkpoint: Checkpoint,
): Promise<RasterData> {
  if (layer.raster) {
    const raster = rasterFromTransfer(layer.raster);
    noteAlloc(raster.data.byteLength, "raster", "layer-raster");
    return raster;
  }
  if (layer.prep) return resolvePrepRaster(layer.prep, outputWidth, outputHeight, checkpoint);
  throw new RenderJobError("layer-input-missing", "A render layer needs either a raster or a prep descriptor.");
}

/** Whether a layer contributes to a plate; shared with the streaming session. */
export function layerPlateVisible(layer: RenderLayerInput, plate: RenderPlateId): boolean {
  const { settings } = layer;
  if (!settings.visible[plate]) return false;
  if (settings.grayscale && plate !== "black") return false;
  return true;
}

/** Replicates drawDot geometry from src/studio/halftone.ts for worker canvases. */
export function paintDot(
  context: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  shape: Exclude<DotShape, "custom">,
  strokeWidth = 1,
): void {
  if (size <= 0.12) return;
  const radius = size / 2;
  context.beginPath();
  if (shape === "square") {
    context.rect(x - radius, y - radius, size, size);
  } else if (shape === "diamond") {
    context.moveTo(x, y - radius);
    context.lineTo(x + radius, y);
    context.lineTo(x, y + radius);
    context.lineTo(x - radius, y);
    context.closePath();
  } else if (shape === "triangle") {
    context.moveTo(x, y - radius);
    context.lineTo(x + radius, y + radius);
    context.lineTo(x - radius, y + radius);
    context.closePath();
  } else if (shape === "cross") {
    const halfBar = size * 0.14;
    context.rect(x - halfBar, y - radius, halfBar * 2, size);
    context.rect(x - radius, y - halfBar, size, halfBar * 2);
  } else if (shape === "circle-outline") {
    context.arc(x, y, radius, 0, Math.PI * 2);
    const innerRadius = Math.max(0, radius - strokeWidth);
    if (innerRadius > 0) {
      context.moveTo(x + innerRadius, y);
      context.arc(x, y, innerRadius, 0, Math.PI * 2, true);
    }
  } else if (shape === "line") {
    context.roundRect(x - radius, y - size * 0.16, size, size * 0.32, size * 0.16);
  } else {
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  context.fill();
}

function paintLayerDots(
  context: OffscreenCanvasRenderingContext2D,
  placements: DotPlacement[],
  layer: RenderLayerInput,
  renderScale: number,
  offsetX: number,
  offsetY: number,
  filter?: (dot: DotPlacement) => boolean,
  startIndex = 0,
  endIndex = placements.length,
): void {
  context.fillStyle = "#000000";
  if (layer.dotShape === "custom") {
    if (!layer.customStamp) {
      throw new RenderJobError("custom-stamp-missing", "Custom dot shapes need a prepared stamp bitmap from the main thread.");
    }
    for (let index = startIndex; index < endIndex; index += 1) {
      const dot = placements[index];
      if (filter && !filter(dot)) continue;
      if (dot.size > 0.12) {
        context.drawImage(
          layer.customStamp,
          dot.x - dot.size / 2 - offsetX,
          dot.y - dot.size / 2 - offsetY,
          dot.size,
          dot.size,
        );
      }
    }
  } else {
    for (let index = startIndex; index < endIndex; index += 1) {
      const dot = placements[index];
      if (filter && !filter(dot)) continue;
      paintDot(context, dot.x - offsetX, dot.y - offsetY, dot.size, layer.dotShape, layer.strokeWidth * renderScale);
    }
  }
}

/**
 * Rasterize halftone dot placements to an ink-coverage field at output size
 * using ONE artboard-sized canvas. Retained as the whole-image reference the
 * tiled path is verified against (and for tiny targets/tests).
 */
export function rasterizePlacements(
  placements: DotPlacement[],
  layer: RenderLayerInput,
  width: number,
  height: number,
  renderScale: number,
): Float32Array {
  const canvas = new OffscreenCanvas(width, height);
  // willReadFrequently pins the SOFTWARE rasterizer so canvases of
  // different sizes never straddle Chromium's GPU/CPU acceleration
  // heuristic — keeping repeated runs of ONE schedule deterministic and
  // holding the tiled-vs-whole-image antialiasing deviation inside the
  // measured bounded-AA contract (see the TILING CONTRACT above; the two
  // schedules are NOT bit-identical on real canvas implementations).
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new RenderJobError("context-unavailable", "OffscreenCanvas 2d context unavailable.");
  paintLayerDots(context, placements, layer, renderScale, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  const ink = new Float32Array(width * height);
  for (let index = 0; index < ink.length; index += 1) {
    ink[index] = pixels.data[index * 4 + 3] / 255;
  }
  return ink;
}

/**
 * Tiled rasterization of halftone dot placements: for each tile of the
 * schedule, every dot whose footprint can touch the tile paints onto a
 * TILE-SIZED canvas at absolute-coordinate offsets, and the tile's alpha
 * rows land in the shared full-resolution ink field.
 *
 * CONTRACT: deterministic bytes for a FIXED schedule (see the module
 * header). Tile origins are integers, so each dot's subpixel phase is
 * preserved and the inclusion test only over-approximates the footprint
 * (half size + 1px AA guard) — an included dot that touches no tile pixel
 * paints nothing. Real canvas AA is coordinate-dependent under translation,
 * so a DIFFERENT schedule (or a single whole-image canvas) reproduces the
 * same geometry within a small measured per-pixel bound rather than
 * byte-exactly; the browser benchmark asserts that bound per dot shape.
 */
export async function rasterizePlacementsTiled(
  placements: DotPlacement[],
  layer: RenderLayerInput,
  width: number,
  height: number,
  renderScale: number,
  tiles: TileRect[],
  checkpoint: Checkpoint,
): Promise<Float32Array> {
  const ink = new Float32Array(width * height);
  noteAlloc(ink.byteLength, "field", "halftone-ink");
  let completed = false;
  try {
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      if (checkpoint) await checkpoint();
      const tile = tiles[tileIndex];
      const canvasBytes = tile.width * tile.height * 8;
      noteAlloc(canvasBytes, "canvas", "tile-canvas");
      try {
        const canvas = new OffscreenCanvas(tile.width, tile.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new RenderJobError("context-unavailable", "OffscreenCanvas 2d context unavailable.");
        const touchesTile = (dot: DotPlacement) => {
          const reach = dot.size / 2 + 1;
          return (
            dot.x + reach >= tile.x &&
            dot.x - reach < tile.x + tile.width &&
            dot.y + reach >= tile.y &&
            dot.y - reach < tile.y + tile.height
          );
        };
        // A single very large tile used to scan millions of placements in
        // one uncancellable loop. Chunk the SAME ordered draw sequence; the
        // awaits do not alter canvas state or output bytes.
        for (let start = 0; start < placements.length; start += 4_096) {
          if (start > 0 && checkpoint) await checkpoint();
          paintLayerDots(
            context,
            placements,
            layer,
            renderScale,
            tile.x,
            tile.y,
            touchesTile,
            start,
            Math.min(placements.length, start + 4_096),
          );
        }
        const pixels = context.getImageData(0, 0, tile.width, tile.height);
        for (let row = 0; row < tile.height; row += 1) {
          const inkBase = (tile.y + row) * width + tile.x;
          const pixelBase = row * tile.width;
          for (let column = 0; column < tile.width; column += 1) {
            ink[inkBase + column] = pixels.data[(pixelBase + column) * 4 + 3] / 255;
          }
        }
      } finally {
        noteRelease(canvasBytes, "canvas", "tile-canvas");
      }
    }
    completed = true;
    return ink;
  } finally {
    if (!completed) noteRelease(ink.byteLength, "field", "halftone-ink");
  }
}

/** The job's tile schedule; plan.tiles when provided, else a default chunking. */
export function jobTiles(
  tiles: TileRect[] | undefined,
  width: number,
  height: number,
): TileRect[] {
  return tiles && tiles.length > 0 ? tiles : chunkTiles(width, height, DEFAULT_TILE_EDGE);
}

/** Nearest-neighbor resample of a sample-space field onto the output grid. */
function resampleFieldToOutput(
  field: Float32Array,
  sampleWidth: number,
  sampleHeight: number,
  width: number,
  height: number,
): Float32Array {
  if (sampleWidth === width && sampleHeight === height) return field;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sampleY = Math.max(0, Math.min(sampleHeight - 1, Math.round((y / height) * sampleHeight)));
    for (let x = 0; x < width; x += 1) {
      const sampleX = Math.max(0, Math.min(sampleWidth - 1, Math.round((x / width) * sampleWidth)));
      out[y * width + x] = field[sampleY * sampleWidth + sampleX];
    }
  }
  return out;
}

/** Diffusion ink mask at output size; parity with renderDiffusionPlate's >= 0.5 threshold. */
function diffusionInkField(
  field: Float32Array,
  sampleWidth: number,
  sampleHeight: number,
  width: number,
  height: number,
): Float32Array {
  const resampled = resampleFieldToOutput(field, sampleWidth, sampleHeight, width, height);
  const ink = resampled === field ? field.slice() : resampled;
  for (let index = 0; index < ink.length; index += 1) {
    ink[index] = ink[index] < 0.5 ? 0 : 1;
  }
  return ink;
}

/** Nearest-neighbor RGBA resize (draft-only up/downscale helper). */
function resizeRasterNearest(source: RasterData, width: number, height: number): RasterData {
  if (source.width === width && source.height === height) return source;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.max(0, Math.min(source.height - 1, Math.round((y / height) * source.height)));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.max(0, Math.min(source.width - 1, Math.round((x / width) * source.width)));
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      data[to] = source.data[from];
      data[to + 1] = source.data[from + 1];
      data[to + 2] = source.data[from + 2];
      data[to + 3] = source.data[from + 3];
    }
  }
  return { data, width, height };
}

/**
 * FNV-1a over a buffer's 32-bit words, strided (every 8th word plus the
 * buffer edges). Draft-only fingerprinting: per-frame keys for eight draft
 * rasters must cost single-digit milliseconds, and any real edit perturbs
 * words throughout the buffer; a missed collision could at worst replay a
 * stale DRAFT until the next edit.
 */
function fnvBuffer(buffer: ArrayBuffer): number {
  const words = new Uint32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
  let hash = 0x811c9dc5;
  for (let index = 0; index < words.length; index += 8) {
    hash ^= words[index];
    hash = Math.imul(hash, 0x01000193);
  }
  if (words.length > 0) {
    hash ^= words[words.length - 1] ^ words.length;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Content fingerprint for the draft layer-field cache, derived from the
 * layer input itself so PRODUCTION preview jobs get draft caching without
 * any consumer change: raster/prep bytes (FNV-1a), geometry, and the full
 * kernel settings. A consumer-supplied cacheKey (protocol field) overrides
 * the derivation. Draft-only: a hash collision could at worst replay a
 * stale DRAFT contribution until the next edit; exact/export never cache.
 */
function deriveDraftLayerKey(layer: RenderLayerInput): string | null {
  const explicit = layer.cacheKey;
  if (explicit) return explicit;
  // Custom stamps arrive as opaque ImageBitmaps whose content cannot be
  // fingerprinted here — deriving a key without stamp identity could replay
  // stale ink after a shape swap. No derived caching for custom dots; a
  // consumer that KNOWS the stamp's asset sha may still pass an explicit
  // cacheKey that includes it.
  if (layer.dotShape === "custom") return null;
  let content = "";
  if (layer.raster) {
    content = `r${layer.raster.width}x${layer.raster.height}:${fnvBuffer(layer.raster.buffer)}`;
  } else if (layer.prep) {
    content =
      `p${layer.prep.source.width}x${layer.prep.source.height}:${fnvBuffer(layer.prep.source.buffer)}` +
      `:${layer.prep.homography.join(",")}:${JSON.stringify(layer.prep.crop)}`;
  }
  return `${content}|${JSON.stringify(layer.settings)}|${layer.opacity}|${layer.dotShape}|${layer.strokeWidth}|${layer.flattenWhite ? 1 : 0}`;
}

export async function executeRenderJob(
  job: RenderJobRequest,
  hooks: ExecutorHooks,
): Promise<RenderResultPayload | null> {
  const { outputWidth: requestedWidth, outputHeight: requestedHeight } = job;
  const composeCapable = supportsOffscreenCanvas() && job.payloadForm !== "layer-data";
  // CONSTANT-WORK DRAFTS (production path): preview-draft jobs render at
  // the adaptive internal edge (adaptiveDraftEdge — legacy 4-pass budget)
  // and the finished proof/plates upscale back to the requested output, so
  // deep stacks keep interactive latency without any consumer change.
  // Exact-viewport and export jobs always render at requested resolution.
  let draftScaleDown = 1;
  if (job.kind === "preview-draft" && composeCapable) {
    const edge = adaptiveDraftEdge(job.layers.length, Math.max(1, job.plates.length));
    const maxDim = Math.max(requestedWidth, requestedHeight);
    if (maxDim > edge) draftScaleDown = edge / maxDim;
  }
  const width = Math.max(1, Math.round(requestedWidth * draftScaleDown));
  const height = Math.max(1, Math.round(requestedHeight * draftScaleDown));
  const renderScale = job.renderScale * draftScaleDown;
  const pixelCount = width * height;
  const checkpoint: Checkpoint = async () => {
    if (hooks.isCancelled()) throw JOB_ABORT;
    await hooks.yieldPoint();
  };
  const draftCache = job.kind === "preview-draft" ? hooks.draftCache : undefined;
  // Layer inputs resolve LAZILY: a draft whose layers replay from the cache
  // never pays for the transferred raster, its alpha extraction, or its
  // content-bounds scan.
  const rasters: (RasterData | null)[] = job.layers.map(() => null);
  const alphaFields: (Float32Array | null)[] = job.layers.map(() => null);
  const contentBoundsList: (ContentBounds | null)[] = job.layers.map(() => null);
  const releaseInputs = () => {
    for (const layer of job.layers) layer.customStamp?.close();
    for (const raster of rasters) {
      if (raster) noteRelease(raster.data.byteLength, "raster", "layer-raster");
    }
    rasters.fill(null);
  };
  const layerRaster = async (index: number): Promise<RasterData> => {
    let raster = rasters[index];
    if (!raster) {
      const input = job.layers[index];
      let localOwner: RasterData | null = null;
      try {
        if (input.prep && draftScaleDown !== 1) {
          // Prep drafts warp DIRECTLY at the internal resolution: scale the
          // source→output homography rows by the same factor.
          const scaled = input.prep.homography.map((value, position) =>
            position < 6 ? value * draftScaleDown : value,
          );
          raster = await resolveLayerInputRaster(
            { ...input, prep: { ...input.prep, homography: scaled } },
            width,
            height,
            checkpoint,
          );
          localOwner = raster;
          input.prep = undefined;
        } else {
          raster = await resolveLayerInputRaster(input, width, height, checkpoint);
          localOwner = raster;
          // The working raster owns the pixels now; drop the job's reference
          // to the transferred source so a prep source never outlives its
          // warp (the request object survives until the job ends).
          input.prep = undefined;
          if (draftScaleDown !== 1) {
            const scaled = resizeRasterNearest(
              raster,
              Math.max(1, Math.round(raster.width * draftScaleDown)),
              Math.max(1, Math.round(raster.height * draftScaleDown)),
            );
            noteAlloc(scaled.data.byteLength, "raster", "layer-raster");
            noteRelease(raster.data.byteLength, "raster", "layer-raster");
            raster = scaled;
            localOwner = scaled;
          }
        }
        if (input.flattenWhite) {
          const flattened = flattenOntoWhite(raster);
          noteAlloc(flattened.data.byteLength, "raster", "layer-raster");
          noteRelease(raster.data.byteLength, "raster", "layer-raster");
          raster = flattened;
          localOwner = flattened;
        }
        rasters[index] = raster;
        localOwner = null;
      } finally {
        if (localOwner) noteRelease(localOwner.data.byteLength, "raster", "layer-raster");
      }
    }
    return raster;
  };
  const layerAlpha = async (index: number): Promise<Float32Array> => {
    let alpha = alphaFields[index];
    if (!alpha) {
      alpha = extractAlphaField(await layerRaster(index));
      alphaFields[index] = alpha;
    }
    return alpha;
  };
  const layerBounds = async (index: number): Promise<ContentBounds> => {
    let bounds = contentBoundsList[index];
    if (!bounds) {
      bounds = visibleContentBounds(await layerRaster(index));
      contentBoundsList[index] = bounds;
    }
    return bounds;
  };

  const draftKeys: (string | null | undefined)[] = job.layers.map(() => undefined);

  try {
    const tiles = draftScaleDown === 1 ? jobTiles(job.tiles, width, height) : jobTiles(undefined, width, height);
    const layerData: LayerPlateData[] = [];
    const composedPlates: ComposedPlateData[] = [];
    const proofInput: Partial<Record<RenderPlateId, ReturnType<typeof composePlate>>> = {};
    const plateCount = Math.max(1, job.plates.length);

    for (let plateIndex = 0; plateIndex < job.plates.length; plateIndex += 1) {
      const plate = job.plates[plateIndex];
      if (hooks.isCancelled()) return null;
      const plateLayers: PlateLayerOutput[] = [];
      /** Ledger-tracked ink fields that die when this plate composes. */
      const plateReleasables: Float32Array[] = [];

      try {
        for (let layerIndex = 0; layerIndex < job.layers.length; layerIndex += 1) {
        const layer = job.layers[layerIndex];
        if (hooks.isCancelled()) return null;
        await hooks.yieldPoint();
        if (!layerPlateVisible(layer, plate)) continue;
        const settings = layer.settings;

        // Draft replay: a cached (layer, plate) contribution skips raster
        // resolution and every kernel. Keys derive from the layer CONTENT
        // (deriveDraftLayerKey), so the unchanged production preview job
        // stream hits the cache with no consumer changes. Cached fields are
        // immutable.
        let cacheKey: string | null = null;
        if (composeCapable && draftCache) {
          if (draftKeys[layerIndex] === undefined) draftKeys[layerIndex] = deriveDraftLayerKey(layer);
          const layerKey = draftKeys[layerIndex];
          if (layerKey !== null) {
            cacheKey = `${layerKey}|${plate}|${width}x${height}|${renderScale}|${job.minimumCellSize}`;
          }
        }
        if (cacheKey) {
          const hit = draftCache!.get(cacheKey);
          if (hit) {
            plateLayers.push({ ink: hit.ink, alpha: hit.alpha, opacity: layer.opacity });
            continue;
          }
        }
        /** Finish a composeCapable layer: cache (drafts) or mark transient. */
        const finishLayer = (ink: Float32Array, inkTracked: boolean, alpha: Float32Array) => {
          if (cacheKey) {
            draftCache!.set(cacheKey, { ink, alpha });
            // Ownership moved to the cache (which self-reports its bytes).
            if (inkTracked) releaseField(ink, "field", "cached-ink");
          } else if (inkTracked) {
            plateReleasables.push(ink);
          }
          plateLayers.push({ ink, alpha, opacity: layer.opacity });
        };
        const raster = await layerRaster(layerIndex);

        if (settings.cleanEnabled) {
          // Clean continuous-tone: the glitched coverage field IS the ink.
          hooks.onProgress("coverage", plate, plateIndex / plateCount);
          const field = await buildCleanFieldCoop(raster, plate, settings, checkpoint);
          let fieldOwned = true;
          try {
            if (composeCapable) {
              const ink = resampleFieldToOutput(field, raster.width, raster.height, width, height);
              if (ink !== field) {
                releaseField(field, "field", "clean-ink");
                fieldOwned = false;
              }
              finishLayer(
                ink,
                ink === field,
                resampleFieldToOutput(await layerAlpha(layerIndex), raster.width, raster.height, width, height),
              );
              if (ink === field) fieldOwned = false;
            } else {
              layerData.push({
                plate,
                layerIndex,
                mode: "clean",
                field: { buffer: field.buffer as ArrayBuffer, width: raster.width, height: raster.height },
                alpha: { buffer: (await layerAlpha(layerIndex)).slice().buffer as ArrayBuffer, width: raster.width, height: raster.height },
              });
              fieldOwned = false;
            }
          } finally {
            if (fieldOwned) releaseField(field, "field", "clean-ink");
          }
        } else if (settings.diffusionEnabled) {
          hooks.onProgress("diffusion", plate, plateIndex / plateCount);
          const field = await buildDiffusionFieldCoop(raster, plate, settings, checkpoint);
          let fieldOwned = true;
          try {
            if (composeCapable) {
              const ink = diffusionInkField(field, raster.width, raster.height, width, height);
              releaseField(field, "field", "diffusion-field");
              fieldOwned = false;
              finishLayer(
                ink,
                false,
                resampleFieldToOutput(await layerAlpha(layerIndex), raster.width, raster.height, width, height),
              );
            } else {
              layerData.push({
                plate,
                layerIndex,
                mode: "diffusion",
                field: { buffer: field.buffer as ArrayBuffer, width: raster.width, height: raster.height },
                alpha: { buffer: (await layerAlpha(layerIndex)).slice().buffer as ArrayBuffer, width: raster.width, height: raster.height },
              });
              fieldOwned = false;
            }
          } finally {
            if (fieldOwned) releaseField(field, "field", "diffusion-field");
          }
        } else {
          hooks.onProgress("coverage", plate, plateIndex / plateCount);
          const field = await buildCoverageFieldCoop(raster, plate, settings, checkpoint);
          let fieldOwned = true;
          let placements: Awaited<ReturnType<typeof collectGridDotsCoop>> | null = null;
          try {
            hooks.onProgress("grid", plate, plateIndex / plateCount);
            const geometry: GridGeometry = {
              width,
              height,
              sourceWidth: raster.width,
              sourceHeight: raster.height,
              cell: effectiveCellSize(settings.cellSize, renderScale, job.minimumCellSize),
              angleDegrees: settings.angles[plate],
            };
            placements = await collectGridDotsCoop(
              field,
              geometry,
              await layerBounds(layerIndex),
              checkpoint,
              job.tile,
            );
            if (composeCapable) {
              releaseField(field, "field", "coverage-field");
              fieldOwned = false;
              // Drafts splat dots without a canvas (documented approximation);
              // exact/export keep the canvas rasterizer's bit parity. Custom
              // stamps always need the canvas.
              const draftSplat = Boolean(draftCache && splatterSupports(layer.dotShape));
              const ink = draftSplat
                ? splatterPlacements(placements, layer.dotShape as Exclude<DotShape, "custom">, layer.strokeWidth * renderScale, width, height)
                : await rasterizePlacementsTiled(placements, layer, width, height, renderScale, tiles, checkpoint);
              let inkOwned = true;
              try {
                finishLayer(
                  ink,
                  true,
                  resampleFieldToOutput(await layerAlpha(layerIndex), raster.width, raster.height, width, height),
                );
                inkOwned = false;
              } finally {
                if (inkOwned) {
                  releaseField(ink, "field", draftSplat ? "draft-splat" : "halftone-ink");
                }
              }
            } else {
              const packed = new Float64Array(placements.length * 3);
              const releasePackedBuild = retainAllocation(
                placements.length * PACKED_PLACEMENT_BYTES_PER_DOT,
                "placements",
                "packed-dot-build",
              );
              try {
                for (let index = 0; index < placements.length; index += 1) {
                  packed[index * 3] = placements[index].x;
                  packed[index * 3 + 1] = placements[index].y;
                  packed[index * 3 + 2] = placements[index].size;
                }
                layerData.push({
                  plate,
                  layerIndex,
                  mode: "halftone",
                  field: { buffer: field.buffer as ArrayBuffer, width: raster.width, height: raster.height },
                  placements: { buffer: packed.buffer as ArrayBuffer, count: placements.length },
                  alpha: { buffer: (await layerAlpha(layerIndex)).slice().buffer as ArrayBuffer, width: raster.width, height: raster.height },
                });
                fieldOwned = false;
              } finally {
                // Sender-side build ownership ends once the payload owns the
                // packed buffer (or construction failed and it is dropped).
                releasePackedBuild();
              }
            }
          } finally {
            placements?.release();
            if (fieldOwned) releaseField(field, "field", "coverage-field");
          }
        }
        }

        if (composeCapable) {
          hooks.onProgress("compose", plate, (plateIndex + 1) / plateCount);
          const composed = composePlate(plateLayers, pixelCount);
          proofInput[plate] = composed;
          composedPlates.push({
            plate,
            inkPremultiplied: { buffer: composed.inkPremultiplied.buffer as ArrayBuffer, width, height },
            alpha: { buffer: composed.alpha.buffer as ArrayBuffer, width, height },
          });
        }
      } finally {
        // Cancellation or any later-layer/compose failure must release the
        // completed layers of this plate too, not only the currently active
        // kernel's locals.
        for (const field of plateReleasables.splice(0)) {
          releaseField(field, "field", "plate-layer-ink");
        }
        plateLayers.length = 0;
      }
    }

    if (hooks.isCancelled()) return null;

    if (!composeCapable) {
      return { form: "layer-data", width, height, layers: layerData };
    }

    let proof: RasterData | null = null;
    if (job.paper) {
      hooks.onProgress("proof", undefined, 1);
      proof = proofCompositeCmyk(proofInput, width, height, job.paper);
    }

    if (job.wantBitmap && proof && supportsCreateImageBitmap()) {
      hooks.onProgress("encode", undefined, 1);
      const imageData = new ImageData(proof.data as Uint8ClampedArray<ArrayBuffer>, width, height);
      // Adaptive drafts upscale back to the requested output inside the
      // bitmap decode, off the consumer's thread.
      const bitmap =
        draftScaleDown === 1
          ? await createImageBitmap(imageData)
          : await createImageBitmap(imageData, {
              resizeWidth: requestedWidth,
              resizeHeight: requestedHeight,
              resizeQuality: "low",
            });
      if (hooks.isCancelled()) {
        bitmap.close();
        return null;
      }
      return {
        form: "bitmap",
        bitmap,
        width: requestedWidth,
        height: requestedHeight,
        ...(draftScaleDown !== 1 ? { draftScaleDown } : {}),
      };
    }

    if (draftScaleDown !== 1) {
      // Plates/proof upscale to the requested output so the payload keeps
      // the protocol contract for any consumer.
      const upscaled: ComposedPlateData[] = composedPlates.map((plate) => ({
        plate: plate.plate,
        inkPremultiplied: {
          buffer: resampleFieldToOutput(
            new Float32Array(plate.inkPremultiplied.buffer),
            width,
            height,
            requestedWidth,
            requestedHeight,
          ).buffer as ArrayBuffer,
          width: requestedWidth,
          height: requestedHeight,
        },
        alpha: {
          buffer: resampleFieldToOutput(
            new Float32Array(plate.alpha.buffer),
            width,
            height,
            requestedWidth,
            requestedHeight,
          ).buffer as ArrayBuffer,
          width: requestedWidth,
          height: requestedHeight,
        },
      }));
      const upscaledProof = proof ? resizeRasterNearest(proof, requestedWidth, requestedHeight) : null;
      return {
        form: "plates",
        width: requestedWidth,
        height: requestedHeight,
        plates: upscaled,
        proof: upscaledProof
          ? { buffer: upscaledProof.data.buffer as ArrayBuffer, width: requestedWidth, height: requestedHeight }
          : undefined,
        draftScaleDown,
      };
    }

    return {
      form: "plates",
      width,
      height,
      plates: composedPlates,
      proof: proof ? { buffer: proof.data.buffer as ArrayBuffer, width, height } : undefined,
    };
  } catch (error) {
    if (error === JOB_ABORT) return null;
    throw error;
  } finally {
    releaseInputs();
  }
}
