import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { ArchiveValidationError, ImportOperation, WorkingSetLedger, openArchiveStream, readArchive, validateEntryName } from "../../src/io/zip-reader";
import { writeArchive } from "../../src/io/zip-writer";

const encoder = new TextEncoder();

/** Raw zip.js writer: crafts archives our hardened writer would refuse to produce. */
async function rawZip(entries: Array<{ name: string; data: Uint8Array; password?: string; level?: number }>): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const entry of entries) {
    await writer.add(entry.name, new Uint8ArrayReader(entry.data), {
      password: entry.password,
      level: entry.level ?? 6,
    });
  }
  return writer.close();
}

/** Replace every occurrence of a byte pattern (equal length) — corrupts headers in place. */
function replaceBytes(buffer: Uint8Array, from: Uint8Array, to: Uint8Array): Uint8Array {
  expect(to.length).toBe(from.length);
  const out = buffer.slice();
  let hits = 0;
  outer: for (let i = 0; i <= out.length - from.length; i++) {
    for (let j = 0; j < from.length; j++) if (out[i + j] !== from[j]) continue outer;
    out.set(to, i);
    hits++;
    i += from.length - 1;
  }
  expect(hits).toBeGreaterThan(0);
  return out;
}

/** Patch the uncompressed-size fields (local + central headers) for one entry. */
function lieAboutSize(buffer: Uint8Array, name: string, fakeSize: number): Uint8Array {
  const out = buffer.slice();
  const nameBytes = encoder.encode(name);
  const view = new DataView(out.buffer);
  let patched = 0;
  for (let i = 0; i <= out.length - 4; i++) {
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b) continue;
    const local = out[i + 2] === 0x03 && out[i + 3] === 0x04;
    const central = out[i + 2] === 0x01 && out[i + 3] === 0x02;
    if (!local && !central) continue;
    const nameOffset = i + (local ? 30 : 46);
    const nameLength = view.getUint16(i + (local ? 26 : 28), true);
    if (nameLength !== nameBytes.length) continue;
    if (!nameBytes.every((byte, j) => out[nameOffset + j] === byte)) continue;
    view.setUint32(i + (local ? 22 : 24), fakeSize, true);
    patched++;
  }
  expect(patched).toBeGreaterThanOrEqual(2);
  return out;
}

/**
 * Repoint one entry's central-directory "relative offset of local header"
 * field so its data range aliases another entry's bytes. This is a REAL
 * overlapping-entry attack: the archive stays structurally valid (signatures,
 * sizes, CRCs untouched) but two central-directory records now claim the
 * same local data.
 */
function repointLocalHeader(buffer: Uint8Array, name: string, newOffset: number): Uint8Array {
  const out = buffer.slice();
  const nameBytes = encoder.encode(name);
  const view = new DataView(out.buffer);
  let patched = 0;
  for (let i = 0; i <= out.length - 4; i++) {
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b || out[i + 2] !== 0x01 || out[i + 3] !== 0x02) continue;
    const nameLength = view.getUint16(i + 28, true);
    if (nameLength !== nameBytes.length) continue;
    if (!nameBytes.every((byte, j) => out[i + 46 + j] === byte)) continue;
    view.setUint32(i + 42, newOffset, true);
    patched++;
  }
  expect(patched).toBe(1);
  return out;
}

