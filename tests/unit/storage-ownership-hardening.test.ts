/**
 * Ownership hardening: (1) bus message validation — arbitrary same-origin
 * data on the channel must cause zero callback invocations, zero state
 * change, zero exceptions; (2) crash-release reacquisition — a waiting
 * read-only tab must gain ownership when the owner dies SILENTLY (no bus
 * message: Web Locks releases on tab death, a lease simply expires), in both
 * lock modes, with NullOwnershipBus, and with clean cancellation on
 * release() (no leaked timers or queued lock requests).
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend, MemoryBusHub } from "../../src/storage/memory-backend";
import {
  LEASE_TTL_MS,
  LeaseOwnershipLock,
  NullOwnershipBus,
  WebLocksOwnershipLock,
  acquireOwnership,
  sanitizeOwnershipMessage,
  type OwnershipMessage,
} from "../../src/storage/ownership";
import type { LeaseRecordV1 } from "../../src/storage/schema";
import { FakeScheduler } from "./storage-fixtures.test";

/* ------------------------------------------------------------------ */
/* Fake LockManager with real queue semantics                          */
/* ------------------------------------------------------------------ */

type Waiter = {
  aborted: boolean;
  run: () => void;
  reject: (error: unknown) => void;
};

class FakeLockManager {
  locked = false;
  private waiters: Waiter[] = [];

  get queuedCount(): number {
    return this.waiters.filter((waiter) => !waiter.aborted).length;
  }

  request(
    _name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (options?.ifAvailable) {
      if (this.locked) return Promise.resolve(callback(null));
      return this.hold(callback);
    }
    if (options?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    if (!this.locked) return this.hold(callback);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        aborted: false,
        run: () => void this.hold(callback).then(resolve, reject),
        reject,
      };
      options?.signal?.addEventListener(
        "abort",
        () => {
          waiter.aborted = true;
          waiter.reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
      this.waiters.push(waiter);
    });
  }

  private async hold(callback: (lock: unknown) => Promise<unknown>): Promise<unknown> {
    this.locked = true;
    try {
      return await callback({ name: "held" });
    } finally {
      this.locked = false;
      this.next();
    }
  }

  private next(): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.aborted) continue;
      waiter.run();
      return;
    }
  }
}

const settle = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

/* ------------------------------------------------------------------ */
/* Bus message validation                                              */
/* ------------------------------------------------------------------ */

describe("sanitizeOwnershipMessage", () => {
  const good: OwnershipMessage = { type: "takeover-request", projectId: "p1" };

  it("accepts exactly the three well-formed message shapes", () => {
    expect(sanitizeOwnershipMessage(good)).toEqual(good);
    expect(
      sanitizeOwnershipMessage({ type: "ownership-released", projectId: "p1" }),
    ).toEqual({ type: "ownership-released", projectId: "p1" });
    expect(
      sanitizeOwnershipMessage({ type: "project-changed", projectId: "p1", savedRevision: 3 }),
    ).toEqual({ type: "project-changed", projectId: "p1", savedRevision: 3 });
  });

  it("rejects a malformed corpus without throwing", () => {
    const oversized = "x".repeat(4096);
    const corpus: unknown[] = [
      null,
      undefined,
      0,
      1,
      NaN,
      "takeover-request",
      true,
      [],
      ["takeover-request"],
      {},
      { type: "takeover-request" }, // no projectId
      { type: "takeover-request", projectId: "" },
      { type: "takeover-request", projectId: oversized },
      { type: "takeover-request", projectId: 7 },
      { type: "self-destruct", projectId: "p1" }, // unknown type
      { type: "takeover-request", projectId: "p1", extra: 1 }, // extra field
      { type: "project-changed", projectId: "p1" }, // missing revision
      { type: "project-changed", projectId: "p1", savedRevision: -1 },
      { type: "project-changed", projectId: "p1", savedRevision: 1.5 },
      { type: "project-changed", projectId: "p1", savedRevision: Infinity },
      { type: "project-changed", projectId: "p1", savedRevision: NaN },
      { type: "project-changed", projectId: "p1", savedRevision: "3" },
      new Map(),
      new (class Custom {})(),
      Object.assign(Object.create({ evil: true }), { type: "takeover-request", projectId: "p1" }),
    ];
    for (const data of corpus) {
      expect(sanitizeOwnershipMessage(data)).toBeNull();
    }
  });

  it("rejects getter-bearing objects WITHOUT invoking the getter", () => {
    let invoked = false;
    const trap = {};
    Object.defineProperty(trap, "type", {
      enumerable: true,
      get() {
        invoked = true;
        return "takeover-request";
      },
    });
    Object.defineProperty(trap, "projectId", { enumerable: true, get: () => "p1" });
    expect(sanitizeOwnershipMessage(trap)).toBeNull();
    expect(invoked).toBe(false);
  });

  it("rejects symbol-keyed and non-enumerable payload tricks", () => {
    const symboled = { type: "takeover-request", projectId: "p1" } as Record<
      string | symbol,
      unknown
    >;
    symboled[Symbol("hidden")] = "x";
    expect(sanitizeOwnershipMessage(symboled)).toBeNull();

    const sneaky = { type: "takeover-request", projectId: "p1" };
    Object.defineProperty(sneaky, "shadow", { enumerable: false, value: 1 });
    expect(sanitizeOwnershipMessage(sneaky)).toBeNull();
  });

  it("returns a FRESH object, never the sender's structure", () => {
    const input = { type: "takeover-request", projectId: "p1" };
    const output = sanitizeOwnershipMessage(input);
    expect(output).not.toBe(input);
  });
});

