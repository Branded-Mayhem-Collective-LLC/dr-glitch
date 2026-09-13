/**
 * ProjectUi — the workspace-side contract for everything project-shaped:
 * identity, dirty/recovery/read-only status, undo/redo, layers + selection,
 * snapshots, and recipe presets. HalftoneStudio (the state owner) builds one
 * per open project; TopBar and the panels consume it exclusively through
 * this context so they never touch the store or repositories directly.
 */
import { createContext, useContext } from "react";
import type { Id, LayerV1, ProjectCoreV1, RecipePresetV1, SnapshotV1 } from "../core/types";
import type { Command } from "../project";

export type RecoveryUiState = "none" | "pending" | "flushed";

/** On-canvas editing mode for the primary selection (Select panel toggles). */
export type EditorMode = "transform" | "crop" | "perspective";

export type ProjectUi = {
  /* Identity + status */
  projectId: Id;
  title: string;
  dirty: boolean;
  readOnly: boolean;
  recovered: boolean;
  recoveryState: RecoveryUiState;
  storageAlert: string | null;
  dismissStorageAlert: () => void;

  /* Document */
  core: ProjectCoreV1;
  layers: LayerV1[];
  selectedLayerIds: Id[];
  primaryLayerId: Id | null;
  selectLayer: (layerId: Id, options?: { additive?: boolean }) => void;

  /* History */
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  undoLabels: readonly (string | null)[];
  undo: () => void;
  redo: () => void;

  /* Topbar actions (dirty-guarded where destructive) */
  requestNewProject: () => void;
  requestHome: () => void;
  requestSave: () => void;
  requestRename: () => void;

  /* Ownership (read-only sessions) */
  requestOwnership: () => void;
  duplicateReadonly: () => void;

  /* Recovery banner */
  saveRecovered: () => void;
  revertToLastSave: () => void;

  /* Layers */
  addLayerFromFile: () => void;
  duplicateLayer: (layerId: Id) => void;
  removeLayer: (layerId: Id) => void;
  moveLayer: (layerId: Id, direction: "up" | "down") => void;
  renameLayer: (layerId: Id, name: string) => void;
  setLayerVisible: (layerId: Id, visible: boolean) => void;
  setLayerLocked: (layerId: Id, locked: boolean) => void;
  setLayerOpacity: (layerId: Id, opacity: number) => void;
  setLayerMode: (layerId: Id, mode: LayerV1["recipe"]["mode"]) => void;
  setLayerPosition: (layerId: Id, axis: "x" | "y", value: number) => void;
  /**
   * Copy Recipe / Apply to Selected: applies the PRIMARY layer's full
   * recipe (mode + halftone + diffusion + glitch) to every other selected
   * UNLOCKED layer as ONE undo transaction. Explicit action — recipe
   * editing otherwise affects only the primary layer.
   */
  applyRecipeToSelected: () => void;

  /* Guides / grid / snapping (document-global) */
  updateGrid: (patch: Partial<ProjectCoreV1["grid"]>) => void;
  updateSnapping: (patch: Partial<ProjectCoreV1["snapping"]>) => void;
  setGuidesVisible: (visible: boolean) => void;
  setGuidesLocked: (locked: boolean) => void;
  clearGuides: () => void;

  /* Editor surface (canvas overlays, Select panel, Document drawer) */
  /** Generic undoable command application (gesture-coalescing aware). */
  applyCommands: (commands: Command | Command[], label: string) => boolean;
  editorMode: EditorMode;
  setEditorMode: (mode: EditorMode) => void;
  /** Session-only ruler visibility (Document drawer toggle; never undoable). */
  rulersVisible: boolean;
  setRulersVisible: (visible: boolean) => void;
  /** Decoded pixel dimensions of a layer's source asset, when known. */
  assetSizeFor: (layerId: Id) => { width: number; height: number } | null;
  /** Validated custom artboard resize (Document drawer). */
  resizeArtboard: (widthPx: number, heightPx: number) => void;

  /* Snapshots */
  snapshots: SnapshotV1[];
  snapshotCap: number;
  createSnapshot: (name: string) => Promise<boolean>;
  restoreSnapshot: (snapshotId: Id) => void;
  deleteSnapshot: (snapshotId: Id) => void;
  duplicateSnapshotToProject: (snapshotId: Id) => void;

  /* Recipe presets (device-global) */
  presets: RecipePresetV1[];
  savePreset: (name: string) => Promise<boolean>;
  applyPreset: (presetId: Id) => void;
  deletePreset: (presetId: Id) => void;
  exportPreset: (presetId: Id) => void;
  importPresetFile: (file: File) => Promise<boolean>;
};

export const ProjectUiContext = createContext<ProjectUi | null>(null);

export function useProjectUi(): ProjectUi {
  const ui = useContext(ProjectUiContext);
  if (!ui) throw new Error("useProjectUi must be used inside the studio");
  return ui;
}