async function rejects(bytes: Uint8Array, code: string, options: Parameters<typeof readArchive>[1] = {}) {
  try {
    await readArchive(bytes, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveValidationError);
    expect((error as ArchiveValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection ${code}`);
}

const POLICY = { maxArchiveEntries: 512, maxArchiveCompressedBytes: 512 * 1024 * 1024, maxArchiveUncompressedBytes: 1.5 * 1024 * 1024 * 1024 };

describe("zip round trip", () => {
  it("writes and reads archives deterministically", async () => {
    const entries = [
      { name: "manifest.json", data: encoder.encode('{"a":1}') },
      { name: "assets/deep/file.bin", data: Uint8Array.from({ length: 4096 }, (_, i) => i % 251), compress: false },
    ];
    const first = await writeArchive(entries);
    const second = await writeArchive(entries);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const read = await readArchive(first);
    expect([...read.keys()]).toEqual(["manifest.json", "assets/deep/file.bin"]);
    expect(Buffer.from(read.get("assets/deep/file.bin")!).equals(Buffer.from(entries[1].data))).toBe(true);
  });

  it("the writer refuses bad names and duplicates up front", async () => {
    await expect(writeArchive([{ name: "../up.txt", data: new Uint8Array(1) }])).rejects.toMatchObject({ code: "archive-bad-filename" });
    await expect(writeArchive([
      { name: "a.txt", data: new Uint8Array(1) },
      { name: "A.TXT", data: new Uint8Array(1) },
    ])).rejects.toMatchObject({ code: "archive-duplicate-entry" });
  });
});

describe("zip filename attacks", () => {
  it("validateEntryName rejects traversal, absolute, drive, backslash, control characters", () => {
    for (const name of ["../evil", "a/../b", "..", "/etc/passwd", "C:evil", "c:/evil", "a\\b", "a//b", "./a", "a/", "", "bad\u0001name"]) {
      expect(() => validateEntryName(name), name).toThrowError(ArchiveValidationError);
    }
    expect(() => validateEntryName("ok/nested/file.png")).not.toThrow();
    expect(() => validateEntryName("dir/", { directory: true })).not.toThrow();
  });

  it("rejects traversal and absolute names inside real archives", async () => {
    const base = await rawZip([{ name: "AAAAAAAAA", data: encoder.encode("x") }]);
    for (const evil of ["../ev.txt", "/abs.txts", "C:ev.txts", "a\\bbb.txt"]) {
      await rejects(replaceBytes(base, encoder.encode("AAAAAAAAA"), encoder.encode(evil)), "archive-bad-filename");
    }
  });

  it("rejects non-UTF8 filenames", async () => {
    const base = await rawZip([{ name: "AAAA", data: encoder.encode("x") }]);
    const evil = replaceBytes(base, encoder.encode("AAAA"), Uint8Array.of(0xff, 0xfe, 0x41, 0x41));
    await rejects(evil, "archive-filename-encoding");
  });

  it("rejects case-insensitive duplicate entries", async () => {
    const bytes = await rawZip([
      { name: "Asset.PNG", data: encoder.encode("one") },
      { name: "asset.png", data: encoder.encode("two") },
    ]);
    await rejects(bytes, "archive-duplicate-entry");
  });

  it("rejects entries whose data ranges overlap, and accepts the benign adjacent layout", async () => {
    const payload = Uint8Array.from({ length: 64 }, (_, i) => i);
    // The benign adjacent layout must keep passing with overlap checking on.
    const benign = await rawZip([
      { name: "a.bin", data: payload, level: 0 },
      { name: "b.bin", data: payload, level: 0 },
    ]);
    const clean = await readArchive(benign);
    expect([...clean.keys()]).toEqual(["a.bin", "b.bin"]);
    // Real overlap attack that stays consistent under strict local-header
    // checks: a.bin's DATA is a byte-exact copy of b.bin's local record
    // (header + stored payload), and b.bin's central-directory record is then
    // repointed INTO a.bin's data. b.bin's local header parses cleanly and
    // matches its central record; only its data range betrays the aliasing.
    const inner = await rawZip([{ name: "b.bin", data: payload, level: 0 }]);
    const innerCdOffset = new DataView(inner.buffer).getUint32(inner.length - 22 + 16, true);
    const bBlock = inner.slice(0, innerCdOffset);
    const outer = await rawZip([
      { name: "a.bin", data: bBlock, level: 0 },
      { name: "b.bin", data: payload, level: 0 },
    ]);
    const view = new DataView(outer.buffer);
    const aDataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const overlapping = repointLocalHeader(outer, "b.bin", aDataStart);
    await rejects(overlapping, "archive-entry-overlap");
  });
});

describe("zip strict-mode ambiguity attacks", () => {
  const payload = Uint8Array.from({ length: 64 }, (_, i) => i);

  function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  it("rejects prepended data", async () => {
    const base = await rawZip([{ name: "a.bin", data: payload, level: 0 }]);
    await rejects(concat(encoder.encode("GARBAGE!".repeat(8)), base), "archive-ambiguous");
  });

  it("rejects appended data", async () => {
    const base = await rawZip([{ name: "a.bin", data: payload, level: 0 }]);
    await rejects(concat(base, encoder.encode("TRAILING-JUNK".repeat(4))), "archive-ambiguous");
  });

  it("rejects trailing central-directory data", async () => {
    const base = await rawZip([{ name: "a.bin", data: payload, level: 0 }]);
    const eocd = base.slice(base.length - 22);
    const body = base.slice(0, base.length - 22);
    await rejects(concat(body, encoder.encode("JUNKJUNKJUNKJUNK"), eocd), "archive-ambiguous");
  });

  it("rejects multiple end-of-central-directory records", async () => {
    const base = await rawZip([{ name: "a.bin", data: payload, level: 0 }]);
    const doubled = concat(base, base.slice(base.length - 22));
    // The original EOCD claims a 22-byte comment so BOTH records reach the
    // end of the file, each pointing at a central directory.
    new DataView(doubled.buffer).setUint16(base.length - 2, 22, true);
    await rejects(doubled, "archive-ambiguous");
  });

  it("rejects a local header whose filename disagrees with the central directory", async () => {
    const base = await rawZip([{ name: "b.bin", data: payload, level: 0 }]);
    const out = base.slice();
    const view = new DataView(out.buffer);
    let patched = 0;
    for (let i = 0; i <= out.length - 4; i++) {
      if (out[i] !== 0x50 || out[i + 1] !== 0x4b || out[i + 2] !== 0x03 || out[i + 3] !== 0x04) continue;
      const nameLength = view.getUint16(i + 26, true);
      if (new TextDecoder().decode(out.slice(i + 30, i + 30 + nameLength)) !== "b.bin") continue;
      out[i + 30] = 0x7a; // local header now says "z.bin"; central still says "b.bin"
      patched++;
    }
    expect(patched).toBe(1);
    await rejects(out, "archive-ambiguous");
  });
});

describe("zip resource attacks", () => {
  it("rejects entry-count bombs", async () => {
    const bytes = await rawZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: encoder.encode("x") })));
    await rejects(bytes, "archive-entry-count", { policy: { ...POLICY, maxArchiveEntries: 4 } });
  });

  it("rejects archives over the compressed budget", async () => {
    const bytes = await rawZip([{ name: "a.bin", data: new Uint8Array(4096), level: 0 }]);
    await rejects(bytes, "archive-too-large", { policy: { ...POLICY, maxArchiveCompressedBytes: 1024 } });
  });

  it("rejects honestly-declared decompression bombs from headers", async () => {
    const bytes = await rawZip([{ name: "bomb.bin", data: new Uint8Array(300_000), level: 9 }]);
    expect(bytes.length).toBeLessThan(4096); // highly compressible
    await rejects(bytes, "archive-entry-too-large", { policy: { ...POLICY, maxArchiveUncompressedBytes: 64 * 1024 } });
  });

  it("rejects cumulative uncompressed totals over quota", async () => {
    const bytes = await rawZip([
      { name: "a.bin", data: new Uint8Array(40_000), level: 9 },
      { name: "b.bin", data: new Uint8Array(40_000), level: 9 },
    ]);
    await rejects(bytes, "archive-uncompressed-quota", { policy: { ...POLICY, maxArchiveUncompressedBytes: 64 * 1024 } });
  });

  it("rejects bombs with lying size headers DURING streaming extraction", async () => {
    // Headers claim 10 bytes; the deflate stream actually inflates to 300000.
    const honest = await rawZip([{ name: "liar.bin", data: new Uint8Array(300_000), level: 9 }]);
    const lying = lieAboutSize(honest, "liar.bin", 10);
    await rejects(lying, "archive-size-mismatch");
  });

  it("enforces the working-memory ceiling against honest headers before extraction", async () => {
    const bytes = await rawZip([
      { name: "a.bin", data: new Uint8Array(48_000), level: 9 },
      { name: "b.bin", data: new Uint8Array(48_000), level: 9 },
    ]);
    // The policy quota (1.5 GiB) would admit this; the working-set ceiling must not.
    await rejects(bytes, "archive-working-set", { maxWorkingSetBytes: 64 * 1024 });
  });

  it("keeps the working ceiling airtight against lying-small headers during extraction", async () => {
    // Headers declare 10 bytes (sailing under the up-front declared-size
    // ceiling) while the stream actually inflates to 300000. zip.js clamps
    // inflation at the declared size and fails the entry before a single
    // over-declared byte reaches the buffering sink, so retained memory can
    // never exceed min(declared totals, ceiling); the in-sink working-set
    // guard behind that clamp is defense in depth against zip.js regressions.
    const honest = await rawZip([{ name: "liar.bin", data: new Uint8Array(300_000), level: 9 }]);
    const lying = lieAboutSize(honest, "liar.bin", 10);
    await rejects(lying, "archive-size-mismatch", { maxWorkingSetBytes: 1024 });
  });

  it("returns each entry as one exact-size dedicated allocation", async () => {
    const bytes = await rawZip([{ name: "a.bin", data: Uint8Array.from({ length: 10_000 }, (_, i) => i % 255), level: 9 }]);
    const read = await readArchive(bytes);
    const data = read.get("a.bin")!;
    expect(data.length).toBe(10_000);
    // No chunk-list slack and no second contiguous copy: the buffer IS the entry.
    expect(data.byteOffset).toBe(0);
    expect(data.buffer.byteLength).toBe(data.length);
  });

  it("rejects truncated output when headers overstate the size", async () => {
    const honest = await rawZip([{ name: "short.bin", data: new Uint8Array(64), level: 0 }]);
    const lying = lieAboutSize(honest, "short.bin", 128);
    await rejects(lying, "archive-size-mismatch");
  });
});

describe("zip integrity and cancellation", () => {
  it("rejects CRC mismatches from flipped payload bytes", async () => {
    const payload = encoder.encode("CRC-SENTINEL-PAYLOAD-BYTES");
    const bytes = await rawZip([{ name: "data.bin", data: payload, level: 0 }]);
    const corrupted = replaceBytes(bytes, encoder.encode("SENTINEL"), encoder.encode("TAMPERED"));
    await rejects(corrupted, "archive-crc-mismatch");
  });

  it("rejects encrypted entries", async () => {
    const bytes = await rawZip([{ name: "secret.txt", data: encoder.encode("boo"), password: "hunter2" }]);
    await rejects(bytes, "archive-encrypted");
  });

  it("honors an already-aborted external signal", async () => {
    const bytes = await rawZip([{ name: "a.txt", data: encoder.encode("x") }]);
    const controller = new AbortController();
    controller.abort();
    await rejects(bytes, "archive-aborted", { signal: controller.signal });
  });

  it("times out via the injectable budget", async () => {
    const bytes = await rawZip([{ name: "big.bin", data: new Uint8Array(8 * 1024 * 1024), level: 9 }]);
    await rejects(bytes, "archive-timeout", { timeoutMs: 0 });
  });

  it("rejects garbage that is not a zip archive", async () => {
    await rejects(encoder.encode("this is definitely not a zip file"), "archive-invalid");
  });
});

describe("openArchiveStream — windowed extraction against an honest ledger", () => {
  async function open(bytes: Uint8Array, maxBytes: number) {
    const operation = new ImportOperation({ timeoutMs: 60_000 });
    const ledger = new WorkingSetLedger(maxBytes);
    ledger.retain(bytes.length, "compressed archive");
    const stream = await openArchiveStream(bytes, { operation, ledger, policy: POLICY });
    return { operation, ledger, stream };
  }

  it("charges each entry on read and refunds it on release; peak is one window", async () => {
    const a = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7) % 251);
    const b = Uint8Array.from({ length: 9_000 }, (_, i) => (i * 13) % 251);
    const bytes = await rawZip([
      { name: "a.bin", data: a, level: 0 },
      { name: "b.bin", data: b, level: 0 },
    ]);
    const { operation, ledger, stream } = await open(bytes, 1024 * 1024);
    try {
      expect(stream.names).toEqual(["a.bin", "b.bin"]);
      expect(stream.sizeOf("b.bin")).toBe(9_000);
      const dataA = await stream.read("a.bin");
      expect(ledger.retained).toBe(bytes.length + 5_000);
      stream.release("a.bin");
      stream.release("a.bin"); // idempotent
      expect(ledger.retained).toBe(bytes.length);
      const dataB = await stream.read("b.bin");
      expect(Buffer.from(dataA).equals(Buffer.from(a))).toBe(true);
      expect(Buffer.from(dataB).equals(Buffer.from(b))).toBe(true);
      stream.release("b.bin");
      // Peak: compressed + ONE window at a time (the largest read).
      expect(ledger.peak).toBe(bytes.length + 9_000);
    } finally {
      await stream.close();
      operation.dispose();
    }
  });

  it("each entry streams exactly once — a second read is a typed rejection", async () => {
    const bytes = await rawZip([{ name: "a.bin", data: new Uint8Array(64), level: 0 }]);
    const { operation, stream } = await open(bytes, 1024 * 1024);
    try {
      await stream.read("a.bin");
      await expect(stream.read("a.bin")).rejects.toMatchObject({ code: "archive-invalid" });
    } finally {
      await stream.close();
      operation.dispose();
    }
  });

  it("fails up front when the largest entry cannot fit beside the retained compressed input", async () => {
    const bytes = await rawZip([{ name: "big.bin", data: new Uint8Array(50_000), level: 0 }]);
    const operation = new ImportOperation({ timeoutMs: 60_000 });
    const ledger = new WorkingSetLedger(bytes.length + 1_000);
    ledger.retain(bytes.length, "compressed archive");
    try {
      await expect(openArchiveStream(bytes, { operation, ledger, policy: POLICY })).rejects.toMatchObject({
        code: "archive-working-set",
      });
    } finally {
      operation.dispose();
    }
  });
});
