/**
 * TRUE STREAMING plate delivery (wave G2): WorkerRenderService.streamPlates
 * over the REAL MainThreadRenderer streaming session.
 *
 * Proves, at the service level:
 * - band → RGBA delivery is PIXEL-IDENTICAL to the buffered renderPlate
 *   output (same plate-raster convention, gapless coverage);
 * - the band-credit window bounds in-flight (emitted-but-unacked) bands
 *   end to end under a SLOW sink, with writes observed BEFORE the render
 *   completes;
 * - cancellation settles bounded even while the sink is blocked on a
 *   credit-gated write, and while the port swallows the cancel entirely
 *   (local-first cancellation);
 * - hostile band streams (out-of-sequence plates, non-contiguous rows,
 *   wrong byte lengths, duplicate completion, missing tail) reject typed;
 * - admission gates on the STREAMED shape (admit-shape === execute-shape).
 */
import { describe, expect, it } from "vitest";
import type { LayerV1, PlateId, ProjectCoreV1, Sha256 } from "../../src/core/types";
import { MainThreadRenderer } from "../../src/render/main-thread-renderer";
import type {
  RenderExportBandAckRequest,
  RenderWorkerEvent,
  StreamingRenderPort,
} from "../../src/render/protocol";
import { STREAM_DELIVERY_BAND_WINDOW } from "../../src/render/planner";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";
import { createWorkerRenderService } from "../../src/export/worker-render-service";
import type { PlateBandDelivery, RasterData, RenderRequestOptions } from "../../src/export/orchestrator";

const WIDTH = 24;
const HEIGHT = 18;
const ASSET_A: Sha256 = "a".repeat(64);
const ASSET_B: Sha256 = "b".repeat(64);

function makeRaster(width: number, height: number, seed: number): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (index * seed + 13) % 256;
  }
  // Opaque so both layers contribute coverage everywhere they land.
  for (let pixel = 0; pixel < width * height; pixel += 1) data[pixel * 4 + 3] = 255;
  return { data, width, height };
}

const ASSETS = new Map<Sha256, RasterData>([
  [ASSET_A, makeRaster(WIDTH, HEIGHT, 31)],
  [ASSET_B, makeRaster(10, 8, 57)],
]);

