/**
 * Workstation layout state manager — pure, React-free.
 *
 * Everything that decides where a panel lives (dock, float, hidden), what the
 * z-order is, what the splitter width is, which drawer is expanded, and how
 * Lock Layout / Reset Layout / Focus Mode behave lives here as a plain
 * reducer over immutable state. React components stay thin: they dispatch
 * actions and render the result. This keeps the whole contract unit-testable
 * in Node without a DOM.
 *
 * Persistence: only `WorkspaceLayoutStateV1` (the `layout` field) is ever
 * written to localStorage. Session fields (active tool, focus, focus mode,
 * in-progress gestures) never persist.
 */

import { TOOL_DEFINITIONS, getToolDefinition } from "../core/tool-registry";
import type {
  PanelPlacementV1,
  PanelRect,
  ToolId,
  WorkspaceLayoutStateV1,
} from "../core/types";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 520;
export const DOCK_DEFAULT_WIDTH = 360;

export const FLOAT_MIN_WIDTH = 320;
export const FLOAT_MIN_HEIGHT = 240;
export const FLOAT_DEFAULT_WIDTH = 360;
export const FLOAT_DEFAULT_HEIGHT = 460;

/**
 * Horizontal pixels of a float that must remain inside the workspace so its
 * TITLEBAR stays grabbable: the 120px contract minimum plus 8px for the
 * float chrome (resize-handle gutter + border) that renders before the
 * titlebar inside the float rect.
 */
export const FLOAT_REACH_X = 128;
/**
 * Vertical clamp allowance: the 36px titlebar plus the floating panel's
 * 1px border on each side, so a bottom-clamped float's titlebar (which
 * renders 1px below the float's y) still ends inside the workspace.
 */
export const FLOAT_TITLEBAR_HEIGHT = 38;

export const WORKSPACE_LAYOUT_STORAGE_KEY = "drglitch.workspace-layout.v1";

export type DrawerId = NonNullable<WorkspaceLayoutStateV1["expandedDrawer"]>;

export const DRAWER_IDS: DrawerId[] = ["document", "proof", "output"];

export type Viewport = { width: number; height: number };

export type GestureKind = "move" | "resize";

export type GestureState = {
  toolId: ToolId;
  kind: GestureKind;
  /** Rect at gesture start; Escape restores it exactly. */
  startRect: PanelRect;
};

export type WorkspaceState = {
  layout: WorkspaceLayoutStateV1;
  activeToolId: ToolId;
  focusedPanelId: ToolId | null;
  focusMode: boolean;
  /** Layout snapshot captured on Focus Mode entry; restored exactly on exit. */
  focusRestore: WorkspaceLayoutStateV1 | null;
  gesture: GestureState | null;
  /**
   * True while a float move-gesture hovers the right dock: the dock renders
   * its drop-target highlight and releasing the pointer docks the panel.
   * Session-only, never persisted.
   */
  dockDropActive: boolean;
};

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const TOOL_IDS = TOOL_DEFINITIONS.map((tool) => tool.id);

function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && (TOOL_IDS as string[]).includes(value);
}

export function createDefaultLayout(): WorkspaceLayoutStateV1 {
  return {
    schema: 1,
    dockWidth: DOCK_DEFAULT_WIDTH,
    dockPanelId: "layers",
    placements: TOOL_DEFINITIONS.map((tool) => ({
      toolId: tool.id,
      mode: "docked",
      rect: null,
      z: 0,
      open: tool.id === "layers",
    })),
    expandedDrawer: "document",
    locked: false,
  };
}

