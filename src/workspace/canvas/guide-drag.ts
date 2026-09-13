/**
 * Guide interaction state machine — pure, React-free.
 *
 * Two gestures share it:
 * - CREATE: drag out of a ruler. The guide is a visual preview only until
 *   commit, which emits ONE guides/add command (a single undo transaction).
 *   Escape (cancel) or releasing outside the artboard emits nothing.
 * - MOVE: drag an existing guide (hitTestGuides; locked/hidden guides never
 *   hit). Updates emit guides/move commands the caller applies LIVE inside
 *   the open pointer gesture, so the whole drag coalesces into one
 *   transaction and Escape rolls it back via DocumentApi.cancelGesture.
 *   Offsets clamp to the artboard — removal is explicit (keyboard/context),
 *   never a side effect of a move.
 *
 * Snapping: guide offsets snap to grid/artboard candidates through
 * computePointSnap when snapping is enabled, then round to integer document
 * pixels.
 */

import type { GuidesV1, SnappingV1, Vec2 } from "../../core/types";
import type { Command, GuideAxis } from "../../project";
import { computePointSnap, hitTestGuides } from "../../editor";

export const GUIDE_HIT_TOLERANCE_PX = 5;

export type GuideDragState =
  | { phase: "idle" }
  | { phase: "create"; axis: GuideAxis; offset: number; valid: boolean }
  | { phase: "move"; axis: GuideAxis; index: number; startOffset: number; offset: number };

export type GuideDragContext = {
  artboard: { width: number; height: number };
  snapping: SnappingV1;
  gridSize: number | null;
  /** Screen px per document px. */
  zoom: number;
  snapTolerancePx?: number;
};

export const GUIDE_IDLE: GuideDragState = { phase: "idle" };

export function beginGuideCreate(axis: GuideAxis): GuideDragState {
  return { phase: "create", axis, offset: 0, valid: false };
}

/** Begin moving the guide under the pointer; idle when nothing hits. */
export function beginGuideMove(
  pointDoc: Vec2,
  guides: GuidesV1,
  zoom: number,
  tolerancePx: number = GUIDE_HIT_TOLERANCE_PX,
): GuideDragState {
  const hit = hitTestGuides(pointDoc, guides, tolerancePx, zoom);
  if (!hit) return GUIDE_IDLE;
  const offset =
    hit.axis === "vertical" ? guides.vertical[hit.index] : guides.horizontal[hit.index];
  return { phase: "move", axis: hit.axis, index: hit.index, startOffset: offset, offset };
}

function snappedOffset(axis: GuideAxis, pointDoc: Vec2, context: GuideDragContext): number {
  const snap = computePointSnap(
    pointDoc,
    {
      gridSize: context.gridSize,
      artboard: context.artboard,
    },
    // Guides never snap to themselves or layers while being placed.
    { ...context.snapping, toGuides: false, toLayers: false },
    context.snapTolerancePx ?? 6,
    context.zoom,
  );
  const raw = axis === "vertical" ? pointDoc.x + snap.delta.x : pointDoc.y + snap.delta.y;
  return Math.round(raw);
}

export type GuideDragUpdate = {
  state: GuideDragState;
  /** Live command to apply inside the open gesture (move only). */
  command: Command | null;
};

export function updateGuideDrag(
  state: GuideDragState,
  pointDoc: Vec2,
  context: GuideDragContext,
): GuideDragUpdate {
  if (state.phase === "idle") return { state, command: null };
  const extent =
    state.axis === "vertical" ? context.artboard.width : context.artboard.height;
  const offset = snappedOffset(state.axis, pointDoc, context);

  if (state.phase === "create") {
    const valid = offset >= 0 && offset <= extent;
    return { state: { ...state, offset, valid }, command: null };
  }

  const clamped = Math.min(extent, Math.max(0, offset));
  if (clamped === state.offset) return { state, command: null };
  return {
    state: { ...state, offset: clamped },
    command: { type: "guides/move", axis: state.axis, index: state.index, offset: clamped },
  };
}

/**
 * Command for pointer release. Create emits the single guides/add; move
 * emits nothing (its updates were applied live inside the gesture).
 */
export function commitGuideDrag(state: GuideDragState): Command | null {
  if (state.phase === "create" && state.valid) {
    return { type: "guides/add", axis: state.axis, offset: state.offset };
  }
  return null;
}

/** Escape/cancel always returns to idle and emits nothing. */
export function cancelGuideDrag(): GuideDragState {
  return GUIDE_IDLE;
}

/** Explicit guide removal (keyboard Delete / context action). */
export function guideRemoveCommand(axis: GuideAxis, index: number): Command {
  return { type: "guides/remove", axis, index };
}
