/**
 * Studio export flow, TRUE STREAMING delivery (wave G2): delivery
 * planning, the GESTURE-SCOPED picker (opened synchronously at Export Now,
 * BEFORE any render work), the cancel matrix across picker → writable →
 * stream → close, pre-picker typed refusals (no user activation is ever
 * spent on a refusal), the byte-identical buffered path for small exports,
 * and the export suspension registry (edge-triggered, born-suspended,
 * ownership on early throws).
 */
import { describe, expect, it, vi } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { ProjectCoreV1 } from "../../src/core/types";
import {
  ExportCancelledError,
  type PlateBandDelivery,
  type RenderService,
} from "../../src/export/orchestrator";
import { plateInkRowsToRgba } from "../../src/export/output-transforms";
import {
  planExportDelivery,
  registerExportSuspendable,
  startStudioExport,
  type SaveFileHandle,
  type SaveFilePicker,
  type StartStudioExportOptions,
} from "../../src/app/export-flow";
import { createExportSessionStore } from "../../src/export/export-session";
import { MAX_BUFFERED_PLATE_PACKAGE_BYTES } from "../../src/export/targets";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";

const WIDTH = 16;
const HEIGHT = 12;

function makeCore(): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: WIDTH, heightPx: HEIGHT, presetId: "custom", background: "white" },
    layers: [
      {
        id: "layer-1",
        name: "Artwork",
        assetId: "a".repeat(64),
        visible: true,
        locked: false,
        opacity: 1,
        crop: null,
        transform: {
          position: { x: WIDTH / 2, y: HEIGHT / 2 },
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
            cellSize: 6,
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
      registrationOnPlates: false,
      registrationOnComposite: false,
    },
    unitPreference: "px",
  };
}

/** Order-recording renderer with a REAL band contract. */
function makeRenderService(order: string[]): RenderService {
  return {
    renderComposite: async () => {
      order.push("render");
      return { data: new Uint8ClampedArray(WIDTH * HEIGHT * 4), width: WIDTH, height: HEIGHT };
    },
    renderPlate: async () => {
      order.push("render");
      return { data: new Uint8ClampedArray(WIDTH * HEIGHT * 4), width: WIDTH, height: HEIGHT };
    },
    renderPlateSvg: async () => "<svg/>",
    renderLayer: async () => ({
      data: new Uint8ClampedArray(WIDTH * HEIGHT * 4),
      width: WIDTH,
      height: HEIGHT,
    }),
    async streamPlates(_core, plates, _options, delivery: PlateBandDelivery) {
      order.push("render");
      for (const plate of plates) {
        await delivery.beginPlate(plate);
        const ink = new Float32Array(HEIGHT * WIDTH).fill(0.5);
        await delivery.writeBand(plate, 0, HEIGHT, plateInkRowsToRgba(ink, ink.length));
        await delivery.endPlate(plate);
      }
    },
  };
}

const BLOB_ENCODERS = {
  encodePng: async () => new Blob(["png"], { type: "image/png" }),
  encodeJpeg: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
  encodeTiff: async () => new Blob(["tiff"], { type: "image/tiff" }),
  zip: async () => new Blob(["zip"], { type: "application/zip" }),
};

function makeHandle(order: string[]) {
  const written: Uint8Array[] = [];
  let closed = 0;
  let abortedCount = 0;
  const handle: SaveFileHandle = {
    createWritable: async () => {
      order.push("writable");
      return {
        write: async (chunk: Uint8Array | Blob) => {
          order.push("write");
          if (chunk instanceof Uint8Array) written.push(chunk);
        },
        close: async () => {
          closed += 1;
          order.push("close");
        },
        abort: async () => {
          abortedCount += 1;
          order.push("abort");
        },
      };
    },
  };
  return { handle, written, closed: () => closed, aborted: () => abortedCount };
}

function baseOptions(
  order: string[],
  picker: SaveFilePicker | null,
  overrides: Partial<StartStudioExportOptions> = {},
): StartStudioExportOptions {
  return {
    core: makeCore(),
    revision: 1,
    sourceName: "artwork.png",
    target: { kind: "plate-package", format: "png" },
    render: makeRenderService(order),
    encoders: BLOB_ENCODERS,
    deliver: async () => order.push("deliver"),
    maxBlobBytes: 8, // force streaming for the plate package
    saveFilePicker: picker,
    ...overrides,
  };
}

