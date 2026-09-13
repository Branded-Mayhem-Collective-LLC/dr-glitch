/**
 * TRUE STREAMING orchestrator (wave G2): startStreamingExport drives plate
 * bands → incremental PNG encode → streamed ZIP entries → sink, with the
 * band-wise output pipeline (polarity → marks → mirror) matching the
 * buffered pipeline's pixel math, the sink terminal state machine
 * (memoized abort, never close-after-abort, commit in the close's own
 * fulfillment continuation), the ≤250ms cancellation contract, and the
 * documented format decisions (JPEG refuses; SVG is ENTRY-BUFFERED with
 * the actual-byte cap).
 */
import { describe, expect, it, vi } from "vitest";
import type { PlateId, ProjectCoreV1 } from "../../src/core/types";
import { readArchive } from "../../src/io/zip-reader";
import {
  ExportCancelledError,
  startStreamingExport,
  type ExportStreamSink,
  type PlateBandDelivery,
  type RasterData,
  type RenderService,
} from "../../src/export/orchestrator";
import {
  invertPlateInk,
  mirrorRasterHorizontal,
  paintRegistrationMarks,
  plateInkRowsToRgba,
} from "../../src/export/output-transforms";

const WIDTH = 21;
const HEIGHT = 15;

function makeCore(overrides: Partial<ProjectCoreV1["output"]> = {}): ProjectCoreV1 {
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
      registrationOnPlates: true,
      registrationOnComposite: false,
      ...overrides,
    },
    unitPreference: "px",
  };
}

/** Deterministic synthetic plate ink field. */
function plateInk(plate: PlateId, pixel: number): number {
  const seed = { cyan: 3, magenta: 5, yellow: 7, black: 11 }[plate];
  return ((pixel * seed) % 97) / 96;
}

/**
 * Fake renderer with a REAL band contract: pushes each plate's synthetic
 * ink in uneven row bands. Also serves the buffered reference conversion.
 */
function makeStreamRenderService(options: { neverFinish?: boolean; delayMs?: number } = {}) {
  let bandsPushed = 0;
  const service: RenderService = {
    renderComposite: () => Promise.reject(new Error("not used")),
    renderPlate: () => Promise.reject(new Error("not used")),
    renderPlateSvg: async (_core, plate) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="1in" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
      `<g data-plate="${plate}"><circle cx="3" cy="3" r="2"/></g></svg>`,
    renderLayer: () => Promise.reject(new Error("not used")),
    async streamPlates(_core, plates, requestOptions, delivery: PlateBandDelivery) {
      for (const plate of plates) {
        await delivery.beginPlate(plate);
        let row = 0;
        for (const count of [4, 7, HEIGHT - 11]) {
          if (requestOptions.signal.aborted) throw new ExportCancelledError();
          if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          if (options.neverFinish && bandsPushed >= 2) {
            await new Promise<never>(() => undefined);
          }
          const ink = new Float32Array(count * WIDTH);
          for (let index = 0; index < ink.length; index += 1) {
            ink[index] = plateInk(plate, row * WIDTH + index);
          }
          await delivery.writeBand(plate, row, count, plateInkRowsToRgba(ink, ink.length));
          bandsPushed += 1;
          row += count;
        }
        await delivery.endPlate(plate);
      }
    },
  };
  return service;
}

/** The buffered-pipeline reference bytes for one plate (same math). */
function referencePlate(core: ProjectCoreV1, plate: PlateId): Uint8ClampedArray {
  const ink = new Float32Array(WIDTH * HEIGHT);
  for (let index = 0; index < ink.length; index += 1) ink[index] = plateInk(plate, index);
  let raster: RasterData = { data: plateInkRowsToRgba(ink, ink.length), width: WIDTH, height: HEIGHT };
  if (core.output.polarity === "negative") {
    raster = invertPlateInk(raster);
    paintRegistrationMarks(raster, core.registration);
  } else {
    paintRegistrationMarks(raster, core.registration);
  }
  if (core.output.pressMirror) raster = mirrorRasterHorizontal(raster);
  return raster.data;
}

/** Minimal filter-0 PNG decoder (same as the encoder suite). */
async function decodePngPixels(bytes: Uint8Array): Promise<Uint8Array> {
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    const data = bytes.slice(at + 8, at + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  const rowBytes = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    pixels.set(inflated.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)), row * rowBytes);
  }
  return pixels;
}

type SinkRecord = {
  sink: ExportStreamSink;
  bytes: () => Uint8Array;
  writes: number;
  closed: number;
  aborted: number;
};

function makeSink(): SinkRecord {
  const chunks: Uint8Array[] = [];
  const record: SinkRecord = {
    writes: 0,
    closed: 0,
    aborted: 0,
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let cursor = 0;
      for (const chunk of chunks) {
        out.set(chunk, cursor);
        cursor += chunk.length;
      }
      return out;
    },
    sink: {
      write(chunk) {
        record.writes += 1;
        chunks.push(chunk.slice());
      },
      async close() {
        record.closed += 1;
      },
      async abort() {
        record.aborted += 1;
      },
    },
  };
  return record;
}

