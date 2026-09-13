/**
 * WorkerRenderService end-to-end against MainThreadRenderer: a small
 * multi-layer project (halftone + clean + diffusion, opacity, placement)
 * rendered through the REAL production RenderService binding.
 *
 * Covered: composite (white matte, black matte, transparent alpha-union),
 * plate rasters (ink-in-alpha convention + registration final pass),
 * selected-layer cutouts, single-shot vs streamed vs proof-derivation
 * bit-identity (budget overrides force each path), cancel mid-render,
 * monotonic progress, 240-DPI plumbing via the orchestrator, and genuine
 * multi-layer SVG plates.
 *
 * Node has no OffscreenCanvas; the deterministic stand-in mirrors
 * tests/unit/render-streaming-equivalence.test.ts so halftone dots
 * rasterize identically on every path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LayerV1, ProjectCoreV1, Sha256 } from "../../src/core/types";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import {
  estimateSingleShotPeakBytes,
  estimateStreamedPeakBytes,
  type RenderPlanInput,
} from "../../src/render/planner";
import {
  createWorkerRenderService,
  type WorkerRenderSources,
} from "../../src/export/worker-render-service";
import type { RasterData, RenderRequestOptions } from "../../src/export/orchestrator";

/* ------------------------------------------------------------------ */
/* Deterministic OffscreenCanvas stand-in (see streaming-equivalence)  */
/* ------------------------------------------------------------------ */

type FakePathShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "circle"; x: number; y: number; radius: number }
  | { kind: "polygon"; points: Array<[number, number]> };

class FakeContext2D {
  fillStyle = "";
  private shapes: FakePathShape[] = [];
  private polygon: Array<[number, number]> | null = null;
  private readonly alpha: Uint8Array;

  constructor(private readonly width: number, private readonly height: number) {
    this.alpha = new Uint8Array(width * height);
  }

  beginPath(): void {
    this.shapes = [];
    this.polygon = null;
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.shapes.push({ kind: "rect", x, y, width, height });
  }

  roundRect(x: number, y: number, width: number, height: number): void {
    this.rect(x, y, width, height);
  }

  arc(x: number, y: number, radius: number): void {
    this.shapes.push({ kind: "circle", x, y, radius });
  }

  moveTo(x: number, y: number): void {
    this.polygon = [[x, y]];
  }

  lineTo(x: number, y: number): void {
    this.polygon?.push([x, y]);
  }

  closePath(): void {
    if (this.polygon) {
      this.shapes.push({ kind: "polygon", points: this.polygon });
      this.polygon = null;
    }
  }

  fill(): void {
    for (const shape of this.shapes) this.paint(shape);
  }

  drawImage(): void {
    throw new Error("custom stamps are not exercised by this suite");
  }

  getImageData(_x: number, _y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < this.alpha.length; index += 1) {
      data[index * 4 + 3] = this.alpha[index];
    }
    return { data, width, height };
  }

  private paint(shape: FakePathShape): void {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    if (shape.kind === "rect") {
      minX = shape.x; maxX = shape.x + shape.width;
      minY = shape.y; maxY = shape.y + shape.height;
    } else if (shape.kind === "circle") {
      minX = shape.x - shape.radius; maxX = shape.x + shape.radius;
      minY = shape.y - shape.radius; maxY = shape.y + shape.radius;
    } else {
      minX = Math.min(...shape.points.map((point) => point[0]));
      maxX = Math.max(...shape.points.map((point) => point[0]));
      minY = Math.min(...shape.points.map((point) => point[1]));
      maxY = Math.max(...shape.points.map((point) => point[1]));
    }
    const left = Math.max(0, Math.floor(minX));
    const right = Math.min(this.width - 1, Math.ceil(maxX));
    const top = Math.max(0, Math.floor(minY));
    const bottom = Math.min(this.height - 1, Math.ceil(maxY));
    for (let pixelY = top; pixelY <= bottom; pixelY += 1) {
      for (let pixelX = left; pixelX <= right; pixelX += 1) {
        if (this.inside(shape, pixelX + 0.5, pixelY + 0.5)) {
          this.alpha[pixelY * this.width + pixelX] = 255;
        }
      }
    }
  }

  private inside(shape: FakePathShape, x: number, y: number): boolean {
    if (shape.kind === "rect") {
      return x >= shape.x && x < shape.x + shape.width && y >= shape.y && y < shape.y + shape.height;
    }
    if (shape.kind === "circle") {
      const dx = x - shape.x;
      const dy = y - shape.y;
      return dx * dx + dy * dy <= shape.radius * shape.radius;
    }
    let hit = false;
    const { points } = shape;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[previous];
      if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) hit = !hit;
    }
    return hit;
  }
}

