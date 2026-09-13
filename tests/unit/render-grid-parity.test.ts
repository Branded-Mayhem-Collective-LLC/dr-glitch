/**
 * Parity oracle for the screen-grid walk and the full coverage-field chain
 * (glitch slices/warp, frayed edges, content bounds). The oracle is the
 * engine's exported renderPlateSvg: with a minimal canvas stub feeding it a
 * known RasterData fixture, its emitted <circle> marks are exactly the
 * original grid walk over the original buildCoverageField. SVG attributes
 * round-trip doubles exactly, so comparison is bit-exact.
 *
 * Also proves: estimateGridPoints parity, tile-union equivalence in absolute
 * artboard coordinates, and screen-anchor invariance under artwork motion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  estimateGridPoints as originalEstimateGridPoints,
  renderPlateSvg,
  type HalftoneSettings,
} from "../../src/studio/halftone";
import { buildCoverageField, visibleContentBounds } from "../../src/render/kernels/coverage";
import {
  collectGridDots,
  effectiveCellSize,
  estimateGridPoints,
  type GridGeometry,
  type TileRect,
} from "../../src/render/kernels/halftone-grid";
import type { RasterData } from "../../src/render/raster";
import { gradientRaster, hardEdgeRaster, noiseRaster } from "../../src/render/fixtures";

const PLATES = ["cyan", "magenta", "yellow", "black"] as const;

function settings(overrides: Partial<HalftoneSettings> = {}): HalftoneSettings {
  return {
    cellSize: 8,
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

/* ------------------------------------------------------------------ */
/* Minimal canvas stub so renderPlateSvg samples our fixture directly. */
/* ------------------------------------------------------------------ */

let currentFixture: RasterData | null = null;
const globals = globalThis as Record<string, unknown>;
let hadDocument = false;
let previousDocument: unknown;
let hadImageElement = false;
let previousImageElement: unknown;

beforeAll(() => {
  hadDocument = "document" in globals;
  previousDocument = globals.document;
  hadImageElement = "HTMLImageElement" in globals;
  previousImageElement = globals.HTMLImageElement;
  globals.HTMLImageElement = class HTMLImageElement {};
  globals.document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: "",
          fillRect: () => {},
          drawImage: () => {},
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            if (!currentFixture) throw new Error("fixture not set");
            if (width !== currentFixture.width || height !== currentFixture.height) {
              throw new Error(`sample size ${width}x${height} != fixture ${currentFixture.width}x${currentFixture.height}`);
            }
            return currentFixture;
          },
        }),
      };
    },
  };
});

afterAll(() => {
  if (hadDocument) globals.document = previousDocument;
  else delete globals.document;
  if (hadImageElement) globals.HTMLImageElement = previousImageElement;
  else delete globals.HTMLImageElement;
});

/** Run the engine oracle and parse its circle marks as exact doubles. */
function oracleDots(raster: RasterData, plate: (typeof PLATES)[number], config: HalftoneSettings) {
  currentFixture = raster;
  const source = { width: raster.width, height: raster.height } as unknown as HTMLCanvasElement;
  const svg = renderPlateSvg(source, config, plate, {});
  currentFixture = null;
  const dots: Array<{ x: number; y: number; size: number }> = [];
  const pattern = /<circle cx="([^"]*)" cy="([^"]*)" r="([^"]*)"\/>/g;
  for (let match = pattern.exec(svg); match; match = pattern.exec(svg)) {
    dots.push({ x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) * 2 });
  }
  return dots;
}

function kernelGeometry(raster: RasterData, plate: (typeof PLATES)[number], config: HalftoneSettings): GridGeometry {
  return {
    width: raster.width,
    height: raster.height,
    sourceWidth: raster.width,
    sourceHeight: raster.height,
    // No document: engine uses scale = 1 and minimum cell 3.
    cell: effectiveCellSize(config.cellSize, 1, 3),
    angleDegrees: config.angles[plate],
  };
}