function baseRecipe(): LayerV1["recipe"] {
  return {
    mode: "clean",
    halftone: {
      cellSize: 5,
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
      intensity: 0.7,
      levels: 4,
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
  };
}

function makeLayer(id: string, assetId: Sha256, mode: "clean" | "diffusion"): LayerV1 {
  const recipe = baseRecipe();
  recipe.mode = mode;
  return {
    id,
    name: id,
    assetId,
    visible: true,
    locked: false,
    opacity: mode === "clean" ? 0.8 : 1,
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
    recipe,
  };
}

function makeCore(): ProjectCoreV1 {
  return {
    schema: 1,
    artboard: { widthPx: WIDTH, heightPx: HEIGHT, presetId: "custom", background: "white" },
    layers: [makeLayer("layer-1", ASSET_A, "clean"), makeLayer("layer-2", ASSET_B, "diffusion")],
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

function makeService(createPort: () => StreamingRenderPort = () => new MainThreadRenderer(false)) {
  return createWorkerRenderService({
    sources: {
      async resolveRaster(assetId) {
        const raster = ASSETS.get(assetId);
        if (!raster) throw new Error(`missing asset ${assetId}`);
        // CALLER-OWNED bytes per the WorkerRenderSources contract.
        return { data: raster.data.slice(), width: raster.width, height: raster.height };
      },
    },
    createPort,
  });
}

function requestOptions(overrides: Partial<RenderRequestOptions> = {}): RenderRequestOptions {
  return {
    revision: 7,
    registration: false,
    matte: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

type CapturedPlate = { rows: Uint8ClampedArray; rowsWritten: number; ended: boolean };

function collectingDelivery(perBandDelayMs = 0) {
  const plates = new Map<PlateId, CapturedPlate>();
  const order: string[] = [];
  const delivery: PlateBandDelivery = {
    beginPlate(plate) {
      order.push(`begin:${plate}`);
      plates.set(plate, {
        rows: new Uint8ClampedArray(WIDTH * HEIGHT * 4),
        rowsWritten: 0,
        ended: false,
      });
    },
    async writeBand(plate, rowStart, rowCount, rgbaRows) {
      if (perBandDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, perBandDelayMs));
      const captured = plates.get(plate)!;
      captured.rows.set(rgbaRows, rowStart * WIDTH * 4);
      captured.rowsWritten += rowCount;
      order.push(`band:${plate}:${rowStart}+${rowCount}`);
    },
    endPlate(plate) {
      const captured = plates.get(plate)!;
      captured.ended = true;
      order.push(`end:${plate}`);
    },
  };
  return { plates, order, delivery };
}

const PLATES: PlateId[] = ["cyan", "magenta", "yellow", "black"];

describe("streamPlates", () => {
  it("delivers gapless RGBA plate rows PIXEL-IDENTICAL to the buffered renderPlate output", async () => {
    const core = makeCore();
    const service = makeService();
    const { plates, delivery, order } = collectingDelivery();
    await service.streamPlates!(core, PLATES, requestOptions(), delivery);
    for (const plate of PLATES) {
      const captured = plates.get(plate)!;
      expect(captured.ended).toBe(true);
      expect(captured.rowsWritten).toBe(HEIGHT);
      const buffered = await makeService().renderPlate(core, plate, requestOptions());
      expect(Buffer.from(captured.rows).equals(Buffer.from(buffered.data))).toBe(true);
    }
    // Press order, begin → bands → end per plate.
    expect(order[0]).toBe("begin:cyan");
    expect(order[order.length - 1]).toBe("end:black");
  });

  it("bounds in-flight bands to the credit window under a SLOW sink, writing DURING the render", async () => {
    const core = makeCore();
    let inFlight = 0;
    let maxInFlight = 0;
    let renderResolved = false;
    let bandsBeforeRenderEnd = 0;
    const port = new MainThreadRenderer(false);
    const wrapped: StreamingRenderPort = {
      submit: (job) => port.submit(job),
      cancel: (revision) => port.cancel(revision),
      dispose: () => port.dispose(),
      beginExport: (request) => port.beginExport(request),
      submitLayer: (request) => port.submitLayer(request),
      finalizeExport: (request) => port.finalizeExport(request),
      ackBand: (request: RenderExportBandAckRequest) => {
        inFlight -= 1;
        port.ackBand(request);
      },
      onEvent: (listener) =>
        port.onEvent((event: RenderWorkerEvent) => {
          if (event.type === "plate-band") {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (!renderResolved) bandsBeforeRenderEnd += 1;
          }
          listener(event);
        }),
    };
    const service = makeService(() => wrapped);
    const { plates, delivery } = collectingDelivery(4);
    const run = service.streamPlates!(core, PLATES, requestOptions(), delivery).then(() => {
      renderResolved = true;
    });
    await run;
    // End-to-end backpressure: never more than the window outstanding.
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(STREAM_DELIVERY_BAND_WINDOW);
    // Sink writes happened BEFORE the render completed, not after.
    expect(bandsBeforeRenderEnd).toBeGreaterThan(0);
    expect(plates.get("black")!.ended).toBe(true);
  });

  it("cancel settles bounded while the sink is BLOCKED on a credit-gated write", async () => {
    const core = makeCore();
    const service = makeService();
    const controller = new AbortController();
    let firstBand: (() => void) | null = null;
    const delivery: PlateBandDelivery = {
      beginPlate() {},
      writeBand: () =>
        new Promise<void>((resolve) => {
          // Never resolves until the test releases it — the worker's band
          // credits exhaust and the session blocks on the credit wait.
          firstBand = resolve;
        }),
      endPlate() {},
    };
    const run = service.streamPlates!(
      core,
      PLATES,
      requestOptions({ signal: controller.signal }),
      delivery,
    );
    run.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(firstBand).not.toBeNull();
    const cancelledAt = Date.now();
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: "export-cancelled" });
    // Caller-observed settlement comfortably inside the ≤250ms contract.
    expect(Date.now() - cancelledAt).toBeLessThan(200);
    firstBand!();
  });

  it("keeps a blocked consumer's transferred band charged until the consumer actually settles", async () => {
    const core = makeCore();
    const service = makeService();
    const controller = new AbortController();
    const ledger = new MemoryLedger();
    let liveReceiptBytes = 0;
    let releaseBand: (() => void) | null = null;
    let retainedReceiptBytes = 0;
    let receivedSignal: AbortSignal | undefined;
    const delivery: PlateBandDelivery = {
      beginPlate() {},
      writeBand(_plate, _rowStart, rowCount, _rows, signal) {
        retainedReceiptBytes = WIDTH * rowCount * 8; // ink + alpha Float32 transfers
        receivedSignal = signal;
        return new Promise<void>((resolve) => {
          releaseBand = resolve;
        });
      },
      endPlate() {},
    };
    setAllocationObserver({
      alloc(bytes, kind, label) {
        ledger.alloc(bytes, kind);
        if (label === "stream-band-receipt") liveReceiptBytes += bytes;
      },
      release(bytes, kind, label) {
        ledger.release(bytes, kind);
        if (label === "stream-band-receipt") liveReceiptBytes -= bytes;
      },
    });
    try {
      const run = service.streamPlates!(
        core,
        PLATES,
        requestOptions({ signal: controller.signal }),
        delivery,
      );
      run.catch(() => undefined);
      for (let attempt = 0; attempt < 50 && !releaseBand; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(releaseBand).not.toBeNull();
      controller.abort();
      await expect(run).rejects.toMatchObject({ code: "export-cancelled" });
      await Promise.resolve();
      expect(receivedSignal?.aborted).toBe(true);
      // The run is gone, but the hostile consumer still retains the event.
      // Releasing this charge early would make the ledger's cancellation
      // story false even though caller-observed settlement is bounded.
      expect(liveReceiptBytes).toBe(retainedReceiptBytes);
      releaseBand!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(liveReceiptBytes).toBe(0);
    } finally {
      setAllocationObserver(null);
      (releaseBand as (() => void) | null)?.();
    }
  });

  it("cancel settles bounded even when the port SWALLOWS the cancel (local-first)", async () => {
    const core = makeCore();
    const inner = new MainThreadRenderer(false);
    const hostile: StreamingRenderPort = {
      submit: (job) => inner.submit(job),
      cancel: () => {
        /* swallowed: the worker never acknowledges */
      },
      dispose: () => inner.dispose(),
      beginExport: (request) => inner.beginExport(request),
      submitLayer: (request) => inner.submitLayer(request),
      finalizeExport: (request) => inner.finalizeExport(request),
      ackBand: (request) => inner.ackBand(request),
      onEvent: (listener) => inner.onEvent(listener),
    };
    const service = makeService(() => hostile);
    const controller = new AbortController();
    const delivery: PlateBandDelivery = {
      beginPlate() {},
      writeBand: () => new Promise<void>(() => undefined), // stuck sink
      endPlate() {},
    };
    const run = service.streamPlates!(
      core,
      PLATES,
      requestOptions({ signal: controller.signal }),
      delivery,
    );
    run.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const cancelledAt = Date.now();
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: "export-cancelled" });
    expect(Date.now() - cancelledAt).toBeLessThan(200);
  });

  it("rejects hostile band streams typed and fails closed", async () => {
    const core = makeCore();
    const scenarios: Array<{
      name: string;
      events: (revision: number) => RenderWorkerEvent[];
      message: RegExp;
    }> = [
      {
        name: "out-of-sequence plate",
        events: (revision) => [
          { type: "export-ready", revision },
          band(revision, "magenta", 0, HEIGHT),
        ],
        message: /out of sequence/,
      },
      {
        name: "non-contiguous rows",
        events: (revision) => [
          { type: "export-ready", revision },
          band(revision, "cyan", 2, 4),
        ],
        message: /not contiguous/,
      },
      {
        name: "wrong byte length",
        events: (revision) => [
          { type: "export-ready", revision },
          {
            type: "plate-band",
            revision,
            plate: "cyan",
            rowStart: 0,
            rowCount: 4,
            inkPremultiplied: { buffer: new ArrayBuffer(WIDTH * 4 * 4 + 64), width: WIDTH, height: 4 },
            alpha: { buffer: new ArrayBuffer(WIDTH * 4 * 4), width: WIDTH, height: 4 },
          },
        ],
        message: /byte lengths/,
      },
      {
        name: "duplicate completion",
        events: (revision) => [
          { type: "export-ready", revision },
          band(revision, "cyan", 0, HEIGHT),
          { type: "plate-complete", revision, plate: "cyan" },
          { type: "plate-complete", revision, plate: "cyan" },
        ],
        message: /out of sequence or twice/,
      },
      {
        name: "missing tail band",
        events: (revision) => [
          { type: "export-ready", revision },
          band(revision, "cyan", 0, HEIGHT - 4),
          { type: "plate-complete", revision, plate: "cyan" },
        ],
        message: /completed after/,
      },
    ];
    function band(revision: number, plate: PlateId, rowStart: number, rowCount: number): RenderWorkerEvent {
      return {
        type: "plate-band",
        revision,
        plate,
        rowStart,
        rowCount,
        inkPremultiplied: { buffer: new ArrayBuffer(WIDTH * rowCount * 4), width: WIDTH, height: rowCount },
        alpha: { buffer: new ArrayBuffer(WIDTH * rowCount * 4), width: WIDTH, height: rowCount },
      };
    }
    for (const scenario of scenarios) {
      const listeners = new Set<(event: RenderWorkerEvent) => void>();
      const hostilePort: StreamingRenderPort = {
        submit() {},
        cancel() {},
        dispose() {},
        beginExport(request) {
          queueMicrotask(() => {
            for (const event of scenario.events(request.revision)) {
              for (const listener of [...listeners]) listener(event);
            }
          });
        },
        submitLayer(request) {
          queueMicrotask(() => {
            for (const listener of [...listeners]) {
              listener({
                type: "layer-ack",
                revision: request.revision,
                plate: request.plate,
                layerIndex: request.layerIndex,
              });
            }
          });
        },
        finalizeExport() {},
        ackBand() {},
        onEvent(listener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      };
      const service = makeService(() => hostilePort);
      const { delivery } = collectingDelivery();
      await expect(
        service.streamPlates!(core, PLATES, requestOptions(), delivery),
        scenario.name,
      ).rejects.toMatchObject({ code: "stream-protocol-violation" });
    }
  });

  it("gates admission on the STREAMED shape and refuses registration misrouting", async () => {
    const core = makeCore();
    // A budget below the streamed estimate rejects BEFORE any decode.
    const tiny = createWorkerRenderService({
      sources: {
        resolveRaster: () => {
          throw new Error("must not decode after a hard block");
        },
      },
      createPort: () => new MainThreadRenderer(false),
      renderBudgetBytes: 1024,
    });
    const { delivery } = collectingDelivery();
    await expect(tiny.streamPlates!(core, PLATES, requestOptions(), delivery)).rejects.toMatchObject({
      code: "render-peak-exceeded",
    });
    // streamPlates renders WITHOUT registration by contract.
    await expect(
      makeService().streamPlates!(core, PLATES, requestOptions({ registration: true }), delivery),
    ).rejects.toMatchObject({ code: "stream-registration-misrouted" });
  });
});
