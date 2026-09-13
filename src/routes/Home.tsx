/**
 * Start/home route. Renders the HomeScreen against the bound project
 * library. setProjectLibrary is called by the app session provider once the
 * storage-backed library exists; binding is reactive, so this route can
 * mount before the async session boot finishes (it renders nothing until
 * the real library arrives — never demo data on the production path).
 */

import { useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { HomeScreen } from "../home/HomeScreen";
import type { ProjectLibraryApi } from "../home/library";

let boundLibrary: ProjectLibraryApi | null = null;
const bindingListeners = new Set<() => void>();

/** Binds the production project library (storage repositories). */
export function setProjectLibrary(library: ProjectLibraryApi): void {
  boundLibrary = library;
  for (const listener of [...bindingListeners]) listener();
}

function useBoundLibrary(): ProjectLibraryApi | null {
  return useSyncExternalStore(
    (listener) => {
      bindingListeners.add(listener);
      return () => void bindingListeners.delete(listener);
    },
    () => boundLibrary,
    () => boundLibrary,
  );
}

export default function Home() {
  const navigate = useNavigate();
  const library = useBoundLibrary();

  // Session boot still pending: paint nothing rather than demo data.
  if (!library) return null;

  return (
    <HomeScreen
      library={library}
      onOpenProject={(id) => navigate(`/?project=${encodeURIComponent(id)}`)}
    />
  );
}
