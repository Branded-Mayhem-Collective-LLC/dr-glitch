/**
 * Asset-GC lifecycle wiring on AppSessionController: fire-and-forget
 * triggers at startup, permanent delete, empty trash, trash expiry, import
 * commit, and snapshot removal; session in-memory roots protecting unsaved
 * projects; and error containment (a failing GC never surfaces as an
 * unhandled rejection or blocks the calling flow).
 */
import { describe, expect, it, vi } from "vitest";
import { AppSessionController } from "../../src/app/session-controller";
import {
  ASSET_GC_GRACE_MS,
  LeaseOwnershipLock,
  MemoryBackend,
  MemoryBusHub,
  TRASH_RETENTION_MS,
} from "../../src/storage";
import { exportDrglitch } from "../../src/io";
import { sha256Hex } from "../../src/io/sha256";
import { FakeScheduler, makeEnvelope, makeLayer } from "./storage-fixtures.test";
import { makeDecodablePng, referenceRasterDecoder } from "./helpers/raster-fixtures";

type World = {
  backend: MemoryBackend;
  hub: MemoryBusHub;
  scheduler: FakeScheduler;
};

function makeWorld(): World {
  return { backend: new MemoryBackend(), hub: new MemoryBusHub(), scheduler: new FakeScheduler() };
}

const SAMPLE_PNG = makeDecodablePng(8, 8, { seed: "gc-sample" });

function makeController(world: World): AppSessionController {
  return new AppSessionController({
    backend: world.backend,
    backendKind: "memory",
    ownership: {
      lock: new LeaseOwnershipLock(world.backend, {
        timer: world.scheduler.timer,
        now: world.scheduler.clock,
      }),
      bus: world.hub.connect(),
    },
    timer: world.scheduler.timer,
    now: world.scheduler.clock,
    rasterDecoder: referenceRasterDecoder,
    sampleFactory: async () => ({
      bytes: SAMPLE_PNG,
      mime: "image/png",
      width: 8,
      height: 8,
      layerName: "Sample artwork",
      title: "Sample",
    }),
  });
}

async function makeArchive(): Promise<Uint8Array> {
  const png = makeDecodablePng(8, 8, { seed: "gc-import" });
  const sha = await sha256Hex(png);
  const base = makeEnvelope({ title: "GC import" });
  const envelope = { ...base, core: { ...base.core, layers: [makeLayer({ assetId: sha })] } };
  return exportDrglitch({ decoder: referenceRasterDecoder,
    envelope,
    appVersion: "test",
    getAsset: (wanted) => (wanted === sha ? { bytes: png, ext: "png" } : null),
    getThumbnail: () => null,
  });
}

