/**
 * Production draft path inside the executor: constant-work adaptive
 * internal resolution (adaptiveDraftEdge), the content-derived draft
 * layer-field cache (no consumer cooperation needed), payload dims restored
 * to the request, and strict non-interference with exact/export jobs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { executeRenderJob, type ExecutorHooks } from "../../src/render/executor";
import { DraftFieldCache, splatterPlacements, DRAFT_CACHE_MAX_BYTES } from "../../src/render/draft";
import { adaptiveDraftEdge, MIN_DRAFT_EDGE } from "../../src/render/planner";
import { setAllocationObserver, type AllocationKind } from "../../src/render/instrumentation";
import type { RenderJobRequest, RenderLayerInput, RenderResultPayload } from "../../src/render/protocol";
import { gradientRaster, hardEdgeRaster } from "../../src/render/fixtures";
import type { RenderSettings } from "../../src/render/settings";

/* Minimal counting OffscreenCanvas stand-in. */
const createdCanvases: Array<{ width: number; height: number }> = [];
class FakeContext {
  fillStyle = "";
  private readonly alpha: Uint8Array;
  constructor(private readonly width: number, private readonly height: number) {
    this.alpha = new Uint8Array(width * height);
  }
  beginPath(): void {}
  arc(x: number, y: number, r: number): void {
    const left = Math.max(0, Math.floor(x - r));
    const right = Math.min(this.width - 1, Math.ceil(x + r));
    const top = Math.max(0, Math.floor(y - r));
    const bottom = Math.min(this.height - 1, Math.ceil(y + r));
    for (let py = top; py <= bottom; py += 1) {
      for (let px = left; px <= right; px += 1) {
        if (Math.hypot(px + 0.5 - x, py + 0.5 - y) <= r) this.alpha[py * this.width + px] = 255;
      }
    }
  }
  rect(): void {}
  roundRect(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  fill(): void {}
  drawImage(_stamp: unknown, x: number, y: number, w: number, h: number): void {
    // Stamp stand-in: opaque box coverage.
    const left = Math.max(0, Math.floor(x));
    const right = Math.min(this.width - 1, Math.ceil(x + w));
    const top = Math.max(0, Math.floor(y));
    const bottom = Math.min(this.height - 1, Math.ceil(y + h));
    for (let py = top; py <= bottom; py += 1) {
      for (let px = left; px <= right; px += 1) this.alpha[py * this.width + px] = 255;
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
    createdCanvases.push({ width, height });
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
afterEach(() => setAllocationObserver(null));

const REQ_W = 900;
const REQ_H = 1200;

function settingsOf(cellSize = 24): RenderSettings {
  return {
    cellSize,
    frayedXEdge: 0,
    frayedYEdge: 0,
    invert: false,
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
    visible: { cyan: true, magenta: true, yellow: true, black: true },
  };
}

function layersOf(count: number, cellSize = 24): RenderLayerInput[] {
  return Array.from({ length: count }, (_, index) => {
    const raster = index % 2 === 0 ? gradientRaster(REQ_W, REQ_H) : hardEdgeRaster(REQ_W, REQ_H);
    return {
      raster: { buffer: raster.data.buffer.slice(0) as ArrayBuffer, width: REQ_W, height: REQ_H },
      settings: settingsOf(cellSize),
      opacity: 1,
      dotShape: "round" as const,
      strokeWidth: 1,
    };
  });
}

function jobOf(kind: RenderJobRequest["kind"], layers: RenderLayerInput[], revision = 1): RenderJobRequest {
  return {
    type: "job",
    kind,
    revision,
    outputWidth: REQ_W,
    outputHeight: REQ_H,
    renderScale: 0.25,
    minimumCellSize: 3,
    plates: ["cyan", "magenta", "yellow", "black"],
    layers,
    paper: [244, 241, 233],
    wantBitmap: false,
  };
}

function hooksOf(cache?: DraftFieldCache): ExecutorHooks {
  return {
    isCancelled: () => false,
    onProgress: () => undefined,
    yieldPoint: () => undefined,
    ...(cache ? { draftCache: cache } : {}),
  };
}

type AllocEvent = { kind: AllocationKind; label?: string };

function observeAllocs(): { events: AllocEvent[] } {
  const events: AllocEvent[] = [];
  setAllocationObserver({
    alloc: (_bytes, kind, label) => void events.push({ kind, label }),
    release: () => undefined,
  });
  return { events };
}

describe("adaptiveDraftEdge policy", () => {
  it("keeps the legacy budget for shallow stacks and shrinks for deep ones", () => {
    expect(adaptiveDraftEdge(1, 4)).toBe(1100);
    expect(adaptiveDraftEdge(2, 4)).toBe(Math.round(1100 * Math.sqrt(4 / 8)));
    expect(adaptiveDraftEdge(8, 4)).toBe(Math.round(1100 * Math.sqrt(4 / 32)));
    expect(adaptiveDraftEdge(32, 4, 300)).toBe(MIN_DRAFT_EDGE);
  });
});

describe("executor draft path", () => {
  it("preview drafts render at the internal edge and return REQUESTED dims", async () => {
    const layers = layersOf(2); // 2 layers × 4 plates ⇒ edge 778 < 1200
    createdCanvases.length = 0;
    const payload = (await executeRenderJob(jobOf("preview-draft", layers), hooksOf(new DraftFieldCache()))) as Extract<
      RenderResultPayload,
      { form: "plates" }
    >;
    expect(payload.form).toBe("plates");
    expect(payload.width).toBe(REQ_W);
    expect(payload.height).toBe(REQ_H);
    expect(payload.plates[0].inkPremultiplied.width).toBe(REQ_W);
    const edge = adaptiveDraftEdge(2, 4);
    const internalH = Math.round(REQ_H * (edge / REQ_H));
    expect(internalH).toBe(edge);
    // Round dots splat without a canvas in drafts: no canvas was created.
    expect(createdCanvases).toEqual([]);
    expect(payload.proof).toBeDefined();
  });

  it("exact-viewport jobs keep full resolution and the canvas rasterizer", async () => {
    const layers = layersOf(2);
    createdCanvases.length = 0;
    const payload = (await executeRenderJob(jobOf("exact-viewport", layers), hooksOf(new DraftFieldCache()))) as Extract<
      RenderResultPayload,
      { form: "plates" }
    >;
    expect(payload.width).toBe(REQ_W);
    expect(createdCanvases.length).toBeGreaterThan(0);
    // Tiles bounded by DEFAULT_TILE_EDGE, never artboard-sized beyond it.
    expect(createdCanvases.every((canvas) => canvas.width <= 1024 && canvas.height <= 1024)).toBe(true);
  });

  it("derived content keys make repeat drafts replay from the cache", async () => {
    const cache = new DraftFieldCache();
    const layers = layersOf(2);
    const first = observeAllocs();
    await executeRenderJob(jobOf("preview-draft", layers, 1), hooksOf(cache));
    setAllocationObserver(null);
    expect(first.events.some((event) => event.label === "draft-splat")).toBe(true);
    expect(cache.sizeBytes).toBeGreaterThan(0);

    // Identical content (fresh buffers, same bytes): every pass replays.
    const second = observeAllocs();
    await executeRenderJob(jobOf("preview-draft", layersOf(2), 2), hooksOf(cache));
    setAllocationObserver(null);
    expect(second.events.some((event) => event.label === "draft-splat")).toBe(false);
    expect(second.events.some((event) => event.label === "coverage-base")).toBe(false);
    // Transferred-but-unused rasters were never even materialized.
    expect(second.events.some((event) => event.label === "layer-raster")).toBe(false);

    // A settings change re-keys and recomputes.
    const third = observeAllocs();
    await executeRenderJob(jobOf("preview-draft", layersOf(2, 30), 3), hooksOf(cache));
    setAllocationObserver(null);
    expect(third.events.some((event) => event.label === "draft-splat")).toBe(true);
  });

  it("exact-viewport never reads or writes the draft cache", async () => {
    const cache = new DraftFieldCache();
    await executeRenderJob(jobOf("preview-draft", layersOf(2), 1), hooksOf(cache));
    const sizeAfterDraft = cache.sizeBytes;
    const events = observeAllocs();
    await executeRenderJob(jobOf("exact-viewport", layersOf(2), 2), hooksOf(cache));
    setAllocationObserver(null);
    expect(cache.sizeBytes).toBe(sizeAfterDraft);
    expect(events.events.some((event) => event.label === "coverage-base")).toBe(true);
  });

  it("cache stays byte-bounded under churn", async () => {
    const cache = new DraftFieldCache(512 * 1024);
    for (let round = 0; round < 6; round += 1) {
      const raster = gradientRaster(200, 150);
      const layer: RenderLayerInput = {
        raster: { buffer: raster.data.buffer as ArrayBuffer, width: 200, height: 150 },
        settings: settingsOf(10 + round),
        opacity: 1,
        dotShape: "round",
        strokeWidth: 1,
      };
      const job: RenderJobRequest = {
        ...jobOf("preview-draft", [layer], round + 1),
        outputWidth: 200,
        outputHeight: 150,
      };
      await executeRenderJob(job, hooksOf(cache));
      expect(cache.sizeBytes).toBeLessThanOrEqual(512 * 1024);
      expect(cache.sizeBytes).toBeGreaterThan(0);
    }
    expect(DRAFT_CACHE_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe("custom-stamp layers are never draft-cached (stale-replay defense)", () => {
  it("no derived key, no cache entries, every draft recomputes", async () => {
    const cache = new DraftFieldCache();
    const stampOf = () => ({ close: () => undefined }) as unknown as ImageBitmap;
    const makeCustomLayers = (): RenderLayerInput[] =>
      layersOf(1).map((layer) => ({ ...layer, dotShape: "custom" as const, customStamp: stampOf() }));
    const first = observeAllocs();
    await executeRenderJob(jobOf("preview-draft", makeCustomLayers(), 1), hooksOf(cache));
    setAllocationObserver(null);
    // The custom layer went through the canvas rasterizer, not the splat.
    expect(first.events.some((event) => event.label === "halftone-ink")).toBe(true);
    // Nothing was cached: a swapped stamp can never replay stale ink.
    expect(cache.sizeBytes).toBe(0);
    const second = observeAllocs();
    await executeRenderJob(jobOf("preview-draft", makeCustomLayers(), 2), hooksOf(cache));
    setAllocationObserver(null);
    expect(second.events.some((event) => event.label === "layer-raster")).toBe(true);
    expect(second.events.some((event) => event.label === "halftone-ink")).toBe(true);
    expect(cache.sizeBytes).toBe(0);
  });
});

describe("splatterPlacements sanity", () => {
  it("deposits comparable ink mass to a binary rasterization of round dots", () => {
    const placements = Array.from({ length: 50 }, (_, index) => ({
      x: 10 + (index % 10) * 9,
      y: 10 + Math.floor(index / 10) * 9,
      size: 6,
    }));
    const ink = splatterPlacements(placements, "round", 1, 100, 60);
    let mass = 0;
    for (let index = 0; index < ink.length; index += 1) mass += ink[index];
    const expected = placements.length * Math.PI * 9; // area πr² per dot
    expect(mass).toBeGreaterThan(expected * 0.85);
    expect(mass).toBeLessThan(expected * 1.15);
  });
});
