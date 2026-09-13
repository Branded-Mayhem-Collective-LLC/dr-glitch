/**
 * PreviewService — job construction, revision discipline, stale-result
 * discard, layer-prep caching, plate-view vs composite, custom stamps, and
 * crash resubmission, all through a fake RenderPort.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initTelemetry,
  resetTelemetryForTests,
  type SentryEventLike,
  type SentryModuleLike,
} from "../../src/telemetry/sentry";
import {
  buildPreviewJob,
  customStampSizeFor,
  PreviewService,
  previewDraftScale,
  previewPaper,
  previewPlates,
  PREVIEW_MINIMUM_CELL,
  type PreviewSources,
  type PreviewTimerHost,
} from "../../src/app/preview-service";
import { applyCommand, createEmptyProjectCore, createLayerFromAsset } from "../../src/project";
import type { ProjectCoreV1 } from "../../src/core/types";
import type {
  RenderJobRequest,
  RenderPort,
  RenderResultPayload,
  RenderWorkerEvent,
  Revision,
} from "../../src/render";
import type { RasterData } from "../../src/export/orchestrator";

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

class FakePort implements RenderPort {
  jobs: RenderJobRequest[] = [];
  cancelledRevisions: Revision[] = [];
  disposed = false;
  private listeners = new Set<(event: RenderWorkerEvent) => void>();

  submit(job: RenderJobRequest): void {
    this.jobs.push(job);
  }
  cancel(revision: Revision): void {
    this.cancelledRevisions.push(revision);
  }
  dispose(): void {
    this.disposed = true;
  }
  onEvent(listener: (event: RenderWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(event: RenderWorkerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const ASSET_A = "a".repeat(64);
const ASSET_B = "b".repeat(64);

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function coreWithLayer(assetId = ASSET_A): ProjectCoreV1 {
  let core = createEmptyProjectCore();
  const layer = createLayerFromAsset(
    assetId,
    "art.png",
    { width: 320, height: 240 },
    core.artboard,
  );
  core = applyCommand(core, { type: "layer/add", layer });
  return core;
}

function smallRaster(width = 4, height = 4): RasterData {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

type Rig = {
  port: FakePort;
  service: PreviewService;
  resolveRaster: ReturnType<typeof vi.fn>;
  prepareLayer: ReturnType<typeof vi.fn>;
};

function makeRig(overrides: {
  wantBitmap?: boolean;
  sources?: Partial<PreviewSources>;
  maxCrashResubmits?: number;
  timer?: PreviewTimerHost;
} = {}): Rig {
  const port = new FakePort();
  const resolveRaster = vi.fn(async () => smallRaster());
  const prepareLayer = vi.fn(
    (_layer: unknown, _source: RasterData, options: { outputWidth: number; outputHeight: number }) =>
      smallRaster(options.outputWidth, options.outputHeight),
  );
  const service = new PreviewService({
    createPort: () => port,
    sources: { resolveRaster, ...overrides.sources },
    wantBitmap: overrides.wantBitmap ?? false,
    maxCrashResubmits: overrides.maxCrashResubmits,
    prepareLayer: prepareLayer as never,
    timer: overrides.timer,
  });
  return { port, service, resolveRaster, prepareLayer };
}

/** Manually fired timer host for the exact-idle window. */
class FakeIdleTimer {
  private tasks: Array<{ id: number; fn: () => void }> = [];
  private nextId = 1;

  readonly host: PreviewTimerHost = {
    set: (fn) => {
      const id = this.nextId++;
      this.tasks.push({ id, fn });
      return id;
    },
    clear: (handle) => {
      this.tasks = this.tasks.filter((task) => task.id !== handle);
    },
  };

  get pending(): number {
    return this.tasks.length;
  }

