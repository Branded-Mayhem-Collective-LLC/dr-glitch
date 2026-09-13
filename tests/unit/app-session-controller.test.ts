/**
 * AppSessionController on MemoryBackend: open/create/save with CAS,
 * markSaved adoption, recovery journaling + crash restore, lifecycle flush,
 * single-writer ownership (read-only, takeover, duplicate), unsaved
 * sample/import semantics, and the home library binding (trash flows).
 */
import { describe, expect, it, vi } from "vitest";
import { AppSessionController } from "../../src/app/session-controller";
import {
  ConflictError,
  LeaseOwnershipLock,
  MemoryBackend,
  MemoryBusHub,
  ProjectRepository,
  RECOVERY_DEBOUNCE_MS,
  type OwnershipBus,
} from "../../src/storage";
import type { RecoveryRecordV1 } from "../../src/core/types";
import { FakeScheduler } from "./storage-fixtures.test";

type World = {
  backend: MemoryBackend;
  hub: MemoryBusHub;
  scheduler: FakeScheduler;
};

function makeWorld(): World {
  return { backend: new MemoryBackend(), hub: new MemoryBusHub(), scheduler: new FakeScheduler() };
}

function makeController(world: World, bus?: OwnershipBus): AppSessionController {
  return new AppSessionController({
    backend: world.backend,
    backendKind: "memory",
    ownership: {
      lock: new LeaseOwnershipLock(world.backend, {
        timer: world.scheduler.timer,
        now: world.scheduler.clock,
      }),
      bus: bus ?? world.hub.connect(),
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

describe("create / open / save", () => {
  it("creates a persisted Untitled project and opens it as the owner", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    expect(open.readOnly).toBe(false);
    expect(open.title).toBe("Untitled");
    expect(open.casToken).toBe(1);
    expect(open.neverSaved).toBe(true);
    expect(controller.savePlan()).toBe("dialog");
    expect(controller.lastOpenProjectId).toBe(id);
  });

  it("first save names the project; markSaved adoption clears dirty without renumbering", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);

    open.doc.apply(cyan(33), "Screen angle");
    expect(controller.isOpenProjectDirty()).toBe(true);

    await controller.performSave("Motor City");
    const after = controller.getOpenProject()!;
    expect(after.title).toBe("Motor City");
    expect(after.neverSaved).toBe(false);
    expect(after.casToken).toBe(2);
    expect(after.store.getState().dirty).toBe(false);
    expect(controller.isOpenProjectDirty()).toBe(false);
    expect(controller.savePlan()).toBe("silent");

    // The saved envelope round-trips with the edit intact.
    const stored = await controller.projects.load(id);
    expect(stored.title).toBe("Motor City");
    expect(stored.core.separation.angles.cyan).toBe(33);
    expect(stored.savedRevision).toBe(2);

    // A later edit re-dirties; a silent save adopts the next CAS token.
    open.doc.apply(cyan(44));
    expect(controller.isOpenProjectDirty()).toBe(true);
    await controller.performSave();
    expect(controller.getOpenProject()!.casToken).toBe(3);
    expect(controller.isOpenProjectDirty()).toBe(false);
  });

  it("save rejects with ConflictError when another writer saved first, leaving both copies intact", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Mine");

    // A concurrent writer (another tab) wins the next CAS slot.
    const other = new ProjectRepository(world.backend);
    const stolen = await other.load(id);
    await other.saveExplicit({
      ...stolen,
      core: { ...stolen.core, separation: { ...stolen.core.separation, angles: { ...stolen.core.separation.angles, cyan: 88 } } },
    });

    open.doc.apply(cyan(21));
    await expect(controller.performSave()).rejects.toBeInstanceOf(ConflictError);
    // In-memory work survives; the stored project keeps the other writer's save.
    expect(controller.getOpenProject()!.store.getEnvelope().core.separation.angles.cyan).toBe(21);
    expect((await controller.projects.load(id)).core.separation.angles.cyan).toBe(88);
  });
});

