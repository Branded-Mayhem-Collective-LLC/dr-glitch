/**
 * Single-writer project ownership. One tab owns a project for writing;
 * other tabs open read-only and may request a takeover or duplicate.
 *
 * Three cooperating layers:
 *   1. OwnershipLock — Web Locks when available, else short-TTL IndexedDB
 *      lease records with heartbeat renewal (works on any StorageBackend).
 *   2. OwnershipBus — BroadcastChannel abstraction for takeover requests,
 *      release notices, and change notifications.
 *   3. savedRevision compare-and-swap in ProjectRepository.saveExplicit is
 *      the final backstop: even if locking fails, a stale writer gets a
 *      ConflictError instead of silently overwriting.
 */
import type { Id } from "../core/types";
import { createId } from "../core/id";
import type { StorageBackend } from "./backend";
import type { LeaseRecordV1 } from "./schema";
import type { Clock, TimerHandle, TimerHost } from "./clock";
import { systemClock, systemTimer } from "./clock";

export const LEASE_TTL_MS = 5_000;
export const OWNERSHIP_CHANNEL = "dr-glitch-ownership";

/* ------------------------------------------------------------------ */
/* Bus                                                                 */
/* ------------------------------------------------------------------ */

export type OwnershipMessage =
  | { type: "takeover-request"; projectId: Id }
  | { type: "ownership-released"; projectId: Id }
  | { type: "project-changed"; projectId: Id; savedRevision: number };

const MAX_MESSAGE_PROJECT_ID = 128;

/**
 * Validates untrusted cross-context bus data into an exact OwnershipMessage,
 * or null. Same-origin contexts (extensions' content-script worlds, other
 * apps on a shared origin, hostile tests) can post arbitrary data on the
 * channel; a malformed or crafted message must produce ZERO callback
 * invocations and zero exceptions — a forged takeover-request would
 * otherwise force an owner to flush and release.
 *
 * Rules: plain object only (null/Object.prototype — non-plain data is
 * rejected conservatively); own-enumerable DATA properties only (getter/
 * setter-bearing objects are rejected without ever invoking them); exact key
 * sets per message type; bounded nonempty projectId; savedRevision a
 * nonnegative safe integer. The returned message is a FRESH object — caller
 * state never aliases sender-controlled structures.
 */
export function sanitizeOwnershipMessage(data: unknown): OwnershipMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(data);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") return null; // symbol keys: reject
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) return null;
    if (!descriptor.enumerable) return null;
  }
  const type = descriptors.type?.value;
  const projectId = descriptors.projectId?.value;
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    projectId.length > MAX_MESSAGE_PROJECT_ID
  ) {
    return null;
  }
  if (type === "takeover-request" || type === "ownership-released") {
    if (keys.length !== 2) return null;
    return { type, projectId };
  }
  if (type === "project-changed") {
    if (keys.length !== 3) return null;
    const savedRevision = descriptors.savedRevision?.value;
    if (
      typeof savedRevision !== "number" ||
      !Number.isSafeInteger(savedRevision) ||
      savedRevision < 0
    ) {
      return null;
    }
    return { type: "project-changed", projectId, savedRevision };
  }
  return null;
}

export interface OwnershipBus {
  /** Deliver to every OTHER connected context (BroadcastChannel semantics). */
  publish(message: OwnershipMessage): void;
  subscribe(listener: (message: OwnershipMessage) => void): () => void;
  close(): void;
}

/** Real cross-tab bus over BroadcastChannel. Browser only. */
export class BroadcastChannelBus implements OwnershipBus {
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<(message: OwnershipMessage) => void>();

  constructor(name: string = OWNERSHIP_CHANNEL) {
    this.channel = new BroadcastChannel(name);
    this.channel.addEventListener("message", (event: MessageEvent) => {
      // Validate BEFORE any fan-out; malformed data is silently ignored.
      const message = sanitizeOwnershipMessage(event.data);
      if (!message) return;
      for (const listener of [...this.listeners]) {
        listener(message);
      }
    });
  }

  publish(message: OwnershipMessage): void {
    this.channel.postMessage(message);
  }

