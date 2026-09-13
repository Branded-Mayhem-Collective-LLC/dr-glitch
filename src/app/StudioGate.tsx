/**
 * "/" route gate. Decides between the home surface and the studio:
 * - `/?project=<id>` opens that project.
 * - A bare "/" reopens this tab's last-open project (sessionStorage — a NEW
 *   tab always lands on Home; a reload of a studio tab restores its project,
 *   applying any newer recovery journal).
 * - Otherwise the home surface renders inline (clean-storage contract).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { HomeScreen } from "../home/HomeScreen";
import HalftoneStudio from "../studio/HalftoneStudio";
import { CorruptRecordError, NotFoundError } from "../storage";
import { captureHandledError } from "../telemetry/sentry";
import { useAppSession, useOptionalAppSession, useSessionSnapshot } from "./app-context";
import { libraryWithCancellableImport } from "./library-import";
import { StorageModeBanner } from "./StorageModeBanner";

/**
 * Thin readiness gate: the session provider renders routes immediately, so
 * this component waits out the async storage boot itself before mounting
 * the session-consuming gate body.
 */
export function StudioGate() {
  const controller = useOptionalAppSession();
  if (!controller) return null;
  return <StudioGateBody />;
}

function StudioGateBody() {
  const controller = useAppSession();
  const snapshot = useSessionSnapshot();
  // Stable per-controller: the home library plus the cancellable-import
  // handle (progress + Cancel affordance for .drglitch intake).
  const library = useMemo(() => libraryWithCancellableImport(controller), [controller]);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requested = params.get("project");
  const [failedId, setFailedId] = useState<string | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  const targetId = requested ?? controller.lastOpenProjectId;
  const shouldOpen = targetId !== null && failedId !== targetId;

  useEffect(() => {
    if (!shouldOpen || !targetId) return;
    if (snapshot.open?.projectId === targetId) return;
    let cancelled = false;
    void controller.openProject(targetId).catch((error: unknown) => {
      if (cancelled) return;
      // Loud failure: fall back to Home, but never silently — the reason is
      // logged and surfaced as an alert (e.g. an unsaved in-memory project
      // whose id survived a reload cannot be reopened).
      console.error(`Project ${targetId} could not be opened`, error);
      // Telemetry: a damaged at-rest row is the signal worth watching for;
      // a stale id (NotFoundError — e.g. an unsaved project id surviving a
      // reload) is routine and never reported.
      if (!(error instanceof NotFoundError)) {
        captureHandledError(
          error instanceof CorruptRecordError ? "storage-corrupt-record" : "project-open-failed",
          error,
        );
      }
      controller.clearLastOpenProject();
      setFailedId(targetId);
      setFailureMessage(
        error instanceof Error && error.message
          ? error.message
          : "The project could not be opened.",
      );
    });
    return () => {
      cancelled = true;
    };
  }, [controller, shouldOpen, targetId, snapshot.open?.projectId]);

  if (!shouldOpen) {
    return (
      <>
        <StorageModeBanner />
        {failureMessage !== null ? (
          <p role="alert" className="home-notice" data-testid="ws-open-error">
            {failureMessage}
          </p>
        ) : null}
        <HomeScreen
          library={library}
          onOpenProject={(id) => {
            setFailedId(null);
            setFailureMessage(null);
            navigate(`/?project=${encodeURIComponent(id)}`);
          }}
        />
      </>
    );
  }

  if (!snapshot.open || snapshot.open.projectId !== targetId) {
    // Brief storage round-trip; the shell mounts as soon as the project opens.
    return null;
  }

  return (
    <>
      <StorageModeBanner />
      <HalftoneStudio key={snapshot.open.projectId} />
    </>
  );
}
