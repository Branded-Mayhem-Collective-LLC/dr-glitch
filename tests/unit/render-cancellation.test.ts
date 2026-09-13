/**
 * Cooperative kernels: (1) every *Coop variant is bit-identical to its
 * synchronous parity original, and (2) cancellation is observable DURING
 * each heavy phase — warp (render-prep.test.ts), coverage separation,
 * glitch remap/macroblock, bitmap sort, diffusion preprocess, banded
 * diffusion scan, grid collection, and rasterization (render-tiling) — with
 * the abort landing within the 250ms latency budget while the phase is
 * artificially slowed (instrumented slow checkpoints).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCoverageBaseCoop,
  buildCoverageField,
  buildCoverageFieldCoop,
  visibleContentBounds,
} from "../../src/render/kernels/coverage";
import {
  bitmapSortField,
  bitmapSortFieldCoop,
  buildGlitchField,
  buildGlitchFieldCoop,
} from "../../src/render/kernels/glitch";
import {
  buildDiffusionField,
  buildDiffusionFieldCoop,
  preprocessDiffusionField,
  preprocessDiffusionFieldCoop,
  processBandedDiffusion,
  processBandedDiffusionCoop,
} from "../../src/render/kernels/diffusion";
import {
  collectGridDots,
  collectGridDotsCoop,
  effectiveCellSize,
  type GridGeometry,
} from "../../src/render/kernels/halftone-grid";
import { gradientRaster, noiseRaster } from "../../src/render/fixtures";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";
import type { RenderSettings } from "../../src/render/settings";

const WIDTH = 64;
const HEIGHT = 48;

afterEach(() => setAllocationObserver(null));

function baseSettings(overrides: Partial<RenderSettings> = {}): RenderSettings {
  return {
    cellSize: 6,
    frayedXEdge: 0,
    frayedYEdge: 0,
    invert: false,
    angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
    visible: { cyan: true, magenta: true, yellow: true, black: true },
    ...overrides,
  };
}

const HEAVY_GLITCH: Partial<RenderSettings> = {
  sliceShift: 6,
  verticalSliceShift: 4,
  gridWarp: 3,
  smearDrag: 0.4,
  macroblockCorrupt: 0.4,
  blockShift: 0.3,
  blockShiftSize: 8,
  channelDesync: 1,
  bitmapSort: 0.5,
};

const DIFFUSION: Partial<RenderSettings> = {
  diffusionEnabled: true,
  diffusionAlgorithm: "stucki",
  diffusionIntensity: 0.85,
  diffusionLevels: 3,
  diffusionModulation: "medium",
  diffusionModStrength: 0.6,
  diffusionDenoise: 0.5,
  diffusionSharpenStrength: 0.4,
  diffusionSharpenRadius: 2,
};

const same = (left: Float32Array, right: Float32Array) =>
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  );

/** Checkpoint counting calls; throws `abort` at call number `failAt`. */
function countingCheckpoint(failAt = Infinity, abort = new Error("phase-abort")) {
  const state = { calls: 0, abort };
  const checkpoint = () => {
    state.calls += 1;
    if (state.calls >= failAt) throw abort;
  };
  return { state, checkpoint };
}

async function expectAbortReleasesLedger(
  run: (checkpoint: () => void) => Promise<unknown>,
  failAt = 2,
): Promise<void> {
  const abort = new Error("ledger-abort");
  const ledger = new MemoryLedger();
  let calls = 0;
  let caught: unknown;
  setAllocationObserver(ledger);
  try {
    await run(() => {
      calls += 1;
      if (calls >= failAt) throw abort;
    });
  } catch (error) {
    caught = error;
  } finally {
    setAllocationObserver(null);
  }
  expect(caught).toBe(abort);
  expect(ledger.currentBytes).toBe(0);
  expect(ledger.liveAllocations).toBe(0);
}

