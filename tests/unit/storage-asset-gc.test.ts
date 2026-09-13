/**
 * Production asset GC: root retention across every root class, grace-window
 * concurrency safety (deterministic scan/sweep interleaving), conservative
 * failure on corrupt root rows, trash-expiry reclamation, dedupe-touch
 * resurrection safety, idempotence, and rollback safety on mid-sweep
 * failure.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import {
  ASSET_GC_GRACE_MS,
  AssetRepository,
  GcRootScanError,
  collectAllAssetRoots,
} from "../../src/storage/asset-repository";
import { ProjectRepository, TRASH_RETENTION_MS } from "../../src/storage/project-repository";
import type { BackendTransaction, StorageBackend } from "../../src/storage/backend";
import type { StoreName, StagingAssetRow, StagingMetaRow } from "../../src/storage/schema";
import { makeEnvelope, makeLayer, makeRecovery, makeSnapshot } from "./storage-fixtures.test";

const encoder = new TextEncoder();
const AFTER_GRACE = ASSET_GC_GRACE_MS + 1_000;

function makeWorld() {
  const backend = new MemoryBackend();
  const clock = { nowMs: 0 };
  const repo = new AssetRepository(backend, { now: () => clock.nowMs });
  const put = async (text: string, kind: "raster" | "thumbnail" | "svg" = "raster") =>
    (
      await repo.putBlob(
        encoder.encode(text),
        kind,
        kind === "svg" ? "image/svg+xml" : "image/png",
        { width: 1, height: 1 },
      )
    ).sha256;
  return { backend, clock, repo, put };
}

describe("asset GC reclamation", () => {
  it("reclaims the orphan when the last durable reference is replaced, then when it is deleted", async () => {
    const { backend, clock, repo, put } = makeWorld();
    const oldSha = await put("artwork-v1");
    const newSha = await put("artwork-v2");
    const base = makeEnvelope();
    const withOld = {
      ...base,
      core: { ...base.core, layers: [makeLayer({ assetId: oldSha })] },
    };
    await backend.put("projects", withOld.id, withOld);

    // Artwork replacement: same project row now references only newSha.
    const withNew = {
      ...withOld,
      core: { ...withOld.core, layers: [makeLayer({ assetId: newSha })] },
    };
    await backend.put("projects", withNew.id, withNew);

    clock.nowMs = AFTER_GRACE;
    const afterReplace = await repo.garbageCollect();
    expect(afterReplace.removedAssets).toEqual([oldSha]);
    expect(await repo.has(newSha)).toBe(true);

    // Permanent deletion of the envelope frees the replacement too.
    await backend.delete("projects", withNew.id);
    const afterDelete = await repo.garbageCollect();
    expect(afterDelete.removedAssets).toEqual([newSha]);
    expect(await repo.has(newSha)).toBe(false);
  });

  it("retains every root class and sweeps only true orphans", async () => {
    const { backend, clock, repo, put } = makeWorld();

    const liveLayer = await put("live-layer");
    const liveCustomDot = await put("live-custom-dot", "svg");
    const liveRegistration = await put("live-registration", "svg");
    const snapCoreRef = await put("snapshot-core-layer");
    const snapThumb = await put("snapshot-thumb", "thumbnail");
    const recoveryRef = await put("recovery-layer");
    const recoveryThumb = await put("recovery-thumb", "thumbnail");
    const trashRef = await put("trash-retained-layer");
    const stagingDeclared = await put("staging-declared");
    const stagingCandidate = await put("staging-candidate-ref");
    const stagedRowSha = await put("staged-asset-row");
    const sessionRef = await put("session-only-ref");
    const orphan = await put("orphan");
    const orphanThumb = await put("orphan-thumb", "thumbnail");

    // Live project: layer asset + halftone custom dot + registration mark
    // in the core, plus a snapshot whose core references its own asset and
    // whose thumbnail lives in the thumbnails store.
    const dotted = makeLayer({ assetId: liveLayer });
    dotted.recipe.halftone.customShapeAssetId = liveCustomDot;
    const base = makeEnvelope();
    const live = {
      ...base,
      core: {
        ...base.core,
        layers: [dotted],
        registration: { ...base.core.registration, customShapeAssetId: liveRegistration },
      },
      snapshots: [
        makeSnapshot({
          thumbnailId: snapThumb,
          core: { ...base.core, layers: [makeLayer({ assetId: snapCoreRef })] },
        }),
      ],
    };
    await backend.put("projects", live.id, live);

    // Trash-retained project: envelope stays in the projects store.
    const trashedBase = makeEnvelope();
    const trashed = {
      ...trashedBase,
      core: { ...trashedBase.core, layers: [makeLayer({ assetId: trashRef })] },
    };
    await backend.put("projects", trashed.id, trashed);
    await backend.put("trash", trashed.id, {
      projectId: trashed.id,
      deletedAt: 0,
      expiresAt: TRASH_RETENTION_MS,
      title: trashed.title,
    });

    // Recovery record: journaled core + snapshot thumbnail.
    const recovery = makeRecovery({
      core: { ...makeEnvelope().core, layers: [makeLayer({ assetId: recoveryRef })] },
      snapshots: [makeSnapshot({ thumbnailId: recoveryThumb })],
    });
    await backend.put("recovery", recovery.projectId, recovery);

    // ACTIVE staging area: declared shas, staged asset row, candidate refs.
    const candidateBase = makeEnvelope();
    const meta: StagingMetaRow = {
      type: "meta",
      stagingId: "staging-1",
      createdAt: 0,
      envelope: {
        ...candidateBase,
        core: { ...candidateBase.core, layers: [makeLayer({ assetId: stagingCandidate })] },
      },
      assetShas: [stagingDeclared],
    };
    await backend.put("staging", meta.stagingId, meta);
    const stagedRow: StagingAssetRow = {
      type: "asset",
      stagingId: "staging-1",
      asset: {
        record: {
          sha256: stagedRowSha,
          kind: "raster",
          mime: "image/png",
          byteLength: encoder.encode("staged-asset-row").byteLength,
          width: 1,
          height: 1,
          createdAt: 0,
        },
        blob: new Blob([encoder.encode("staged-asset-row")]),
      },
    };
    await backend.put("staging", `staging-1:asset:${stagedRowSha}`, stagedRow);

    clock.nowMs = AFTER_GRACE;
    const result = await repo.garbageCollect({ extraRoots: [sessionRef] });
    expect(result.removedAssets.sort()).toEqual([orphan].sort());
    expect(result.removedThumbnails).toEqual([orphanThumb]);

    for (const sha of [
      liveLayer,
      liveCustomDot,
      liveRegistration,
      snapCoreRef,
      recoveryRef,
      trashRef,
      stagingDeclared,
      stagingCandidate,
      stagedRowSha,
      sessionRef,
    ]) {
      expect(await repo.has(sha)).toBe(true);
    }
    expect(await repo.has(snapThumb, "thumbnail")).toBe(true);
    expect(await repo.has(recoveryThumb, "thumbnail")).toBe(true);
    expect(await repo.has(orphan)).toBe(false);
    expect(await repo.has(orphanThumb, "thumbnail")).toBe(false);
  });

  it("reclaims a project's blobs after trash expiry sweeps it (30-day window)", async () => {
    const { backend, clock, repo, put } = makeWorld();
    const sha = await put("trash-bound");
    const projects = new ProjectRepository(backend, { now: () => clock.nowMs });
    const base = makeEnvelope();
    const envelope = { ...base, core: { ...base.core, layers: [makeLayer({ assetId: sha })] } };
    await backend.put("projects", envelope.id, envelope);
    await projects.moveToTrash(envelope.id);

    // Inside the retention window (even long past GC grace): retained.
    clock.nowMs = TRASH_RETENTION_MS - 1;
    expect(await projects.sweepExpiredTrash()).toBe(0);
    expect((await repo.garbageCollect()).removedAssets).toEqual([]);
    expect(await repo.has(sha)).toBe(true);

    // Past expiry: the sweep permanently deletes, then GC reclaims.
    clock.nowMs = TRASH_RETENTION_MS + 1;
    expect(await projects.sweepExpiredTrash()).toBe(1);
    expect((await repo.garbageCollect()).removedAssets).toEqual([sha]);
    expect(await repo.has(sha)).toBe(false);
  });

  it("is idempotent: a second run over the same state removes nothing", async () => {
    const { backend, clock, repo, put } = makeWorld();
    const kept = await put("kept");
    await put("doomed");
    const base = makeEnvelope();
    const envelope = { ...base, core: { ...base.core, layers: [makeLayer({ assetId: kept })] } };
    await backend.put("projects", envelope.id, envelope);
    clock.nowMs = AFTER_GRACE;
    const first = await repo.garbageCollect();
    expect(first.removedAssets.length).toBe(1);
    const second = await repo.garbageCollect();
    expect(second.removedAssets).toEqual([]);
    expect(second.removedThumbnails).toEqual([]);
    expect(await repo.has(kept)).toBe(true);
  });
});

describe("asset GC grace window", () => {
  it("retains unreferenced assets younger than the grace window, sweeps them after it", async () => {
    const { clock, repo, put } = makeWorld();
    clock.nowMs = 500;
    const young = await put("young-orphan");

    clock.nowMs = 1_000; // age 500ms << grace
    const early = await repo.garbageCollect();
    expect(early.removedAssets).toEqual([]);
    expect(early.retainedRecent).toEqual([young]);
    expect(await repo.has(young)).toBe(true);

    clock.nowMs = 500 + AFTER_GRACE;
    const late = await repo.garbageCollect();
    expect(late.removedAssets).toEqual([young]);
    expect(await repo.has(young)).toBe(false);
  });

  it("a dedupe re-put refreshes recency so an old orphan about to be re-referenced survives", async () => {
    const { clock, repo, put } = makeWorld();
    const sha = await put("re-imported"); // createdAt = 0
    clock.nowMs = AFTER_GRACE; // orphan is now old enough to sweep…

    // …but the same bytes were just re-put (dedupe hit in another flow whose
    // durable reference has not landed yet).
    const again = await repo.putBlob(encoder.encode("re-imported"), "raster", "image/png", {
      width: 1,
      height: 1,
    });
    expect(again.sha256).toBe(sha);
    expect(again.createdAt).toBe(0); // dedupe identity preserved

    const result = await repo.garbageCollect();
    expect(result.removedAssets).toEqual([]);
    expect(result.retainedRecent).toEqual([sha]);

    // Still unreferenced a full grace window later: reclaimed.
    clock.nowMs = AFTER_GRACE * 2;
    expect((await repo.garbageCollect()).removedAssets).toEqual([sha]);
  });

  it("dedupe re-put stays a successful no-op under quota pressure (touch is best-effort)", async () => {
    const { backend, clock, repo, put } = makeWorld();
    const sha = await put("quota-dedupe");
    clock.nowMs = 5_000;
    backend.simulateQuotaExceeded = true;
    const record = await repo.putBlob(encoder.encode("quota-dedupe"), "raster", "image/png", {
      width: 1,
      height: 1,
    });
    expect(record.sha256).toBe(sha);
    backend.simulateQuotaExceeded = false;
    expect(await repo.has(sha)).toBe(true);
  });
});

/**
 * Deterministic interleaving harness: pauses the GC transaction exactly
 * between the root scan and the sweep (the first getAllKeys("assets") call
 * is the sweep's opening move), letting the test land a concurrent write in
 * that window the way another tab's bare IndexedDB put would.
 */
