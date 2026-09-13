/**
 * StudioApi — the contract between the studio state owner (HalftoneStudio)
 * and every workspace panel/drawer. Panels never reach into studio state
 * directly; they read and mutate through this context. When the multi-layer
 * project store lands, this surface is the seam where panel wiring moves
 * from single-artwork settings to project commands.
 */

import { createContext, useContext } from "react";
import type { Id, OutputDefaultsV1, PreflightIssue } from "../core/types";
import type { ExportSessionStore } from "../export/export-session";
import type { ExportTarget } from "../export/targets";
import type { VectorEligibility } from "../export/preflight";
import type { CustomShapeAsset } from "../studio/custom-shape-data";
import type { DocumentSettings } from "../studio/document-model";
import type { HalftoneSettings, Plate } from "../studio/halftone";

export type ProcessPlate = Exclude<Plate, "composite">;

/**
 * The real export pipeline surface (src/app/export-flow): preflight via
 * evaluate() with probed capabilities, revision-bound warning
 * acknowledgement, orchestrated start with progress + explicit cancel.
 */
export type ExportPipeline = {
  /** Preflight the target against the CURRENT core/revision (sync). */
  evaluate(target: ExportTarget): PreflightIssue[];
  vectorEligibility(): VectorEligibility;
  /** Primary layer for Selected Layer exports; null with no layers. */
  selectedLayerId: Id | null;
  /** Warn issues still needing explicit confirmation for this revision. */
  unconfirmedWarnings(issues: PreflightIssue[]): PreflightIssue[];
  confirmWarnings(issues: PreflightIssue[]): void;
  start(
    target: ExportTarget,
    hooks: { onProgress?(fraction: number): void },
  ): { cancel(): void; done: Promise<"done" | "cancelled" | "error"> };
};

export type RegistrationLayout = "corners" | "centered";

export type UnitDisplay = "px" | "in" | "mm";

export type PreflightSummary = {
  reviewCount: number;
  hiddenPlates: ProcessPlate[];
  sharedAngleGroups: Array<[number, ProcessPlate[]]>;
  registrationOff: boolean;
  polarityInverted: boolean;
  dense: boolean;
  screenLoad: { marks: number; plate: ProcessPlate | null };
  diffusionPixelLoad: number;
  diffusionMemoryMiB: number;
};

export type StudioApi = {
  /* Artwork source */
  source: HTMLImageElement | HTMLCanvasElement | null;
  sourceName: string;
  sourceMeta: string;
  requestArtworkFile: () => void;
  resetArtwork: () => void;

  /* Halftone / diffusion / glitch settings */
  settings: HalftoneSettings;
  updateSetting: <K extends keyof HalftoneSettings>(
    key: K,
    value: HalftoneSettings[K],
  ) => void;
  setAngles: (angles: Record<ProcessPlate, number>) => void;
  resetHalftone: () => void;
  resetDiffusion: () => void;
  resetGlitch: () => void;
  resetOutput: () => void;
  openCustomShapeDialog: () => void;

  /* Plates */
  activePlate: Plate;
  applicablePlates: ProcessPlate[];
  enabledPlates: ProcessPlate[];
  hiddenPlates: ProcessPlate[];
  soloPlate: (plate: Plate) => void;
  togglePlateVisible: (plate: ProcessPlate) => void;
  setPlateAngle: (plate: ProcessPlate, angle: number) => void;

  /* Document / sheet */
  documentSettings: DocumentSettings;
  updateDocument: (patch: Partial<DocumentSettings>) => void;
  fitArtworkToSheet: () => void;
  outputDimensions: { width: number; height: number };
  unitDisplay: UnitDisplay;
  setUnitDisplay: (unit: UnitDisplay) => void;

  /* Proof view */
  zoom: number;
  setZoom: (zoom: number) => void;
  zoomBounds: { min: number; max: number; fit: number };

  /* Canonical output ownership (core.output — OutputDefaultsV1).
   * The Output drawer binds here directly and UNDOABLY; it never edits
   * layer recipes or transforms. */
  output: OutputDefaultsV1;
  updateOutput: (patch: Partial<OutputDefaultsV1>) => void;

  /* Proof registration overlay — SESSION-ONLY view state (never persisted
   * to core, never exported, never undoable). Until the operator toggles
   * it explicitly, it follows core.output.registrationOnPlates so the
   * proof previews the plate-package default. */
  proofRegistration: boolean;
  setProofRegistration: (enabled: boolean) => void;

  /* Registration / output */
  registration: boolean;
  setRegistrationEnabled: (enabled: boolean) => void;
  registrationMode: RegistrationLayout;
  setRegistrationMode: (mode: RegistrationLayout) => void;
  registrationSize: number;
  setRegistrationSize: (value: number) => void;
  registrationOffset: number;
  setRegistrationOffset: (value: number) => void;
  registrationWeight: number;
  setRegistrationWeight: (value: number) => void;
  registrationShape: CustomShapeAsset | undefined;
  requestRegistrationFile: () => void;

  /* Registration on composite exports (document default; the plate-package
   * default is setRegistrationEnabled / registrationOnPlates above). */
  setCompositeRegistration: (enabled: boolean) => void;

  /* Preflight / export */
  preflight: PreflightSummary;
  copyJobTicket: () => void;
  exportPipeline: ExportPipeline;
  /**
   * Session-owned export workflow state (target/progress/cancel/warnings).
   * Lives with the studio session, NOT the conditionally-mounted panel, so
   * a re-mounted Export panel binds back into a live run.
   */
  exportSession: ExportSessionStore;
  exporting: boolean;

  /* Notices (toast) */
  notify: (message: string) => void;
};

export const StudioApiContext = createContext<StudioApi | null>(null);

export function useStudioApi(): StudioApi {
  const api = useContext(StudioApiContext);
  if (!api) {
    throw new Error("useStudioApi must be used inside StudioApiContext");
  }
  return api;
}