  subscribe(listener: (message: OwnershipMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.channel.close();
  }
}

/** No-op bus for environments without BroadcastChannel (single context). */
export class NullOwnershipBus implements OwnershipBus {
  publish(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
  close(): void {}
}

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

export type LockAttempt = {
  acquired: boolean;
  /**
   * Idempotent POSTCONDITION: resolves only after the lock layer has
   * actually released (Web Locks: the underlying `locks.request()` promise
   * settled, which the spec guarantees happens after the user agent
   * unlocked; lease: the delete transaction committed). Repeated calls
   * share one promise. Reporting "released" any earlier lets release
   * notifications and reacquisition attempts race ahead of the real unlock.
   */
  release(): Promise<void>;
};

export interface OwnershipLock {
  /** Try to take the exclusive write lock; never waits for the holder. */
  tryAcquire(projectId: Id): Promise<LockAttempt>;
  /**
   * Crash-release wait: resolves with a HELD attempt once the lock becomes
   * free — including when the holder died silently (a crashed tab's Web Lock
   * releases with no bus message; a lease simply expires). Event-driven
   * where the platform allows (a real queued lock request), TTL-boundary
   * retries in lease mode — never a busy loop. Rejects with an AbortError
   * when `signal` aborts; implementations must leak no timers or queued
   * requests after abort. Optional: doubles without it simply get no
   * crash-release detection.
   */
  acquireWhenAvailable?(projectId: Id, signal: AbortSignal): Promise<LockAttempt>;
}

const lockName = (projectId: Id): string => `dr-glitch:project:${projectId}`;

function abortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("The ownership wait was aborted.", "AbortError")
    : Object.assign(new Error("The ownership wait was aborted."), { name: "AbortError" });
}

/**
 * Web Locks implementation: the lock is held until release() is called.
 *
 * release() is the postcondition described on LockAttempt: it resolves the
 * `held` promise (letting the request callback return) and then AWAITS the
 * `locks.request()` promise itself, which per spec settles only after the
 * callback returned AND the user agent actually released the lock. Without
 * that final await, a "released" report races the real unlock: an
 * ifAvailable reacquire attempt still sees the lock held, and a parked
 * queued request has not been granted yet (the WEBLOCKS-RACE bug).
 */
export class WebLocksOwnershipLock implements OwnershipLock {
  constructor(private readonly locks: LockManager) {}

  tryAcquire(projectId: Id): Promise<LockAttempt> {
    return new Promise((resolve, reject) => {
      let releaseHeld: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => {
        releaseHeld = resolveHeld;
      });
      let settled: Promise<void> | null = null;
      const request = this.locks.request(
        lockName(projectId),
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolve({ acquired: false, release: async () => undefined });
            return;
          }
          let releasing: Promise<void> | null = null;
          resolve({
            acquired: true,
            release: () => {
              releasing ??= (async () => {
                releaseHeld();
                await settled;
              })();
              return releasing;
            },
          });
          await held;
        },
      );
      settled = request.then(
        () => undefined,
        () => undefined,
      );
      request.catch(reject);
    });
  }

  /**
   * Parks a REAL queued request (no ifAvailable polling): the browser
   * resolves it exactly when the current holder releases — explicitly or by
   * dying. The abort signal cancels the queued request cleanly. Grant order
   * is the user agent's FIFO request queue — this is the requester-priority
   * contract the session layer relies on (see acquireOwnership).
   */
  acquireWhenAvailable(projectId: Id, signal: AbortSignal): Promise<LockAttempt> {
    return new Promise((resolve, reject) => {
      let releaseHeld: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => {
        releaseHeld = resolveHeld;
      });
      let settled: Promise<void> | null = null;
      const request = this.locks.request(lockName(projectId), { signal }, async () => {
        let releasing: Promise<void> | null = null;
        resolve({
          acquired: true,
          release: () => {
            releasing ??= (async () => {
              releaseHeld();
              await settled;
            })();
            return releasing;
          },
        });
        await held;
      });
      settled = request.then(
        () => undefined,
        () => undefined,
      );
      request.catch((error: unknown) => reject(error));
    });
  }
}

