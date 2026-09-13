/**
 * Clean continuous-tone layer mode: the layer's (glitched) separation
 * coverage IS the plate ink — no screening, no diffusion, no threshold.
 *
 * Verified here:
 * - hand-computed oracle: composed ink == coverage × effective alpha, with
 *   the CMYK separation arithmetic re-derived independently in the test;
 * - glitch applies before the clean mode kernel (buildCleanField order);
 * - knockout: an opaque zero-ink clean layer knocks out lower ink;
 * - streamed sessions are bit-identical to single-shot for clean stacks
 *   (clean streaming needs no OffscreenCanvas at all);
 * - the reduced no-OffscreenCanvas path reports mode "clean" layer data.
 *
 * Clean-only stacks never rasterize dots, so a bare OffscreenCanvas stub is
 * enough for the compose-capable paths (never actually invoked).
 */
import { afterEach, describe, expect, it } from "vitest";
import { executeRenderJob } from "../../src/render/executor";
import { buildCleanField } from "../../src/render/kernels/coverage";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import type {
  RenderJobRequest,
  RenderLayerInput,
  RenderResultPayload,
  RenderWorkerEvent,
} from "../../src/render/protocol";
import type { RasterData } from "../../src/render/raster";
import type { RenderPlateId, RenderSettings } from "../../src/render/settings";
import { makeRaster } from "../../src/render/fixtures";

const globalScope = globalThis as { OffscreenCanvas?: unknown };

/** Clean stacks never touch the canvas; a bare stub satisfies the gate. */
class StubOffscreenCanvas {
  getContext(): null {
    return null;
  }
}

function installStub(): void {
  globalScope.OffscreenCanvas = StubOffscreenCanvas;
}

afterEach(() => {
  delete globalScope.OffscreenCanvas;
});

function cleanSettings(overrides: Partial<RenderSettings> = {}): RenderSettings {
  return {
    cellSize: 5,
    frayedXEdge: 0,
    frayedYEdge: 0,
    invert: false,
    cleanEnabled: true,
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
    visible: { cyan: true, magenta: true, yellow: true, black: true },
    ...overrides,
  };
}

function toLayerInput(
  raster: RasterData,
  settings: RenderSettings,
  opacity = 1,
): RenderLayerInput {
  return {
    raster: {
      buffer: raster.data.buffer.slice(0) as ArrayBuffer,
      width: raster.width,
      height: raster.height,
    },
    settings,
    opacity,
    dotShape: "round",
    strokeWidth: 1,
  };
}

async function runJob(
  layers: RenderLayerInput[],
  plates: RenderPlateId[],
  width: number,
  height: number,
  paper?: readonly [number, number, number],
): Promise<RenderResultPayload> {
  const job: RenderJobRequest = {
    type: "job",
    kind: "export",
    revision: 1,
    outputWidth: width,
    outputHeight: height,
    renderScale: 1,
    minimumCellSize: 0.01,
    plates,
    layers,
    ...(paper ? { paper } : {}),
    wantBitmap: false,
  };
  const payload = await executeRenderJob(job, {
    isCancelled: () => false,
    onProgress: () => undefined,
    yieldPoint: () => undefined,
  });
  if (!payload) throw new Error("job unexpectedly cancelled");
  return payload;
}

function plateOf(payload: RenderResultPayload, plate: RenderPlateId) {
  if (payload.form !== "plates") throw new Error(`expected plates, got ${payload.form}`);
  const found = payload.plates.find((entry) => entry.plate === plate);
  if (!found) throw new Error(`missing plate ${plate}`);
  return {
    ink: new Float32Array(found.inkPremultiplied.buffer),
    alpha: new Float32Array(found.alpha.buffer),
  };
}

/** Independent re-derivation of the engine's CMYK coverage (max-GCR). */
function expectedCoverage(
  plate: "cyan" | "magenta" | "yellow" | "black",
  red: number,
  green: number,
  blue: number,
): number {
  const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
  if (luminance >= 250) return 0;
  const cyan = 1 - red / 255;
  const magenta = 1 - green / 255;
  const yellow = 1 - blue / 255;
  const black = Math.min(cyan, magenta, yellow);
  const value = { cyan: cyan - black, magenta: magenta - black, yellow: yellow - black, black }[plate];
  return Math.min(1, Math.max(0, value));
}

