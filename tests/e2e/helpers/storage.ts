import type { Page } from "@playwright/test";

/**
 * Storage contract — see docs/specs/2026-09-12-e2e-coverage-map.md §1.
 * These names are part of the binding selector/storage contract the
 * implementation must satisfy.
 */

/** IndexedDB database name for projects/assets/recovery/presets/trash. */
export const APP_DB_NAME = "drglitch";

/** localStorage key holding the persisted WorkspaceLayoutStateV1 JSON. */
export const LAYOUT_STORAGE_KEY = "drglitch.workspace-layout.v1";

/**
 * Dev-build-only test seam: when this localStorage key holds a positive
 * integer, export jobs add that many milliseconds of artificial delay per
 * tile/plate so progress and cancellation are deterministically observable.
 * Production builds ignore the key entirely.
 */
export const EXPORT_DELAY_STORAGE_KEY = "drglitch.debug.export-tile-delay-ms";

/**
 * Dev-build-only test seam: while this localStorage key is "1", every
 * storage-backend WRITE throws a real DOMException QuotaExceededError
 * (src/app/storage-quota-seam.ts) so the quota E2E can exercise the
 * journal/save failure paths. Read per write — arm/disarm mid-session.
 * Production builds do not contain the seam at all (DCE).
 */
export const QUOTA_SIMULATION_STORAGE_KEY = "drglitch.debug.simulate-quota";

/**
 * Clears every client-side store the workstation uses (localStorage,
 * sessionStorage, all IndexedDB databases) and reloads, so each test starts
 * on the clean-storage home surface.
 */
export async function resetAppStorage(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async (fallbackDbName) => {
    localStorage.clear();
    sessionStorage.clear();
    const names: string[] = [];
    if ("databases" in indexedDB) {
      // Chromium/Firefox/WebKit all ship databases() on current versions;
      // the fallback below covers engines where it is absent.
      for (const database of await indexedDB.databases()) {
        if (database.name) names.push(database.name);
      }
    } else {
      names.push(fallbackDbName);
    }
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      ),
    );
  }, APP_DB_NAME);
  await page.reload();
}
