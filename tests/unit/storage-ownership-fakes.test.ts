/**
 * Shared ownership test doubles with REAL user-agent semantics, plus
 * self-validation. Exported for the Web Locks race suites
 * (storage-ownership-weblocks, app-session-ownership-handoff), mirroring
 * how FakeScheduler is shared from storage-fixtures.
 *
 * FakeWebLocks mimics the parts of the Web Locks spec the ownership layer
 * depends on:
 *  - one FIFO request queue per resource name; grants strictly in request
 *    order;
 *  - callbacks are invoked ASYNCHRONOUSLY after the grant decision (never
 *    during request());
 *  - the promise returned by request() settles only AFTER the callback
 *    settled AND the lock was actually released (the next waiter is granted
 *    BEFORE that promise resolves) — the exact timing window behind the
 *    WEBLOCKS-RACE bug;
 *  - ifAvailable grants only when the lock is immediately grantable: not
 *    held AND no earlier queued request for the same name;
 *  - aborting a PENDING request removes it and rejects with AbortError;
 *    aborting after the grant is ignored;
 *  - crash(name) models a silently dying tab: the user agent releases the
 *    lock and pumps the queue, while the dead tab's request promise never
 *    settles (nobody is left to observe it).
 *
 * AsyncBusHub is a MemoryBusHub analogue whose deliveries are queued as
 * microtasks — messages always arrive ASYNCHRONOUSLY, interleaving with
 * lock-grant microtasks like a real BroadcastChannel interleaves with the
 * lock manager.
 */
import { describe, expect, it } from "vitest";
import type { OwnershipBus, OwnershipMessage } from "../../src/storage/ownership";

/** Flush enough microtask turns for lock grants and bus deliveries to land. */
export const settle = async (turns = 200): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

type LockGrantCallback = (lock: { name: string } | null) => Promise<unknown> | unknown;

type LockRequestOptions = {
  ifAvailable?: boolean;
  signal?: AbortSignal;
};

type Entry = {
  name: string;
  callback: LockGrantCallback;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  granted: boolean;
  crashed: boolean;
};

export class FakeWebLocks {
  private readonly holders = new Map<string, Entry>();
  private readonly queues = new Map<string, Entry[]>();

  isHeld(name: string): boolean {
    return this.holders.has(name);
  }

  get heldCount(): number {
    return this.holders.size;
  }

  /** Parked (queued, not yet granted) requests — for `name`, or in total. */
  pendingCount(name?: string): number {
    let total = 0;
    for (const [queueName, queue] of this.queues) {
      if (name !== undefined && queueName !== name) continue;
      total += queue.length;
    }
    return total;
  }

  /**
   * Silent owner crash: the user agent releases a dead tab's lock and
   * grants the next waiter. The zombie's request promise never settles.
   */
  crash(name: string): void {
    const holder = this.holders.get(name);
    if (!holder) return;
    holder.crashed = true;
    this.holders.delete(name);
    this.pump(name);
  }

  request(name: string, options: LockRequestOptions, callback: LockGrantCallback): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const entry: Entry = { name, callback, resolve, reject, granted: false, crashed: false };
      if (options.ifAvailable) {
        // Spec: granted only when IMMEDIATELY grantable — not held and no
        // earlier queued request for this resource.
        if (this.holders.has(name) || this.pendingCount(name) > 0) {
          void (async () => {
            await Promise.resolve();
            try {
              resolve(await callback(null));
            } catch (error) {
              reject(error);
            }
          })();
          return;
        }
        this.grant(entry);
        return;
      }
      options.signal?.addEventListener(
        "abort",
        () => {
          if (entry.granted) return; // spec: abort after grant is ignored
          const queue = this.queues.get(name);
          if (queue) {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
          }
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      queue.push(entry);
      this.pump(name);
    });
  }

  private pump(name: string): void {
    if (this.holders.has(name)) return;
    const queue = this.queues.get(name);
    if (!queue) return;
    const entry = queue.shift();
    if (entry) this.grant(entry);
  }

  private grant(entry: Entry): void {
    entry.granted = true;
    this.holders.set(entry.name, entry);
    void (async () => {
      // UA timing: the callback runs asynchronously after the grant.
      await Promise.resolve();
      let result: unknown;
      let failure: unknown;
      let ok = true;
      try {
        result = await entry.callback({ name: entry.name });
      } catch (error) {
        ok = false;
        failure = error;
      }
      if (entry.crashed) return; // a crashed holder's promise never settles
      // Spec ordering: the lock is RELEASED — and the next waiter granted —
      // BEFORE the request promise settles.
      this.holders.delete(entry.name);
      this.pump(entry.name);
      await Promise.resolve();
      if (ok) entry.resolve(result);
      else entry.reject(failure);
    })();
  }
}

export class AsyncBusHub {
  private readonly buses = new Set<AsyncBus>();

