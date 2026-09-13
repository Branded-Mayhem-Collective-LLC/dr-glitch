/**
 * React binding for the app session spine. AppSessionProvider constructs the
 * controller once (IdbBackend with MemoryBackend fallback), installs the
 * lifecycle journal flush, binds the home-route project library, and exposes
 * the controller through context.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { setProjectLibrary } from "../routes/Home";
import { AppErrorBoundary } from "./ErrorBoundary";
import { libraryWithCancellableImport } from "./library-import";
import { createSampleArtwork } from "./sample";
import {
  AppSessionController,
  type SessionSnapshot,
} from "./session-controller";

/**
 * Production sessions always boot through AppSessionController.create().
 * Dev builds route through the storage quota seam module instead, whose
 * backend wrapper simulates QuotaExceededError while a localStorage debug
 * flag is set (the Playwright quota E2E, mirroring the export-delay seam
 * idiom). The DEV guard is statically false in production builds, so the
 * dynamic import — and the whole seam chunk — is dead-code-eliminated.
 */
async function createSessionController(): Promise<AppSessionController> {
  if (import.meta.env.DEV) {
    const { createDevSessionController } = await import("./storage-quota-seam");
    return createDevSessionController({ sampleFactory: createSampleArtwork });
  }
  return AppSessionController.create({ sampleFactory: createSampleArtwork });
}

/**
 * `undefined` = no provider above (programming error); `null` = provider
 * mounted but AppSessionController.create() has not resolved yet. The
 * provider renders children IMMEDIATELY — non-session routes (landing,
 * login, signup) must paint at document load, not after the async storage
 * boot — so session-consuming components gate themselves on the pending
 * state via useOptionalAppSession.
 */
const AppSessionContext = createContext<AppSessionController | null | undefined>(undefined);

/** Journal flush on tab hide/close so recovery never trails a crash. */
function installLifecycleFlush(controller: AppSessionController): () => void {
  const flush = () => void controller.flushJournalNow();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", flush);
  };
}

/**
 * The provider effect body, extracted so the StrictMode double-invoke
 * sequence (setup → cleanup → setup with a late-resolving async create) is
 * unit-testable against the REAL shipped logic. Contract:
 * - Each setup pass owns exactly one controller and its cleanup disposes
 *   exactly that one — the second StrictMode pass gets its own fresh
 *   instance instead of a disposed leak.
 * - When cleanup runs while create() is still in flight, the late-resolving
 *   controller is disposed immediately (journal timers, ownership bus,
 *   backend/IDB connection) so it cannot leak or block IndexedDB deletion,
 *   and onReady is never called for it.
 */
export function acquireSessionForMount(deps: {
  create: () => Promise<AppSessionController>;
  onReady: (controller: AppSessionController) => void;
  onTeardown?: () => void;
}): () => void {
  let alive = true;
  let owned: AppSessionController | null = null;
  void deps.create().then((created) => {
    if (!alive) {
      void created.dispose();
      return;
    }
    owned = created;
    deps.onReady(created);
  });
  return () => {
    alive = false;
    if (owned) {
      void owned.dispose();
      owned = null;
      deps.onTeardown?.();
    }
  };
}

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<AppSessionController | null>(null);

  useEffect(() => {
    let removeLifecycle: (() => void) | null = null;
    const release = acquireSessionForMount({
      create: createSessionController,
      onReady: (created) => {
        // Wave-F UI seam: the bound library carries the cancellable-import
        // handle so the home surface can show progress and offer Cancel.
        setProjectLibrary(libraryWithCancellableImport(created));
        removeLifecycle = installLifecycleFlush(created);
        setController(created);
      },
      onTeardown: () => setController(null),
    });
    return () => {
      removeLifecycle?.();
      release();
    };
  }, []);

  return (
    <AppSessionContext.Provider value={controller}>
      <AppErrorBoundary>{children}</AppErrorBoundary>
    </AppSessionContext.Provider>
  );
}

/** The controller, or null while the async session boot is still pending. */
export function useOptionalAppSession(): AppSessionController | null {
  const controller = useContext(AppSessionContext);
  if (controller === undefined) {
    throw new Error("useAppSession must be used inside AppSessionProvider");
  }
  return controller;
}

export function useAppSession(): AppSessionController {
  const controller = useOptionalAppSession();
  if (!controller) {
    throw new Error(
      "The app session is not ready yet; gate on useOptionalAppSession before rendering session consumers",
    );
  }
  return controller;
}

export function useSessionSnapshot(): SessionSnapshot {
  const controller = useAppSession();
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
}