export type LeaseLockOptions = {
  ttlMs?: number;
  /** Renewal period; defaults to half the TTL. */
  heartbeatMs?: number;
  now?: Clock;
  timer?: TimerHost;
};

/**
 * IndexedDB-lease fallback: a short-TTL record per project, renewed by
 * heartbeat while held. An expired lease may be stolen by the next acquire.
 */
export class LeaseOwnershipLock implements OwnershipLock {
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly now: Clock;
  private readonly timer: TimerHost;

  constructor(
    private readonly backend: StorageBackend,
    options: LeaseLockOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? LEASE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.floor(this.ttlMs / 2);
    this.now = options.now ?? systemClock;
    this.timer = options.timer ?? systemTimer;
  }

  async tryAcquire(projectId: Id): Promise<LockAttempt> {
    const ownerId = createId();
    let acquired = false;
    await this.backend.transaction(["leases"], async (tx) => {
      const existing = await tx.get<LeaseRecordV1>("leases", projectId);
      if (existing && existing.expiresAt > this.now()) return;
      const timestamp = this.now();
      const lease: LeaseRecordV1 = {
        projectId,
        ownerId,
        acquiredAt: timestamp,
        expiresAt: timestamp + this.ttlMs,
      };
      await tx.put("leases", projectId, lease);
      acquired = true;
    });
    if (!acquired) {
      return { acquired: false, release: async () => undefined };
    }

    let released = false;
    let heartbeatHandle: TimerHandle | undefined;

    const renew = async (): Promise<void> => {
      if (released) return;
      let stillOwner = false;
      await this.backend.transaction(["leases"], async (tx) => {
        const lease = await tx.get<LeaseRecordV1>("leases", projectId);
        if (!lease || lease.ownerId !== ownerId) return;
        await tx.put("leases", projectId, { ...lease, expiresAt: this.now() + this.ttlMs });
        stillOwner = true;
      });
      if (stillOwner && !released) schedule();
    };

    const schedule = (): void => {
      heartbeatHandle = this.timer.set(() => {
        void renew().catch(() => {
          // A failed renewal lets the lease lapse; CAS still protects saves.
        });
      }, this.heartbeatMs);
    };
    schedule();

    let releasing: Promise<void> | null = null;
    const performRelease = async (): Promise<void> => {
      released = true;
      if (heartbeatHandle !== undefined) this.timer.clear(heartbeatHandle);
      await this.backend.transaction(["leases"], async (tx) => {
        const lease = await tx.get<LeaseRecordV1>("leases", projectId);
        if (lease && lease.ownerId === ownerId) {
          await tx.delete("leases", projectId);
        }
      });
    };

    return {
      acquired: true,
      release: () => {
        // Idempotent postcondition: released only once the delete transaction
        // committed; repeated calls share one promise.
        releasing ??= performRelease();
        return releasing;
      },
    };
  }