describe("planExportDelivery", () => {
  it("routes on the conservative estimate: cap-exact buffers, cap-plus-one streams (decided PRE-render)", () => {
    const core = makeCore();
    const plan = planExportDelivery(core, { kind: "plate-package", format: "png" });
    expect(plan.mode).toBe("buffered"); // tiny fixture under the real cap
    const exact = planExportDelivery(core, { kind: "plate-package", format: "png" }, {
      maxBlobBytes: plan.estimatedBytes,
    });
    expect(exact.mode).toBe("buffered");
    const plusOne = planExportDelivery(core, { kind: "plate-package", format: "png" }, {
      maxBlobBytes: plan.estimatedBytes - 1,
    });
    expect(plusOne.mode).toBe("stream");
  });

  it("routes a plate package above 32 MiB to streaming even below the generic Blob cap", () => {
    const core = makeCore();
    core.artboard = { ...core.artboard, widthPx: 1500, heightPx: 1500 };
    const plan = planExportDelivery(core, { kind: "plate-package", format: "png" }, {
      maxBlobBytes: RESOURCE_POLICY.maxBlobDownloadBytes,
    });
    expect(plan.estimatedBytes).toBeGreaterThan(MAX_BUFFERED_PLATE_PACKAGE_BYTES);
    expect(plan.estimatedBytes).toBeLessThan(RESOURCE_POLICY.maxBlobDownloadBytes);
    expect(plan.mode).toBe("stream");
  });
});

