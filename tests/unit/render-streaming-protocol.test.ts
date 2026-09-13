/**
 * Streaming-session protocol conformance through the worker-harness message
 * handlers, invoked directly (no real Worker in Node): begin/submit/finalize
 * round-trips with transferable manifests, ack-before-next ordering,
 * out-of-order rejection, revision hygiene, cancellation semantics, preview
 * refusal, and single-shot jobs deferring behind an open session.
 *
 * Layers here are diffusion-mode only so the whole pipeline runs without
 * OffscreenCanvas — the reduced-environment guarantee for streamed exports.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startWorkerHarness, type HarnessMode } from "../../src/render/worker-harness";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";
import {
  exportLayerTransferables,
  payloadTransferables,
  type RenderExportBeginRequest,
  type RenderExportLayerRequest,
  type RenderLayerInput,
  type RenderWorkerEvent,
  type RenderWorkerRequest,
} from "../../src/render/protocol";
import type { RenderPlateId } from "../../src/render/settings";
import { gradientRaster, hardEdgeRaster } from "../../src/render/fixtures";
import type { HalftoneSettings } from "../../src/studio/halftone";

const WIDTH = 16;
const HEIGHT = 12;
const PLATES: RenderPlateId[] = ["cyan", "black"];
const REVISION = 41;

afterEach(() => setAllocationObserver(null));

type Sent = { message: RenderWorkerEvent; transfer?: Transferable[] };

function makeHarness(mode: HarnessMode = "export") {
  const sent: Sent[] = [];
  const scope = {
    postMessage: (message: RenderWorkerEvent, transfer?: Transferable[]) => {
      sent.push({ message, transfer });
    },
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  startWorkerHarness(scope, mode);
  const post = (data: RenderWorkerRequest) => {
    scope.onmessage?.({ data } as MessageEvent);
  };
  return { sent, post };
}

function diffusionSettings(overrides: Partial<HalftoneSettings> = {}): HalftoneSettings {
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
    diffusionLevels: 3,
    ...overrides,
  };
}

function makeLayer(seedOffset = 0, opacity = 1): RenderLayerInput {
  const raster = seedOffset % 2 === 0 ? gradientRaster(WIDTH, HEIGHT) : hardEdgeRaster(WIDTH, HEIGHT);
  return {
    raster: { buffer: raster.data.buffer.slice(0) as ArrayBuffer, width: raster.width, height: raster.height },
    settings: diffusionSettings(),
    opacity,
    dotShape: "round",
    strokeWidth: 1,
  };
}

function beginRequest(overrides: Partial<RenderExportBeginRequest> = {}): RenderExportBeginRequest {
  return {
    type: "begin-export",
    revision: REVISION,
    outputWidth: WIDTH,
    outputHeight: HEIGHT,
    renderScale: 1,
    minimumCellSize: 0.01,
    plates: PLATES,
    layerCount: 2,
    bandHeight: 3,
    paper: [238, 234, 224],
    ...overrides,
  };
}

function layerRequest(plate: RenderPlateId, layerIndex: number): RenderExportLayerRequest {
  return { type: "submit-layer", revision: REVISION, plate, layerIndex, layer: makeLayer(layerIndex, layerIndex === 0 ? 1 : 0.6) };
}

async function waitFor<T>(sent: Sent[], predicate: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = predicate();
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; saw ${sent.map((entry) => entry.message.type).join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function eventIndex(sent: Sent[], predicate: (event: RenderWorkerEvent) => boolean): number {
  return sent.findIndex((entry) => predicate(entry.message));
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("streaming session protocol through the export harness", () => {
  it("round-trips begin → per-plate layer streams → banded plates → proof → result", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest());
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");

    for (const plate of PLATES) {
      for (let layerIndex = 0; layerIndex < 2; layerIndex += 1) {
        post(layerRequest(plate, layerIndex));
        await waitFor(
          sent,
          () => sent.find((entry) =>
            entry.message.type === "layer-ack" && entry.message.plate === plate && entry.message.layerIndex === layerIndex),
          `layer-ack ${plate}/${layerIndex}`,
        );
      }
    }
    post({ type: "finalize-export", revision: REVISION });
    const result = await waitFor(
      sent,
      () => sent.find((entry) => entry.message.type === "result"),
      "result",
    );
    expect(result.message.type === "result" && result.message.payload.form).toBe("streamed");

    // Ack-before-next ordering: the ack of layer 0 precedes every cyan plate
    // band, and plate emission completes before the final ack of the pass.
    const ackCyan0 = eventIndex(sent, (event) => event.type === "layer-ack" && event.plate === "cyan" && event.layerIndex === 0);
    const ackCyan1 = eventIndex(sent, (event) => event.type === "layer-ack" && event.plate === "cyan" && event.layerIndex === 1);
    const firstCyanBand = eventIndex(sent, (event) => event.type === "plate-band" && event.plate === "cyan");
    const cyanComplete = eventIndex(sent, (event) => event.type === "plate-complete" && event.plate === "cyan");
    expect(ackCyan0).toBeGreaterThanOrEqual(0);
    expect(firstCyanBand).toBeGreaterThan(ackCyan0);
    expect(cyanComplete).toBeGreaterThan(firstCyanBand);
    expect(ackCyan1).toBeGreaterThan(cyanComplete);

    // Bands cover each plate exactly once and transfer both buffers.
    for (const plate of PLATES) {
      let rows = 0;
      for (const entry of sent) {
        if (entry.message.type !== "plate-band" || entry.message.plate !== plate) continue;
        rows += entry.message.rowCount;
        expect(entry.transfer).toHaveLength(2);
        expect(entry.transfer).toContain(entry.message.inkPremultiplied.buffer);
        expect(entry.transfer).toContain(entry.message.alpha.buffer);
        expect(new Float32Array(entry.message.inkPremultiplied.buffer)).toHaveLength(entry.message.rowCount * WIDTH);
      }
      expect(rows).toBe(HEIGHT);
    }
    let proofRows = 0;
    for (const entry of sent) {
      if (entry.message.type !== "proof-band") continue;
      proofRows += entry.message.rowCount;
      expect(entry.transfer).toContain(entry.message.rgba.buffer);
    }
    expect(proofRows).toBe(HEIGHT);

    // Progress stayed monotonic through the whole session.
    const ratios = sent
      .filter((entry) => entry.message.type === "progress")
      .map((entry) => (entry.message as { ratio: number }).ratio);
    expect(ratios.length).toBeGreaterThan(0);
    for (let index = 1; index < ratios.length; index += 1) {
      expect(ratios[index]).toBeGreaterThanOrEqual(ratios[index - 1]);
    }
  });

  it("rejects out-of-order layers and ends the session", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest());
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    post(layerRequest("cyan", 1));
    const failure = await waitFor(
      sent,
      () => sent.find((entry) => entry.message.type === "error"),
      "order error",
    );
    expect(failure.message.type === "error" && failure.message.code).toBe("export-layer-order");
    // The worker is idle again: a fresh session opens cleanly.
    post(beginRequest());
    await waitFor(
      sent,
      () => (sent.filter((entry) => entry.message.type === "export-ready").length === 2 ? true : undefined),
      "second export-ready",
    );
  });

  it("reports revision mismatches without killing the open session", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest());
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    post({ ...layerRequest("cyan", 0), revision: REVISION + 1 });
    const failure = await waitFor(sent, () => sent.find((entry) => entry.message.type === "error"), "revision error");
    expect(failure.message.type === "error" && failure.message.code).toBe("export-session-revision");
    post(layerRequest("cyan", 0));
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "layer-ack"), "layer-ack after mismatch");
  });

  it("cancel mid-session emits cancelled once, releases, ignores stragglers", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest());
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    post(layerRequest("cyan", 0));
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "layer-ack"), "layer-ack");
    post({ type: "cancel", revision: REVISION });
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "cancelled"), "cancelled");
    post(layerRequest("cyan", 1));
    post({ type: "finalize-export", revision: REVISION });
    await flush();
    expect(sent.filter((entry) => entry.message.type === "cancelled")).toHaveLength(1);
    expect(sent.some((entry) => entry.message.type === "result")).toBe(false);
    expect(sent.some((entry) => entry.message.type === "plate-band")).toBe(false);
    expect(sent.some((entry) => entry.message.type === "error")).toBe(false);
  });

  it("refuses finalize before every pass completes", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest());
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    post({ type: "finalize-export", revision: REVISION });
    const failure = await waitFor(sent, () => sent.find((entry) => entry.message.type === "error"), "finalize error");
    expect(failure.message.type === "error" && failure.message.code).toBe("export-finalize-early");
  });

  it("releases a resolved raster when streamed layer dimensions are invalid", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest({ plates: ["black"], layerCount: 1, paper: undefined }));
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");

    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    const request = layerRequest("black", 0);
    request.layer.raster = {
      buffer: new Uint8ClampedArray(4).buffer,
      width: 1,
      height: 1,
    };
    post(request);
    const failure = await waitFor(
      sent,
      () => sent.find((entry) => entry.message.type === "error"),
      "layer size error",
    );
    setAllocationObserver(null);

    expect(failure.message.type === "error" && failure.message.code).toBe("export-layer-size");
    expect(ledger.currentBytes).toBe(0);
    expect(ledger.liveAllocations).toBe(0);
  });

  it("refuses sessions on preview harnesses and without begin", async () => {
    const preview = makeHarness("preview");
    preview.post(beginRequest());
    await flush();
    const refusal = preview.sent.find((entry) => entry.message.type === "error");
    expect(refusal && refusal.message.type === "error" && refusal.message.code).toBe("export-session-unsupported");

    const orphan = makeHarness();
    orphan.post(layerRequest("cyan", 0));
    await flush();
    const missing = orphan.sent.find((entry) => entry.message.type === "error");
    expect(missing && missing.message.type === "error" && missing.message.code).toBe("export-session-missing");
  });

  it("defers single-shot jobs submitted during a session until it ends", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest({ plates: ["black"], layerCount: 1, paper: undefined }));
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    // A frozen single-shot export arrives while the session is open.
    const raster = gradientRaster(WIDTH, HEIGHT);
    post({
      type: "job",
      kind: "export",
      revision: REVISION + 10,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      renderScale: 1,
      minimumCellSize: 3,
      plates: ["black"],
      layers: [{
        raster: { buffer: raster.data.buffer.slice(0) as ArrayBuffer, width: WIDTH, height: HEIGHT },
        settings: diffusionSettings(),
        opacity: 1,
        dotShape: "round",
        strokeWidth: 1,
      }],
      wantBitmap: false,
    });
    await flush();
    expect(sent.some((entry) => entry.message.type === "result")).toBe(false);
    post(layerRequest("black", 0));
    await waitFor(
      sent,
      () => sent.find((entry) => entry.message.type === "layer-ack"),
      "layer-ack",
    );
    post({ type: "finalize-export", revision: REVISION });
    await waitFor(
      sent,
      () => (sent.filter((entry) => entry.message.type === "result").length === 2 ? true : undefined),
      "session result then deferred job result",
    );
    const results = sent.filter((entry) => entry.message.type === "result");
    expect(results[0].message.type === "result" && results[0].message.payload.form).toBe("streamed");
    expect(results[1].message.type === "result" && results[1].message.revision).toBe(REVISION + 10);
  });

  it("rejects begin-export while the worker is busy", async () => {
    const { sent, post } = makeHarness();
    post(beginRequest());
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    post(beginRequest({ revision: REVISION + 1 }));
    await flush();
    const busy = sent.find((entry) => entry.message.type === "error");
    expect(busy && busy.message.type === "error" && busy.message.code).toBe("export-session-busy");
  });

  it("closes transferred custom stamps on ack and on cancellation", async () => {
    // Diffusion layers never draw the stamp, so a plain close-spy works.
    const makeStamp = () => {
      const stamp = { closed: 0, close() { this.closed += 1; } };
      return stamp as unknown as ImageBitmap & { closed: number };
    };
    const { sent, post } = makeHarness();
    post(beginRequest({ plates: ["cyan"], layerCount: 2, paper: undefined }));
    await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
    const ackStamp = makeStamp();
    const ackRequest = layerRequest("cyan", 0);
    ackRequest.layer.customStamp = ackStamp;
    post(ackRequest);
    await waitFor(
      sent,
      () => sent.find((entry) => entry.message.type === "layer-ack"),
      "layer-ack",
    );
    expect((ackStamp as unknown as { closed: number }).closed).toBe(1);

    // Cancel before the second layer: its stamp must still be closed.
    post({ type: "cancel", revision: REVISION });
    const cancelStamp = makeStamp();
    const cancelRequest = layerRequest("cyan", 1);
    cancelRequest.layer.customStamp = cancelStamp;
    post(cancelRequest);
    await flush();
    expect((cancelStamp as unknown as { closed: number }).closed).toBe(1);
  });

  it("transfer helpers cover the new protocol shapes", () => {
    const request = layerRequest("cyan", 0);
    expect(exportLayerTransferables(request)).toEqual([request.layer.raster!.buffer]);
    expect(payloadTransferables({ form: "streamed", width: WIDTH, height: HEIGHT, plates: PLATES })).toEqual([]);
  });
});

describe("proof-only sessions suppress discarded plate bands", () => {
  it("emitPlateBands:false → zero plate-band events, byte-identical proof", async () => {
    const run = async (emitPlateBands: boolean) => {
      const { sent, post } = makeHarness();
      post(
        emitPlateBands
          ? beginRequest()
          : { ...beginRequest(), emitPlateBands: false },
      );
      await waitFor(sent, () => sent.find((entry) => entry.message.type === "export-ready"), "export-ready");
      for (const plate of PLATES) {
        for (let layerIndex = 0; layerIndex < 2; layerIndex += 1) {
          post(layerRequest(plate, layerIndex));
          await waitFor(
            sent,
            () => sent.find((entry) =>
              entry.message.type === "layer-ack" && entry.message.plate === plate && entry.message.layerIndex === layerIndex),
            `layer-ack ${plate}/${layerIndex}`,
          );
        }
      }
      post({ type: "finalize-export", revision: REVISION });
      await waitFor(sent, () => sent.find((entry) => entry.message.type === "result"), "result");
      const plateBands = sent.filter((entry) => entry.message.type === "plate-band");
      const proofBytes: number[] = [];
      for (const entry of sent) {
        if (entry.message.type !== "proof-band") continue;
        proofBytes.push(...new Uint8ClampedArray(entry.message.rgba.buffer));
      }
      const completes = sent.filter((entry) => entry.message.type === "plate-complete").length;
      return { plateBands: plateBands.length, proofBytes, completes };
    };

    const emitting = await run(true);
    const suppressed = await run(false);
    expect(emitting.plateBands).toBeGreaterThan(0);
    expect(suppressed.plateBands).toBe(0);
    // plate-complete still marks pass boundaries in both modes.
    expect(suppressed.completes).toBe(PLATES.length);
    // The proof is byte-identical with and without band emission.
    expect(suppressed.proofBytes.length).toBe(WIDTH * HEIGHT * 4);
    expect(suppressed.proofBytes).toEqual(emitting.proofBytes);
  });
});