  /** Fire every scheduled idle callback (simulates the window elapsing). */
  elapse(): void {
    const due = this.tasks;
    this.tasks = [];
    for (const task of due) task.fn();
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("previewPlates", () => {
  const core = createEmptyProjectCore();

  it("expands composite to the visible CMYK set in press order", () => {
    expect(previewPlates(core.separation, "composite")).toEqual([
      "cyan",
      "magenta",
      "yellow",
      "black",
    ]);
    const hidden = applyCommand(core, {
      type: "separation/set-plate-visibility",
      plate: "magenta",
      visible: false,
    });
    expect(previewPlates(hidden.separation, "composite")).toEqual(["cyan", "yellow", "black"]);
  });

  it("grayscale composite is the black plate alone (and nothing when hidden)", () => {
    const gray = applyCommand(core, { type: "separation/set-mode", mode: "grayscale" });
    expect(previewPlates(gray.separation, "composite")).toEqual(["black"]);
    const dark = applyCommand(gray, {
      type: "separation/set-plate-visibility",
      plate: "black",
      visible: false,
    });
    expect(previewPlates(dark.separation, "composite")).toEqual([]);
  });

  it("plate views pass through (coerced to black under grayscale)", () => {
    expect(previewPlates(core.separation, "cyan")).toEqual(["cyan"]);
    const gray = applyCommand(core, { type: "separation/set-mode", mode: "grayscale" });
    expect(previewPlates(gray.separation, "cyan")).toEqual(["black"]);
  });
});

describe("previewDraftScale / previewPaper / customStampSizeFor", () => {
  it("caps the viewport scale at the draft sample edge", () => {
    const core = createEmptyProjectCore(); // 2640 × 3600
    expect(previewDraftScale(core, 1)).toBeCloseTo(1100 / 3600, 10);
    expect(previewDraftScale(core, 0.1)).toBeCloseTo(0.1, 10);
    expect(previewDraftScale(core, 1, 7200)).toBe(1);
  });

  it("maps backgrounds to the legacy proof papers; transparent keeps alpha", () => {
    expect(previewPaper("white")).toEqual([0xf4, 0xf1, 0xe9]);
    // Canonical background contract (wave F): TRANSPARENT proofs keep real
    // alpha — no paper compositing anywhere in the render job.
    expect(previewPaper("transparent")).toBeNull();
    expect(previewPaper("black")).toEqual([0x11, 0x12, 0x14]);
  });

  it("sizes custom stamps at two samples per effective cell px, clamped", () => {
    // cell 24 at scale 1: effective 24 → ceil(24 * 1.04 * 2) = 50
    expect(customStampSizeFor(24, 1)).toBe(50);
    // Deep draft: the 3px cell floor then the 16px stamp floor apply
    expect(customStampSizeFor(24, 0.01)).toBe(16);
    expect(customStampSizeFor(20000, 1)).toBe(2048);
  });
});

describe("buildPreviewJob", () => {
  const core = coreWithLayer();

  function jobFor(view: "composite" | "cyan", wantBitmap = true): RenderJobRequest {
    return buildPreviewJob({
      revision: 7,
      kind: "preview-draft",
      core,
      view,
      scale: 0.25,
      layers: [{ layer: core.layers[0], raster: smallRaster(660, 900) }],
      wantBitmap,
    });
  }

  it("builds a composite job with paper, scaled output, and preview cell floor", () => {
    const job = jobFor("composite");
    expect(job.revision).toBe(7);
    expect(job.outputWidth).toBe(Math.round(core.artboard.widthPx * 0.25));
    expect(job.outputHeight).toBe(Math.round(core.artboard.heightPx * 0.25));
    expect(job.renderScale).toBe(0.25);
    expect(job.minimumCellSize).toBe(PREVIEW_MINIMUM_CELL);
    expect(job.plates).toEqual(["cyan", "magenta", "yellow", "black"]);
    expect(job.paper).toEqual([0xf4, 0xf1, 0xe9]);
    expect(job.wantBitmap).toBe(true);
    expect(job.layers[0].opacity).toBe(1);
  });

  it("plate views carry one plate, no paper, and never want bitmaps", () => {
    const job = jobFor("cyan", true);
    expect(job.plates).toEqual(["cyan"]);
    expect(job.paper).toBeUndefined();
    expect(job.wantBitmap).toBe(false);
  });

  it("a transparent-background composite job sends NO paper and no bitmap", () => {
    const transparentCore: ProjectCoreV1 = {
      ...core,
      artboard: { ...core.artboard, background: "transparent" },
    };
    const job = buildPreviewJob({
      revision: 3,
      kind: "preview-draft",
      core: transparentCore,
      view: "composite",
      scale: 0.25,
      layers: [{ layer: transparentCore.layers[0], raster: smallRaster(660, 900) }],
      wantBitmap: true,
    });
    expect(job.paper).toBeUndefined();
    expect(job.wantBitmap).toBe(false);
  });

  it("job payloads contain no guide, grid, or snapping data", () => {
    const decorated: ProjectCoreV1 = {
      ...core,
      guides: { horizontal: [31337], vertical: [41337], locked: false, visible: true },
      grid: { visible: true, size: 51337 },
    };
    const job = buildPreviewJob({
      revision: 1,
      kind: "exact-viewport",
      core: decorated,
      view: "composite",
      scale: 1,
      layers: [{ layer: decorated.layers[0], raster: smallRaster() }],
      wantBitmap: false,
    });
    const json = JSON.stringify(job);
    expect(json).not.toContain("guides");
    expect(json).not.toContain("snapping");
    expect(json).not.toContain("31337");
    expect(json).not.toContain("41337");
    expect(json).not.toContain("51337");
  });
});

/* ------------------------------------------------------------------ */
/* Service behavior                                                    */
/* ------------------------------------------------------------------ */

describe("PreviewService", () => {
  it("assigns monotonic revisions and submits draft-vs-exact parameters", async () => {
    const { port, service } = makeRig();
    const core = coreWithLayer();

    const r1 = service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    const r2 = service.requestExact({ core, view: "composite", viewportScale: 0.5 });
    await tick();

    expect(r2).toBeGreaterThan(r1);
    expect(port.jobs).toHaveLength(2);
    const [draft, exact] = port.jobs;
    expect(draft.kind).toBe("preview-draft");
    expect(draft.revision).toBe(r1);
    // 2640×3600 artboard: draft caps at 1100/3600.
    expect(draft.renderScale).toBeCloseTo(1100 / 3600, 10);
    expect(exact.kind).toBe("exact-viewport");
    expect(exact.revision).toBe(r2);
    expect(exact.renderScale).toBe(0.5);
    expect(exact.minimumCellSize).toBe(PREVIEW_MINIMUM_CELL);
  });

  it("delivers only the newest revision's frame and discards stale results", async () => {
    const { port, service } = makeRig();
    const core = coreWithLayer();
    const frames: Revision[] = [];
    service.onFrame((frame) => frames.push(frame.revision));

    const r1 = service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    const r2 = service.requestExact({ core, view: "composite", viewportScale: 1 });
    await tick();

    const close = vi.fn();
    const stale: RenderResultPayload = {
      form: "bitmap",
      bitmap: { close } as unknown as ImageBitmap,
      width: 8,
      height: 8,
    };
    port.emit({ type: "result", revision: r1, kind: "preview-draft", payload: stale });
    expect(frames).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);

    const fresh: RenderResultPayload = { form: "plates", width: 8, height: 8, plates: [] };
    port.emit({ type: "result", revision: r2, kind: "exact-viewport", payload: fresh });
    expect(frames).toEqual([r2]);
  });

  it("frames carry kind, view, renderScale, and paper metadata", async () => {
    const { port, service } = makeRig();
    const core = coreWithLayer();
    const seen: Array<{ kind: string; view: string; paper: unknown }> = [];
    service.onFrame((frame) => seen.push({ kind: frame.kind, view: frame.view, paper: frame.paper }));

    const revision = service.requestDraft({ core, view: "cyan", viewportScale: 1 });
    await tick();
    port.emit({
      type: "result",
      revision,
      kind: "preview-draft",
      payload: { form: "plates", width: 8, height: 8, plates: [] },
    });
    expect(seen).toEqual([{ kind: "preview-draft", view: "cyan", paper: null }]);
  });

  it("decodes each asset once and re-warps only when the fingerprint changes", async () => {
    const { port, service, resolveRaster, prepareLayer } = makeRig();
    const core = coreWithLayer();

    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    service.requestDraft({ core, view: "cyan", viewportScale: 1 });
    await tick();

    // Same geometry + scale: decode once, warp once.
    expect(resolveRaster).toHaveBeenCalledTimes(1);
    expect(prepareLayer).toHaveBeenCalledTimes(1);

    // Moving the layer invalidates the warp cache but not the decode.
    const moved = applyCommand(core, {
      type: "layer/set-transform",
      layerId: core.layers[0].id,
      patch: { position: { x: 99, y: 99 } },
    });
    service.requestDraft({ core: moved, view: "composite", viewportScale: 1 });
    await tick();
    expect(resolveRaster).toHaveBeenCalledTimes(1);
    expect(prepareLayer).toHaveBeenCalledTimes(2);

    // A different exact scale is a different output size → new warp.
    service.requestExact({ core: moved, view: "composite", viewportScale: 0.9 });
    await tick();
    expect(prepareLayer).toHaveBeenCalledTimes(3);
    expect(port.jobs).toHaveLength(4);
  });

  it("copies raster buffers per submit so transfer can never detach the cache", async () => {
    const { port, service } = makeRig();
    const core = coreWithLayer();
    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    service.requestDraft({ core, view: "cyan", viewportScale: 1 });
    await tick();
    expect(port.jobs).toHaveLength(2);
    const firstRaster = port.jobs[0].layers[0].raster;
    const secondRaster = port.jobs[1].layers[0].raster;
    expect(firstRaster).toBeDefined();
    expect(secondRaster).toBeDefined();
    expect(firstRaster!.buffer).not.toBe(secondRaster!.buffer);
  });

  it("skips hidden layers", async () => {
    const { port, service } = makeRig();
    let core = coreWithLayer();
    core = applyCommand(core, {
      type: "layer/set-visibility",
      layerId: core.layers[0].id,
      visible: false,
    });
    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    expect(port.jobs[0].layers).toEqual([]);
  });

  it("resolves main-thread custom stamps for custom-dot halftone layers", async () => {
    const stamp = { close: vi.fn() } as unknown as ImageBitmap;
    const resolveCustomStamp = vi.fn(async () => stamp);
    const { port, service } = makeRig({ sources: { resolveCustomStamp } });

    let core = coreWithLayer();
    core = applyCommand(core, {
      type: "layer/set-mode",
      layerId: core.layers[0].id,
      mode: "halftone",
    });
    core = applyCommand(core, {
      type: "recipe/update-halftone",
      layerId: core.layers[0].id,
      patch: { dotShape: "custom", customShapeAssetId: ASSET_B },
    });
    service.requestExact({ core, view: "composite", viewportScale: 1 });
    await tick();

    expect(resolveCustomStamp).toHaveBeenCalledWith(
      ASSET_B,
      customStampSizeFor(core.layers[0].recipe.halftone.cellSize, 1),
    );
    expect(port.jobs[0].layers[0].customStamp).toBe(stamp);
  });

  it("surfaces a stable error when a custom stamp source is missing", async () => {
    const { port, service } = makeRig();
    const errors: string[] = [];
    service.onError((error) => errors.push(error.code));

    let core = coreWithLayer();
    core = applyCommand(core, {
      type: "layer/set-mode",
      layerId: core.layers[0].id,
      mode: "halftone",
    });
    core = applyCommand(core, {
      type: "recipe/update-halftone",
      layerId: core.layers[0].id,
      patch: { dotShape: "custom", customShapeAssetId: ASSET_B },
    });
    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();

    expect(errors).toEqual(["custom-stamp-unavailable"]);
    expect(port.jobs).toHaveLength(0);
  });

  it("rebuilds and resubmits the latest request after a worker crash, then surfaces", async () => {
    const { port, service } = makeRig({ maxCrashResubmits: 1 });
    const core = coreWithLayer();
    const errors: string[] = [];
    service.onError((error) => errors.push(error.code));

    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    expect(port.jobs).toHaveLength(1);

    port.emit({ type: "error", revision: null, code: "worker-crashed", message: "boom" });
    await tick();
    expect(port.jobs).toHaveLength(2);
    expect(port.jobs[1].revision).toBeGreaterThan(port.jobs[0].revision);
    expect(errors).toEqual([]);

    port.emit({ type: "error", revision: null, code: "worker-crashed", message: "boom" });
    await tick();
    expect(port.jobs).toHaveLength(2);
    expect(errors).toEqual(["worker-crashed"]);
  });

  it("dispose tears down the port and silences frames", async () => {
    const { port, service } = makeRig();
    const core = coreWithLayer();
    const frames: unknown[] = [];
    service.onFrame((frame) => frames.push(frame));

    const revision = service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    service.dispose();
    expect(port.disposed).toBe(true);
    port.emit({
      type: "result",
      revision,
      kind: "preview-draft",
      payload: { form: "plates", width: 8, height: 8, plates: [] },
    });
    expect(frames).toEqual([]);
  });

  it("prunes decode and warp caches for removed layers", async () => {
    const { service, resolveRaster, prepareLayer } = makeRig();
    const core = coreWithLayer();
    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    expect(prepareLayer).toHaveBeenCalledTimes(1);

    const empty = applyCommand(core, { type: "layer/remove", layerId: core.layers[0].id });
    service.pruneCaches(empty);

    // Re-adding the same asset decodes again — the cache was really dropped.
    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();
    expect(resolveRaster).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/* requestPreview: double-gated draft-then-exact scheduling            */
/* ------------------------------------------------------------------ */

describe("PreviewService.requestPreview", () => {
  const plates = (): RenderResultPayload => ({ form: "plates", width: 8, height: 8, plates: [] });
  // 2640×3600 artboard: draft cap ≈ 0.3056, so 0.5 forces exact > draft.
  const SCALED = 0.5;

  it("a slow draft (longer than the idle window) still paints before exact", async () => {
    let releaseDecode!: () => void;
    const gate = new Promise<void>((resolve) => (releaseDecode = resolve));
    const idle = new FakeIdleTimer();
    const { port, service } = makeRig({
      timer: idle.host,
      sources: {
        resolveRaster: async () => {
          await gate;
          return smallRaster();
        },
      },
    });
    const core = coreWithLayer();
    const frames: Array<{ revision: Revision; kind: string }> = [];
    service.onFrame((frame) => frames.push({ revision: frame.revision, kind: frame.kind }));

    const draftRevision = service.requestPreview({ core, view: "composite", viewportScale: SCALED });
    // The idle window elapses while the draft is STILL building — under the
    // old unconditional timer this is the moment exact superseded the draft.
    idle.elapse();
    await tick();
    expect(port.jobs).toHaveLength(0);

    releaseDecode();
    await tick();
    expect(port.jobs).toHaveLength(1);
    expect(port.jobs[0].kind).toBe("preview-draft");

    // Draft delivers → the frame presents, and only then does exact follow.
    port.emit({ type: "result", revision: draftRevision, kind: "preview-draft", payload: plates() });
    expect(frames).toEqual([{ revision: draftRevision, kind: "preview-draft" }]);
    await tick();
    expect(port.jobs).toHaveLength(2);
    expect(port.jobs[1].kind).toBe("exact-viewport");
    expect(port.jobs[1].revision).toBeGreaterThan(draftRevision);
  });

  it("fast drafts during a scrub never start exact before the idle window", async () => {
    const idle = new FakeIdleTimer();
    const { port, service } = makeRig({ timer: idle.host });
    const core = coreWithLayer();
    const frames: Revision[] = [];
    service.onFrame((frame) => frames.push(frame.revision));

    // Scrub: each input's draft delivers quickly, then the next input lands
    // before the idle window elapses — no exact may start in between.
    let last: Revision = 0;
    for (let step = 0; step < 3; step++) {
      last = service.requestPreview({ core, view: "composite", viewportScale: SCALED });
      await tick();
      port.emit({ type: "result", revision: last, kind: "preview-draft", payload: plates() });
      await tick();
      expect(port.jobs.filter((job) => job.kind === "exact-viewport")).toHaveLength(0);
    }
    // Every draft presented (no starvation), newest last.
    expect(frames).toHaveLength(3);
    expect(frames[2]).toBe(last);

    // The scrub ends: the idle window elapses → exactly ONE exact goes out.
    idle.elapse();
    await tick();
    const exactJobs = port.jobs.filter((job) => job.kind === "exact-viewport");
    expect(exactJobs).toHaveLength(1);
    expect(exactJobs[0].revision).toBeGreaterThan(last);
    // One generation, one exact: nothing else is pending.
    expect(idle.pending).toBe(0);
  });

  it("skips the exact entirely when the draft already renders at the exact scale", async () => {
    const idle = new FakeIdleTimer();
    const { port, service } = makeRig({ timer: idle.host });
    const core = coreWithLayer();
    // 0.2 is below the draft cap (≈0.3056): draftScale === exactScale.
    const revision = service.requestPreview({ core, view: "composite", viewportScale: 0.2 });
    // No idle timer is even scheduled — there is no exact to gate.
    expect(idle.pending).toBe(0);
    await tick();
    port.emit({ type: "result", revision, kind: "preview-draft", payload: plates() });
    await tick();
    idle.elapse();
    await tick();
    expect(port.jobs.filter((job) => job.kind === "exact-viewport")).toHaveLength(0);
  });

  it("a stale draft cannot arm the exact follow-up of a newer generation", async () => {
    const idle = new FakeIdleTimer();
    const { port, service } = makeRig({ timer: idle.host });
    const coreA = coreWithLayer();
    const coreB = applyCommand(coreA, {
      type: "layer/set-transform",
      layerId: coreA.layers[0].id,
      patch: { position: { x: 42, y: 42 } },
    });
    const frames: Revision[] = [];
    service.onFrame((frame) => frames.push(frame.revision));

    const rA = service.requestPreview({ core: coreA, view: "composite", viewportScale: SCALED });
    await tick();
    const rB = service.requestPreview({ core: coreB, view: "composite", viewportScale: SCALED });
    await tick();
    idle.elapse(); // B's idle gate opens; delivery gate still closed

    // A's late result: stale — discarded, no frame, and no exact armed.
    port.emit({ type: "result", revision: rA, kind: "preview-draft", payload: plates() });
    await tick();
    expect(frames).toEqual([]);
    expect(port.jobs.filter((job) => job.kind === "exact-viewport")).toHaveLength(0);

    // B delivers → both gates open → exactly one exact for the newest input.
    port.emit({ type: "result", revision: rB, kind: "preview-draft", payload: plates() });
    await tick();
    const exactJobs = port.jobs.filter((job) => job.kind === "exact-viewport");
    expect(exactJobs).toHaveLength(1);
    expect(exactJobs[0].revision).toBeGreaterThan(rB);
  });

  it("an exact frame never triggers another exact (no follow-up loops)", async () => {
    const idle = new FakeIdleTimer();
    const { port, service } = makeRig({ timer: idle.host });
    const core = coreWithLayer();

    const draftRevision = service.requestPreview({ core, view: "composite", viewportScale: SCALED });
    await tick();
    port.emit({ type: "result", revision: draftRevision, kind: "preview-draft", payload: plates() });
    idle.elapse();
    await tick();
    const exact = port.jobs.find((job) => job.kind === "exact-viewport");
    expect(exact).toBeDefined();
    port.emit({ type: "result", revision: exact!.revision, kind: "exact-viewport", payload: plates() });
    await tick();
    expect(port.jobs.filter((job) => job.kind === "exact-viewport")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Stale-result gate: latestRequested, not latestSubmitted             */
/* ------------------------------------------------------------------ */

describe("PreviewService stale-result gate", () => {
  it("discards revision N while N+1 is still mid-async-build", async () => {
    // N resolves instantly; N+1's decode is held open so N+1 is REQUESTED
    // but not yet SUBMITTED when N's result arrives. A latestSubmitted
    // gate would wrongly present N; the latestRequested gate discards it.
    let call = 0;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    const { port, service } = makeRig({
      sources: {
        resolveRaster: async () => {
          call += 1;
          if (call > 1) await secondGate;
          return smallRaster();
        },
      },
    });
    // A different asset for N+1 so its decode really goes through the gate
    // (a same-asset edit would reuse N's decode cache and build instantly).
    const coreA = coreWithLayer(ASSET_A);
    const coreB = coreWithLayer(ASSET_B);
    const frames: Revision[] = [];
    service.onFrame((frame) => frames.push(frame.revision));

    const rN = service.requestDraft({ core: coreA, view: "composite", viewportScale: 1 });
    await tick();
    expect(port.jobs.map((job) => job.revision)).toEqual([rN]);

    // N+1 requested; its build blocks on the decode gate (not submitted).
    const rNext = service.requestDraft({ core: coreB, view: "composite", viewportScale: 1 });
    await tick();
    expect(port.jobs.map((job) => job.revision)).toEqual([rN]);

    // N's result lands mid-build of N+1: must be discarded, bitmap closed.
    const close = vi.fn();
    port.emit({
      type: "result",
      revision: rN,
      kind: "preview-draft",
      payload: { form: "bitmap", bitmap: { close } as unknown as ImageBitmap, width: 8, height: 8 },
    });
    expect(frames).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);

    // N+1 finishes building, submits, and presents.
    releaseSecond();
    await tick();
    expect(port.jobs.map((job) => job.revision)).toEqual([rN, rNext]);
    port.emit({ type: "result", revision: rNext, kind: "preview-draft", payload: { form: "plates", width: 8, height: 8, plates: [] } });
    expect(frames).toEqual([rNext]);
  });
});

/* ------------------------------------------------------------------ */
/* Telemetry: preview worker crash exhaustion                          */
/* ------------------------------------------------------------------ */

describe("telemetry — preview worker crash", () => {
  afterEach(() => resetTelemetryForTests());

  function fakeTransport() {
    const captured: SentryEventLike[] = [];
    const sentry: SentryModuleLike = {
      init: () => undefined,
      captureEvent: (event) => void captured.push(event),
    };
    return { sentry, captured };
  }

  const telemetryEnv = {
    dsn: "https://public@example.ingest.invalid/1",
    release: "dr-glitch@0.1.0",
    environment: "production",
    privateValidation: false,
  };

  it("reports exactly ONE scrubbed stable-code event when replacement is exhausted", async () => {
    const { sentry, captured } = fakeTransport();
    await initTelemetry({ env: telemetryEnv, loadSentry: async () => sentry });

    const { port, service } = makeRig({ maxCrashResubmits: 1 });
    const core = coreWithLayer();
    const errors: string[] = [];
    service.onError((error) => errors.push(error.code));
    service.requestDraft({ core, view: "composite", viewportScale: 1 });
    await tick();

    // First crash: silent resubmission — no event.
    port.emit({ type: "error", revision: null, code: "worker-crashed", message: "boom" });
    await tick();
    expect(captured).toHaveLength(0);

    // Second crash: replacement exhausted — exactly one event.
    port.emit({ type: "error", revision: null, code: "worker-crashed", message: "boom" });
    await tick();
    expect(errors).toEqual(["worker-crashed"]);
    expect(captured).toHaveLength(1);
    expect(captured[0].tags).toMatchObject({
      error_code: "preview-worker-crash",
      layer_count_bucket: "1",
    });
    // Full scrub: no layer/file/project-derived values anywhere.
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain("art.png");
    expect(serialized).not.toContain(core.layers[0].id);
    expect(serialized).not.toContain(core.layers[0].assetId);
  });

  it("reports nothing without a DSN", async () => {
    const enabled = await initTelemetry({
      env: { ...telemetryEnv, dsn: null },
      loadSentry: async () => {
        throw new Error("must never load");
      },
    });
    expect(enabled).toBe(false);
    const { port, service } = makeRig({ maxCrashResubmits: 0 });
    service.onError(() => undefined);
    service.requestDraft({ core: coreWithLayer(), view: "composite", viewportScale: 1 });
    await tick();
    expect(() =>
      port.emit({ type: "error", revision: null, code: "worker-crashed", message: "boom" }),
    ).not.toThrow();
  });

  it("non-crash render errors do not emit crash telemetry", async () => {
    const { sentry, captured } = fakeTransport();
    await initTelemetry({ env: telemetryEnv, loadSentry: async () => sentry });
    const { port, service } = makeRig();
    service.onError(() => undefined);
    service.requestDraft({ core: coreWithLayer(), view: "composite", viewportScale: 1 });
    await tick();
    port.emit({ type: "error", revision: 1, code: "render-failed", message: "tile error" });
    expect(captured).toHaveLength(0);
  });
});
