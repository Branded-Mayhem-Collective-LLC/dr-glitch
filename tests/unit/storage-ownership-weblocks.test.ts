/**
 * WEBLOCKS-RACE regression suite (resume-brief item 6), on the UA-faithful
 * FakeWebLocks + async bus doubles:
 *
 *  (a) cooperative two-tab handoff converges on the previously racy path
 *      (release notifications and probe grants interleave asynchronously);
 *  (b) duplicate release notifications cause no double-acquisition;
 *  (c) three tabs with two successive SILENT owner crashes — ownership
 *      converges each time, in lock-queue FIFO order;
 *  (d) former-owner recovery: after a handoff the old owner re-arms as a
 *      waiter and regains ownership when the new owner dies;
 *  (e) release() is an idempotent postcondition sharing one promise, and
 *      resolves only after the user agent actually unlocked;
 *  (f) no leaked parked requests after dispose (pendingCount 0), including
 *      a probe grant that was never adopted.
 *
 * Chosen priority semantics: the lock layer's own queue decides the next
 * owner — Web Locks UA FIFO request order (the earliest parked probe wins a
 * freed lock), lease mode TTL-boundary retry with wait-first grace. No
 * separate request IDs: FIFO park order IS the priority.
 */
import { describe, expect, it } from "vitest";
import {
  NullOwnershipBus,
  WebLocksOwnershipLock,
  acquireOwnership,
  type OwnershipDeps,
  type OwnershipHandle,
  type OwnershipLock,
} from "../../src/storage/ownership";
import { AsyncBusHub, FakeWebLocks, settle } from "./storage-ownership-fakes.test";

const PROJECT = "p1";
const NAME = `dr-glitch:project:${PROJECT}`;

function makeLock(fake: FakeWebLocks): WebLocksOwnershipLock {
  return new WebLocksOwnershipLock(fake as unknown as LockManager);
}

/** The session layer's re-arm wrapper: waits, never races tryAcquire. */
function waiterLock(real: OwnershipLock): OwnershipLock {
  return {
    tryAcquire: async () => ({ acquired: false, release: async () => undefined }),
    acquireWhenAvailable: real.acquireWhenAvailable!.bind(real),
  };
}

/**
 * Controller-style promotion loop: on every released signal, adopt the held
 * probe grant if there is one, else fall back to a fresh acquire attempt.
 * Counts promotions so double-acquisition is detectable.
 */
function promoteOnRelease(
  handle: OwnershipHandle,
  deps: OwnershipDeps,
  sink: { promoted: OwnershipHandle | null; promotions: number; signals: number },
): void {
  handle.onOwnershipReleased(() => {
    sink.signals += 1;
    void (async () => {
      if (sink.promoted) return;
      const owned =
        handle.adoptPendingOwnership() ?? (await acquireOwnership(PROJECT, deps));
      if (owned.status !== "owner") {
        await owned.release();
        return;
      }
      if (sink.promoted) {
        await owned.release();
        return;
      }
      sink.promoted = owned;
      sink.promotions += 1;
    })();
  });
}

describe("(e) release() postcondition and idempotence", () => {
  it("shares one promise and resolves only after the UA actually unlocked", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const attempt = await lock.tryAcquire(PROJECT);
    expect(attempt.acquired).toBe(true);
    expect(fake.isHeld(NAME)).toBe(true);

    const first = attempt.release();
    const second = attempt.release();
    expect(second).toBe(first); // shared promise
    // Postcondition, not an instant: the UA unlock is still in flight.
    expect(fake.isHeld(NAME)).toBe(true);
    await first;
    expect(fake.isHeld(NAME)).toBe(false);
    await attempt.release(); // still idempotent after settlement
    expect(fake.isHeld(NAME)).toBe(false);
  });

  it("an ownership handle publishes the release notification exactly once across repeated release()", async () => {
    const fake = new FakeWebLocks();
    const hub = new AsyncBusHub();
    const ownerBus = hub.connect();
    const witness = hub.connect();
    let releasedMessages = 0;
    witness.subscribe((message) => {
      if (message.type === "ownership-released") releasedMessages += 1;
    });

    const owner = await acquireOwnership(PROJECT, { lock: makeLock(fake), bus: ownerBus });
    expect(owner.status).toBe("owner");
    const first = owner.release();
    const second = owner.release();
    expect(second).toBe(first);
    await Promise.all([first, second, owner.release()]);
    await settle();
    expect(releasedMessages).toBe(1);
    expect(fake.isHeld(NAME)).toBe(false);
  });
});

