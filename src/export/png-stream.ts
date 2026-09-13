/**
 * Streaming PNG encoder for TRUE STREAMING EXPORT delivery (wave G2).
 *
 * Row-push architecture: the render's plate bands arrive incrementally
 * (top-to-bottom), each band is filtered scanline-by-scanline (filter 0)
 * and fed to the platform's CompressionStream("deflate") — the zlib
 * format IDAT requires — while the pull side (`readable`, handed to a
 * streaming ZIP entry or a writable) receives complete chunks: signature,
 * IHDR, one pHYs, IDAT blocks as the compressor emits them, IEND. At no
 * point does a complete encoded PNG — or a complete unencoded raster —
 * exist inside the encoder; retention is one filtered band plus the
 * compressor window, and real backpressure flows both ways (a slow sink
 * stalls writeRows, which stalls the renderer's band-credit loop).
 *
 * BYTE CONTRACT: output is a standards-valid PNG that decodes to exactly
 * the pushed pixels (bit depth 8, color type 6 RGBA, filter 0 per
 * scanline). The BYTES intentionally differ from the canvas-encoded
 * buffered path (different compressor and filters) — streamed delivery is
 * pixel-exact, not byte-identical, and every hash-parity oracle binds to
 * the non-streamed path only.
 *
 * DOM-free: needs only CompressionStream (Chromium 80+, Node 18+), so the
 * encoder is unit-testable in node and usable from any realm. Band
 * buffers self-report to the allocation ledger under "encode" so the
 * memory tests can prove bounded packaging retention.
 */

import {
  MAX_DEFLATE_READ_CHUNK_BYTES,
  PNG_IDAT_PAYLOAD_BYTES,
} from "../core/stream-memory";
import { retainAllocation } from "../render";
import { ExportError } from "./orchestrator";

/* ------------------------------------------------------------------ */
/* CRC32 (PNG chunk checksums)                                         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      crc = CRC_TABLE[(crc ^ part[index]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Chunk assembly                                                      */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Fixed IDAT payload size (framing-bound enforcement; see chunks()). */
export const IDAT_PAYLOAD_BYTES = PNG_IDAT_PAYLOAD_BYTES;

function typeBytes(type: string): Uint8Array {
  return Uint8Array.from(type, (char) => char.charCodeAt(0));
}

/** One complete chunk: length + type + data + CRC. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const name = typeBytes(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(name, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(name, data));
  return out;
}

function ihdrChunk(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = 6; // color type: RGBA
  // compression 0, filter 0, interlace 0 already zero.
  return pngChunk("IHDR", data);
}

function physChunk(dpi: number): Uint8Array {
  // Pixels per meter, unit 1 (meter) — the same math as studio/png-dpi.
  const ppm = Math.round((dpi * 1000) / 25.4);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, ppm);
  view.setUint32(4, ppm);
  data[8] = 1;
  return pngChunk("pHYs", data);
}

/* ------------------------------------------------------------------ */
/* Row-push encoder                                                    */
/* ------------------------------------------------------------------ */

export type PngRowEncoderOptions = {
  /** Resolution stamped into the single pHYs chunk. */
  dpi: number;
};