describe("bus fan-out defense", () => {
  it("malformed raw deliveries produce zero callbacks, zero flush/release side effects, zero throws", async () => {
    const backend = new MemoryBackend();
    const scheduler = new FakeScheduler();
    const hub = new MemoryBusHub();
    const lock = new LeaseOwnershipLock(backend, { now: scheduler.clock, timer: scheduler.timer });
    const bus = hub.connect();
    const owner = await acquireOwnership("p1", { lock, bus });
    expect(owner.status).toBe("owner");

    let takeovers = 0;
    let releases = 0;
    let changes = 0;
    owner.onTakeoverRequested(() => void (takeovers += 1));
    owner.onOwnershipReleased(() => void (releases += 1));
    owner.onProjectChanged(() => void (changes += 1));

    const deliver = (data: unknown) =>
      (bus as unknown as { deliver: (message: unknown) => void }).deliver(data);
    const corpus: unknown[] = [
      null,
      undefined,
      42,
      "ownership-released",
      [],
      { type: "takeover-request" },
      { type: "takeover-request", projectId: "p1", forged: true },
      { type: "project-changed", projectId: "p1", savedRevision: Number.MAX_VALUE },
      { type: "unknown-op", projectId: "p1" },
    ];
    for (const data of corpus) {
      expect(() => deliver(data)).not.toThrow();
    }
    await settle();
    expect(takeovers).toBe(0);
    expect(releases).toBe(0);
    expect(changes).toBe(0);
    // A well-formed request still works after the garbage.
    deliver({ type: "takeover-request", projectId: "p1" });
    expect(takeovers).toBe(1);
    await owner.release();
  });
});

/* ------------------------------------------------------------------ */
/* Crash-release reacquisition                                         */
/* ------------------------------------------------------------------ */

describe("crash release — Web Locks mode", () => {
  it("a waiting read-only tab acquires after the owner's lock releases SILENTLY (NullOwnershipBus)", async () => {
    const manager = new FakeLockManager();
    const lock = new WebLocksOwnershipLock(manager as unknown as LockManager);
    const bus = new NullOwnershipBus();

    const owner = await acquireOwnership("p1", { lock, bus });
    expect(owner.status).toBe("owner");
    const reader = await acquireOwnership("p1", { lock, bus });
    expect(reader.status).toBe("readonly");
    await settle();
    expect(manager.queuedCount).toBe(1); // one REAL parked request, no polling

    let notified = 0;
    reader.onOwnershipReleased(() => void (notified += 1));

    // Owner dies: the platform releases the lock; NO bus message is sent.
    await owner.release(); // NullOwnershipBus.publish is a no-op — silent
    await settle();
    expect(notified).toBe(1);

    // The probe HOLDS its grant for adoption: the waiting tab promotes by
    // adopting the exact grant, never by releasing and re-racing it.
    const promoted = reader.adoptPendingOwnership();
    expect(promoted).not.toBeNull();
    expect(promoted!.status).toBe("owner");
    expect(reader.adoptPendingOwnership()).toBeNull(); // at most one adoption
    await promoted!.release();
    await reader.release();
    expect(manager.queuedCount).toBe(0);
    expect(manager.locked).toBe(false);
  });

  it("release() cancels the parked queued request cleanly", async () => {
    const manager = new FakeLockManager();
    const lock = new WebLocksOwnershipLock(manager as unknown as LockManager);
    const bus = new NullOwnershipBus();

    const owner = await acquireOwnership("p1", { lock, bus });
    const reader = await acquireOwnership("p1", { lock, bus });
    await settle();
    expect(manager.queuedCount).toBe(1);

    let notified = 0;
    reader.onOwnershipReleased(() => void (notified += 1));
    await reader.release();
    await settle();
    expect(manager.queuedCount).toBe(0);

    // A later silent release must not resurrect the cancelled waiter.
    await owner.release();
    await settle();
    expect(notified).toBe(0);
  });

  it("takeover request aimed at a DEAD owner still converges via the probe", async () => {
    const manager = new FakeLockManager();
    const lock = new WebLocksOwnershipLock(manager as unknown as LockManager);
    const bus = new NullOwnershipBus();

    const owner = await acquireOwnership("p1", { lock, bus });
    const reader = await acquireOwnership("p1", { lock, bus });
    let notified = 0;
    reader.onOwnershipReleased(() => void (notified += 1));

    // The request goes nowhere (dead owner / no bus). Not an error.
    reader.requestTakeover();
    await settle();
    expect(notified).toBe(0);

    await owner.release(); // silent death
    await settle();
    expect(notified).toBe(1);
    await reader.release();
    expect(manager.queuedCount).toBe(0);
  });
});