const ENCODERS = {
  encodePng: () => Promise.reject(new Error("buffered encoders unused on the streamed path")),
  encodeJpeg: () => Promise.reject(new Error("unused")),
  encodeTiff: () => Promise.reject(new Error("unused")),
  zip: () => Promise.reject(new Error("the buffered zip must NEVER run on the streamed path")),
};

function startJob(
  core: ProjectCoreV1,
  sinkRecord: SinkRecord,
  render: RenderService,
  target: { kind: "plate-package"; format: "png" | "svg"; registration?: boolean } = {
    kind: "plate-package",
    format: "png",
  },
) {
  return startStreamingExport({
    core,
    revision: 3,
    sourceName: "artwork.png",
    target,
    render,
    encoders: ENCODERS,
    sink: sinkRecord.sink,
  });
}

describe("startStreamingExport (plate packages)", () => {
  it("writes a reader-valid ZIP whose plate PNGs are PIXEL-IDENTICAL to the buffered pipeline (positive + marks)", async () => {
    const core = makeCore();
    const sink = makeSink();
    const job = startJob(core, sink, makeStreamRenderService());
    const result = await job.result;
    expect(result.name).toBe("artwork-CMYK-plates.zip");
    expect(sink.closed).toBe(1);
    expect(sink.aborted).toBe(0);
    expect(result.bytesWritten).toBe(sink.bytes().length);
    const archive = await readArchive(sink.bytes());
    expect([...archive.keys()].sort()).toEqual([
      "artwork-C-plate.png",
      "artwork-K-plate.png",
      "artwork-M-plate.png",
      "artwork-Y-plate.png",
      "job-settings.json",
    ]);
    for (const [plate, letter] of [
      ["cyan", "C"],
      ["magenta", "M"],
      ["yellow", "Y"],
      ["black", "K"],
    ] as const) {
      const pixels = await decodePngPixels(archive.get(`artwork-${letter}-plate.png`)!);
      expect(Buffer.from(pixels).equals(Buffer.from(referencePlate(core, plate).buffer))).toBe(true);
    }
    const manifest = JSON.parse(new TextDecoder().decode(archive.get("job-settings.json")!));
    expect(manifest.source).toBe("artwork.png");
  });

  it("band-wise negative polarity + marks + press mirror equal the buffered transform order", async () => {
    const core = makeCore({ polarity: "negative", pressMirror: true });
    const sink = makeSink();
    const job = startJob(core, sink, makeStreamRenderService());
    await job.result;
    const archive = await readArchive(sink.bytes());
    const pixels = await decodePngPixels(archive.get("artwork-K-plate.png")!);
    expect(Buffer.from(pixels).equals(Buffer.from(referencePlate(core, "black").buffer))).toBe(true);
  });

  it("cancel mid-stream settles ≤250ms: sink.abort exactly once, close never, no buffered zip", async () => {
    const core = makeCore();
    const sink = makeSink();
    const job = startJob(core, sink, makeStreamRenderService({ neverFinish: true }));
    job.result.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const cancelledAt = Date.now();
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ExportCancelledError);
    expect(Date.now() - cancelledAt).toBeLessThan(200);
    expect(sink.aborted).toBe(1);
    expect(sink.closed).toBe(0);
  });

  it("a cancel AFTER the commit never aborts the closed file (terminal arbitration)", async () => {
    const core = makeCore();
    const sink = makeSink();
    const job = startJob(core, sink, makeStreamRenderService());
    await job.result;
    job.cancel(); // post-commit: must be a no-op
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sink.closed).toBe(1);
    expect(sink.aborted).toBe(0);
  });

  it("a THROWING progress callback after packaging cannot abort a committed file", async () => {
    const core = makeCore();
    const sink = makeSink();
    const job = startStreamingExport({
      core,
      revision: 3,
      sourceName: "artwork.png",
      target: { kind: "plate-package", format: "png" },
      render: makeStreamRenderService(),
      encoders: ENCODERS,
      sink: sink.sink,
      onProgress: () => {
        throw new Error("hostile progress consumer");
      },
    });
    await job.result; // contained; still succeeds
    expect(sink.closed).toBe(1);
    expect(sink.aborted).toBe(0);
  });

  it("post-open validation failures abandon the sink exactly once (never close)", async () => {
    const core = makeCore({ polarity: "negative" });
    const sink = makeSink();
    const job = startJob(core, sink, makeStreamRenderService(), {
      kind: "plate-package",
      format: "svg",
    });
    await expect(job.result).rejects.toMatchObject({ code: "polarity-vector-unsupported" });
    expect(sink.aborted).toBe(1);
    expect(sink.closed).toBe(0);

    const customMarks = makeCore();
    customMarks.registration.customShapeAssetId = "f".repeat(64);
    const sink2 = makeSink();
    const job2 = startJob(customMarks, sink2, makeStreamRenderService());
    await expect(job2.result).rejects.toMatchObject({ code: "registration-shape-unsupported" });
    expect(sink2.aborted).toBe(1);
    expect(sink2.closed).toBe(0);
  });

  it("SVG packages are ENTRY-BUFFERED (documented, capped): valid zip; over-cap actual bytes abort with zero entry body", async () => {
    const core = makeCore();
    const sink = makeSink();
    const job = startJob(core, sink, makeStreamRenderService(), {
      kind: "plate-package",
      format: "svg",
      registration: false,
    });
    await job.result;
    const archive = await readArchive(sink.bytes());
    const names = [...archive.keys()];
    expect(names.filter((name) => name.endsWith(".svg"))).toHaveLength(4);
    expect(names.some((name) => name.endsWith("job-settings.json"))).toBe(true);

    // Actual-byte cap: a renderer emitting an oversized SVG aborts BEFORE
    // any entry body reaches the archive.
    const oversized: RenderService = {
      ...makeStreamRenderService(),
      renderPlateSvg: async () => `<svg>${"x".repeat(33 * 1024 * 1024)}</svg>`,
    };
    const sink2 = makeSink();
    const job2 = startJob(makeCore(), sink2, oversized, {
      kind: "plate-package",
      format: "svg",
      registration: false,
    });
    await expect(job2.result).rejects.toMatchObject({ code: "svg-entry-bytes-exceeded" });
    expect(sink2.aborted).toBe(1);
    expect(sink2.closed).toBe(0);
    expect(sink2.bytes().length).toBe(0); // zero entry body written
  }, 30_000);

  it("refuses JPEG (no streamed form) with the sink abandoned", async () => {
    const sink = makeSink();
    const job = startStreamingExport({
      core: makeCore(),
      revision: 3,
      sourceName: "artwork.png",
      target: { kind: "composite", format: "jpeg" },
      render: makeStreamRenderService(),
      encoders: ENCODERS,
      sink: sink.sink,
    });
    await expect(job.result).rejects.toMatchObject({ code: "stream-target-unsupported" });
    expect(sink.aborted).toBe(1);
    expect(sink.closed).toBe(0);
  });
});