describe("(a) cooperative handoff over the async bus", () => {
  it("second tab requests takeover, first releases, second acquires — exactly once", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const hub = new AsyncBusHub();
    const busA = hub.connect();
    const busB = hub.connect();

    const a = await acquireOwnership(PROJECT, { lock, bus: busA });
    const b = await acquireOwnership(PROJECT, { lock, bus: busB });
    await settle();
    expect(a.status).toBe("owner");
    expect(b.status).toBe("readonly");
    expect(fake.pendingCount(NAME)).toBe(1); // b's probe parked, FIFO slot 1

    const sink = { promoted: null as OwnershipHandle | null, promotions: 0, signals: 0 };
    promoteOnRelease(b, { lock, bus: busB }, sink);
    a.onTakeoverRequested(() => {
      void a.release();
    });

    b.requestTakeover();
    await settle(600);

    // The released signal arrives via the bus AND via the probe grant; the
    // handoff still converges on exactly one promotion.
    expect(sink.signals).toBeGreaterThanOrEqual(1);
    expect(sink.promotions).toBe(1);
    expect(sink.promoted!.status).toBe("owner");
    expect(fake.heldCount).toBe(1); // the adopted grant, nothing else

    await b.release(); // old readonly handle: adopted grant is NOT touched
    expect(fake.isHeld(NAME)).toBe(true);
    await sink.promoted!.release();
    await settle();
    expect(fake.heldCount).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });
});

describe("(b) duplicate release notifications", () => {
  it("forged/duplicate released messages cause no double-acquisition and leak no probes", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const hub = new AsyncBusHub();
    const a = await acquireOwnership(PROJECT, { lock, bus: hub.connect() });
    const busB = hub.connect();
    const b = await acquireOwnership(PROJECT, { lock, bus: busB });
    await settle();
    expect(fake.pendingCount(NAME)).toBe(1);

    const sink = { promoted: null as OwnershipHandle | null, promotions: 0, signals: 0 };
    promoteOnRelease(b, { lock, bus: busB }, sink);

    // Duplicates while the owner still holds: promotion must NOT happen,
    // and every transient retry probe must be reclaimed.
    const attacker = hub.connect();
    attacker.publish({ type: "ownership-released", projectId: PROJECT });
    attacker.publish({ type: "ownership-released", projectId: PROJECT });
    await settle(600);
    expect(sink.signals).toBe(2);
    expect(sink.promotions).toBe(0);
    expect(fake.isHeld(NAME)).toBe(true); // still tab A's lock
    expect(fake.pendingCount(NAME)).toBe(1); // only b's original probe

    // A real release afterwards still promotes exactly once, despite more
    // duplicates arriving around it.
    await a.release();
    attacker.publish({ type: "ownership-released", projectId: PROJECT });
    attacker.publish({ type: "ownership-released", projectId: PROJECT });
    await settle(600);
    expect(sink.promotions).toBe(1);
    expect(b.adoptPendingOwnership()).toBeNull(); // at most one adoption
    expect(fake.heldCount).toBe(1);

    await b.release();
    await sink.promoted!.release();
    await settle();
    expect(fake.heldCount).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });
});

