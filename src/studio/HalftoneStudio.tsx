"use client";

/**
 * HalftoneStudio — the studio state owner for one OPEN project.
 *
 * Document truth lives in the project store (ProjectCoreV1 via ProjectStore /
 * DocumentApi); this component projects it onto the legacy single-artwork
 * render shapes (HalftoneSettings / DocumentSettings) so the existing render
 * path stays byte-identical for a one-layer project.
 *
 * RENDER ROUTING (editor-UI wave): the canvas renders through TWO paths,
 * chosen per frame by legacyEngineEligible (src/export/current-engine):
 * - A project in the exact legacy single-layer shape (one visible
 *   halftone/diffusion layer, uncropped, identity transform, full-artboard
 *   source) keeps the ORIGINAL renderHalftone path — pixel-identical to the
 *   pre-workstation studio and to the render-regression oracle.
 * - Everything else (multi-layer stacks, clean mode, moved/cropped/warped
 *   layers, empty projects) renders through PreviewService: draft jobs at
 *   draftScaleFor scale on every change, the exact viewport job ~180ms
 *   after the last change, via the preview worker (MainThreadRenderer
 *   fallback outside worker-capable engines). Frames draw through
 *   preview-presenter; registration marks are the final main-thread pass.
 */

import { Check, Sparkles, Upload, X, ZoomIn, ZoomOut } from "lucide-react";
import { useNavigate } from "react-router";
import { PRODUCT_NAME } from "../brand";
import CustomShapeDialog from "./CustomShapeDialog";
import { importCustomShape, prepareCustomShape } from "./custom-shape";
import type { CustomShapeAsset } from "./custom-shape-data";
import { CHROME_INK, COMPOSITE_INK } from "./inks";
import { isInteractiveTarget } from "./useStudioKeys";
import { isModalOpen } from "../workspace/shortcuts";
import {
  MAX_EXPORT_GRID_POINTS,
  MAX_DIFFUSION_RASTER_PIXELS,
  estimateGridPoints,
  HalftoneSettings,
  PLATE_META,
  PLATES,
  processPlates,
  Plate,
  renderHalftone,
} from "./halftone";
import {
  DEFAULT_DOCUMENT_SETTINGS,
  DOCUMENT_DPI,
  type DocumentSettings,
  getFitScalePercent,
  getSheetPixelDimensions,
  SHEET_SIZES,
} from "./document-model";
import { ArtworkIntakeError, validateArtworkFile } from "./image-file";
import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DEFAULT_SETTINGS } from "./settings-defaults";
import { WorkspaceShell } from "../workspace/WorkspaceShell";
import {
  StudioApiContext,
  type ExportPipeline,
  type ProcessPlate,
  type StudioApi,
  type UnitDisplay,
} from "../workspace/studio-api";
import { ProjectUiContext, type ProjectUi } from "../workspace/project-ui";
import "../workspace/workstation-ui.css";
import { TextPromptDialog, ChoiceDialog } from "../workspace/dialogs";
import { DirtyWorkDialog } from "../home/DirtyWorkDialog";
import type { DirtyGuardChoice } from "../home/dirty-guard";
/* Direct module imports (not the src/app index) keep the StudioGate ->
 * HalftoneStudio -> app dependency acyclic. */
import {
  commandsForDocumentPatch,
  commandsForSetting,
  documentFromCore,
  halftoneSettingsFromCore,
  resetDiffusionCommands,
  resetGlitchCommands,
  resetHalftoneCommands,
  resetOutputCommands,
} from "../app/legacy-bridge";
import { AssetCache } from "../app/asset-cache";
import {
  artworkIntakeCommands,
  layerCapError,
  type ArtworkIntakeIntent,
} from "../app/artwork-intake";
import { ensureLive } from "../app/lifecycle";
import { probeEnvironmentCapabilities } from "../app/capabilities";
import {
  PreviewService,
  previewPaper,
  previewPlates,
  type PreviewFrame,
} from "../app/preview-service";
import { createPreviewWorker, WorkerRenderPort } from "../app/worker-port";
import { discardPayload, MainThreadRenderer } from "../render";
import { legacyProofEligible } from "../export/current-engine";
import { composeTransformPatch } from "../workspace/canvas/transform-compose";
import { EditingSurface } from "../workspace/canvas/EditingSurface";
import { ArtboardOverlays } from "../workspace/canvas/ArtboardOverlays";
import {
  presentPreviewFrame,
  type PresenterContext,
  type PresenterLayerShape,
} from "../workspace/canvas/preview-presenter";
import { startAppSpan } from "../telemetry/sentry";
import { loadImageBlob } from "../io/image-load";
import { customShapeStamp } from "./custom-shape";
import type { EditorMode } from "../workspace/project-ui";
/* Real export pipeline (addendum: UI exports go through the orchestrator). */
import {
  createWarningGate,
  deliverStudioExport,
  loadAssetInfos,
  preflightForTarget,
  registerExportSuspendable,
  startStudioExport,
} from "../app/export-flow";
import { createRegistrationPainter, createStudioRenderService } from "../app/studio-export";
import { createExportSessionStore, type ExportSessionStore } from "../export/export-session";
import { BROWSER_EXPORT_ENCODERS, downloadExportBlob } from "../export/encoders";
import { ExportCancelledError, type RenderService } from "../export/orchestrator";
import { vectorPlateEligibility, type AssetInfo } from "../export/preflight";
import type { ExportTarget } from "../export/targets";
import { useAppSession, useSessionSnapshot } from "../app/app-context";
import {
  createLayerFromAsset,
  createPresetFromLayer,
  parsePreset,
  applyPresetCommand,
  useProjectStore,
  type Command,
} from "../project";
import { RESOURCE_POLICY } from "../core/resource-policy";
import { createId } from "../core/id";
import { ConflictError } from "../storage";
import type { Id, RecipePresetV1 } from "../core/types";

const ZOOM_BOUNDS = { min: 35, max: 110, fit: 76 } as const;

type GuardedAction = "new" | "home";

/** Cheap viewBox/width parse for stored-SVG asset dimensions. */
function svgDimensions(svg: string): { width: number; height: number } {
  const viewBox = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]?.trim().split(/[\s,]+/);
  if (viewBox?.length === 4) {
    const width = Number(viewBox[2]);
    const height = Number(viewBox[3]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width: Math.round(width), height: Math.round(height) };
    }
  }
  return { width: 100, height: 100 };
}