class GateBackend implements StorageBackend {
  onBeforeSweep: (() => Promise<void>) | null = null;

  constructor(private readonly inner: MemoryBackend) {}

  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.inner.get(store, key);
  }
  put<T>(store: StoreName, key: string, value: T): Promise<void> {
    return this.inner.put(store, key, value);
  }
  delete(store: StoreName, key: string): Promise<void> {
    return this.inner.delete(store, key);
  }
  getAll<T>(store: StoreName): Promise<T[]> {
    return this.inner.getAll(store);
  }
  getAllKeys(store: StoreName): Promise<string[]> {
    return this.inner.getAllKeys(store);
  }
  close(): void {
    this.inner.close();
  }

  transaction(
    stores: StoreName[],
    work: (tx: BackendTransaction) => Promise<void>,
  ): Promise<void> {
    return this.inner.transaction(stores, async (tx) => {
      const wrapped: BackendTransaction = {
        ...tx,
        getAllKeys: async (store) => {
          if (store === "assets" && this.onBeforeSweep) {
            const hook = this.onBeforeSweep;
            this.onBeforeSweep = null;
            await hook();
          }
          return tx.getAllKeys(store);
        },
      };
      await work(wrapped);
    });
  }
}

describe("asset GC scan/sweep interleaving (deterministic gate)", () => {
  it("a reference inserted between scan and sweep NEVER loses the blob (grace window)", async () => {
    const inner = new MemoryBackend();
    const backend = new GateBackend(inner);
    const clock = { nowMs: 0 };
    const repo = new AssetRepository(backend, { now: () => clock.nowMs });

    // Control: an orphan old enough to sweep — proves the sweep really ran.
    const oldOrphan = (
      await repo.putBlob(encoder.encode("old-orphan"), "raster", "image/png", {
        width: 1,
        height: 1,
      })
    ).sha256;

    // The racer: freshly written bytes whose durable reference is still in
    // flight in "another tab" when the GC scan completes.
    clock.nowMs = AFTER_GRACE;
    const freshBytes = encoder.encode("fresh-blob-about-to-be-referenced");
    const fresh = (
      await repo.putBlob(freshBytes, "raster", "image/png", { width: 1, height: 1 })
    ).sha256;

    let inserted = false;
    backend.onBeforeSweep = async () => {
      // Scan is complete (it did NOT see this reference); sweep has not
      // deleted anything yet. Land the reference now.
      const base = makeEnvelope();
      const envelope = {
        ...base,
        core: { ...base.core, layers: [makeLayer({ assetId: fresh })] },
      };
      await inner.put("projects", envelope.id, envelope);
      inserted = true;
    };

    const result = await repo.garbageCollect();
    expect(inserted).toBe(true);
    // The old orphan was swept — the interleaving really hit the window…
    expect(result.removedAssets).toEqual([oldOrphan]);
    // …and the newly referenced blob survived with intact bytes.
    expect(result.retainedRecent).toEqual([fresh]);
    const blob = await repo.getBlob(fresh);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(freshBytes);

    // A full GC much later still retains it: the reference is durable now.
    clock.nowMs = AFTER_GRACE * 3;
    const later = await repo.garbageCollect();
    expect(later.removedAssets).toEqual([]);
    expect(await repo.has(fresh)).toBe(true);
  });
});

