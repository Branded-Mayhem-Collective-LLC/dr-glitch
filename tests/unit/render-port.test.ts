/**
 * RenderPort behavior via MainThreadRenderer, which shares the executor with
 * both workers. In node there is no OffscreenCanvas, so this exercises the
 * reduced-performance typed-array path end to end: kernels run, results come
 * back as transferable layer data, newer preview revisions supersede older
 * ones, and cancellation/disposal behave.
 */
import { describe, expect, it } from "vitest";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import type {
  RenderJobRequest,
  RenderResultPayload,
  RenderWorkerEvent,
} from "../../src/render/protocol";
import { gradientRaster } from "../../src/render/fixtures";
import type { HalftoneSettings } from "../../src/studio/halftone";

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

function makeJob(revision: number, overrides: Partial<RenderJobRequest> = {}): RenderJobRequest {
  const raster = gradientRaster(48, 36);
  return {
    type: "job",
    kind: "preview-draft",
    revision,
    outputWidth: 48,
    outputHeight: 36,
    renderScale: 1,
    minimumCellSize: 3,
    plates: ["cyan", "black"],
    layers: [
      {
        raster: { buffer: raster.data.buffer as ArrayBuffer, width: raster.width, height: raster.height },
        settings: settings(),
        opacity: 1,
        dotShape: "round",
        strokeWidth: 1,
      },
    ],
    wantBitmap: false,
    ...overrides,
  };
}

function collectUntil(
  port: MainThreadRenderer,
  done: (events: RenderWorkerEvent[]) => boolean,
  timeoutMs = 5000,
): Promise<RenderWorkerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RenderWorkerEvent[] = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout; saw ${events.map((event) => event.type).join(",")}`));
    }, timeoutMs);
    const unsubscribe = port.onEvent((event) => {
      events.push(event);
      if (done(events)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(events);
      }
    });
  });
}

describe("MainThreadRenderer", () => {
  it("runs a job through the kernels and returns layer data with placements", async () => {
    const port = new MainThreadRenderer();
    const waiting = collectUntil(port, (events) => events.some((event) => event.type === "result"));
    port.submit(makeJob(1));
    const events = await waiting;
    const result = events.find((event) => event.type === "result");
    expect(result && result.type === "result" && result.revision).toBe(1);
    const payload = (result as { payload: RenderResultPayload }).payload;
    expect(payload.form).toBe("layer-data");
    if (payload.form !== "layer-data") return;
    expect(payload.layers.map((layer) => layer.plate)).toEqual(["cyan", "black"]);
    for (const layer of payload.layers) {
      expect(layer.mode).toBe("halftone");
      expect(layer.placements && layer.placements.count).toBeGreaterThan(0);
      expect(new Float32Array(layer.field.buffer).length).toBe(48 * 36);
      expect(new Float32Array(layer.alpha.buffer).every((value) => value === 1)).toBe(true);
    }
    expect(events.some((event) => event.type === "progress")).toBe(true);
    port.dispose();
  });

  it("supersedes older preview revisions and never delivers stale results", async () => {
    const port = new MainThreadRenderer();
    const waiting = collectUntil(port, (events) => events.some((event) => event.type === "result"));
    port.submit(makeJob(1));
    port.submit(makeJob(2));
    const events = await waiting;
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].type === "result" && results[0].revision).toBe(2);
    expect(events.some((event) => event.type === "cancelled" && event.revision === 1)).toBe(true);
    port.dispose();
  });

  it("cancels a queued job explicitly", async () => {
    const port = new MainThreadRenderer(false);
    const waiting = collectUntil(port, (events) =>
      events.some((event) => event.type === "result" && event.revision === 3));
    port.submit(makeJob(3, { kind: "export" }));
    port.submit(makeJob(4, { kind: "export" }));
    port.cancel(4);
    const events = await waiting;
    expect(events.some((event) => event.type === "cancelled" && event.revision === 4)).toBe(true);
    const results = events.filter((event) => event.type === "result");
    expect(results.every((event) => event.type === "result" && event.revision === 3)).toBe(true);
    port.dispose();
  });

  it("runs diffusion-mode layers through the diffusion kernel", async () => {
    const port = new MainThreadRenderer();
    const job = makeJob(9);
    job.layers[0].settings = settings({ diffusionEnabled: true, diffusionLevels: 2, diffusionIntensity: 1 });
    const waiting = collectUntil(port, (events) => events.some((event) => event.type === "result"));
    port.submit(job);
    const events = await waiting;
    const result = events.find((event) => event.type === "result");
    const payload = (result as { payload: RenderResultPayload }).payload;
    expect(payload.form).toBe("layer-data");
    if (payload.form !== "layer-data") return;
    expect(payload.layers.every((layer) => layer.mode === "diffusion")).toBe(true);
    expect(payload.layers.every((layer) => layer.placements === undefined)).toBe(true);
    port.dispose();
  });

  it("acknowledges dispose and refuses further work", async () => {
    const port = new MainThreadRenderer();
    const seen: RenderWorkerEvent[] = [];
    port.onEvent((event) => seen.push(event));
    port.dispose();
    expect(seen.some((event) => event.type === "disposed")).toBe(true);
    port.submit(makeJob(10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.filter((event) => event.type === "result")).toHaveLength(0);
  });
});