export default function HalftoneStudio() {
  const controller = useAppSession();
  const snapshot = useSessionSnapshot();
  const navigate = useNavigate();
  if (!snapshot.open) throw new Error("HalftoneStudio requires an open project");
  const open = snapshot.open;
  const { store, doc } = open;
  const projectState = useProjectStore(store);
  const core = projectState.envelope.core;
  const layers = core.layers;

  /* ----- asset cache (session-scoped, StrictMode-safe) -----
   * The effect below owns the cache lifetime: cleanup disposes it, and a
   * setup re-run after cleanup (StrictMode runs setup → cleanup → setup on
   * one mounted instance with refs preserved) constructs a FRESH cache and
   * re-renders so render-scope consumers rebind. Reading through ensureLive
   * everywhere means no code path can hold a permanently disposed cache. */
  const cacheRef = useRef<AssetCache | null>(null);
  const cache = ensureLive(cacheRef, () => new AssetCache(controller.assets));
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    const previous = cacheRef.current;
    const live = ensureLive(cacheRef, () => new AssetCache(controller.assets));
    if (live !== previous) setCacheTick((tick) => tick + 1);
    const unsubscribe = live.subscribe(() => setCacheTick((tick) => tick + 1));
    // Export suspension (decode-cache co-residency): the cache's raster
    // decode cache evicts for the duration of every export and refills
    // lazily after — registered on the flow-level registry so the export
    // pipeline needs no component plumbing.
    const unregister = registerExportSuspendable({
      suspendForExport: () => live.suspendRasters(),
      resumeAfterExport: () => live.resumeRasters(),
    });
    return () => {
      unregister();
      unsubscribe();
      live.dispose();
    };
  }, [controller.assets]);

  /* ----- session-only selection (never in undo history) ----- */
  const [selection, setSelection] = useState<Id[]>([]);
  const selectedLayerIds = useMemo(
    () => selection.filter((id) => layers.some((layer) => layer.id === id)),
    [selection, layers],
  );
  const primaryLayerId =
    selectedLayerIds[selectedLayerIds.length - 1] ?? layers[layers.length - 1]?.id ?? null;
  const primaryLayer = layers.find((layer) => layer.id === primaryLayerId) ?? null;

  /* ----- legacy projections ----- */
  const customShape =
    primaryLayer?.recipe.halftone.customShapeAssetId != null
      ? cache.getCustomShape(primaryLayer.recipe.halftone.customShapeAssetId) ?? undefined
      : undefined;
  const registrationShape =
    core.registration.customShapeAssetId != null
      ? cache.getCustomShape(core.registration.customShapeAssetId) ?? undefined
      : undefined;

  const settings = useMemo<HalftoneSettings>(() => {
    if (!primaryLayer) {
      return {
        ...DEFAULT_SETTINGS,
        grayscale: core.separation.mode === "grayscale",
        angles: { ...core.separation.angles },
        visible: { ...core.separation.visible },
      };
    }
    const mapped = halftoneSettingsFromCore(core, primaryLayer, customShape);
    // UI truth: glitch parameter values stay visible even while no glitch
    // amount is live (enabled=false renders identically because amounts are 0).
    const glitch = primaryLayer.recipe.glitch;
    return {
      ...mapped,
      sliceShift: glitch.sliceShift,
      sliceSize: glitch.sliceSize,
      verticalSliceShift: glitch.verticalSliceShift,
      verticalSliceSize: glitch.verticalSliceSize,
      gridWarp: glitch.gridWarp,
      warpScale: glitch.warpScale,
      smearDrag: glitch.smearDrag,
      smearLength: glitch.smearLength,
      smearVertical: glitch.smearVertical,
      macroblockCorrupt: glitch.macroblockCorrupt,
      macroblockDropout: glitch.macroblockDropout,
      blockShift: glitch.blockShift,
      blockShiftSize: glitch.blockShiftSize,
      channelDesync: glitch.channelDesync,
      bitmapSort: glitch.bitmapSort,
      bitmapSortVertical: glitch.bitmapSortVertical,
    };
  }, [core, primaryLayer, customShape]);

  const documentSettings = useMemo<DocumentSettings>(
    () => documentFromCore(core, primaryLayer),
    [core, primaryLayer],
  );

  // Widened to the StudioApi source type: future render binding may hand the
  // canvas a staged HTMLCanvasElement instead of the decoded image.
  const source = (primaryLayer ? cache.getImage(primaryLayer.assetId) : null) as
    | HTMLImageElement
    | HTMLCanvasElement
    | null;
  const sourceName = primaryLayer?.name ?? "No artwork";

  const registration = core.output.registrationOnPlates;
  /* Proof registration overlay: SESSION-ONLY (never persisted to core,
   * never exported, never in undo history). null = follow the document's
   * plate-package default so the proof previews what plates will carry;
   * an explicit Proof-drawer toggle overrides for this session only. */
  const [proofOverlayOverride, setProofOverlayOverride] = useState<boolean | null>(null);
  const proofRegistration = proofOverlayOverride ?? registration;
  const registrationSize = core.registration.size ?? 120;
  const registrationOffset = core.registration.offset ?? 120;
  const registrationWeight = core.registration.weight;
  const registrationMode = core.registration.mode;

  /* ----- session view state ----- */
  const [selectedPlate, setActivePlate] = useState<Plate>("composite");
  const activePlate =
    settings.grayscale && selectedPlate !== "composite" ? "black" : selectedPlate;
  const applicablePlates = useMemo(() => processPlates(settings), [settings]);
  const [zoom, setZoom] = useState<number>(ZOOM_BOUNDS.fit);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [customShapeOpen, setCustomShapeOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const registrationFileRef = useRef<HTMLInputElement>(null);
  const renderFrame = useRef<number | null>(null);
  const artworkLoadRef = useRef(0);
  const artworkAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    artworkLoadRef.current += 1;
    artworkAbortRef.current?.abort();
  }, []);
  const registrationLoadRef = useRef(0);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  /* ----- dialog state ----- */
  const [dirtyGuard, setDirtyGuard] = useState<GuardedAction | null>(null);
  const [saveDialog, setSaveDialog] = useState<{ continueWith: GuardedAction | null } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);

  /*
   * Invocation ref for the project-flow dialogs: the control that opened the
   * dialog (topbar New/Save, project title, …) gets focus back whenever the
   * dialog closes without navigating away (Escape/Cancel, or a completed
   * in-place action like Rename). Deterministic keyboard round-trips are
   * part of the workspace-a11y contract.
   */
  const dialogInvokerRef = useRef<HTMLElement | null>(null);

  const captureDialogInvoker = useCallback(() => {
    dialogInvokerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);

  const restoreDialogInvoker = useCallback(() => {
    const invoker = dialogInvokerRef.current;
    dialogInvokerRef.current = null;
    if (!invoker) return;
    // Deferred one frame: the dialog must unmount (and ModalDialog must
    // lift `inert` from the app root) before the invoker can take focus.
    window.requestAnimationFrame(() => {
      if (invoker.isConnected) invoker.focus();
    });
  }, []);

  /* ----- gesture bracketing: scrub = ONE transaction; Escape cancels ----- */
  useEffect(() => {
    const down = () => doc.beginGesture();
    const up = () => doc.endGesture();
    // pointercancel is a CANCEL, not a commit: the system revoked the
    // pointer mid-drag, so the coalesced transaction rolls back exactly
    // like Escape instead of committing a half-finished scrub.
    const cancel = () => {
      if (!doc.cancelGesture()) doc.endGesture();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (doc.cancelGesture()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [doc]);

  /* ----- editor-UI session state (never in undo history) ----- */
  const [editorMode, setEditorMode] = useState<EditorMode>("transform");
  const [rulersVisible, setRulersVisible] = useState(true);
  const [previewFallback, setPreviewFallback] = useState(false);

  const assetSizeFor = useCallback(
    (layerId: Id): { width: number; height: number } | null => {
      const layer = store.getEnvelope().core.layers.find((candidate) => candidate.id === layerId);
      if (!layer) return null;
      const image = cache.getImage(layer.assetId);
      return image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
    },
    [store, cache],
  );

  /* ----- render routing: any DocumentSettings-representable single-layer
   * project proves through the ORIGINAL synchronous renderHalftone path
   * (legacyProofEligible — the legacy studio proved EVERY single-artwork
   * project this way, and the migrated pixel/latency specs depend on it);
   * everything else goes through PreviewService. EXPORT routing keeps the
   * stricter legacyEngineEligible inside createStudioRenderService. ----- */
  // Transparent artboard backgrounds are not DocumentSettings-representable
  // (legacy paper is always white/black): those proofs keep real alpha and
  // always render through PreviewService.
  const legacyEligible =
    legacyProofEligible(core) && core.artboard.background !== "transparent";
  const legacyEligibleRef = useRef(legacyEligible);
  legacyEligibleRef.current = legacyEligible;

  /* Presenter context for worker preview frames (rebuilt every render). */
  const visibleLayers = useMemo(() => layers.filter((layer) => layer.visible), [layers]);
  const presenterRef = useRef<PresenterContext | null>(null);
  presenterRef.current = {
    plates: previewPlates(core.separation, activePlate),
    paper: previewPaper(core.artboard.background),
    layerOpacities: visibleLayers.map((layer) => layer.opacity),
    layerShapes: visibleLayers.map((layer): PresenterLayerShape => {
      const { halftone } = layer.recipe;
      let stamp: CanvasImageSource | undefined;
      if (
        layer.recipe.mode === "halftone" &&
        halftone.dotShape === "custom" &&
        halftone.customShapeAssetId !== null
      ) {
        const shape = cache.getCustomShape(halftone.customShapeAssetId);
        if (shape) {
          try {
            stamp = customShapeStamp(shape, "#000000", 128);
          } catch {
            /* not prepared yet — the cache subscription re-renders */
          }
        }
      }
      return { dotShape: halftone.dotShape, strokeWidth: halftone.strokeWidth, stamp };
    }),
    registration: proofRegistration
      ? {
          size: registrationSize,
          offset: registrationOffset,
          weight: registrationWeight,
          mode: registrationMode,
          stamp: (() => {
            if (!registrationShape) return null;
            try {
              return customShapeStamp(registrationShape, "#121416", 256);
            } catch {
              return null;
            }
          })(),
        }
      : null,
  };

  const handlePreviewFrame = useCallback((frame: PreviewFrame) => {
    const canvas = canvasRef.current;
    const presenter = presenterRef.current;
    if (!canvas || !presenter || legacyEligibleRef.current) {
      discardPayload(frame.payload);
      return;
    }
    presentPreviewFrame(canvas, frame, presenter);
  }, []);

  const handlePreviewError = useCallback((error: { code: string; message: string }) => {
    if (error.code === "worker-crashed") {
      // Crash replacement exhausted: degrade to the main-thread renderer.
      setPreviewFallback(true);
      return;
    }
    setNotice(error.message);
  }, []);

  const previewServiceRef = useRef<{ service: PreviewService; fallback: boolean } | null>(null);
  const previewSuspendableUnregisterRef = useRef<(() => void) | null>(null);
  const getPreviewService = useCallback((): PreviewService => {
    const current = previewServiceRef.current;
    // isDisposed guard: under StrictMode the unmount cleanup disposes the
    // service between two setup passes while this ref survives; a disposed
    // service silently ignores requests, so it must be replaced, never reused.
    if (current && !current.service.isDisposed && current.fallback === previewFallback) {
      return current.service;
    }
    current?.service.dispose();
    const env = probeEnvironmentCapabilities();
    const useWorker = env.moduleWorkers && !previewFallback;
    const service = new PreviewService({
      createPort: useWorker
        ? () => new WorkerRenderPort(createPreviewWorker)
        : () => new MainThreadRenderer(true),
      sources: {
        // Resolve through the ref at call time (ensureLive) so a service
        // never captures a cache instance that a cleanup later disposes.
        resolveRaster: (assetId) =>
          ensureLive(cacheRef, () => new AssetCache(controller.assets)).getRasterData(assetId),
        resolveCustomStamp: (assetId, sizePx) =>
          ensureLive(cacheRef, () => new AssetCache(controller.assets)).getCustomStampBitmap(
            assetId,
            sizePx,
          ),
      },
      wantBitmap: env.createImageBitmap,
    });
    service.onFrame(handlePreviewFrame);
    service.onError(handlePreviewError);
    // Export suspension: the preview's decode/warp/proxy caches AND its
    // worker-side draft cache evict for the duration of every export.
    previewSuspendableUnregisterRef.current?.();
    previewSuspendableUnregisterRef.current = registerExportSuspendable(service);
    previewServiceRef.current = { service, fallback: previewFallback };
    return service;
  }, [controller.assets, previewFallback, handlePreviewFrame, handlePreviewError]);

  useEffect(
    () => () => {
      previewSuspendableUnregisterRef.current?.();
      previewSuspendableUnregisterRef.current = null;
      previewServiceRef.current?.service.dispose();
    },
    [],
  );

  /** Output px per document px for the exact viewport job. */
  const measureViewportScale = useCallback((): number => {
    const width = canvasRef.current?.getBoundingClientRect().width ?? 0;
    const { widthPx, heightPx } = store.getEnvelope().core.artboard;
    if (width <= 0) return Math.min(1, 980 / Math.max(widthPx, heightPx));
    const dpr = window.devicePixelRatio || 1;
    return Math.min(1, (width * dpr) / widthPx);
  }, [store]);

  /* ----- render (unchanged legacy path; gated by legacyEligible) ----- */
  const render = useCallback(() => {
    if (!legacyEligibleRef.current) return;
    if (!source || !canvasRef.current) return;
    // A custom dot renders only once its SVG asset resolves from storage;
    // the cache subscription re-renders the frame when it lands.
    if (settings.dotShape === "custom" && !settings.customShape) return;
    const sheet = getSheetPixelDimensions(
      documentSettings.sheetSize,
      documentSettings.orientation,
    );
    const maxDimension = 980;
    const scale = Math.min(1, maxDimension / Math.max(sheet.width, sheet.height));
    const finishPreview = startAppSpan("app.preview");
    try {
    renderHalftone(source, canvasRef.current, settings, {
      plate: activePlate,
      width: sheet.width * scale,
      height: sheet.height * scale,
      paper: documentSettings.background === "black" ? "#111214" : "#F4F1E9",
      registration: proofRegistration,
      registrationSize,
      registrationOffset,
      registrationWeight,
      registrationShape,
      registrationMode,
      monochromePlate: true,
      document: documentSettings,
      preview: true,
    });
    finishPreview();
    } catch (error) { finishPreview(error); throw error; }
  }, [activePlate, documentSettings, proofRegistration, registrationMode, registrationOffset, registrationShape, registrationSize, registrationWeight, settings, source]);

  useEffect(() => {
    let cancelled = false;
    if (renderFrame.current) cancelAnimationFrame(renderFrame.current);
    renderFrame.current = requestAnimationFrame(async () => {
      try {
        if (settings.dotShape === "custom" && settings.customShape) await prepareCustomShape(settings.customShape);
        if (registrationShape) await prepareCustomShape(registrationShape);
        if (!cancelled) render();
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "The custom SVG could not be rendered.");
      }
    });
    return () => {
      cancelled = true;
      if (renderFrame.current) cancelAnimationFrame(renderFrame.current);
    };
  }, [registrationShape, render, settings.dotShape, settings.customShape]);

  /* ----- worker preview: draft on every change, exact viewport on idle.
   * requestPreview submits the draft immediately and lets PreviewService
   * follow with the exact viewport job once THAT draft frame has delivered
   * and no newer change has arrived — during a pointer scrub each change
   * supersedes the pending exact, so only drafts render; the last change's
   * draft settles into exact as soon as it presents (no fixed delay). ----- */
  useEffect(() => {
    if (legacyEligible) return;
    const service = getPreviewService();
    service.pruneCaches(core);
    service.requestPreview({
      core,
      view: activePlate,
      viewportScale: measureViewportScale(),
    });
  }, [
    core,
    activePlate,
    legacyEligible,
    zoom,
    cacheTick,
    // Session-only proof overlay: marks draw in the presenter pass, so a
    // toggle re-requests the frame even though core did not change.
    proofRegistration,
    getPreviewService,
    measureViewportScale,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const sourceMeta = useMemo(() => {
    if (!source) return "No image";
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    return `${width} × ${height}px · RGB`;
  }, [source]);

  /* ----- command dispatch ----- */

  const notifyReadOnly = useCallback(() => {
    setNotice("This project is open read-only in this tab. Request ownership or duplicate it to edit.");
  }, []);

  const apply = useCallback(
    (commands: Command | Command[], label?: string) => {
      if (open.readOnly) {
        notifyReadOnly();
        return false;
      }
      return doc.apply(commands, label);
    },
    [doc, open.readOnly, notifyReadOnly],
  );

  const updateSetting = useCallback(
    <K extends keyof HalftoneSettings>(key: K, value: HalftoneSettings[K]) => {
      if (key === "customShape") return; // asset install path handles this
      const envelope = store.getEnvelope();
      const currentCore = envelope.core;
      const layer =
        currentCore.layers.find((candidate) => candidate.id === primaryLayerId) ?? null;
      const commands = commandsForSetting(currentCore, layer, key, value);
      if (commands.length > 0) apply(commands, String(key));
    },
    [apply, store, primaryLayerId],
  );

  const updateDocument = useCallback(
    (patch: Partial<DocumentSettings>) => {
      const envelope = store.getEnvelope();
      const currentCore = envelope.core;
      const layer =
        currentCore.layers.find((candidate) => candidate.id === primaryLayerId) ?? null;
      const commands = commandsForDocumentPatch(currentCore, layer, patch);
      if (commands.length > 0) apply(commands, "Document");
    },
    [apply, store, primaryLayerId],
  );

  const handleSolo = useCallback(
    (plate: Plate) => {
      if (settings.grayscale && plate !== "black" && plate !== "composite") return;
      setActivePlate(plate);
    },
    [settings.grayscale],
  );

  const handleToggleVisible = useCallback(
    (plate: ProcessPlate) => {
      apply(
        {
          type: "separation/set-plate-visibility",
          plate,
          visible: !store.getEnvelope().core.separation.visible[plate],
        },
        "Plate visibility",
      );
    },
    [apply, store],
  );

  const handleAngleChange = useCallback(
    (plate: ProcessPlate, angle: number) => {
      apply({ type: "separation/set-angle", plate, angle }, "Screen angle");
    },
    [apply],
  );

  const setAngles = useCallback(
    (angles: Record<ProcessPlate, number>) => {
      updateSetting("angles", angles);
    },
    [updateSetting],
  );

  /* Space-drag pan arming (session-only). */
  useEffect(() => {
    function down(event: KeyboardEvent) {
      if (event.code !== "Space" || event.repeat) return;
      if (isInteractiveTarget(event.target)) return;
      if (isModalOpen()) return; // no pan arming behind a modal dialog
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setSpaceHeld(true);
    }
    function up(event: KeyboardEvent) {
      if (event.code === "Space") setSpaceHeld(false);
    }
    function reset() {
      setSpaceHeld(false);
      setPanning(false);
      panStart.current = null;
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);

  /* ----- derived preflight (unchanged) ----- */
  const hiddenPlates = useMemo(
    () => applicablePlates.filter((plate) => !settings.visible[plate]),
    [settings.visible, applicablePlates],
  );
  const enabledPlates = useMemo(
    () => applicablePlates.filter((plate) => settings.visible[plate]),
    [applicablePlates, settings.visible],
  );
  const sharedAngleGroups = useMemo(() => {
    const grouped = new Map<number, Array<(typeof PLATES)[number]>>();
    for (const plate of applicablePlates) {
      const angle = ((settings.angles[plate] % 360) + 360) % 360;
      grouped.set(angle, [...(grouped.get(angle) ?? []), plate]);
    }
    return [...grouped.entries()].filter(([, plates]) => plates.length > 1);
  }, [settings.angles, applicablePlates]);
  const outputDimensions = getSheetPixelDimensions(
    documentSettings.sheetSize,
    documentSettings.orientation,
  );
  const screenLoad = applicablePlates
    .filter((plate) => settings.visible[plate])
    .reduce<{ marks: number; plate: (typeof PLATES)[number] | null }>(
      (worst, plate) => {
        const marks = estimateGridPoints(
          outputDimensions.width,
          outputDimensions.height,
          settings.cellSize,
          settings.angles[plate],
        );
        return marks > worst.marks ? { marks, plate } : worst;
      },
      { marks: 0, plate: null },
    );
  const diffusionPixelLoad =
    outputDimensions.width * outputDimensions.height * Math.max(1, enabledPlates.length);
  const diffusionMemoryBytes = outputDimensions.width * outputDimensions.height * 24;
  const screenLoadIsDense = settings.diffusionEnabled
    ? diffusionPixelLoad > MAX_DIFFUSION_RASTER_PIXELS
    : screenLoad.marks > MAX_EXPORT_GRID_POINTS;
  // Dot-polarity review keys on the CANONICAL output polarity (the only
  // output-stage inversion), never the per-layer recipe inverts.
  const polarityInverted = core.output.polarity === "negative";
  const preflightReviewCount =
    (hiddenPlates.length > 0 ? 1 : 0) +
    (sharedAngleGroups.length > 0 ? 1 : 0) +
    (!registration ? 1 : 0) +
    (polarityInverted ? 1 : 0) +
    (screenLoadIsDense ? 1 : 0);

  /* ----- resets (project commands, one transaction each) ----- */

  function resetHalftoneCmyk() {
    apply(resetHalftoneCommands(core, primaryLayer), "Reset halftone");
    setActivePlate("composite");
    setNotice("Halftone / CMYK controls reset");
  }

  function resetArtwork() {
    updateDocument({ ...DEFAULT_DOCUMENT_SETTINGS });
    setNotice("Artwork controls reset");
  }

  function resetOutput() {
    // Canonical output only: polarity, press mirror, registration defaults
    // and mark geometry. Never layer recipes or opacity (P0 contract).
    apply(resetOutputCommands(), "Reset output");
    // The session proof overlay follows the document default again.
    setProofOverlayOverride(null);
    setNotice("Output controls reset");
  }

  function resetDiffusion() {
    apply(resetDiffusionCommands(primaryLayer), "Reset diffusion");
    setNotice("Diffusion controls reset");
  }

  function resetGlitch() {
    apply(resetGlitchCommands(primaryLayer), "Reset glitch");
    setNotice("Glitch controls reset");
  }

  function fitArtworkToSheet() {
    if (!source || !primaryLayerId) return;
    const currentCore = store.getEnvelope().core;
    const layer = currentCore.layers.find((entry) => entry.id === primaryLayerId);
    if (!layer || layer.locked) return;
    const sourceWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const sourceHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    const { widthPx, heightPx } = currentCore.artboard;
    const scale = getFitScalePercent(sourceWidth, sourceHeight, widthPx, heightPx) / 100;
    apply({
      type: "layer/set-transform",
      layerId: layer.id,
      patch: composeTransformPatch(layer.transform, {
        position: { x: widthPx / 2, y: heightPx / 2 },
        scale: { x: scale, y: scale },
      }),
    }, "Fit artwork");
  }

  /* ----- job ticket / export (legacy path, unchanged output) ----- */

  function jobTicketText() {
    const visible = applicablePlates
      .filter((plate) => settings.visible[plate])
      .map((plate) => PLATE_META[plate].short)
      .join(", ");
    const sheet = SHEET_SIZES.find(({ id }) => id === documentSettings.sheetSize);
    return [
      `${PRODUCT_NAME} JOB TICKET`,
      `Artwork: ${sourceName}`,
      `Source: ${sourceMeta}`,
      `Sheet: ${sheet?.label ?? documentSettings.sheetSize}`,
      `Orientation: ${titleCase(documentSettings.orientation)}`,
      `Output dimensions: ${outputDimensions.width} × ${outputDimensions.height}px`,
      `Resolution: ${DOCUMENT_DPI} DPI`,
      `Scale: ${documentSettings.scalePercent}%`,
      `Mirror: ${
        documentSettings.mirrorImage ? titleCase(documentSettings.mirrorDirection) : "Off"
      }`,
      `Dot: ${settings.dotShape}`,
      ...(settings.dotShape === "custom" && settings.customShape
        ? [`Custom SVG: ${settings.customShape.filename} (stretched to square)`]
        : []),
      `Color mode: ${settings.grayscale ? "Grayscale (K)" : "CMYK"}`,
      `Outline stroke: ${settings.strokeWidth ?? 1}px`,
      `Cell size: ${settings.cellSize}px`,
      `Angles: ${applicablePlates
        .map((plate) => `${PLATE_META[plate].short} ${settings.angles[plate]}°`)
        .join(" · ")}`,
      `Enabled plates: ${visible || "None"}`,
      `Omitted plates: ${hiddenPlates.map((plate) => PLATE_META[plate].short).join(", ") || "None"}`,
      `Render mode: ${settings.diffusionEnabled ? "Diffusion" : "Halftone"}`,
      `Opacity: ${Math.round(settings.opacity * 100)}%`,
      `Registration marks: ${registration ? "Included" : "Off"}`,
      `Registration size: ${registrationSize}px`,
      `Registration offset: ${registrationOffset}px`,
      `Registration weight: ${registrationWeight}px`,
      `Registration mode: ${registrationMode === "centered" ? "Top/bottom centered" : "Four corners"}`,
      ...(registrationShape ? [`Registration SVG: ${registrationShape.filename}`] : []),
      settings.diffusionEnabled
        ? `Estimated diffusion load: ${diffusionPixelLoad.toLocaleString("en-US")} plate-pixels / ${Math.ceil(diffusionMemoryBytes / 1024 / 1024)} MiB working memory`
        : `Estimated screen load: ${screenLoad.marks.toLocaleString("en-US")} marks/plate${screenLoad.plate ? ` (${PLATE_META[screenLoad.plate].short} at ${settings.angles[screenLoad.plate]}°)` : ""}`,
    ].join("\n");
  }

  async function copyJobTicket() {
    const ticket = jobTicketText();
    try {
      await navigator.clipboard.writeText(ticket);
      setNotice("Job ticket copied");
    } catch {
      downloadBlob(
        new Blob([ticket], { type: "text/plain;charset=utf-8" }),
        `${cleanName(sourceName)}-job-ticket.txt`,
      );
      setNotice("Job ticket downloaded");
    }
  }

  /* ----- artwork import: asset store + layer command -----
   *
   * TWO flows share the intake pipeline, split BEFORE anything async:
   * - REPLACE (Select panel / canvas drop): replaces the layer that was
   *   primary when the picker opened;
   * - ADD (Layers panel): preserves the whole stack and artboard.
   * The intent is captured as an IMMUTABLE value when the picker opens and
   * travels with the load; the global artworkLoadRef keeps latest-wins, so
   * two racing intakes can never tear state. */

  const intakeIntentRef = useRef<ArtworkIntakeIntent>({
    mode: "replace",
    targetLayerId: null,
  });

  const requestArtworkReplace = useCallback(() => {
    intakeIntentRef.current = {
      mode: "replace",
      targetLayerId: primaryLayerId,
    };
    fileRef.current?.click();
  }, [primaryLayerId]);

  const requestArtworkAdd = useCallback(() => {
    if (layers.length >= RESOURCE_POLICY.maxLayers) {
      setNotice(layerCapError());
      return;
    }
    intakeIntentRef.current = { mode: "add" };
    fileRef.current?.click();
  }, [layers.length]);

  async function loadFile(file: File, intent: ArtworkIntakeIntent) {
    const request = ++artworkLoadRef.current;
    artworkAbortRef.current?.abort();
    const artworkAbort = new AbortController();
    artworkAbortRef.current = artworkAbort;
    // BYTES-LEVEL validation BEFORE any decoder runs (io/raster-validator
    // via the intake module: magic bytes, MIME/extension cross-checks,
    // APNG/animated-WebP rejection, header dimension + pixel quotas; SVG
    // through the strict "artwork" sanitizer). Typed rejections surface in
    // the existing toast style.
    let intake: Awaited<ReturnType<typeof validateArtworkFile>>;
    try {
      intake = await validateArtworkFile(file);
    } catch (error) {
      if (request !== artworkLoadRef.current) return;
      setNotice(
        error instanceof ArtworkIntakeError ? error.message : "That image could not be read.",
      );
      return;
    }
    if (request !== artworkLoadRef.current) return;
    // Decode AFTER validation — rasters from the validated bytes, SVGs from
    // the CANONICAL sanitized markup (the only form that is ever stored).
    const decodeBlob =
      intake.kind === "raster"
        ? new Blob([intake.bytes.slice() as unknown as BlobPart], { type: intake.info.mime })
        : new Blob([intake.sanitized.svg], { type: "image/svg+xml" });
    let image: HTMLImageElement;
    try {
      image = await loadImageBlob(decodeBlob, { signal: artworkAbort.signal });
    } catch {
      if (!artworkAbort.signal.aborted) setNotice("That image could not be opened.");
      return;
    }
    if (request !== artworkLoadRef.current) return;
    const dims =
      intake.kind === "raster"
        ? { width: intake.info.width, height: intake.info.height }
        : {
            width: image.naturalWidth || Math.round(intake.sanitized.width),
            height: image.naturalHeight || Math.round(intake.sanitized.height),
          };
    if (open.readOnly) {
      notifyReadOnly();
      return;
    }
    try {
      const record =
        intake.kind === "raster"
          ? await controller.assets.putBlob(intake.bytes, "raster", intake.info.mime, dims)
          : await controller.assets.putBlob(
              new TextEncoder().encode(intake.sanitized.svg),
              "svg",
              "image/svg+xml",
              dims,
            );
      if (request !== artworkLoadRef.current || artworkAbort.signal.aborted) return;
      // Keep the decoded image so the canvas never re-decodes the blob.
      cache.primeImage(record.sha256, image);

      const envelope = store.getEnvelope();
      const currentCore = envelope.core;
      const layer = createLayerFromAsset(
        record.sha256,
        file.name,
        { width: image.naturalWidth, height: image.naturalHeight },
        currentCore.artboard,
      );
      if (intent.mode === "replace") {
        // Parity: replaced artwork is screened immediately (never "clean").
        layer.recipe.mode = "halftone";
      }
      // ADD keeps createLayerFromAsset's contract: Clean mode, Glitch off.

      const result = artworkIntakeCommands(currentCore, intent, layer);
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      const commands: Command[] = [...result.commands];
      if (intent.mode === "replace") {
        // Orientation auto-fit is a REPLACE-only convenience; Add Layer
        // preserves the artboard exactly.
        const ratio = image.naturalWidth / image.naturalHeight;
        const orientation =
          ratio > 1.1 ? "landscape" : ratio < 0.9 ? "portrait" : documentSettings.orientation;
        if (orientation !== documentSettings.orientation) {
          const dims = getSheetPixelDimensions(documentSettings.sheetSize, orientation);
          commands.push({
            type: "artboard/resize",
            widthPx: dims.width,
            heightPx: dims.height,
            presetId: documentSettings.sheetSize,
          });
        }
      }
      if (apply(commands, intent.mode === "add" ? "Add layer" : "Import artwork")) {
        setSelection([layer.id]);
        setActivePlate("composite");
        setNotice(intent.mode === "add" ? "Layer added" : "Artwork loaded");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The artwork could not be stored.");
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Freeze the intent that opened THIS picker before anything async. A
    // replace intent without a captured target (the input was driven
    // directly, not through a button) materializes the CURRENT primary now
    // — the legacy single-artwork convention.
    let intent = intakeIntentRef.current;
    if (intent.mode === "replace" && intent.targetLayerId === null) {
      intent = { mode: "replace", targetLayerId: primaryLayerId };
    }
    // Consume the intent: the next direct input drive is a plain replace.
    intakeIntentRef.current = { mode: "replace", targetLayerId: null };
    if (file) void loadFile(file, intent);
    event.target.value = "";
  }

  async function onRegistrationFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++registrationLoadRef.current;
    try {
      const shape = await importCustomShape(file, "registration-mark");
      if (request !== registrationLoadRef.current) return;
      const bytes = new TextEncoder().encode(shape.svg);
      const record = await controller.assets.putBlob(
        bytes,
        "svg",
        "image/svg+xml",
        svgDimensions(shape.svg),
      );
      cache.primeCustomShape(record.sha256, shape);
      apply(
        [
          { type: "registration/update", patch: { customShapeAssetId: record.sha256 } },
          { type: "output/update", patch: { registrationOnPlates: true } },
        ],
        "Registration mark",
      );
      setNotice(`Registration mark loaded: ${shape.filename}`);
    } catch (error) {
      if (request !== registrationLoadRef.current) return;
      setNotice(
        error instanceof Error ? error.message : "That registration SVG could not be imported.",
      );
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    // Canvas drop keeps the single-artwork convention: replace the primary.
    if (file) void loadFile(file, { mode: "replace", targetLayerId: primaryLayerId });
  }

  /* ----- export: the REAL pipeline (preflight -> orchestrator -> deliver).
   * Every UI export builds an ExportTarget from the CURRENT core, freezes
   * the session revision into the job, preflights via evaluate() with
   * probed capabilities, and runs startExport over the routed render
   * service (legacyEngineEligible is the ONLY parity gate). ----- */

  const [assetInfos, setAssetInfos] = useState<ReadonlyMap<string, AssetInfo>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void loadAssetInfos(core, controller.assets).then((infos) => {
      if (!cancelled) setAssetInfos(infos);
    });
    return () => {
      cancelled = true;
    };
  }, [core, controller]);
  /* Record-backed asset dimensions for the render planner: the SAME
   * AssetRecordV1 width/height preflight consumes — never the sync image
   * cache, which is null on a cold cache and retains HTMLImageElements. */
  const assetInfosRef = useRef(assetInfos);
  assetInfosRef.current = assetInfos;
  const recordAssetDimensions = useCallback((assetId: string) => {
    const info = assetInfosRef.current.get(assetId);
    return info && info.ok && info.kind === "raster"
      ? { width: info.width, height: info.height, byteLength: info.byteLength }
      : null;
  }, []);

  const exportRenderRef = useRef<RenderService | null>(null);
  const getExportRenderService = useCallback((): RenderService => {
    if (!exportRenderRef.current) {
      exportRenderRef.current = createStudioRenderService(
        cache,
        probeEnvironmentCapabilities(),
        recordAssetDimensions,
      );
    }
    return exportRenderRef.current;
  }, [cache, recordAssetDimensions]);

  /* Warning confirmations bind to the exact warn set + revision. */
  const warningGateRef = useRef(createWarningGate());

  /* Export workflow state (target/progress/cancel/warnings) is SESSION
   * state: the shell unmounts the Export panel on tool switches / Focus
   * Mode, and a re-mounted panel must bind back into a live run. One store
   * per open studio; duplicate starts are rejected inside the store. */
  const exportSessionRef = useRef<ExportSessionStore | null>(null);
  if (exportSessionRef.current === null) {
    exportSessionRef.current = createExportSessionStore();
  }
  const exportSession = exportSessionRef.current;

  /* Legacy naming base: artifacts and job-settings.source derive from the
   * ARTWORK SOURCE name (primary layer), never the project title —
   * renaming a project must not change press artifact names. Empty name →
   * exportBaseName's documented "untitled" fallback. */
  const exportSourceName = primaryLayer?.name ?? "";

  const exportPipeline: ExportPipeline = {
    evaluate: (target: ExportTarget) =>
      preflightForTarget(
        store.getEnvelope().core,
        (assetId) => assetInfos.get(assetId) ?? null,
        target,
        store.getState().revision,
        probeEnvironmentCapabilities(),
      ),
    vectorEligibility: () => vectorPlateEligibility(core),
    selectedLayerId: primaryLayerId,
    unconfirmedWarnings: (issues) => warningGateRef.current.unconfirmed(issues),
    confirmWarnings: (issues) => warningGateRef.current.confirm(issues),
    start: (target, hooks) => {
      const envelope = store.getEnvelope();
      setExporting(true);
      const pickerHost = globalThis as {
        showSaveFilePicker?: NonNullable<
          Parameters<typeof deliverStudioExport>[1]["showSaveFilePicker"]
        >;
      };
      // A SYNCHRONOUS startStudioExport throw must reset the shell's
      // exporting flag (the session store rolls back separately) — the
      // TopBar loader can never wedge on a construction failure.
      let run: ReturnType<typeof startStudioExport>;
      try {
        run = buildStudioExportRun();
      } catch (error) {
        setExporting(false);
        setNotice(error instanceof Error ? error.message : "Export failed");
        throw error;
      }
      function buildStudioExportRun() {
        return startStudioExport({
        core: envelope.core,
        revision: store.getState().revision,
        sourceName: exportSourceName,
        target,
        render: getExportRenderService(),
        encoders: BROWSER_EXPORT_ENCODERS,
        // Plate-package job-settings.json echoes customShape/registrationShape
        // through this resolver, in the legacy RENDER form (permissive
        // sanitize: 1024² root + preserveAspectRatio="none" stretch) — the
        // form parseSettings/prepareCustomShape reproduce plates from. The
        // STORED asset stays strict-canonical; this is a presentation
        // projection only.
        resolveCustomShape: async (id) => {
          const shape = await ensureLive(
            cacheRef,
            () => new AssetCache(controller.assets),
          ).customShapeWhenReady(id);
          const { sanitizeSvg } = await import("./custom-shape-data");
          return { filename: shape.filename, svg: sanitizeSvg(shape.svg) };
        },
        // Custom registration marks paint AFTER polarity (final content
        // pass) through the same main-thread painter the render path uses.
        prepareCustomRegistration: (registrationState, width, height, signal) =>
          createRegistrationPainter(
            ensureLive(cacheRef, () => new AssetCache(controller.assets)),
          ).prepareRows(registrationState, width, height, signal),
        paintCustomRegistration: (raster, registrationState) =>
          createRegistrationPainter(
            ensureLive(cacheRef, () => new AssetCache(controller.assets)),
          ).paintRaster(raster, registrationState),
        deliver: (files) =>
          deliverStudioExport(files, {
            saveBlob: downloadExportBlob,
            ...(pickerHost.showSaveFilePicker
              ? { showSaveFilePicker: pickerHost.showSaveFilePicker.bind(globalThis) }
              : {}),
          }),
        onProgress: (progress) => hooks.onProgress?.(progress.fraction),
        });
      }
      const done = run.done
        .then((files) => {
          setNotice(`Exported ${files.map((file) => file.name).join(", ")}`);
          return "done" as const;
        })
        .catch((error: unknown) => {
          if (error instanceof ExportCancelledError) {
            setNotice("Export cancelled");
            return "cancelled" as const;
          }
          setNotice(error instanceof Error ? error.message : "Export failed");
          return "error" as const;
        })
        .finally(() => setExporting(false));
      return { cancel: run.cancel, done };
    },
  };

  /* ----- project flows: new / home / save / rename / conflict ----- */

  const runGuardedAction = useCallback(
    async (action: GuardedAction) => {
      if (action === "new") {
        const id = await controller.createProject();
        navigate(`/?project=${encodeURIComponent(id)}`);
      } else {
        await controller.closeProject();
        navigate("/home");
      }
    },
    [controller, navigate],
  );

  const requestGuardedAction = useCallback(
    (action: GuardedAction) => {
      if (!controller.isOpenProjectDirty()) {
        void runGuardedAction(action);
        return;
      }
      captureDialogInvoker();
      setDirtyGuard(action);
    },
    [controller, runGuardedAction, captureDialogInvoker],
  );

  function onDirtyGuardChoice(choice: DirtyGuardChoice) {
    const action = dirtyGuard;
    setDirtyGuard(null);
    if (!action) return;
    if (choice === "cancel") {
      restoreDialogInvoker();
      return;
    }
    if (choice === "discard") {
      void controller.discardOpenProjectChanges().then(() => runGuardedAction(action));
      return;
    }
    if (controller.savePlan() === "dialog") {
      setSaveDialog({ continueWith: action });
      return;
    }
    void controller
      .performSave()
      .then(() => runGuardedAction(action))
      .catch((error) => {
        if (error instanceof ConflictError) setConflictOpen(true);
      });
  }

  const requestSave = useCallback(() => {
    if (open.readOnly) {
      notifyReadOnly();
      return;
    }
    if (controller.savePlan() === "dialog") {
      captureDialogInvoker();
      setSaveDialog({ continueWith: null });
      return;
    }
    void controller.performSave().catch((error) => {
      if (error instanceof ConflictError) setConflictOpen(true);
    });
  }, [controller, open.readOnly, notifyReadOnly, captureDialogInvoker]);

  async function onSaveDialogSubmit(name: string) {
    const continueWith = saveDialog?.continueWith ?? null;
    try {
      await controller.performSave(name);
      setSaveDialog(null);
      setNotice("Project saved");
      if (continueWith) await runGuardedAction(continueWith);
      else restoreDialogInvoker();
    } catch (error) {
      setSaveDialog(null);
      if (error instanceof ConflictError) setConflictOpen(true);
      else setNotice(error instanceof Error ? error.message : "The project could not be saved.");
    }
  }

  /* ----- snapshots ----- */

  /**
   * SNAPSHOT ATOMICITY — phase 1, synchronous: copy the proof canvas pixels
   * into an offscreen thumbnail canvas AT CLICK TIME, before any await, so
   * the captured pixels and the synchronously frozen core are one
   * representation. (The thumbnail is rendered from the live canvas, so the
   * canvas — not a re-render of the core — is the source of truth; pairing
   * both captures in the same synchronous frame is what keeps them split-
   * proof against mid-await edits.)
   */
  const captureThumbnailCanvas = useCallback((): HTMLCanvasElement | null => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return null;
    try {
      const thumb = document.createElement("canvas");
      const scale = Math.min(1, 240 / Math.max(canvas.width, canvas.height));
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      thumb.getContext("2d")?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      return thumb;
    } catch {
      return null;
    }
  }, []);

  /** Phase 2, asynchronous: encode + persist the frozen thumbnail pixels. */
  const persistThumbnail = useCallback(
    async (thumb: HTMLCanvasElement | null): Promise<string | null> => {
      if (!thumb) return null;
      try {
        const blob = await new Promise<Blob | null>((resolve) =>
          thumb.toBlob(resolve, "image/png"),
        );
        if (!blob) return null;
        const record = await controller.assets.putBlob(blob, "thumbnail", "image/png", {
          width: thumb.width,
          height: thumb.height,
        });
        return record.sha256;
      } catch {
        return null;
      }
    },
    [controller],
  );

  /* ----- presets (device-global) ----- */

  const [presets, setPresets] = useState<RecipePresetV1[]>([]);
  const refreshPresets = useCallback(async () => {
    try {
      setPresets(await controller.presets.list());
    } catch {
      /* preset list is non-critical */
    }
  }, [controller]);
  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  /* ----- ProjectUi (TopBar + panels contract) ----- */

  // Same rule as controller.isOpenProjectDirty, derived reactively: edits
  // past the last save, or content living outside the saved library.
  const dirty =
    !open.readOnly && (projectState.dirty || !open.persisted || open.casToken === 0);

  const projectUi: ProjectUi = {
    projectId: open.projectId,
    title: open.title,
    dirty,
    readOnly: open.readOnly,
    recovered: open.recovered,
    recoveryState: snapshot.recoveryState,
    storageAlert: snapshot.storageAlert,
    dismissStorageAlert: () => controller.clearStorageAlert(),

    core,
    layers,
    selectedLayerIds,
    primaryLayerId,
    selectLayer: (layerId, options) => {
      setSelection((current) => {
        if (!options?.additive) return [layerId];
        return current.includes(layerId)
          ? current.filter((id) => id !== layerId)
          : [...current, layerId];
      });
    },

    canUndo: projectState.canUndo,
    canRedo: projectState.canRedo,
    undoDepth: doc.undoDepth,
    redoDepth: doc.redoDepth,
    undoLabels: doc.getUndoLabels(),
    undo: () => {
      if (open.readOnly) notifyReadOnly();
      else doc.undo();
    },
    redo: () => {
      if (open.readOnly) notifyReadOnly();
      else doc.redo();
    },

    requestNewProject: () => requestGuardedAction("new"),
    requestHome: () => requestGuardedAction("home"),
    requestSave,
    requestRename: () => {
      captureDialogInvoker();
      setRenameOpen(true);
    },

    requestOwnership: () => controller.requestOwnership(),
    duplicateReadonly: () => {
      void controller.duplicateAsUnsaved().then((id) => {
        navigate(`/?project=${encodeURIComponent(id)}`);
      });
    },

    saveRecovered: requestSave,
    revertToLastSave: () => void controller.revertToLastSave(),

    addLayerFromFile: requestArtworkAdd,
    duplicateLayer: (layerId) => {
      if (layers.length >= RESOURCE_POLICY.maxLayers) {
        setNotice(`Projects hold at most ${RESOURCE_POLICY.maxLayers} layers.`);
        return;
      }
      const newLayerId = createId();
      if (apply({ type: "layer/duplicate", layerId, newLayerId }, "Duplicate layer")) {
        setSelection([newLayerId]);
      }
    },
    removeLayer: (layerId) => {
      apply({ type: "layer/remove", layerId }, "Delete layer");
    },
    moveLayer: (layerId, direction) => {
      const index = layers.findIndex((layer) => layer.id === layerId);
      if (index < 0) return;
      const toIndex = direction === "up" ? index + 1 : index - 1;
      if (toIndex < 0 || toIndex >= layers.length) return;
      apply({ type: "layer/reorder", layerId, toIndex }, "Reorder layer");
    },
    renameLayer: (layerId, name) => {
      if (name.trim()) apply({ type: "layer/rename", layerId, name: name.trim() }, "Rename layer");
    },
    setLayerVisible: (layerId, visible) =>
      void apply({ type: "layer/set-visibility", layerId, visible }, "Layer visibility"),
    setLayerLocked: (layerId, locked) =>
      void apply({ type: "layer/set-locked", layerId, locked }, "Layer lock"),
    setLayerOpacity: (layerId, opacity) =>
      void apply({ type: "layer/set-opacity", layerId, opacity }, "Layer opacity"),
    setLayerMode: (layerId, mode) =>
      void apply({ type: "layer/set-mode", layerId, mode }, "Layer mode"),
    setLayerPosition: (layerId, axis, value) => {
      const layer = layers.find((candidate) => candidate.id === layerId);
      if (!layer) return;
      apply(
        {
          type: "layer/set-transform",
          layerId,
          // Compose: a stored perspective quad travels with the move.
          patch: composeTransformPatch(layer.transform, {
            position: { ...layer.transform.position, [axis]: value },
          }),
        },
        "Move layer",
      );
    },

    applyRecipeToSelected: () => {
      if (!primaryLayer) return;
      const recipe = primaryLayer.recipe;
      const commands: Command[] = [];
      for (const id of selectedLayerIds) {
        if (id === primaryLayer.id) continue;
        const target = layers.find((candidate) => candidate.id === id);
        if (!target || target.locked) continue;
        commands.push({
          type: "recipe/apply-preset",
          layerId: id,
          mode: recipe.mode,
          halftone: {
            ...recipe.halftone,
            // Custom-dot assets are content-addressed and shared safely.
          },
          diffusion: { ...recipe.diffusion },
          glitch: { ...recipe.glitch },
        });
      }
      if (commands.length === 0) {
        setNotice("Select additional unlocked layers to receive the recipe.");
        return;
      }
      if (apply(commands, "Apply recipe to selected")) {
        setNotice(
          `Recipe applied to ${commands.length} ${commands.length === 1 ? "layer" : "layers"}`,
        );
      }
    },

    updateGrid: (patch) => void apply({ type: "grid/update", patch }, "Grid"),
    updateSnapping: (patch) => void apply({ type: "snapping/update", patch }, "Snapping"),
    setGuidesVisible: (visible) =>
      void apply({ type: "guides/set-visible", visible }, "Guides"),
    setGuidesLocked: (locked) =>
      void apply({ type: "guides/set-locked", locked }, "Lock guides"),
    clearGuides: () => void apply({ type: "guides/clear" }, "Clear guides"),

    /* Editor surface */
    applyCommands: (commands, label) => apply(commands, label),
    editorMode,
    setEditorMode,
    rulersVisible,
    setRulersVisible,
    assetSizeFor,
    resizeArtboard: (widthPx, heightPx) =>
      void apply(
        { type: "artboard/resize", widthPx, heightPx, presetId: "custom" },
        "Artboard size",
      ),

    snapshots: projectState.envelope.snapshots,
    snapshotCap: RESOURCE_POLICY.maxSnapshots,
    createSnapshot: async (name) => {
      if (open.readOnly) {
        notifyReadOnly();
        return false;
      }
      // ATOMIC pair: freeze the core AND capture the canvas in the same
      // synchronous frame — before ANY await — then persist the thumbnail
      // and store the snapshot FROM the frozen core. An edit landing while
      // the thumbnail blob persists can no longer split the checkpoint
      // (thumbnail at N, core at N+1); both always represent click time.
      const frozenCore = store.getEnvelope().core;
      const thumbCanvas = captureThumbnailCanvas();
      const thumbnailId = await persistThumbnail(thumbCanvas);
      const created = doc.addSnapshot(name, thumbnailId, frozenCore);
      if (!created) {
        setNotice(`Snapshot limit reached (${RESOURCE_POLICY.maxSnapshots}). Delete one first.`);
        return false;
      }
      setNotice(`Snapshot “${name}” created`);
      return true;
    },
    restoreSnapshot: (snapshotId) => {
      if (doc.restoreSnapshot(snapshotId)) setNotice("Snapshot restored — undo to return");
    },
    deleteSnapshot: (snapshotId) => void doc.deleteSnapshot(snapshotId),
    duplicateSnapshotToProject: (snapshotId) => {
      const envelope = store.duplicateSnapshotToProject(snapshotId);
      if (!envelope) return;
      controller.registerUnsavedProject(envelope);
      navigate(`/?project=${encodeURIComponent(envelope.id)}`);
    },

    presets,
    savePreset: async (name) => {
      if (!primaryLayer) return false;
      const customDotSvg =
        primaryLayer.recipe.halftone.dotShape === "custom" && customShape
          ? customShape.svg
          : null;
      await controller.presets.save(createPresetFromLayer(primaryLayer, name, customDotSvg));
      await refreshPresets();
      setNotice(`Preset “${name}” saved`);
      return true;
    },
    applyPreset: (presetId) => {
      const preset = presets.find((candidate) => candidate.id === presetId);
      if (!preset || !primaryLayerId) return;
      void (async () => {
        let customShapeAssetId: string | null | undefined;
        if (preset.customDotSvg) {
          const bytes = new TextEncoder().encode(preset.customDotSvg);
          const record = await controller.assets.putBlob(
            bytes,
            "svg",
            "image/svg+xml",
            svgDimensions(preset.customDotSvg),
          );
          cache.primeCustomShape(record.sha256, {
            filename: `${preset.name}.svg`,
            svg: preset.customDotSvg,
          });
          customShapeAssetId = record.sha256;
        }
        apply(applyPresetCommand(preset, primaryLayerId, customShapeAssetId), "Apply preset");
      })();
    },
    deletePreset: (presetId) => {
      void controller.presets.delete(presetId).then(refreshPresets);
    },
    exportPreset: (presetId) => {
      const preset = presets.find((candidate) => candidate.id === presetId);
      if (!preset) return;
      downloadBlob(
        new Blob([serializePresetJson(preset)], { type: "application/json" }),
        `${cleanName(preset.name) || "preset"}.drpreset`,
      );
    },
    importPresetFile: async (file) => {
      const result = parsePreset(await file.text());
      if (!result.ok) {
        setNotice(`Preset rejected: ${result.error}`);
        return false;
      }
      await controller.presets.save(result.preset);
      await refreshPresets();
      setNotice(`Preset “${result.preset.name}” imported`);
      return true;
    },
  };

  /* ----- legacy StudioApi (panels/drawers contract, unchanged shape) ----- */

  const activeInk = activePlate === "composite" ? COMPOSITE_INK : CHROME_INK[activePlate];

  const api: StudioApi = {
    source,
    sourceName,
    sourceMeta,
    requestArtworkFile: requestArtworkReplace,
    resetArtwork,
    settings,
    updateSetting,
    setAngles,
    resetHalftone: resetHalftoneCmyk,
    resetDiffusion,
    resetGlitch,
    resetOutput,
    openCustomShapeDialog: () => setCustomShapeOpen(true),
    activePlate,
    applicablePlates,
    enabledPlates,
    hiddenPlates,
    soloPlate: handleSolo,
    togglePlateVisible: handleToggleVisible,
    setPlateAngle: handleAngleChange,
    documentSettings,
    updateDocument,
    fitArtworkToSheet,
    outputDimensions,
    unitDisplay: core.unitPreference as UnitDisplay,
    setUnitDisplay: (unit) => void apply({ type: "unit/set", unitPreference: unit }, "Units"),
    zoom,
    setZoom,
    zoomBounds: ZOOM_BOUNDS,
    output: core.output,
    updateOutput: (patch) => void apply({ type: "output/update", patch }, "Output"),
    proofRegistration,
    setProofRegistration: setProofOverlayOverride,
    registration,
    setRegistrationEnabled: (enabled) =>
      void apply(
        { type: "output/update", patch: { registrationOnPlates: enabled } },
        "Registration",
      ),
    registrationMode,
    setRegistrationMode: (mode) =>
      void apply({ type: "registration/update", patch: { mode } }, "Registration"),
    registrationSize,
    setRegistrationSize: (value) =>
      void apply({ type: "registration/update", patch: { size: value } }, "Registration"),
    registrationOffset,
    setRegistrationOffset: (value) =>
      void apply({ type: "registration/update", patch: { offset: value } }, "Registration"),
    registrationWeight,
    setRegistrationWeight: (value) =>
      void apply({ type: "registration/update", patch: { weight: value } }, "Registration"),
    registrationShape,
    requestRegistrationFile: () => registrationFileRef.current?.click(),
    setCompositeRegistration: (enabled) =>
      void apply(
        { type: "output/update", patch: { registrationOnComposite: enabled } },
        "Registration",
      ),
    preflight: {
      reviewCount: preflightReviewCount,
      hiddenPlates,
      sharedAngleGroups,
      registrationOff: !registration,
      polarityInverted,
      dense: screenLoadIsDense,
      screenLoad,
      diffusionPixelLoad,
      diffusionMemoryMiB: Math.ceil(diffusionMemoryBytes / 1024 / 1024),
    },
    copyJobTicket: () => void copyJobTicket(),
    exportPipeline,
    exportSession,
    exporting,
    notify: setNotice,
  };

  const canvasStage = (
    <div
      className={[
        "canvas-stage",
        dragging ? "dragging" : "",
        spaceHeld ? "pan-armed" : "",
        panning ? "panning" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="ws-canvas"
      data-pan-armed={spaceHeld ? "true" : "false"}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
      onPointerDown={(event) => {
        if (!spaceHeld || event.button !== 0) return;
        event.preventDefault();
        panStart.current = {
          x: event.clientX,
          y: event.clientY,
          panX: pan.x,
          panY: pan.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPanning(true);
      }}
      onPointerMove={(event) => {
        const start = panStart.current;
        if (!start) return;
        setPan({
          x: start.panX + event.clientX - start.x,
          y: start.panY + event.clientY - start.y,
        });
      }}
      onPointerUp={(event) => {
        if (!panStart.current) return;
        panStart.current = null;
        setPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        panStart.current = null;
        setPanning(false);
      }}
    >
      {open.recovered && (
        <div className="ws-recovery-banner" data-testid="ws-recovery-banner" role="status">
          <strong>Recovered unsaved changes.</strong>
          <span>
            This project was restored from its recovery journal and is marked unsaved.
          </span>
          <button type="button" onClick={projectUi.saveRecovered}>
            Save
          </button>
          <button type="button" onClick={projectUi.revertToLastSave}>
            Revert to Last Save
          </button>
        </div>
      )}

      <div className="stage-toolbar">
        <div className="view-status">
          <Sparkles size={14} />
          <span>Live browser preview · Space-drag pans</span>
        </div>
        <div className="proof-contract" aria-label="Current proof state">
          {/* Truthful mode label: CLEAN prints continuous tone, unscreened. */}
          <span data-testid="proof-mode-label">
            {primaryLayer?.recipe.mode === "clean"
              ? "Clean"
              : settings.diffusionEnabled
                ? "Diffusion"
                : "Halftone"}
          </span>
          <span>{settings.grayscale ? "K" : "CMYK"}</span>
          <span>{activePlate === "composite" ? "Composite" : PLATE_META[activePlate].short}</span>
        </div>
      </div>

      <div className="stage-body">
        <EditingSurface
          canvasRef={canvasRef}
          viewKey={`${zoom}:${pan.x}:${pan.y}:${core.artboard.widthPx}x${core.artboard.heightPx}`}
        >
        <div className="canvas-scroll">
          <div
            className="artboard-wrap"
            data-testid="ws-artboard"
            data-background={core.artboard.background}
            style={{
              width: `${zoom}%`,
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
            }}
            onDoubleClick={() => setZoom(ZOOM_BOUNDS.fit)}
          >
            <canvas
              ref={canvasRef}
              data-testid="artwork-canvas"
              aria-label={settings.grayscale ? "Live grayscale halftone preview" : "Live CMYK halftone preview"}
            />
            <ArtboardOverlays canvasRef={canvasRef} panArmed={spaceHeld || panning} />
            <span className="artboard-label" data-testid="artboard-label">
              {activePlate === "composite"
                ? hiddenPlates.length === 0
                  ? settings.grayscale ? "Grayscale proof (K)" : "Composite proof"
                  : hiddenPlates.length === applicablePlates.length
                    ? "Composite proof — all plates hidden"
                    : `Composite proof — ${hiddenPlates
                        .map((plate) => PLATE_META[plate].short)
                        .join(", ")} hidden`
                : settings.visible[activePlate]
                  ? `${PLATE_META[activePlate].label} plate`
                  : `${PLATE_META[activePlate].label} plate — hidden`}
            </span>
          </div>
        </div>
        </EditingSurface>
      </div>

      <div className="stage-footer">
        <div className="quality-note">
          <span className="status-dot" />
          Preview uses your device. Nothing is uploaded.
        </div>
        <div className="zoom-controls">
          <button
            className="icon-button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => setZoom((value) => Math.max(ZOOM_BOUNDS.min, value - 8))}
          >
            <ZoomOut size={17} />
          </button>
          {/* The numeric zoom field lives in the Proof drawer (selector
              contract); the footer keeps the quick slider and buttons. */}
          <input
            type="range"
            data-testid="zoom-slider"
            min={ZOOM_BOUNDS.min}
            max={ZOOM_BOUNDS.max}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label="Preview zoom"
            aria-valuetext={`${zoom} percent`}
            /* Shares the Proof drawer numeric-zoom field's unit + hint as its
               description (selector contract: type-first zoom, slider for
               drag adjustment). */
            aria-describedby="numeric-zoom-unit numeric-zoom-hint"
          />
          <button
            className="icon-button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => setZoom((value) => Math.min(ZOOM_BOUNDS.max, value + 8))}
          >
            <ZoomIn size={17} />
          </button>
        </div>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <Upload size={30} />
          <strong>Drop artwork to begin</strong>
          <span>PNG, JPG, or WebP</span>
        </div>
      )}
    </div>
  );

  return (
    <main
      className="studio-shell"
      data-studio-root
      style={{ "--ink-active": activeInk } as CSSProperties}
    >
      <StudioApiContext.Provider value={api}>
        <ProjectUiContext.Provider value={projectUi}>
          <WorkspaceShell canvas={canvasStage} />

          {dirtyGuard !== null && (
            <DirtyWorkDialog
              open
              projectTitle={open.title}
              actionLabel={dirtyGuard === "new" ? "start a new project" : "leave for Home"}
              onChoice={onDirtyGuardChoice}
            />
          )}

          {saveDialog !== null && (
            <TextPromptDialog
              title="Save Project"
              fieldLabel="Project name"
              submitLabel="Save"
              initialValue={open.title === "Untitled" ? "" : open.title}
              description={
                <p>Projects stay on this device. Your account never syncs files.</p>
              }
              onSubmit={(name) => void onSaveDialogSubmit(name)}
              onCancel={() => {
                setSaveDialog(null);
                restoreDialogInvoker();
              }}
            />
          )}

          {renameOpen && (
            <TextPromptDialog
              title="Rename Project"
              fieldLabel="Project name"
              submitLabel="Rename"
              initialValue={open.title}
              onSubmit={(name) => {
                setRenameOpen(false);
                void controller.renameOpenProject(name);
                restoreDialogInvoker();
              }}
              onCancel={() => {
                setRenameOpen(false);
                restoreDialogInvoker();
              }}
            />
          )}

          {conflictOpen && (
            <ChoiceDialog
              title="Save Conflict"
              description={
                <p>
                  Another tab saved a newer revision of this project. Reload to
                  take that version (dropping this tab’s changes), or duplicate
                  your current work as a new project.
                </p>
              }
              choices={[
                {
                  label: "Reload",
                  onChoose: () => {
                    setConflictOpen(false);
                    void controller.revertToLastSave();
                  },
                },
                {
                  label: "Duplicate",
                  onChoose: () => {
                    setConflictOpen(false);
                    projectUi.duplicateReadonly();
                  },
                },
              ]}
              onCancel={() => setConflictOpen(false)}
            />
          )}
        </ProjectUiContext.Provider>
      </StudioApiContext.Provider>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        hidden
        onChange={onFileChange}
      />
      <input
        ref={registrationFileRef}
        type="file"
        accept=".svg,image/svg+xml"
        hidden
        onChange={(event) => void onRegistrationFileChange(event)}
      />

      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {snapshot.storageAlert && (
        <div className="toast is-alert" role="alert">
          {snapshot.storageAlert}
          <button onClick={() => controller.clearStorageAlert()} aria-label="Dismiss storage alert">
            <X size={14} />
          </button>
        </div>
      )}

      {customShapeOpen && (
        <CustomShapeDialog
          current={settings.customShape}
          onCancel={() => setCustomShapeOpen(false)}
          onApply={(shape) => {
            setCustomShapeOpen(false);
            void applyCustomShape(shape);
          }}
        />
      )}
    </main>
  );

  async function applyCustomShape(shape: CustomShapeAsset) {
    if (!primaryLayerId) {
      setNotice("Import artwork before assigning a custom dot shape.");
      return;
    }
    try {
      const bytes = new TextEncoder().encode(shape.svg);
      const record = await controller.assets.putBlob(
        bytes,
        "svg",
        "image/svg+xml",
        svgDimensions(shape.svg),
      );
      cache.primeCustomShape(record.sha256, shape);
      apply(
        {
          type: "recipe/update-halftone",
          layerId: primaryLayerId,
          patch: { dotShape: "custom", customShapeAssetId: record.sha256 },
        },
        "Custom dot shape",
      );
      setNotice(`Custom shape loaded: ${shape.filename}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The custom SVG could not be stored.");
    }
  }
}

function serializePresetJson(preset: RecipePresetV1): string {
  return JSON.stringify(preset, null, 2);
}

function cleanName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