describe("streamed custom registration", () => {
  it.each([false, true])("paints custom bands after polarity and before mirror=%s", async (mirror) => {
    const core = makeCore({ polarity: "negative", pressMirror: mirror });
    core.registration.customShapeAssetId = "f".repeat(64);
    const sink = makeSink();
    const dispose = vi.fn();
    const prepare = vi.fn(async () => ({
      async paintRows(rows: Uint8ClampedArray, _start: number, count: number) {
        for (let y = 0; y < count; y++) rows.set([23, 47, 91, 177], y * WIDTH * 4);
      }, dispose,
    }));
    await startStreamingExport({ core, revision: 1, sourceName: "artwork", target: { kind: "plate-package", format: "png" },
      render: makeStreamRenderService(), encoders: ENCODERS, sink: sink.sink, prepareCustomRegistration: prepare,
    }).result;
    const entries = await readArchive(sink.bytes());
    for (const plate of ["cyan", "magenta", "yellow", "black"] as const) {
      const short = { cyan: "C", magenta: "M", yellow: "Y", black: "K" }[plate];
      const actual = await decodePngPixels(entries.get(`artwork-${short}-plate.png`)!);
      for (let y = 0; y < HEIGHT; y++) {
        const x = mirror ? WIDTH - 1 : 0;
        const at = (y * WIDTH + x) * 4;
        expect([...actual.subarray(at, at + 4)]).toEqual([23, 47, 91, 177]);
        const sourceX = 2, outputX = mirror ? WIDTH - 1 - sourceX : sourceX;
        const expectedAlpha = 255 - new Uint8ClampedArray([plateInk(plate, y * WIDTH + sourceX) * 255])[0];
        expect(actual[(y * WIDTH + outputX) * 4 + 3]).toBe(expectedAlpha);
      }
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(sink.closed).toBe(1);
  });

  it("cancels a pending stamp preparation and disposes its late result", async () => {
    const core = makeCore();
    core.registration.customShapeAssetId = "f".repeat(64);
    const sink = makeSink();
    const dispose = vi.fn();
    let resolve!: (painter: { paintRows: () => Promise<void>; dispose: () => void }) => void;
    const prepare = vi.fn(() => new Promise<{ paintRows: () => Promise<void>; dispose: () => void }>((r) => { resolve = r; }));
    const job = startStreamingExport({ core, revision: 1, sourceName: "artwork", target: { kind: "plate-package", format: "png" },
      render: makeStreamRenderService(), encoders: ENCODERS, sink: sink.sink, prepareCustomRegistration: prepare,
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ExportCancelledError);
    resolve({ paintRows: async () => undefined, dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(sink.closed).toBe(0);
    expect(sink.aborted).toBe(1);
  });
});