export type PngRowEncoder = {
  /**
   * Feed the next scanlines (top-to-bottom; length must be a whole number
   * of rows). Resolves once the compressor accepted the band — real
   * backpressure from the consumer of `readable`.
   */
  writeRows(
    rgbaRows: Uint8Array | Uint8ClampedArray,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Every row fed; flushes the trailing IDAT and IEND. */
  end(signal?: AbortSignal): Promise<void>;
  /** Abort: `readable` errors, pending writes reject, buffers release. */
  abort(reason?: unknown): void;
  /** Encoded PNG bytes, pulled by the consumer (streaming ZIP entry). */
  readable: ReadableStream<Uint8Array>;
};

export function createPngRowEncoder(
  width: number,
  height: number,
  options: PngRowEncoderOptions,
): PngRowEncoder {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ExportError("export-failed", "createPngRowEncoder expected positive integer dimensions");
  }
  const rowBytes = width * 4;
  const compressor = new CompressionStream("deflate");
  const feed = compressor.writable.getWriter();
  // Own the compressor's readable side from construction, not only after
  // the outer PNG stream advances past its three header frames. A blocked
  // archive can leave those headers queued while writeRows is already
  // backpressured; without this reader, abort has no way to cancel the
  // compressor output and its pending input write can retain a whole band.
  const drain = compressor.readable.getReader();
  let rowsFed = 0;
  let aborted: unknown = null;
  let feedAbort: Promise<void> | null = null;
  let drainCancel: Promise<void> | null = null;
  let terminalCleanup: Promise<void> | null = null;
  let drainLockReleased = false;
  let writeInFlight = false;
  let ending = false;
  let ended = false;
  let iteratorRef: AsyncGenerator<Uint8Array, void, void> | null = null;
  let outputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const pendingBandReleases = new Set<() => void>();

  const asError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));
  const cancelled = () => new ExportError("export-cancelled", "Export cancelled");
  // `closed` is the platform's terminal ownership boundary: after it
  // settles the compressor has processed or discarded every queued write.
  // Catch here so an abort rejection is always observed.
  const feedClosed = feed.closed.then(
    () => undefined,
    () => undefined,
  );
  const releaseDrainLock = () => {
    if (drainLockReleased) return;
    drainLockReleased = true;
    drain.releaseLock();
  };
  const cancelDrain = (reason: unknown): Promise<void> => {
    if (drainLockReleased) return Promise.resolve();
    drainCancel ??= Promise.resolve()
      .then(() => drain.cancel(reason))
      .catch(() => undefined)
      .then(releaseDrainLock);
    return drainCancel;
  };
  const requestAbort = (reason?: unknown): Promise<void> => {
    if (aborted === null) aborted = reason ?? cancelled();
    try {
      outputController?.error(aborted);
    } catch {
      /* stream already terminal */
    }
    if (!terminalCleanup) {
      // Start BOTH sides concurrently. In particular, cancelling the
      // eagerly-owned readable breaks CompressionStream backpressure even
      // when the public PNG readable never advanced beyond its headers.
      feedAbort ??= Promise.resolve()
        .then(() => feed.abort(aborted))
        .catch(() => undefined);
      const cancelOutput = cancelDrain(aborted);
      const closeIterator = Promise.resolve()
        .then(() => iteratorRef?.return())
        .catch(() => undefined);
      terminalCleanup = Promise.all([
        feedAbort,
        cancelOutput,
        feedClosed,
        closeIterator,
      ]).then(() => {
        // A write promise normally releases its own receipt. This terminal
        // fallback covers platform implementations that settle `closed`
        // after discarding a queued chunk but fail to settle that individual
        // write promise. Releasing before this boundary would falsify the
        // ledger because the native compressor could still retain `band`.
        for (const release of [...pendingBandReleases]) release();
      });
    }
    return terminalCleanup;
  };
  const raceSignal = <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return pending;
    if (signal.aborted) {
      const error = cancelled();
      void requestAbort(error);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const error = cancelled();
        void requestAbort(error);
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(asError(error));
        },
      );
    });
  };

  async function* ownedFrame(
    frame: Uint8Array,
    label: string,
  ): AsyncGenerator<Uint8Array, void, void> {
    const release = retainAllocation(frame.byteLength, "encode", label);
    try {
      yield frame;
    } finally {
      release();
    }
  }

  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    yield* ownedFrame(PNG_SIGNATURE.slice(), "png-frame");
    yield* ownedFrame(ihdrChunk(width, height), "png-frame");
    yield* ownedFrame(physChunk(options.dpi), "png-frame");
    // FIXED-SIZE IDAT COALESCING: CompressionStream's output chunking is
    // implementation-defined (it may emit many tiny chunks), so deflate
    // output is buffered into fixed 64 KiB IDAT payloads BEFORE framing —
    // the 12-bytes-per-64KiB framing bound in the delivery estimate holds
    // BY CONSTRUCTION, and the coalescing buffer is the ledgered staging
    // term (one payload, bounded).
    const pending = new Uint8Array(IDAT_PAYLOAD_BYTES);
    const releasePending = retainAllocation(
      pending.byteLength,
      "encode",
      "png-idat-coalescer",
    );
    let pendingLength = 0;
    let drained = false;
    try {
      for (;;) {
        const { done, value } = await drain.read();
        if (done) {
          drained = true;
          break;
        }
        // HONEST LEDGER for the platform-defined read: CompressionStream
        // may emit its output in arbitrarily large chunks, and that whole
        // buffer stays live while it is consumed into fixed frames — so
        // it is CHARGED on receipt and released once fully consumed. The
        // model's compressor term is therefore platform-bounded-by-
        // measurement (the browser benchmark's UASM gate), while the
        // frame sizes are bounded by construction.
        const retainedReadBytes = Math.max(value.byteLength, value.buffer.byteLength);
        const releaseRead = retainAllocation(
          retainedReadBytes,
          "encode",
          "png-deflate-read",
        );
        try {
          if (retainedReadBytes > MAX_DEFLATE_READ_CHUNK_BYTES) {
            throw new ExportError(
              "export-failed",
              `CompressionStream emitted an over-limit retained chunk (${retainedReadBytes} bytes).`,
            );
          }
          let offset = 0;
          while (offset < value.length) {
            const take = Math.min(IDAT_PAYLOAD_BYTES - pendingLength, value.length - offset);
            pending.set(value.subarray(offset, offset + take), pendingLength);
            pendingLength += take;
            offset += take;
            if (pendingLength === IDAT_PAYLOAD_BYTES) {
              yield* ownedFrame(pngChunk("IDAT", pending), "png-idat-frame");
              pendingLength = 0;
            }
          }
        } finally {
          releaseRead();
        }
      }
      if (pendingLength > 0) {
        yield* ownedFrame(
          pngChunk("IDAT", pending.subarray(0, pendingLength)),
          "png-idat-frame",
        );
        pendingLength = 0;
      }
    } finally {
      if (!drained) await cancelDrain(aborted ?? cancelled());
      else releaseDrainLock();
      releasePending();
    }
    if (rowsFed !== height) {
      throw new ExportError(
        "export-failed",
        `PNG row stream ended after ${rowsFed} of ${height} rows`,
      );
    }
    yield* ownedFrame(pngChunk("IEND", new Uint8Array(0)), "png-frame");
  }

  const iterator = chunks();
  iteratorRef = iterator;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
    },
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          iteratorRef = null;
          outputController = null;
          controller.close();
        }
        else controller.enqueue(value);
      } catch (error) {
        void requestAbort(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await requestAbort(reason ?? cancelled());
      iteratorRef = null;
      outputController = null;
    },
  });

  return {
    readable,
    async writeRows(rgbaRows, signal) {
      if (aborted !== null) throw aborted instanceof Error ? aborted : new Error(String(aborted));
      if (writeInFlight || ending || ended) {
        throw new ExportError(
          "png-write-conflict",
          "PNG rows must be written sequentially before end().",
        );
      }
      if (rgbaRows.length === 0 || rgbaRows.length % rowBytes !== 0) {
        throw new ExportError("export-failed", "writeRows expected a whole number of scanlines");
      }
      const rows = rgbaRows.length / rowBytes;
      if (rowsFed + rows > height) {
        throw new ExportError("export-failed", "writeRows received more rows than the image height");
      }
      writeInFlight = true;
      try {
        // Filtered band: one extra filter byte (0, None) per scanline.
        const band = new Uint8Array(rows * (rowBytes + 1));
        const releaseBand = retainAllocation(
          band.byteLength,
          "encode",
          "png-stream-band",
        );
        let bandOwned = true;
        const finishBand = () => {
          if (!bandOwned) return;
          bandOwned = false;
          pendingBandReleases.delete(finishBand);
          releaseBand();
        };
        pendingBandReleases.add(finishBand);
        for (let row = 0; row < rows; row += 1) {
          const at = row * (rowBytes + 1);
          band[at] = 0;
          const source = rgbaRows.subarray(row * rowBytes, (row + 1) * rowBytes);
          band.set(source instanceof Uint8ClampedArray ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : source, at + 1);
        }
        let write: Promise<void>;
        try {
          write = feed.write(band);
        } catch (error) {
          finishBand();
          throw error;
        }
        void write.then(finishBand, finishBand);
        await raceSignal(write, signal);
        rowsFed += rows;
      } finally {
        writeInFlight = false;
      }
    },
    async end(signal) {
      if (aborted !== null) return;
      if (writeInFlight || ending || ended) {
        throw new ExportError(
          "png-write-conflict",
          "PNG end() cannot overlap a row write or another end().",
        );
      }
      ending = true;
      try {
        await raceSignal(feed.close(), signal);
        ended = true;
      } finally {
        ending = false;
      }
    },
    abort(reason) {
      if (aborted !== null) return;
      void requestAbort(reason ?? cancelled());
    },
  };
}

