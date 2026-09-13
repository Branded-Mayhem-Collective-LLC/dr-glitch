/**
 * UNEQUAL-SOURCE ROUND-DOT PARITY for the legacy compatibility binding
 * (src/export/current-engine.ts): when a legacy-representable project has a
 * source whose dimensions DIFFER from the (exact-sheet) artboard, the routed
 * service must hand renderHalftone / renderPlateSvg the source UNSTAGED at
 * its natural size together with the legacy DocumentSettings, so the
 * engine's own document placement (calculateArtworkPlacement) runs — the
 * exact call shape the shipped studio (and the custom-shape E2E oracle)
 * uses. Output must be byte-identical to calling the legacy engine directly
 * with that same staging.
 *
 * The unit project has no real canvas, so every canvas here is a
 * deterministic recording stub: draw calls append to an op log and
 * getImageData synthesizes pixels from a hash of that log (recursively
 * including drawn source canvases). Two renders produce identical bytes iff
 * the engine received identical sources, placement, and options — any
 * pre-warped staging (extra canvas, different dimensions, different
 * drawImage placement) changes the log and therefore the bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectCoreV1 } from "../../src/core/types";
import {
  createCurrentEngineRenderService,
  createRoutedRenderService,
} from "../../src/export/current-engine";
import { documentSettingsFromCore, halftoneSettingsFromCore } from "../../src/export/job-settings";
import type { RasterData, RenderService } from "../../src/export/orchestrator";
import { renderHalftone, renderPlateSvg } from "../../src/studio/halftone";

/* ------------------------------------------------------------------ */
/* Deterministic recording canvas stub                                 */
/* ------------------------------------------------------------------ */

type FakeCanvas = {
  width: number;
  height: number;
  __ops: string[];
  getContext: (...args: unknown[]) => unknown;
};

function isFakeCanvas(value: unknown): value is FakeCanvas {
  return typeof value === "object" && value !== null && "__ops" in value;
}

/** Identity of a canvas = its dimensions + everything drawn into it. */
function signatureOf(canvas: FakeCanvas): string {
  return `${canvas.width}x${canvas.height}|${canvas.__ops.join(";")}`;
}

function serialize(value: unknown): string {
  if (isFakeCanvas(value)) return `canvas(${signatureOf(value)})`;
  return String(value);
}

/** FNV-1a seeded LCG byte stream — same key, same bytes, always. */
function bytesFor(key: string, length: number): Uint8ClampedArray {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  const out = new Uint8ClampedArray(length);
  let state = hash || 1;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function makeCanvas(): FakeCanvas {
  const ops: string[] = [];
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    __ops: ops,
    getContext: () => context,
  };
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (prop === "canvas") return canvas;
      if (prop === "getImageData") {
        return (x: number, y: number, width: number, height: number) => ({
          width,
          height,
          data: bytesFor(`${signatureOf(canvas)}@${x},${y},${width},${height}`, width * height * 4),
        });
      }
      return (...args: unknown[]) => {
        ops.push(`${String(prop)}(${args.map(serialize).join(",")})`);
      };
    },
    set(_target, prop, value) {
      ops.push(`${String(prop)}=${serialize(value)}`);
      return true;
    },
  });
  return canvas;
}

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
      return makeCanvas();
    },
  };
});

afterAll(() => {
  if (hadDocument) globals.document = previousDocument;
  else delete globals.document;
  if (hadImageElement) globals.HTMLImageElement = previousImageElement;
  else delete globals.HTMLImageElement;
});

/* ------------------------------------------------------------------ */
/* Fixture: 320x200 source on the 8x10 sheet artboard (1920x2400)      */
/* ------------------------------------------------------------------ */

const ASSET_ID = "c".repeat(64);
const SHEET_WIDTH = 1920; // 8x10 portrait at 240 DPI
const SHEET_HEIGHT = 2400;
const SOURCE_WIDTH = 320;
const SOURCE_HEIGHT = 200;

