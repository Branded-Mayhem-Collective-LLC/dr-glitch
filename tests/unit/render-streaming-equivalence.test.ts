/**
 * Streamed export sessions must be bit-identical to the single-shot export
 * path: same composed plate fields, same proof bytes, for every band height,
 * across mixed halftone/diffusion stacks with opacities and knockout.
 *
 * Node has no OffscreenCanvas, so a deterministic software stand-in
 * rasterizes halftone dots (binary point-in-shape coverage) — the SAME
 * stand-in serves both paths through the shared rasterizePlacements, so the
 * comparison exercises exactly the streaming/banding/compose machinery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeRenderJob } from "../../src/render/executor";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import type {
  RenderJobRequest,
  RenderLayerInput,
  RenderResultPayload,
  RenderWorkerEvent,
} from "../../src/render/protocol";
import type { RasterData } from "../../src/render/raster";
import type { RenderPlateId } from "../../src/render/settings";
import {
  gradientRaster,
  makeRaster,
  noiseRaster,
  transparentRegionsRaster,
} from "../../src/render/fixtures";
import type { DotShape } from "../../src/core/types";
import type { HalftoneSettings } from "../../src/studio/halftone";

/* ------------------------------------------------------------------ */
/* Deterministic OffscreenCanvas stand-in                              */
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

  getImageData(_x: number, _y: number, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
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
/* Stack fixtures and drivers                                          */
/* ------------------------------------------------------------------ */

const WIDTH = 44;
const HEIGHT = 30;
const ALL_PLATES: RenderPlateId[] = ["cyan", "magenta", "yellow", "black"];
const PAPER = [238, 234, 224] as const;

type StackSettings = HalftoneSettings & { cleanEnabled?: boolean };

function settings(overrides: Partial<StackSettings> = {}): StackSettings {
  return {
    cellSize: 5,
    frayedXEdge: 0,
    frayedYEdge: 0,
    opacity: 1,
    dotShape: "round",
    invert: false,
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
    visible: { cyan: true, magenta: true, yellow: true, black: true },
    ...overrides,
  };
}

type StackLayer = {
  raster: RasterData;
  settings: StackSettings;
  opacity: number;
  dotShape: DotShape;
};

/** Opaque-white left half (full alpha, zero coverage ⇒ knockout), transparent right half. */
function knockoutRaster(width: number, height: number): RasterData {
  return makeRaster(width, height, (x) =>
    x < width / 2 ? [255, 255, 255, 255] : [0, 0, 0, 0]);
}

function buildStack(): StackLayer[] {
  return [
    { raster: gradientRaster(WIDTH, HEIGHT), settings: settings({ cellSize: 5 }), opacity: 1, dotShape: "round" },
    {
      raster: transparentRegionsRaster(WIDTH, HEIGHT),
      settings: settings({
        diffusionEnabled: true,
        diffusionAlgorithm: "stucki",
        diffusionIntensity: 0.9,
        diffusionLevels: 3,
        diffusionModulation: "heavy",
        diffusionModStrength: 0.7,
      }),
      opacity: 0.5,
      dotShape: "round",
    },
    {
      raster: noiseRaster(WIDTH, HEIGHT, 5),
      settings: settings({ cellSize: 6, sliceShift: 3, sliceSize: 6, bitmapSort: 0.4, frayedXEdge: 2, visible: { cyan: true, magenta: false, yellow: true, black: true } }),
      opacity: 0.85,
      dotShape: "square",
    },
    {
      // Clean continuous-tone layer with glitch: coverage folds in directly.
      raster: gradientRaster(WIDTH, HEIGHT),
      settings: settings({ cleanEnabled: true, sliceShift: 2, sliceSize: 5, macroblockCorrupt: 0.3 }),
      opacity: 0.6,
      dotShape: "round",
    },
    { raster: knockoutRaster(WIDTH, HEIGHT), settings: settings({ cellSize: 5 }), opacity: 1, dotShape: "cross" },
  ];
}

function toLayerInput(layer: StackLayer): RenderLayerInput {
  const buffer = layer.raster.data.buffer.slice(0) as ArrayBuffer;
  return {
    raster: { buffer, width: layer.raster.width, height: layer.raster.height },
    settings: layer.settings,
    opacity: layer.opacity,
    dotShape: layer.dotShape,
    strokeWidth: 1,
  };
}

async function runSingleShot(stack: StackLayer[], plates: RenderPlateId[]): Promise<RenderResultPayload> {
  const job: RenderJobRequest = {
    type: "job",
    kind: "export",
    revision: 100,
    outputWidth: WIDTH,
    outputHeight: HEIGHT,
    renderScale: 1,
    minimumCellSize: 0.01,
    plates,
    layers: stack.map(toLayerInput),
    paper: PAPER,
    wantBitmap: false,
  };
  const payload = await executeRenderJob(job, {
    isCancelled: () => false,
    onProgress: () => undefined,
    yieldPoint: () => undefined,
  });
  if (!payload) throw new Error("single-shot job was unexpectedly cancelled");
  return payload;
}

type StreamedOutput = {
  events: RenderWorkerEvent[];
  plates: Map<RenderPlateId, { ink: Float32Array; alpha: Float32Array; rows: number }>;
  proof: Uint8ClampedArray;
};

function assembleStreamed(events: RenderWorkerEvent[]): StreamedOutput["plates"] {
  const map: StreamedOutput["plates"] = new Map();
  for (const event of events) {
    if (event.type !== "plate-band") continue;
    let entry = map.get(event.plate);
    if (!entry) {
      entry = { ink: new Float32Array(WIDTH * HEIGHT), alpha: new Float32Array(WIDTH * HEIGHT), rows: 0 };
      map.set(event.plate, entry);
    }
    entry.ink.set(new Float32Array(event.inkPremultiplied.buffer), event.rowStart * WIDTH);
    entry.alpha.set(new Float32Array(event.alpha.buffer), event.rowStart * WIDTH);
    entry.rows += event.rowCount;
  }
  return map;
}

function assembleProof(events: RenderWorkerEvent[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let rows = 0;
  for (const event of events) {
    if (event.type !== "proof-band") continue;
    rgba.set(new Uint8ClampedArray(event.rgba.buffer), event.rowStart * WIDTH * 4);
    rows += event.rowCount;
  }
  expect(rows).toBe(HEIGHT);
  return rgba;
}

async function waitFor<T>(
  events: RenderWorkerEvent[],
  predicate: () => T | undefined,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = predicate();
    if (found !== undefined) return found;
    const failure = events.find((event) => event.type === "error");
    if (failure) throw new Error(`error while waiting for ${label}: ${JSON.stringify(failure)}`);
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; saw ${events.map((event) => event.type).join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function runStreamed(
  stack: StackLayer[],
  plates: RenderPlateId[],
  bandHeight: number,
): Promise<StreamedOutput> {
  const port = new MainThreadRenderer(false);
  const events: RenderWorkerEvent[] = [];
  port.onEvent((event) => events.push(event));
  const revision = 7;
  port.beginExport({
    type: "begin-export",
    revision,
    outputWidth: WIDTH,
    outputHeight: HEIGHT,
    renderScale: 1,
    minimumCellSize: 0.01,
    plates,
    layerCount: stack.length,
    bandHeight,
    paper: PAPER,
  });
  await waitFor(events, () => events.find((event) => event.type === "export-ready"), "export-ready");
  for (const plate of plates) {
    for (let layerIndex = 0; layerIndex < stack.length; layerIndex += 1) {
      port.submitLayer({ type: "submit-layer", revision, plate, layerIndex, layer: toLayerInput(stack[layerIndex]) });
      await waitFor(
        events,
        () => events.find((event) => event.type === "layer-ack" && event.plate === plate && event.layerIndex === layerIndex),
        `layer-ack ${plate}/${layerIndex}`,
      );
    }
  }
  port.finalizeExport({ type: "finalize-export", revision });
  await waitFor(events, () => events.find((event) => event.type === "result"), "result");
  port.dispose();
  return { events, plates: assembleStreamed(events), proof: assembleProof(events) };
}

function expectBitIdentical(streamed: StreamedOutput, single: RenderResultPayload, label: string): void {
  expect(single.form).toBe("plates");
  if (single.form !== "plates") return;
  for (const plate of single.plates) {
    const entry = streamed.plates.get(plate.plate);
    expect(entry, `${label}: missing plate ${plate.plate}`).toBeDefined();
    if (!entry) continue;
    expect(entry.rows, `${label}: band rows must cover every output row exactly once`).toBe(HEIGHT);
    expect(new Uint32Array(entry.ink.buffer), `${label}: ink ${plate.plate}`)
      .toEqual(new Uint32Array(plate.inkPremultiplied.buffer));
    expect(new Uint32Array(entry.alpha.buffer), `${label}: alpha ${plate.plate}`)
      .toEqual(new Uint32Array(plate.alpha.buffer));
  }
  expect(single.proof, `${label}: single-shot proof`).toBeDefined();
  expect([...streamed.proof], `${label}: proof bytes`).toEqual([...new Uint8ClampedArray(single.proof!.buffer)]);
}

/* ------------------------------------------------------------------ */
/* Suites                                                              */
/* ------------------------------------------------------------------ */

describe("streamed export equivalence", () => {
  it("matches the single-shot composed plates and proof bit-for-bit at several band heights", async () => {
    const single = await runSingleShot(buildStack(), ALL_PLATES);
    for (const bandHeight of [1, 4, 7, HEIGHT]) {
      const streamed = await runStreamed(buildStack(), ALL_PLATES, bandHeight);
      expectBitIdentical(streamed, single, `band ${bandHeight}`);
    }
  }, 30_000);

  it("matches for a grayscale single-plate stack", async () => {
    const stack: StackLayer[] = [
      { raster: gradientRaster(WIDTH, HEIGHT), settings: settings({ grayscale: true, cellSize: 5 }), opacity: 0.7, dotShape: "round" },
      {
        raster: noiseRaster(WIDTH, HEIGHT, 11),
        settings: settings({ grayscale: true, diffusionEnabled: true, diffusionAlgorithm: "atkinson", diffusionLevels: 2 }),
        opacity: 1,
        dotShape: "round",
      },
    ];
    const single = await runSingleShot(stack, ["black"]);
    const streamed = await runStreamed(stack, ["black"], 5);
    expectBitIdentical(streamed, single, "grayscale");
  });

  it("emits monotonic, meaningful progress across layer × plate × band", async () => {
    const streamed = await runStreamed(buildStack(), ALL_PLATES, 4);
    const ratios = streamed.events
      .filter((event) => event.type === "progress")
      .map((event) => (event as { ratio: number }).ratio);
    expect(ratios.length).toBeGreaterThanOrEqual(ALL_PLATES.length * (buildStack().length + 1));
    for (let index = 1; index < ratios.length; index += 1) {
      expect(ratios[index]).toBeGreaterThanOrEqual(ratios[index - 1]);
    }
    expect(ratios.at(-1)).toBeLessThanOrEqual(1);
    // Acks arrived once per layer per pass.
    const acks = streamed.events.filter((event) => event.type === "layer-ack");
    expect(acks).toHaveLength(ALL_PLATES.length * buildStack().length);
  });

  it("cancels mid-stream: buffers released, one cancelled event, no partial finalize", async () => {
    const stack = buildStack();
    const port = new MainThreadRenderer(false);
    const events: RenderWorkerEvent[] = [];
    port.onEvent((event) => events.push(event));
    const revision = 9;
    port.beginExport({
      type: "begin-export",
      revision,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      renderScale: 1,
      minimumCellSize: 0.01,
      plates: ALL_PLATES,
      layerCount: stack.length,
      bandHeight: 4,
      paper: PAPER,
    });
    await waitFor(events, () => events.find((event) => event.type === "export-ready"), "export-ready");
    port.submitLayer({ type: "submit-layer", revision, plate: "cyan", layerIndex: 0, layer: toLayerInput(stack[0]) });
    await waitFor(
      events,
      () => events.find((event) => event.type === "layer-ack"),
      "first layer-ack",
    );
    port.cancel(revision);
    await waitFor(events, () => events.find((event) => event.type === "cancelled"), "cancelled");
    // Post-cancel messages are silently ignored; nothing may finalize.
    port.submitLayer({ type: "submit-layer", revision, plate: "cyan", layerIndex: 1, layer: toLayerInput(stack[1]) });
    port.finalizeExport({ type: "finalize-export", revision });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1);
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(events.some((event) => event.type === "plate-band")).toBe(false);
    expect(events.some((event) => event.type === "proof-band")).toBe(false);
    expect(events.filter((event) => event.type === "layer-ack")).toHaveLength(1);
    port.dispose();
  });
});