describe("cooperative kernels are bit-identical to the parity originals", () => {
  const raster = noiseRaster(WIDTH, HEIGHT, 7);

  it("coverage base + full chain (heavy glitch + fray)", async () => {
    const settings = baseSettings({ ...HEAVY_GLITCH, frayedXEdge: 4, frayedYEdge: 3 });
    const { state, checkpoint } = countingCheckpoint();
    const sync = buildCoverageField(raster, "magenta", settings);
    const coop = await buildCoverageFieldCoop(raster, "magenta", settings, checkpoint, );
    expect(same(sync, coop)).toBe(true);
    expect(state.calls).toBeGreaterThan(0);
    const base = await buildCoverageBaseCoop(raster, "cyan", settings, checkpoint, 5);
    expect(same(base, buildCoverageField(raster, "cyan", { ...settings, ...{} }))).toBe(false); // base ≠ chained
  });

  it("glitch chain with every op active, chunked at odd row counts", async () => {
    const field = buildCoverageField(raster, "black", baseSettings());
    const settings = baseSettings(HEAVY_GLITCH);
    const sync = buildGlitchField(field, WIDTH, HEIGHT, settings, 3);
    for (const rows of [1, 5, 17, 1000]) {
      const coop = await buildGlitchFieldCoop(field, WIDTH, HEIGHT, settings, 3, undefined, rows);
      expect(same(sync, coop)).toBe(true);
    }
  });

  it("bitmap sort chunked per line", async () => {
    const field = buildCoverageField(raster, "cyan", baseSettings());
    const sync = bitmapSortField(field, WIDTH, HEIGHT, 0.7, true, 99 + 17);
    const coop = await bitmapSortFieldCoop(field, WIDTH, HEIGHT, 0.7, true, 99 + 17, undefined, 3);
    expect(same(sync, coop)).toBe(true);
  });

  it("diffusion preprocess (datamosh + denoise + sharpen) and full field", async () => {
    const settings = baseSettings({ ...HEAVY_GLITCH, ...DIFFUSION });
    const base = buildCoverageField(raster, "yellow", baseSettings());
    const sync = preprocessDiffusionField(base, WIDTH, HEIGHT, settings, 2);
    const coop = await preprocessDiffusionFieldCoop(base, WIDTH, HEIGHT, settings, 2, undefined);
    expect(same(sync, coop)).toBe(true);
    const syncField = buildDiffusionField(raster, "yellow", settings);
    const coopField = await buildDiffusionFieldCoop(raster, "yellow", settings, undefined);
    expect(same(syncField, coopField)).toBe(true);

    // Negative denoise path too.
    const noisy = baseSettings({ ...DIFFUSION, diffusionDenoise: -0.6 });
    expect(
      same(
        buildDiffusionField(raster, "black", noisy),
        await buildDiffusionFieldCoop(raster, "black", noisy, undefined),
      ),
    ).toBe(true);
  });

  it("banded diffusion coop emits the sync bands for every band height", async () => {
    const settings = baseSettings(DIFFUSION);
    const base = buildCoverageField(raster, "black", baseSettings());
    const source = preprocessDiffusionField(base, WIDTH, HEIGHT, settings, 3);
    for (const bandHeight of [1, 5, HEIGHT]) {
      const syncBands: Float32Array[] = [];
      processBandedDiffusion(source, WIDTH, HEIGHT, settings, bandHeight, (_start, _count, rows) =>
        void syncBands.push(rows.slice()),
      );
      const coopBands: Float32Array[] = [];
      await processBandedDiffusionCoop(
        source,
        WIDTH,
        HEIGHT,
        settings,
        bandHeight,
        (_start, _count, rows) => void coopBands.push(rows.slice()),
        undefined,
      );
      expect(coopBands.length).toBe(syncBands.length);
      for (let index = 0; index < syncBands.length; index += 1) {
        expect(same(syncBands[index], coopBands[index])).toBe(true);
      }
    }
  });

  it("grid collection coop yields the identical placement sequence", async () => {
    const field = buildCoverageField(raster, "black", baseSettings());
    const geometry: GridGeometry = {
      width: WIDTH,
      height: HEIGHT,
      sourceWidth: WIDTH,
      sourceHeight: HEIGHT,
      cell: effectiveCellSize(6, 1, 0.01),
      angleDegrees: 45,
    };
    const bounds = visibleContentBounds(raster);
    const sync = collectGridDots(field, geometry, bounds);
    const { state, checkpoint } = countingCheckpoint();
    const coop = await collectGridDotsCoop(field, geometry, bounds, checkpoint, undefined, 8);
    expect(coop).toEqual(sync);
    expect(state.calls).toBeGreaterThan(2);
  });
});