describe("asset GC conservative failure", () => {
  it("a corrupt project root row aborts with a typed error and retains EVERYTHING", async () => {
    const { backend, clock, repo, put } = makeWorld();
    const orphan = await put("sweepable-orphan");
    await backend.put("projects", "bad-row", { schema: 1, core: { layers: "not-an-array" } });

    clock.nowMs = AFTER_GRACE;
    const failure = await repo.garbageCollect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GcRootScanError);
    expect((failure as GcRootScanError).code).toBe("gc-root-scan-failed");
    expect((failure as GcRootScanError).store).toBe("projects");
    // Never sweep on an incomplete scan: even the true orphan survives.
    expect(await repo.has(orphan)).toBe(true);

    // Once the damaged row is gone, GC resumes and reclaims.
    await backend.delete("projects", "bad-row");
    expect((await repo.garbageCollect()).removedAssets).toEqual([orphan]);
  });

  it("corrupt recovery and staging root rows are equally conservative", async () => {
    const { backend, clock, repo, put } = makeWorld();
    const orphan = await put("orphan-under-corruption");
    clock.nowMs = AFTER_GRACE;

    await backend.put("recovery", "bad-recovery", { core: 7 });
    await expect(repo.garbageCollect()).rejects.toMatchObject({
      name: "GcRootScanError",
      store: "recovery",
    });
    await backend.delete("recovery", "bad-recovery");

    await backend.put("staging", "bad-staging", { type: "mystery" });
    await expect(repo.garbageCollect()).rejects.toMatchObject({
      name: "GcRootScanError",
      store: "staging",
    });
    await backend.delete("staging", "bad-staging");

    expect(await repo.has(orphan)).toBe(true);
    expect((await repo.garbageCollect()).removedAssets).toEqual([orphan]);
  });

  it("collectAllAssetRoots throws typed on malformed reference fields", async () => {
    const backend = new MemoryBackend();
    const base = makeEnvelope();
    const bad = {
      ...base,
      core: { ...base.core, layers: [{ ...makeLayer(), assetId: "not-a-sha" }] },
    };
    await backend.put("projects", bad.id, bad);
    await expect(collectAllAssetRoots(backend)).rejects.toBeInstanceOf(GcRootScanError);
  });

  it("a failure mid-sweep rolls back ALL deletions; the retry reclaims cleanly", async () => {
    const inner = new MemoryBackend();
    let failNextDelete = false;
    const backend: StorageBackend = {
      get: (store, key) => inner.get(store, key),
      put: (store, key, value) => inner.put(store, key, value),
      delete: (store, key) => inner.delete(store, key),
      getAll: (store) => inner.getAll(store),
      getAllKeys: (store) => inner.getAllKeys(store),
      close: () => inner.close(),
      transaction: (stores, work) =>
        inner.transaction(stores, async (tx) => {
          await work({
            ...tx,
            delete: async (store, key) => {
              if (failNextDelete) {
                failNextDelete = false;
                const quota = new Error("Simulated quota failure mid-sweep");
                quota.name = "QuotaExceededError";
                throw quota;
              }
              await tx.delete(store, key);
            },
          });
        }),
    };
    const clock = { nowMs: 0 };
    const repo = new AssetRepository(backend, { now: () => clock.nowMs });
    const a = (
      await repo.putBlob(encoder.encode("doomed-a"), "raster", "image/png", { width: 1, height: 1 })
    ).sha256;
    const b = (
      await repo.putBlob(encoder.encode("doomed-b"), "raster", "image/png", { width: 1, height: 1 })
    ).sha256;

    clock.nowMs = AFTER_GRACE;
    failNextDelete = true;
    await expect(repo.garbageCollect()).rejects.toMatchObject({ name: "QuotaExceededError" });
    // Rollback: nothing was half-deleted.
    expect(await repo.has(a)).toBe(true);
    expect(await repo.has(b)).toBe(true);

    const retry = await repo.garbageCollect();
    expect(retry.removedAssets.sort()).toEqual([a, b].sort());
  });
});