  connect(): OwnershipBus {
    const bus = new AsyncBus(this);
    this.buses.add(bus);
    return bus;
  }

  broadcast(from: AsyncBus, message: OwnershipMessage): void {
    for (const bus of [...this.buses]) {
      if (bus === from) continue;
      queueMicrotask(() => bus.deliver(message));
    }
  }

  disconnect(bus: AsyncBus): void {
    this.buses.delete(bus);
  }
}

class AsyncBus implements OwnershipBus {
  private readonly listeners = new Set<(message: OwnershipMessage) => void>();
  private closed = false;

  constructor(private readonly hub: AsyncBusHub) {}

  publish(message: OwnershipMessage): void {
    this.hub.broadcast(this, structuredClone(message));
  }

  deliver(message: OwnershipMessage): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(message);
  }

  subscribe(listener: (message: OwnershipMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.hub.disconnect(this);
  }
}

/* ------------------------------------------------------------------ */
/* Self-validation: the fake really has user-agent semantics           */
/* ------------------------------------------------------------------ */

function holdLock(locks: FakeWebLocks, name: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const done = locks.request(name, {}, async () => {
    await held;
  });
  return { release, done };
}

describe("FakeWebLocks semantics", () => {
  it("grants strictly in FIFO request order", async () => {
    const locks = new FakeWebLocks();
    const order: string[] = [];
    const first = holdLock(locks, "r");
    await settle();
    expect(locks.isHeld("r")).toBe(true);
    void locks.request("r", {}, () => {
      order.push("second");
    });
    void locks.request("r", {}, () => {
      order.push("third");
    });
    expect(locks.pendingCount("r")).toBe(2);
    first.release();
    await first.done;
    await settle();
    expect(order).toEqual(["second", "third"]);
    expect(locks.pendingCount("r")).toBe(0);
    expect(locks.isHeld("r")).toBe(false);
  });

  it("the request promise settles only AFTER the lock is released and the next waiter granted", async () => {
    const locks = new FakeWebLocks();
    const order: string[] = [];
    const first = holdLock(locks, "r");
    await settle();
    void locks.request("r", {}, () => {
      order.push("waiter-granted");
    });
    first.release();
    await first.done.then(() => order.push("request-promise-settled"));
    expect(order[0]).toBe("waiter-granted");
    expect(order).toContain("request-promise-settled");
  });

  it("ifAvailable fails while held AND while earlier requests are queued", async () => {
    const locks = new FakeWebLocks();
    const first = holdLock(locks, "r");
    await settle();
    const whileHeld = await locks.request("r", { ifAvailable: true }, (lock) => lock);
    expect(whileHeld).toBeNull();

    const controller = new AbortController();
    void locks.request("r", { signal: controller.signal }, () => undefined).catch(() => undefined);
    first.release();
    await first.done;
    // The queued waiter was granted at release; once it finished, a NEW
    // parked waiter must still beat a later ifAvailable request.
    await settle();
    const second = holdLock(locks, "r");
    await settle();
    void locks.request("r", {}, () => undefined);
    const whileQueued = await locks.request("r", { ifAvailable: true }, (lock) => lock);
    expect(whileQueued).toBeNull();
    second.release();
    await second.done;
    await settle();
  });

  it("abort removes a PENDING request; crash releases to the next waiter and never settles the zombie", async () => {
    const locks = new FakeWebLocks();
    const first = holdLock(locks, "r");
    await settle();

    const controller = new AbortController();
    const asserted = expect(
      locks.request("r", { signal: controller.signal }, () => undefined),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await asserted;
    expect(locks.pendingCount("r")).toBe(0);

    let granted = false;
    void locks.request("r", {}, () => {
      granted = true;
    });
    let zombieSettled = false;
    void first.done.then(
      () => (zombieSettled = true),
      () => (zombieSettled = true),
    );
    locks.crash("r");
    await settle();
    expect(granted).toBe(true);
    expect(zombieSettled).toBe(false);
    expect(locks.isHeld("r")).toBe(false);
  });
});

describe("AsyncBusHub semantics", () => {
  it("delivers to OTHER buses only, asynchronously", async () => {
    const hub = new AsyncBusHub();
    const a = hub.connect();
    const b = hub.connect();
    const seenA: OwnershipMessage[] = [];
    const seenB: OwnershipMessage[] = [];
    a.subscribe((message) => seenA.push(message));
    b.subscribe((message) => seenB.push(message));
    a.publish({ type: "takeover-request", projectId: "p1" });
    expect(seenB).toEqual([]); // not synchronous
    await settle();
    expect(seenB).toEqual([{ type: "takeover-request", projectId: "p1" }]);
    expect(seenA).toEqual([]);
    b.close();
    a.publish({ type: "takeover-request", projectId: "p1" });
    await settle();
    expect(seenB).toHaveLength(1);
  });
});