describe("clean layer mode: single-shot", () => {
  it("contributes coverage × effective alpha as ink, no screening (hand oracle)", async () => {
    installStub();
    const width = 4;
    const height = 3;
    // Uniform color, alpha varies by column: 255, 128, 51, 0.
    const alphas = [255, 128, 51, 0];
    const raster = makeRaster(width, height, (x) => [40, 70, 120, alphas[x]]);
    const opacity = 0.75;
    const payload = await runJob(
      [toLayerInput(raster, cleanSettings(), opacity)],
      ["cyan", "black"],
      width,
      height,
    );
    for (const plate of ["cyan", "black"] as const) {
      const { ink, alpha } = plateOf(payload, plate);
      const coverage = expectedCoverage(plate, 40, 70, 120);
      expect(coverage).toBeGreaterThan(0); // the fixture exercises real ink
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const layerAlpha = (alphas[x] / 255) * opacity;
          const index = y * width + x;
          expect(ink[index]).toBeCloseTo(coverage * layerAlpha, 6);
          expect(alpha[index]).toBeCloseTo(layerAlpha, 6);
        }
      }
    }
  });

  it("applies the layer glitch before clean ink (field == buildCleanField)", async () => {
    installStub();
    const width = 24;
    const height = 16;
    const raster = makeRaster(width, height, (x, y) => [
      (x * 37) % 256,
      (y * 53) % 256,
      (x * 11 + y * 7) % 256,
      255,
    ]);
    const settings = cleanSettings({ sliceShift: 3, sliceSize: 4, bitmapSort: 0.5 });
    const payload = await runJob([toLayerInput(raster, settings)], ["magenta"], width, height);
    const { ink } = plateOf(payload, "magenta");
    const field = buildCleanField(raster, "magenta", settings);
    // Opaque layer at opacity 1 ⇒ ink is exactly the clamped glitched field.
    for (let index = 0; index < field.length; index += 1) {
      expect(ink[index]).toBeCloseTo(Math.min(1, Math.max(0, field[index])), 6);
    }
    // The glitch actually moved ink somewhere (order is observable).
    const plain = buildCleanField(raster, "magenta", cleanSettings());
    expect([...field]).not.toEqual([...plain]);
  });

  it("knockout: an opaque zero-ink clean layer knocks out lower clean ink", async () => {
    installStub();
    const width = 6;
    const height = 4;
    // Bottom: solid dark (full coverage everywhere, alpha 1).
    const bottom = makeRaster(width, height, () => [20, 20, 20, 255]);
    // Top: left half opaque white (alpha 1, coverage 0 ⇒ knockout),
    // right half fully transparent (reveals lower ink).
    const top = makeRaster(width, height, (x) =>
      x < width / 2 ? [255, 255, 255, 255] : [0, 0, 0, 0],
    );
    const payload = await runJob(
      [toLayerInput(bottom, cleanSettings()), toLayerInput(top, cleanSettings())],
      ["black"],
      width,
      height,
    );
    const { ink, alpha } = plateOf(payload, "black");
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (x < width / 2) {
          expect(ink[index]).toBe(0); // knocked out
          expect(alpha[index]).toBe(1); // covered by the opaque top layer
        } else {
          expect(ink[index]).toBeGreaterThan(0.9); // lower ink revealed
        }
      }
    }
  });

  it("returns mode 'clean' layer data on the reduced no-OffscreenCanvas path", async () => {
    // No stub installed: the executor must fall back to layer-data.
    const width = 8;
    const height = 6;
    const raster = makeRaster(width, height, () => [40, 70, 120, 255]);
    const settings = cleanSettings();
    const payload = await runJob([toLayerInput(raster, settings)], ["cyan"], width, height);
    expect(payload.form).toBe("layer-data");
    if (payload.form !== "layer-data") return;
    expect(payload.layers).toHaveLength(1);
    expect(payload.layers[0].mode).toBe("clean");
    expect(payload.layers[0].placements).toBeUndefined();
    const field = new Float32Array(payload.layers[0].field.buffer);
    expect([...field]).toEqual([...buildCleanField(raster, "cyan", settings)]);
  });
});