describe("(c) three tabs, two successive silent owner crashes", () => {
  it("ownership converges each time, in FIFO park order, with no bus at all", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const bus = new NullOwnershipBus();

    const a = await acquireOwnership(PROJECT, { lock, bus });
    const b = await acquireOwnership(PROJECT, { lock, bus });
    const c = await acquireOwnership(PROJECT, { lock, bus });
    await settle();
    expect(a.status).toBe("owner");
    expect(fake.pendingCount(NAME)).toBe(2); // b then c, FIFO

    let bOwner: OwnershipHandle | null = null;
    let cOwner: OwnershipHandle | null = null;
    b.onOwnershipReleased(() => {
      bOwner ??= b.adoptPendingOwnership();
    });
    c.onOwnershipReleased(() => {
      cOwner ??= c.adoptPendingOwnership();
    });

    fake.crash(NAME); // owner A dies silently — no message anywhere
    await settle();
    expect(bOwner).not.toBeNull(); // FIFO: b parked first, b wins
    expect(bOwner!.status).toBe("owner");
    expect(cOwner).toBeNull();
    expect(fake.heldCount).toBe(1);
    expect(fake.pendingCount(NAME)).toBe(1); // c still parked

    fake.crash(NAME); // owner B dies silently too
    await settle();
    expect(cOwner).not.toBeNull();
    expect(cOwner!.status).toBe("owner");
    expect(fake.heldCount).toBe(1);
    expect(fake.pendingCount(NAME)).toBe(0);

    // Cleanup: only the survivors release (crashed tabs are gone).
    await cOwner!.release();
    await c.release();
    await b.release();
    await settle();
    expect(fake.heldCount).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });
});

describe("(d) former-owner recovery", () => {
  it("after a handoff the old owner re-arms as a waiter and adopts the lock when the new owner dies", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const bus = new NullOwnershipBus();

    const a = await acquireOwnership(PROJECT, { lock, bus });
    const b = await acquireOwnership(PROJECT, { lock, bus });
    await settle();

    let bOwner: OwnershipHandle | null = null;
    b.onOwnershipReleased(() => {
      bOwner ??= b.adoptPendingOwnership();
    });
    await a.release(); // cooperative handoff (silent bus: probe path only)
    await settle();
    expect(bOwner!.status).toBe("owner");

    // A re-arms exactly like the session layer: a pure waiter, parked
    // BEHIND any other requester, never racing tryAcquire.
    const aWaiter = await acquireOwnership(PROJECT, { lock: waiterLock(lock), bus });
    expect(aWaiter.status).toBe("readonly");
    await settle();
    expect(fake.pendingCount(NAME)).toBe(1);

    let aRecovered: OwnershipHandle | null = null;
    aWaiter.onOwnershipReleased(() => {
      aRecovered ??= aWaiter.adoptPendingOwnership();
    });

    fake.crash(NAME); // the new owner dies silently
    await settle();
    expect(aRecovered).not.toBeNull();
    expect(aRecovered!.status).toBe("owner");
    expect(fake.heldCount).toBe(1);

    await aRecovered!.release();
    await aWaiter.release();
    await b.release();
    await settle();
    expect(fake.heldCount).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });
});

describe("(f) no leaked parked requests after dispose", () => {
  it("releasing waiting handles reclaims parked probes", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const bus = new NullOwnershipBus();
    const a = await acquireOwnership(PROJECT, { lock, bus });
    const b = await acquireOwnership(PROJECT, { lock, bus });
    const c = await acquireOwnership(PROJECT, { lock, bus });
    await settle();
    expect(fake.pendingCount(NAME)).toBe(2);

    await c.release();
    await b.release();
    await settle();
    expect(fake.pendingCount(NAME)).toBe(0);
    await a.release();
    expect(fake.heldCount).toBe(0);
  });

  it("a probe grant that was never adopted is handed back on release()", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const bus = new NullOwnershipBus();
    const owner = await acquireOwnership(PROJECT, { lock, bus });
    const reader = await acquireOwnership(PROJECT, { lock, bus });
    await settle();

    let notified = 0;
    reader.onOwnershipReleased(() => {
      notified += 1; // deliberately does NOT adopt
    });
    await owner.release();
    await settle();
    expect(notified).toBe(1);
    expect(fake.isHeld(NAME)).toBe(true); // held FOR adoption

    await reader.release(); // never adopted: the grant goes back to the UA
    await settle();
    expect(fake.isHeld(NAME)).toBe(false);
    expect(fake.heldCount).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });

  it("release() racing the probe grant leaves nothing held and nothing parked", async () => {
    const fake = new FakeWebLocks();
    const lock = makeLock(fake);
    const bus = new NullOwnershipBus();
    const owner = await acquireOwnership(PROJECT, { lock, bus });
    const reader = await acquireOwnership(PROJECT, { lock, bus });
    await settle();

    // Fire both concurrently: the grant may or may not beat the abort —
    // either way the final state must be fully reclaimed.
    await Promise.all([owner.release(), reader.release()]);
    await settle();
    expect(fake.heldCount).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });
});
