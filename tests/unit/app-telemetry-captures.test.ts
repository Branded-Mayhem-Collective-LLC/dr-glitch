/**
 * Session-level telemetry captures: one scrubbed stable-code event per REAL
 * handled storage/archive/GC failure, none without a DSN, no duplicates.
 *
 * The transport is a fake injected through initTelemetry (no network, no
 * DSN semantics beyond "configured"), and failures are injected at the
 * typed-error surfaces the session controller owns:
 * - quota / generic write failure   → reportStorageError (journal + save)
 * - CAS collision                   → performSave ConflictError
 * - corrupt GC root                 → scheduleAssetGc GcRootScanError
 * - archive trust boundary          → importProjectFileCancellable
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSessionController } from "../../src/app/session-controller";
import {
  GcRootScanError,
  LeaseOwnershipLock,
  MemoryBackend,
  MemoryBusHub,
  ProjectRepository,
  type StorageBackend,
} from "../../src/storage";
import { ArchiveValidationError } from "../../src/io";
import {
  initTelemetry,
  resetTelemetryForTests,
  type SentryEventLike,
  type SentryModuleLike,
} from "../../src/telemetry/sentry";
import { FakeScheduler } from "./storage-fixtures.test";

afterEach(() => resetTelemetryForTests());

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

function fakeTransport() {
  const captured: SentryEventLike[] = [];
  const sentry: SentryModuleLike = {
    init: () => undefined,
    captureEvent: (event) => void captured.push(event),
  };
  return { sentry, captured };
}

const TELEMETRY_ENV = {
  dsn: "https://public@example.ingest.invalid/1",
  release: "dr-glitch@0.1.0",
  environment: "production",
  privateValidation: false,
};

async function enableTelemetry() {
  const transport = fakeTransport();
  await initTelemetry({ env: TELEMETRY_ENV, loadSentry: async () => transport.sentry });
  return transport;
}

/** Backend wrapper whose WRITES fail with `error` while armed. */
function failingWrites(backend: MemoryBackend, isArmed: () => boolean, error: () => Error): StorageBackend {
  return {
    get: (store, key) => backend.get(store, key),
    getAll: (store) => backend.getAll(store),
    getAllKeys: (store) => backend.getAllKeys(store),
    put: (store, key, value) =>
      isArmed() ? Promise.reject(error()) : backend.put(store, key, value),
    delete: (store, key) => (isArmed() ? Promise.reject(error()) : backend.delete(store, key)),
    transaction: (stores, work) =>
      isArmed() ? Promise.reject(error()) : backend.transaction(stores, work),
    close: () => backend.close(),
  };
}

function makeWorld() {
  return { backend: new MemoryBackend(), hub: new MemoryBusHub(), scheduler: new FakeScheduler() };
}

function makeController(
  world: ReturnType<typeof makeWorld>,
  backend: StorageBackend = world.backend,
): AppSessionController {
  return new AppSessionController({
    backend,
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
  });
}

const cyan = (value: number) =>
  ({ type: "separation/set-angle", plate: "cyan", angle: value }) as const;

function quotaError(): Error {
  return new DOMException("QuotaExceededError: db full", "QuotaExceededError") as unknown as Error;
}

/* ------------------------------------------------------------------ */
/* Storage failures                                                    */
/* ------------------------------------------------------------------ */