class FakeOffscreenCanvas {
  private readonly context: FakeContext2D;

  constructor(width: number, height: number) {
    this.context = new FakeContext2D(width, height);
  }

  getContext(id: string): FakeContext2D | null {
    return id === "2d" ? this.context : null;
  }
}

const globalScope = globalThis as { OffscreenCanvas?: unknown };

beforeAll(() => {
  globalScope.OffscreenCanvas = FakeOffscreenCanvas;
});

afterAll(() => {
  delete globalScope.OffscreenCanvas;
});

/* ------------------------------------------------------------------ */
/* Project fixture                                                     */
/* ------------------------------------------------------------------ */

const WIDTH = 44;
const HEIGHT = 30;
const ASSET_A: Sha256 = "a".repeat(64);
const ASSET_B: Sha256 = "b".repeat(64);
const ASSET_C: Sha256 = "c".repeat(64);

function makeRaster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = alpha;
    }
  }
  return { data, width, height };
}

const ASSETS = new Map<Sha256, RasterData>([
  // Full-artboard gradient (halftone base layer).
  [
    ASSET_A,
    makeRaster(WIDTH, HEIGHT, (x, y) => [
      Math.round((x / (WIDTH - 1)) * 255),
      Math.round((y / (HEIGHT - 1)) * 255),
      Math.round(((x + y) / (WIDTH + HEIGHT - 2)) * 255),
      255,
    ]),
  ],
  // Small opaque dark block (clean layer).
  [ASSET_B, makeRaster(12, 8, () => [30, 45, 60, 255])],
  // Half-transparent noise (diffusion layer).
  [
    ASSET_C,
    makeRaster(16, 12, (x, y) => [
      (x * 37) % 256,
      (y * 53) % 256,
      (x * 11 + y * 7) % 256,
      x < 8 ? 255 : 0,
    ]),
  ],
]);

function baseRecipe(): LayerV1["recipe"] {
  return {
    mode: "halftone",
    halftone: {
      cellSize: 5,
      dotShape: "round",
      customShapeAssetId: null,
      invert: false,
      strokeWidth: 1,
      frayedXEdge: 0,
      frayedYEdge: 0,
    },
    diffusion: {
      algorithm: "stucki",
      modulation: "none",
      modStrength: 0.5,
      intensity: 0.9,
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
  };
}

function makeLayer(
  id: string,
  assetId: Sha256,
  position: { x: number; y: number },
  overrides: Partial<LayerV1> = {},
): LayerV1 {
  return {
    id,
    name: id,
    assetId,
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: {
      position,
      scale: { x: 1, y: 1 },
      rotation: 0,
      flipH: false,
      flipV: false,
      skew: { x: 0, y: 0 },
      perspective: null,
    },
    recipe: baseRecipe(),
    ...overrides,
  };
}

function makeCore(layers: LayerV1[], overrides: Partial<ProjectCoreV1> = {}): ProjectCoreV1 {
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
    ...overrides,
  };
}

function makeStack(): LayerV1[] {
  const halftone = makeLayer("layer-halftone", ASSET_A, { x: WIDTH / 2, y: HEIGHT / 2 });
  const clean = makeLayer("layer-clean", ASSET_B, { x: 12, y: 10 }, { opacity: 0.6 });
  clean.recipe.mode = "clean";
  const diffusion = makeLayer("layer-diffusion", ASSET_C, { x: 30, y: 18 }, { opacity: 0.8 });
  diffusion.recipe.mode = "diffusion";
  return [halftone, clean, diffusion];
}

const SOURCES: WorkerRenderSources = {
  async resolveRaster(assetId) {
    const raster = ASSETS.get(assetId);
    if (!raster) throw new Error(`missing asset ${assetId}`);
    return raster;
  },
};