function kernelDots(raster: RasterData, plate: (typeof PLATES)[number], config: HalftoneSettings, tile?: TileRect) {
  const field = buildCoverageField(raster, plate, config);
  return collectGridDots(field, kernelGeometry(raster, plate, config), visibleContentBounds(raster), tile);
}

function expectSameDots(
  actual: Array<{ x: number; y: number; size: number }>,
  expected: Array<{ x: number; y: number; size: number }>,
  label: string,
) {
  expect(actual.length, `${label}: count`).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index].x === expected[index].x, `${label}: x[${index}]`).toBe(true);
    expect(actual[index].y === expected[index].y, `${label}: y[${index}]`).toBe(true);
    expect(actual[index].size / 2 === expected[index].size / 2, `${label}: size[${index}]`).toBe(true);
  }
}

describe("grid walk parity against renderPlateSvg", () => {
  const gradient = gradientRaster(96, 72);
  const hardEdge = hardEdgeRaster(80, 64);

  it("matches every plate angle on the gradient fixture", () => {
    for (const plate of PLATES) {
      expectSameDots(kernelDots(gradient, plate, settings()), oracleDots(gradient, plate, settings()), plate);
    }
  });

  it.each([
    [0, 6],
    [15, 7.5],
    [45, 8],
    [75, 11],
  ] as const)("matches at angle %d with cell size %d", (angle, cellSize) => {
    const config = settings({ cellSize, angles: { cyan: angle, magenta: angle, yellow: angle, black: angle } });
    expectSameDots(kernelDots(gradient, "black", config), oracleDots(gradient, "black", config), `angle ${angle}`);
  });

  it("matches with sub-minimum cell size (engine clamps to 3)", () => {
    const config = settings({ cellSize: 1 });
    expectSameDots(kernelDots(hardEdge, "black", config), oracleDots(hardEdge, "black", config), "clamped cell");
  });

  it("matches under frayed edges and the full glitch chain incl. slices and warp", () => {
    const config = settings({
      frayedXEdge: 4,
      frayedYEdge: 3,
      sliceShift: 3,
      sliceSize: 6,
      verticalSliceShift: 2,
      gridWarp: 2,
      warpScale: 10,
      smearDrag: 0.4,
      blockShift: 0.3,
      channelDesync: 0.4,
      macroblockCorrupt: 0.4,
      bitmapSort: 0.4,
    });
    for (const plate of ["cyan", "black"] as const) {
      expectSameDots(kernelDots(hardEdge, plate, config), oracleDots(hardEdge, plate, config), `glitch ${plate}`);
    }
  });

  it("matches for grayscale and invert", () => {
    const grayscale = settings({ grayscale: true });
    expectSameDots(kernelDots(gradient, "black", grayscale), oracleDots(gradient, "black", grayscale), "grayscale");
    const inverted = settings({ invert: true });
    expectSameDots(kernelDots(hardEdge, "magenta", inverted), oracleDots(hardEdge, "magenta", inverted), "invert");
  });

  it("matches on a noisy odd-dimension fixture", () => {
    const noisy = noiseRaster(61, 47, 11);
    expectSameDots(kernelDots(noisy, "yellow", settings({ cellSize: 5 })), oracleDots(noisy, "yellow", settings({ cellSize: 5 })), "noise");
  });
});

describe("estimateGridPoints parity", () => {
  it("matches the original across dimension, cell, and angle sweeps", () => {
    const dims = [
      [100, 50],
      [3600, 5280],
      [1, 1],
      [0, 0],
      [640, 480],
    ] as const;
    const cells = [0, 1, 4, 10, 12.5];
    const angles = [0, 15, 45, 75, 90, 135, -22.5];
    for (const [width, height] of dims) {
      for (const cell of cells) {
        for (const angle of angles) {
          expect(estimateGridPoints(width, height, cell, angle))
            .toBe(originalEstimateGridPoints(width, height, cell, angle));
        }
      }
    }
  });
});