describe("telemetry — storage failures", () => {
  it("quota during the journal flush: alert + exactly one scrubbed storage-quota event", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    let armed = false;
    const controller = makeController(world, failingWrites(world.backend, () => armed, quotaError));
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Quota Victim");
    expect(captured).toHaveLength(0);

    armed = true;
    open.doc.apply(cyan(77), "Screen angle");
    await controller.flushJournalNow();

    expect(controller.getSnapshot().storageAlert).toMatch(/storage is full/i);
    expect(captured).toHaveLength(1);
    expect(captured[0].tags!.error_code).toBe("storage-quota");
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain("Quota Victim");
    expect(serialized).not.toContain(id);
    // In-memory work preserved; last explicit save untouched.
    expect(open.store.getEnvelope().core.separation.angles.cyan).toBe(77);
    armed = false;
    const saved = await new ProjectRepository(world.backend).load(id);
    expect(saved.core.separation.angles.cyan).toBe(15);
    await controller.dispose();
  });

  it("a generic write failure on Save reports storage-write-failed exactly once", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    let armed = false;
    const controller = makeController(
      world,
      failingWrites(world.backend, () => armed, () => new Error("disk detached mid-write")),
    );
    const id = await controller.createProject();
    await controller.openProject(id);
    armed = true;
    await expect(controller.performSave("Doomed")).rejects.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured[0].tags!.error_code).toBe("storage-write-failed");
    expect(JSON.stringify(captured[0])).not.toContain("Doomed");
    armed = false;
    await controller.dispose();
  });

  it("a CAS collision on Save reports save-conflict (and still throws to the UI)", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    const controller = makeController(world);
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Mine");
    // Another writer bumps the CAS token behind this session's back.
    const repository = new ProjectRepository(world.backend);
    const theirs = await repository.load(id);
    await repository.saveExplicit({ ...theirs, title: "Theirs" });

    open.doc.apply(cyan(60), "Angle");
    await expect(controller.performSave()).rejects.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured[0].tags!.error_code).toBe("save-conflict");
    await controller.dispose();
  });

  it("reports nothing without a DSN", async () => {
    const world = makeWorld();
    let armed = false;
    const controller = makeController(world, failingWrites(world.backend, () => armed, quotaError));
    const id = await controller.createProject();
    const open = await controller.openProject(id);
    await controller.performSave("Silent");
    armed = true;
    open.doc.apply(cyan(50), "Angle");
    await controller.flushJournalNow();
    // Alert still surfaces to the user; no telemetry transport exists.
    expect(controller.getSnapshot().storageAlert).not.toBeNull();
    armed = false;
    await controller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* Asset GC root-scan failure                                          */
/* ------------------------------------------------------------------ */

describe("telemetry — GC root scan", () => {
  it("a GcRootScanError from a GC pass reports gc-root-scan-failed exactly once", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    const controller = makeController(world);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(controller.assets, "garbageCollect").mockRejectedValue(
      new GcRootScanError("projects", "row-1", "unreadable structure"),
    );
    await controller.scheduleAssetGc("test");
    await controller.scheduleAssetGc("test-again"); // same rejected error object
    expect(captured).toHaveLength(1);
    expect(captured[0].tags!.error_code).toBe("gc-root-scan-failed");
    expect(JSON.stringify(captured[0])).not.toContain("row-1");
    warn.mockRestore();
    await controller.dispose();
  });

  it("other GC failures stay log-only (conservative retention is not an event)", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    const controller = makeController(world);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(controller.assets, "garbageCollect").mockRejectedValue(new Error("transient"));
    await controller.scheduleAssetGc("test");
    expect(captured).toHaveLength(0);
    warn.mockRestore();
    await controller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* Archive trust boundary                                              */
/* ------------------------------------------------------------------ */

describe("telemetry — archive import failures", () => {
  function fileOf(bytes: Uint8Array): { size: number; arrayBuffer(): Promise<ArrayBuffer> } {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return { size: bytes.byteLength, arrayBuffer: async () => buffer };
  }

  it("a typed archive rejection reports its stable archive-* code once", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    const controller = makeController(world);
    const handle = controller.importProjectFileCancellable(
      fileOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    );
    const rejection = await handle.promise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(ArchiveValidationError);
    expect(captured).toHaveLength(1);
    const code = captured[0].tags!.error_code as string;
    expect(code.startsWith("archive-")).toBe(true);
    expect(code).not.toBe("archive-aborted");
    await controller.dispose();
  });

  it("user cancellation (archive-aborted) reports nothing", async () => {
    const { captured } = await enableTelemetry();
    const world = makeWorld();
    const controller = makeController(world);
    let releaseRead: (buffer: ArrayBuffer) => void;
    const gate = new Promise<ArrayBuffer>((resolve) => {
      releaseRead = resolve;
    });
    const handle = controller.importProjectFileCancellable({
      size: 8,
      arrayBuffer: () => gate,
    });
    handle.cancel();
    releaseRead!(new ArrayBuffer(8));
    await expect(handle.promise).rejects.toMatchObject({ code: "archive-aborted" });
    expect(captured).toHaveLength(0);
    await controller.dispose();
  });
});
