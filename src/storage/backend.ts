/**
 * Narrow storage backend boundary. All business logic (CAS saves, trash,
 * GC, recovery, leases, staging) lives above this interface so it can run
 * unchanged against IndexedDB in the browser and MemoryBackend in Node
 * tests (memory-backend.ts).
 */
import type { DrGlitchDatabase, StoreName } from "./schema";
import { openDrGlitchDatabase } from "./schema";

/**
 * Operations available inside a transaction. IMPORTANT: inside
 * `StorageBackend.transaction` callbacks, await ONLY these operations.
 * IndexedDB auto-commits when the event loop sees a non-IDB await, so
 * awaiting foreign promises (fetch, crypto, parsing) inside a transaction
 * is a bug on the real backend even though MemoryBackend tolerates it.
 */
export interface BackendTransaction {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  getAll<T>(store: StoreName): Promise<T[]>;
  getAllKeys(store: StoreName): Promise<string[]>;
}

export interface StorageBackend {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  getAll<T>(store: StoreName): Promise<T[]>;
  getAllKeys(store: StoreName): Promise<string[]>;
  /**
   * Run `work` atomically across `stores` in readwrite mode. If `work`
   * throws, every write inside it is rolled back and the error is rethrown.
   */
  transaction(
    stores: StoreName[],
    work: (tx: BackendTransaction) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  close(): void;
}

/** Real IndexedDB backend over the idb wrapper. Browser only. */
export class IdbBackend implements StorageBackend {
  private constructor(private readonly db: DrGlitchDatabase) {}

  static async open(): Promise<IdbBackend> {
    return new IdbBackend(await openDrGlitchDatabase());
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return (await this.db.get(store, key)) as T | undefined;
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    await this.db.put(store, value as never, key);
  }

  async delete(store: StoreName, key: string): Promise<void> {
    await this.db.delete(store, key);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return (await this.db.getAll(store)) as T[];
  }

  async getAllKeys(store: StoreName): Promise<string[]> {
    return (await this.db.getAllKeys(store)) as string[];
  }

  async transaction(
    stores: StoreName[],
    work: (tx: BackendTransaction) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException("The storage transaction was aborted.", "AbortError");
    const tx = this.db.transaction(stores as never[], "readwrite");
    let active = true;
    const assertActive = (): void => {
      if (!active || signal?.aborted) {
        throw new DOMException("The storage transaction was aborted.", "AbortError");
      }
    };
    const wrapper: BackendTransaction = {
      get: async (store, key) => {
        assertActive();
        return (await tx.objectStore(store as never).get(key)) as never;
      },
      put: async (store, key, value) => {
        assertActive();
        await tx.objectStore(store as never).put(value as never, key);
      },
      delete: async (store, key) => {
        assertActive();
        await tx.objectStore(store as never).delete(key);
      },
      getAll: async (store) => {
        assertActive();
        return (await tx.objectStore(store as never).getAll()) as never;
      },
      getAllKeys: async (store) => {
        assertActive();
        return (await tx.objectStore(store as never).getAllKeys()) as never;
      },
    };
    const onAbort = (): void => {
      if (!active) return;
      try {
        tx.abort();
      } catch {
        // tx.done is the authority: if commit already won it will resolve;
        // otherwise it rejects. Never guess from an InvalidStateError.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Native abort must also interrupt a defective/stalled callback. Attach
    // the tx.done rejection handler immediately so a request failure cannot
    // leak an unhandled rejection while the callback unwinds.
    const failed = new Promise<never>((_resolve, reject) => { void tx.done.catch(reject); });
    try {
      await Promise.race([work(wrapper), failed]);
      // A cancellation observed before the atomic transaction settles asks
      // IndexedDB to roll it back. Once tx.done resolves, commit is terminal
      // success and no later signal is allowed to rewrite that truth.
      if (signal?.aborted) onAbort();
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Transaction may already be aborted (e.g. quota failure).
      }
      await tx.done.catch(() => undefined);
      throw error;
    } finally {
      active = false;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    this.db.close();
  }
}
