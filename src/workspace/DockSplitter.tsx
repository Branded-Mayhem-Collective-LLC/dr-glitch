/**
 * Keyboard-accessible splitter between the canvas and the right dock.
 * Pointer drag or ArrowLeft/ArrowRight (16px), Home/End to min/max.
 * Locked layouts ignore input but keep the separator announced.
 */

import { useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from "./layout-state";

type Props = {
  width: number;
  locked: boolean;
  onResize: (width: number) => void;
};

export function DockSplitter({ width, locked, onResize }: Props) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (locked || event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    // The dock sits right of the splitter: dragging left grows the dock.
    onResize(state.startWidth + (state.startX - event.clientX));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  /** pointercancel restores the pre-drag width (cancel, not commit). */
  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResize(state.startWidth);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (locked) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResize(width + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResize(width - 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize(DOCK_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize(DOCK_MAX_WIDTH);
    }
  }

  return (
    <div
      className="ws-splitter"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize tool dock"
      aria-valuemin={DOCK_MIN_WIDTH}
      aria-valuemax={DOCK_MAX_WIDTH}
      aria-valuenow={width}
      aria-disabled={locked || undefined}
      data-testid="ws-dock-splitter"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    />
  );
}
