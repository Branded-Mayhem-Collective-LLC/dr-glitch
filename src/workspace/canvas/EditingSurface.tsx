/**
 * EditingSurface — unit-aware rulers around the canvas viewport plus the
 * drag-from-ruler guide creation gesture.
 *
 * Rulers are workspace chrome: they read the document (unit preference,
 * artboard, guides/snapping) but never enter render payloads or exports.
 * Tick math is generateRulerTicks (src/editor, unit-exact at 240 DPI);
 * the doc↔screen mapping comes from measuring the visible canvas.
 *
 * Guide creation: pointer down on a ruler starts a guide-drag (pure machine
 * in guide-drag.ts). The guide is a preview line until pointer release
 * commits ONE guides/add command — a single undo transaction. Escape or
 * releasing outside the artboard cancels. Locked guides and read-only
 * sessions disable creation.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { generateRulerTicks } from "../../editor";
import { useProjectUi } from "../project-ui";
import { useStudioApi } from "../studio-api";
import {
  beginGuideCreate,
  cancelGuideDrag,
  commitGuideDrag,
  GUIDE_IDLE,
  updateGuideDrag,
  type GuideDragState,
} from "./guide-drag";
import { docPointFromClient, measureCanvas, type CanvasMetrics } from "./canvas-metrics";

const RULER_THICKNESS = 22;

type Props = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Bumps whenever zoom/pan/artboard change so rulers re-measure. */
  viewKey: string;
  children: ReactNode;
};

function RulerTicks({
  metrics,
  orientation,
  rulerStart,
  rulerLength,
  unit,
}: {
  metrics: CanvasMetrics;
  orientation: "horizontal" | "vertical";
  rulerStart: number;
  rulerLength: number;
  unit: "px" | "in" | "mm";
}) {
  const canvasStart = orientation === "horizontal" ? metrics.left : metrics.top;
  const ticks = generateRulerTicks({
    unit,
    zoom: metrics.scale,
    viewportStartDocPx: (rulerStart - canvasStart) / metrics.scale,
    viewportLengthScreenPx: rulerLength,
    minMajorSpacingPx: unit === "px" ? 64 : 48,
  });
  return (
    <>
      {ticks.map((tick) => (
        <span
          key={`${tick.kind}-${tick.docPx}`}
          className={`ws-ruler-tick is-${tick.kind}`}
          style={
            orientation === "horizontal"
              ? { left: tick.screenPx }
              : { top: tick.screenPx }
          }
          aria-hidden="true"
        >
          {tick.label !== null && (
            <span className="ws-ruler-label">{tick.label}</span>
          )}
        </span>
      ))}
    </>
  );
}

export function EditingSurface({ canvasRef, viewKey, children }: Props) {
  const project = useProjectUi();
  const api = useStudioApi();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [, setMeasureTick] = useState(0);
  const [drag, setDrag] = useState<GuideDragState>(GUIDE_IDLE);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const { core } = project;
  const rulersOn = project.rulersVisible;

  const remeasure = useCallback(() => {
    requestAnimationFrame(() => setMeasureTick((tick) => tick + 1));
  }, []);

  useEffect(remeasure, [viewKey, rulersOn, remeasure]);

  useEffect(() => {
    const root = rootRef.current;
    window.addEventListener("resize", remeasure);
    root?.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      root?.removeEventListener("scroll", remeasure, true);
    };
  }, [remeasure]);

  // Escape cancels an in-flight guide creation (visual only — no commands
  // were applied, so there is nothing to roll back).
  useEffect(() => {
    if (drag.phase !== "create") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrag(cancelGuideDrag());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag.phase]);

  const metrics = measureCanvas(canvasRef.current, core.artboard.widthPx);
  const rootRect = rootRef.current?.getBoundingClientRect() ?? null;
  const contentRect = contentRef.current?.getBoundingClientRect() ?? null;

  const canCreateGuides =
    !project.readOnly && !core.guides.locked && metrics !== null;

  function dragContext() {
    return {
      artboard: { width: core.artboard.widthPx, height: core.artboard.heightPx },
      snapping: core.snapping,
      gridSize: core.grid.size,
      zoom: metrics?.scale ?? 1,
    };
  }

  function onRulerPointerDown(
    axis: "horizontal" | "vertical",
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (!canCreateGuides || event.button !== 0 || !metrics) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = docPointFromClient(metrics, event.clientX, event.clientY);
    setDrag(updateGuideDrag(beginGuideCreate(axis), point, dragContext()).state);
  }

  function onRulerPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragRef.current;
    if (state.phase !== "create" || !metrics) return;
    const point = docPointFromClient(metrics, event.clientX, event.clientY);
    setDrag(updateGuideDrag(state, point, dragContext()).state);
  }

  function onRulerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (state.phase !== "create") return;
    const command = commitGuideDrag(state);
    if (command) project.applyCommands(command, "Add guide");
    setDrag(GUIDE_IDLE);
  }

  /** Screen position of the create-preview line, relative to the root. */
  function previewStyle(): { left?: number; top?: number } | null {
    if (drag.phase !== "create" || !drag.valid || !metrics || !rootRect) return null;
    if (drag.axis === "vertical") {
      return { left: metrics.left - rootRect.left + drag.offset * metrics.scale };
    }
    return { top: metrics.top - rootRect.top + drag.offset * metrics.scale };
  }

  const preview = previewStyle();

  return (
    <div
      ref={rootRef}
      className={`ws-editing-surface${rulersOn ? " has-rulers" : ""}`}
      style={{ "--ws-ruler-size": `${RULER_THICKNESS}px` } as React.CSSProperties}
    >
      {rulersOn && (
        <>
          <div className="ws-ruler-corner" aria-hidden="true">
            {api.unitDisplay}
          </div>
          <div
            className="ws-ruler is-horizontal"
            data-testid="ws-ruler-horizontal"
            role="presentation"
            title={
              canCreateGuides
                ? "Drag down to create a horizontal guide"
                : "Guides are locked"
            }
            onPointerDown={(event) => onRulerPointerDown("horizontal", event)}
            onPointerMove={onRulerPointerMove}
            onPointerUp={onRulerPointerUp}
            onPointerCancel={() => setDrag(GUIDE_IDLE)}
          >
            {metrics && contentRect && (
              <RulerTicks
                metrics={metrics}
                orientation="horizontal"
                rulerStart={contentRect.left}
                rulerLength={contentRect.width}
                unit={api.unitDisplay}
              />
            )}
          </div>
          <div
            className="ws-ruler is-vertical"
            data-testid="ws-ruler-vertical"
            role="presentation"
            title={
              canCreateGuides
                ? "Drag right to create a vertical guide"
                : "Guides are locked"
            }
            onPointerDown={(event) => onRulerPointerDown("vertical", event)}
            onPointerMove={onRulerPointerMove}
            onPointerUp={onRulerPointerUp}
            onPointerCancel={() => setDrag(GUIDE_IDLE)}
          >
            {metrics && contentRect && (
              <RulerTicks
                metrics={metrics}
                orientation="vertical"
                rulerStart={contentRect.top}
                rulerLength={contentRect.height}
                unit={api.unitDisplay}
              />
            )}
          </div>
        </>
      )}
      <div ref={contentRef} className="ws-editing-content">
        {children}
      </div>
      {preview && (
        <div
          className={`ws-guide-drag-preview is-${drag.phase === "create" ? drag.axis : ""}`}
          style={preview}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