function makeService(renderBudgetBytes?: number) {
  return createWorkerRenderService({
    sources: SOURCES,
    createPort: () => new MainThreadRenderer(false),
    ...(renderBudgetBytes !== undefined ? { renderBudgetBytes } : {}),
  });
}

function requestOptions(overrides: Partial<RenderRequestOptions> = {}): RenderRequestOptions {
  return {
    revision: 7,
    registration: false,
    matte: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Budget landmarks for forcing each render path at this fixture size. */
function budgets() {
  const input: RenderPlanInput = {
    sampleWidth: WIDTH,
    sampleHeight: HEIGHT,
    outputWidth: WIDTH,
    outputHeight: HEIGHT,
    plateCount: 4,
    layerCount: 3,
  };
  const singleShotWithProof = estimateSingleShotPeakBytes({ ...input, wantsProof: true });
  const streamedNoProof = estimateStreamedPeakBytes(input, HEIGHT);
  const streamedWithProof = estimateStreamedPeakBytes({ ...input, wantsProof: true }, HEIGHT);
  expect(streamedNoProof).toBeLessThan(streamedWithProof);
  expect(streamedWithProof).toBeLessThan(singleShotWithProof);
  return {
    // Streamed session CAN carry the proof, single-shot cannot run.
    inSessionProof: Math.floor((streamedWithProof + singleShotWithProof) / 2),
    // Even the proof-carrying streamed form does not fit: derive from bands.
    deriveProof: Math.floor((streamedNoProof + streamedWithProof) / 2),
  };
}

/* ------------------------------------------------------------------ */
/* Composite                                                           */
/* ------------------------------------------------------------------ */

describe("WorkerRenderService: composite", () => {
  it("single-shot, in-session streamed proof, and derived proof are bit-identical", async () => {
    const core = makeCore(makeStack());
    const { inSessionProof, deriveProof } = budgets();
    const options = () => requestOptions({ matte: "#ffffff" });
    const viaSingleShot = await makeService().renderComposite(core, options());
    const viaSessionProof = await makeService(inSessionProof).renderComposite(core, options());
    const viaDerived = await makeService(deriveProof).renderComposite(core, options());
    expect(viaSingleShot.width).toBe(WIDTH);
    expect(viaSingleShot.height).toBe(HEIGHT);
    expect([...viaSessionProof.data]).toEqual([...viaSingleShot.data]);
    expect([...viaDerived.data]).toEqual([...viaSingleShot.data]);
    // White matte: opaque, and some ink darkened the sheet.
    for (let index = 3; index < viaSingleShot.data.length; index += 4) {
      expect(viaSingleShot.data[index]).toBe(255);
    }
    expect(viaSingleShot.data.some((value, index) => index % 4 === 0 && value < 250)).toBe(true);
  }, 30_000);

  it("transparent composite alpha is composed layer coverage: opaque under a full-artboard opaque layer", async () => {
    // makeStack's bottom layer is a full-artboard opaque source, so under the
    // composed-layer-alpha contract every pixel carries alpha 255 regardless
    // of how much ink lands there.
    const core = makeCore(makeStack());
    const raster = await makeService().renderComposite(core, requestOptions({ matte: null }));
    for (let index = 0; index < raster.data.length; index += 4) {
      expect(raster.data[index + 3]).toBe(255);
    }
  });

  it("transparent composite over a centered transparent clean source sees both clear and opaque", async () => {
    const layer = makeLayer("layer-clean-c", ASSET_C, { x: WIDTH / 2, y: HEIGHT / 2 });
    layer.recipe.mode = "clean";
    const core = makeCore([layer]);
    const raster = await makeService().renderComposite(core, requestOptions({ matte: null }));
    let sawTransparent = false;
    let sawOpaque = false;
    for (let index = 0; index < raster.data.length; index += 4) {
      const alpha = raster.data[index + 3];
      if (alpha === 0) sawTransparent = true;
      if (alpha === 255) sawOpaque = true;
    }
    expect(sawTransparent).toBe(true); // uncovered artboard stays clear
    expect(sawOpaque).toBe(true); // the source's opaque half is opaque
  });

  it("black matte flattens the over-white color onto black", async () => {
    // Use the transparent-source case so uncovered pixels genuinely exist;
    // a full-artboard opaque stack would make the uncovered branch vacuous.
    const layer = makeLayer("layer-clean-c", ASSET_C, { x: WIDTH / 2, y: HEIGHT / 2 });
    layer.recipe.mode = "clean";
    const core = makeCore([layer]);
    const raster = await makeService().renderComposite(core, requestOptions({ matte: "#000000" }));
    const transparentReference = await makeService().renderComposite(
      core,
      requestOptions({ matte: null }),
    );
    let uncoveredChecked = 0;
    for (let index = 0; index < raster.data.length; index += 4) {
      expect(raster.data[index + 3]).toBe(255);
      if (transparentReference.data[index + 3] === 0) {
        expect(raster.data[index]).toBe(0);
        expect(raster.data[index + 1]).toBe(0);
        expect(raster.data[index + 2]).toBe(0);
        uncoveredChecked += 1;
      }
    }
    expect(uncoveredChecked).toBeGreaterThan(0);
  });

  it("reports monotonic progress ending at 1", async () => {
    const core = makeCore(makeStack());
    const fractions: number[] = [];
    await makeService().renderComposite(
      core,
      requestOptions({ matte: "#ffffff", onProgress: (fraction) => fractions.push(fraction) }),
    );
    expect(fractions.length).toBeGreaterThan(1);
    for (let index = 1; index < fractions.length; index += 1) {
      expect(fractions[index]).toBeGreaterThanOrEqual(fractions[index - 1]);
    }
    expect(fractions.at(-1)).toBe(1);
  });

  it("cancel mid-render rejects with export-cancelled (single-shot and streamed)", async () => {
    const core = makeCore(makeStack());
    for (const budget of [undefined, budgets().deriveProof]) {
      const controller = new AbortController();
      let aborted = false;
      const pending = makeService(budget).renderComposite(
        core,
        requestOptions({
          matte: "#ffffff",
          signal: controller.signal,
          onProgress: () => {
            if (!aborted) {
              aborted = true;
              controller.abort();
            }
          },
        }),
      );
      await expect(pending).rejects.toMatchObject({ code: "export-cancelled" });
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Plates and selected layer                                           */
/* ------------------------------------------------------------------ */

describe("WorkerRenderService: plates and selected layer", () => {
  it("plate rasters carry ink in alpha over constant ink RGB, streamed == single-shot", async () => {
    const core = makeCore(makeStack());
    const single = await makeService().renderPlate(core, "cyan", requestOptions());
    const streamed = await makeService(budgets().deriveProof).renderPlate(
      core,
      "cyan",
      requestOptions(),
    );
    expect([...streamed.data]).toEqual([...single.data]);
    let inked = 0;
    for (let index = 0; index < single.data.length; index += 4) {
      expect(single.data[index]).toBe(0x11);
      expect(single.data[index + 1]).toBe(0x12);
      expect(single.data[index + 2]).toBe(0x14);
      if (single.data[index + 3] > 0) inked += 1;
    }
    expect(inked).toBeGreaterThan(0);
    expect(inked).toBeLessThan(WIDTH * HEIGHT); // not a solid field
  }, 30_000);

  it("paints the registration final pass into plate rasters", async () => {
    const core = makeCore(makeStack());
    const plain = await makeService().renderPlate(core, "yellow", requestOptions());
    const marked = await makeService().renderPlate(
      core,
      "yellow",
      requestOptions({ registration: true }),
    );
    expect([...marked.data]).not.toEqual([...plain.data]);
    // Known crosshair pixel of the top-left corner mark (offset 14, size 7).
    const index = (8 * WIDTH + 14) * 4;
    expect(marked.data[index + 3]).toBeGreaterThan(0);
    expect(plain.data[index + 3]).toBe(0);
  });

  it("refuses custom registration shapes with a stable code", async () => {
    const core = makeCore(makeStack());
    core.registration.customShapeAssetId = "d".repeat(64);
    await expect(
      makeService().renderPlate(core, "cyan", requestOptions({ registration: true })),
    ).rejects.toMatchObject({ code: "registration-shape-unsupported" });
  });

  it("selected-layer renders exactly one layer, transparent, placement preserved", async () => {
    const stack = makeStack();
    const core = makeCore(stack);
    const raster = await makeService().renderLayer(core, "layer-clean", requestOptions());
    // The clean block occupies x 6..17, y 6..13 (12x8 centered at 12,10);
    // everything outside must be fully transparent.
    let inside = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const alpha = raster.data[(y * WIDTH + x) * 4 + 3];
        const inBlock = x >= 6 && x < 18 && y >= 6 && y < 14;
        if (!inBlock) expect(alpha).toBe(0);
        else if (alpha > 0) inside += 1;
      }
    }
    expect(inside).toBeGreaterThan(0);
  });

  it("includes a hidden layer in selected-layer export", async () => {
    const stack = makeStack();
    stack[1].visible = false;
    const core = makeCore(stack);
    const raster = await makeService().renderLayer(core, "layer-clean", requestOptions());
    expect(raster.data.some((_, index) => index % 4 === 3 && raster.data[index] > 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Vector plates                                                       */
/* ------------------------------------------------------------------ */

describe("WorkerRenderService: SVG plates", () => {
  function vectorCore(): ProjectCoreV1 {
    // Two non-overlapping halftone layers.
    const left = makeLayer("layer-left", ASSET_B, { x: 8, y: 8 });
    const right = makeLayer("layer-right", ASSET_B, { x: 32, y: 20 }, { opacity: 0.5 });
    return makeCore([left, right]);
  }

  it("emits genuine multi-layer vector plates with per-layer opacity groups", async () => {
    const svg = await makeService().renderPlateSvg(vectorCore(), "black", requestOptions());
    expect(svg).toContain(`viewBox="0 0 ${WIDTH} ${HEIGHT}"`);
    expect(svg).toContain(`width="${(WIDTH / 240).toFixed(4)}in"`);
    const groups = svg.match(/<g fill="#000000" stroke="none" opacity="[^"]+">/g) ?? [];
    expect(groups).toHaveLength(2);
    expect(svg).toContain('opacity="0.5"');
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("<image");
  });

  it("adds built-in registration marks as a stroke group", async () => {
    const svg = await makeService().renderPlateSvg(
      vectorCore(),
      "black",
      requestOptions({ registration: true }),
    );
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toMatch(/<g fill="none" stroke="#000000" stroke-width="1">/);
  });

  it("emits diffusion run-length rects for a single diffusion layer", async () => {
    const layer = makeLayer("layer-d", ASSET_C, { x: WIDTH / 2, y: HEIGHT / 2 });
    layer.recipe.mode = "diffusion";
    const svg = await makeService().renderPlateSvg(makeCore([layer]), "black", requestOptions());
    expect(svg).toContain('height="1.25"');
    expect(svg).not.toContain("<circle");
  });

  it("refuses clean layers and multi-layer diffusion stacks", async () => {
    const cleanLayer = makeLayer("layer-c", ASSET_B, { x: 8, y: 8 });
    cleanLayer.recipe.mode = "clean";
    await expect(
      makeService().renderPlateSvg(makeCore([cleanLayer]), "black", requestOptions()),
    ).rejects.toMatchObject({ code: "vector-ineligible" });

    const diffusionLayer = makeLayer("layer-d", ASSET_C, { x: 30, y: 20 });
    diffusionLayer.recipe.mode = "diffusion";
    const halftoneLayer = makeLayer("layer-h", ASSET_B, { x: 8, y: 8 });
    await expect(
      makeService().renderPlateSvg(
        makeCore([halftoneLayer, diffusionLayer]),
        "black",
        requestOptions(),
      ),
    ).rejects.toMatchObject({ code: "vector-ineligible" });
  });
});

/* ------------------------------------------------------------------ */
/* Crash / fallback semantics and capability gaps (wave G1)            */
/* ------------------------------------------------------------------ */

import type { RenderWorkerEvent, StreamingRenderPort } from "../../src/render/protocol";

/** A port whose channel dies mid-job: accepts requests, then reports the
 *  worker-crashed condition exactly as WorkerRenderPort does (revision null). */
class MidJobCrashPort implements StreamingRenderPort {
  private readonly listeners = new Set<(event: RenderWorkerEvent) => void>();
  submitted = 0;

  private crash(): void {
    setTimeout(() => {
      for (const listener of [...this.listeners]) {
        listener({
          type: "error",
          revision: null,
          code: "worker-crashed",
          message: "The export render worker crashed and was replaced.",
        });
      }
    }, 0);
  }

  submit(): void {
    this.submitted += 1;
    this.crash();
  }
  beginExport(): void {
    this.submitted += 1;
    this.crash();
  }
  submitLayer(): void {}
  finalizeExport(): void {}
  ackBand(): void {}
  cancel(): void {}
  dispose(): void {}
  onEvent(listener: (event: RenderWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/** A port whose postMessage layer throws synchronously on first use. */
class ThrowingSubmitPort extends MidJobCrashPort {
  override submit(): void {
    throw new TypeError("postMessage failed: object could not be cloned");
  }
  override beginExport(): void {
    throw new TypeError("postMessage failed: object could not be cloned");
  }
}

describe("WorkerRenderService: crash and fallback semantics", () => {
  const core = () => makeCore(makeStack());

  async function healthyReference(): Promise<RasterData> {
    return makeService().renderComposite(core(), requestOptions({ matte: "#ffffff" }));
  }

  it("worker CONSTRUCTOR throw falls back exactly once and completes", async () => {
    let constructorCalls = 0;
    let fallbackCalls = 0;
    const service = createWorkerRenderService({
      sources: SOURCES,
      createPort: () => {
        constructorCalls += 1;
        throw new Error("Worker constructor blew up");
      },
      createFallbackPort: () => {
        fallbackCalls += 1;
        return new MainThreadRenderer(false);
      },
    });
    const raster = await service.renderComposite(core(), requestOptions({ matte: "#ffffff" }));
    expect(constructorCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    const reference = await healthyReference();
    expect(Buffer.from(raster.data).equals(Buffer.from(reference.data))).toBe(true);
  });

  it("synchronous postMessage throw falls back exactly once and completes", async () => {
    let fallbackCalls = 0;
    const service = createWorkerRenderService({
      sources: SOURCES,
      createPort: () => new ThrowingSubmitPort(),
      createFallbackPort: () => {
        fallbackCalls += 1;
        return new MainThreadRenderer(false);
      },
    });
    const raster = await service.renderComposite(core(), requestOptions({ matte: "#ffffff" }));
    expect(fallbackCalls).toBe(1);
    const reference = await healthyReference();
    expect(Buffer.from(raster.data).equals(Buffer.from(reference.data))).toBe(true);
  });

  it("mid-job crash reissues the frozen work exactly once with fresh state", async () => {
    const crashPorts: MidJobCrashPort[] = [];
    let fallbackCalls = 0;
    const service = createWorkerRenderService({
      sources: SOURCES,
      createPort: () => {
        const port = new MidJobCrashPort();
        crashPorts.push(port);
        return port;
      },
      createFallbackPort: () => {
        fallbackCalls += 1;
        return new MainThreadRenderer(false);
      },
    });
    // Transparent composite exercises the collector: the retry must fold
    // into a FRESH collector, so bytes match the healthy transparent run.
    const raster = await service.renderComposite(core(), requestOptions({ matte: null }));
    expect(crashPorts.length).toBe(1);
    expect(crashPorts[0].submitted).toBe(1);
    expect(fallbackCalls).toBe(1);
    const reference = await makeService().renderComposite(core(), requestOptions({ matte: null }));
    expect(Buffer.from(raster.data).equals(Buffer.from(reference.data))).toBe(true);
  });

  it("a second crash surfaces — no infinite retry, no silent loss", async () => {
    let attempts = 0;
    const service = createWorkerRenderService({
      sources: SOURCES,
      createPort: () => {
        attempts += 1;
        return new MidJobCrashPort();
      },
      createFallbackPort: () => {
        attempts += 1;
        return new MidJobCrashPort();
      },
    });
    await expect(
      service.renderComposite(core(), requestOptions()),
    ).rejects.toMatchObject({ code: "worker-crashed" });
    expect(attempts).toBe(2);
  });

  it("cancellation is never retried through the fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    let fallbackCalls = 0;
    const service = createWorkerRenderService({
      sources: SOURCES,
      createPort: () => new MainThreadRenderer(false),
      createFallbackPort: () => {
        fallbackCalls += 1;
        return new MainThreadRenderer(false);
      },
    });
    await expect(
      service.renderComposite(core(), requestOptions({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "export-cancelled" });
    expect(fallbackCalls).toBe(0);
  });
});

describe("WorkerRenderService: capability gaps close BEFORE execution", () => {
  it("halftone raster export without OffscreenCanvas is refused before any decode", async () => {
    let decodes = 0;
    let ports = 0;
    const service = createWorkerRenderService({
      sources: {
        resolveRaster: async (assetId) => {
          decodes += 1;
          return SOURCES.resolveRaster(assetId);
        },
      },
      createPort: () => {
        ports += 1;
        return new MainThreadRenderer(false);
      },
      offscreenCanvas: false,
    });
    await expect(
      service.renderComposite(makeCore(makeStack()), requestOptions()),
    ).rejects.toMatchObject({ code: "render-environment-unsupported" });
    await expect(
      service.renderPlate(makeCore(makeStack()), "black", requestOptions()),
    ).rejects.toMatchObject({ code: "render-environment-unsupported" });
    expect(decodes).toBe(0);
    expect(ports).toBe(0);
  });

  it("diffusion/clean stacks succeed through the typed layer-data fallback without OffscreenCanvas", async () => {
    const clean = makeLayer("layer-clean", ASSET_B, { x: 12, y: 10 }, { opacity: 0.6 });
    clean.recipe.mode = "clean";
    const diffusion = makeLayer("layer-diffusion", ASSET_C, { x: 30, y: 18 }, { opacity: 0.8 });
    diffusion.recipe.mode = "diffusion";
    const core = makeCore([clean, diffusion]);

    // Reference: the compose-capable path (fake OffscreenCanvas installed).
    const reference = await makeService().renderComposite(core, requestOptions({ matte: null }));

    // Reduced environment: hide OffscreenCanvas entirely so the executor
    // yields layer-data and the service composes it itself.
    const saved = globalScope.OffscreenCanvas;
    delete globalScope.OffscreenCanvas;
    try {
      const service = createWorkerRenderService({
        sources: SOURCES,
        createPort: () => new MainThreadRenderer(false),
        offscreenCanvas: false,
      });
      const reduced = await service.renderComposite(core, requestOptions({ matte: null }));
      expect(Buffer.from(reduced.data).equals(Buffer.from(reference.data))).toBe(true);
      const plate = await service.renderPlate(core, "black", requestOptions());
      expect(plate.width).toBe(WIDTH);
    } finally {
      globalScope.OffscreenCanvas = saved;
    }
  });

  it("vector plates never need OffscreenCanvas", async () => {
    const halftoneLayer = makeLayer("layer-h", ASSET_A, { x: WIDTH / 2, y: HEIGHT / 2 });
    const core = makeCore([halftoneLayer]);
    const saved = globalScope.OffscreenCanvas;
    delete globalScope.OffscreenCanvas;
    try {
      const service = createWorkerRenderService({
        sources: SOURCES,
        createPort: () => new MainThreadRenderer(false),
        offscreenCanvas: false,
      });
      const svg = await service.renderPlateSvg(core, "black", requestOptions());
      expect(svg).toMatch(/<circle|<rect|<path/);
    } finally {
      globalScope.OffscreenCanvas = saved;
    }
  });
});

describe("WorkerRenderService: bounded source retention", () => {
  it("streamed exports re-decode per (pass, layer) instead of caching sources", async () => {
    let decodes = 0;
    const sources: WorkerRenderSources = {
      resolveRaster: async (assetId) => {
        decodes += 1;
        return SOURCES.resolveRaster(assetId);
      },
    };
    const { deriveProof } = budgets();
    const service = createWorkerRenderService({
      sources,
      createPort: () => new MainThreadRenderer(false),
      renderBudgetBytes: deriveProof,
    });
    const core = makeCore(makeStack());
    await service.renderComposite(core, requestOptions({ matte: "#ffffff" }));
    // Streamed form: one decode per (plate pass, layer) — 4 plates × 3
    // layers — never a service-lifetime cache.
    expect(decodes).toBe(12);

    decodes = 0;
    const singleShot = createWorkerRenderService({
      sources,
      createPort: () => new MainThreadRenderer(false),
    });
    await singleShot.renderComposite(core, requestOptions({ matte: "#ffffff" }));
    expect(decodes).toBe(3); // one per layer, consumed by the transfer
  });
});
