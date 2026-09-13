import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import { STORE_NAMES } from "../../src/storage/schema";

describe("MemoryBackend", () => {
  it("provides every schema store", async () => {
    const backend = new MemoryBackend();
    for (const store of STORE_NAMES) {
      expect(await backend.getAll(store)).toEqual([]);
    }
  });

  it("round-trips values with clone isolation", async () => {
    const backend = new MemoryBackend();
    const value = { nested: { list: [1, 2, 3] } };
    await backend.put("projects", "p1", value);
    value.nested.list.push(4);
    const stored = await backend.get<typeof value>("projects", "p1");
    expect(stored?.nested.list).toEqual([1, 2, 3]);
    stored?.nested.list.push(5);
    expect((await backend.get<typeof value>("projects", "p1"))?.nested.list).toEqual([1, 2, 3]);
  });

  it("rolls back every write when a transaction throws", async () => {
    const backend = new MemoryBackend();
    await backend.put("projects", "keep", { title: "before" });
    await expect(
      backend.transaction(["projects", "trash"], async (tx) => {
        await tx.put("projects", "keep", { title: "changed" });
        await tx.put("projects", "new", { title: "new" });
        await tx.put("trash", "keep", { deletedAt: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await backend.get("projects", "keep")).toEqual({ title: "before" });
    expect(await backend.get("projects", "new")).toBeUndefined();
    expect(await backend.get("trash", "keep")).toBeUndefined();
  });

  it("rejects access to stores outside the transaction scope", async () => {
    const backend = new MemoryBackend();
    await expect(
      backend.transaction(["projects"], async (tx) => {
        await tx.put("assets", "x", { record: {} });
      }),
    ).rejects.toThrow(/not included/);
  });

  it("serializes overlapping transactions", async () => {
    const backend = new MemoryBackend();
    const order: string[] = [];
    const first = backend.transaction(["projects"], async (tx) => {
      order.push("first-start");
      await tx.put("projects", "p", { n: 1 });
      await Promise.resolve();
      order.push("first-end");
    });
    const second = backend.transaction(["projects"], async (tx) => {
      order.push("second-start");
      const current = await tx.get<{ n: number }>("projects", "p");
      await tx.put("projects", "p", { n: (current?.n ?? 0) + 1 });
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(await backend.get("projects", "p")).toEqual({ n: 2 });
  });

  it("throws QuotaExceededError-named errors when simulating quota", async () => {
    const backend = new MemoryBackend();
    backend.simulateQuotaExceeded = true;
    await expect(backend.put("recovery", "p", {})).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
  });

  it("commits its writes without overwriting independent puts and deletes", async () => {
    const backend = new MemoryBackend();
    await backend.put("recovery", "deleted", { revision: 1 });
    await backend.transaction(["projects", "recovery"], async (tx) => {
      await tx.put("projects", "owned", { title: "transaction" });
      await backend.put("projects", "independent", { title: "another caller" });
      await backend.delete("recovery", "deleted");
    });
    expect(await backend.get("projects", "owned")).toEqual({ title: "transaction" });
    expect(await backend.get("projects", "independent")).toEqual({ title: "another caller" });
    expect(await backend.get("recovery", "deleted")).toBeUndefined();
  });

  it("rolls back its writes while preserving an independent write", async () => {
    const backend = new MemoryBackend();
    await expect(backend.transaction(["projects"], async (tx) => {
      await tx.put("projects", "rolled-back", {});
      await backend.put("projects", "independent", {});
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await backend.getAllKeys("projects")).toEqual(["independent"]);
  });

  it("aborts stalled work without letting its late continuation recreate rows", async () => {
    const backend = new MemoryBackend();
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let continued!: () => void;
    const finished = new Promise<void>((resolve) => { continued = resolve; });
    let lateError: unknown;
    const run = backend.transaction(["staging"], async (tx) => {
      await tx.put("staging", "before-abort", {});
      started();
      await blocked;
      try { await tx.put("staging", "late", {}); }
      catch (error) { lateError = error; }
      finally { continued(); }
    }, controller.signal);
    await ready;
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(await backend.getAllKeys("staging")).toEqual([]);
    release();
    await finished;
    expect(lateError).toMatchObject({ name: "AbortError" });
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });
});
