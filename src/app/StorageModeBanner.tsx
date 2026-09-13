/**
 * Loud, persistent alert shown whenever the session runs on the in-memory
 * fallback backend (IndexedDB unavailable). Saving still works for the life
 * of the tab, but nothing survives a reload — the user must know this
 * BEFORE trusting Save or the "projects stay on this device" copy.
 */
import { useSessionSnapshot } from "./app-context";

export function StorageModeBanner() {
  const snapshot = useSessionSnapshot();
  if (snapshot.durable) return null;
  return (
    <div
      role="alert"
      className="home-notice ws-storage-mode-banner"
      data-testid="ws-storage-mode-banner"
    >
      Device storage is unavailable, so projects cannot be stored on this
      device right now. Save keeps working while this tab stays open, but
      nothing — saves, recovery journals, or presets — will survive a reload.
      Export your work (File → Export Project) to keep it.
    </div>
  );
}