describe("recovery journal", () => {
  it("journals committed edits after the debounce and reports flushed", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Journaled");

    open.doc.apply(cyan(77));
    expect(await world.backend.get("recovery", id)).toBeUndefined();
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 60);
    const record = await world.backend.get<RecoveryRecordV1>("recovery", id);
    expect(record?.core.separation.angles.cyan).toBe(77);
    expect(record!.revision).toBeGreaterThan(record!.savedRevision);
    expect(controller.getSnapshot().recoveryState).toBe("flushed");
    // Journaling never touches the canonical save.
    expect((await controller.projects.load(id)).core.separation.angles.cyan).not.toBe(77);
    expect(controller.isOpenProjectDirty()).toBe(true);
  });

  it("flushJournalNow persists immediately on lifecycle events", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Lifecycle");
    open.doc.apply(cyan(55));
    await controller.flushJournalNow();
    expect((await world.backend.get<RecoveryRecordV1>("recovery", id))?.core.separation.angles.cyan).toBe(55);
  });

  it("reopening with newer recovery restores it recovered/dirty; Revert returns to the last save", async () => {
    const world = makeWorld();
    const first = makeController(world);
    const id = await first.createProject();
    const open = await first.openProject(id);
    open.doc.apply(cyan(33));
    await first.performSave("Recovery Rig");
    open.doc.apply(cyan(77));
    await first.flushJournalNow();
    // Simulated crash: no explicit save, no clean close.

    const second = makeController(world);
    // A crash stops the heartbeat and the lease expires; deleting the lease
    // record is the deterministic equivalent under the fake scheduler.
    await world.backend.delete("leases", id);
    const reopened = await second.openProject(id);
    expect(reopened.readOnly).toBe(false);
    expect(reopened.recovered).toBe(true);
    expect(second.isOpenProjectDirty()).toBe(true);
    expect(reopened.store.getEnvelope().core.separation.angles.cyan).toBe(77);
    // Undo returns to the last explicit save.
    expect(reopened.store.canUndo).toBe(true);

    await second.revertToLastSave();
    const reverted = second.getOpenProject()!;
    expect(reverted.store.getEnvelope().core.separation.angles.cyan).toBe(33);
    expect(second.isOpenProjectDirty()).toBe(false);
    expect(await world.backend.get("recovery", id)).toBeUndefined();
  });

  it("saving after recovery promotes the recovered work and clears the journal", async () => {
    const world = makeWorld();
    const first = makeController(world);
    const id = await first.createProject();
    const open = await first.openProject(id);
    open.doc.apply(cyan(33));
    await first.performSave("Recovery Save");
    open.doc.apply(cyan(55));
    await first.flushJournalNow();

    const second = makeController(world);
    await world.backend.delete("leases", id); // crashed tab's lease
    await second.openProject(id);
    await second.performSave();
    expect((await second.projects.load(id)).core.separation.angles.cyan).toBe(55);
    expect(await world.backend.get("recovery", id)).toBeUndefined();
    expect(second.isOpenProjectDirty()).toBe(false);
  });

  it("discardOpenProjectChanges drops the journal so abandoned work never resurrects", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Guarded");
    open.doc.apply(cyan(55));
    await controller.flushJournalNow();
    expect(await world.backend.get("recovery", id)).toBeDefined();
    await controller.discardOpenProjectChanges();
    expect(await world.backend.get("recovery", id)).toBeUndefined();
  });
});

describe("single-writer ownership", () => {
  it("a second controller opens read-only and takeover transfers the writer role", async () => {
    const world = makeWorld();
    const tabA = makeController(world);
    const tabB = makeController(world);
    const id = await tabA.createProject();
    await tabA.openProject(id);
    await tabA.performSave("Shared Sheet");

    const b = await tabB.openProject(id);
    expect(b.readOnly).toBe(true);
    expect(b.doc.apply(cyan(50))).toBe(false);

    tabB.requestOwnership();
    await vi.waitFor(() => {
      expect(tabB.getOpenProject()!.readOnly).toBe(false);
      expect(tabA.getOpenProject()!.readOnly).toBe(true);
    });
    // The new owner can edit; the old owner cannot.
    expect(tabB.getOpenProject()!.doc.apply(cyan(66))).toBe(true);
    expect(tabA.getOpenProject()!.doc.apply(cyan(1))).toBe(false);
  });

  it("a read-only tab live-updates title and revision on the owner's save", async () => {
    const world = makeWorld();
    const tabA = makeController(world);
    const tabB = makeController(world);
    const id = await tabA.createProject();
    const a = await tabA.openProject(id);
    await tabA.performSave("Before");

    const b = await tabB.openProject(id);
    expect(b.readOnly).toBe(true);
    a.doc.apply(cyan(61));
    await tabA.performSave("After Rename? No — same title");
    await vi.waitFor(() => {
      expect(tabB.getOpenProject()!.casToken).toBe(tabA.getOpenProject()!.casToken);
      expect(tabB.getOpenProject()!.store.getEnvelope().core.separation.angles.cyan).toBe(61);
    });
  });

  it("duplicateAsUnsaved forks the saved project as a new unsaved copy", async () => {
    const world = makeWorld();
    const tabA = makeController(world);
    const tabB = makeController(world);
    const id = await tabA.createProject();
    await tabA.openProject(id);
    await tabA.performSave("Fork Base");

    await tabB.openProject(id);
    const copyId = await tabB.duplicateAsUnsaved();
    expect(copyId).not.toBe(id);
    const copy = await tabB.openProject(copyId);
    expect(copy.readOnly).toBe(false);
    expect(copy.title).toBe("Fork Base copy");
    expect(copy.neverSaved).toBe(true);
    expect(tabB.isOpenProjectDirty()).toBe(true);
    // Not in the library until explicitly saved.
    const listed = await tabB.library.listProjects();
    expect(listed.map((project) => project.id)).not.toContain(copyId);
  });
});