describe("tiling in absolute artboard coordinates", () => {
  const raster = gradientRaster(120, 90);

  function dotKey(dot: { x: number; y: number; size: number }) {
    return `${dot.x}|${dot.y}|${dot.size}`;
  }

  it.each([
    [0, 8, 32],
    [15, 8, 48],
    [45, 6, 25],
    [45, 8, 97],
    [75, 12, 64],
    [30, 7.5, 40],
  ] as const)("union of tiles equals the full walk (angle %d, cell %d, tile %d)", (angle, cellSize, tileEdge) => {
    const config = settings({ cellSize, angles: { cyan: angle, magenta: angle, yellow: angle, black: angle } });
    const field = buildCoverageField(raster, "black", config);
    const geometry = kernelGeometry(raster, "black", config);
    const content = visibleContentBounds(raster);
    const full = collectGridDots(field, geometry, content);

    // Dots can land up to one cell outside the artboard; the tile partition
    // must cover that margin. Half-open tiles guarantee disjointness.
    const pad = Math.ceil(geometry.cell) + 2;
    const union: Array<{ x: number; y: number; size: number }> = [];
    for (let tileY = -pad; tileY < raster.height + pad; tileY += tileEdge) {
      for (let tileX = -pad; tileX < raster.width + pad; tileX += tileEdge) {
        const tile: TileRect = { x: tileX, y: tileY, width: tileEdge, height: tileEdge };
        union.push(...collectGridDots(field, geometry, content, tile));
      }
    }
    expect(union.length).toBe(full.length);
    expect(union.map(dotKey).sort()).toEqual(full.map(dotKey).sort());
  });

  it("a tile yields exactly the dots whose centers land inside it", () => {
    const config = settings({ cellSize: 8 });
    const field = buildCoverageField(raster, "black", config);
    const geometry = kernelGeometry(raster, "black", config);
    const content = visibleContentBounds(raster);
    const tile: TileRect = { x: 24, y: 16, width: 40, height: 32 };
    const inTile = collectGridDots(field, geometry, content, tile);
    const filtered = collectGridDots(field, geometry, content).filter((dot) =>
      dot.x >= tile.x && dot.x < tile.x + tile.width && dot.y >= tile.y && dot.y < tile.y + tile.height);
    expect(inTile.map(dotKey)).toEqual(filtered.map(dotKey));
    expect(inTile.length).toBeGreaterThan(0);
  });
});

describe("screen anchoring", () => {
  it("moving the artwork never moves the screen lattice", () => {
    const width = 90;
    const height = 70;
    const original = hardEdgeRaster(width, height, 0, 0);
    const translated = hardEdgeRaster(width, height, 9, 7);
    const config = settings({ cellSize: 6 });
    const geometry: GridGeometry = {
      width,
      height,
      sourceWidth: width,
      sourceHeight: height,
      cell: effectiveCellSize(config.cellSize, 1, 3),
      angleDegrees: config.angles.black,
    };

    // The full lattice for this geometry, independent of any artwork.
    const fullCoverage = new Float32Array(width * height).fill(1);
    const lattice = new Set(
      collectGridDots(fullCoverage, geometry, { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 })
        .map((dot) => `${dot.x}|${dot.y}`),
    );

    const originalDots = collectGridDots(buildCoverageField(original, "black", config), geometry, visibleContentBounds(original));
    const translatedDots = collectGridDots(buildCoverageField(translated, "black", config), geometry, visibleContentBounds(translated));
    expect(originalDots.length).toBeGreaterThan(0);
    expect(translatedDots.length).toBeGreaterThan(0);

    // Every emitted dot sits on the shared document lattice: translation
    // changes which lattice points ink, never where lattice points are.
    for (const dot of originalDots) expect(lattice.has(`${dot.x}|${dot.y}`)).toBe(true);
    for (const dot of translatedDots) expect(lattice.has(`${dot.x}|${dot.y}`)).toBe(true);
    const originalKeys = new Set(originalDots.map((dot) => `${dot.x}|${dot.y}`));
    expect(translatedDots.some((dot) => !originalKeys.has(`${dot.x}|${dot.y}`))).toBe(true);
  });
});
