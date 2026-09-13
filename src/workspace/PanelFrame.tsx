/**
 * PanelFrame — the chrome around every tool panel, docked or floating.
 *
 * Pointer model: titlebar drag moves a float, eight edge/corner handles
 * resize it (min 320x240), pointerdown raises it, Escape cancels an
 * in-progress gesture and restores the pre-gesture rect exactly.
 *
 * Keyboard model: the titlebar menu offers Float, Dock Right, Close, Reset
 * Position, Move, and Resize. Move/Resize enter an arrow-key mode (16px
 * steps, 1px with Shift) committed with Enter and cancelled with Escape.
 *
 * Lock Layout disables move/resize/dock/undock but keeps open/close/focus.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { Icon } from "../components/icons";
import type { PanelRect, ToolId } from "../core/types";
import {
  FLOAT_DEFAULT_HEIGHT,
  FLOAT_DEFAULT_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  getPlacement,
  type GestureKind,
} from "./layout-state";
import { useWorkspaceController } from "./workspace-controller";

/** Pointer sits this far below the spawned float's top edge (mid-titlebar). */
const UNDOCK_GRAB_OFFSET_Y = 18;
/** Pointer travel (px) before a docked titlebar drag undocks the panel. */
const UNDOCK_THRESHOLD = 6;

function dockBounds(): DOMRect | null {
  return (
    document
      .querySelector('[data-testid="ws-dock"]')
      ?.getBoundingClientRect() ?? null
  );
}

function pointerOverDock(point: { clientX: number; clientY: number }): boolean {
  const bounds = dockBounds();
  return Boolean(
    bounds &&
      point.clientX >= bounds.left &&
      point.clientX <= bounds.right &&
      point.clientY >= bounds.top &&
      point.clientY <= bounds.bottom,
  );
}

function workspaceOrigin(): { left: number; top: number } {
  const bounds = document.querySelector(".ws-main")?.getBoundingClientRect();
  return { left: bounds?.left ?? 0, top: bounds?.top ?? 0 };
}

const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type ResizeDir = (typeof RESIZE_DIRS)[number];

type Props = {
  toolId: ToolId;
  title: string;
  mode: "docked" | "floating";
  rect: PanelRect | null;
  z: number;
  focused: boolean;
  locked: boolean;
  children: ReactNode;
};

type PointerGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startRect: PanelRect;
  dir: "move" | ResizeDir;
  cancelled: boolean;
};

function applyResize(
  start: PanelRect,
  dir: ResizeDir,
  dx: number,
  dy: number,
): PanelRect {
  let { x, y, width, height } = start;
  if (dir.includes("e")) width = Math.max(FLOAT_MIN_WIDTH, start.width + dx);
  if (dir.includes("s")) height = Math.max(FLOAT_MIN_HEIGHT, start.height + dy);
  if (dir.includes("w")) {
    const shift = Math.min(dx, start.width - FLOAT_MIN_WIDTH);
    x = start.x + shift;
    width = start.width - shift;
  }
  if (dir.includes("n")) {
    const shift = Math.min(dy, start.height - FLOAT_MIN_HEIGHT);
    y = start.y + shift;
    height = start.height - shift;
  }
  return { x, y, width, height };
}