describe("unsaved sample and .drglitch import", () => {
  it("the sample opens unsaved, stays out of the library, and persists under its own id on first save", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.openSampleAsUnsaved();
    expect(await controller.library.listProjects()).toHaveLength(0);

    const open = await controller.openProject(id);
    expect(open.persisted).toBe(false);
    expect(open.neverSaved).toBe(true);
    expect(controller.isOpenProjectDirty()).toBe(true);
    expect(open.store.getEnvelope().core.layers).toHaveLength(1);
    // Parity: the sample layer screens immediately, like the current studio.
    expect(open.store.getEnvelope().core.layers[0].recipe.mode).toBe("halftone");

    await controller.performSave("Sample One");
    expect(controller.isOpenProjectDirty()).toBe(false);
    const stored = await controller.projects.load(id);
    expect(stored.title).toBe("Sample One");
    const listed = await controller.library.listProjects();
    expect(listed.map((project) => project.title)).toContain("Sample One");
  });

  it("keeps journaling after the sample's first save (fresh session fields, not a stale capture)", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.openSampleAsUnsaved();
    const open = await controller.openProject(id);
    await controller.performSave("Sample Journal");

    open.doc.apply(cyan(63));
    await world.scheduler.advance(RECOVERY_DEBOUNCE_MS + 60);
    const record = await world.backend.get<RecoveryRecordV1>("recovery", id);
    expect(record?.core.separation.angles.cyan).toBe(63);
    // The record carries the post-save CAS token and title, not stale ones.
    expect(record?.savedRevision).toBe(controller.getOpenProject()!.casToken);
    expect(record?.title).toBe("Sample Journal");
  });

  it(".drglitch export/import round-trips; the import opens unsaved-dirty with a new identity", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    open.doc.apply(cyan(33));
    await controller.performSave("Round Trip");

    const { filename, bytes } = await controller.exportProjectArchive(id);
    expect(filename).toBe("Round-Trip.drglitch");
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'

    const importedId = await controller.importProjectFile(bytes);
    expect(importedId).not.toBe(id);
    // Installed at savedRevision 0: not in the library until saved.
    expect((await controller.library.listProjects()).map((project) => project.id)).not.toContain(importedId);

    const imported = await controller.openProject(importedId);
    expect(imported.title).toBe("Round Trip");
    expect(imported.neverSaved).toBe(true);
    expect(controller.isOpenProjectDirty()).toBe(true);
    expect(imported.store.getEnvelope().core.separation.angles.cyan).toBe(33);

    await controller.performSave("Round Trip");
    const listed = await controller.library.listProjects();
    expect(listed.filter((project) => project.title === "Round Trip")).toHaveLength(2);
  });
});

describe("project archive operation lifecycle", () => {
  it("forwards a pre-aborted plan signal through the home library binding", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      controller.library.planProjectExport!(id, { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await controller.dispose();
  });

  it("dispose cancels a blocked streamed write and shares one sink abort", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    let startedWrite: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedWrite = resolve;
    });
    let rejectWrite: ((reason: unknown) => void) | null = null;
    let aborts = 0;
    const exporting = controller.exportProjectArchiveToSink(id, {
      write: () => {
        startedWrite!();
        return new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        });
      },
      abort: () => {
        aborts += 1;
        rejectWrite?.(new DOMException("Aborted", "AbortError"));
      },
    });
    exporting.catch(() => undefined);
    await started;
    const startedAt = Date.now();
    const disposing = controller.dispose();
    await expect(exporting).rejects.toMatchObject({ name: "AbortError" });
    await disposing;
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(aborts).toBe(1);
  });
});