describe("clean layer mode: streamed parity", () => {
  it("is bit-identical to single-shot for a clean-only stack, several band heights", async () => {
    installStub();
    const width = 25;
    const height = 17;
    const plates: RenderPlateId[] = ["cyan", "magenta", "yellow", "black"];
    const paper = [238, 234, 224] as const;
    const bottom = makeRaster(width, height, (x, y) => [
      (x * 29) % 256,
      (y * 41) % 256,
      (x + y * 3) % 256,
      255,
    ]);
    const top = makeRaster(width, height, (x, y) => [
      30,
      60,
      90,
      x > width / 2 ? Math.round((y / (height - 1)) * 255) : 0,
    ]);
    const bottomSettings = cleanSettings({ sliceShift: 2, sliceSize: 5 });
    const topSettings = cleanSettings();
    const single = await runJob(
      [toLayerInput(bottom, bottomSettings, 1), toLayerInput(top, topSettings, 0.5)],
      plates,
      width,
      height,
      paper,
    );
    expect(single.form).toBe("plates");
    if (single.form !== "plates") return;

    for (const bandHeight of [1, 5, height]) {
      const port = new MainThreadRenderer(false);
      const events: RenderWorkerEvent[] = [];
      port.onEvent((event) => events.push(event));
      const revision = 42;
      port.beginExport({
        type: "begin-export",
        revision,
        outputWidth: width,
        outputHeight: height,
        renderScale: 1,
        minimumCellSize: 0.01,
        plates,
        layerCount: 2,
        bandHeight,
        paper,
      });
      const waitFor = async (match: (event: RenderWorkerEvent) => boolean, label: string) => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const found = events.find(match);
          if (found) return found;
          const failure = events.find((event) => event.type === "error");
          if (failure) throw new Error(`error waiting for ${label}: ${JSON.stringify(failure)}`);
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      await waitFor((event) => event.type === "export-ready", "export-ready");
      const stack = [
        { raster: bottom, settings: bottomSettings, opacity: 1 },
        { raster: top, settings: topSettings, opacity: 0.5 },
      ];
      for (const plate of plates) {
        for (let layerIndex = 0; layerIndex < stack.length; layerIndex += 1) {
          const layer = stack[layerIndex];
          port.submitLayer({
            type: "submit-layer",
            revision,
            plate,
            layerIndex,
            layer: toLayerInput(layer.raster, layer.settings, layer.opacity),
          });
          await waitFor(
            (event) =>
              event.type === "layer-ack" && event.plate === plate && event.layerIndex === layerIndex,
            `ack ${plate}/${layerIndex}`,
          );
        }
      }
      port.finalizeExport({ type: "finalize-export", revision });
      await waitFor((event) => event.type === "result", "result");

      for (const plate of plates) {
        const expected = plateOf(single, plate);
        const ink = new Float32Array(width * height);
        const alpha = new Float32Array(width * height);
        for (const event of events) {
          if (event.type !== "plate-band" || event.plate !== plate) continue;
          ink.set(new Float32Array(event.inkPremultiplied.buffer), event.rowStart * width);
          alpha.set(new Float32Array(event.alpha.buffer), event.rowStart * width);
        }
        expect(new Uint32Array(ink.buffer), `band ${bandHeight} ink ${plate}`).toEqual(
          new Uint32Array(expected.ink.buffer),
        );
        expect(new Uint32Array(alpha.buffer), `band ${bandHeight} alpha ${plate}`).toEqual(
          new Uint32Array(expected.alpha.buffer),
        );
      }
      const proof = new Uint8ClampedArray(width * height * 4);
      let proofRows = 0;
      for (const event of events) {
        if (event.type !== "proof-band") continue;
        proof.set(new Uint8ClampedArray(event.rgba.buffer), event.rowStart * width * 4);
        proofRows += event.rowCount;
      }
      expect(proofRows).toBe(height);
      expect(single.proof).toBeDefined();
      expect([...proof]).toEqual([...new Uint8ClampedArray(single.proof!.buffer)]);
      port.dispose();
    }
  }, 30_000);
});
