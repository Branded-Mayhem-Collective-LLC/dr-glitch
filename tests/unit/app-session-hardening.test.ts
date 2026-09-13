/**
 * Session-spine hardening regressions:
 * - journal-only recovery hydration for never-saved projects (crash reload)
 * - atomic first Save (no partial rows on failure; retry lands everything)
 * - mid-save edit race (recovery for post-freeze edits survives the Save)
 * - rename base-bump re-journaling (stale-base journal never restored)
 * - non-durable storage mode exposure
 * - pre-read size gate on .drglitch intake (no buffer materialization)
 * - boot-time abandoned-staging sweep
 * - DocumentApi value-level no-op suppression (undo stack hygiene)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppSessionController } from "../../src/app/session-controller";
import { DocumentApi } from "../../src/app/document-api";
import { ProjectStore, createEmptyProject } from "../../src/project";
import {
  ArchiveValidationError,
  MAX_PRESET_TEXT_LENGTH,
} from "../../src/io";
import {
  LeaseOwnershipLock,
  MemoryBackend,
  MemoryBusHub,
  RECOVERY_DEBOUNCE_MS,
  STAGING_ABANDONED_AFTER_MS,
  type StorageBackend,
} from "../../src/storage";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { StagingMetaRow } from "../../src/storage/schema";
import { FakeScheduler } from "./storage-fixtures.test";

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

type World = {
  backend: MemoryBackend;
  hub: MemoryBusHub;
  scheduler: FakeScheduler;
};

function makeWorld(): World {
  return { backend: new MemoryBackend(), hub: new MemoryBusHub(), scheduler: new FakeScheduler() };
}

function makeController(world: World, backend?: StorageBackend): AppSessionController {
  return new AppSessionController({
    backend: backend ?? world.backend,
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
    sampleFactory: async () => ({
      bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
      mime: "image/png",
      width: 1200,
      height: 900,
      layerName: "Sample artwork",
      title: "Sample",
    }),
  });
}

const cyan = (value: number) =>
  ({ type: "separation/set-angle", plate: "cyan", angle: value }) as const;

describe("journal-only recovery for never-saved projects", () => {
  it("open sample → edit → journal flush → crash reload → reopens recovered+dirty; Save then persists", async () => {
    const world = makeWorld();
    const first = makeController(world);
    const id = await first.openSampleAsUnsaved();
    const open = await first.openProject(id);
    expect(open.persisted).toBe(false);

    open.doc.apply(cyan(66), "Screen angle");
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 100);
    expect(await world.backend.get("recovery", id)).toBeDefined();

    // Simulated crash reload: a NEW controller on the SAME backend — the
    // in-memory unsavedProjects map is empty, the repository has no row,
    // but the recovery journal carries the full core + title.
    await first.dispose();
    const second = makeController(world);
    const reopened = await second.openProject(id);
    expect(reopened.persisted).toBe(false);
    expect(reopened.recovered).toBe(true);
    expect(reopened.title).toBe("Sample");
    expect(reopened.store.getEnvelope().core.separation.angles.cyan).toBe(66);
    expect(second.isOpenProjectDirty()).toBe(true);

    // First Save afterwards persists normally.
    await second.performSave("Rescued");
    const stored = await second.projects.load(id);
    expect(stored.title).toBe("Rescued");
    expect(stored.core.separation.angles.cyan).toBe(66);
    expect(stored.savedRevision).toBe(1);
    await second.dispose();
  });

  it("a missing project with NO journal still fails with the original NotFound error", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await expect(controller.openProject("ghost-project")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await controller.dispose();
  });
});

describe("atomic first save", () => {
  it("a failed first Save leaves NO partial row; the session stays unsaved+dirty; retry lands core AND snapshots", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.openSampleAsUnsaved();
    const open = await controller.openProject(id);
    open.doc.apply(cyan(41), "Screen angle");
    open.doc.addSnapshot("Checkpoint");

    world.backend.simulateQuotaExceeded = true;
    await expect(controller.performSave("Doomed")).rejects.toThrow();
    world.backend.simulateQuotaExceeded = false;

    // Nothing persisted, session state untouched and retryable.
    expect(await world.backend.get("projects", id)).toBeUndefined();
    const after = controller.getOpenProject()!;
    expect(after.persisted).toBe(false);
    expect(after.neverSaved).toBe(true);
    expect(controller.isOpenProjectDirty()).toBe(true);
    expect(controller.getSnapshot().storageAlert).not.toBeNull();

    // Retry succeeds with the COMPLETE envelope in one shot.
    await controller.performSave("Recovered Save");
    const stored = await controller.projects.load(id);
    expect(stored.title).toBe("Recovered Save");
    expect(stored.savedRevision).toBe(1);
    expect(stored.core.separation.angles.cyan).toBe(41);
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0].name).toBe("Checkpoint");
    expect(controller.getOpenProject()!.persisted).toBe(true);
    expect(controller.isOpenProjectDirty()).toBe(false);
    await controller.dispose();
  });
});

describe("mid-save edit race", () => {
  function gatedBackend(inner: MemoryBackend): {
    backend: StorageBackend;
    blockTransactions: () => { release: () => void };
  } {
    let gate: Promise<void> | null = null;
    const backend: StorageBackend = {
      get: (store, key) => inner.get(store, key),
      put: (store, key, value) => inner.put(store, key, value),
      delete: (store, key) => inner.delete(store, key),
      getAll: (store) => inner.getAll(store),
      getAllKeys: (store) => inner.getAllKeys(store),
      transaction: async (stores, work) => {
        if (gate) await gate;
        return inner.transaction(stores, work);
      },
      close: () => inner.close(),
    };
    const blockTransactions = () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release: () => {
          gate = null;
          release();
        },
      };
    };
    return { backend, blockTransactions };
  }

  it("edits landed during an in-flight Save keep their crash recovery (re-journaled on the new base)", async () => {
    const world = makeWorld();
    const { backend, blockTransactions } = gatedBackend(world.backend);
    const controller = makeController(world, backend);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    open.doc.apply(cyan(33));
    await controller.performSave("Base"); // casToken 2
    open.doc.apply(cyan(44)); // frozen revision N for the next save

    const gate = blockTransactions(); // block the storage transaction
    const saving = controller.performSave();
    await Promise.resolve();
    open.doc.apply(cyan(55)); // mid-save edit: N+1
    gate.release();
    await saving;

    // Canonical state is the FROZEN revision (44); session stays dirty.
    expect((await controller.projects.load(id)).core.separation.angles.cyan).toBe(44);
    expect(controller.isOpenProjectDirty()).toBe(true);

    // The journal was rescheduled for the newer state on the NEW base…
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 100);
    const journaled = await world.backend.get<{ savedRevision: number; core: { separation: { angles: { cyan: number } } } }>(
      "recovery",
      id,
    );
    expect(journaled).toBeDefined();
    expect(journaled!.savedRevision).toBe(controller.getOpenProject()!.casToken);
    expect(journaled!.core.separation.angles.cyan).toBe(55);

    // …so a crash reload restores N+1, not just the saved N.
    await controller.dispose();
    const second = makeController(world);
    const reopened = await second.openProject(id);
    expect(reopened.recovered).toBe(true);
    expect(reopened.store.getEnvelope().core.separation.angles.cyan).toBe(55);
    expect(second.isOpenProjectDirty()).toBe(true);
    await second.dispose();
  });
});

describe("rename bumps the recovery base", () => {
  it("dirty work is re-journaled on the new base after a rename; crash reload restores it", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    open.doc.apply(cyan(33));
    await controller.performSave("Before");

    open.doc.apply(cyan(44));
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 100); // journal on old base

    await controller.renameOpenProject("After");
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 100); // re-journal on new base

    await controller.dispose();
    const second = makeController(world);
    const reopened = await second.openProject(id);
    expect(reopened.title).toBe("After");
    expect(reopened.recovered).toBe(true);
    expect(reopened.store.getEnvelope().core.separation.angles.cyan).toBe(44);
    await second.dispose();
  });

  it("a journal left on the OLD base is discarded, never restored over newer canonical state", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    open.doc.apply(cyan(33));
    await controller.performSave("Base");
    open.doc.apply(cyan(44));
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 100);

    // Another tab renames (base bump) directly through the repository —
    // this session's open handle knows nothing about it.
    await controller.projects.rename(id, "Renamed Elsewhere");

    await controller.dispose();
    const second = makeController(world);
    const reopened = await second.openProject(id);
    // Stale old-base journal is rejected: canonical state wins.
    expect(reopened.recovered).toBe(false);
    expect(reopened.store.getEnvelope().core.separation.angles.cyan).toBe(33);
    expect(reopened.title).toBe("Renamed Elsewhere");
    await second.dispose();
  });
});

describe("non-durable storage mode", () => {
  it("exposes durable=false on the memory fallback and durable=true for idb sessions", () => {
    const world = makeWorld();
    const memory = makeController(world);
    expect(memory.isDurable).toBe(false);
    expect(memory.getSnapshot().durable).toBe(false);
    expect(memory.getSnapshot().backendKind).toBe("memory");

    const idbLike = new AppSessionController({
      backend: world.backend,
      backendKind: "idb",
      ownership: {
        lock: new LeaseOwnershipLock(world.backend, {
          timer: world.scheduler.timer,
          now: world.scheduler.clock,
        }),
        bus: world.hub.connect(),
      },
      timer: world.scheduler.timer,
      now: world.scheduler.clock,
    });
    expect(idbLike.isDurable).toBe(true);
    expect(idbLike.getSnapshot().durable).toBe(true);
  });

  it("Save still works in-session on the non-durable backend", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    open.doc.apply(cyan(12));
    await controller.performSave("Ephemeral");
    expect((await controller.projects.load(id)).title).toBe("Ephemeral");
    expect(controller.isOpenProjectDirty()).toBe(false);
    await controller.dispose();
  });
});

describe("pre-read intake size gates", () => {
  it(".drglitch: an oversized File is rejected BEFORE arrayBuffer is ever called", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const arrayBuffer = vi.fn();
    const fake = {
      size: RESOURCE_POLICY.maxArchiveCompressedBytes + 1,
      arrayBuffer,
    } as unknown as File;
    await expect(controller.library.openProjectFile(fake)).rejects.toBeInstanceOf(
      ArchiveValidationError,
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it(".drpreset ceiling matches the io byte limit used by the PresetsSection gate", () => {
    // The UI gate compares File.size against this exported constant before
    // .text() runs; pin it so a silent limit change breaks the build here.
    expect(MAX_PRESET_TEXT_LENGTH).toBe(4 * 1024 * 1024);
  });
});

describe("boot-time abandoned staging sweep", () => {
  it("purges staging areas older than the threshold; fresh in-flight areas survive", async () => {
    const world = makeWorld();
    world.scheduler.nowMs = STAGING_ABANDONED_AFTER_MS + 60_000;
    const oldMeta: StagingMetaRow = {
      type: "meta",
      stagingId: "stale-import",
      createdAt: 10, // long dead
      envelope: null,
      assetShas: [],
    };
    const freshMeta: StagingMetaRow = {
      type: "meta",
      stagingId: "live-import",
      createdAt: world.scheduler.nowMs - 1_000, // within the threshold
      envelope: null,
      assetShas: [],
    };
    await world.backend.put("staging", oldMeta.stagingId, oldMeta);
    await world.backend.put("staging", freshMeta.stagingId, freshMeta);

    const controller = makeController(world);
    await controller.startupMaintenance;
    const keys = await world.backend.getAllKeys("staging");
    expect(keys).toEqual(["live-import"]);
    await controller.dispose();
  });
});

describe("DocumentApi value-level no-op suppression", () => {
  function makeDoc() {
    const store = new ProjectStore(createEmptyProject({ title: "T", now: 0 }));
    return { store, doc: new DocumentApi(store) };
  }

  it("re-applying identical values (blur after Enter) records NO extra undo transaction", () => {
    const { store, doc } = makeDoc();
    const before = store.getEnvelope().core.separation.angles.cyan;
    doc.apply(cyan(37), "Angle");
    expect(doc.undoDepth).toBe(1);
    const revision = store.getState().revision;

    // The duplicate commit a numeric field fires on blur right after Enter.
    doc.apply(cyan(37), "Angle");
    expect(doc.undoDepth).toBe(1);
    expect(store.getState().revision).toBe(revision);

    // ONE undo returns to the original value — never a visible no-op.
    expect(doc.undo()).toBe(true);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(before);
    expect(doc.undoDepth).toBe(0);
  });

  it("a gesture that ends where it began records nothing", () => {
    const { store, doc } = makeDoc();
    const base = store.getEnvelope().core.separation.angles.cyan;
    doc.beginGesture();
    doc.apply(cyan(80), "Scrub");
    doc.apply(cyan(base), "Scrub"); // dragged back to the start
    doc.endGesture();
    expect(doc.undoDepth).toBe(0);
    expect(store.getState().canUndo).toBe(false);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(base);
  });

  it("a gesture with a real change still commits exactly one transaction", () => {
    const { store, doc } = makeDoc();
    doc.beginGesture();
    doc.apply(cyan(10), "Scrub");
    doc.apply(cyan(20), "Scrub");
    doc.endGesture();
    expect(doc.undoDepth).toBe(1);
    expect(store.getEnvelope().core.separation.angles.cyan).toBe(20);
    doc.undo();
    expect(doc.undoDepth).toBe(0);
  });
});