describe("library binding: trash flows", () => {
  it("trash, restore, delete permanently, and empty trash", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    await controller.openProject(id);
    await controller.performSave("Trash Me");
    await controller.closeProject();

    await controller.library.trashProject(id);
    expect(await controller.library.listProjects()).toHaveLength(0);
    const trash = await controller.library.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0].title).toBe("Trash Me");
    expect(trash[0].expiresAt - trash[0].deletedAt).toBe(30 * 24 * 60 * 60 * 1000);

    await controller.library.restoreProject(id);
    expect((await controller.library.listProjects())[0].title).toBe("Trash Me");
    expect(await controller.library.listTrash()).toHaveLength(0);

    await controller.library.trashProject(id);
    await controller.library.deletePermanently(id);
    expect(await controller.library.listTrash()).toHaveLength(0);
    await expect(controller.projects.load(id)).rejects.toThrow();

    const secondId = await controller.createProject();
    await controller.openProject(secondId);
    await controller.performSave("Trash Me Too");
    await controller.closeProject();
    await controller.library.trashProject(secondId);
    await controller.library.emptyTrash();
    expect(await controller.library.listTrash()).toHaveLength(0);
    expect(await controller.library.listProjects()).toHaveLength(0);
  });

  it("rename bumps the CAS token so a stale writer conflicts instead of reverting the title", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    await controller.openProject(id);
    await controller.performSave("Original Name");
    const before = controller.getOpenProject()!.casToken;
    await controller.renameOpenProject("Renamed City");
    const after = controller.getOpenProject()!;
    expect(after.title).toBe("Renamed City");
    expect(after.casToken).toBe(before + 1);
    expect((await controller.projects.load(id)).title).toBe("Renamed City");
  });
});

/* ------------------------------------------------------------------ */
/* dispose — session lifecycle teardown (StrictMode/unmount safety)    */
/* ------------------------------------------------------------------ */

