/**
 * In-memory StorageBackend used by unit tests and as a last-resort runtime
 * fallback when IndexedDB is unavailable (data lives for the session only).
 * Mirrors IndexedDB semantics that matter to the business logic:
 * structured-clone isolation of stored values, atomic rollback of failed
 * transactions, and serialized readwrite transactions.
 */
import type { BackendTransaction, StorageBackend } from "./backend";
import type { StoreName } from "./schema";
import { STORE_NAMES } from "./schema";
import type { OwnershipBus, OwnershipMessage } from "./ownership";

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // Values that cannot be structured-cloned would throw in IndexedDB too;
    // in the fallback path we keep the reference rather than lose data.
    return value;
  }
}

function quotaError(): Error {
  const error = new Error("Simulated storage quota exceeded");
  error.name = "QuotaExceededError";
  return error;
}

export class MemoryBackend implements StorageBackend {
  private readonly stores = new Map<StoreName, Map<string, unknown>>();
  private txQueue: Promise<void> = Promise.resolve();
  /** When true, every put throws a QuotaExceededError (tests). */
  simulateQuotaExceeded = false;

  constructor() {
    for (const name of STORE_NAMES) {
      this.stores.set(name, new Map());
    }
  }

  private table(store: StoreName): Map<string, unknown> {
    const table = this.stores.get(store);
    if (!table) throw new Error(`Unknown object store: ${store}`);
    return table;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const value = this.table(store).get(key);
    return value === undefined ? undefined : cloneValue(value as T);
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    if (this.simulateQuotaExceeded) throw quotaError();
    this.table(store).set(key, cloneValue(value));
  }

  async delete(store: StoreName, key: string): Promise<void> {
    this.table(store).delete(key);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return [...this.table(store).values()].map((value) => cloneValue(value as T));
  }

  async getAllKeys(store: StoreName): Promise<string[]> {
    return [...this.table(store).keys()];
  }

  async transaction(
    stores: StoreName[],
    work: (tx: BackendTransaction) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (signal?.aborted) throw new DOMException("The storage transaction was aborted.", "AbortError");
      // Mutate transaction-local clones, not the live tables. Besides matching
      // IndexedDB isolation, this prevents a provider promise that settles
      // after cancellation from resurrecting rows after rollback.
      const local = new Map<StoreName, Map<string, unknown>>();
      const writes = new Map<StoreName, Set<string>>();
      for (const store of stores) {
        writes.set(store, new Set());
        local.set(
          store,
          new Map(
            [...this.table(store).entries()].map(([key, value]) => [key, cloneValue(value)]),
          ),
        );
      }
      let active = true;
      const guard = (store: StoreName): Map<string, unknown> => {
        if (!active || signal?.aborted) {
          throw new DOMException("The storage transaction was aborted.", "AbortError");
        }
        const table = local.get(store);
        if (!table) {
          throw new Error(`Store "${store}" not included in this transaction`);
        }
        return table;
      };
      const tx: BackendTransaction = {
        get: async (store, key) => {
          const value = guard(store).get(key);
          return value === undefined ? undefined : (cloneValue(value) as never);
        },
        put: async (store, key, value) => {
          if (this.simulateQuotaExceeded) throw quotaError();
          guard(store).set(key, cloneValue(value));
          writes.get(store)!.add(key);
        },
        delete: async (store, key) => {
          guard(store).delete(key);
          writes.get(store)!.add(key);
        },
        getAll: async (store) => [...guard(store).values()].map((v) => cloneValue(v)) as never,
        getAllKeys: async (store) => [...guard(store).keys()],
      };
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const onAbort = (): void => {
        if (!active) return;
        active = false;
        rejectAbort(new DOMException("The storage transaction was aborted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const working = Promise.resolve().then(() => work(tx));
      // A late continuation is harmless: active=false makes every tx method
      // reject, and this handler prevents an unobserved rejection.
      void working.catch(() => undefined);
      try {
        await (signal ? Promise.race([working, aborted]) : working);
        if (signal?.aborted) onAbort();
        if (!active) throw new DOMException("The storage transaction was aborted.", "AbortError");
        // Publish only this transaction's write set, synchronously. Other
        // callers may have updated an unrelated key while the callback was
        // suspended; publishing an entire snapshot would erase their writes
        // or resurrect records they deleted (including recovery journals).
        for (const [store, keys] of writes) {
          const snapshot = local.get(store)!;
          const live = this.table(store);
          for (const key of keys) {
            if (snapshot.has(key)) live.set(key, snapshot.get(key));
            else live.delete(key);
          }
        }
      } finally {
        active = false;
        signal?.removeEventListener("abort", onAbort);
      }
    };
    // Serialize transactions the way IndexedDB serializes overlapping
    // readwrite transactions.
    const result = this.txQueue.then(run);
    this.txQueue = result.catch(() => undefined);
    return result;
  }

  close(): void {
    // Nothing to release.
  }
}

/**
 * In-process OwnershipBus hub for tests: each connect() acts like one tab's
 * BroadcastChannel — publishes deliver to every OTHER connected bus, never
 * back to the sender.
 */
export class MemoryBusHub {
  private readonly buses = new Set<MemoryBus>();

  connect(): OwnershipBus {
    const bus = new MemoryBus(this);
    this.buses.add(bus);
    return bus;
  }

  broadcast(from: MemoryBus, message: OwnershipMessage): void {
    for (const bus of [...this.buses]) {
      if (bus !== from) bus.deliver(message);
    }
  }

  disconnect(bus: MemoryBus): void {
    this.buses.delete(bus);
  }
}

class MemoryBus implements OwnershipBus {
  private readonly listeners = new Set<(message: OwnershipMessage) => void>();

  constructor(private readonly hub: MemoryBusHub) {}

  publish(message: OwnershipMessage): void {
    this.hub.broadcast(this, structuredClone(message));
  }

  deliver(message: OwnershipMessage): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  subscribe(listener: (message: OwnershipMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.hub.disconnect(this);
  }
}
