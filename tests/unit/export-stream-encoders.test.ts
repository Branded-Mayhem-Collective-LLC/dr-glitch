/**
 * Streaming encoders (wave G2): the row-push PNG encoder and the banded
 * TIFF chunk stream. PNG output is pixel-exact (decoded via
 * DecompressionStream + un-filtering — the encoder writes filter 0) with
 * exactly one pHYs chunk at the requested DPI; TIFF chunk concatenation is
 * BYTE-IDENTICAL to the buffered encoder. Ledger assertions prove the
 * bounded staging contract: every owned band/frame charge releases and the
 * peak stays below the shared compressor/coalescer envelope.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedger, setAllocationObserver } from "../../src/render/instrumentation";
import { createPngRowEncoder, streamPngChunks } from "../../src/export/png-stream";
import { encodeTiffRgba, streamTiffRgbaChunks } from "../../src/export/tiff";
import {
  MAX_DEFLATE_READ_CHUNK_BYTES,
  PNG_IDAT_PAYLOAD_BYTES,
} from "../../src/core/stream-memory";

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function makeRaster(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (index * 31 + 7) % 256;
  }
  return { width, height, data };
}

/** Minimal decoder for OUR OWN output: filter-0 scanlines, zlib IDAT. */
async function decodePng(bytes: Uint8Array): Promise<{
  width: number;
  height: number;
  pixels: Uint8Array;
  physCount: number;
  ppm: number;
}> {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  let physCount = 0;
  let ppm = 0;
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
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(6); // RGBA
    } else if (type === "pHYs") {
      physCount += 1;
      ppm = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      expect(data[8]).toBe(1);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    at += 12 + length;
  }
  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  const rowBytes = width * 4;
  expect(inflated.length).toBe(height * (rowBytes + 1));
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    expect(inflated[row * (rowBytes + 1)]).toBe(0); // filter None
    pixels.set(
      inflated.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)),
      row * rowBytes,
    );
  }
  return { width, height, pixels, physCount, ppm };
}

describe("createPngRowEncoder", () => {
  it("row-pushed bands decode to exactly the input pixels with one 240-DPI pHYs", async () => {
    const raster = makeRaster(37, 23);
    const encoder = createPngRowEncoder(raster.width, raster.height, { dpi: 240 });
    const chunks: Uint8Array[] = [];
    const drain = (async () => {
      const reader = encoder.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();
    const rowBytes = raster.width * 4;
    // Uneven bands, pushed incrementally like plate bands arrive.
    for (const [start, count] of [
      [0, 5],
      [5, 11],
      [16, 7],
    ] as const) {
      await encoder.writeRows(raster.data.subarray(start * rowBytes, (start + count) * rowBytes));
    }
    await encoder.end();
    await drain;
    const decoded = await decodePng(concat(chunks));
    expect(decoded.width).toBe(raster.width);
    expect(decoded.height).toBe(raster.height);
    expect(decoded.physCount).toBe(1);
    expect(decoded.ppm).toBe(Math.round((240 * 1000) / 25.4));
    expect(Buffer.from(decoded.pixels).equals(Buffer.from(raster.data.buffer))).toBe(true);
  });

  it("keeps packaging memory bounded on the ledger and releases every ownership receipt", async () => {
    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    try {
      const raster = makeRaster(128, 512);
      const chunks: Uint8Array[] = [];
      for await (const chunk of streamPngChunks(raster, { dpi: 240, bandRows: 16 })) {
        chunks.push(chunk);
      }
      expect(concat(chunks).length).toBeGreaterThan(0);
      // Every filtered band was released...
      expect(ledger.currentBytes).toBe(0);
      // Worst observable overlap: one capped compressor read, the persistent
      // coalescer, one IDAT frame, and one filtered input band. Native codec
      // internals are covered by the browser UASM gate, not this realm ledger.
      expect(ledger.peakBytes).toBeLessThanOrEqual(
        MAX_DEFLATE_READ_CHUNK_BYTES +
          2 * (PNG_IDAT_PAYLOAD_BYTES + 12) +
          16 * (128 * 4 + 1),
      );
      expect(ledger.peakByKind.get("encode")).toBeGreaterThan(0);
    } finally {
      setAllocationObserver(null);
    }
  });

  it("short feed errors and abort rejects pending work", async () => {
    const short = createPngRowEncoder(8, 8, { dpi: 240 });
    await short.writeRows(new Uint8Array(8 * 4 * 3));
    await short.end();
    await expect(new Response(short.readable).arrayBuffer()).rejects.toThrow(/ended after/);

    const aborted = createPngRowEncoder(8, 8, { dpi: 240 });
    const consumed = new Response(aborted.readable).arrayBuffer();
    consumed.catch(() => undefined);
    aborted.abort(new Error("cancelled"));
    await expect(consumed).rejects.toThrow();
    await expect(aborted.writeRows(new Uint8Array(8 * 4))).rejects.toThrow();
  });

  it("drains a backpressured filtered band when cancellation lands before the PNG is read", async () => {
    const width = 512;
    const height = 512;
    const rows = new Uint8Array(width * height * 4);
    // Incompressible enough to make CompressionStream apply backpressure
    // while the output is deliberately unread, matching a blocked archive
    // sink before it advances past the PNG headers.
    let state = 0x9e3779b9;
    for (let index = 0; index < rows.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      rows[index] = state;
    }

    const ledger = new MemoryLedger();
    const controller = new AbortController();
    setAllocationObserver(ledger);
    try {
      const encoder = createPngRowEncoder(width, height, { dpi: 240 });
      const writing = encoder.writeRows(rows, controller.signal);
      // Let the output stream pre-pull and stop on its queued PNG header;
      // the compressor readable has not otherwise been consumed.
      await Promise.resolve();
      expect(ledger.currentBytes).toBeGreaterThanOrEqual(height * (width * 4 + 1));

      controller.abort();
      // Caller cancellation is not itself an ownership boundary: the band
      // remains charged until the compressor's native terminal promises
      // prove that the queued write was processed or discarded.
      expect(ledger.currentBytes).toBeGreaterThanOrEqual(height * (width * 4 + 1));
      await expect(writing).rejects.toMatchObject({ code: "export-cancelled" });
      const deadline = Date.now() + 1_000;
      while (ledger.liveAllocations !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(ledger.currentBytes).toBe(0);
      expect(ledger.liveAllocations).toBe(0);
    } finally {
      setAllocationObserver(null);
    }
  });
});

describe("streamTiffRgbaChunks", () => {
  it("chunk concatenation is byte-identical to the buffered encoder", async () => {
    const raster = makeRaster(29, 17);
    const buffered = encodeTiffRgba(raster.width, raster.height, raster.data, 240);
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamTiffRgbaChunks(raster, { dpi: 240, bandRows: 5 })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(2); // preamble + several bands
    expect(Buffer.from(concat(chunks)).equals(Buffer.from(buffered))).toBe(true);
  });

  it("aborts between bands when the signal fires", async () => {
    const controller = new AbortController();
    const raster = makeRaster(16, 64);
    const iterator = streamTiffRgbaChunks(raster, { dpi: 240, bandRows: 4, signal: controller.signal });
    await iterator.next(); // preamble
    await iterator.next(); // first band
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
});