describe("dispose", () => {
  it("closes the open project, clears every timer, and frees the writer lock", async () => {
    const world = makeWorld();
    const first = makeController(world);
    const id = await first.createProject();
    const open = await first.openProject(id);
    open.doc.apply(cyan(31), "Screen angle");
    // Journal debounce + flushed-signal + lease heartbeat are pending now.
    expect(world.scheduler.pendingCount).toBeGreaterThan(0);

    await first.dispose();
    expect(first.isDisposed).toBe(true);
    expect(first.getOpenProject()).toBeNull();
    // No leaked timers: debounce/signal cleared, heartbeat released.
    expect(world.scheduler.pendingCount).toBe(0);

    // The write lock is really free — a new session becomes the owner and
    // the teardown flush preserved the dirty edit as recovery.
    const second = makeController(world);
    const reopened = await second.openProject(id);
    expect(reopened.readOnly).toBe(false);
    expect(reopened.recovered).toBe(true);
    expect(reopened.store.getEnvelope().core.separation.angles.cyan).toBe(31);
  });

  it("is idempotent and makes later opens fail loudly", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    await controller.openProject(id);
    await controller.dispose();
    await controller.dispose();
    await expect(controller.openProject(id)).rejects.toThrow(/disposed/);
  });

  it("never closes an injected backend or bus (shared two-tab test worlds)", async () => {
    const world = makeWorld();
    const bus = world.hub.connect();
    const backendClose = vi.spyOn(world.backend, "close");
    const busClose = vi.spyOn(bus, "close");
    const controller = makeController(world, bus);
    const id = await controller.createProject();
    await controller.openProject(id);
    await controller.dispose();
    expect(backendClose).not.toHaveBeenCalled();
    expect(busClose).not.toHaveBeenCalled();
  });

  it("tears down an orphaned create() (cleanup raced the async factory) completely", async () => {
    // The AppSessionProvider StrictMode path: create() resolves AFTER the
    // effect cleanup ran; the orphan is disposed immediately. create()'s
    // controller owns its backend and ownership bus, so dispose must close
    // both — exactly once, never having opened a project.
    const controller = await AppSessionController.create();
    const backendClose = vi.spyOn(controller.backend, "close");
    await controller.dispose();
    expect(backendClose).toHaveBeenCalledTimes(1);
    expect(controller.isDisposed).toBe(true);
    await controller.dispose();
    expect(backendClose).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* dispose vs in-flight open, concurrent dispose, provider contract    */
/* ------------------------------------------------------------------ */

import { SessionDisposedError } from "../../src/app/session-controller";
import { acquireSessionForMount } from "../../src/app/app-context";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("dispose/open race", () => {
  it("an open gated mid-acquire when dispose starts releases its lock and opens nothing", async () => {
    const world = makeWorld();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const releaseSpy = vi.fn(async () => undefined);
    const controller = new AppSessionController({
      backend: world.backend,
      backendKind: "memory",
      ownership: {
        lock: {
          tryAcquire: async () => {
            await gate;
            return { acquired: true, release: releaseSpy };
          },
        },
        bus: world.hub.connect(),
      },
      timer: world.scheduler.timer,
      now: world.scheduler.clock,
    });
    const id = await controller.createProject();

    const opening = controller.openProject(id);
    const openingOutcome = opening.then(
      () => "opened" as const,
      (error: unknown) => error,
    );
    await flush(); // the open is now parked inside the gated tryAcquire

    const disposal = controller.dispose(); // must wait for the open chain
    await flush();
    expect(controller.isDisposed).toBe(true);

    releaseGate();
    await disposal;

    // The open never completed: the acquired lock went straight back, no
    // open state or last-open pointer survived, and the caller got the
    // typed disposed error.
    expect(await openingOutcome).toBeInstanceOf(SessionDisposedError);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(controller.getOpenProject()).toBeNull();
    expect(world.scheduler.pendingCount).toBe(0);
  });

  it("concurrent dispose() calls share one promise and close the backend once", async () => {
    const controller = await AppSessionController.create();
    const backendClose = vi.spyOn(controller.backend, "close");
    const first = controller.dispose();
    const second = controller.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(backendClose).toHaveBeenCalledTimes(1);
    // A third call after completion still reuses the settled promise.
    expect(controller.dispose()).toBe(first);
    expect(backendClose).toHaveBeenCalledTimes(1);
  });

  it("operations started after dispose fail with the typed disposed error", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    await controller.openProject(id);
    await controller.dispose();
    await expect(controller.openProject(id)).rejects.toBeInstanceOf(SessionDisposedError);
    await expect(controller.createProject()).rejects.toBeInstanceOf(SessionDisposedError);
    await expect(controller.performSave("x")).rejects.toBeInstanceOf(SessionDisposedError);
    await expect(controller.openSampleAsUnsaved()).rejects.toBeInstanceOf(SessionDisposedError);
    await expect(
      controller.importProjectFile(new Uint8Array([1, 2, 3])),
    ).rejects.toBeInstanceOf(SessionDisposedError);
  });
});

describe("acquireSessionForMount (AppSessionProvider StrictMode contract)", () => {
  it("setup → cleanup → setup: the second setup owns a live controller and the late-resolving first create is disposed", async () => {
    const world = makeWorld();
    const ready: AppSessionController[] = [];

    // setup #1 — its async create is still in flight when cleanup runs.
    let resolveFirst!: (controller: AppSessionController) => void;
    const firstCreate = new Promise<AppSessionController>((resolve) => (resolveFirst = resolve));
    const cleanup1 = acquireSessionForMount({
      create: () => firstCreate,
      onReady: (controller) => ready.push(controller),
    });

    // StrictMode: cleanup #1 fires before the create resolves.
    cleanup1();

    // setup #2 owns its own fresh controller.
    const second = makeController(world);
    const teardown = vi.fn();
    const cleanup2 = acquireSessionForMount({
      create: async () => second,
      onReady: (controller) => ready.push(controller),
      onTeardown: teardown,
    });
    await flush();
    expect(ready).toEqual([second]);
    expect(second.isDisposed).toBe(false);

    // The orphaned first create resolves late: disposed, never surfaced.
    const first = makeController(world);
    resolveFirst(first);
    await flush();
    expect(first.isDisposed).toBe(true);
    expect(ready).toEqual([second]);

    // Real unmount: the owned controller is disposed, teardown signalled,
    // and the shared world holds no leaked timers.
    cleanup2();
    await flush();
    expect(second.isDisposed).toBe(true);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(world.scheduler.pendingCount).toBe(0);
  });
});
