/**
 * Transform interaction state machine — pure, React-free.
 *
 * A drag is bracketed by the studio's pointer gesture (DocumentApi), so
 * every update the caller applies lands in ONE undo transaction and Escape
 * cancels the whole drag via cancelGesture. This module only computes: it
 * never touches the store.
 *
 * Gestures:
 * - MOVE: translate the selected unlocked layers; smart-guide snapping via
 *   computeSnap over guides/grid/layers/artboard candidates (~6 screen px).
 * - SCALE (8 handles): scale about the opposite bounds anchor. Corner
 *   handles scale both axes (Shift constrains aspect via projection onto
 *   the diagonal); edge handles scale one axis (Shift makes it uniform).
 *   Factors clamp to ≥ MIN_SCALE_FACTOR — handles never flip a layer.
 * - ROTATE: about the selection bounds center; Shift snaps to 15°.
 * - PERSPECTIVE: corner-edit on one layer. Each update validates the
 *   candidate quad (validateQuad); an invalid quad KEEPS the last valid one
 *   and emits no command, so the prior valid transform is never destroyed.
 *
 * Group transforms go through applyGroupTransform, so multi-selection,
 * perspective-carrying layers, and locked-layer exclusion follow the
 * editor-module contract exactly.
 */

import type { Id, TransformV1, Vec2 } from "../../core/types";
import type { Command } from "../../project";
import {
  applyGroupTransform,
  computePointSnap,
  computeSnap,
  transformedBounds,
  transformedCorners,
  unionBounds,
  validateQuad,
  type Bounds,
  type GroupTransformDelta,
  type SnapCandidates,
} from "../../editor";
import type { SnappingV1 } from "../../core/types";

export const SNAP_TOLERANCE_PX = 6;
export const MIN_SCALE_FACTOR = 0.01;
export const ROTATE_SNAP_DEG = 15;

export type TransformDragLayer = {
  id: Id;
  locked: boolean;
  transform: TransformV1;
  /** Cropped-source size (croppedSize of the layer's asset). */
  size: { width: number; height: number };
};

export type ScaleHandle =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type TransformHandle = "move" | `scale-${ScaleHandle}` | "rotate";

export type SnapContext = {
  snapping: SnappingV1;
  candidates: SnapCandidates;
  /** Screen px per document px. */
  zoom: number;
  tolerancePx?: number;
};

export type TransformDragState = {
  handle: TransformHandle;
  start: Vec2;
  layers: TransformDragLayer[];
  /** Union doc-space bounds of the (unlocked) selection at drag start. */
  bounds: Bounds;
  pivot: Vec2;
  /** Fixed reference point the handle started from (scale handles). */
  handlePoint: Vec2;
};

export type TransformDragUpdate = {
  /** layers/set-transforms entries; empty means "no change this update". */
  entries: { layerId: Id; transform: TransformV1 }[];
  linesX: number[];
  linesY: number[];
};

function handleAnchor(handle: ScaleHandle, bounds: Bounds): { pivot: Vec2; point: Vec2 } {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  switch (handle) {
    case "nw": return { pivot: { x: right, y: bottom }, point: { x: left, y: top } };
    case "n": return { pivot: { x: midX, y: bottom }, point: { x: midX, y: top } };
    case "ne": return { pivot: { x: left, y: bottom }, point: { x: right, y: top } };
    case "e": return { pivot: { x: left, y: midY }, point: { x: right, y: midY } };
    case "se": return { pivot: { x: left, y: top }, point: { x: right, y: bottom } };
    case "s": return { pivot: { x: midX, y: top }, point: { x: midX, y: bottom } };
    case "sw": return { pivot: { x: right, y: top }, point: { x: left, y: bottom } };
    case "w": return { pivot: { x: right, y: midY }, point: { x: left, y: midY } };
  }
}

