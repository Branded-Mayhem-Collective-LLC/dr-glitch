import { useOptionalAppSession, useSessionSnapshot } from "../app/app-context";
import HalftoneStudio from "./HalftoneStudio";

/** The provider prepares one ephemeral artwork; no library or saved-project lookup. */
export function BrowserStudioGate() {
  return useOptionalAppSession() ? <ReadyStudio /> : <p role="status">Opening artwork…</p>;
}

function ReadyStudio() {
  const snapshot = useSessionSnapshot();
  return snapshot.open ? <HalftoneStudio key={snapshot.open.projectId} /> : null;
}
