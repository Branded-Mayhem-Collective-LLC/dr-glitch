/**
 * Pure helpers behind the home surface's cancellable .drglitch import UI
 * (progress copy + typed-cancel detection). React-free so the flow's
 * user-facing semantics are unit-testable in node.
 */

import type { ProjectImportProgress } from "./library";

export const IMPORT_PHASE_LABELS: Record<ProjectImportProgress["phase"], string> = {
  extract: "Extracting archive",
  validate: "Validating media",
  stage: "Staging assets",
  commit: "Installing project",
};

export const IMPORT_CANCELLED_NOTICE = "Import cancelled — nothing was installed.";

/** One-line progress readout for the import status region. */
export function describeImportProgress(
  filename: string,
  progress: ProjectImportProgress | null,
): string {
  if (!progress) return `Importing “${filename}” — reading file…`;
  const counters =
    progress.assetsTotal > 0
      ? ` (${progress.assetsDone}/${progress.assetsTotal} assets)`
      : "…";
  return `Importing “${filename}” — ${IMPORT_PHASE_LABELS[progress.phase]}${counters}`;
}

/**
 * True only for the session import's TYPED cancellation rejection
 * ("archive-aborted") — a user's own Cancel is announced calmly, never as
 * a failure; every other rejection surfaces its typed message.
 */
export function isImportCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "archive-aborted"
  );
}