/** Selection bounds over unlocked layers; null when nothing is draggable. */
export function dragSelectionBounds(layers: readonly TransformDragLayer[]): Bounds | null {
  return unionBounds(
    layers
      .filter((layer) => !layer.locked)
      .map((layer) => transformedBounds(layer.transform, layer.size)),
  );
}

export function beginTransformDrag(
  handle: TransformHandle,
  layers: readonly TransformDragLayer[],
  pointDoc: Vec2,
): TransformDragState | null {
  const unlocked = layers.filter((layer) => !layer.locked);
  const bounds = dragSelectionBounds(unlocked);
  if (!bounds || unlocked.length === 0) return null;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  let pivot = center;
  let handlePoint = pointDoc;
  if (handle.startsWith("scale-")) {
    const anchor = handleAnchor(handle.slice(6) as ScaleHandle, bounds);
    pivot = anchor.pivot;
    handlePoint = anchor.point;
  }
  return { handle, start: pointDoc, layers: unlocked, bounds, pivot, handlePoint };
}

function entriesFor(
  state: TransformDragState,
  delta: GroupTransformDelta,
): { layerId: Id; transform: TransformV1 }[] {
  return applyGroupTransform(state.layers, delta, state.pivot).map((result) => ({
    layerId: result.id,
    transform: result.transform,
  }));
}

function clampFactor(value: number): number {
  return Math.max(MIN_SCALE_FACTOR, value);
}

