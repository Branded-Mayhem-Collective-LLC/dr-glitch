/**
 * Home-library decoration: attaches the session controller's cancellable
 * .drglitch import handle to the ProjectLibraryApi the home surface renders
 * against, WITHOUT touching session-controller.ts (the library base binding
 * lives there; this wrapper is the wave-F UI seam).
 */

import type { AppSessionController } from "./session-controller";
import type { ProjectImportHandle, ProjectLibraryApi } from "../home/library";

/**
 * The controller's library plus importProjectFileCancellable, so the home
 * surface can show real progress and offer a Cancel that aborts the whole
 * operation (typed "archive-aborted", exactly-once cleanup, zero rows).
 */
export function libraryWithCancellableImport(
  controller: AppSessionController,
): ProjectLibraryApi {
  return {
    ...controller.library,
    importProjectFileCancellable: (file: File): ProjectImportHandle =>
      controller.importProjectFileCancellable(file),
  };
}