  /**
   * Bounded TTL-boundary retry (never a busy loop): re-attempts acquisition
   * when the current lease is due to expire, plus a small jitter so several
   * waiting tabs don't stampede the same transaction. A crashed owner stops
   * heartbeating, its lease lapses within one TTL, and the next attempt
   * succeeds — no bus message required.
   *
   * WAIT-FIRST, then try: a probe is a BACKGROUND waiter. On a cooperative
   * handoff the bus-notified requester must win the freed lease, so the
   * probe never races the release instant — it re-attempts only at the TTL
   * boundary (crashed owner) or after a short grace when no lease exists.
   * This is the lease-mode analogue of the Web Locks FIFO queue: explicit
   * foreground acquire attempts always get the first shot at a freed lock.
   */
  async acquireWhenAvailable(projectId: Id, signal: AbortSignal): Promise<LockAttempt> {
    for (;;) {
      if (signal.aborted) throw abortError();
      const lease = await this.backend.get<LeaseRecordV1>("leases", projectId);
      const untilExpiry =
        lease && Number.isFinite(lease.expiresAt) ? lease.expiresAt - this.now() : 0;
      const waitMs =
        Math.min(Math.max(untilExpiry, 50), this.ttlMs) + Math.floor(Math.random() * 250);
      await this.delay(waitMs, signal);
      if (signal.aborted) throw abortError();
      const attempt = await this.tryAcquire(projectId);
      if (signal.aborted) {
        if (attempt.acquired) await attempt.release();
        throw abortError();
      }
      if (attempt.acquired) return attempt;
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const handle = this.timer.set(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        this.timer.clear(handle);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Ownership handle                                                    */
/* ------------------------------------------------------------------ */

export type OwnershipStatus = "owner" | "readonly";

export type OwnershipHandle = {
  readonly status: OwnershipStatus;
  /** Read-only side: ask the current owner to hand the project over. */
  requestTakeover(): void;
  /** Owner side: notified when another tab requests a takeover. */
  onTakeoverRequested(callback: () => void): () => void;
  /** Read-only side: notified when the owner releases (so acquire can be retried). */
  onOwnershipReleased(callback: () => void): () => void;
  /** Any side: notified when the owner explicitly saves a new revision. */
  onProjectChanged(callback: (savedRevision: number) => void): () => void;
  /** Owner side: broadcast a new explicitly saved revision. */
  notifyProjectChanged(savedRevision: number): void;
  /**
   * Read-only side: claim the crash-release probe's ALREADY-GRANTED lock as
   * new ownership. When the parked probe wins the lock, this handle keeps
   * HOLDING that grant until the consumer either adopts it (returning a
   * fresh "owner" handle wrapped around the same grant — the lock is never
   * released and re-raced) or releases this handle. Returns null when no
   * grant is held: the released notification came from the bus while the
   * probe is still parked, the grant was already adopted, or this handle is
   * releasing — fall back to a fresh acquire attempt. At most one adoption
   * per handle.
   */
  adoptPendingOwnership(): OwnershipHandle | null;
  /**
   * Idempotent postcondition release: resolves only after the lock layer
   * has ACTUALLY released (see LockAttempt.release), any unadopted probe
   * grant was handed back, all bus subscriptions are detached, and — when
   * this handle owned the lock — the "ownership-released" notification was
   * published EXACTLY ONCE. Repeated calls share one promise.
   */
  release(): Promise<void>;
};

export type OwnershipDeps = {
  lock: OwnershipLock;
  bus: OwnershipBus;
};

/**
 * Acquire single-writer ownership of a project. Returns an "owner" handle
 * when the lock was free, else a "readonly" handle that can request a
 * takeover or observe release/change notifications.
 */
export async function acquireOwnership(projectId: Id, deps: OwnershipDeps): Promise<OwnershipHandle> {
  const attempt = await deps.lock.tryAcquire(projectId);
  return buildOwnershipHandle(projectId, deps, attempt);
}

/**
 * Wraps an already-settled lock attempt in a full OwnershipHandle. Used by
 * acquireOwnership for fresh attempts and by adoptPendingOwnership for a
 * probe grant promoted into ownership.
 */
function buildOwnershipHandle(
  projectId: Id,
  deps: OwnershipDeps,
  attempt: LockAttempt,
): OwnershipHandle {
  const takeoverCallbacks = new Set<() => void>();
  const releasedCallbacks = new Set<() => void>();
  const changedCallbacks = new Set<(savedRevision: number) => void>();

  const unsubscribe = deps.bus.subscribe((raw) => {
    // Defense in depth: bus doubles may deliver unvalidated data; the same
    // sanitizer that guards BroadcastChannelBus runs here before fan-out.
    const message = sanitizeOwnershipMessage(raw);
    if (!message || message.projectId !== projectId) return;
    if (message.type === "takeover-request" && attempt.acquired) {
      for (const callback of [...takeoverCallbacks]) callback();
    } else if (message.type === "ownership-released") {
      for (const callback of [...releasedCallbacks]) callback();
    } else if (message.type === "project-changed") {
      for (const callback of [...changedCallbacks]) callback(message.savedRevision);
    }
  });

  // Crash-release watch for read-only handles: the bus only ACCELERATES a
  // cooperative handover; a crashed owner posts nothing (and NullOwnershipBus
  // posts nothing ever). Park one probe on the lock layer — a queued Web
  // Locks request, or lease-TTL retries — and surface its grant through the
  // same "ownership released" path the bus uses.
  //
  // ADOPTION, not release-and-re-race: once the probe is GRANTED, this
  // handle keeps holding the lock until the consumer adopts it via
  // adoptPendingOwnership() (the grant becomes the new ownership directly)
  // or releases this handle (the grant is handed back with full
  // settlement). Releasing the grant and racing to reacquire was the
  // WEBLOCKS-RACE bug: the freed lock could land on another parked waiter —
  // or on nobody, with the probe consumed — and the handoff died. Among
  // several waiting tabs the lock layer's own queue picks exactly one
  // grantee (Web Locks: UA FIFO request order; lease: TTL-boundary retry
  // with jitter); the others stay parked. The adopter reloads the envelope
  // before accepting edits — see session-controller.handleOwnershipReleased.
  let probeAbort: AbortController | null = null;
  let probePromise: Promise<LockAttempt> | null = null;
  let pendingProbe: LockAttempt | null = null;
  let adoptedOut = false;
  let releasePromise: Promise<void> | null = null;

  if (!attempt.acquired && typeof deps.lock.acquireWhenAvailable === "function") {
    probeAbort = new AbortController();
    const signal = probeAbort.signal;
    probePromise = deps.lock.acquireWhenAvailable(projectId, signal);
    void probePromise
      .then(async (probe) => {
        if (releasePromise !== null || signal.aborted) {
          // The grant raced this handle's release: hand it straight back.
          // (release() also settles probePromise; LockAttempt.release is
          // idempotent, so the double path is safe.)
          await probe.release();
          return;
        }
        pendingProbe = probe;
        for (const callback of [...releasedCallbacks]) callback();
      })
      .catch(() => {
        // Aborted by release(), or the lock layer failed: never retry-storm.
      });
  }

  return {
    status: attempt.acquired ? "owner" : "readonly",
    requestTakeover: () => {
      deps.bus.publish({ type: "takeover-request", projectId });
    },
    onTakeoverRequested: (callback) => {
      takeoverCallbacks.add(callback);
      return () => takeoverCallbacks.delete(callback);
    },
    onOwnershipReleased: (callback) => {
      releasedCallbacks.add(callback);
      return () => releasedCallbacks.delete(callback);
    },
    onProjectChanged: (callback) => {
      changedCallbacks.add(callback);
      return () => changedCallbacks.delete(callback);
    },
    notifyProjectChanged: (savedRevision) => {
      deps.bus.publish({ type: "project-changed", projectId, savedRevision });
    },
    adoptPendingOwnership: () => {
      if (releasePromise !== null || pendingProbe === null) return null;
      const adopted = pendingProbe;
      pendingProbe = null;
      adoptedOut = true;
      return buildOwnershipHandle(projectId, deps, adopted);
    },
    release: () => {
      releasePromise ??= (async () => {
        probeAbort?.abort();
        unsubscribe();
        if (probePromise !== null && !adoptedOut) {
          try {
            // If the grant raced the abort (aborting a GRANTED Web Lock is
            // a no-op), the probe resolved holding the lock: hand it back
            // with full settlement. An adopted grant is never touched.
            const probe = await probePromise;
            if (!adoptedOut) await probe.release();
          } catch {
            // Aborted before the grant: nothing held, nothing to release.
          }
        }
        pendingProbe = null;
        const wasOwner = attempt.acquired;
        await attempt.release();
        if (wasOwner) {
          deps.bus.publish({ type: "ownership-released", projectId });
        }
      })();
      return releasePromise;
    },
  };
}

/**
 * Runtime wiring: Web Locks + BroadcastChannel when the browser provides
 * them, else the IndexedDB lease lock and a no-op bus.
 */
export function createOwnershipDeps(backend: StorageBackend): OwnershipDeps {
  const lock: OwnershipLock =
    typeof navigator !== "undefined" && "locks" in navigator && navigator.locks
      ? new WebLocksOwnershipLock(navigator.locks)
      : new LeaseOwnershipLock(backend);
  const bus: OwnershipBus =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannelBus() : new NullOwnershipBus();
  return { lock, bus };
}
