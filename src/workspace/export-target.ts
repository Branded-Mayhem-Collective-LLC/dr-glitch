/**
 * Shared export-target construction from the session workflow state.
 *
 * The Export panel and the Output drawer's readiness line must agree on
 * what "the active export target" is — the drawer's press-readiness count
 * is the ACTIVE target's preflight evaluate() result, not a parallel
 * summary. One pure builder keeps them in lockstep.
 */

import type { Id } from "../core/types";
import type { ExportSessionState } from "../export/export-session";
import type { ExportTarget } from "../export/targets";

export type BuildTargetContext = {
  /** Primary layer for Selected Layer exports; null with no layers. */
  selectedLayerId: Id | null;
  /** Vector plate eligibility; an ineligible "svg" choice falls back to png. */
  vectorEligible: boolean;
};

/**
 * The active export target for the current session state, or null when the
 * selection cannot form one (Selected Layer with no layers).
 */
export function buildTargetFromSession(
  state: ExportSessionState,
  context: BuildTargetContext,
  kind: ExportSessionState["targetKind"] = state.targetKind,
): ExportTarget | null {
  if (kind === "composite") {
    return { kind: "composite", format: state.compositeFormat };
  }
  if (kind === "plate-package") {
    const format =
      !context.vectorEligible && state.plateFormat === "svg" ? "png" : state.plateFormat;
    return { kind: "plate-package", format };
  }
  if (!context.selectedLayerId) return null;
  return {
    kind: "selected-layer",
    format: state.layerFormat,
    layerId: context.selectedLayerId,
    registration: state.layerRegistration,
  };
}
