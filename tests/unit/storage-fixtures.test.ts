/**
 * Shared fixtures for the storage unit suite. Other storage-*.test.ts files
 * import the factories from here; the sanity test below keeps this file a
 * valid vitest module and pins the fixture invariants.
 */
import { describe, expect, it } from "vitest";
import type {
  LayerV1,
  ProjectCoreV1,
  ProjectEnvelopeV1,
  RecoveryRecordV1,
  SnapshotV1,
} from "../../src/core/types";
import type { Clock, TimerHandle, TimerHost } from "../../src/storage/clock";

let counter = 0;

export const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;

export function makeLayer(overrides: Partial<LayerV1> = {}): LayerV1 {
  return {
    id: nextId("layer"),
    name: "Layer",
    assetId: "a".repeat(64),
    visible: true,
    locked: false,
    opacity: 1,
    crop: null,
    transform: {
      position: { x: 0, y: 0 },
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
        cellSize: 8,
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
        modStrength: 0,
        intensity: 1,
        levels: 2,
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
        sliceSize: 0,
        verticalSliceShift: 0,
        verticalSliceSize: 0,
        gridWarp: 0,
        warpScale: 0,
        smearDrag: 0,
        smearLength: 0,
        smearVertical: false,
        macroblockCorrupt: 0,
        macroblockDropout: 0,
        blockShift: 0,
        blockShiftSize: 0,
        channelDesync: 0,
        bitmapSort: 0,
        bitmapSortVertical: false,
      },
    },
    ...overrides,
  };
}

export function makeCore(overrides: Partial<ProjectCoreV1> = {}): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: 2640, heightPx: 3600, presetId: "11x15", background: "white" },
    layers: [],
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
    unitPreference: "in",
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    id: nextId("snapshot"),
    name: "Checkpoint",
    createdAt: 1_000,
    thumbnailId: null,
    core: makeCore(),
    ...overrides,
  };
}

export function makeEnvelope(overrides: Partial<ProjectEnvelopeV1> = {}): ProjectEnvelopeV1 {
  return {
    schema: 1,
    id: nextId("project"),
    title: "Untitled",
    createdAt: 1_000,
    updatedAt: 1_000,
    savedRevision: 1,
    core: makeCore(),
    snapshots: [],
    ...overrides,
  };
}

export function makeRecovery(overrides: Partial<RecoveryRecordV1> = {}): RecoveryRecordV1 {
  return {
    projectId: nextId("project"),
    revision: 2,
    savedRevision: 1,
    updatedAt: 1_000,
    title: "Untitled",
    core: makeCore(),
    snapshots: [],
    ...overrides,
  };
}

/** Deterministic clock + timer for debounce/TTL logic. */
export class FakeScheduler {
  nowMs = 0;
  private nextHandle = 1;
  private readonly tasks = new Map<number, { at: number; run: () => void }>();

  readonly clock: Clock = () => this.nowMs;

  readonly timer: TimerHost = {
    set: (callback, delayMs): TimerHandle => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.tasks.set(handle, { at: this.nowMs + delayMs, run: callback });
      return handle;
    },
    clear: (handle): void => {
      this.tasks.delete(handle as number);
    },
  };

  /** Advance time, firing due tasks in schedule order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [handle, task] = due[0];
      this.tasks.delete(handle);
      this.nowMs = Math.max(this.nowMs, task.at);
      task.run();
      // Let any promise chains started by the task settle (backend
      // transactions run several microtask turns deep).
      for (let i = 0; i < 25; i += 1) {
        await Promise.resolve();
      }
    }
    this.nowMs = target;
  }

  get pendingCount(): number {
    return this.tasks.size;
  }
}

describe("storage fixtures", () => {
  it("builds schema-valid envelopes with unique ids", () => {
    const a = makeEnvelope();
    const b = makeEnvelope();
    expect(a.id).not.toBe(b.id);
    expect(a.schema).toBe(1);
    expect(a.core.artboard.widthPx).toBe(2640);
  });

  it("fires fake timers in order and supports clear", async () => {
    const scheduler = new FakeScheduler();
    const fired: string[] = [];
    scheduler.timer.set(() => fired.push("late"), 100);
    const early = scheduler.timer.set(() => fired.push("early"), 10);
    scheduler.timer.clear(early);
    await scheduler.advance(200);
    expect(fired).toEqual(["late"]);
    expect(scheduler.nowMs).toBe(200);
  });
});
