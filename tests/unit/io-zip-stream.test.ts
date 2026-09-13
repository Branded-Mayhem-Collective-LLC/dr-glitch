/**
 * Streaming ZIP writer (wave G2): entry-by-entry delivery with data
 * descriptors into a caller sink, plus the DETERMINISM SPLIT — the
 * archive-determinism suite binds to the buffered writer only; the
 * streamed archive must still be fully readable by the hardened reader.
 * Also covers the abort contract (never finalizes: no EOCD after abort),
 * the state guards (add-after-close, sequential adds, double abort), and
 * bounded cancellation of a blocked sink write.
 */
import { describe, expect, it } from "vitest";
import { readArchive } from "../../src/io/zip-reader";
import { createStreamingArchiveWriter, writeArchive } from "../../src/io/zip-writer";

const encoder = new TextEncoder();

type SinkOptions = { blockAfter?: number };

function makeSink(options: SinkOptions = {}) {
  const chunks: Uint8Array[] = [];
  let writes = 0;
  let blocked: (() => void) | null = null;
  const sink = {
    chunks,
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
    unblock: () => blocked?.(),
    async write(chunk: Uint8Array) {
      writes += 1;
      if (options.blockAfter !== undefined && writes > options.blockAfter) {
        await new Promise<void>((resolve) => {
          blocked = resolve;
        });
      }
      chunks.push(chunk.slice());
    },
  };
  return sink;
}

function chunkedStream(data: Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

/** True when the buffer contains a ZIP end-of-central-directory record. */
function hasEocd(bytes: Uint8Array): boolean {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
      return true;
    }
  }
  return false;
}

describe("createStreamingArchiveWriter", () => {
  it("streams entries (buffers and chunked ReadableStreams) into a reader-valid archive", async () => {
    const sink = makeSink();
    const archive = createStreamingArchiveWriter(sink);
    const png = new Uint8Array(1024).map((_, index) => index % 251);
    await archive.addEntry("plates/K-plate.png", chunkedStream(png), { compress: false });
    await archive.addEntry("job-settings.json", encoder.encode(JSON.stringify({ ok: true })));
    await archive.close();
    const bytes = sink.bytes();
    expect(hasEocd(bytes)).toBe(true);
    // The HARDENED reader accepts the streamed archive (data descriptors
    // included) and returns exact entry bytes.
    const read = await readArchive(bytes);
    expect([...read.keys()].sort()).toEqual(["job-settings.json", "plates/K-plate.png"]);
    const plate = read.get("plates/K-plate.png")!;
    expect(Buffer.from(plate).equals(Buffer.from(png))).toBe(true);
  });

  it("documents the determinism split: buffered output is reproducible, streamed output is delivery-only", async () => {
    const entries = [
      { name: "a.txt", data: encoder.encode("alpha") },
      { name: "b.txt", data: encoder.encode("beta") },
    ];
    const bufferedOnce = await writeArchive(entries);
    const bufferedTwice = await writeArchive(entries);
    // Buffered writer: byte-identical across runs — the determinism suite
    // binds HERE.
    expect(Buffer.from(bufferedOnce).equals(Buffer.from(bufferedTwice))).toBe(true);
    const sink = makeSink();
    const streaming = createStreamingArchiveWriter(sink);
    for (const entry of entries) await streaming.addEntry(entry.name, entry.data);
    await streaming.close();
    // Streamed output differs (data descriptors) but reads back identically.
    const read = await readArchive(sink.bytes());
    expect([...read.keys()].sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("abort NEVER finalizes: no EOCD bytes ever reach the sink after abort", async () => {
    const sink = makeSink();
    const archive = createStreamingArchiveWriter(sink);
    await archive.addEntry("one.bin", new Uint8Array(64));
    await archive.abort(new Error("cancelled"));
    await expect(archive.close()).rejects.toThrow();
    // The partial bytes carry entry data but never a central directory.
    expect(hasEocd(sink.bytes())).toBe(false);
    // Idempotent double abort.
    await archive.abort();
  });

  it("rejects add-after-close and concurrent adds with typed guards", async () => {
    const sink = makeSink();
    const archive = createStreamingArchiveWriter(sink);
    // Concurrent add: entries are strictly sequential.
    let release: (() => void) | null = null;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });
    const first = archive.addEntry("slow.bin", slow);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(archive.addEntry("second.bin", new Uint8Array(4))).rejects.toMatchObject({
      code: "archive-write-conflict",
    });
    release!();
    await first;
    await archive.close();
    await expect(archive.addEntry("late.bin", new Uint8Array(4))).rejects.toMatchObject({
      code: "archive-writer-closed",
    });
  });

  it("keeps a completed close terminal when abort arrives afterward", async () => {
    const sink = makeSink();
    const archive = createStreamingArchiveWriter(sink);
    await archive.addEntry("done.bin", new Uint8Array(8));
    await archive.close();
    const committed = sink.bytes().slice();
    await archive.abort(new Error("too late"));
    expect(Buffer.from(sink.bytes()).equals(Buffer.from(committed))).toBe(true);
    expect(hasEocd(sink.bytes())).toBe(true);
    await expect(archive.close()).rejects.toMatchObject({ code: "archive-writer-closed" });
  });

  it("rejects duplicate entry names case-insensitively", async () => {
    const sink = makeSink();
    const archive = createStreamingArchiveWriter(sink);
    await archive.addEntry("Plate.png", new Uint8Array(8), { compress: false });
    await expect(archive.addEntry("plate.PNG", new Uint8Array(8))).rejects.toMatchObject({
      code: "archive-duplicate-entry",
    });
    await archive.abort();
  });

  it("cancels a BLOCKED sink write within the settlement bound; abort never becomes closed", async () => {
    const sink = makeSink({ blockAfter: 1 });
    const archive = createStreamingArchiveWriter(sink);
    const pending = archive.addEntry("big.bin", new Uint8Array(256 * 1024));
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    await archive.abort(new Error("cancelled"));
    // abort() itself settles immediately (never awaits the stuck write)...
    expect(Date.now() - startedAt).toBeLessThan(200);
    // ...and once the sink unblocks, the pending add rejects instead of
    // silently continuing, and close reports the abort — the archive can
    // never transition aborted → closed.
    sink.unblock();
    await expect(pending).rejects.toThrow();
    await expect(archive.close()).rejects.toThrow();
    expect(hasEocd(sink.bytes())).toBe(false);
  });
});