describe("startStudioExport — streamed path", () => {
  it("refuses an over-32 MiB package without FSA before render or delivery", async () => {
    const order: string[] = [];
    const core = makeCore();
    core.artboard = { ...core.artboard, widthPx: 1500, heightPx: 1500 };
    const run = startStudioExport(
      baseOptions(order, null, {
        core,
        maxBlobBytes: RESOURCE_POLICY.maxBlobDownloadBytes,
      }),
    );
    await expect(run.done).rejects.toMatchObject({ code: "delivery-exceeded" });
    expect(order).toEqual([]);
  });

  it("opens the picker SYNCHRONOUSLY in the gesture, before ANY render work, and streams to the writable", async () => {
    const order: string[] = [];
    const { handle, closed, aborted } = makeHandle(order);
    let pickerCalledSynchronously = false;
    const picker: SaveFilePicker = (pickerOptions) => {
      order.push("picker");
      pickerCalledSynchronously = true;
      expect(pickerOptions?.suggestedName).toBe("artwork-CMYK-plates.zip");
      return Promise.resolve(handle);
    };
    const run = startStudioExport(baseOptions(order, picker));
    // The picker was invoked before startStudioExport returned — inside
    // the click task, with transient activation live.
    expect(pickerCalledSynchronously).toBe(true);
    const files = await run.done;
    expect(files).toEqual([{ name: "artwork-CMYK-plates.zip", blob: null }]);
    expect(order[0]).toBe("picker");
    expect(order.indexOf("writable")).toBeLessThan(order.indexOf("render"));
    // Sink writes happened DURING the job, before close; never aborted.
    expect(order.indexOf("write")).toBeLessThan(order.indexOf("close"));
    expect(closed()).toBe(1);
    expect(aborted()).toBe(0);
  });

  it("a DISMISSED picker is a clean cancellation: no render, no writable, no suspension disturbance", async () => {
    const order: string[] = [];
    const suspendable = { suspendForExport: vi.fn(), resumeAfterExport: vi.fn() };
    const unregister = registerExportSuspendable(suspendable);
    try {
      const picker: SaveFilePicker = () =>
        Promise.reject(new DOMException("dismissed", "AbortError"));
      const run = startStudioExport(baseOptions(order, picker));
      await expect(run.done).rejects.toBeInstanceOf(ExportCancelledError);
      expect(order).toEqual([]); // nothing rendered, nothing written
      expect(suspendable.suspendForExport).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("no-FSA + missing custom painter refusals are typed and PRE-PICKER (no activation spent)", async () => {
    const order: string[] = [];
    const noFsa = startStudioExport(baseOptions(order, null));
    await expect(noFsa.done).rejects.toMatchObject({ code: "delivery-exceeded" });
    expect(order).toEqual([]);

    const picker = vi.fn();
    const withMarks = makeCore();
    withMarks.registration.customShapeAssetId = "f".repeat(64);
    withMarks.output.registrationOnPlates = true;
    const refused = startStudioExport(
      baseOptions(order, picker as unknown as SaveFilePicker, { core: withMarks }),
    );
    await expect(refused.done).rejects.toMatchObject({ code: "registration-shape-unsupported" });
    expect(picker).not.toHaveBeenCalled();

    const jpeg = startStudioExport(
      baseOptions(order, picker as unknown as SaveFilePicker, {
        target: { kind: "composite", format: "jpeg" },
        maxBlobBytes: 1,
      }),
    );
    await expect(jpeg.done).rejects.toMatchObject({ code: "delivery-exceeded" });
    expect(picker).not.toHaveBeenCalled();
  });

  it("cancel during a PENDING picker/createWritable settles bounded; a LATE writable is aborted once", async () => {
    // Pending picker.
    const order: string[] = [];
    const neverPicker: SaveFilePicker = () => new Promise<never>(() => undefined);
    const run = startStudioExport(baseOptions(order, neverPicker));
    run.done.catch(() => undefined);
    const cancelledAt = Date.now();
    run.cancel();
    await expect(run.done).rejects.toBeInstanceOf(ExportCancelledError);
    expect(Date.now() - cancelledAt).toBeLessThan(200);

    // Pending createWritable, resolving LATE after cancel.
    let lateAborts = 0;
    let releaseWritable: (() => void) | null = null;
    const handle: SaveFileHandle = {
      createWritable: () =>
        new Promise((resolve) => {
          releaseWritable = () =>
            resolve({
              write: async () => undefined,
              close: async () => undefined,
              abort: async () => {
                lateAborts += 1;
              },
            });
        }),
    };
    const run2 = startStudioExport(baseOptions(order, () => Promise.resolve(handle)));
    run2.done.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    run2.cancel();
    await expect(run2.done).rejects.toBeInstanceOf(ExportCancelledError);
    releaseWritable!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateAborts).toBe(1); // exactly once, contained
  });

  it("settles cancellation promptly but retains a native write receipt until that write settles", async () => {
    const order: string[] = [];
    let writeEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      writeEntered = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let aborts = 0;
    const handle: SaveFileHandle = {
      createWritable: async () => ({
        async write() {
          writeEntered();
          await writeGate;
        },
        close: async () => undefined,
        abort: async () => {
          aborts += 1;
        },
      }),
    };
    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    try {
      const run = startStudioExport(baseOptions(order, () => Promise.resolve(handle)));
      await entered;
      const cancelledAt = Date.now();
      run.cancel();
      await expect(run.done).rejects.toBeInstanceOf(ExportCancelledError);
      expect(Date.now() - cancelledAt).toBeLessThan(200);
      expect(aborts).toBe(1);

      // The job/UI has settled, but the hostile native write still owns its
      // chunk. Cancellation must not erase that receipt optimistically.
      expect(ledger.currentBytes).toBeGreaterThan(0);
      expect(ledger.liveAllocations).toBeGreaterThan(0);

      releaseWrite();
      const deadline = Date.now() + 1_000;
      while (ledger.liveAllocations !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(ledger.currentBytes).toBe(0);
      expect(ledger.liveAllocations).toBe(0);
    } finally {
      releaseWrite();
      setAllocationObserver(null);
    }
  });

  it("a SYNCHRONOUSLY throwing picker is contained typed and the session store rolls back to idle", async () => {
    const order: string[] = [];
    const throwingPicker: SaveFilePicker = () => {
      throw new DOMException("no activation", "SecurityError");
    };
    const store = createExportSessionStore();
    const handle = store.start({ kind: "plate-package", format: "png" }, () => {
      const run = startStudioExport(baseOptions(order, throwingPicker));
      return {
        cancel: run.cancel,
        done: run.done.then(
          () => "done" as const,
          () => "error" as const,
        ),
      };
    });
    expect(handle).not.toBeNull();
    await handle!.done;
    expect(store.getState().run).toBeNull(); // back to idle
    // The next export is startable.
    const again = store.start({ kind: "plate-package", format: "png" }, () => ({
      cancel: () => undefined,
      done: Promise.resolve("done" as const),
    }));
    expect(again).not.toBeNull();
    await again!.done;
  });

  it("a stale run handle's cancel is a token-guarded no-op on a newer run", async () => {
    const store = createExportSessionStore();
    const cancels: string[] = [];
    const first = store.start({ kind: "plate-package", format: "png" }, () => ({
      cancel: () => cancels.push("A"),
      done: Promise.resolve("done" as const),
    }));
    await first!.done;
    const second = store.start({ kind: "plate-package", format: "png" }, () => ({
      cancel: () => cancels.push("B"),
      done: new Promise(() => undefined),
    }));
    expect(second).not.toBeNull();
    first!.cancel(); // stale: must not touch run B
    expect(cancels).toEqual([]);
    store.cancel(); // live-UI intent reaches B
    expect(cancels).toEqual(["B"]);
  });
});

describe("startStudioExport — buffered path and suspension registry", () => {
  it("small exports keep the buffered Blob path byte-identical and never call the picker", async () => {
    const order: string[] = [];
    const picker = vi.fn();
    const delivered: { name: string; blob: Blob }[] = [];
    const run = startStudioExport({
      ...baseOptions(order, picker as unknown as SaveFilePicker),
      maxBlobBytes: 1024 * 1024,
      deliver: async (files) => {
        delivered.push(...files);
      },
    });
    const files = await run.done;
    expect(picker).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(files[0].blob).toBe(delivered[0].blob); // the SAME Blob object
    expect(await delivered[0].blob.text()).toBe("zip"); // untouched encoder bytes
  });

  it("suspends registered caches for the export and resumes after (buffered AND streamed); born-suspended registrants join", async () => {
    const events: string[] = [];
    const suspendable = (label: string) => ({
      suspendForExport: () => events.push(`suspend:${label}`),
      resumeAfterExport: () => events.push(`resume:${label}`),
    });
    const unregisterA = registerExportSuspendable(suspendable("A"));
    const lateRegistration: { unregister: (() => void) | null } = { unregister: null };
    try {
      const order: string[] = [];
      const run = startStudioExport({
        ...baseOptions(order, null),
        maxBlobBytes: 1024 * 1024, // buffered
        deliver: async () => {
          // Mid-export registration: born suspended.
          lateRegistration.unregister = registerExportSuspendable(suspendable("B"));
        },
      });
      await run.done;
      expect(events).toEqual(["suspend:A", "suspend:B", "resume:A", "resume:B"]);
    } finally {
      unregisterA();
      lateRegistration.unregister?.();
    }
  });

  it("suspension ownership survives an early SYNCHRONOUS startExport throw (unclonable core)", () => {
    const events: string[] = [];
    const unregister = registerExportSuspendable({
      suspendForExport: () => events.push("suspend"),
      resumeAfterExport: () => events.push("resume"),
    });
    try {
      const order: string[] = [];
      const core = makeCore();
      // structuredClone rejects functions — a synchronous startExport throw.
      (core as unknown as Record<string, unknown>).poison = () => undefined;
      expect(() =>
        startStudioExport({
          ...baseOptions(order, null),
          core,
          maxBlobBytes: 1024 * 1024,
        }),
      ).toThrow();
      // The suspension resumed SYNCHRONOUSLY — previews never wedge.
      expect(events).toEqual(["suspend", "resume"]);
    } finally {
      unregister();
    }
  });

  it("overlapping suspensions are edge-triggered: resume fires only at the final 1→0 edge", async () => {
    const events: string[] = [];
    const unregister = registerExportSuspendable({
      suspendForExport: () => events.push("suspend"),
      resumeAfterExport: () => events.push("resume"),
    });
    try {
      const order: string[] = [];
      const firstGate: { release: () => void } = { release: () => undefined };
      const slowDeliver = () =>
        new Promise<void>((resolve) => {
          firstGate.release = resolve;
        });
      const first = startStudioExport({
        ...baseOptions(order, null),
        maxBlobBytes: 1024 * 1024,
        deliver: slowDeliver,
      });
      first.done.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = startStudioExport({
        ...baseOptions(order, null),
        maxBlobBytes: 1024 * 1024,
        deliver: async () => undefined,
      });
      await second.done;
      // Second export ended while the first is still live: NOT resumed yet.
      expect(events).toEqual(["suspend"]);
      firstGate.release();
      await first.done;
      expect(events).toEqual(["suspend", "resume"]);
    } finally {
      unregister();
    }
  });
});


it("forwards the custom band painter through the gesture-scoped export flow", async () => {
  const order: string[] = [];
  const { handle, closed, aborted } = makeHandle(order);
  const core = makeCore();
  core.registration.customShapeAssetId = "f".repeat(64);
  core.output.registrationOnPlates = true;
  const paintRows = vi.fn(async () => undefined), dispose = vi.fn();
  const prepareCustomRegistration = vi.fn(async () => ({ paintRows, dispose }));
  const run = startStudioExport(baseOptions(order, async () => handle, { core, prepareCustomRegistration }));
  await run.done;
  expect(prepareCustomRegistration).toHaveBeenCalledTimes(1);
  expect(paintRows).toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(closed()).toBe(1);
  expect(aborted()).toBe(0);
});
