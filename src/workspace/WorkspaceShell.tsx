/**
 * WorkspaceShell — the permanent creative-workstation frame.
 *
 * 48px top command bar, 52px permanent left tool rail, central canvas,
 * right dock (default 360px, resizable 320–520px) with fixed drawers above
 * the docked tool panel, and in-app floating panels. Layout persists to
 * localStorage as WorkspaceLayoutStateV1; session state (active tool, focus,
 * Focus Mode) never persists. Below 1280×800 only the editor area is
 * replaced by a size notice (CSS gate) — components stay mounted, so
 * project and layout state survive.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PRODUCT_NAME } from "../brand";
import "./workstation-a11y.css";
import type { PanelRect, ToolCapabilityContext, ToolId } from "../core/types";
import { DockSplitter } from "./DockSplitter";
import { Drawers } from "./Drawers";
import { HelpDialog } from "./HelpDialog";
import { PanelFrame } from "./PanelFrame";
import { WORKSTATION_TOOL_REGISTRY } from "./workstation-tool-registry";
import {
  createDefaultLayout,
  createDefaultWorkspaceState,
  getPlacement,
  openFloats,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  type Viewport,
  type WorkspaceState,
} from "./layout-state";
import {
  createToolShortcuts,
  readSingleKeyShortcutsDisabled,
  useWorkspaceShortcuts,
  writeSingleKeyShortcutsDisabled,
  type ModifierShortcutBinding,
  type ShortcutBinding,
} from "./shortcuts";
import { useProjectUi } from "./project-ui";
import { useStudioApi } from "./studio-api";
import { ToolRail } from "./ToolRail";
import { TopBar } from "./TopBar";
import {
  WorkspaceControllerContext,
  type WorkspaceController,
} from "./workspace-controller";
import { PLATES } from "../studio/halftone";
import { workspaceReducer } from "./layout-state";

const FALLBACK_VIEWPORT: Viewport = { width: 1280, height: 752 };

function initWorkspaceState(): WorkspaceState {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  } catch {
    // Storage unavailable (privacy mode); run on defaults.
  }
  return createDefaultWorkspaceState(
    parseWorkspaceLayout(stored) ?? createDefaultLayout(),
  );
}

export function WorkspaceShell({ canvas }: { canvas: ReactNode }) {
  const api = useStudioApi();
  const project = useProjectUi();
  const mainRef = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    initWorkspaceState,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const helpReturnFocusRef = useRef<HTMLElement | null>(null);
  const canvasSectionRef = useRef<HTMLElement>(null);

  /* ----- WCAG 2.1.4: user switch for unmodified character-key shortcuts */
  const [singleKeyShortcutsDisabled, setSingleKeyShortcutsDisabled] = useState(
    readSingleKeyShortcutsDisabled,
  );
  const toggleSingleKeyShortcuts = useCallback(() => {
    setSingleKeyShortcutsDisabled((disabled) => {
      writeSingleKeyShortcutsDisabled(!disabled);
      return !disabled;
    });
  }, []);

  /*
   * Shortcut-triggered UI changes can unmount the focused control (tool
   * switch swaps the dock panel; Focus Mode hides the rail). Keyboard focus
   * must never strand on <body>: recover to the active tool's rail button,
   * or to the canvas region while the rail is hidden.
   */
  const stateRef = useRef(state);
  stateRef.current = state;
  const recoverShortcutFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const railButton = document.querySelector<HTMLElement>(
        `[data-testid="ws-rail-${stateRef.current.activeToolId}"]`,
      );
      if (railButton) railButton.focus();
      else canvasSectionRef.current?.focus();
    });
  }, []);

  /* ----- size gate: announce activation, manage displaced focus -----
   * The gate itself is CSS-only (globals.css) so nothing unmounts; this
   * mirror of the SAME media query adds the accessibility contract: a
   * polite live announcement when the editor is replaced, and keyboard
   * focus recovery — a focused control inside a display:none region would
   * otherwise silently drop focus to <body>. */
  const sizeGateRef = useRef<HTMLDivElement>(null);
  const [sizeGateActive, setSizeGateActive] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1279px), (max-height: 799px)");
    const applyState = (active: boolean) => {
      setSizeGateActive(active);
      window.requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (active) {
          // Focus stranded inside a gated (hidden) region moves to the gate.
          if (
            !focused ||
            focused === document.body ||
            (focused instanceof HTMLElement && focused.offsetParent === null &&
              !focused.closest('[data-testid="ws-topbar"]'))
          ) {
            sizeGateRef.current?.focus();
          }
        } else if (
          !focused ||
          focused === document.body ||
          focused === sizeGateRef.current
        ) {
          recoverShortcutFocus();
        }
      });
    };
    setSizeGateActive(query.matches);
    const onChange = (event: MediaQueryListEvent) => applyState(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [recoverShortcutFocus]);

  const getViewport = useCallback((): Viewport => {
    const bounds = mainRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return FALLBACK_VIEWPORT;
    return { width: bounds.width, height: bounds.height };
  }, []);

  /* ----- layout autosave (write-through, corrupt-safe) ----- */
  const layoutRef = useRef(state.layout);
  layoutRef.current = state.layout;
  /** Last layout object actually written; skips redundant/unload writes. */
  const persistedLayoutRef = useRef<WorkspaceState["layout"] | null>(null);

  const persistLayout = useCallback(() => {
    if (persistedLayoutRef.current === layoutRef.current) return;
    try {
      window.localStorage.setItem(
        WORKSPACE_LAYOUT_STORAGE_KEY,
        serializeWorkspaceLayout(layoutRef.current),
      );
    } catch {
      // Quota/privacy failures never interrupt editing.
    }
    persistedLayoutRef.current = layoutRef.current;
  }, []);

  /*
   * Write through on every layout change (the JSON is ~1KB; a debounce here
   * loses the newest arrangement when a reload lands inside the window and
   * the reload-persistence contract forbids that). The pagehide/unmount
   * flush only covers a change whose effect has not run yet — the dirty
   * check keeps it from clobbering values written by other tabs/tools
   * between our last write and unload.
   */
  useEffect(persistLayout, [state.layout, persistLayout]);

  useEffect(() => {
    window.addEventListener("pagehide", persistLayout);
    return () => {
      window.removeEventListener("pagehide", persistLayout);
      persistLayout();
    };
  }, [persistLayout]);

  /* ----- keep recovered/offscreen floats reachable ----- */
  useEffect(() => {
    dispatch({ type: "clamp-floats", viewport: getViewport() });
    function onResize() {
      dispatch({ type: "clamp-floats", viewport: getViewport() });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [getViewport]);

  /* ----- controller ----- */
  const controller = useMemo<WorkspaceController>(
    () => ({
      state,
      dispatch,
      getViewport,
      activateTool: (toolId: ToolId) =>
        dispatch({ type: "activate-tool", toolId, viewport: getViewport() }),
      focusPanel: (toolId: ToolId) => dispatch({ type: "focus-panel", toolId }),
      closePanel: (toolId: ToolId) => dispatch({ type: "close-panel", toolId }),
      floatPanel: (toolId: ToolId) =>
        dispatch({ type: "float-panel", toolId, viewport: getViewport() }),
      floatPanelAt: (toolId: ToolId, rect: PanelRect) =>
        dispatch({ type: "float-panel", toolId, viewport: getViewport(), rect }),
      dockPanel: (toolId: ToolId) => dispatch({ type: "dock-panel", toolId }),
      setDockDropTarget: (active: boolean) =>
        dispatch({ type: "set-dock-drop-target", active }),
      resetPanelPosition: (toolId: ToolId) =>
        dispatch({
          type: "reset-panel-position",
          toolId,
          viewport: getViewport(),
        }),
      beginGesture: (toolId, kind) =>
        dispatch({ type: "begin-gesture", toolId, kind }),
      updateGesture: (rect) =>
        dispatch({ type: "update-gesture", rect, viewport: getViewport() }),
      commitGesture: () => dispatch({ type: "commit-gesture" }),
      cancelGesture: () => dispatch({ type: "cancel-gesture" }),
      setExpandedDrawer: (drawer) =>
        dispatch({ type: "set-expanded-drawer", drawer }),
    }),
    [state, getViewport],
  );

  /* ----- shortcuts (centralized; suppressed while typing/modals) ----- */
  const bindings = useMemo<ShortcutBinding[]>(() => {
    const soloBindings: ShortcutBinding[] = PLATES.map((plate, index) => ({
      id: `plate.${plate}`,
      key: String(index + 1),
      description: `Solo the ${plate} plate in the proof`,
      run: () => api.soloPlate(plate),
    }));
    return [
      // Tool shortcuts can unmount the focused control (dock swap):
      // recover focus deterministically afterwards.
      ...createToolShortcuts((toolId) => {
        controller.activateTool(toolId);
        recoverShortcutFocus();
      }),
      ...soloBindings,
      {
        id: "plate.composite",
        key: "`",
        description: "View the composite proof",
        run: () => api.soloPlate("composite"),
      },
      {
        id: "halftone.cell-larger",
        key: "]",
        description: "Increase halftone cell size",
        run: () =>
          api.updateSetting(
            "cellSize",
            Math.min(64, Math.max(3, api.settings.cellSize + 1)),
          ),
      },
      {
        id: "halftone.cell-smaller",
        key: "[",
        description: "Decrease halftone cell size",
        run: () =>
          api.updateSetting(
            "cellSize",
            Math.min(64, Math.max(3, api.settings.cellSize - 1)),
          ),
      },
      {
        id: "view.focus-mode",
        key: "f",
        description: "Toggle Focus Mode (hide rail, dock, and floats)",
        run: () => {
          dispatch({ type: "set-focus-mode", enabled: !state.focusMode });
          recoverShortcutFocus();
        },
      },
      {
        id: "help.open",
        key: "?",
        description: "Open Help",
        // openHelp (not a bare setState) so the invoker is captured and
        // Escape can return focus deterministically.
        run: () => openHelp(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, controller.activateTool, state.focusMode, recoverShortcutFocus]);

  /*
   * Modifier combos are the always-available alternative to single-key
   * shortcuts (they survive the WCAG 2.1.4 switch). Suppressed only while
   * a modal dialog is open; Undo/Redo also yield to native text editing.
   */
  const modifierBindings = useMemo<ModifierShortcutBinding[]>(
    () => [
      {
        id: "edit.undo",
        key: "z",
        shift: false,
        description: "Undo (Ctrl/Cmd+Z)",
        run: project.undo,
      },
      {
        id: "edit.redo",
        key: "z",
        shift: true,
        description: "Redo (Ctrl/Cmd+Shift+Z)",
        run: project.redo,
      },
      {
        id: "project.save",
        key: "s",
        allowWhileTyping: true,
        description: "Save (Ctrl/Cmd+S)",
        run: project.requestSave,
      },
    ],
    [project.undo, project.redo, project.requestSave],
  );

  useWorkspaceShortcuts(bindings, {
    singleKeyDisabled: singleKeyShortcutsDisabled,
    modifierBindings,
  });

  // Real capability context, not a hardcoded stub: project presence comes
  // from the open project's identity, layer/selection counts from its state.
  const capability: ToolCapabilityContext = {
    hasProject: Boolean(project.projectId),
    layerCount: project.layers.length,
    selectionCount: Math.min(
      project.layers.length,
      Math.max(project.selectedLayerIds.length, project.primaryLayerId ? 1 : 0),
    ),
  };

  const { layout, focusMode } = state;
  const floats = openFloats(layout);
  const dockEntry =
    layout.dockPanelId !== null
      ? WORKSTATION_TOOL_REGISTRY[layout.dockPanelId]
      : null;

  function openHelp() {
    helpReturnFocusRef.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    setHelpOpen(true);
  }

  function closeHelp() {
    setHelpOpen(false);
    // Deferred so ModalDialog can lift `inert` from the app root first.
    window.requestAnimationFrame(() => {
      const invoker = helpReturnFocusRef.current;
      if (invoker && invoker.isConnected) {
        invoker.focus();
        return;
      }
      // Shortcut-opened Help has no focused invoker: land on the topbar
      // Help button, never <body>.
      document
        .querySelector<HTMLElement>('[data-testid="ws-topbar"] [aria-label="Help"]')
        ?.focus();
    });
  }

  return (
    <WorkspaceControllerContext.Provider value={controller}>
      <div
        className="ws-root"
        data-testid="workspace-root"
        data-focus-mode={focusMode ? "true" : "false"}
        data-layout-locked={layout.locked ? "true" : "false"}
      >
        <TopBar
          focusMode={focusMode}
          locked={layout.locked}
          singleKeyShortcutsDisabled={singleKeyShortcutsDisabled}
          onToggleFocusMode={() =>
            dispatch({ type: "set-focus-mode", enabled: !focusMode })
          }
          onToggleLock={() =>
            dispatch({ type: "set-locked", locked: !layout.locked })
          }
          onToggleSingleKeyShortcuts={toggleSingleKeyShortcuts}
          onResetLayout={() => dispatch({ type: "reset-layout" })}
          onOpenHelp={openHelp}
        />

        <div className="ws-main" ref={mainRef}>
          {!focusMode && (
            <ToolRail
              activeToolId={state.activeToolId}
              capability={capability}
              onActivate={controller.activateTool}
            />
          )}

          <section
            ref={canvasSectionRef}
            className="ws-canvas"
            aria-label="Artboard"
            /* Programmatic focus target for shortcut focus recovery while
             * the rail is hidden (Focus Mode). Not in the tab order. */
            tabIndex={-1}
          >
            {canvas}
          </section>

          {!focusMode && (
            <DockSplitter
              width={layout.dockWidth}
              locked={layout.locked}
              onResize={(width) => dispatch({ type: "set-dock-width", width })}
            />
          )}

          {!focusMode && (
            <aside
              className="ws-dock"
              style={{ width: layout.dockWidth }}
              aria-label="Tool dock"
              data-testid="ws-dock"
              data-drop-active={state.dockDropActive ? "true" : undefined}
            >
              <Drawers expanded={layout.expandedDrawer} />
              <div className="ws-dock-panel">
                {layout.dockPanelId && dockEntry ? (
                  <PanelFrame
                    toolId={layout.dockPanelId}
                    title={dockEntry.title}
                    mode="docked"
                    rect={null}
                    z={0}
                    focused={state.focusedPanelId === layout.dockPanelId}
                    locked={layout.locked}
                  >
                    <dockEntry.Component />
                  </PanelFrame>
                ) : (
                  <p className="ws-dock-empty" data-testid="dock-empty">
                    No panel docked. Choose a tool from the rail.
                  </p>
                )}
              </div>
            </aside>
          )}

          {!focusMode &&
            floats.map((placement) => {
              const entry = WORKSTATION_TOOL_REGISTRY[placement.toolId];
              return (
                <PanelFrame
                  key={placement.toolId}
                  toolId={placement.toolId}
                  title={entry.title}
                  mode="floating"
                  rect={placement.rect}
                  z={placement.z}
                  focused={state.focusedPanelId === placement.toolId}
                  locked={layout.locked}
                >
                  <entry.Component />
                </PanelFrame>
              );
            })}

          <div
            className="ws-size-gate"
            data-testid="ws-size-gate"
            ref={sizeGateRef}
            tabIndex={-1}
          >
            <p className="desktop-only-title">Open on a larger screen</p>
            <p className="desktop-only-body">
              {PRODUCT_NAME} drives press separations at full resolution and
              needs at least a 1280×800 viewport. Your project and workspace
              layout are preserved — nothing collapses or resets.
            </p>
            {/* Live announcement: text appears only while the gate is
                active, so assistive tech hears the editor being replaced. */}
            <p role="status" data-testid="ws-size-gate-status">
              {sizeGateActive
                ? "Editor hidden: the viewport is below 1280 by 800. Project and layout are preserved."
                : ""}
            </p>
          </div>
        </div>

        {helpOpen && <HelpDialog shortcuts={bindings} onClose={closeHelp} />}
      </div>
    </WorkspaceControllerContext.Provider>
  );
}

/** Re-exported for tests and the dev component lab. */
export function describeDockPanel(state: WorkspaceState): string | null {
  const { dockPanelId } = state.layout;
  if (!dockPanelId) return null;
  return getPlacement(state.layout, dockPanelId).open
    ? WORKSTATION_TOOL_REGISTRY[dockPanelId].title
    : null;
}