describe("cancellation DURING each phase stops within the latency budget", () => {
  const raster = gradientRaster(WIDTH, HEIGHT);

  /**
   * Slow checkpoint fixture: each checkpoint call burns ~20ms (simulating a
   * loaded worker between chunks) and the abort flag flips DURING the
   * phase. The phase must reject on the very next checkpoint — wall time
   * from the flip to the rejection stays under 250ms even though the whole
   * phase would take far longer.
   */
  async function assertPromptAbort(run: (checkpoint: () => void) => Promise<unknown>): Promise<void> {
    const abort = new Error("cancelled-mid-phase");
    let calls = 0;
    let cancelledAt = 0;
    const checkpoint = () => {
      calls += 1;
      const spin = Date.now() + 20;
      while (Date.now() < spin) {
        // busy wait: instrumented slow fixture
      }
      if (calls === 2) cancelledAt = Date.now();
      if (cancelledAt > 0) throw abort;
    };
    await expect(run(checkpoint)).rejects.toBe(abort);
    expect(cancelledAt).toBeGreaterThan(0);
    expect(Date.now() - cancelledAt).toBeLessThanOrEqual(250);
    expect(calls).toBeGreaterThanOrEqual(2);
  }

  it("during coverage separation", async () => {
    await assertPromptAbort((checkpoint) =>
      buildCoverageBaseCoop(raster, "cyan", baseSettings(), checkpoint, 4),
    );
  });

  it("during the glitch remap", async () => {
    const field = buildCoverageField(raster, "black", baseSettings());
    await assertPromptAbort((checkpoint) =>
      buildGlitchFieldCoop(field, WIDTH, HEIGHT, baseSettings(HEAVY_GLITCH), 1, checkpoint, 4),
    );
  });

  it("during the bitmap sort", async () => {
    const field = buildCoverageField(raster, "black", baseSettings());
    await assertPromptAbort((checkpoint) =>
      bitmapSortFieldCoop(field, WIDTH, HEIGHT, 0.9, false, 99, checkpoint, 2),
    );
  });

  it("during the diffusion preprocess", async () => {
    const base = buildCoverageField(raster, "black", baseSettings());
    await assertPromptAbort((checkpoint) =>
      preprocessDiffusionFieldCoop(
        base,
        WIDTH,
        HEIGHT,
        baseSettings(DIFFUSION),
        3,
        checkpoint,
      ),
    );
  });

  it("during the banded diffusion scan", async () => {
    const settings = baseSettings(DIFFUSION);
    const base = buildCoverageField(raster, "black", baseSettings());
    const source = preprocessDiffusionField(base, WIDTH, HEIGHT, settings, 3);
    await assertPromptAbort((checkpoint) =>
      processBandedDiffusionCoop(source, WIDTH, HEIGHT, settings, 4, () => undefined, checkpoint),
    );
  });

  it("during grid collection", async () => {
    const field = buildCoverageField(raster, "black", baseSettings());
    const geometry: GridGeometry = {
      width: WIDTH,
      height: HEIGHT,
      sourceWidth: WIDTH,
      sourceHeight: HEIGHT,
      cell: effectiveCellSize(6, 1, 0.01),
      angleDegrees: 15,
    };
    await assertPromptAbort((checkpoint) =>
      collectGridDotsCoop(field, geometry, visibleContentBounds(raster), checkpoint, undefined, 4),
    );
  });
});

describe("cooperative cancellation releases every internally owned field", () => {
  const raster = noiseRaster(WIDTH, HEIGHT, 17);

  it("cleans a partial coverage base and a completed glitch chain", async () => {
    await expectAbortReleasesLedger((checkpoint) =>
      buildCoverageBaseCoop(raster, "cyan", baseSettings(), checkpoint, 4),
    );
    await expectAbortReleasesLedger(
      (checkpoint) =>
        buildCoverageFieldCoop(
          raster,
          "magenta",
          baseSettings({ ...HEAVY_GLITCH, frayedXEdge: 4, frayedYEdge: 3 }),
          checkpoint,
        ),
      1,
    );
  });

  it("closes suspended glitch and bitmap-sort generators", async () => {
    const input = new Float32Array(WIDTH * HEIGHT).fill(0.6);
    await expectAbortReleasesLedger((checkpoint) =>
      buildGlitchFieldCoop(input, WIDTH, HEIGHT, baseSettings(HEAVY_GLITCH), 1, checkpoint, 4),
    );
    await expectAbortReleasesLedger((checkpoint) =>
      bitmapSortFieldCoop(input, WIDTH, HEIGHT, 0.9, false, 99, checkpoint, 2),
    );
  });

  it("cleans blur/preprocess scratch and the full diffusion chain", async () => {
    const input = new Float32Array(WIDTH * HEIGHT).fill(0.45);
    await expectAbortReleasesLedger((checkpoint) =>
      preprocessDiffusionFieldCoop(
        input,
        WIDTH,
        HEIGHT,
        baseSettings(DIFFUSION),
        3,
        checkpoint,
      ),
    );
    await expectAbortReleasesLedger((checkpoint) =>
      buildDiffusionFieldCoop(raster, "black", baseSettings(DIFFUSION), checkpoint),
    );
  });
});
