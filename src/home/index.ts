/** Public surface of the start/home subsystem. */

export type { ProjectLibraryApi, ProjectSummary, TrashSummary } from "./library";
export { createDemoLibrary } from "./demo-library";
export {
  guardDirtyWork,
  type DirtyGuardChoice,
  type DirtyGuardOptions,
  type DirtyGuardOutcome,
} from "./dirty-guard";
export {
  ConfirmDialog,
  DirtyWorkDialog,
  type ConfirmDialogProps,
  type DirtyWorkDialogProps,
} from "./DirtyWorkDialog";
export { HomeScreen, type HomeScreenProps } from "./HomeScreen";