export function createDefaultWorkspaceState(
  layout: WorkspaceLayoutStateV1 = createDefaultLayout(),
): WorkspaceState {
  return {
    layout,
    activeToolId: "select",
    focusedPanelId: null,
    focusMode: false,
    focusRestore: null,
    gesture: null,
    dockDropActive: false,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function getPlacement(
  layout: WorkspaceLayoutStateV1,
  toolId: ToolId,
): PanelPlacementV1 {
  const placement = layout.placements.find((item) => item.toolId === toolId);
  if (!placement) throw new Error(`Missing placement for tool: ${toolId}`);
  return placement;
}

function patchPlacement(
  layout: WorkspaceLayoutStateV1,
  toolId: ToolId,
  patch: Partial<PanelPlacementV1>,
): WorkspaceLayoutStateV1 {
  return {
    ...layout,
    placements: layout.placements.map((item) =>
      item.toolId === toolId ? { ...item, ...patch } : item,
    ),
  };
}

function topZ(layout: WorkspaceLayoutStateV1): number {
  return layout.placements.reduce((max, item) => Math.max(max, item.z), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DOCK_DEFAULT_WIDTH;
  return clamp(Math.round(width), DOCK_MIN_WIDTH, DOCK_MAX_WIDTH);
}

/**
 * Clamp a float rect so its titlebar always stays reachable inside the
 * workspace: at least FLOAT_REACH_X horizontal pixels visible, and the top
 * edge inside the vertical range. Also enforces the 320x240 minimum size.
 */
export function clampFloatRect(rect: PanelRect, viewport: Viewport): PanelRect {
  const width = clamp(
    Math.round(rect.width),
    FLOAT_MIN_WIDTH,
    Math.max(FLOAT_MIN_WIDTH, Math.round(viewport.width)),
  );
  const height = clamp(
    Math.round(rect.height),
    FLOAT_MIN_HEIGHT,
    Math.max(FLOAT_MIN_HEIGHT, Math.round(viewport.height)),
  );
  const x = clamp(
    Math.round(rect.x),
    FLOAT_REACH_X - width,
    Math.max(FLOAT_REACH_X - width, Math.round(viewport.width) - FLOAT_REACH_X),
  );
  const y = clamp(
    Math.round(rect.y),
    0,
    Math.max(0, Math.round(viewport.height) - FLOAT_TITLEBAR_HEIGHT),
  );
  return { x, y, width, height };
}

/**
 * Cascaded default float rect. The horizontal step is deliberately wider
 * than half a default float (360/2 = 180) plus drag slack so that when two
 * cascaded floats overlap, EACH titlebar's center stays pointer-reachable
 * while the other float is raised — the workspace-shell "floats raise on
 * focus" contract exercises exactly that with real pointer clicks.
 */
export function defaultFloatRect(toolId: ToolId, viewport: Viewport): PanelRect {
  const index = Math.max(
    0,
    TOOL_DEFINITIONS.findIndex((tool) => tool.id === toolId),
  );
  return clampFloatRect(
    {
      x: 96 + index * 240,
      y: 64 + index * 28,
      width: FLOAT_DEFAULT_WIDTH,
      height: FLOAT_DEFAULT_HEIGHT,
    },
    viewport,
  );
}

/** Open floating placements, back-to-front (ascending z) for rendering. */
export function openFloats(layout: WorkspaceLayoutStateV1): PanelPlacementV1[] {
  return layout.placements
    .filter((item) => item.mode === "floating" && item.open)
    .sort((a, b) => a.z - b.z);
}

function cloneLayout(layout: WorkspaceLayoutStateV1): WorkspaceLayoutStateV1 {
  return {
    ...layout,
    placements: layout.placements.map((item) => ({
      ...item,
      rect: item.rect ? { ...item.rect } : null,
    })),
  };
}

/** Hide the currently docked panel (if any, and different from keepToolId). */
function hideDisplacedDockPanel(
  layout: WorkspaceLayoutStateV1,
  keepToolId: ToolId,
): WorkspaceLayoutStateV1 {
  if (layout.dockPanelId === null || layout.dockPanelId === keepToolId) {
    return layout;
  }
  return patchPlacement(layout, layout.dockPanelId, { open: false });
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export type WorkspaceAction =
  | { type: "activate-tool"; toolId: ToolId; viewport: Viewport }
  | { type: "focus-panel"; toolId: ToolId }
  | { type: "close-panel"; toolId: ToolId }
  | { type: "float-panel"; toolId: ToolId; viewport: Viewport; rect?: PanelRect }
  | { type: "dock-panel"; toolId: ToolId }
  | { type: "set-dock-drop-target"; active: boolean }
  | { type: "raise-panel"; toolId: ToolId }
  | { type: "reset-panel-position"; toolId: ToolId; viewport: Viewport }
  | { type: "set-dock-width"; width: number }
  | { type: "set-expanded-drawer"; drawer: DrawerId | null }
  | { type: "set-locked"; locked: boolean }
  | { type: "reset-layout" }
  | { type: "set-focus-mode"; enabled: boolean }
  | { type: "begin-gesture"; toolId: ToolId; kind: GestureKind }
  | { type: "update-gesture"; rect: PanelRect; viewport: Viewport }
  | { type: "commit-gesture" }
  | { type: "cancel-gesture" }
  /**
   * Restore a panel's remembered float rect without changing its mode —
   * used when a dock drag-out is cancelled (Escape/pointercancel): the
   * spawn-at-pointer rect must not clobber the geometry the float had
   * before the aborted drag.
   */
  | { type: "restore-float-rect"; toolId: ToolId; rect: PanelRect | null }
  | { type: "clamp-floats"; viewport: Viewport };

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "activate-tool": {
      const { toolId, viewport } = action;
      const placement = getPlacement(state.layout, toolId);
      let layout = state.layout;
      if (placement.mode === "floating") {
        // Activate + raise the existing float; the dock keeps whatever panel
        // it is currently showing.
        layout = patchPlacement(layout, toolId, {
          open: true,
          rect: clampFloatRect(
            placement.rect ?? defaultFloatRect(toolId, viewport),
            viewport,
          ),
          z: topZ(layout) + 1,
        });
      } else {
        // Nonfloating tool: its sole panel occupies the dock, displacing
        // (hiding) whichever panel held the dock before.
        layout = hideDisplacedDockPanel(layout, toolId);
        layout = patchPlacement(layout, toolId, { open: true });
        layout = { ...layout, dockPanelId: toolId };
      }
      return {
        ...state,
        layout,
        activeToolId: toolId,
        focusedPanelId: toolId,
      };
    }

    case "focus-panel": {
      // Interacting with a panel activates its tool without re-placing it.
      const { toolId } = action;
      const placement = getPlacement(state.layout, toolId);
      let layout = state.layout;
      if (placement.mode === "floating" && placement.open) {
        const highest = topZ(layout);
        if (placement.z < highest) {
          layout = patchPlacement(layout, toolId, { z: highest + 1 });
        }
      }
      if (
        layout === state.layout &&
        state.activeToolId === toolId &&
        state.focusedPanelId === toolId
      ) {
        return state;
      }
      return {
        ...state,
        layout,
        activeToolId: toolId,
        focusedPanelId: toolId,
      };
    }

    case "close-panel": {
      // Close remembers prior placement (mode + rect stay on the record) so
      // rail activation restores it exactly. Allowed while locked.
      const { toolId } = action;
      let layout = patchPlacement(state.layout, toolId, { open: false });
      if (layout.dockPanelId === toolId) {
        layout = { ...layout, dockPanelId: null };
      }
      return {
        ...state,
        layout,
        focusedPanelId:
          state.focusedPanelId === toolId ? null : state.focusedPanelId,
      };
    }

    case "float-panel": {
      if (state.layout.locked) return state;
      const { toolId, viewport } = action;
      const placement = getPlacement(state.layout, toolId);
      let layout = patchPlacement(state.layout, toolId, {
        mode: "floating",
        open: true,
        rect: clampFloatRect(
          // An explicit rect (drag-to-undock spawns the float at the
          // pointer) wins over the remembered/default placement.
          action.rect ?? placement.rect ?? defaultFloatRect(toolId, viewport),
          viewport,
        ),
        z: topZ(state.layout) + 1,
      });
      if (layout.dockPanelId === toolId) {
        layout = { ...layout, dockPanelId: null };
      }
      return {
        ...state,
        layout,
        activeToolId: toolId,
        focusedPanelId: toolId,
      };
    }

    case "dock-panel": {
      if (state.layout.locked) return state;
      const { toolId } = action;
      let layout = hideDisplacedDockPanel(state.layout, toolId);
      layout = patchPlacement(layout, toolId, { mode: "docked", open: true });
      layout = { ...layout, dockPanelId: toolId };
      return {
        ...state,
        layout,
        activeToolId: toolId,
        focusedPanelId: toolId,
      };
    }

    case "set-dock-drop-target": {
      if (state.dockDropActive === action.active) return state;
      return { ...state, dockDropActive: action.active };
    }

    case "raise-panel": {
      const placement = getPlacement(state.layout, action.toolId);
      if (placement.mode !== "floating" || !placement.open) return state;
      const highest = topZ(state.layout);
      if (placement.z >= highest && highest > 0) return state;
      return {
        ...state,
        layout: patchPlacement(state.layout, action.toolId, {
          z: highest + 1,
        }),
      };
    }

    case "reset-panel-position": {
      if (state.layout.locked) return state;
      return {
        ...state,
        layout: patchPlacement(state.layout, action.toolId, {
          rect: defaultFloatRect(action.toolId, action.viewport),
        }),
      };
    }

    case "set-dock-width": {
      if (state.layout.locked) return state;
      return {
        ...state,
        layout: { ...state.layout, dockWidth: clampDockWidth(action.width) },
      };
    }

    case "set-expanded-drawer": {
      // Exclusivity is structural: one field holds at most one drawer id.
      return {
        ...state,
        layout: { ...state.layout, expandedDrawer: action.drawer },
      };
    }

    case "set-locked": {
      return {
        ...state,
        layout: { ...state.layout, locked: action.locked },
        gesture: action.locked ? null : state.gesture,
      };
    }

    case "reset-layout": {
      // Hides floats, resets dock and z-order, docks the active tool,
      // unlocks. Never touches document or canvas state (none lives here).
      const activeToolId = state.activeToolId;
      const layout: WorkspaceLayoutStateV1 = {
        schema: 1,
        dockWidth: DOCK_DEFAULT_WIDTH,
        dockPanelId: activeToolId,
        placements: TOOL_DEFINITIONS.map((tool) => ({
          toolId: tool.id,
          mode: "docked",
          rect: null,
          z: 0,
          open: tool.id === activeToolId,
        })),
        expandedDrawer: "document",
        locked: false,
      };
      return {
        ...state,
        layout,
        focusedPanelId: activeToolId,
        gesture: null,
      };
    }

    case "set-focus-mode": {
      if (action.enabled === state.focusMode) return state;
      if (action.enabled) {
        return {
          ...state,
          focusMode: true,
          focusRestore: cloneLayout(state.layout),
          gesture: null,
        };
      }
      return {
        ...state,
        focusMode: false,
        layout: state.focusRestore ?? state.layout,
        focusRestore: null,
      };
    }

    case "begin-gesture": {
      if (state.layout.locked) return state;
      const placement = getPlacement(state.layout, action.toolId);
      if (placement.mode !== "floating" || !placement.open || !placement.rect) {
        return state;
      }
      return {
        ...state,
        layout: patchPlacement(state.layout, action.toolId, {
          z: topZ(state.layout) + 1,
        }),
        activeToolId: action.toolId,
        focusedPanelId: action.toolId,
        gesture: {
          toolId: action.toolId,
          kind: action.kind,
          startRect: { ...placement.rect },
        },
      };
    }

    case "update-gesture": {
      if (!state.gesture) return state;
      return {
        ...state,
        layout: patchPlacement(state.layout, state.gesture.toolId, {
          rect: clampFloatRect(action.rect, action.viewport),
        }),
      };
    }

    case "commit-gesture": {
      if (!state.gesture) return state;
      return { ...state, gesture: null, dockDropActive: false };
    }

    case "cancel-gesture": {
      if (!state.gesture) return state;
      return {
        ...state,
        layout: patchPlacement(state.layout, state.gesture.toolId, {
          rect: { ...state.gesture.startRect },
        }),
        gesture: null,
        dockDropActive: false,
      };
    }

    case "restore-float-rect": {
      return {
        ...state,
        layout: patchPlacement(state.layout, action.toolId, {
          rect: action.rect ? { ...action.rect } : null,
        }),
      };
    }

    case "clamp-floats": {
      return {
        ...state,
        layout: {
          ...state.layout,
          placements: state.layout.placements.map((item) =>
            item.mode === "floating" && item.rect
              ? { ...item, rect: clampFloatRect(item.rect, action.viewport) }
              : item,
          ),
        },
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export function serializeWorkspaceLayout(
  layout: WorkspaceLayoutStateV1,
): string {
  return JSON.stringify(layout);
}

function parseRect(value: unknown): PanelRect | null {
  if (value === null || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  const fields = [rect.x, rect.y, rect.width, rect.height];
  if (!fields.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  return {
    x: Math.round(rect.x as number),
    y: Math.round(rect.y as number),
    width: Math.max(FLOAT_MIN_WIDTH, Math.round(rect.width as number)),
    height: Math.max(FLOAT_MIN_HEIGHT, Math.round(rect.height as number)),
  };
}

/**
 * Parse a stored layout string. Any corrupt, foreign, or future-schema value
 * yields null so the caller falls back to defaults; recoverable field-level
 * damage is normalized instead of discarding the whole layout.
 */
export function parseWorkspaceLayout(
  raw: string | null | undefined,
): WorkspaceLayoutStateV1 | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const stored = parsed as Record<string, unknown>;
  if (stored.schema !== 1) return null;

  const layout = createDefaultLayout();
  layout.dockWidth = clampDockWidth(
    typeof stored.dockWidth === "number" ? stored.dockWidth : NaN,
  );
  layout.locked = stored.locked === true;
  layout.expandedDrawer =
    stored.expandedDrawer === null ||
    (DRAWER_IDS as string[]).includes(stored.expandedDrawer as string)
      ? (stored.expandedDrawer as DrawerId | null)
      : "document";

  const storedPlacements = Array.isArray(stored.placements)
    ? (stored.placements as unknown[])
    : [];
  layout.placements = layout.placements.map((fallback) => {
    const match = storedPlacements.find(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).toolId === fallback.toolId,
    ) as Record<string, unknown> | undefined;
    if (!match) return fallback;
    const mode = match.mode === "floating" ? "floating" : "docked";
    const z =
      typeof match.z === "number" && Number.isFinite(match.z) && match.z >= 0
        ? Math.round(match.z)
        : 0;
    return {
      toolId: fallback.toolId,
      mode,
      rect: parseRect(match.rect ?? null),
      z,
      open: match.open === true,
    } satisfies PanelPlacementV1;
  });

  // dockPanelId must point at an existing docked, open placement.
  if (isToolId(stored.dockPanelId)) {
    const placement = getPlacement(layout, stored.dockPanelId);
    layout.dockPanelId =
      placement.mode === "docked" && placement.open ? stored.dockPanelId : null;
  } else {
    layout.dockPanelId = null;
  }

  return layout;
}

/** Human label used by shell chrome; re-exported so components need one import. */
export function toolLabel(toolId: ToolId): string {
  return getToolDefinition(toolId).label;
}
