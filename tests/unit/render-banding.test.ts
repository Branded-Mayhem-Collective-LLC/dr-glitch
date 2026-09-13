/**
 * Band-streaming diffusion must be bit-identical to the whole-image scan for
 * every band height: banding bounds memory, never reorders the sequential
 * error propagation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildDiffusionField as originalBuildDiffusionField, type HalftoneSettings } from "../../src/studio/halftone";
import {
  buildCoverageBase,
} from "../../src/render/kernels/coverage";
import {
  diffuseField,
  preprocessDiffusionField,
  processBandedDiffusion,
  processBandedDiffusionCoop,
} from "../../src/render/kernels/diffusion";
import { gradientRaster, hardEdgeRaster, noiseRaster } from "../../src/render/fixtures";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";

afterEach(() => setAllocationObserver(null));

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
    diffusionEnabled: true,
    diffusionAlgorithm: "floyd-steinberg",
    diffusionIntensity: 0.8,
    diffusionLevels: 4,
    ...overrides,
  };
}

function assembleBanded(
  source: Float32Array,
  width: number,
  height: number,
  config: HalftoneSettings,
  bandHeight: number,
): { field: Float32Array; bands: Array<{ rowStart: number; rowCount: number }> } {
  const field = new Float32Array(width * height);
  const bands: Array<{ rowStart: number; rowCount: number }> = [];
  processBandedDiffusion(source, width, height, config, bandHeight, (rowStart, rowCount, rows) => {
    bands.push({ rowStart, rowCount });
    expect(rows.length).toBe(rowCount * width);
    field.set(rows, rowStart * width);
  });
  return { field, bands };
}

describe("processBandedDiffusion", () => {
  const fixtures = [gradientRaster(24, 17), hardEdgeRaster(16, 16), noiseRaster(21, 13, 3)];
  const bandHeights = [1, 2, 3, 5, 7, 16, 17, 64];
  const algorithms = ["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"] as const;

  it("is bit-identical to the whole-image scan for every band height and algorithm", () => {
    for (const raster of fixtures) {
      for (const algorithm of algorithms) {
        const config = settings({ diffusionAlgorithm: algorithm });
        const base = buildCoverageBase(raster, "black", config);
        const source = preprocessDiffusionField(base, raster.width, raster.height, config, 3);
        const whole = diffuseField(source, raster.width, raster.height, config);
        for (const bandHeight of bandHeights) {
          const { field } = assembleBanded(source, raster.width, raster.height, config, bandHeight);
          expect(new Uint32Array(field.buffer), `${algorithm} band ${bandHeight} ${raster.width}x${raster.height}`)
            .toEqual(new Uint32Array(whole.buffer));
        }
      }
    }
  });

  it("carries error across band boundaries under modulation, bias, and reset", () => {
    const raster = gradientRaster(19, 23);
    const config = settings({
      diffusionAlgorithm: "stucki",
      diffusionModulation: "heavy",
      diffusionModStrength: 0.8,
      directionalBias: 0.6,
      directionalBiasAngle: 20,
      brokenKernel: 0.4,
      errorOverflow: 0.5,
      diffusionReset: 0.6,
      crossChannelBleed: 0.3,
    });
    const base = buildCoverageBase(raster, "black", config);
    const source = preprocessDiffusionField(base, raster.width, raster.height, config, 3);
    const whole = diffuseField(source, raster.width, raster.height, config);
    for (const bandHeight of [1, 4, 9]) {
      const { field } = assembleBanded(source, raster.width, raster.height, config, bandHeight);
      expect(new Uint32Array(field.buffer)).toEqual(new Uint32Array(whole.buffer));
    }
  });

  it("emits contiguous non-overlapping bands covering every row exactly once", () => {
    const raster = hardEdgeRaster(12, 11);
    const config = settings();
    const base = buildCoverageBase(raster, "black", config);
    const source = preprocessDiffusionField(base, raster.width, raster.height, config, 3);
    const { bands } = assembleBanded(source, raster.width, raster.height, config, 4);
    expect(bands.map((band) => band.rowStart)).toEqual([0, 4, 8]);
    expect(bands.map((band) => band.rowCount)).toEqual([4, 4, 3]);
  });

  it("agrees with the engine oracle end-to-end (coverage → preprocess → banded scan)", () => {
    const raster = gradientRaster(16, 16);
    const config = settings({ diffusionAlgorithm: "atkinson", diffusionDenoise: -0.5, diffusionSharpenStrength: 0.4 });
    const expected = originalBuildDiffusionField(
      { data: raster.data, width: raster.width, height: raster.height, colorSpace: "srgb" } as ImageData,
      "black",
      config,
    );
    const base = buildCoverageBase(raster, "black", config);
    const source = preprocessDiffusionField(base, raster.width, raster.height, config, 3);
    const { field } = assembleBanded(source, raster.width, raster.height, config, 5);
    expect(new Uint32Array(field.buffer)).toEqual(new Uint32Array(expected.buffer));
  });

  it("releases the working window and emitted rows when a sync consumer throws", () => {
    const width = 12;
    const height = 11;
    const source = new Float32Array(width * height).fill(0.5);
    const ledger = new MemoryLedger();
    const abort = new Error("band-consumer-abort");
    setAllocationObserver(ledger);

    expect(() =>
      processBandedDiffusion(source, width, height, settings(), 4, () => {
        throw abort;
      }),
    ).toThrow(abort);

    expect(ledger.currentBytes).toBe(0);
    expect(ledger.liveAllocations).toBe(0);
  });

  it("retains emitted rows until an async consumer settles, then releases every band allocation", async () => {
    const width = 12;
    const height = 11;
    const bandHeight = 4;
    const source = new Float32Array(width * height).fill(0.5);
    const ledger = new MemoryLedger();
    const abort = new Error("async-band-consumer-abort");
    let enterConsumer!: () => void;
    let rejectConsumer!: (error: Error) => void;
    const enteredConsumer = new Promise<void>((resolve) => {
      enterConsumer = resolve;
    });
    const consumerGate = new Promise<void>((_resolve, reject) => {
      rejectConsumer = reject;
    });
    setAllocationObserver(ledger);

    const processing = processBandedDiffusionCoop(
      source,
      width,
      height,
      settings(),
      bandHeight,
      async () => {
        enterConsumer();
        await consumerGate;
      },
      undefined,
    );
    await enteredConsumer;

    // The band callback borrows both the (band + carry) working window and
    // this band's emitted row copy until its promise settles.
    expect(ledger.currentBytes).toBe(((bandHeight + 2) + bandHeight) * width * 4);
    expect(ledger.liveAllocations).toBe(2);

    rejectConsumer(abort);
    await expect(processing).rejects.toBe(abort);
    expect(ledger.currentBytes).toBe(0);
    expect(ledger.liveAllocations).toBe(0);
  });
});
