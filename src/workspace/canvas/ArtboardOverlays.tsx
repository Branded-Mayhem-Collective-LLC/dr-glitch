/**
 * ArtboardOverlays — everything drawn OVER the proof canvas: guides (with
 * drag/keyboard/context removal), smart-guide snap lines, the selection
 * transform box (move/scale/rotate), crop mode, and perspective corner
 * editing. Overlay-only chrome: none of this ever enters a render payload
 * or an export (see PreviewService).
 *
 * Interaction model: every drag runs inside the studio's global pointer
 * gesture (DocumentApi), so live command updates coalesce into ONE undo
 * transaction and Escape cancels the whole drag — the machines in
 * guide-drag.ts / transform-drag.ts / crop-drag.ts compute, this component
 * only wires pointers and applies commands.
 *
 * Positioning: children are laid out in PERCENT of the artboard so the
 * overlay survives zoom/pan without re-measuring. Pointer input maps
 * through the measured canvas rect (canvas-metrics).
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { Id, LayerV1, Vec2 } from "../../core/types";
import {
  croppedSize,
  mat3ApplyToPoint,
  transformedBounds,
  transformedCorners,
  type Bounds,
  type SnapCandidates,
} from "../../editor";
import { useProjectUi } from "../project-ui";
import { useWorkspaceController } from "../workspace-controller";
import { docPointFromClient, measureCanvas } from "./canvas-metrics";
import {
  guideRemoveCommand,
  updateGuideDrag,
  type GuideDragState,
} from "./guide-drag";
import {
  beginCropDrag,
  updateCropDrag,
  sourceToDocMatrix,
  type CropDragState,
  type CropHandle,
} from "./crop-drag";
import {
  beginPerspectiveDrag,
  beginTransformDrag,
  dragSelectionBounds,
  hitTestLayers,
  transformDragCommand,
  updatePerspectiveDrag,
  updateTransformDrag,
  type PerspectiveDragState,
  type ScaleHandle,
  type TransformDragLayer,
  type TransformDragState,
  type TransformHandle,
} from "./transform-drag";

const SCALE_HANDLES: ScaleHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CROP_HANDLES: Exclude<CropHandle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** True while space-drag panning is armed — overlays stand down. */
  panArmed: boolean;
};

type ActiveDrag =
  | { kind: "transform"; state: TransformDragState; label: string }
  | { kind: "guide"; state: GuideDragState }
  | { kind: "crop"; state: CropDragState }
  | { kind: "perspective"; state: PerspectiveDragState };

