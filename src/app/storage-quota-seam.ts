/**
 * Dev-only storage QUOTA injection seam (Playwright E2E).
 *
 * Quota exhaustion cannot be simulated faithfully from Playwright: mocking
 * navigator.storage.estimate() does not make IndexedDB writes throw, and
 * Chromium exposes no CDP switch to shrink the origin quota at runtime. So
 * dev builds wrap the storage backend with this seam: while the
 * `drglitch.debug.simulate-quota` localStorage flag is "1", every WRITE
 * operation (put / delete / transaction) throws a real
 * DOMException("...", "QuotaExceededError") exactly where IndexedDB would;
 * reads keep working, mirroring genuine quota pressure. The flag is read
 * per operation, so a test can arm and disarm it mid-session.
 *
 * Production builds never contain this module: the only importer is a
 * dynamic import inside a statically-false `import.meta.env.DEV` branch in
 * app-context (the same idiom as the export-tile-delay seam and the dev
 * component lab), which Vite dead-code-eliminates.
 */

import type { StorageBackend } from "../storage";
import { IdbBackend, MemoryBackend } from "../storage";
import {
  AppSessionController,
  browserKeyValueStore,
  type AppSessionOptions,
} from "./session-controller";

/** localStorage flag: "1" = simulate QuotaExceededError on every write. */
export const QUOTA_SIMULATION_STORAGE_KEY = "drglitch.debug.simulate-quota";

export function quotaSimulationActive(): boolean {
  try {
    return window.localStorage.getItem(QUOTA_SIMULATION_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function simulatedQuotaError(): DOMException {
  return new DOMException(
    "Simulated storage quota exceeded (dev seam drglitch.debug.simulate-quota).",
    "QuotaExceededError",
  );
}

/** Backend wrapper: reads pass through; writes throw while the flag is set. */
export function withSimulatedQuota(backend: StorageBackend): StorageBackend {
  return {
    get: (store, key) => backend.get(store, key),
    getAll: (store) => backend.getAll(store),
    getAllKeys: (store) => backend.getAllKeys(store),
    put: (store, key, value) => {
      if (quotaSimulationActive()) return Promise.reject(simulatedQuotaError());
      return backend.put(store, key, value);
    },
    delete: (store, key) => {
      if (quotaSimulationActive()) return Promise.reject(simulatedQuotaError());
      return backend.delete(store, key);
    },
    transaction: (stores, work) => {
      if (quotaSimulationActive()) return Promise.reject(simulatedQuotaError());
      return backend.transaction(stores, work);
    },
    close: () => backend.close(),
  };
}

/**
 * Dev-build session boot: identical to AppSessionController.create()
 * (IdbBackend with MemoryBackend fallback, per-tab sessionStorage last-open
 * store, owned backend) with the quota seam wrapped around the backend.
 * With the flag unset the wrapper is pure pass-through.
 */
export async function createDevSessionController(
  options: Omit<AppSessionOptions, "backend" | "backendKind" | "ownsBackend"> = {},
): Promise<AppSessionController> {
  let backend: StorageBackend;
  let backendKind: "idb" | "memory";
  try {
    backend = await IdbBackend.open();
    backendKind = "idb";
  } catch {
    backend = new MemoryBackend();
    backendKind = "memory";
  }
  const keyValue =
    options.keyValue ?? (typeof window !== "undefined" ? browserKeyValueStore() : null);
  return new AppSessionController({
    ...options,
    backend: withSimulatedQuota(backend),
    backendKind,
    ownsBackend: true,
    ...(keyValue ? { keyValue } : {}),
  });
}
