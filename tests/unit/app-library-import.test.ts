/**
 * Home-surface import UI seam (wave F):
 * - libraryWithCancellableImport exposes the controller's cancellable
 *   .drglitch handle through the ProjectLibraryApi the home surface
 *   renders against, preserving the base library;
 * - cancel through the WRAPPED handle rejects typed and installs nothing;
 * - the pure flow helpers (progress copy + typed-cancel detection) behave
 *   exactly as the UI relies on.
 */
import { describe, expect, it } from "vitest";
import { libraryWithCancellableImport } from "../../src/app/library-import";
import {
  describeImportProgress,
  IMPORT_CANCELLED_NOTICE,
  isImportCancelled,
} from "../../src/home/import-flow";
import { AppSessionController } from "../../src/app/session-controller";
import { LeaseOwnershipLock, MemoryBackend, MemoryBusHub } from "../../src/storage";
import { exportDrglitch } from "../../src/io";
import { sha256Hex } from "../../src/io/sha256";
import { FakeScheduler, makeEnvelope, makeLayer } from "./storage-fixtures.test";
import { makeDecodablePng, referenceRasterDecoder } from "./helpers/raster-fixtures";

function makeWorld() {
  return { backend: new MemoryBackend(), hub: new MemoryBusHub(), scheduler: new FakeScheduler() };
}

function makeController(world: ReturnType<typeof makeWorld>): AppSessionController {
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
  });
}

async function makeArchive(): Promise<Uint8Array> {
  const png = makeDecodablePng(8, 8, { seed: "library-import" });
  const sha = await sha256Hex(png);
  const base = makeEnvelope({ title: "Imported via library" });
  const envelope = {
    ...base,
    core: { ...base.core, layers: [makeLayer({ assetId: sha })] },
  };
  return exportDrglitch({ decoder: referenceRasterDecoder,
    envelope,
    appVersion: "test",
    getAsset: (wanted) => (wanted === sha ? { bytes: png, ext: "png" } : null),
    getThumbnail: () => null,
  });
}

describe("libraryWithCancellableImport", () => {
  it("exposes the cancellable handle while preserving the base library", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const library = libraryWithCancellableImport(controller);
    expect(typeof library.importProjectFileCancellable).toBe("function");
    expect(await library.listProjects()).toEqual([]);

    const bytes = await makeArchive();
    const handle = library.importProjectFileCancellable!(
      new File([bytes as BlobPart], "piece.drglitch"),
    );
    const phases: string[] = [];
    const unsubscribe = handle.onProgress((progress) => phases.push(progress.phase));
    const id = await handle.promise;
    unsubscribe();
    expect(phases).toContain("extract");
    expect(phases[phases.length - 1]).toBe("commit");
    expect((await controller.projects.load(id)).title).toBe("Imported via library");
    await controller.dispose();
  });

  it("cancel through the wrapped handle rejects typed and installs NOTHING", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const library = libraryWithCancellableImport(controller);
    const bytes = await makeArchive();
    const handle = library.importProjectFileCancellable!(
      new File([bytes as BlobPart], "piece.drglitch"),
    );
    handle.cancel();
    let rejection: unknown = null;
    try {
      await handle.promise;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).not.toBeNull();
    // The UI's typed-cancel detection turns exactly this rejection into a
    // calm notice, never a generic failure.
    expect(isImportCancelled(rejection)).toBe(true);
    expect(await library.listProjects()).toEqual([]);
    expect(await world.backend.getAllKeys("projects")).toEqual([]);
    expect(await world.backend.getAllKeys("assets")).toEqual([]);
    expect(await world.backend.getAllKeys("staging")).toEqual([]);
    await controller.dispose();
  });
});

describe("import flow helpers", () => {
  it("describes every phase with asset counters", () => {
    expect(describeImportProgress("a.drglitch", null)).toContain("reading file");
    expect(
      describeImportProgress("a.drglitch", { phase: "extract", assetsDone: 0, assetsTotal: 0 }),
    ).toContain("Extracting archive");
    expect(
      describeImportProgress("a.drglitch", { phase: "stage", assetsDone: 3, assetsTotal: 7 }),
    ).toContain("Staging assets (3/7 assets)");
    expect(
      describeImportProgress("a.drglitch", { phase: "commit", assetsDone: 7, assetsTotal: 7 }),
    ).toContain("Installing project (7/7 assets)");
  });

  it("detects ONLY the typed archive-aborted rejection as a cancel", () => {
    expect(isImportCancelled({ code: "archive-aborted" })).toBe(true);
    expect(isImportCancelled(new Error("boom"))).toBe(false);
    expect(isImportCancelled({ code: "archive-too-large" })).toBe(false);
    expect(isImportCancelled(null)).toBe(false);
    expect(IMPORT_CANCELLED_NOTICE).toMatch(/nothing was installed/i);
  });
});