/* ------------------------------------------------------------------ */
/* Whole-raster convenience (tests, small callers)                     */
/* ------------------------------------------------------------------ */

export type PngStreamOptions = PngRowEncoderOptions & {
  signal?: AbortSignal;
  /** Rows per pushed band (default ≈4 MiB of scanlines). */
  bandRows?: number;
};

/** Target band payload for the whole-raster wrapper. */
const BAND_TARGET_BYTES = 4 * 1024 * 1024;

/**
 * Encode a complete RGBA raster as an async PNG chunk sequence by pushing
 * it through createPngRowEncoder in bounded bands. Concatenating every
 * yielded chunk is the complete file.
 */
export async function* streamPngChunks(
  raster: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  options: PngStreamOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const { width, height, data } = raster;
  if (data.length !== width * height * 4) {
    throw new ExportError("export-failed", "streamPngChunks expected a full RGBA raster");
  }
  const rowBytes = width * 4;
  const bandRows = Math.max(1, options.bandRows ?? Math.floor(BAND_TARGET_BYTES / (rowBytes + 1)));
  const encoder = createPngRowEncoder(width, height, { dpi: options.dpi });
  const reader = encoder.readable.getReader();
  const onAbort = () => {
    const error = new ExportError("export-cancelled", "Export cancelled");
    encoder.abort(error);
    void reader.cancel(error).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const feeding = (async () => {
    try {
      for (let rowStart = 0; rowStart < height; rowStart += bandRows) {
        if (options.signal?.aborted) throw new ExportError("export-cancelled", "Export cancelled");
        const rows = Math.min(bandRows, height - rowStart);
        await encoder.writeRows(
          data.subarray(rowStart * rowBytes, (rowStart + rows) * rowBytes),
          options.signal,
        );
      }
      await encoder.end(options.signal);
    } catch (error) {
      encoder.abort(error);
      throw error;
    }
  })();
  feeding.catch(() => undefined);
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
    await feeding;
    completed = true;
  } catch (error) {
    encoder.abort(error);
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      encoder.abort(new ExportError("export-cancelled", "Export cancelled"));
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