describe("asset GC lifecycle triggers", () => {
  it("startup maintenance schedules a GC pass", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const gcSpy = vi.spyOn(controller, "scheduleAssetGc");
    const runSpy = vi.spyOn(controller.assets, "garbageCollect");
    await controller.startupMaintenance;
    expect(gcSpy).toHaveBeenCalledWith("startup");
    expect(runSpy).toHaveBeenCalledTimes(1);
    await controller.dispose();
  });

  it("fires after deletePermanently and emptyTrash, and actually reclaims the blobs", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;
    const gcSpy = vi.spyOn(controller, "scheduleAssetGc");

    // A saved project whose layer owns an asset.
    const record = await controller.assets.putBlob(
      makeDecodablePng(8, 8, { seed: "doomed" }),
      "raster",
      "image/png",
      { width: 8, height: 8 },
    );
    const base = makeEnvelope();
    const envelope = {
      ...base,
      core: { ...base.core, layers: [makeLayer({ assetId: record.sha256 })] },
    };
    await world.backend.put("projects", envelope.id, envelope);

    world.scheduler.nowMs = ASSET_GC_GRACE_MS + 1_000;
    await controller.library.deletePermanently(envelope.id);
    expect(gcSpy).toHaveBeenCalledWith("delete-permanently");
    // Drain the serialized chain, then the blob must be gone.
    await controller.scheduleAssetGc("test-drain");
    expect(await controller.assets.has(record.sha256)).toBe(false);

    await controller.library.emptyTrash();
    expect(gcSpy).toHaveBeenCalledWith("empty-trash");
    await controller.dispose();
  });

  it("fires when listTrash sweeps expired entries (30-day expiry reclamation)", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;
    const gcSpy = vi.spyOn(controller, "scheduleAssetGc");

    const record = await controller.assets.putBlob(
      makeDecodablePng(8, 8, { seed: "expiring" }),
      "raster",
      "image/png",
      { width: 8, height: 8 },
    );
    const base = makeEnvelope();
    const envelope = {
      ...base,
      core: { ...base.core, layers: [makeLayer({ assetId: record.sha256 })] },
    };
    await world.backend.put("projects", envelope.id, envelope);
    await controller.library.trashProject(envelope.id);

    // Inside the window: no sweep-triggered GC, blob retained.
    expect((await controller.library.listTrash()).length).toBe(1);
    expect(gcSpy).not.toHaveBeenCalledWith("trash-expired");

    world.scheduler.nowMs = TRASH_RETENTION_MS + ASSET_GC_GRACE_MS + 1_000;
    expect((await controller.library.listTrash()).length).toBe(0);
    expect(gcSpy).toHaveBeenCalledWith("trash-expired");
    await controller.scheduleAssetGc("test-drain");
    expect(await controller.assets.has(record.sha256)).toBe(false);
    await controller.dispose();
  });

  it("fires after a committed archive import", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;
    const gcSpy = vi.spyOn(controller, "scheduleAssetGc");
    const id = await controller.importProjectFile(await makeArchive());
    expect(gcSpy).toHaveBeenCalledWith("import-commit");
    // The freshly imported asset is referenced (and young): never a victim.
    await controller.scheduleAssetGc("test-drain");
    const installed = await controller.projects.load(id);
    expect(await controller.assets.has(installed.core.layers[0].assetId)).toBe(true);
    await controller.dispose();
  });

  it("fires when a snapshot (and its thumbnail reference) is deleted", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    const gcSpy = vi.spyOn(controller, "scheduleAssetGc");

    const thumb = await controller.assets.putBlob(
      makeDecodablePng(8, 8, { seed: "gc-thumb" }),
      "thumbnail",
      "image/png",
      { width: 8, height: 8 },
    );
    const snapshot = open.doc.addSnapshot("Checkpoint", thumb.sha256);
    expect(snapshot).not.toBeNull();
    expect(gcSpy).not.toHaveBeenCalledWith("snapshot-removed");

    expect(open.doc.deleteSnapshot(snapshot!.id)).toBe(true);
    expect(gcSpy).toHaveBeenCalledWith("snapshot-removed");
    await controller.dispose();
  });

  it("session roots keep an unsaved project's blobs alive past the grace window; discard+close frees them", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;

    const sampleId = await controller.openSampleAsUnsaved();
    const open = await controller.openProject(sampleId);
    const assetSha = open.store.getEnvelope().core.layers[0].assetId;

    // Hours later, still unsaved: no durable row references the sample's
    // bytes, only this session's memory. GC must retain via session roots.
    world.scheduler.nowMs = ASSET_GC_GRACE_MS * 4;
    await controller.scheduleAssetGc("test-old-unsaved");
    expect(await controller.assets.has(assetSha)).toBe(true);

    // Discard the unsaved project and close it: the last in-memory
    // reference is gone, so the next pass reclaims the bytes.
    await controller.discardOpenProjectChanges();
    await controller.closeProject();
    await controller.scheduleAssetGc("test-after-discard");
    expect(await controller.assets.has(assetSha)).toBe(false);
    await controller.dispose();
  });
});

describe("asset GC error containment", () => {
  it("a failing GC never rejects the trigger promise, never blocks the flow, and never leaks an unhandled rejection", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.spyOn(controller.assets, "garbageCollect").mockRejectedValue(
        new Error("simulated GC failure"),
      );

      // Direct call: resolves despite the failure.
      await expect(controller.scheduleAssetGc("direct")).resolves.toBeUndefined();

      // Lifecycle trigger: the user-facing flow still succeeds.
      const id = await controller.createProject();
      await controller.library.deletePermanently(id);
      await expect(controller.projects.load(id)).rejects.toMatchObject({ name: "NotFoundError" });

      // Drain the chain and all microtasks so any dangling rejection fires.
      await controller.scheduleAssetGc("drain");
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
    await controller.dispose();
  });

  it("GC after dispose is a safe no-op", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await controller.startupMaintenance;
    const runSpy = vi.spyOn(controller.assets, "garbageCollect");
    await controller.dispose();
    await expect(controller.scheduleAssetGc("post-dispose")).resolves.toBeUndefined();
    expect(runSpy).not.toHaveBeenCalled();
  });
});
