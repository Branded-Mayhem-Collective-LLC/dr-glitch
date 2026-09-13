/**
 * REAL PreviewService integration over the REAL render stack: the actual
 * src/app/preview-service.ts (no fakes) drives MainThreadRenderer →
 * executeRenderJob with the production draft-then-exact policy — decode,
 * main-thread prepareLayerRaster, revision discipline, delivery-gated +
 * idle-gated exact scheduling, frame delivery.
 *
 * Also pins the wave-G1 settle-scheduling capability the audit demanded:
 * adaptive preview drafts publish their executed reduction
 * (payload.draftScaleDown) and previewDraftIsApproximate exposes the SAME
 * policy the executor applies, so the equal-scale exact skip can be gated
 * correctly. (The one-hunk PreviewService gate change that consumes the
 * predicate is specified in the wave-G1 report for the app owner; this
 * suite proves the capability end to end at the service seam.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PreviewService, type PreviewFrame } from "../../src/app/preview-service";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import type { LayerV1, ProjectCoreV1, Sha256 } from "../../src/core/types";
import type { RasterData } from "../../src/export/orchestrator";

/* Clean-mode layers never rasterize dots, so a bare OffscreenCanvas stub
 * keeps the executor on the compose-capable path (plates payloads, adaptive
 * drafts) without any real drawing. */
class StubOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): null {
    return null;
  }
}
const globalScope = globalThis as { OffscreenCanvas?: unknown };
beforeAll(() => {
  globalScope.OffscreenCanvas = StubOffscreenCanvas;
});
afterAll(() => {
  delete globalScope.OffscreenCanvas;
});

const ASSET: Sha256 = "d".repeat(64);

function makeLayer(id: string, width: number, height: number): LayerV1 {
  return {
    id,
    name: id,
    assetId: ASSET,
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: {
      position: { x: width / 2, y: height / 2 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      flipH: false,
      flipV: false,
      skew: { x: 0, y: 0 },
      perspective: null,
    },
    recipe: {
      mode: "clean",
      halftone: {
        cellSize: 12,
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
  };
}

function makeCore(width: number, height: number, layerCount: number): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: width, heightPx: height, presetId: "custom", background: "white" },
    layers: Array.from({ length: layerCount }, (_, index) => makeLayer(`layer-${index}`, width, height)),
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
  };
}

function sourceRaster(width: number, height: number): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = (index * 7) % 220;
    data[index * 4 + 1] = (index * 13) % 220;
    data[index * 4 + 2] = (index * 3) % 220;
    data[index * 4 + 3] = 255;
  }
  return { data, width, height };
}

