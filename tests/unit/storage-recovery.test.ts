import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import { RECOVERY_DEBOUNCE_MS, RecoveryJournal } from "../../src/storage/recovery";
import { ProjectRepository } from "../../src/storage/project-repository";
import { StorageQuotaError } from "../../src/storage/errors";
import type { RecoveryRecordV1 } from "../../src/core/types";
import { FakeScheduler, makeCore, makeRecovery } from "./storage-fixtures.test";

function setup(onError?: (error: unknown) => void) {
  const backend = new MemoryBackend();
  const scheduler = new FakeScheduler();
  const journal = new RecoveryJournal(backend, { timer: scheduler.timer, onError });
  return { backend, scheduler, journal };
}

describe("RecoveryJournal", () => {
  it("debounces journaling by ~750ms and coalesces rapid edits", async () => {
    const { backend, scheduler, journal } = setup();
    const first = makeRecovery({ projectId: "p1", revision: 2 });
    journal.scheduleJournal(first);

    await scheduler.advance(700);
    expect(await backend.get("recovery", "p1")).toBeUndefined();

    // A newer edit inside the window resets the debounce and wins.
    const second: RecoveryRecordV1 = { ...first, revision: 3 };
    journal.scheduleJournal(second);
    await scheduler.advance(700);
    expect(await backend.get("recovery", "p1")).toBeUndefined();

    await scheduler.advance(RECOVERY_DEBOUNCE_MS);
    const stored = await backend.get<RecoveryRecordV1>("recovery", "p1");
    expect(stored?.revision).toBe(3);
    expect(journal.latestInMemory("p1")).toBeUndefined();
  });

  it("flushNow persists immediately for lifecycle events", async () => {
    const { backend, scheduler, journal } = setup();
    journal.scheduleJournal(makeRecovery({ projectId: "p1", revision: 5 }));
    await journal.flushNow();
    expect((await backend.get<RecoveryRecordV1>("recovery", "p1"))?.revision).toBe(5);
    // Debounce timer was cancelled; nothing left to fire.
    expect(scheduler.pendingCount).toBe(0);
  });

  it("loadNewer returns only recovery ahead of the last explicit save", async () => {
    const { backend, journal } = setup();
    await backend.put("recovery", "p1", makeRecovery({ projectId: "p1", revision: 4, savedRevision: 3 }));
    expect((await journal.loadNewer("p1", 3))?.revision).toBe(4);
    expect(await journal.loadNewer("p1", 4)).toBeNull();
    expect(await journal.loadNewer("p1", 9)).toBeNull();
    expect(await journal.loadNewer("missing", 0)).toBeNull();
  });

  it("clear cancels pending work and deletes the stored journal", async () => {
    const { backend, scheduler, journal } = setup();
    await backend.put("recovery", "p1", makeRecovery({ projectId: "p1" }));
    journal.scheduleJournal(makeRecovery({ projectId: "p1", revision: 7 }));
    await journal.clear("p1");
    expect(await backend.get("recovery", "p1")).toBeUndefined();
    expect(journal.latestInMemory("p1")).toBeUndefined();
    await scheduler.advance(2_000);
    expect(await backend.get("recovery", "p1")).toBeUndefined();
  });

  it("quota failure keeps the in-memory copy, surfaces StorageQuotaError, and never corrupts the last save", async () => {
    const backend = new MemoryBackend();
    const scheduler = new FakeScheduler();
    const errors: unknown[] = [];
    const journal = new RecoveryJournal(backend, {
      timer: scheduler.timer,
      onError: (error) => errors.push(error),
    });

    // An explicitly saved project exists on disk.
    const repo = new ProjectRepository(backend, { now: scheduler.clock });
    const project = await repo.create("Saved", makeCore());

    backend.simulateQuotaExceeded = true;
    const record = makeRecovery({ projectId: project.id, revision: 2, savedRevision: 1 });
    journal.scheduleJournal(record);

    // Debounced flush reports through onError with the typed error.
    await scheduler.advance(1_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StorageQuotaError);

    // Explicit flush surfaces the same typed error.
    await expect(journal.flushNow()).rejects.toBeInstanceOf(StorageQuotaError);

    // In-memory copy survives; nothing was written; the save is intact.
    expect(journal.latestInMemory(project.id)?.revision).toBe(2);
    expect(await backend.get("recovery", project.id)).toBeUndefined();
    const saved = await repo.load(project.id);
    expect(saved.title).toBe("Saved");
    expect(saved.savedRevision).toBe(1);

    // Once space frees up, the retained copy flushes cleanly.
    backend.simulateQuotaExceeded = false;
    await journal.flushNow();
    expect((await backend.get<RecoveryRecordV1>("recovery", project.id))?.revision).toBe(2);
    expect(journal.latestInMemory(project.id)).toBeUndefined();
  });
});