export function PanelFrame({
  toolId,
  title,
  mode,
  rect,
  z,
  focused,
  locked,
  children,
}: Props) {
  const controller = useWorkspaceController();
  const rootRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState<GestureKind | null>(null);
  const titleId = useId();
  const floating = mode === "floating";

  /* ----- pointer gestures ----- */

  function beginPointerGesture(
    event: ReactPointerEvent<HTMLElement>,
    dir: "move" | ResizeDir,
  ) {
    if (!floating || locked || !rect || event.button !== 0) return;
    // Buttons inside the titlebar keep their own click behavior.
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: { ...rect },
      dir,
      cancelled: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    controller.beginGesture(toolId, dir === "move" ? "move" : "resize");
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.cancelled) return;
    if (event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const next =
      gesture.dir === "move"
        ? { ...gesture.startRect, x: gesture.startRect.x + dx, y: gesture.startRect.y + dy }
        : applyResize(gesture.startRect, gesture.dir, dx, dy);
    controller.updateGesture(next);
    // Dragging a float by its titlebar over the right dock arms the dock
    // as a drop target (visible highlight; release docks the panel).
    if (gesture.dir === "move") {
      controller.setDockDropTarget(pointerOverDock(event));
    }
  }

  function endPointerGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const dropOnDock =
      !gesture.cancelled && gesture.dir === "move" && pointerOverDock(event);
    if (!gesture.cancelled) controller.commitGesture();
    if (dropOnDock) controller.dockPanel(toolId);
    gestureRef.current = null;
  }

  /**
   * pointercancel is a CANCEL, not a commit: the system revoked the pointer
   * (touch gesture takeover, device change), so the float snaps back to its
   * pre-gesture rect exactly like Escape — and never dock-drops.
   */
  function cancelPointerGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!gesture.cancelled) controller.cancelGesture();
    gestureRef.current = null;
  }

  /**
   * Drag-to-undock: pressing a DOCKED titlebar and moving past the
   * threshold pops the panel out as a float under the pointer and continues
   * as a normal move gesture. Listeners live on window because the docked
   * PanelFrame unmounts the moment the panel floats. Escape cancels the
   * whole drag and re-docks.
   */
  function beginDockedDragOut(event: ReactPointerEvent<HTMLElement>) {
    if (floating || locked || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const remembered = getPlacement(controller.state.layout, toolId).rect;
    const size = {
      width: remembered?.width ?? FLOAT_DEFAULT_WIDTH,
      height: remembered?.height ?? FLOAT_DEFAULT_HEIGHT,
    };
    const origin = workspaceOrigin();
    let undocked = false;
    let done = false;

    const rectAt = (point: { clientX: number; clientY: number }): PanelRect => ({
      x: Math.round(point.clientX - origin.left - size.width / 2),
      y: Math.round(point.clientY - origin.top - UNDOCK_GRAB_OFFSET_Y),
      width: size.width,
      height: size.height,
    });

    const cleanup = () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowCancel);
      window.removeEventListener("keydown", onWindowKeyDown, true);
      controller.setDockDropTarget(false);
    };

    const onWindowMove = (moveEvent: PointerEvent) => {
      if (done) return;
      if (!undocked) {
        const travelled = Math.hypot(
          moveEvent.clientX - startX,
          moveEvent.clientY - startY,
        );
        if (travelled < UNDOCK_THRESHOLD) return;
        undocked = true;
        controller.floatPanelAt(toolId, rectAt(moveEvent));
        controller.beginGesture(toolId, "move");
      }
      controller.updateGesture(rectAt(moveEvent));
      controller.setDockDropTarget(pointerOverDock(moveEvent));
    };

    const onWindowUp = (upEvent: PointerEvent) => {
      if (done) return;
      done = true;
      const dropOnDock = undocked && pointerOverDock(upEvent);
      cleanup();
      if (!undocked) return;
      controller.commitGesture();
      if (dropOnDock) controller.dockPanel(toolId);
    };

    /**
     * Cancelling an in-flight drag-out (Escape or pointercancel) re-docks
     * the panel AND restores the float geometry it remembered BEFORE this
     * drag — the transient spawn-at-pointer rect must never survive as the
     * panel's remembered placement.
     */
    const abortDragOut = () => {
      cleanup();
      if (!undocked) return;
      controller.cancelGesture();
      controller.dockPanel(toolId);
      controller.dispatch({
        type: "restore-float-rect",
        toolId,
        rect: remembered ? { ...remembered } : null,
      });
    };

    const onWindowCancel = () => {
      if (done) return;
      done = true;
      abortDragOut();
    };

    const onWindowKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || done) return;
      done = true;
      keyEvent.stopPropagation();
      abortDragOut();
    };

    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowCancel);
    window.addEventListener("keydown", onWindowKeyDown, true);
  }

  // Escape cancels an in-progress pointer gesture, restoring the start rect.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const gesture = gestureRef.current;
      if (!gesture || gesture.cancelled) return;
      gesture.cancelled = true;
      controller.cancelGesture();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /* ----- keyboard move/resize ----- */

  function startKeyboardMode(kind: GestureKind) {
    if (!floating || locked || !rect) return;
    controller.beginGesture(toolId, kind);
    setKeyboardMode(kind);
    rootRef.current?.focus();
  }

  function onRootKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!keyboardMode || !rect) return;
    const step = event.shiftKey ? 1 : 16;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      controller.commitGesture();
      setKeyboardMode(null);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      controller.cancelGesture();
      setKeyboardMode(null);
      return;
    } else {
      return;
    }
    event.preventDefault();
    const next =
      keyboardMode === "move"
        ? { ...rect, x: rect.x + dx, y: rect.y + dy }
        : {
            ...rect,
            width: Math.max(FLOAT_MIN_WIDTH, rect.width + dx),
            height: Math.max(FLOAT_MIN_HEIGHT, rect.height + dy),
          };
    controller.updateGesture(next);
  }

  /* ----- titlebar menu ----- */

  function relocatePanel(destination: "docked" | "floating") {
    // Dock/float remounts this frame in another parent. Focus the new DOM
    // after React commits, rather than the button that is about to unmount.
    flushSync(() => {
      setMenuOpen(false);
      if (destination === "docked") controller.dockPanel(toolId);
      else controller.floatPanel(toolId);
    });
    document.querySelector<HTMLButtonElement>(
      `[data-testid="ws-panel-${toolId}"] [aria-label="Panel menu"]`,
    )?.focus();
  }

  function closeMenu(refocus: boolean) {
    setMenuOpen(false);
    if (refocus) menuButtonRef.current?.focus();
  }

  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
  }, [menuOpen]);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const index = items.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  const menuItems: Array<{
    id: string;
    label: string;
    disabled: boolean;
    run: () => void;
  }> = [
    {
      id: "float",
      label: "Float",
      disabled: locked || floating,
      run: () => relocatePanel("floating"),
    },
    {
      id: "dock",
      label: "Dock Right",
      disabled: locked || !floating,
      run: () => relocatePanel("docked"),
    },
    {
      id: "close",
      label: "Close",
      disabled: false,
      run: () => closeAndReturnFocusToRail(),
    },
    {
      id: "reset-position",
      label: "Reset Position",
      disabled: locked || !floating,
      run: () => controller.resetPanelPosition(toolId),
    },
    {
      id: "move",
      label: "Move",
      disabled: locked || !floating,
      run: () => startKeyboardMode("move"),
    },
    {
      id: "resize",
      label: "Resize",
      disabled: locked || !floating,
      run: () => startKeyboardMode("resize"),
    },
  ];

  /* ----- activation on interaction ----- */

  function onFramePointerDownCapture() {
    controller.focusPanel(toolId);
  }

  /**
   * Closing a panel would otherwise drop keyboard focus on <body>; the
   * contract restores it to the panel's rail tool button instead.
   */
  function closeAndReturnFocusToRail() {
    controller.closePanel(toolId);
    document
      .querySelector<HTMLButtonElement>(`[data-testid="ws-rail-${toolId}"]`)
      ?.focus();
  }

  const frame = (
    <section
      ref={rootRef}
      className={`ws-panel ${floating ? "is-floating" : "is-docked"} ${
        focused ? "is-focused" : ""
      }`}
      aria-labelledby={titleId}
      data-testid={`ws-panel-${toolId}`}
      data-mode={mode}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      onPointerDownCapture={onFramePointerDownCapture}
      onFocusCapture={() => {
        controller.focusPanel(toolId);
      }}
    >
      <header
        className="ws-panel-titlebar"
        data-testid={`ws-panel-titlebar-${toolId}`}
        onPointerDown={(event) =>
          floating
            ? beginPointerGesture(event, "move")
            : beginDockedDragOut(event)
        }
        onPointerMove={onPointerMove}
        onPointerUp={endPointerGesture}
        onPointerCancel={cancelPointerGesture}
        /* Docked titlebars are grabbable too: drag past the threshold to
         * undock (Photoshop-grade docking). */
        data-grabbable={!locked ? "true" : undefined}
      >
        <span className="ws-panel-title" id={titleId}>
          {title}
        </span>
        <div className="ws-panel-titlebar-actions">
          <div className="ws-panel-menu-wrap">
            <button
              ref={menuButtonRef}
              type="button"
              className="ws-titlebar-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Panel menu"
              title={`${title} panel menu`}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="panel-menu" size={14} />
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                className="ws-panel-menu"
                role="menu"
                aria-label={`${title} panel commands`}
                onKeyDown={onMenuKeyDown}
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    closeMenu(false);
                  }
                }}
              >
                {menuItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    aria-disabled={item.disabled ? "true" : "false"}
                    onClick={() => {
                      if (item.disabled) return;
                      closeMenu(
                        item.id !== "move" &&
                          item.id !== "resize" &&
                          item.id !== "close",
                      );
                      item.run();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {floating ? (
            <button
              type="button"
              className="ws-titlebar-button"
              aria-label={`Dock ${title} panel right`}
              title={locked ? "Layout is locked" : "Dock Right"}
              disabled={locked}
              onClick={() => relocatePanel("docked")}
            >
              <Icon name="dock-right" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="ws-titlebar-button"
              aria-label={`Float ${title} panel`}
              title={locked ? "Layout is locked" : "Float"}
              disabled={locked}
              onClick={() => relocatePanel("floating")}
            >
              <Icon name="move" size={14} />
            </button>
          )}
          <button
            type="button"
            className="ws-titlebar-button"
            aria-label={`Close ${title} panel`}
            title="Close"
            onClick={closeAndReturnFocusToRail}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      {keyboardMode && (
        <p className="ws-panel-kb-hint" role="status">
          {keyboardMode === "move" ? "Moving" : "Resizing"} with arrow keys —
          Shift for 1px, Enter to commit, Escape to cancel.
        </p>
      )}

      <div className="ws-panel-body">{children}</div>
    </section>
  );

  if (!floating) return frame;

  return (
    <div
      className="ws-float"
      data-testid={`ws-float-${toolId}`}
      role="dialog"
      aria-label={title}
      style={
        rect
          ? {
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              zIndex: 10 + z,
            }
          : undefined
      }
    >
      {frame}
      {!locked &&
        RESIZE_DIRS.map((dir) => (
          <span
            key={dir}
            className={`ws-resize-handle ws-resize-${dir}`}
            data-resize={dir}
            data-testid={dir === "se" ? "ws-float-resize-handle" : undefined}
            aria-hidden="true"
            onPointerDown={(event) => beginPointerGesture(event, dir)}
            onPointerMove={onPointerMove}
            onPointerUp={endPointerGesture}
            onPointerCancel={cancelPointerGesture}
          />
        ))}
    </div>
  );
}
