import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import { ProjectRepository, TRASH_RETENTION_MS } from "../../src/storage/project-repository";
import { ConflictError, NotFoundError } from "../../src/storage/errors";
import type { ProjectEnvelopeV1 } from "../../src/core/types";
import { FakeScheduler, makeCore } from "./storage-fixtures.test";

function setup(): { backend: MemoryBackend; repo: ProjectRepository; scheduler: FakeScheduler } {
  const backend = new MemoryBackend();
  const scheduler = new FakeScheduler();
  scheduler.nowMs = 1_000;
  const repo = new ProjectRepository(backend, { now: scheduler.clock });
  return { backend, repo, scheduler };
}

describe("ProjectRepository", () => {
  it("creates projects at savedRevision 1 and lists them most recent first", async () => {
    const { repo, scheduler } = setup();
    const first = await repo.create("First", makeCore());
    scheduler.nowMs = 2_000;
    const second = await repo.create("Second", makeCore());
    expect(first.savedRevision).toBe(1);
    const list = await repo.list();
    expect(list.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({ title: "Second", updatedAt: 2_000, snapshotCount: 0 });
  });

  it("saveExplicit increments savedRevision via compare-and-swap", async () => {
    const { repo } = setup();
    const created = await repo.create("P", makeCore());
    const saved = await repo.saveExplicit({ ...created, title: "P edited" });
    expect(saved.savedRevision).toBe(2);
    expect((await repo.load(created.id)).title).toBe("P edited");
  });

  it("rejects a stale save with ConflictError and never silently overwrites", async () => {
    const { repo } = setup();
    const created = await repo.create("P", makeCore());
    // Two tabs load revision 1; tab A saves first.
    const tabA: ProjectEnvelopeV1 = { ...created, title: "from A" };
    const tabB: ProjectEnvelopeV1 = { ...created, title: "from B" };
    await repo.saveExplicit(tabA);
    const failure = await repo.saveExplicit(tabB).catch((error) => error);
    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure).toMatchObject({
      projectId: created.id,
      expectedRevision: 1,
      actualRevision: 2,
    });
    const stored = await repo.load(created.id);
    expect(stored.title).toBe("from A");
    expect(stored.savedRevision).toBe(2);
  });

  it("rejects saving a project that does not exist", async () => {
    const { repo } = setup();
    const ghost: ProjectEnvelopeV1 = {
      schema: 1,
      id: "missing",
      title: "Ghost",
      createdAt: 0,
      updatedAt: 0,
      savedRevision: 1,
      core: makeCore(),
      snapshots: [],
    };
    await expect(repo.saveExplicit(ghost)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rename updates title, bumps savedRevision, and conflicts stale saves", async () => {
    const { repo, scheduler } = setup();
    const created = await repo.create("Old name", makeCore());
    scheduler.nowMs = 5_000;
    const renamed = await repo.rename(created.id, "New name");
    expect(renamed).toMatchObject({ title: "New name", savedRevision: 2, updatedAt: 5_000 });
    // A writer still holding revision 1 must now conflict, not revert the title.
    await expect(repo.saveExplicit({ ...created, title: "stale" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("duplicate deep-copies under a new id and fresh revision", async () => {
    const { repo, scheduler } = setup();
    const created = await repo.create("Original", makeCore());
    const withEdit = await repo.saveExplicit({
      ...created,
      core: { ...created.core, grid: { visible: true, size: 48 } },
    });
    scheduler.nowMs = 9_000;
    const copy = await repo.duplicate(created.id);
    expect(copy.id).not.toBe(created.id);
    expect(copy).toMatchObject({
      title: "Original copy",
      savedRevision: 1,
      createdAt: 9_000,
      updatedAt: 9_000,
    });
    expect(copy.core.grid).toEqual({ visible: true, size: 48 });
    // Mutating the copy's core must not leak into the source.
    copy.core.grid.size = 1;
    expect((await repo.load(withEdit.id)).core.grid.size).toBe(48);
    expect((await repo.list()).length).toBe(2);
  });

  it("moveToTrash hides from list, keeps envelope, and restore brings it back", async () => {
    const { repo, scheduler } = setup();
    const kept = await repo.create("Kept", makeCore());
    const trashed = await repo.create("Trashed", makeCore());
    scheduler.nowMs = 10_000;
    const record = await repo.moveToTrash(trashed.id);
    expect(record).toEqual({
      projectId: trashed.id,
      deletedAt: 10_000,
      expiresAt: 10_000 + TRASH_RETENTION_MS,
      title: "Trashed",
    });
    expect((await repo.list()).map((p) => p.id)).toEqual([kept.id]);
    expect((await repo.listTrash()).map((t) => t.projectId)).toEqual([trashed.id]);
    // Envelope survives while in trash (asset-GC root, restore source).
    expect((await repo.load(trashed.id)).title).toBe("Trashed");

    const restored = await repo.restore(trashed.id);
    expect(restored.id).toBe(trashed.id);
    expect(await repo.listTrash()).toEqual([]);
    expect((await repo.list()).length).toBe(2);
  });

  it("deletePermanently removes envelope, trash record, and recovery", async () => {
    const { backend, repo } = setup();
    const project = await repo.create("Doomed", makeCore());
    await backend.put("recovery", project.id, { projectId: project.id });
    await repo.moveToTrash(project.id);
    await repo.deletePermanently(project.id);
    expect(await backend.get("projects", project.id)).toBeUndefined();
    expect(await backend.get("trash", project.id)).toBeUndefined();
    expect(await backend.get("recovery", project.id)).toBeUndefined();
  });

  it("emptyTrash permanently deletes every trashed project", async () => {
    const { repo } = setup();
    const a = await repo.create("A", makeCore());
    const b = await repo.create("B", makeCore());
    const kept = await repo.create("Kept", makeCore());
    await repo.moveToTrash(a.id);
    await repo.moveToTrash(b.id);
    expect(await repo.emptyTrash()).toBe(2);
    expect(await repo.listTrash()).toEqual([]);
    await expect(repo.load(a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.load(b.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await repo.list()).map((p) => p.id)).toEqual([kept.id]);
  });

  it("sweeps only trash entries past the 30-day expiry on the injected clock", async () => {
    const { repo, scheduler } = setup();
    const old = await repo.create("Old", makeCore());
    const fresh = await repo.create("Fresh", makeCore());
    scheduler.nowMs = 10_000;
    await repo.moveToTrash(old.id);
    scheduler.nowMs = 10_000 + 15 * 24 * 60 * 60 * 1000;
    await repo.moveToTrash(fresh.id);

    // Day 29 after the first deletion: nothing expires.
    scheduler.nowMs = 10_000 + 29 * 24 * 60 * 60 * 1000;
    expect(await repo.sweepExpiredTrash()).toBe(0);

    // Day 30: only the old entry expires.
    scheduler.nowMs = 10_000 + TRASH_RETENTION_MS;
    expect(await repo.sweepExpiredTrash()).toBe(1);
    await expect(repo.load(old.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await repo.listTrash()).map((t) => t.projectId)).toEqual([fresh.id]);
    expect((await repo.load(fresh.id)).title).toBe("Fresh");
  });
});