function makeUnequalCore(): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: {
      widthPx: SHEET_WIDTH,
      heightPx: SHEET_HEIGHT,
      presetId: "8x10",
      background: "white",
    },
    layers: [
      {
        id: "layer-1",
        name: "Artwork",
        assetId: ASSET_ID,
        visible: true,
        locked: false,
        opacity: 1,
        crop: null,
        transform: {
          position: { x: SHEET_WIDTH / 2, y: SHEET_HEIGHT / 2 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          flipH: false,
          flipV: false,
          skew: { x: 0, y: 0 },
          perspective: null,
        },
        recipe: {
          mode: "halftone",
          halftone: {
            // Large cells keep the deterministic grid walk small; the
            // document path must NOT clamp this to the artboard grid.
            cellSize: 96,
            dotShape: "round",
            customShapeAssetId: null,
            invert: false,
            strokeWidth: 1,
            frayedXEdge: 0,
            frayedYEdge: 0,
          },
          diffusion: {
            algorithm: "floyd-steinberg",
            modulation: "none",
            modStrength: 0.5,
            intensity: 0.5,
            levels: 8,
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
        },
      },
    ],
    separation: {
      // Grayscale keeps composite parity to a single K pass — the staging
      // under test is identical for every plate.
      mode: "grayscale",
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
  };
}

function fixtureSource(): FakeCanvas {
  const source = makeCanvas();
  source.width = SOURCE_WIDTH;
  source.height = SOURCE_HEIGHT;
  source.__ops.push("fixture-artwork");
  return source;
}

function makeRoutedService(source: FakeCanvas): RenderService {
  const legacy = createCurrentEngineRenderService({
    resolveImage: async () => source as unknown as HTMLCanvasElement,
  });
  const refuse = () => {
    throw new Error("the worker must not render the legacy-representable fixture");
  };
  const worker: RenderService = {
    renderComposite: refuse,
    renderPlate: refuse,
    renderPlateSvg: refuse,
    renderLayer: refuse,
  };
  return createRoutedRenderService({
    legacy,
    worker,
    assetDimensions: () => ({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT }),
  });
}

function requestOptions() {
  return {
    revision: 1,
    registration: false,
    matte: null,
    signal: new AbortController().signal,
  };
}

function sameBytes(actual: Uint8ClampedArray, expected: Uint8ClampedArray): boolean {
  return (
    actual.length === expected.length &&
    Buffer.from(actual.buffer, actual.byteOffset, actual.length).equals(
      Buffer.from(expected.buffer, expected.byteOffset, expected.length),
    )
  );
}

/** The legacy engine called directly with the shipped document staging. */
function directRender(
  source: FakeCanvas,
  core: ProjectCoreV1,
  renderOptions: Record<string, unknown>,
): RasterData {
  const layer = core.layers[0];
  const target = makeCanvas();
  renderHalftone(
    source as unknown as HTMLCanvasElement,
    target as unknown as HTMLCanvasElement,
    halftoneSettingsFromCore(core, layer),
    {
      width: core.artboard.widthPx,
      height: core.artboard.heightPx,
      document: documentSettingsFromCore(core, layer),
      registration: false,
      ...renderOptions,
    },
  );
  const context = target.getContext() as { getImageData: (x: number, y: number, w: number, h: number) => RasterData };
  return context.getImageData(0, 0, target.width, target.height);
}

/* ------------------------------------------------------------------ */
/* Parity                                                              */
/* ------------------------------------------------------------------ */

describe("unequal-source round-dot parity (document staging)", () => {
  it(
    "composite through the routed service is byte-identical to the direct legacy document render",
    { timeout: 60_000 },
    async () => {
      const source = fixtureSource();
      const routed = makeRoutedService(source);
      const actual = await routed.renderComposite(makeUnequalCore(), requestOptions());
      // Output stays artboard-sized: the document path must not letterbox.
      expect(actual.width).toBe(SHEET_WIDTH);
      expect(actual.height).toBe(SHEET_HEIGHT);
      const expected = directRender(source, makeUnequalCore(), {
        plate: "composite",
        transparent: true,
      });
      expect(sameBytes(actual.data, expected.data)).toBe(true);
    },
  );

  it(
    "the K plate through the routed service is byte-identical to the direct legacy document render",
    { timeout: 60_000 },
    async () => {
      const source = fixtureSource();
      const routed = makeRoutedService(source);
      const actual = await routed.renderPlate(makeUnequalCore(), "black", requestOptions());
      expect(actual.width).toBe(SHEET_WIDTH);
      expect(actual.height).toBe(SHEET_HEIGHT);
      const expected = directRender(source, makeUnequalCore(), {
        plate: "black",
        monochromePlate: true,
        transparent: true,
      });
      expect(sameBytes(actual.data, expected.data)).toBe(true);
    },
  );

  it(
    "the K plate SVG through the routed service equals the direct legacy document SVG",
    { timeout: 60_000 },
    async () => {
      const source = fixtureSource();
      const routed = makeRoutedService(source);
      const core = makeUnequalCore();
      const actual = await routed.renderPlateSvg(core, "black", requestOptions());
      const expected = renderPlateSvg(
        source as unknown as HTMLCanvasElement,
        halftoneSettingsFromCore(core, core.layers[0]),
        "black",
        {
          width: core.artboard.widthPx,
          height: core.artboard.heightPx,
          document: documentSettingsFromCore(core, core.layers[0]),
          registration: false,
        },
      );
      expect(actual).toBe(expected);
    },
  );
});
