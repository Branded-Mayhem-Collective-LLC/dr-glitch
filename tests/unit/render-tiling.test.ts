/**
 * Tile-scheduled halftone rasterization: production consumes plan.tiles —
 * dots paint onto TILE-SIZED canvases at absolute artboard coordinates.
 * Under the DETERMINISTIC point-in-shape stand-in (translation-exact by
 * construction), the stitched ink field equals whole-image rasterization
 * for any exact partition — proving the scheduler's LOGICAL correctness:
 * dot inclusion, seam clipping, and region assembly. Also proves the
 * executor honors an explicit job tile schedule (and chunks a default one
 * when absent) by observing every canvas allocation.
 *
 * REAL canvas AA is coordinate-dependent under translation, so the
 * production contract is determinism per canonical schedule with a
 * measured bound against single-canvas output — asserted per dot shape in
 * the browser benchmark (tests/e2e/perf-benchmark.spec.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeRenderJob, rasterizePlacements, rasterizePlacementsTiled } from "../../src/render/executor";
import { collectGridDots, effectiveCellSize, type GridGeometry } from "../../src/render/kernels/halftone-grid";
import { buildCoverageField, visibleContentBounds } from "../../src/render/kernels/coverage";
import { chunkTiles, DEFAULT_TILE_EDGE, planRender } from "../../src/render/planner";
import type { RenderJobRequest, RenderLayerInput, RenderResultPayload } from "../../src/render/protocol";
import { gradientRaster, hardEdgeRaster } from "../../src/render/fixtures";
import type { RenderSettings } from "../../src/render/settings";

/* Deterministic point-in-shape 2D context (subset used by paintDot). */
type Shape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "circle"; x: number; y: number; radius: number; hole?: number }
  | { kind: "polygon"; points: Array<[number, number]> };

class FakeContext {
  fillStyle = "";
  private shapes: Shape[] = [];
  private polygon: Array<[number, number]> | null = null;
  private pendingArcs: Array<{ x: number; y: number; radius: number; ccw: boolean }> = [];
  private readonly alpha: Float32Array;

  constructor(private readonly width: number, private readonly height: number) {
    this.alpha = new Float32Array(width * height);
  }

  beginPath(): void {
    this.shapes = [];
    this.polygon = null;
    this.pendingArcs = [];
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.shapes.push({ kind: "rect", x, y, width, height });
  }
  roundRect(x: number, y: number, width: number, height: number): void {
    this.rect(x, y, width, height);
  }
  arc(x: number, y: number, radius: number, _s?: number, _e?: number, ccw = false): void {
    this.pendingArcs.push({ x, y, radius, ccw });
  }
  moveTo(x: number, y: number): void {
    this.polygon = [[x, y]];
  }
  lineTo(x: number, y: number): void {
    this.polygon?.push([x, y]);
  }
  closePath(): void {
    if (this.polygon && this.polygon.length > 2) {
      this.shapes.push({ kind: "polygon", points: this.polygon });
    }
    this.polygon = null;
  }
  fill(): void {
    // Resolve arcs: an even-odd inner arc punches a hole in the outer one.
    if (this.pendingArcs.length > 0) {
      const outer = this.pendingArcs[0];
      const inner = this.pendingArcs.find((candidate) => candidate.ccw);
      this.shapes.push({
        kind: "circle",
        x: outer.x,
        y: outer.y,
        radius: outer.radius,
        ...(inner ? { hole: inner.radius } : {}),
      });
      this.pendingArcs = [];
    }
    for (let py = 0; py < this.height; py += 1) {
      for (let px = 0; px < this.width; px += 1) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        for (const shape of this.shapes) {
          if (this.inside(shape, cx, cy)) {
            this.alpha[py * this.width + px] = 1;
            break;
          }
        }
      }
    }
  }
  private inside(shape: Shape, x: number, y: number): boolean {
    if (shape.kind === "rect") {
      return x >= shape.x && x < shape.x + shape.width && y >= shape.y && y < shape.y + shape.height;
    }
    if (shape.kind === "circle") {
      const distance = Math.hypot(x - shape.x, y - shape.y);
      return distance <= shape.radius && (shape.hole === undefined || distance >= shape.hole);
    }
    let winding = false;
    const { points } = shape;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) winding = !winding;
    }
    return winding;
  }
  getImageData(_x: number, _y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      data[index * 4 + 3] = this.alpha[index] * 255;
    }
    return { data, width, height };
  }
}

const createdCanvases: Array<{ width: number; height: number }> = [];

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

const WIDTH = 96;
const HEIGHT = 64;

function settingsOf(): RenderSettings {
  return {
    cellSize: 7,
    frayedXEdge: 0,
    frayedYEdge: 0,
    invert: false,
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
    visible: { cyan: true, magenta: true, yellow: true, black: true },
  };
}

function layerOf(): RenderLayerInput {
  const raster = gradientRaster(WIDTH, HEIGHT);
  return {
    raster: { buffer: raster.data.buffer as ArrayBuffer, width: WIDTH, height: HEIGHT },
    settings: settingsOf(),
    opacity: 1,
    dotShape: "round",
    strokeWidth: 1,
  };
}

