import { describe, expect, it } from "vitest";
import { exportDrglitch, importDrglitch } from "../../src/io/drglitch";
import { writeArchive } from "../../src/io/zip-writer";
import { sha256Hex } from "../../src/io/sha256";
import { StorageStagingSink } from "../../src/storage/import-sink";
import { MemoryBackend } from "../../src/storage/memory-backend";
import { ProjectRepository } from "../../src/storage/project-repository";
import { createEmptyProject, createLayerFromAsset } from "../../src/project/factory";
import type { AssetRecordV1 } from "../../src/core/types";
import { makeDecodablePng, referenceRasterDecoder } from "./helpers/raster-fixtures";

/** A tiny valid 1x1 opaque PNG. */
const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function makeSourceProject() {
  const sha = await sha256Hex(PNG_1X1);
  const record: AssetRecordV1 = {
    sha256: sha,
    kind: "raster",
    mime: "image/png",
    byteLength: PNG_1X1.byteLength,
    width: 1,
    height: 1,
    createdAt: 1,
  };
  const envelope = createEmptyProject({ title: "Round trip" });
  envelope.core.layers.push(createLayerFromAsset(sha, "Art", { width: 1, height: 1 }, envelope.core.artboard));
  return { envelope, record };
}

describe("StorageStagingSink (io <-> storage seam)", () => {
  it("installs a .drglitch import atomically with the io-assigned id and savedRevision 0", async () => {
    const { envelope, record } = await makeSourceProject();
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope,
      appVersion: "test",
      getAsset: (sha) => (sha === record.sha256 ? { bytes: PNG_1X1, ext: "png" } : null),
      getThumbnail: () => null,
    });

    const backend = new MemoryBackend();
    const sink = new StorageStagingSink(backend);
    const imported = await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder });

    expect(sink.installed).not.toBeNull();
    expect(sink.installed!.id).toBe(imported.id);
    expect(imported.id).not.toBe(envelope.id);
    expect(sink.installed!.savedRevision).toBe(0);

    const repo = new ProjectRepository(backend);
    const loaded = await repo.load(imported.id);
    expect(loaded.title).toBe("Round trip");
    expect(loaded.core.layers).toHaveLength(1);
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("aborts cleanly on a corrupt archive, leaving no live or staged state", async () => {
    const { envelope, record } = await makeSourceProject();
    void record;
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope,
      appVersion: "test",
      getAsset: () => ({ bytes: PNG_1X1, ext: "png" }),
      getThumbnail: () => null,
    });
    // Corrupt one byte inside the stored asset payload to break its hash.
    const corrupt = bytes.slice();
    const marker = new TextEncoder().encode("assets/");
    const index = corrupt.findIndex((_, i) =>
      marker.every((b, j) => corrupt[i + j] === b),
    );
    corrupt[index + 80] ^= 0xff;

    const backend = new MemoryBackend();
    const sink = new StorageStagingSink(backend);
    await expect(importDrglitch(corrupt, { sink, decoder: referenceRasterDecoder })).rejects.toThrow();
    expect(sink.installed).toBeNull();
    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });
});

  it("a full-decode failure aborts exactly once: projects/assets/staging stores unchanged", async () => {
    // Correct-hash, header-valid PNG whose IDAT is truncated: every cheap
    // gate passes and only the payload decode catches it.
    const bad = makeDecodablePng(8, 8, { seed: "sink-decode", truncateIdat: true });
    const sha = await sha256Hex(bad);
    const envelope = createEmptyProject({ title: "Poisoned" });
    envelope.core.layers.push(createLayerFromAsset(sha, "Art", { width: 8, height: 8 }, envelope.core.artboard));
    const bytes = await writeArchive([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify({ format: "drglitch", schema: 1, appVersion: "t" })) },
      { name: "project.json", data: new TextEncoder().encode(JSON.stringify(envelope)) },
      { name: `assets/${sha}.png`, data: bad },
    ]);

    const backend = new MemoryBackend();
    const sink = new StorageStagingSink(backend);
    await expect(importDrglitch(bytes, { sink, decoder: referenceRasterDecoder })).rejects.toMatchObject({
      name: "DrglitchError",
      code: "asset-invalid",
    });
    expect(sink.installed).toBeNull();
    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });
