import { describe, expect, it } from "vitest";
import { MemoryBackend, MemoryBusHub } from "../../src/storage/memory-backend";
import {
  LEASE_TTL_MS,
  LeaseOwnershipLock,
  acquireOwnership,
} from "../../src/storage/ownership";
import type { LeaseRecordV1 } from "../../src/storage/schema";
import { FakeScheduler } from "./storage-fixtures.test";

function setup() {
  const backend = new MemoryBackend();
  const scheduler = new FakeScheduler();
  const hub = new MemoryBusHub();
  const makeLock = () =>
    new LeaseOwnershipLock(backend, { now: scheduler.clock, timer: scheduler.timer });
  return { backend, scheduler, hub, makeLock };
}

describe("LeaseOwnershipLock", () => {
  it("grants the lock to the first acquirer and refuses the second", async () => {
    const { makeLock } = setup();
    const first = await makeLock().tryAcquire("p1");
    expect(first.acquired).toBe(true);
    const second = await makeLock().tryAcquire("p1");
    expect(second.acquired).toBe(false);
  });

  it("release frees the lease for the next acquirer", async () => {
    const { backend, makeLock } = setup();
    const first = await makeLock().tryAcquire("p1");
    await first.release();
    expect(await backend.get("leases", "p1")).toBeUndefined();
    const second = await makeLock().tryAcquire("p1");
    expect(second.acquired).toBe(true);
  });

  it("an expired lease (crashed owner) can be stolen", async () => {
    const { scheduler, makeLock } = setup();
    const crashed = await makeLock().tryAcquire("p1");
    expect(crashed.acquired).toBe(true);
    // Simulate a crash: no release, no heartbeat. Cancel its timers by
    // never firing them — advance the clock only.
    scheduler.nowMs += LEASE_TTL_MS + 1;
    const thief = await makeLock().tryAcquire("p1");
    expect(thief.acquired).toBe(true);
  });

  it("heartbeat renews the lease so a live owner is never stolen from", async () => {
    const { backend, scheduler, makeLock } = setup();
    const owner = await makeLock().tryAcquire("p1");
    expect(owner.acquired).toBe(true);

    // Advance well past the original TTL; heartbeats fire along the way.
    await scheduler.advance(LEASE_TTL_MS * 3);
    const lease = await backend.get<LeaseRecordV1>("leases", "p1");
    expect(lease).toBeDefined();
    expect(lease!.expiresAt).toBeGreaterThan(scheduler.nowMs);

    const rival = await makeLock().tryAcquire("p1");
    expect(rival.acquired).toBe(false);

    // After release the heartbeat stops and the lease is gone.
    await owner.release();
    expect(await backend.get("leases", "p1")).toBeUndefined();
    await scheduler.advance(LEASE_TTL_MS * 2);
    expect(await backend.get("leases", "p1")).toBeUndefined();
  });

  it("does not delete a lease it no longer owns on release", async () => {
    const { backend, scheduler, makeLock } = setup();
    const stale = await makeLock().tryAcquire("p1");
    scheduler.nowMs += LEASE_TTL_MS + 1;
    const current = await makeLock().tryAcquire("p1");
    expect(current.acquired).toBe(true);
    await stale.release();
    const lease = await backend.get<LeaseRecordV1>("leases", "p1");
    expect(lease).toBeDefined();
  });
});

describe("acquireOwnership", () => {
  it("second tab opens read-only and can request a takeover the owner observes", async () => {
    const { hub, makeLock } = setup();
    const owner = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    const reader = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    expect(owner.status).toBe("owner");
    expect(reader.status).toBe("readonly");

    let takeoverRequests = 0;
    owner.onTakeoverRequested(() => {
      takeoverRequests += 1;
    });
    reader.requestTakeover();
    expect(takeoverRequests).toBe(1);
  });

  it("release notifies waiting tabs, which can then acquire ownership", async () => {
    const { hub, makeLock } = setup();
    const owner = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    const readerBus = hub.connect();
    const reader = await acquireOwnership("p1", { lock: makeLock(), bus: readerBus });
    expect(reader.status).toBe("readonly");

    let released = false;
    reader.onOwnershipReleased(() => {
      released = true;
    });
    await owner.release();
    expect(released).toBe(true);

    const retry = await acquireOwnership("p1", { lock: makeLock(), bus: readerBus });
    expect(retry.status).toBe("owner");
  });

  it("broadcasts explicit-save change notifications to other tabs only", async () => {
    const { hub, makeLock } = setup();
    const owner = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    const reader = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });

    const ownerSaw: number[] = [];
    const readerSaw: number[] = [];
    owner.onProjectChanged((revision) => ownerSaw.push(revision));
    reader.onProjectChanged((revision) => readerSaw.push(revision));

    owner.notifyProjectChanged(7);
    expect(readerSaw).toEqual([7]);
    // BroadcastChannel semantics: the sender does not hear itself.
    expect(ownerSaw).toEqual([]);
  });

  it("ignores messages for other projects", async () => {
    const { hub, makeLock } = setup();
    const owner = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    const other = await acquireOwnership("p2", { lock: makeLock(), bus: hub.connect() });
    let takeovers = 0;
    owner.onTakeoverRequested(() => {
      takeovers += 1;
    });
    other.requestTakeover();
    expect(takeovers).toBe(0);
  });

  it("unsubscribing a takeover callback stops notifications", async () => {
    const { hub, makeLock } = setup();
    const owner = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    const reader = await acquireOwnership("p1", { lock: makeLock(), bus: hub.connect() });
    let takeovers = 0;
    const unsubscribe = owner.onTakeoverRequested(() => {
      takeovers += 1;
    });
    reader.requestTakeover();
    unsubscribe();
    reader.requestTakeover();
    expect(takeovers).toBe(1);
  });
});