function placementsFor(dotShape: RenderLayerInput["dotShape"] = "round") {
  const raster = hardEdgeRaster(WIDTH, HEIGHT);
  const field = buildCoverageField(raster, "black", settingsOf());
  const geometry: GridGeometry = {
    width: WIDTH,
    height: HEIGHT,
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    cell: effectiveCellSize(7, 1, 0.01),
    angleDegrees: 45,
  };
  const placements = collectGridDots(field, geometry, visibleContentBounds(raster));
  const layer: RenderLayerInput = {
    raster: { buffer: raster.data.buffer as ArrayBuffer, width: WIDTH, height: HEIGHT },
    settings: settingsOf(),
    opacity: 1,
    dotShape,
    strokeWidth: 2,
  };
  return { placements, layer };
}

describe("tiled rasterization equivalence", () => {
  const shapes: Array<RenderLayerInput["dotShape"]> = [
    "round",
    "square",
    "diamond",
    "triangle",
    "cross",
    "circle-outline",
    "line",
  ];
  for (const shape of shapes) {
    it(`tiled == whole for ${shape} dots across tile partitions`, async () => {
      const { placements, layer } = placementsFor(shape);
      expect(placements.length).toBeGreaterThan(20);
      const whole = rasterizePlacements(placements, layer, WIDTH, HEIGHT, 1);
      for (const edge of [16, 33, 64, 1024]) {
        const tiles = chunkTiles(WIDTH, HEIGHT, edge);
        const tiled = await rasterizePlacementsTiled(placements, layer, WIDTH, HEIGHT, 1, tiles, undefined);
        expect(Buffer.from(tiled.buffer).equals(Buffer.from(whole.buffer))).toBe(true);
      }
    });
  }

  it("checks cancellation between tiles", async () => {
    const { placements, layer } = placementsFor("round");
    const tiles = chunkTiles(WIDTH, HEIGHT, 16);
    const abort = new Error("stop-raster");
    let checks = 0;
    await expect(
      rasterizePlacementsTiled(placements, layer, WIDTH, HEIGHT, 1, tiles, () => {
        checks += 1;
        if (checks === 3) throw abort;
      }),
    ).rejects.toBe(abort);
    expect(checks).toBe(3);
  });
});

describe("executor consumes the tile schedule", () => {
  function jobOf(tiles?: RenderJobRequest["tiles"]): RenderJobRequest {
    return {
      type: "job",
      kind: "export",
      revision: 1,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      renderScale: 1,
      minimumCellSize: 0.01,
      plates: ["black"],
      layers: [layerOf()],
      wantBitmap: false,
      ...(tiles ? { tiles } : {}),
    };
  }

  const hooks = {
    isCancelled: () => false,
    onProgress: () => undefined,
    yieldPoint: () => undefined,
  };

  it("uses plan.tiles when the job carries them and output matches the untiled reference", async () => {
    const { placements, layer } = placementsFor("round");
    void placements;
    void layer;
    const plan = planRender({
      sampleWidth: WIDTH,
      sampleHeight: HEIGHT,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      plateCount: 1,
      layerCount: 1,
    });
    // The artboard is smaller than the default tile edge, so the schedule
    // is a single exact-cover tile — still consumed as given.
    createdCanvases.length = 0;
    const withPlanTiles = (await executeRenderJob(jobOf(plan.tiles), hooks)) as Extract<
      RenderResultPayload,
      { form: "plates" }
    >;
    expect(withPlanTiles.form).toBe("plates");
    expect(createdCanvases).toEqual(plan.tiles.map(({ width, height }) => ({ width, height })));

    // A finer explicit schedule allocates one canvas per tile, never an
    // artboard-sized one, and produces identical plates.
    const fine = chunkTiles(WIDTH, HEIGHT, 32);
    createdCanvases.length = 0;
    const withFineTiles = (await executeRenderJob(jobOf(fine), hooks)) as Extract<
      RenderResultPayload,
      { form: "plates" }
    >;
    expect(createdCanvases).toEqual(fine.map(({ width, height }) => ({ width, height })));
    expect(createdCanvases.every((canvas) => canvas.width <= 32 && canvas.height <= 32)).toBe(true);
    expect(
      Buffer.from(withFineTiles.plates[0].inkPremultiplied.buffer).equals(
        Buffer.from(withPlanTiles.plates[0].inkPremultiplied.buffer),
      ),
    ).toBe(true);
  });

  it("chunks DEFAULT_TILE_EDGE tiles when a job (e.g. preview draft) has no schedule", async () => {
    createdCanvases.length = 0;
    const payload = await executeRenderJob(jobOf(), hooks);
    expect(payload && payload.form).toBe("plates");
    const expected = chunkTiles(WIDTH, HEIGHT, DEFAULT_TILE_EDGE);
    expect(createdCanvases).toEqual(expected.map(({ width, height }) => ({ width, height })));
  });
});