export function updateTransformDrag(
  state: TransformDragState,
  pointDoc: Vec2,
  modifiers: { shift?: boolean },
  snapContext: SnapContext,
): TransformDragUpdate {
  const tolerance = snapContext.tolerancePx ?? SNAP_TOLERANCE_PX;

  if (state.handle === "move") {
    const raw = { x: pointDoc.x - state.start.x, y: pointDoc.y - state.start.y };
    const proposed: Bounds = {
      x: state.bounds.x + raw.x,
      y: state.bounds.y + raw.y,
      width: state.bounds.width,
      height: state.bounds.height,
    };
    const snap = computeSnap(
      proposed,
      snapContext.candidates,
      snapContext.snapping,
      tolerance,
      snapContext.zoom,
    );
    const translate = { x: raw.x + snap.delta.x, y: raw.y + snap.delta.y };
    return {
      entries: entriesFor(state, { translate }),
      linesX: snap.linesX,
      linesY: snap.linesY,
    };
  }

  if (state.handle === "rotate") {
    const center = state.pivot;
    const startAngle = Math.atan2(state.start.y - center.y, state.start.x - center.x);
    const pointAngle = Math.atan2(pointDoc.y - center.y, pointDoc.x - center.x);
    let rotateDeg = ((pointAngle - startAngle) * 180) / Math.PI;
    if (modifiers.shift) rotateDeg = Math.round(rotateDeg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
    return { entries: entriesFor(state, { rotateDeg }), linesX: [], linesY: [] };
  }

  // Scale: snap the dragged handle point first, then derive axis factors.
  const handle = state.handle.slice(6) as ScaleHandle;
  const snap = computePointSnap(
    pointDoc,
    snapContext.candidates,
    snapContext.snapping,
    tolerance,
    snapContext.zoom,
  );
  const point = { x: pointDoc.x + snap.delta.x, y: pointDoc.y + snap.delta.y };
  const { pivot, handlePoint } = state;
  const baseX = handlePoint.x - pivot.x;
  const baseY = handlePoint.y - pivot.y;
  const scalesX = handle === "n" || handle === "s" ? false : baseX !== 0;
  const scalesY = handle === "e" || handle === "w" ? false : baseY !== 0;

  let sx = scalesX ? clampFactor((point.x - pivot.x) / baseX) : 1;
  let sy = scalesY ? clampFactor((point.y - pivot.y) / baseY) : 1;
  if (modifiers.shift) {
    if (scalesX && scalesY) {
      // Constrain aspect: project the pointer onto the pivot→handle diagonal.
      const lengthSq = baseX * baseX + baseY * baseY;
      const projected =
        ((point.x - pivot.x) * baseX + (point.y - pivot.y) * baseY) / lengthSq;
      sx = sy = clampFactor(projected);
    } else {
      sx = sy = scalesX ? sx : sy;
    }
  }
  return {
    entries: entriesFor(state, { scale: { x: sx, y: sy } }),
    linesX: snap.linesX,
    linesY: snap.linesY,
  };
}

/** The command for one live update (empty updates apply nothing). */
export function transformDragCommand(update: TransformDragUpdate): Command | null {
  if (update.entries.length === 0) return null;
  return {
    type: "layers/set-transforms",
    entries: update.entries.map(({ layerId, transform }) => ({ layerId, transform })),
  };
}

/* ------------------------------------------------------------------ */
/* Layer hit-testing                                                   */
/* ------------------------------------------------------------------ */

export type HitTestLayer = {
  id: Id;
  visible: boolean;
  locked: boolean;
  transform: TransformV1;
  size: { width: number; height: number };
};

function pointInConvexQuad(point: Vec2, corners: readonly Vec2[]): boolean {
  let sign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index];
    const b = corners[(index + 1) % corners.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross === 0) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/** Topmost visible layer under the point (bottom-to-top stack order). */
export function hitTestLayers(
  pointDoc: Vec2,
  layers: readonly HitTestLayer[],
): HitTestLayer | null {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layer.visible) continue;
    if (pointInConvexQuad(pointDoc, transformedCorners(layer.transform, layer.size))) {
      return layer;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Perspective corner editing                                          */
/* ------------------------------------------------------------------ */

export type PerspectiveDragState = {
  layerId: Id;
  cornerIndex: 0 | 1 | 2 | 3;
  /** Quad at drag start: the stored quad or the affine corner geometry. */
  startQuad: [Vec2, Vec2, Vec2, Vec2];
  /** Last quad that passed validateQuad; never replaced by an invalid one. */
  lastValid: [Vec2, Vec2, Vec2, Vec2];
};

export function beginPerspectiveDrag(
  layer: TransformDragLayer,
  cornerIndex: 0 | 1 | 2 | 3,
): PerspectiveDragState | null {
  if (layer.locked) return null;
  const quad = layer.transform.perspective ?? transformedCorners(layer.transform, layer.size);
  const startQuad: [Vec2, Vec2, Vec2, Vec2] = [
    { ...quad[0] },
    { ...quad[1] },
    { ...quad[2] },
    { ...quad[3] },
  ];
  return { layerId: layer.id, cornerIndex, startQuad, lastValid: startQuad };
}

export type PerspectiveDragUpdate = {
  state: PerspectiveDragState;
  /** Live patch command; null while the candidate quad is invalid. */
  command: Command | null;
  valid: boolean;
};

export function updatePerspectiveDrag(
  state: PerspectiveDragState,
  pointDoc: Vec2,
  snapContext: SnapContext,
): PerspectiveDragUpdate {
  const snap = computePointSnap(
    pointDoc,
    snapContext.candidates,
    snapContext.snapping,
    snapContext.tolerancePx ?? SNAP_TOLERANCE_PX,
    snapContext.zoom,
  );
  const corner = { x: pointDoc.x + snap.delta.x, y: pointDoc.y + snap.delta.y };
  const candidate = state.startQuad.map((point, index) =>
    index === state.cornerIndex ? corner : point,
  ) as [Vec2, Vec2, Vec2, Vec2];
  const validation = validateQuad(candidate);
  if (!validation.valid) {
    return { state, command: null, valid: false };
  }
  const next: PerspectiveDragState = { ...state, lastValid: candidate };
  return {
    state: next,
    command: {
      type: "layer/set-transform",
      layerId: state.layerId,
      patch: { perspective: candidate },
    },
    valid: true,
  };
}
