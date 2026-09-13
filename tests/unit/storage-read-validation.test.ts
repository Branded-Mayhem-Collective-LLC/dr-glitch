/**
 * At-rest corruption threat model: rows written through the raw backend
 * (simulating disk damage or a hostile/buggy same-origin writer) must never
 * reach application state. Covers repository read validation (projects,
 * trash, recovery, presets, assets), verified asset reads (hash + content
 * agreement, including same-length poison), write-path repair, recovery
 * base binding, and import staging atomicity (failed-commit cleanup and
 * poisoned same-SHA repair).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import { ProjectRepository } from "../../src/storage/project-repository";
import { PresetRepository } from "../../src/storage/preset-repository";
import { RecoveryJournal } from "../../src/storage/recovery";
import { AssetRepository } from "../../src/storage/asset-repository";
import { ImportStaging } from "../../src/storage/staging";
import { StorageStagingSink } from "../../src/storage/import-sink";
import { CorruptRecordError, NotFoundError } from "../../src/storage/errors";
import { sha256Hex } from "../../src/storage/sha256";
import type { StoredAssetRow } from "../../src/storage/schema";
import type { AssetRecordV1, RecipePresetV1 } from "../../src/core/types";
import { makeEnvelope, makeRecovery } from "./storage-fixtures.test";
import { makePng } from "./io-raster-validator.test";
import { sanitizeSvg } from "../../src/io/svg-sanitizer";

const encoder = new TextEncoder();

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

function makePreset(id: string): RecipePresetV1 {
  return {
    schema: 1,
    id,
    name: "Stored",
    createdAt: 5,
    mode: "halftone",
    halftone: {
      cellSize: 12,
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
      modStrength: 0,
      intensity: 1,
      levels: 2,
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
      sliceSize: 0,
      verticalSliceShift: 0,
      verticalSliceSize: 0,
      gridWarp: 0,
      warpScale: 0,
      smearDrag: 0,
      smearLength: 0,
      smearVertical: false,
      macroblockCorrupt: 0,
      macroblockDropout: 0,
      blockShift: 0,
      blockShiftSize: 0,
      channelDesync: 0,
      bitmapSort: 0,
      bitmapSortVertical: false,
    },
    customDotSvg: null,
  };
}

describe("project repository read validation", () => {
  it("skips corrupt project rows in list() with a warning instead of crashing", async () => {
    const backend = new MemoryBackend();
    const repo = new ProjectRepository(backend, { now: () => 10 });
    const good = makeEnvelope({ title: "Good" });
    await backend.put("projects", good.id, good);
    await backend.put("projects", "corrupt-1", { schema: 1, id: "corrupt-1", garbage: true });
    await backend.put("projects", "corrupt-2", "not even an object");

    const list = await repo.list();
    expect(list.map((entry) => entry.id)).toEqual([good.id]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("load() throws typed CorruptRecordError for a damaged envelope", async () => {
    const backend = new MemoryBackend();
    const repo = new ProjectRepository(backend);
    const bad = makeEnvelope();
    await backend.put("projects", bad.id, {
      ...bad,
      core: { ...bad.core, artboard: { ...bad.core.artboard, widthPx: -5 } },
    });
    await expect(repo.load(bad.id)).rejects.toBeInstanceOf(CorruptRecordError);
    // Missing stays NotFound, not corrupt.
    await expect(repo.load("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a stored envelope whose id does not match its key", async () => {
    const backend = new MemoryBackend();
    const repo = new ProjectRepository(backend);
    const envelope = makeEnvelope();
    await backend.put("projects", "other-key", envelope);
    await expect(repo.load("other-key")).rejects.toBeInstanceOf(CorruptRecordError);
  });

  it("skips corrupt trash rows in listTrash() and never destroys project data for them", async () => {
    const backend = new MemoryBackend();
    const repo = new ProjectRepository(backend, { now: () => 1_000 });
    const envelope = makeEnvelope();
    await backend.put("projects", envelope.id, envelope);
    await backend.put("trash", envelope.id, { projectId: envelope.id, deletedAt: "soon" });

    expect(await repo.listTrash()).toEqual([]);
    // Sweep drops ONLY the corrupt trash marker; the envelope survives.
    await repo.sweepExpiredTrash();
    expect(await backend.get("trash", envelope.id)).toBeUndefined();
    expect(await backend.get("projects", envelope.id)).toBeDefined();
  });
});

describe("preset repository read validation", () => {
  it("skips corrupt preset rows in list() and re-sanitizes on read", async () => {
    const backend = new MemoryBackend();
    const repo = new PresetRepository(backend);
    const good = makePreset("good");
    await backend.put("presets", good.id, good);
    await backend.put("presets", "bad-shape", { schema: 1, id: "bad-shape" });
    // Poisoned at rest: script SVG smuggled into a stored row.
    await backend.put("presets", "poisoned", {
      ...makePreset("poisoned"),
      halftone: { ...makePreset("poisoned").halftone, dotShape: "custom" },
      customDotSvg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>1</script><rect width="1" height="1"/></svg>',
    });

    const list = await repo.list();
    expect(list.map((preset) => preset.id)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalled();
    await expect(repo.load("poisoned")).rejects.toBeInstanceOf(CorruptRecordError);
    await expect(repo.load("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("preserves stored identity (id/createdAt) for valid rows", async () => {
    const backend = new MemoryBackend();
    const repo = new PresetRepository(backend);
    const preset = makePreset("keep-me");
    await repo.save(preset);
    const loaded = await repo.load("keep-me");
    expect(loaded.id).toBe("keep-me");
    expect(loaded.createdAt).toBe(5);
    expect(loaded.halftone).toEqual(preset.halftone);
  });
});

describe("recovery journal read validation and base binding", () => {
  it("discards a corrupt recovery record with a warning and clears the row", async () => {
    const backend = new MemoryBackend();
    const journal = new RecoveryJournal(backend);
    await backend.put("recovery", "p1", { projectId: "p1", core: "garbage" });
    expect(await journal.loadNewer("p1", 1)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(await backend.get("recovery", "p1")).toBeUndefined();
  });

  it("same-base newer recovery restores (normal crash path)", async () => {
    const backend = new MemoryBackend();
    const journal = new RecoveryJournal(backend);
    const record = makeRecovery({ projectId: "p2", savedRevision: 3, revision: 5 });
    await backend.put("recovery", "p2", record);
    expect(await journal.loadNewer("p2", 3)).toMatchObject({ revision: 5, savedRevision: 3 });
  });

  it("REJECTS a stale old-base record even when its revision is numerically huge", async () => {
    const backend = new MemoryBackend();
    const journal = new RecoveryJournal(backend);
    // Journal recorded against base 3 with many edits; a rename/save later
    // bumped the canonical base to 4. Numerically 900 > 4, but the base
    // differs — restoring it would clobber newer canonical state.
    const record = makeRecovery({ projectId: "p3", savedRevision: 3, revision: 900 });
    await backend.put("recovery", "p3", record);
    expect(await journal.loadNewer("p3", 4)).toBeNull();
    // Stale records are discarded on load, never kept around.
    expect(await backend.get("recovery", "p3")).toBeUndefined();
  });

  it("load() returns the validated record for journal-only hydration", async () => {
    const backend = new MemoryBackend();
    const journal = new RecoveryJournal(backend);
    const record = makeRecovery({ projectId: "p4", savedRevision: 0, revision: 2, title: "Sample" });
    await backend.put("recovery", "p4", record);
    const loaded = await journal.load("p4");
    expect(loaded).toMatchObject({ projectId: "p4", title: "Sample" });
  });
});

describe("asset verified reads and write-path repair", () => {
  async function seedPng(repo: AssetRepository, width = 8, height = 8) {
    const bytes = makePng(width, height);
    const record = await repo.putBlob(bytes, "raster", "image/png", { width, height });
    return { bytes, record };
  }

  it("structural validation: blob/byteLength mismatch is a CorruptRecordError", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const { record } = await seedPng(repo);
    const row = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    await backend.put("assets", record.sha256, {
      record: row.record,
      blob: new Blob([new Uint8Array(3)]),
    });
    await expect(repo.getBlob(record.sha256)).rejects.toBeInstanceOf(CorruptRecordError);
    expect(await repo.has(record.sha256)).toBe(false);
  });

  it("same-length POISON bytes pass structural checks but fail the verified read", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const { bytes, record } = await seedPng(repo);
    // First verified read succeeds.
    await repo.verifyAsset(record.sha256, "raster");
    // Swap in same-length wrong bytes directly in the backing store.
    const poison = makePng(8, 8);
    poison[poison.length - 1] ^= 0xff; // corrupt CRC byte: same length, new hash
    expect(poison.length).toBe(bytes.length);
    const row = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    await backend.put("assets", record.sha256, { record: row.record, blob: new Blob([new Uint8Array(poison)]) });

    // Structural read still passes (length matches)…
    await expect(repo.getBlob(record.sha256)).resolves.toBeInstanceOf(Blob);
    // …but the NEXT verified read detects the swap (no stale trust cache).
    await expect(repo.verifyAsset(record.sha256, "raster")).rejects.toMatchObject({
      integrity: "asset-hash-mismatch",
    });
  });

  it("granular integrity codes: missing blob, kind mismatch, dimension mismatch", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const { bytes, record } = await seedPng(repo, 8, 8);

    await backend.put("assets", record.sha256, { record });
    await expect(repo.verifyAsset(record.sha256)).rejects.toMatchObject({
      integrity: "asset-missing-blob",
    });

    // Non-PNG bytes under an image/png record: kind/content mismatch.
    const text = encoder.encode("plain text pretending to be a png");
    const textSha = await sha256Hex(text);
    const fakeRecord: AssetRecordV1 = {
      sha256: textSha,
      kind: "raster",
      mime: "image/png",
      byteLength: text.byteLength,
      width: 8,
      height: 8,
      createdAt: 1,
    };
    await backend.put("assets", textSha, { record: fakeRecord, blob: new Blob([text]) });
    await expect(repo.verifyAsset(textSha)).rejects.toMatchObject({
      integrity: "asset-kind-mismatch",
    });

    // Header dimensions disagree with the record metadata.
    const wrongDims: AssetRecordV1 = {
      sha256: record.sha256,
      kind: "raster",
      mime: "image/png",
      byteLength: bytes.byteLength,
      width: 999,
      height: 999,
      createdAt: 1,
    };
    await backend.put("assets", record.sha256, { record: wrongDims, blob: new Blob([bytes.slice()]) });
    await expect(repo.verifyAsset(record.sha256)).rejects.toMatchObject({
      integrity: "asset-dimensions-mismatch",
    });
  });

  it("SVG rows: kind/mime coherence is enforced", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    // At-rest SVG must be CANONICAL sanitizer output (the strict at-rest
    // rule); a bare non-canonical string is rejected below.
    const svg = encoder.encode(
      sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', "artwork").svg,
    );
    const record = await repo.putBlob(svg, "svg", "image/svg+xml", { width: 1, height: 1 });
    await expect(repo.verifyAsset(record.sha256, "svg")).resolves.toBeDefined();

    // Non-canonical (but well-formed) SVG at rest fails closed.
    const loose = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">  <rect width="1" height="1" id="x"/></svg>');
    const looseRecord = await repo.putBlob(loose, "svg", "image/svg+xml", { width: 1, height: 1 });
    await expect(repo.verifyAsset(looseRecord.sha256, "svg")).rejects.toMatchObject({
      integrity: "asset-content-invalid",
    });

    // svg mime with raster kind is rejected.
    const row = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    await backend.put("assets", record.sha256, {
      record: { ...row.record, kind: "raster" },
      blob: row.blob,
    });
    await expect(repo.verifyAsset(record.sha256, "svg")).rejects.toMatchObject({
      integrity: "asset-kind-mismatch",
    });
  });

  it("putBlob REPAIRS a poisoned same-SHA row instead of structurally deduping", async () => {
    const backend = new MemoryBackend();
    const repo = new AssetRepository(backend);
    const { bytes, record } = await seedPng(repo);
    const poison = makePng(8, 8);
    poison[poison.length - 1] ^= 0xff;
    const row = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    await backend.put("assets", record.sha256, { record: row.record, blob: new Blob([new Uint8Array(poison)]) });

    await repo.putBlob(bytes, "raster", "image/png", { width: 8, height: 8 });
    const repaired = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    const storedBytes = new Uint8Array(await repaired.blob.arrayBuffer());
    expect(Array.from(storedBytes)).toEqual(Array.from(bytes));
    await expect(repo.verifyAsset(record.sha256)).resolves.toBeDefined();
  });
});

describe("import staging atomicity and same-SHA poison repair", () => {
  function makeStagedPng() {
    const bytes = makePng(8, 8);
    return bytes;
  }

  async function stagedRecord(bytes: Uint8Array): Promise<AssetRecordV1> {
    return {
      sha256: await sha256Hex(bytes),
      kind: "raster",
      mime: "image/png",
      byteLength: bytes.byteLength,
      width: 8,
      height: 8,
      createdAt: 1,
    };
  }

  it("import REPAIRS a poisoned pre-existing same-SHA row (same length, wrong bytes)", async () => {
    const backend = new MemoryBackend();
    const bytes = makeStagedPng();
    const record = await stagedRecord(bytes);
    // Preseed poison under the archive asset's SHA: same length, wrong bytes.
    const poison = bytes.slice();
    poison[poison.length - 1] ^= 0xff;
    await backend.put<StoredAssetRow>("assets", record.sha256, {
      record,
      blob: new Blob([new Uint8Array(poison)]),
    });

    const staging = new ImportStaging(backend, { now: () => 1_000, newId: () => "installed-1" });
    const handle = await staging.begin();
    // begin() consumed the injected id; subsequent ids come from the default.
    await handle.stageAsset(record, new Blob([bytes.slice()]));
    await handle.stageProject(makeEnvelope({ savedRevision: 0 }));
    await handle.commit();

    // FINAL STORED BYTES must be exactly the validated staged asset.
    const stored = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    const storedBytes = new Uint8Array(await stored.blob.arrayBuffer());
    expect(Array.from(storedBytes)).toEqual(Array.from(bytes));
  });

  it("keeps a verified pre-existing same-SHA row (dedupe still works)", async () => {
    const backend = new MemoryBackend();
    const bytes = makeStagedPng();
    const record = await stagedRecord(bytes);
    await backend.put<StoredAssetRow>("assets", record.sha256, {
      record,
      blob: new Blob([bytes.slice()]),
    });

    const staging = new ImportStaging(backend, { now: () => 1_000 });
    const handle = await staging.begin();
    await handle.stageAsset(record, new Blob([bytes.slice()]));
    await handle.stageProject(makeEnvelope({ savedRevision: 0 }));
    await expect(handle.commit()).resolves.toBeDefined();
    const stored = (await backend.get<StoredAssetRow>("assets", record.sha256))!;
    expect(new Uint8Array(await stored.blob.arrayBuffer()).length).toBe(bytes.length);
  });

  it("a REJECTED install transaction leaves the sink abortable: staging store ends empty", async () => {
    const backend = new MemoryBackend();
    // Fail ONLY the install transaction's "projects" write: staging puts
    // (allocate/write/stageProject) succeed, then the atomic install
    // transaction rejects and rolls back — the crash window under test.
    const failing: typeof backend = Object.create(backend);
    failing.transaction = (stores, work) =>
      backend.transaction(stores, async (tx) =>
        work({
          ...tx,
          put: async (store, key, value) => {
            if (store === "projects") {
              const error = new Error("Simulated storage quota exceeded");
              error.name = "QuotaExceededError";
              throw error;
            }
            return tx.put(store, key, value);
          },
        }),
      );

    const sink = new StorageStagingSink(failing);
    await sink.allocate();
    const bytes = makeStagedPng();
    const record = await stagedRecord(bytes);
    await sink.write(record, bytes);

    await expect(sink.commit(makeEnvelope({ savedRevision: 0 }))).rejects.toThrow();
    // The transaction rolled back: no project row, no asset row.
    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
    // Staged rows are still there (nothing silently lost mid-failure)…
    expect((await backend.getAllKeys("staging")).length).toBeGreaterThan(0);

    // …and the failed commit did NOT consume the handle: abort() purges.
    await sink.abort();
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });
});
