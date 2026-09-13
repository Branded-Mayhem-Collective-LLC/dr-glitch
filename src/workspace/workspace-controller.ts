/**
 * WorkspaceController — the shell's imperative surface for panels, drawers,
 * and chrome. Wraps the pure reducer dispatch with viewport-aware helpers so
 * leaf components never measure the workspace themselves.
 */

import { createContext, useContext } from "react";
import type { PanelRect, ToolId } from "../core/types";
import type {
  DrawerId,
  GestureKind,
  Viewport,
  WorkspaceAction,
  WorkspaceState,
} from "./layout-state";

export type WorkspaceController = {
  state: WorkspaceState;
  dispatch: (action: WorkspaceAction) => void;
  /** Size of the workspace area floats are positioned within. */
  getViewport: () => Viewport;
  activateTool: (toolId: ToolId) => void;
  focusPanel: (toolId: ToolId) => void;
  closePanel: (toolId: ToolId) => void;
  floatPanel: (toolId: ToolId) => void;
  /** Undock into a float at an explicit rect (drag-to-undock). */
  floatPanelAt: (toolId: ToolId, rect: PanelRect) => void;
  dockPanel: (toolId: ToolId) => void;
  /** Highlight (or clear) the dock as the active drop target mid-drag. */
  setDockDropTarget: (active: boolean) => void;
  resetPanelPosition: (toolId: ToolId) => void;
  beginGesture: (toolId: ToolId, kind: GestureKind) => void;
  updateGesture: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  commitGesture: () => void;
  cancelGesture: () => void;
  setExpandedDrawer: (drawer: DrawerId | null) => void;
};

export const WorkspaceControllerContext =
  createContext<WorkspaceController | null>(null);

export function useWorkspaceController(): WorkspaceController {
  const controller = useContext(WorkspaceControllerContext);
  if (!controller) {
    throw new Error(
      "useWorkspaceController must be used inside the workspace shell",
    );
  }
  return controller;
}