function waitForFrames(
  frames: PreviewFrame[],
  count: number,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (frames.length >= count) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`timeout waiting for ${count} frames; got ${frames.length}`));
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("PreviewService × real render stack", () => {
  it("draft-then-exact: real service schedules and settles the exact viewport after the idle window", async () => {
    // 1600×1200 artboard, viewport at 100%: the public draft scale (1100
    // cap ⇒ 0.6875) differs from the viewport scale, so the production
    // policy schedules the exact follow-up once the draft delivered AND the
    // idle window elapsed.
    const core = makeCore(1600, 1200, 1);
    const source = sourceRaster(1600, 1200);
    const timers: Array<() => void> = [];
    const service = new PreviewService({
      createPort: () => new MainThreadRenderer(true),
      sources: { resolveRaster: async () => source },
      timer: {
        set: (callback) => {
          timers.push(callback);
          return timers.length - 1;
        },
        clear: () => undefined,
      },
    });
    const frames: PreviewFrame[] = [];
    service.onFrame((frame) => frames.push(frame));
    const errors: string[] = [];
    service.onError((error) => errors.push(`${error.code}: ${error.message}`));

    service.requestPreview({ core, view: "composite", viewportScale: 1 });
    await waitForFrames(frames, 1);
    expect(errors).toEqual([]);
    expect(frames[0].kind).toBe("preview-draft");
    expect(frames[0].renderScale).toBeCloseTo(1100 / 1600, 6);

    // Idle gate: fire the armed timer; the exact viewport job must follow.
    expect(timers.length).toBeGreaterThan(0);
    for (const fire of timers.splice(0)) fire();
    await waitForFrames(frames, 2);
    expect(errors).toEqual([]);
    expect(frames[1].kind).toBe("exact-viewport");
    expect(frames[1].renderScale).toBe(1);
    // The exact settle is full-fidelity: no adaptive reduction marker.
    expect(
      frames[1].payload.form === "plates" ? frames[1].payload.draftScaleDown ?? 1 : 1,
    ).toBe(1);
    service.dispose();
  });

  it("requestPreview on a DEEP stack at equal public scales: approximate draft, then the exact settle — exactly two frames, in order", async () => {
    // Deep stack + small viewport: public draft scale EQUALS the viewport
    // scale (0.5), but the executor renders the draft internally at the
    // adaptive edge — the production gate must therefore still arm and
    // fire the exact settle (the old equal-scale skip was the audit
    // blocker).
    const width = 1600;
    const height = 1200;
    const core = makeCore(width, height, 8);
    const source = sourceRaster(width, height);
    const timers: Array<() => void> = [];
    const service = new PreviewService({
      createPort: () => new MainThreadRenderer(true),
      sources: { resolveRaster: async () => source },
      timer: {
        set: (callback) => {
          timers.push(callback);
          return timers.length - 1;
        },
        clear: () => undefined,
      },
    });
    const frames: PreviewFrame[] = [];
    service.onFrame((frame) => frames.push(frame));
    const errors: string[] = [];
    service.onError((error) => errors.push(`${error.code}: ${error.message}`));

    service.requestPreview({ core, view: "composite", viewportScale: 0.5 });
    await waitForFrames(frames, 1);
    expect(errors).toEqual([]);
    expect(frames[0].kind).toBe("preview-draft");
    expect(frames[0].renderScale).toBe(0.5); // public scale equals viewport scale
    // The delivered draft is marked as adaptively reduced…
    expect(frames[0].payload.form).toBe("plates");
    if (frames[0].payload.form === "plates") {
      expect(frames[0].payload.draftScaleDown).toBeDefined();
      expect(frames[0].payload.draftScaleDown!).toBeLessThan(1);
      expect(frames[0].payload.width).toBe(width * 0.5);
      expect(frames[0].payload.height).toBe(height * 0.5);
    }
    // …and the production gate armed the exact plan despite equal scales.
    expect(timers.length).toBeGreaterThan(0);
    for (const fire of timers.splice(0)) fire();
    await waitForFrames(frames, 2);
    expect(errors).toEqual([]);
    expect(frames.length).toBe(2);
    expect(frames[1].kind).toBe("exact-viewport");
    expect(frames[1].renderScale).toBe(0.5);
    // The settle is full-fidelity: no adaptive reduction marker.
    expect(
      frames[1].payload.form === "plates" ? (frames[1].payload.draftScaleDown ?? 1) : 1,
    ).toBe(1);
    // No further frames trickle in (no duplicate exact).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames.length).toBe(2);
    service.dispose();
  });

  it("requestPreview on a SHALLOW stack at truly equal scales: one frame, no exact scheduled", async () => {
    const width = 1600;
    const height = 1200;
    const core = makeCore(width, height, 1);
    const source = sourceRaster(width, height);
    const timers: Array<() => void> = [];
    const service = new PreviewService({
      createPort: () => new MainThreadRenderer(true),
      sources: { resolveRaster: async () => source },
      timer: {
        set: (callback) => {
          timers.push(callback);
          return timers.length - 1;
        },
        clear: () => undefined,
      },
    });
    const frames: PreviewFrame[] = [];
    service.onFrame((frame) => frames.push(frame));

    service.requestPreview({ core, view: "composite", viewportScale: 0.5 });
    await waitForFrames(frames, 1);
    expect(frames[0].kind).toBe("preview-draft");
    // 1 layer × 4 plates at 800×600 is NOT adaptive: the executed scale
    // truly equals the viewport scale, so the skip is valid — no exact
    // plan was armed and no second frame ever arrives.
    expect(
      frames[0].payload.form === "plates" ? (frames[0].payload.draftScaleDown ?? 1) : 1,
    ).toBe(1);
    expect(timers.length).toBe(0);
    for (const fire of timers.splice(0)) fire();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(frames.length).toBe(1);
    service.dispose();
  });
});
