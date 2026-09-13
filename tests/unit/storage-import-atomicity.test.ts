import { describe, expect, it } from "vitest";
import { StorageStagingSink } from "../../src/storage/import-sink";
import { MemoryBackend } from "../../src/storage/memory-backend";
import type { BackendTransaction } from "../../src/storage/backend";
import type { StoreName } from "../../src/storage/schema";
import { createEmptyProject, createLayerFromAsset } from "../../src/project/factory";
import { exportDrglitch, importDrglitch } from "../../src/io/drglitch";
import { sha256Hex } from "../../src/io/sha256";
import { makeDecodablePng, referenceRasterDecoder } from "./helpers/raster-fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Pause an actual transaction after a mutation, then attempt a late write. */
class PausedBackend extends MemoryBackend {
  readonly entered = deferred();
  readonly resume = deferred();
  readonly continued = deferred();
  pause: "allocate" | "write" | "commit" | null = null;

  override transaction(stores: StoreName[], work: (tx: BackendTransaction) => Promise<void>, signal?: AbortSignal) {
    return super.transaction(stores, async (tx) => work({
      ...tx,
      put: async <T>(store: StoreName, key: string, value: T) => {
        await tx.put(store, key, value);
        const type = (value as { type?: string }).type;
        if ((this.pause === "allocate" && store === "staging" && type === "meta") ||
            (this.pause === "write" && store === "staging" && type === "asset") ||
            (this.pause === "commit" && store === "projects")) {
          this.pause = null;
          this.entered.resolve();
          await this.resume.promise;
          try { await tx.put(store, key, value); }
          finally { this.continued.resolve(); }
        }
      },
    }), signal);
  }
}

async function fixture() {
  const bytes = makeDecodablePng(8, 8, { seed: "atomic-import" });
  const sha256 = await sha256Hex(bytes);
  const record = {
    sha256, kind: "raster" as const, mime: "image/png", byteLength: bytes.length,
    width: 8, height: 8, createdAt: 1,
  };
  const envelope = createEmptyProject();
  envelope.core.layers.push(createLayerFromAsset(sha256, "Artwork", { width: 8, height: 8 }, envelope.core.artboard));
  return { bytes, record, envelope };
}

describe("atomic import lifecycle", () => {
  it.each(["allocate", "write", "commit"] as const)("abort interrupts %s and late work cannot install or resurrect staging", async (phase) => {
    const { record, bytes, envelope } = await fixture();
    const backend = new PausedBackend();
    const sink = new StorageStagingSink(backend);
    if (phase !== "allocate") await sink.allocate();
    if (phase === "commit") await sink.write(record, bytes);
    backend.pause = phase;
    const run = phase === "allocate" ? sink.allocate() :
      phase === "write" ? sink.write(record, bytes) : sink.commit(envelope);
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await backend.entered.promise;
    await sink.abort("cancel");
    await rejected;
    for (const store of ["staging", "projects", "assets", "thumbnails"] as const) {
      expect(await backend.getAllKeys(store)).toEqual([]);
    }
    backend.resume.resolve();
    await backend.continued.promise;
    expect(sink.installed).toBeNull();
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("a completed commit stays successful after cancel", async () => {
    const { record, bytes, envelope } = await fixture();
    const backend = new MemoryBackend();
    const sink = new StorageStagingSink(backend);
    await sink.allocate();
    await sink.write(record, bytes);
    await sink.commit(envelope);
    await sink.abort("late cancellation");
    expect(sink.installed?.id).toBe(envelope.id);
    expect(await backend.getAllKeys("projects")).toEqual([envelope.id]);
    expect(await backend.getAllKeys("assets")).toEqual([record.sha256]);
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("retries failed abort cleanup using the original staging handle", async () => {
    class RetryBackend extends MemoryBackend {
      failCleanup = false;
      override transaction(stores: StoreName[], work: (tx: BackendTransaction) => Promise<void>, signal?: AbortSignal) {
        if (this.failCleanup) {
          this.failCleanup = false;
          return Promise.reject(new Error("temporary cleanup failure"));
        }
        return super.transaction(stores, work, signal);
      }
    }
    const backend = new RetryBackend();
    const sink = new StorageStagingSink(backend);
    await sink.allocate();
    backend.failCleanup = true;
    await expect(sink.abort("cancel")).rejects.toThrow("temporary cleanup failure");
    expect((await backend.getAllKeys("staging")).length).toBe(1);
    await sink.abort("retry");
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("round-trips the same PNG as both a layer asset and a snapshot thumbnail", async () => {
    const { record, bytes, envelope } = await fixture();
    envelope.snapshots = [{ id: "snapshot", name: "Checkpoint", createdAt: 1,
      thumbnailId: record.sha256, core: structuredClone(envelope.core) }];
    const archive = await exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "test",
      getAsset: () => ({ bytes, ext: "png" }), getThumbnail: () => bytes });
    const backend = new MemoryBackend();
    const sink = new StorageStagingSink(backend);
    const imported = await importDrglitch(archive, { sink, decoder: referenceRasterDecoder });
    expect(imported.core.layers[0].assetId).toBe(record.sha256);
    expect(imported.snapshots[0].thumbnailId).toBe(record.sha256);
    expect(await backend.getAllKeys("assets")).toEqual([record.sha256]);
    expect(await backend.getAllKeys("thumbnails")).toEqual([record.sha256]);
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });
});