describe("crash release — lease fallback mode", () => {
  function setup() {
    const backend = new MemoryBackend();
    const scheduler = new FakeScheduler();
    const lock = new LeaseOwnershipLock(backend, {
      now: scheduler.clock,
      timer: scheduler.timer,
    });
    return { backend, scheduler, lock };
  }

  it("a waiting tab acquires within one TTL after the owner's lease lapses (no bus at all)", async () => {
    const { backend, scheduler, lock } = setup();
    const bus = new NullOwnershipBus();

    // Dead owner: a leftover lease row from a crashed tab — no heartbeat,
    // no release, no bus message, ever.
    const deadLease: LeaseRecordV1 = {
      projectId: "p1",
      ownerId: "dead-tab",
      acquiredAt: scheduler.nowMs,
      expiresAt: scheduler.nowMs + LEASE_TTL_MS,
    };
    await backend.put("leases", "p1", deadLease);

    const reader = await acquireOwnership("p1", { lock, bus });
    expect(reader.status).toBe("readonly");
    let notified = 0;
    reader.onOwnershipReleased(() => void (notified += 1));

    // TTL-boundary retry (plus jitter) — bounded, not busy polling.
    await scheduler.advance(LEASE_TTL_MS + 500);
    await settle();
    expect(notified).toBe(1);

    // The probe holds the stolen lease for adoption (heartbeating); the
    // waiting tab promotes by adopting the grant, never by re-racing it.
    const promoted = reader.adoptPendingOwnership();
    expect(promoted).not.toBeNull();
    expect(promoted!.status).toBe("owner");
    await promoted!.release();
    await reader.release();
    expect(await backend.get("leases", "p1")).toBeUndefined();
    await scheduler.advance(LEASE_TTL_MS * 2);
    expect(scheduler.pendingCount).toBe(0); // nothing leaked
  });

  it("release() cancels the TTL retry — no timers survive dispose", async () => {
    const { backend, scheduler, lock } = setup();
    const bus = new NullOwnershipBus();
    await backend.put("leases", "p1", {
      projectId: "p1",
      ownerId: "immortal",
      acquiredAt: scheduler.nowMs,
      expiresAt: scheduler.nowMs + LEASE_TTL_MS * 1000,
    } satisfies LeaseRecordV1);

    const reader = await acquireOwnership("p1", { lock, bus });
    expect(reader.status).toBe("readonly");
    await settle();
    expect(scheduler.pendingCount).toBeGreaterThan(0); // parked retry timer

    await reader.release();
    await settle();
    expect(scheduler.pendingCount).toBe(0);

    let notified = 0;
    reader.onOwnershipReleased(() => void (notified += 1));
    await scheduler.advance(LEASE_TTL_MS * 5);
    expect(notified).toBe(0);
  });

  it("the newly promoted tab still holds CAS safety: it must adopt (or re-acquire) and reload before edits", async () => {
    // Regression guard for the handover contract: the probe fires the
    // released signal and HOLDS its grant; ownership is taken by adopting
    // that grant (or a fresh acquireOwnership when none is held), which the
    // session layer follows with an envelope reload — see
    // session-controller.handleOwnershipReleased.
    const { backend, scheduler, lock } = setup();
    const bus = new NullOwnershipBus();
    await backend.put("leases", "p1", {
      projectId: "p1",
      ownerId: "dead-tab",
      acquiredAt: scheduler.nowMs,
      expiresAt: scheduler.nowMs + LEASE_TTL_MS,
    } satisfies LeaseRecordV1);

    const reader = await acquireOwnership("p1", { lock, bus });
    let promoted = false;
    reader.onOwnershipReleased(() => {
      promoted = true;
    });
    await scheduler.advance(LEASE_TTL_MS + 500);
    await settle();
    expect(promoted).toBe(true);
    // Status of the ORIGINAL handle never mutates in place.
    expect(reader.status).toBe("readonly");
    await reader.release();
  });
});