export function ArtboardOverlays({ canvasRef, panArmed }: Props) {
  const project = useProjectUi();
  const controller = useWorkspaceController();
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const gridPatternId = useId();
  const [snapLines, setSnapLines] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [quadInvalid, setQuadInvalid] = useState(false);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const { core, layers } = project;
  const docW = core.artboard.widthPx;
  const docH = core.artboard.heightPx;
  const selectActive = controller.state.activeToolId === "select";
  const interactive = selectActive && !project.readOnly && !panArmed;

  /* Escape ends the visual drag; the store rollback happens in the studio's
   * global gesture handler (cancelGesture). */
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDrag(null);
      setSnapLines({ x: [], y: [] });
      setQuadInvalid(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag]);

  /* ----- helpers ----- */

  const pct = (value: number, total: number) => `${(value / total) * 100}%`;

  function metricsNow() {
    return measureCanvas(canvasRef.current, docW);
  }

  function docPoint(event: { clientX: number; clientY: number }): Vec2 | null {
    const metrics = metricsNow();
    if (!metrics) return null;
    return docPointFromClient(metrics, event.clientX, event.clientY);
  }

  function zoomNow(): number {
    return metricsNow()?.scale ?? 1;
  }

  function layerFor(id: Id | null): LayerV1 | null {
    return layers.find((layer) => layer.id === id) ?? null;
  }

  function toDragLayer(layer: LayerV1): TransformDragLayer | null {
    const asset = project.assetSizeFor(layer.id);
    if (!asset) return null;
    return {
      id: layer.id,
      locked: layer.locked,
      transform: layer.transform,
      size: croppedSize(layer.crop, asset.width, asset.height),
    };
  }

  function selectedDragLayers(ids: readonly Id[]): TransformDragLayer[] {
    const result: TransformDragLayer[] = [];
    for (const id of ids) {
      const layer = layerFor(id);
      if (!layer) continue;
      const dragLayer = toDragLayer(layer);
      if (dragLayer) result.push(dragLayer);
    }
    return result;
  }

  function snapCandidates(excluded: ReadonlySet<Id>): SnapCandidates {
    const layerBounds: Bounds[] = [];
    for (const layer of layers) {
      if (!layer.visible || excluded.has(layer.id)) continue;
      const asset = project.assetSizeFor(layer.id);
      if (!asset) continue;
      layerBounds.push(
        transformedBounds(layer.transform, croppedSize(layer.crop, asset.width, asset.height)),
      );
    }
    return {
      guidesX: core.guides.visible ? core.guides.vertical : [],
      guidesY: core.guides.visible ? core.guides.horizontal : [],
      gridSize: core.grid.size,
      layerBounds,
      artboard: { width: docW, height: docH },
    };
  }

  function snapContextFor(excluded: ReadonlySet<Id>) {
    return {
      snapping: core.snapping,
      candidates: snapCandidates(excluded),
      zoom: zoomNow(),
    };
  }

  function endDrag() {
    setDrag(null);
    setSnapLines({ x: [], y: [] });
    setQuadInvalid(false);
  }

  function capture(event: ReactPointerEvent<Element>) {
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  /* ----- root pointer handlers: layer hit-test select + move drag ----- */

  function onRootPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive || event.button !== 0 || project.editorMode !== "transform") return;
    if (event.target !== event.currentTarget) return; // handles manage themselves
    const point = docPoint(event);
    if (!point) return;
    const hitList = layers
      .map((layer) => {
        const asset = project.assetSizeFor(layer.id);
        if (!asset) return null;
        return {
          id: layer.id,
          visible: layer.visible,
          locked: layer.locked,
          transform: layer.transform,
          size: croppedSize(layer.crop, asset.width, asset.height),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const hit = hitTestLayers(point, hitList);
    if (!hit) {
      // Click on empty paper keeps the selection (matches layer panels).
      return;
    }
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const alreadySelected = project.selectedLayerIds.includes(hit.id);
    if (!alreadySelected || additive) {
      project.selectLayer(hit.id, { additive });
    }
    if (hit.locked) return;
    // A modifier-click on an already-selected layer DESELECTS it — that
    // click never starts a drag, and the dragged id set must reflect the
    // post-click selection (the deselected id previously leaked in stale).
    if (additive && alreadySelected) return;
    const ids = additive
      ? [...project.selectedLayerIds, hit.id]
      : alreadySelected
        ? project.selectedLayerIds
        : [hit.id];
    const state = beginTransformDrag("move", selectedDragLayers(ids), point);
    if (!state) return;
    event.preventDefault();
    capture(event);
    setDrag({ kind: "transform", state, label: "Move layer" });
  }

  function onRootPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    routePointerMove(event);
  }

  function onRootPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    routePointerUp(event);
  }

  /* ----- shared move/up routing for every drag kind ----- */

  function routePointerMove(event: ReactPointerEvent<Element>) {
    const active = dragRef.current;
    if (!active) return;
    const point = docPoint(event);
    if (!point) return;

    if (active.kind === "transform") {
      const update = updateTransformDrag(
        active.state,
        point,
        { shift: event.shiftKey },
        snapContextFor(new Set(active.state.layers.map((layer) => layer.id))),
      );
      const command = transformDragCommand(update);
      if (command) project.applyCommands(command, active.label);
      setSnapLines({ x: update.linesX, y: update.linesY });
      return;
    }
    if (active.kind === "guide") {
      const update = updateGuideDrag(active.state, point, {
        artboard: { width: docW, height: docH },
        snapping: core.snapping,
        gridSize: core.grid.size,
        zoom: zoomNow(),
      });
      if (update.command) project.applyCommands(update.command, "Move guide");
      setDrag({ kind: "guide", state: update.state });
      return;
    }
    if (active.kind === "crop") {
      const update = updateCropDrag(active.state, point);
      if (update.commands.length > 0) project.applyCommands(update.commands, "Crop layer");
      setDrag({ kind: "crop", state: update.state });
      return;
    }
    const update = updatePerspectiveDrag(
      active.state,
      point,
      snapContextFor(new Set([active.state.layerId])),
    );
    if (update.command) project.applyCommands(update.command, "Perspective");
    setQuadInvalid(!update.valid);
    setDrag({ kind: "perspective", state: update.state });
  }

  function routePointerUp(event: ReactPointerEvent<Element>) {
    if ((event.currentTarget as Element).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    }
    if (!dragRef.current) return;
    endDrag();
  }

  /* ----- handle pointerdowns ----- */

  function onTransformHandleDown(
    handle: TransformHandle,
    event: ReactPointerEvent<Element>,
  ) {
    if (!interactive || event.button !== 0) return;
    const point = docPoint(event);
    if (!point) return;
    const state = beginTransformDrag(
      handle,
      selectedDragLayers(project.selectedLayerIds),
      point,
    );
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    capture(event);
    setDrag({
      kind: "transform",
      state,
      label: handle === "rotate" ? "Rotate layer" : handle === "move" ? "Move layer" : "Scale layer",
    });
  }

  function onGuidePointerDown(
    axis: "horizontal" | "vertical",
    index: number,
    event: ReactPointerEvent<Element>,
  ) {
    if (project.readOnly || core.guides.locked || event.button !== 0) return;
    // The element identifies the guide exactly — no hit-test tolerance
    // games; the pure machine covers hitTestGuides-based entry in tests.
    const offset =
      axis === "vertical" ? core.guides.vertical[index] : core.guides.horizontal[index];
    setDrag({
      kind: "guide",
      state: { phase: "move", axis, index, startOffset: offset, offset },
    });
    event.preventDefault();
    event.stopPropagation();
    capture(event);
  }

  function onGuideKeyDown(
    axis: "horizontal" | "vertical",
    index: number,
    event: ReactKeyboardEvent<Element>,
  ) {
    if (project.readOnly || core.guides.locked) return;
    const offsets = axis === "vertical" ? core.guides.vertical : core.guides.horizontal;
    const offset = offsets[index];
    const step = event.shiftKey ? 10 : 1;
    const extent = axis === "vertical" ? docW : docH;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      project.applyCommands(guideRemoveCommand(axis, index), "Remove guide");
      return;
    }
    const along =
      axis === "vertical"
        ? { decrease: "ArrowLeft", increase: "ArrowRight" }
        : { decrease: "ArrowUp", increase: "ArrowDown" };
    if (event.key === along.decrease || event.key === along.increase) {
      event.preventDefault();
      const next = Math.min(
        extent,
        Math.max(0, offset + (event.key === along.increase ? step : -step)),
      );
      if (next !== offset) {
        project.applyCommands(
          { type: "guides/move", axis, index, offset: next },
          "Move guide",
        );
      }
    }
  }

  /* ----- keyboard alternatives for crop / perspective handles -----
   * Each arrow press drives the SAME pure machine one step (begin → update
   * at a nudged point → apply), so keyboard and pointer editing can never
   * diverge. Snapping is off for keyboard nudges (deterministic steps);
   * each press is one undoable command. Step: 1 doc px, Shift = 10. */

  function arrowDelta(event: ReactKeyboardEvent<Element>): Vec2 | null {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") return { x: -step, y: 0 };
    if (event.key === "ArrowRight") return { x: step, y: 0 };
    if (event.key === "ArrowUp") return { x: 0, y: -step };
    if (event.key === "ArrowDown") return { x: 0, y: step };
    return null;
  }

  function noSnapContext() {
    return {
      snapping: { ...core.snapping, enabled: false },
      candidates: snapCandidates(new Set<Id>()),
      zoom: zoomNow(),
    };
  }

  function onPerspectiveHandleKey(
    corner: 0 | 1 | 2 | 3,
    event: ReactKeyboardEvent<Element>,
  ) {
    if (!interactive) return;
    const delta = arrowDelta(event);
    if (!delta) return;
    const layer = layerFor(project.primaryLayerId);
    const dragLayer = layer ? toDragLayer(layer) : null;
    if (!dragLayer || dragLayer.locked) return;
    event.preventDefault();
    const state = beginPerspectiveDrag(dragLayer, corner);
    if (!state) return;
    const target = {
      x: state.startQuad[corner].x + delta.x,
      y: state.startQuad[corner].y + delta.y,
    };
    const update = updatePerspectiveDrag(state, target, noSnapContext());
    if (update.command) project.applyCommands(update.command, "Perspective");
    setQuadInvalid(!update.valid);
  }

  function onCropHandleKey(
    handle: Exclude<CropHandle, "move">,
    event: ReactKeyboardEvent<Element>,
  ) {
    if (!interactive) return;
    const delta = arrowDelta(event);
    if (!delta) return;
    const layer = layerFor(project.primaryLayerId);
    const asset = layer ? project.assetSizeFor(layer.id) : null;
    if (!layer || layer.locked || !asset) return;
    const geometry = cropGeometry();
    if (!geometry) return;
    event.preventDefault();
    const point = geometry.handlePoints[handle];
    const state = beginCropDrag(handle, layer, asset, point);
    if (!state) return;
    const update = updateCropDrag(state, {
      x: point.x + delta.x,
      y: point.y + delta.y,
    });
    if (update.commands.length > 0) project.applyCommands(update.commands, "Crop layer");
  }

  function onCropHandleDown(handle: CropHandle, event: ReactPointerEvent<Element>) {
    if (!interactive || event.button !== 0) return;
    const layer = layerFor(project.primaryLayerId);
    const asset = layer ? project.assetSizeFor(layer.id) : null;
    const point = docPoint(event);
    if (!layer || layer.locked || !asset || !point) return;
    const state = beginCropDrag(handle, layer, asset, point);
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    capture(event);
    setDrag({ kind: "crop", state });
  }

  function onPerspectiveHandleDown(corner: 0 | 1 | 2 | 3, event: ReactPointerEvent<Element>) {
    if (!interactive || event.button !== 0) return;
    const layer = layerFor(project.primaryLayerId);
    const dragLayer = layer ? toDragLayer(layer) : null;
    const point = docPoint(event);
    if (!dragLayer || !point) return;
    const state = beginPerspectiveDrag(dragLayer, corner);
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    capture(event);
    setQuadInvalid(false);
    setDrag({ kind: "perspective", state });
  }

  /* ----- derived render data ----- */

  const selectionBounds =
    interactive && project.editorMode === "transform"
      ? dragSelectionBounds(selectedDragLayers(project.selectedLayerIds))
      : null;

  const primaryLayer = layerFor(project.primaryLayerId);
  const primaryAsset = primaryLayer ? project.assetSizeFor(primaryLayer.id) : null;

  /** Crop geometry from the frozen drag matrix or the committed layer. */
  function cropGeometry() {
    if (!primaryLayer || !primaryAsset) return null;
    const active = drag?.kind === "crop" ? drag.state : null;
    const matrix = active ? active.sourceToDoc : sourceToDocMatrix(primaryLayer, primaryAsset);
    const rect = active
      ? active.rect
      : (primaryLayer.crop ?? { x: 0, y: 0, width: primaryAsset.width, height: primaryAsset.height });
    const map = (x: number, y: number) => mat3ApplyToPoint(matrix, { x, y });
    const sourceCorners = [
      map(0, 0),
      map(primaryAsset.width, 0),
      map(primaryAsset.width, primaryAsset.height),
      map(0, primaryAsset.height),
    ];
    const rectCorners = [
      map(rect.x, rect.y),
      map(rect.x + rect.width, rect.y),
      map(rect.x + rect.width, rect.y + rect.height),
      map(rect.x, rect.y + rect.height),
    ];
    const handlePoints: Record<Exclude<CropHandle, "move">, Vec2> = {
      nw: rectCorners[0],
      ne: rectCorners[1],
      se: rectCorners[2],
      sw: rectCorners[3],
      n: map(rect.x + rect.width / 2, rect.y),
      e: map(rect.x + rect.width, rect.y + rect.height / 2),
      s: map(rect.x + rect.width / 2, rect.y + rect.height),
      w: map(rect.x, rect.y + rect.height / 2),
    };
    return { sourceCorners, rectCorners, handlePoints };
  }

  function perspectiveQuad(): [Vec2, Vec2, Vec2, Vec2] | null {
    if (!primaryLayer || !primaryAsset) return null;
    if (drag?.kind === "perspective") return drag.state.lastValid;
    const size = croppedSize(primaryLayer.crop, primaryAsset.width, primaryAsset.height);
    return primaryLayer.transform.perspective ?? transformedCorners(primaryLayer.transform, size);
  }

  const crop = interactive && project.editorMode === "crop" ? cropGeometry() : null;
  const quad = interactive && project.editorMode === "perspective" ? perspectiveQuad() : null;

  const points = (corners: readonly Vec2[]) =>
    corners.map((corner) => `${corner.x},${corner.y}`).join(" ");

  return (
    <div
      className={`ws-artboard-overlays${interactive ? " is-interactive" : ""}`}
      onPointerDown={onRootPointerDown}
      onPointerMove={onRootPointerMove}
      onPointerUp={onRootPointerUp}
      onPointerCancel={endDrag}
    >
      {/* Configurable grid — workspace overlay only, never in a render
          payload or an export. Drawn as one SVG pattern so any artboard /
          grid-size combination stays cheap; non-scaling stroke keeps the
          lines 1 screen px at every zoom. */}
      {core.grid.visible && core.grid.size > 0 && (
        <svg
          className="ws-grid"
          data-testid="ws-grid"
          viewBox={`0 0 ${docW} ${docH}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <pattern
              id={gridPatternId}
              width={core.grid.size}
              height={core.grid.size}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${core.grid.size} 0 H 0 V ${core.grid.size}`}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            </pattern>
          </defs>
          <rect width={docW} height={docH} fill={`url(#${gridPatternId})`} />
        </svg>
      )}

      {/* Guides */}
      {core.guides.visible &&
        core.guides.vertical.map((offset, index) => (
          <div
            key={`v-${index}`}
            className={`ws-guide is-vertical${core.guides.locked ? " is-locked" : ""}`}
            data-testid="ws-guide-vertical"
            style={{ left: pct(offset, docW) }}
            tabIndex={core.guides.locked ? -1 : 0}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Vertical guide at ${Math.round(offset)} px`}
            title="Drag to move · Delete removes · right-click removes"
            onPointerDown={(event) => onGuidePointerDown("vertical", index, event)}
            onPointerMove={routePointerMove}
            onPointerUp={routePointerUp}
            onKeyDown={(event) => onGuideKeyDown("vertical", index, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!project.readOnly && !core.guides.locked) {
                project.applyCommands(guideRemoveCommand("vertical", index), "Remove guide");
              }
            }}
          />
        ))}
      {core.guides.visible &&
        core.guides.horizontal.map((offset, index) => (
          <div
            key={`h-${index}`}
            className={`ws-guide is-horizontal${core.guides.locked ? " is-locked" : ""}`}
            data-testid="ws-guide-horizontal"
            style={{ top: pct(offset, docH) }}
            tabIndex={core.guides.locked ? -1 : 0}
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Horizontal guide at ${Math.round(offset)} px`}
            title="Drag to move · Delete removes · right-click removes"
            onPointerDown={(event) => onGuidePointerDown("horizontal", index, event)}
            onPointerMove={routePointerMove}
            onPointerUp={routePointerUp}
            onKeyDown={(event) => onGuideKeyDown("horizontal", index, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!project.readOnly && !core.guides.locked) {
                project.applyCommands(guideRemoveCommand("horizontal", index), "Remove guide");
              }
            }}
          />
        ))}

      {/* Smart-guide snap lines (drag feedback only) */}
      {snapLines.x.map((x) => (
        <div
          key={`snap-x-${x}`}
          className="ws-snap-line is-vertical"
          style={{ left: pct(x, docW) }}
          aria-hidden="true"
        />
      ))}
      {snapLines.y.map((y) => (
        <div
          key={`snap-y-${y}`}
          className="ws-snap-line is-horizontal"
          style={{ top: pct(y, docH) }}
          aria-hidden="true"
        />
      ))}

      {/* Selection transform box */}
      {selectionBounds && project.editorMode === "transform" && (
        <div
          className="ws-transform-box"
          data-testid="ws-transform-box"
          style={{
            left: pct(selectionBounds.x, docW),
            top: pct(selectionBounds.y, docH),
            width: pct(selectionBounds.width, docW),
            height: pct(selectionBounds.height, docH),
          }}
        >
          {SCALE_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className={`ws-handle ws-handle-${handle}`}
              data-testid={`ws-handle-scale-${handle}`}
              aria-label={`Scale handle ${handle}`}
              tabIndex={-1}
              onPointerDown={(event) => onTransformHandleDown(`scale-${handle}`, event)}
              onPointerMove={routePointerMove}
              onPointerUp={routePointerUp}
            />
          ))}
          <button
            type="button"
            className="ws-handle ws-handle-rotate"
            data-testid="ws-handle-rotate"
            aria-label="Rotate handle"
            tabIndex={-1}
            onPointerDown={(event) => onTransformHandleDown("rotate", event)}
            onPointerMove={routePointerMove}
            onPointerUp={routePointerUp}
          />
        </div>
      )}

      {/* Crop mode */}
      {crop && (
        <>
          <svg
            className="ws-crop-svg"
            viewBox={`0 0 ${docW} ${docH}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polygon className="ws-crop-source" points={points(crop.sourceCorners)} />
            <polygon
              className="ws-crop-rect"
              points={points(crop.rectCorners)}
              style={{ pointerEvents: "fill", cursor: "move" }}
              data-testid="ws-crop-rect"
              onPointerDown={(event) => onCropHandleDown("move", event)}
              onPointerMove={routePointerMove}
              onPointerUp={routePointerUp}
            />
          </svg>
          {CROP_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className={`ws-handle ws-crop-handle ws-handle-${handle}`}
              data-testid={`ws-crop-handle-${handle}`}
              aria-label={`Crop handle ${handle} — arrow keys nudge, Shift for 10px`}
              tabIndex={0}
              style={{
                left: pct(crop.handlePoints[handle].x, docW),
                top: pct(crop.handlePoints[handle].y, docH),
              }}
              onPointerDown={(event) => onCropHandleDown(handle, event)}
              onPointerMove={routePointerMove}
              onPointerUp={routePointerUp}
              onKeyDown={(event) => onCropHandleKey(handle, event)}
            />
          ))}
        </>
      )}

      {/* Perspective corner editing */}
      {quad && (
        <>
          <svg
            className="ws-perspective-svg"
            viewBox={`0 0 ${docW} ${docH}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polygon
              className={`ws-perspective-quad${quadInvalid ? " is-invalid" : ""}`}
              points={points(quad)}
            />
          </svg>
          {quad.map((corner, index) => (
            <button
              key={index}
              type="button"
              className="ws-handle ws-perspective-handle"
              data-testid={`ws-perspective-handle-${index}`}
              aria-label={`Perspective corner ${index + 1} — arrow keys nudge, Shift for 10px`}
              tabIndex={0}
              style={{ left: pct(corner.x, docW), top: pct(corner.y, docH) }}
              onPointerDown={(event) =>
                onPerspectiveHandleDown(index as 0 | 1 | 2 | 3, event)
              }
              onPointerMove={routePointerMove}
              onPointerUp={routePointerUp}
              onKeyDown={(event) =>
                onPerspectiveHandleKey(index as 0 | 1 | 2 | 3, event)
              }
            />
          ))}
        </>
      )}
    </div>
  );
}
