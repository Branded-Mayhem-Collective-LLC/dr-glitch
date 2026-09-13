import { sanitizeSvg } from "../../src/io/svg-sanitizer";
import { describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import {
  ASSET_GC_GRACE_MS,
  AssetRepository,
  collectAllAssetRoots,
  collectEnvelopeAssetRefs,
} from "../../src/storage/asset-repository";
import { sha256Hex, sha256HexFallback } from "../../src/storage/sha256";
import { NotFoundError } from "../../src/storage/errors";
import type { StagingMetaRow } from "../../src/storage/schema";
import type { StorageBackend } from "../../src/storage/backend";
import { makeEnvelope, makeLayer, makeRecovery, makeSnapshot } from "./storage-fixtures.test";
import { makeDecodablePng, referenceRasterDecoder } from "./helpers/raster-fixtures";

const encoder = new TextEncoder();

const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256", () => {
  it("matches known vectors via the runtime path", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(SHA_EMPTY);
    expect(await sha256Hex(encoder.encode("abc"))).toBe(SHA_ABC);
  });

  it("matches known vectors via the pure-JS fallback", () => {
    expect(sha256HexFallback(new Uint8Array(0))).toBe(SHA_EMPTY);
    expect(sha256HexFallback(encoder.encode("abc"))).toBe(SHA_ABC);
    // Multi-block message (>64 bytes of padding pressure).
    expect(
      sha256HexFallback(
        encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("fallback agrees with WebCrypto on arbitrary bytes", async () => {
    const bytes = new Uint8Array(300).map((_, i) => (i * 31 + 7) % 256);
    expect(sha256HexFallback(bytes)).toBe(await sha256Hex(bytes));
  });
});

describe("AssetRepository", () => {
  it("stores blobs content-addressed and dedupes identical bytes", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend, { now: () => 42 });
    const bytes = encoder.encode("abc");
    const record = await repo.putBlob(bytes, "raster", "image/png", { width: 3, height: 1 });
    expect(record).toEqual({
      sha256: SHA_ABC,
      kind: "raster",
      mime: "image/png",
      byteLength: 3,
      width: 3,
      height: 1,
      createdAt: 42,
    });

    // Second put of the same content: same record, no duplicate row.
    const again = await repo.putBlob(new Blob([bytes]), "raster", "image/png", {
      width: 3,
      height: 1,
    });
    expect(again.sha256).toBe(SHA_ABC);
    expect((await backend.getAllKeys("assets")).length).toBe(1);

    const blob = await repo.getBlob(SHA_ABC);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("routes thumbnails to the thumbnails store", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const record = await repo.putBlob(encoder.encode("thumb"), "thumbnail", "image/png", {
      width: 64,
      height: 64,
    });
    expect(await backend.getAllKeys("thumbnails")).toEqual([record.sha256]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
    expect(await repo.has(record.sha256, "thumbnail")).toBe(true);
    expect(await repo.has(record.sha256, "raster")).toBe(false);
  });

  it("binds export metadata and body to one immutable row snapshot", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const original = encoder.encode("original-body");
    const record = await repo.putBlob(original, "raster", "image/png", {
      width: 13,
      height: 1,
    });
    const snapshot = await repo.openExportSnapshot(record.sha256, "raster");
    expect(snapshot?.record).toMatchObject({ mime: "image/png", byteLength: original.length });

    // Replace the live row after capture with same-length, different metadata
    // and bytes. The snapshot must still expose the original bound body.
    const replacement = encoder.encode("replacement!!");
    expect(replacement.length).toBe(original.length);
    await backend.put("assets", record.sha256, {
      record: { ...record, mime: "image/webp" },
      blob: new Blob([replacement]),
    });
    await expect(snapshot!.readBytes()).resolves.toEqual(original);
    await expect(snapshot!.readBytes()).rejects.toThrow("already consumed");
  });

  it("refuses a pre-aborted export snapshot read before body materialization", async () => {
    const repo = new AssetRepository(new MemoryBackend());
    const record = await repo.putBlob(encoder.encode("bounded"), "raster", "image/png", {
      width: 7,
      height: 1,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      repo.openExportSnapshot(record.sha256, "raster", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("settles an export snapshot lookup when its backend read stalls", async () => {
    const inner = new MemoryBackend();
    const backend: StorageBackend = {
      get: async (store, key) =>
        store === "assets" ? new Promise<never>(() => undefined) : inner.get(store, key),
      put: (store, key, value) => inner.put(store, key, value),
      delete: (store, key) => inner.delete(store, key),
      getAll: (store) => inner.getAll(store),
      getAllKeys: (store) => inner.getAllKeys(store),
      transaction: (stores, work) => inner.transaction(stores, work),
      close: () => inner.close(),
    };
    const repo = new AssetRepository(backend);
    const controller = new AbortController();
    const pending = repo.openExportSnapshot("a".repeat(64), "raster", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a stalled Blob stream and rejects the one-shot body read", async () => {
    const inner = new MemoryBackend();
    const sha = "b".repeat(64);
    let streamCancels = 0;
    class StalledBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          cancel() {
            streamCancels += 1;
          },
        });
      }
    }
    const row = {
      record: {
        sha256: sha,
        kind: "raster" as const,
        mime: "image/png",
        byteLength: 8,
        width: 1,
        height: 1,
        createdAt: 1,
      },
      blob: new StalledBlob([new Uint8Array(8)]),
    };
    const backend: StorageBackend = {
      get: async <T,>(store: Parameters<StorageBackend["get"]>[0]) =>
        (store === "assets" ? row : await inner.get(store, sha)) as T,
      put: (store, key, value) => inner.put(store, key, value),
      delete: (store, key) => inner.delete(store, key),
      getAll: (store) => inner.getAll(store),
      getAllKeys: (store) => inner.getAllKeys(store),
      transaction: (stores, work) => inner.transaction(stores, work),
      close: () => inner.close(),
    };
    const repo = new AssetRepository(backend);
    const snapshot = await repo.openExportSnapshot(sha, "raster");
    const controller = new AbortController();
    const pending = snapshot!.readBytes(controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(streamCancels).toBe(1);
    await expect(snapshot!.readBytes()).rejects.toThrow("already consumed");
  });

  it("throws NotFoundError for missing blobs", async () => {
    const repo = new AssetRepository(new MemoryBackend());
    await expect(repo.getBlob("f".repeat(64))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("collects envelope refs across layers, custom dots, and snapshots", () => {
    const base = makeEnvelope();
    const dottedLayer = makeLayer({ assetId: "2".repeat(64) });
    dottedLayer.recipe.halftone.customShapeAssetId = "3".repeat(64);
    const envelope = makeEnvelope({
      core: {
        ...base.core,
        layers: [makeLayer({ assetId: "1".repeat(64) }), dottedLayer],
        registration: { ...base.core.registration, customShapeAssetId: "4".repeat(64) },
      },
      snapshots: [
        makeSnapshot({
          thumbnailId: "5".repeat(64),
          core: { ...base.core, layers: [makeLayer({ assetId: "6".repeat(64) })] },
        }),
      ],
    });
    const refs = collectEnvelopeAssetRefs(envelope);
    expect([...refs].sort()).toEqual(
      ["1", "2", "3", "4", "5", "6"].map((c) => c.repeat(64)).sort(),
    );
  });

  it("GC retains roots from projects, trash, recovery, snapshots, staging and collects orphans", async () => {
    const backend = new MemoryBackend();
    let nowMs = 0;
    const repo = new AssetRepository(backend, { now: () => nowMs });

    const put = async (text: string, kind: "raster" | "thumbnail" = "raster") =>
      (await repo.putBlob(encoder.encode(text), kind, "image/png", { width: 1, height: 1 }))
        .sha256;

    const liveSha = await put("live-layer");
    const trashSha = await put("trashed-layer");
    const recoverySha = await put("recovery-layer");
    const snapshotThumbSha = await put("snapshot-thumb", "thumbnail");
    const stagingRefSha = await put("staged-ref");
    const orphanSha = await put("orphan");
    const orphanThumbSha = await put("orphan-thumb", "thumbnail");

    // Live project referencing liveSha, with a snapshot thumbnail.
    const live = makeEnvelope({
      core: { ...makeEnvelope().core, layers: [makeLayer({ assetId: liveSha })] },
      snapshots: [makeSnapshot({ thumbnailId: snapshotThumbSha })],
    });
    await backend.put("projects", live.id, live);

    // Trashed project (envelope stays in projects store + trash record).
    const trashed = makeEnvelope({
      core: { ...makeEnvelope().core, layers: [makeLayer({ assetId: trashSha })] },
    });
    await backend.put("projects", trashed.id, trashed);
    await backend.put("trash", trashed.id, {
      projectId: trashed.id,
      deletedAt: 0,
      expiresAt: 1,
      title: trashed.title,
    });

    // Recovery record referencing recoverySha.
    const recovery = makeRecovery({
      core: { ...makeEnvelope().core, layers: [makeLayer({ assetId: recoverySha })] },
    });
    await backend.put("recovery", recovery.projectId, recovery);

    // Staging area whose candidate references a live asset.
    const meta: StagingMetaRow = {
      type: "meta",
      stagingId: "staging-1",
      createdAt: 0,
      envelope: makeEnvelope({
        core: { ...makeEnvelope().core, layers: [makeLayer({ assetId: stagingRefSha })] },
      }),
      assetShas: [],
    };
    await backend.put("staging", meta.stagingId, meta);

    const roots = await collectAllAssetRoots(backend);
    for (const sha of [liveSha, trashSha, recoverySha, snapshotThumbSha, stagingRefSha]) {
      expect(roots.has(sha)).toBe(true);
    }

    // Everything was written at t=0; run GC past the grace window so the
    // orphans are old enough to sweep.
    nowMs = ASSET_GC_GRACE_MS + 1;
    const result = await repo.garbageCollect();
    expect(result.removedAssets).toEqual([orphanSha]);
    expect(result.removedThumbnails).toEqual([orphanThumbSha]);
    expect(result.retainedRecent).toEqual([]);

    // Referenced assets are never collected.
    for (const sha of [liveSha, trashSha, recoverySha, stagingRefSha]) {
      expect(await repo.has(sha)).toBe(true);
    }
    expect(await repo.has(snapshotThumbSha, "thumbnail")).toBe(true);
    expect(await repo.has(orphanSha)).toBe(false);
    expect(await repo.has(orphanThumbSha, "thumbnail")).toBe(false);
  });

  it("retains extraRoots (session in-memory references) that no durable row carries", async () => {
    const backend = new MemoryBackend();
    let nowMs = 0;
    const repo = new AssetRepository(backend, { now: () => nowMs });
    const keep = await repo.putBlob(encoder.encode("keep"), "raster", "image/png", {
      width: 1,
      height: 1,
    });
    await repo.putBlob(encoder.encode("drop"), "raster", "image/png", { width: 1, height: 1 });
    nowMs = ASSET_GC_GRACE_MS + 1;
    const result = await repo.garbageCollect({ extraRoots: [keep.sha256] });
    expect(result.removedAssets.length).toBe(1);
    expect(await repo.has(keep.sha256)).toBe(true);
  });
});

describe("AssetRepository with a configured full-decode adapter", () => {
  function repoWithDecoder(backend = new MemoryBackend()) {
    return { backend, repo: new AssetRepository(backend, { rasterDecoder: referenceRasterDecoder }) };
  }

  it("verifyAsset accepts a fully decodable raster and returns its row", async () => {
    const { repo } = repoWithDecoder();
    const bytes = makeDecodablePng(8, 8, { seed: "at-rest-ok" });
    const record = await repo.putBlob(bytes, "raster", "image/png", { width: 8, height: 8 });
    await expect(repo.verifyAsset(record.sha256)).resolves.toBeDefined();
  });

  it("decode snapshots hash/header-check one bound Blob without invoking the configured decoder", async () => {
    const backend = new MemoryBackend();
    const decoder = {
      decode: vi.fn(referenceRasterDecoder.decode.bind(referenceRasterDecoder)),
    };
    const repo = new AssetRepository(backend, { rasterDecoder: decoder });
    const bytes = makeDecodablePng(8, 8, { seed: "decode-candidate" });
    const record = await repo.putBlob(bytes, "raster", "image/png", { width: 8, height: 8 });
    decoder.decode.mockClear();

    const candidate = await repo.openRasterDecodeSnapshot(record.sha256);
    // Replace the live row after capture. Verification and the returned Blob
    // must stay bound to the original row, never pair split reads.
    await backend.put("assets", record.sha256, {
      record,
      blob: new Blob([new Uint8Array(bytes.byteLength).fill(9)], { type: "image/png" }),
    });
    const blob = await candidate.verify();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(decoder.decode).not.toHaveBeenCalled();
    await expect(candidate.verify()).rejects.toThrow(/already consumed/);
  });

  it("decode snapshots reject a same-key poisoned body before native decode", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend, { rasterDecoder: referenceRasterDecoder });
    const bytes = makeDecodablePng(8, 8, { seed: "decode-poison" });
    const sha = await sha256Hex(bytes);
    const poisoned = bytes.slice();
    poisoned[poisoned.length - 1] ^= 0xff;
    await backend.put("assets", sha, {
      record: {
        sha256: sha, kind: "raster", mime: "image/png",
        byteLength: poisoned.byteLength, width: 8, height: 8, createdAt: 1,
      },
      blob: new Blob([poisoned], { type: "image/png" }),
    });
    const candidate = await repo.openRasterDecodeSnapshot(sha);
    await expect(candidate.verify()).rejects.toMatchObject({
      name: "AssetIntegrityError",
      integrity: "asset-hash-mismatch",
    });
  });

  it("decode snapshot verification cooperatively aborts a stalled Blob read", async () => {
    const inner = new MemoryBackend();
    const bytes = makeDecodablePng(2, 2, { seed: "stalled-decode" });
    const sha = await sha256Hex(bytes);
    let cancels = 0;
    class StalledRasterBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          cancel() { cancels += 1; },
        });
      }
    }
    const row = {
      record: {
        sha256: sha, kind: "raster" as const, mime: "image/png",
        byteLength: bytes.byteLength, width: 2, height: 2, createdAt: 1,
      },
      blob: new StalledRasterBlob([bytes], { type: "image/png" }),
    };
    const backend: StorageBackend = {
      get: async <T,>(store: Parameters<StorageBackend["get"]>[0]) =>
        (store === "assets" ? row : await inner.get(store, sha)) as T,
      put: (store, key, value) => inner.put(store, key, value),
      delete: (store, key) => inner.delete(store, key),
      getAll: (store) => inner.getAll(store),
      getAllKeys: (store) => inner.getAllKeys(store),
      transaction: (stores, work) => inner.transaction(stores, work),
      close: () => inner.close(),
    };
    const repo = new AssetRepository(backend);
    const candidate = await repo.openRasterDecodeSnapshot(sha);
    const controller = new AbortController();
    const pending = candidate.verify(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancels).toBe(1);
  });

  it("verifyAsset rejects a CORRECT-HASH undecodable payload at rest (typed asset-decode-failed)", async () => {
    const { backend, repo } = repoWithDecoder();
    // Header-valid, hash-consistent, payload-broken: only decode strength
    // catches it. Seed the row directly — putBlob would refuse these bytes.
    const bad = makeDecodablePng(8, 8, { seed: "at-rest-bad", truncateIdat: true });
    const sha = await sha256Hex(bad);
    await backend.put("assets", sha, {
      record: {
        sha256: sha, kind: "raster", mime: "image/png",
        byteLength: bad.byteLength, width: 8, height: 8, createdAt: 1,
      },
      blob: new Blob([bad]),
    });
    await expect(repo.verifyAsset(sha)).rejects.toMatchObject({
      name: "AssetIntegrityError",
      integrity: "asset-decode-failed",
    });
  });

  it("putBlob refuses undecodable raster bytes before anything persists", async () => {
    const { backend, repo } = repoWithDecoder();
    const bad = makeDecodablePng(8, 8, { seed: "put-bad", corruptIdat: true });
    await expect(repo.putBlob(bad, "raster", "image/png", { width: 8, height: 8 })).rejects.toMatchObject({
      name: "RasterValidationError",
      code: "raster-decode-failed",
    });
    expect(await backend.getAllKeys("assets")).toEqual([]);
  });

  it("putBlob refuses raster bytes whose decode disagrees with the declared dimensions", async () => {
    const { backend, repo } = repoWithDecoder();
    const bytes = makeDecodablePng(8, 8, { seed: "put-dims" });
    await expect(repo.putBlob(bytes, "raster", "image/png", { width: 8, height: 9 })).rejects.toMatchObject({
      code: "raster-decode-dimensions",
    });
    expect(await backend.getAllKeys("assets")).toEqual([]);
  });

  it("without a decoder, verifyAsset still passes header+hash but never claims decode strength", async () => {
    // The undecoder-less repository is the node/test default; the same
    // truncated payload passes header+hash checks (documented limitation —
    // browser sessions always configure the real decoder).
    const backend = new MemoryBackend();
    const weak = new AssetRepository(backend);
    const bad = makeDecodablePng(8, 8, { seed: "weak", truncateIdat: true });
    const sha = await sha256Hex(bad);
    await backend.put("assets", sha, {
      record: {
        sha256: sha, kind: "raster", mime: "image/png",
        byteLength: bad.byteLength, width: 8, height: 8, createdAt: 1,
      },
      blob: new Blob([bad]),
    });
    await expect(weak.verifyAsset(sha)).resolves.toBeDefined();
  });
});


describe("canonical SVG artwork decode snapshots", () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" viewBox="0 0 80 60"><rect width="80" height="60" fill="#000000"/></svg>';
  it("accepts a canonical SVG from one immutable row and preserves the raster-only gate", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const bytes = encoder.encode(sanitizeSvg(source, "artwork").svg);
    const record = await repo.putBlob(bytes, "svg", "image/svg+xml", { width: 80, height: 60 });
    const snapshot = await repo.openArtworkDecodeSnapshot(record.sha256);
    await backend.put("assets", record.sha256, { record, blob: new Blob([new Uint8Array(bytes.length)]) });
    expect(new Uint8Array(await (await snapshot.verify()).arrayBuffer())).toEqual(bytes);
    await expect(repo.openRasterDecodeSnapshot(record.sha256)).rejects.toMatchObject({ code: "asset-kind-mismatch" });
  });
  it("rejects correct-hash unsafe SVG before native decoding", async () => {
    const repo = new AssetRepository(new MemoryBackend());
    const bytes = encoder.encode(source.replace("<rect", '<script>alert(1)</script><rect'));
    const record = await repo.putBlob(bytes, "svg", "image/svg+xml", { width: 80, height: 60 });
    const snapshot = await repo.openArtworkDecodeSnapshot(record.sha256);
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "asset-kind-mismatch" });
  });
  it("leaves full archive decode to the packager after its allocation gate", async () => {
    const decoder = { decode: vi.fn(referenceRasterDecoder.decode) };
    const repo = new AssetRepository(new MemoryBackend(), { rasterDecoder: decoder });
    const bytes = makeDecodablePng(8, 8);
    const record = await repo.putBlob(bytes, "raster", "image/png", { width: 8, height: 8 });
    decoder.decode.mockClear();
    const snapshot = await repo.openExportSnapshot(record.sha256);
    expect(await snapshot!.readBytes()).toEqual(bytes);
    expect(decoder.decode).not.toHaveBeenCalled();
  });
});
