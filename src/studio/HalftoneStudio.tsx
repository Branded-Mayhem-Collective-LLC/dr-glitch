"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Download,
  FileImage,
  FolderOpen,
  HelpCircle,
  ImagePlus,
  Layers3,
  MonitorUp,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Sparkles,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import JSZip from "jszip";
import SessionBadge from "../auth/SessionBadge";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import ProcessLoader from "../components/ProcessLoader";
import InkRail from "./InkRail";
import { CHROME_INK, COMPOSITE_INK } from "./inks";
import NumericField from "./NumericField";
import StageSpine, { type Stage } from "./StageSpine";
import { isInteractiveTarget, useStudioKeys } from "./useStudioKeys";
import {
  MAX_EXPORT_GRID_POINTS,
  createDemoArtwork,
  estimateGridPoints,
  HalftoneSettings,
  PLATE_META,
  PLATES,
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
  type SheetSizeId,
} from "./document-model";
import { withPngDpi } from "./png-dpi";
import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const DEFAULT_SETTINGS: HalftoneSettings = {
  cellSize: 12,
  contrast: 1,
  exposure: 0,
  opacity: 0.84,
  dotShape: "round",
  invert: false,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
};

const STAGE_DEFINITIONS = [
  {
    id: "artwork",
    number: "01",
    label: "Artwork",
    description: "Confirm the source file before building the screen.",
  },
  {
    id: "screen",
    number: "02",
    label: "Screen",
    description: "Set the dot geometry and tonal response.",
  },
  {
    id: "separation",
    number: "03",
    label: "Separation",
    description: "Check each process plate and its screen angle.",
  },
  {
    id: "output",
    number: "04",
    label: "Output",
    description: "Finish the plate package and press handoff.",
  },
] as const;

type StudioStageId = (typeof STAGE_DEFINITIONS)[number]["id"];

export default function HalftoneStudio() {
  const [source, setSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(
    null,
  );
  const [sourceName, setSourceName] = useState(`${PRODUCT_NAME} sample artwork`);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(
    () => ({ ...DEFAULT_DOCUMENT_SETTINGS }),
  );
  const [activePlate, setActivePlate] = useState<Plate>("composite");
  const [zoom, setZoom] = useState(76);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [placingArtwork, setPlacingArtwork] = useState(false);
  const [activeStage, setActiveStage] = useState<StudioStageId>("artwork");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [registration, setRegistration] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const renderFrame = useRef<number | null>(null);
  const panStart = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const artworkPlacementStart = useRef<{
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    pixelsPerScreenX: number;
    pixelsPerScreenY: number;
  } | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSource(createDemoArtwork()), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const render = useCallback(() => {
    if (!source || !canvasRef.current) return;
    const sheet = getSheetPixelDimensions(
      documentSettings.sheetSize,
      documentSettings.orientation,
    );
    const maxDimension = 980;
    const scale = Math.min(1, maxDimension / Math.max(sheet.width, sheet.height));
    renderHalftone(source, canvasRef.current, settings, {
      plate: activePlate,
      width: sheet.width * scale,
      height: sheet.height * scale,
      paper: "#F4F1E9",
      registration,
      monochromePlate: true,
      document: documentSettings,
      preview: true,
    });
  }, [activePlate, documentSettings, registration, settings, source]);

  useEffect(() => {
    if (renderFrame.current) cancelAnimationFrame(renderFrame.current);
    renderFrame.current = requestAnimationFrame(render);
    return () => {
      if (renderFrame.current) cancelAnimationFrame(renderFrame.current);
    };
  }, [render]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const sourceMeta = useMemo(() => {
    if (!source) return "No image";
    const width =
      source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height =
      source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    return `${width} × ${height}px · RGB`;
  }, [source]);

  const updateSetting = <K extends keyof HalftoneSettings>(
    key: K,
    value: HalftoneSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  const handleSolo = useCallback((plate: Plate) => {
    setActivePlate(plate);
  }, []);

  const handleCellSizeDelta = useCallback((delta: number) => {
    setSettings((current) => ({
      ...current,
      cellSize: Math.min(64, Math.max(3, current.cellSize + delta)),
    }));
  }, []);

  useStudioKeys({
    onSolo: handleSolo,
    onCellSizeDelta: handleCellSizeDelta,
  });

  useEffect(() => {
    function down(event: KeyboardEvent) {
      if (event.code !== "Space" || event.repeat) return;
      if (isInteractiveTarget(event.target)) return;
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
      setPlacingArtwork(false);
      panStart.current = null;
      artworkPlacementStart.current = null;
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

  const handleToggleVisible = useCallback(
    (plate: Exclude<Plate, "composite">) => {
      setSettings((current) => ({
        ...current,
        visible: { ...current.visible, [plate]: !current.visible[plate] },
      }));
    },
    [],
  );

  const handleAngleChange = useCallback(
    (plate: Exclude<Plate, "composite">, angle: number) => {
      setSettings((current) => ({
        ...current,
        angles: { ...current.angles, [plate]: angle },
      }));
    },
    [],
  );

  // §1: "a print tool that misleads the eye about ink is broken." renderHalftone
  // blanks any plate (including every plate inside a composite render) whose
  // settings.visible flag is off, so the proof can go blank while its label
  // still claims to show something. hiddenPlates drives the same label logic
  // for both the single-plate case (already handled below) and composite.
  const hiddenPlates = useMemo(
    () => PLATES.filter((plate) => !settings.visible[plate]),
    [settings.visible],
  );
  const sharedAngleGroups = useMemo(() => {
    const grouped = new Map<number, Array<(typeof PLATES)[number]>>();
    for (const plate of PLATES) {
      const angle = ((settings.angles[plate] % 360) + 360) % 360;
      grouped.set(angle, [...(grouped.get(angle) ?? []), plate]);
    }
    return [...grouped.entries()].filter(([, plates]) => plates.length > 1);
  }, [settings.angles]);
  const outputDimensions = getSheetPixelDimensions(
    documentSettings.sheetSize,
    documentSettings.orientation,
  );
  const screenLoad = PLATES.filter((plate) => settings.visible[plate]).reduce<{
    marks: number;
    plate: (typeof PLATES)[number] | null;
  }>(
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
  const screenLoadIsDense = screenLoad.marks > MAX_EXPORT_GRID_POINTS;
  const preflightReviewCount =
    (hiddenPlates.length > 0 ? 1 : 0) +
    (sharedAngleGroups.length > 0 ? 1 : 0) +
    (!registration ? 1 : 0) +
    (settings.invert ? 1 : 0) +
    (screenLoadIsDense ? 1 : 0);

  function resetScreen() {
    setSettings((current) => ({
      ...current,
      cellSize: DEFAULT_SETTINGS.cellSize,
      contrast: DEFAULT_SETTINGS.contrast,
      exposure: DEFAULT_SETTINGS.exposure,
      dotShape: DEFAULT_SETTINGS.dotShape,
    }));
    setNotice("Screen controls reset");
  }

  function resetArtwork() {
    setDocumentSettings({ ...DEFAULT_DOCUMENT_SETTINGS });
    setNotice("Artwork controls reset");
  }

  function resetSeparation() {
    setSettings((current) => ({
      ...current,
      angles: { ...DEFAULT_SETTINGS.angles },
      visible: { ...DEFAULT_SETTINGS.visible },
    }));
    setActivePlate("composite");
    setNotice("Plate angles and visibility reset");
  }

  function resetOutput() {
    setSettings((current) => ({
      ...current,
      opacity: DEFAULT_SETTINGS.opacity,
      invert: DEFAULT_SETTINGS.invert,
    }));
    setRegistration(true);
    setNotice("Output controls reset");
  }

  function jobTicketText() {
    const visible = PLATES.filter((plate) => settings.visible[plate])
      .map((plate) => PLATE_META[plate].short)
      .join(", ");
    const sheet = SHEET_SIZES.find(
      ({ id }) => id === documentSettings.sheetSize,
    );
    return [
      `${PRODUCT_NAME} JOB TICKET`,
      `Artwork: ${sourceName}`,
      `Source: ${sourceMeta}`,
      `Sheet: ${sheet?.label ?? documentSettings.sheetSize}`,
      `Orientation: ${titleCase(documentSettings.orientation)}`,
      `Output dimensions: ${outputDimensions.width} × ${outputDimensions.height}px`,
      `Resolution: ${DOCUMENT_DPI} DPI`,
      `Scale: ${documentSettings.scalePercent}%`,
      `Offset: X ${documentSettings.offsetX}px · Y ${documentSettings.offsetY}px`,
      `Mirror: ${
        documentSettings.mirrorImage
          ? titleCase(documentSettings.mirrorDirection)
          : "Off"
      }`,
      `Dot: ${settings.dotShape}`,
      `Cell size: ${settings.cellSize}px`,
      `Contrast: ${settings.contrast}×`,
      `Exposure: ${Math.round(settings.exposure * 100)}%`,
      `Angles: ${PLATES.map(
        (plate) => `${PLATE_META[plate].short} ${settings.angles[plate]}°`,
      ).join(" · ")}`,
      `Enabled plates: ${visible || "None"}`,
      `Registration marks: ${registration ? "Included" : "Off"}`,
      `Invert dots: ${settings.invert ? "On" : "Off"}`,
      `Ink density: ${Math.round(settings.opacity * 100)}%`,
      `Estimated screen load: ${screenLoad.marks.toLocaleString(
        "en-US",
      )} marks/plate${
        screenLoad.plate
          ? ` (${PLATE_META[screenLoad.plate].short} at ${
              settings.angles[screenLoad.plate]
            }°)`
          : ""
      }`,
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

  function loadFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setNotice("Choose a PNG, JPG, or WebP image.");
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setSource(image);
      setSourceName(file.name);
      setActivePlate("composite");
      const ratio = image.naturalWidth / image.naturalHeight;
      setDocumentSettings((current) => ({
        ...current,
        orientation:
          ratio > 1.1
            ? "landscape"
            : ratio < 0.9
              ? "portrait"
              : current.orientation,
      }));
      setNotice("Artwork loaded");
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      setNotice("That image could not be opened.");
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }

  async function exportArtwork(kind: "composite" | "plates") {
    if (!source) return;
    if (screenLoadIsDense) {
      setExportOpen(false);
      setNotice(
        `Export blocked: estimated ${screenLoad.marks.toLocaleString(
          "en-US",
        )} marks per plate exceeds the ${MAX_EXPORT_GRID_POINTS.toLocaleString(
          "en-US",
        )} limit. Increase cell size to export.`,
      );
      return;
    }
    setExportOpen(false);
    setExporting(true);
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    try {
      const { width, height } = outputDimensions;

      if (kind === "composite") {
        const canvas = document.createElement("canvas");
        renderHalftone(source, canvas, settings, {
          plate: "composite",
          width,
          height,
          registration,
          paper: "#ffffff",
          document: documentSettings,
        });
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error("Export failed");
        const dpiBlob = await withPngDpi(blob, DOCUMENT_DPI);
        downloadBlob(dpiBlob, `${cleanName(sourceName)}-halftone.png`);
        setNotice("Composite PNG exported");
      } else {
        const zip = new JSZip();
        for (const plate of PLATES) {
          const canvas = document.createElement("canvas");
          renderHalftone(source, canvas, settings, {
            plate,
            width,
            height,
            registration,
            paper: "#ffffff",
            monochromePlate: true,
            document: documentSettings,
          });
          const plateBlob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png"),
          );
          if (!plateBlob) throw new Error("Plate export failed");
          const dpiBlob = await withPngDpi(plateBlob, DOCUMENT_DPI);
          zip.file(
            `${cleanName(sourceName)}-${PLATE_META[plate].short}-plate.png`,
            dpiBlob,
          );
        }
        zip.file(
          "job-settings.json",
          JSON.stringify(
            {
              source: sourceName,
              document: documentSettings,
              settings,
              registration,
              output: {
                width,
                height,
                dpi: DOCUMENT_DPI,
                estimatedMarksPerPlate: screenLoad.marks,
                worstPlate: screenLoad.plate,
                worstAngle:
                  screenLoad.plate === null
                    ? null
                    : settings.angles[screenLoad.plate],
              },
            },
            null,
            2,
          ),
        );
        const blob = await zip.generateAsync({ type: "blob" });
        downloadBlob(blob, `${cleanName(sourceName)}-CMYK-plates.zip`);
        setNotice("CMYK plate package exported");
      }
    } catch {
      setNotice("Export could not be completed.");
    } finally {
      setExporting(false);
    }
  }

  // §6.2 channel tinting: every active affordance renders in the soloed
  // plate's ink so the operator never has to ask which plate they're
  // editing. Composite carries no single plate hue (COMPOSITE_INK, not a
  // CHROME_INK value) — presented as a hairline stripe instead (InkRail).
  const activeInk =
    activePlate === "composite" ? COMPOSITE_INK : CHROME_INK[activePlate];

  const stages: Stage[] = STAGE_DEFINITIONS.map((stage) => ({
    ...stage,
    complete: stage.id === "artwork" ? Boolean(source) : false,
  }));

  function jumpToStage(id: string) {
    if (!STAGE_DEFINITIONS.some((stage) => stage.id === id)) return;
    setActiveStage(id as StudioStageId);
    setInspectorCollapsed(false);
  }

  function adjacentStage(delta: -1 | 1) {
    const current = STAGE_DEFINITIONS.findIndex(
      (stage) => stage.id === activeStage,
    );
    const next = STAGE_DEFINITIONS[current + delta];
    if (next) jumpToStage(next.id);
  }

  return (
    <main
      className="studio-shell"
      data-studio-root
      style={{ "--ink-active": activeInk } as CSSProperties}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>{PRODUCT_NAME}</strong>
            <span>{PRODUCT_TAGLINE}</span>
          </div>
        </div>

        <div className="project-title">
          <FileImage size={15} />
          <span>{sourceName}</span>
          <span className="saved-state">
            <Check size={12} /> Local session
          </span>
        </div>

        <nav className="top-actions" aria-label="Application actions">
          <button className="icon-button" title="Help" aria-label="Help">
            <HelpCircle size={18} />
          </button>
          <button className="button secondary" onClick={() => fileRef.current?.click()}>
            <FolderOpen size={16} /> Open artwork
          </button>
          <div className="export-wrap">
            <button
              className="button primary"
              onClick={() => setExportOpen((current) => !current)}
              disabled={exporting}
            >
              {exporting ? (
                <ProcessLoader compact label="Preparing export" />
              ) : (
                <Download size={16} />
              )}
              {exporting ? "Preparing…" : "Export"}
              <ChevronDown size={14} />
            </button>
            {exportOpen && (
              <div className="export-menu">
                <button onClick={() => exportArtwork("composite")}>
                  <MonitorUp size={17} />
                  <span>
                    <strong>Composite PNG</strong>
                    <small>Ready for sharing and proofing</small>
                  </span>
                </button>
                <button onClick={() => exportArtwork("plates")}>
                  <Layers3 size={17} />
                  <span>
                    <strong>CMYK plate package</strong>
                    <small>Four monochrome PNG plates + settings</small>
                  </span>
                </button>
              </div>
            )}
          </div>
        </nav>
      </header>

      <section
        className={`workspace ${inspectorCollapsed ? "inspector-collapsed" : ""}`}
      >
        <aside
          className={`inspector ${inspectorCollapsed ? "is-collapsed" : ""}`}
          data-testid="inspector"
          data-collapsed={inspectorCollapsed ? "true" : "false"}
        >
          <StageSpine
            stages={stages}
            active={activeStage}
            onJump={jumpToStage}
          />
          <div className="inspector-heading">
            <div>
              <span className="eyebrow">Recipe</span>
              <h1>Build your separation</h1>
            </div>
            <button
              className="icon-button"
              title={inspectorCollapsed ? "Expand panel" : "Collapse panel"}
              aria-label={inspectorCollapsed ? "Expand panel" : "Collapse panel"}
              aria-expanded={!inspectorCollapsed}
              onClick={() => setInspectorCollapsed((current) => !current)}
            >
              {inspectorCollapsed ? (
                <PanelLeftOpen size={18} />
              ) : (
                <PanelLeftClose size={18} />
              )}
            </button>
          </div>

          <StagePanel
            id="artwork"
            number="01"
            label="Artwork"
            description="Confirm the source file before building the screen."
            active={activeStage === "artwork"}
            onNext={() => adjacentStage(1)}
            onReset={resetArtwork}
          >
            <button className="upload-card" onClick={() => fileRef.current?.click()}>
              <span className="upload-icon">
                <ImagePlus size={20} />
              </span>
              <span>
                <strong>{sourceName}</strong>
                <small>{sourceMeta}</small>
              </span>
              <span className="replace-label">Replace</span>
            </button>
            <div className="artwork-layout-controls">
              <label className="select-field">
                <span>Sheet size</span>
                <select
                  data-testid="artwork-sheet-size"
                  value={documentSettings.sheetSize}
                  onChange={(event) =>
                    setDocumentSettings((current) => ({
                      ...current,
                      sheetSize: event.target.value as SheetSizeId,
                    }))
                  }
                >
                  {SHEET_SIZES.map((sheet) => (
                    <option key={sheet.id} value={sheet.id}>
                      {sheet.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="artwork-control-group">
                <span className="artwork-control-label">Orientation</span>
                <div className="segmented-control" role="group" aria-label="Orientation">
                  {(["portrait", "landscape"] as const).map((orientation) => (
                    <button
                      key={orientation}
                      type="button"
                      data-testid={`artwork-orientation-${orientation}`}
                      aria-pressed={documentSettings.orientation === orientation}
                      onClick={() =>
                        setDocumentSettings((current) => ({
                          ...current,
                          orientation,
                        }))
                      }
                    >
                      {titleCase(orientation)}
                    </button>
                  ))}
                </div>
              </div>

              <NumericField
                id="artworkScale"
                label="Scale"
                value={documentSettings.scalePercent}
                min={10}
                max={400}
                step={1}
                unit="%"
                defaultValue={DEFAULT_DOCUMENT_SETTINGS.scalePercent}
                onChange={(scalePercent) =>
                  setDocumentSettings((current) => ({
                    ...current,
                    scalePercent,
                  }))
                }
              />

              <NumericField
                id="artworkOffsetX"
                label="X offset"
                value={documentSettings.offsetX}
                min={-6000}
                max={6000}
                step={1}
                unit="px"
                defaultValue={DEFAULT_DOCUMENT_SETTINGS.offsetX}
                hint="Horizontal placement in 240-DPI document pixels."
                onChange={(offsetX) =>
                  setDocumentSettings((current) => ({
                    ...current,
                    offsetX,
                  }))
                }
              />

              <NumericField
                id="artworkOffsetY"
                label="Y offset"
                value={documentSettings.offsetY}
                min={-6000}
                max={6000}
                step={1}
                unit="px"
                defaultValue={DEFAULT_DOCUMENT_SETTINGS.offsetY}
                hint="Vertical placement in 240-DPI document pixels."
                onChange={(offsetY) =>
                  setDocumentSettings((current) => ({
                    ...current,
                    offsetY,
                  }))
                }
              />

              <div className="artwork-action-row">
                <button
                  type="button"
                  data-testid="artwork-center"
                  onClick={() =>
                    setDocumentSettings((current) => ({
                      ...current,
                      offsetX: 0,
                      offsetY: 0,
                    }))
                  }
                >
                  Center
                </button>
                <button
                  type="button"
                  data-testid="artwork-fit"
                  onClick={() => {
                    if (!source) return;
                    const sourceWidth =
                      source instanceof HTMLImageElement
                        ? source.naturalWidth
                        : source.width;
                    const sourceHeight =
                      source instanceof HTMLImageElement
                        ? source.naturalHeight
                        : source.height;
                    const sheet = getSheetPixelDimensions(
                      documentSettings.sheetSize,
                      documentSettings.orientation,
                    );
                    setDocumentSettings((current) => ({
                      ...current,
                      scalePercent: getFitScalePercent(
                        sourceWidth,
                        sourceHeight,
                        sheet.width,
                        sheet.height,
                      ),
                      offsetX: 0,
                      offsetY: 0,
                    }));
                  }}
                >
                  Fit
                </button>
              </div>

              <label className="artwork-mirror-toggle">
                <span>Mirror artwork</span>
                <input
                  type="checkbox"
                  data-testid="artwork-mirror"
                  checked={documentSettings.mirrorImage}
                  onChange={(event) =>
                    setDocumentSettings((current) => ({
                      ...current,
                      mirrorImage: event.target.checked,
                    }))
                  }
                />
              </label>

              <div className="artwork-control-group">
                <span className="artwork-control-label">Mirror direction</span>
                <div
                  className="segmented-control"
                  role="group"
                  aria-label="Mirror direction"
                >
                  {(["horizontal", "vertical"] as const).map((mirrorDirection) => (
                    <button
                      key={mirrorDirection}
                      type="button"
                      data-testid={`artwork-mirror-direction-${mirrorDirection}`}
                      aria-pressed={
                        documentSettings.mirrorDirection === mirrorDirection
                      }
                      disabled={!documentSettings.mirrorImage}
                      onClick={() =>
                        setDocumentSettings((current) => ({
                          ...current,
                          mirrorDirection,
                        }))
                      }
                    >
                      {titleCase(mirrorDirection)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </StagePanel>

          <StagePanel
            id="screen"
            number="02"
            label="Screen"
            description="Set the dot geometry and tonal response."
            active={activeStage === "screen"}
            onBack={() => adjacentStage(-1)}
            onNext={() => adjacentStage(1)}
            onReset={resetScreen}
          >
            <div className="field-grid">
              <label className="select-field">
                <span>Dot shape</span>
                <select
                  value={settings.dotShape}
                  onChange={(event) =>
                    updateSetting(
                      "dotShape",
                      event.target.value as HalftoneSettings["dotShape"],
                    )
                  }
                >
                  <option value="round">Round</option>
                  <option value="square">Square</option>
                  <option value="diamond">Diamond</option>
                  <option value="line">Line</option>
                </select>
              </label>
              <NumericField
                id="cellSize"
                label="Cell size"
                value={settings.cellSize}
                min={3}
                max={64}
                step={1}
                unit="px"
                defaultValue={DEFAULT_SETTINGS.cellSize}
                hint="At 240 DPI, 16 px yields about 15 LPI; 4 px yields about 60 LPI."
                onChange={(value) => updateSetting("cellSize", value)}
              />
              <NumericField
                id="contrast"
                label="Contrast"
                value={settings.contrast}
                min={0.5}
                max={2}
                step={0.05}
                unit="×"
                defaultValue={DEFAULT_SETTINGS.contrast}
                hint="Expands or compresses the tonal range before dots are built."
                onChange={(value) => updateSetting("contrast", value)}
              />
              <NumericField
                id="exposure"
                label="Exposure"
                value={Math.round(settings.exposure * 100)}
                min={-30}
                max={30}
                step={1}
                unit="%"
                defaultValue={DEFAULT_SETTINGS.exposure * 100}
                hint="Shifts overall coverage toward more ink or more paper."
                onChange={(value) => updateSetting("exposure", value / 100)}
              />
            </div>
          </StagePanel>

          <StagePanel
            id="separation"
            number="03"
            label="Separation"
            description="Check each process plate and its screen angle."
            active={activeStage === "separation"}
            onBack={() => adjacentStage(-1)}
            onNext={() => adjacentStage(1)}
            onReset={resetSeparation}
          >
            <span
              className="separation-viewing-label"
              data-testid="active-plate-label"
            >
              Viewing:{" "}
              {activePlate === "composite"
                ? "Composite"
                : PLATE_META[activePlate].label}
            </span>
            <InkRail
              activePlate={activePlate}
              settings={settings}
              onSolo={handleSolo}
              onToggleVisible={handleToggleVisible}
              onAngleChange={handleAngleChange}
            />
          </StagePanel>

          <StagePanel
            id="output"
            number="04"
            label="Output"
            description="Finish the plate package and press handoff."
            active={activeStage === "output"}
            onBack={() => adjacentStage(-1)}
            onReset={resetOutput}
            final
          >
            <label className="toggle-row">
              <span>
                <strong>Registration marks</strong>
                <small>Include on proofs and plates</small>
              </span>
              <input
                type="checkbox"
                checked={registration}
                onChange={(event) => setRegistration(event.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>
                <strong>Invert dots</strong>
                <small>Swap ink and paper coverage</small>
              </span>
              <input
                type="checkbox"
                checked={settings.invert}
                onChange={(event) => updateSetting("invert", event.target.checked)}
              />
            </label>
            <NumericField
              id="opacity"
              label="Ink density"
              value={Math.round(settings.opacity * 100)}
              min={35}
              max={100}
              step={1}
              unit="%"
              defaultValue={DEFAULT_SETTINGS.opacity * 100}
              hint="Changes the opacity of every plate in the composite proof."
              onChange={(value) => updateSetting("opacity", value / 100)}
            />
            <section className="preflight-card" aria-labelledby="preflight-title">
              <header className="preflight-heading">
                <span>
                  <ClipboardCheck size={16} aria-hidden="true" />
                  <strong id="preflight-title">Output preflight</strong>
                </span>
                <span data-testid="preflight-count">
                  {preflightReviewCount === 0
                    ? "No visible omissions"
                    : `${preflightReviewCount} to review`}
                </span>
              </header>
              <ul className="preflight-list">
                <PreflightItem
                  review={hiddenPlates.length > 0}
                  label="Plate visibility"
                  value={
                    hiddenPlates.length === 0
                      ? "4/4 enabled"
                      : `${hiddenPlates
                          .map((plate) => PLATE_META[plate].short)
                          .join(", ")} hidden`
                  }
                />
                <PreflightItem
                  review={sharedAngleGroups.length > 0}
                  label="Screen angles"
                  value={
                    sharedAngleGroups.length === 0
                      ? "All four angles are distinct"
                      : sharedAngleGroups
                          .map(
                            ([angle, plates]) =>
                              `${plates
                                .map((plate) => PLATE_META[plate].short)
                                .join("/")} share ${angle}°`,
                          )
                          .join(" · ")
                  }
                />
                <PreflightItem
                  review={!registration}
                  label="Registration"
                  value={registration ? "Marks included" : "Off — confirm before film"}
                />
                <PreflightItem
                  review={settings.invert}
                  label="Dot polarity"
                  value={settings.invert ? "Inverted — confirm" : "Standard positive"}
                />
                <PreflightItem
                  review={screenLoadIsDense}
                  label="Screen load"
                  value={
                    screenLoad.plate
                      ? `${screenLoad.marks.toLocaleString(
                          "en-US",
                        )} estimated marks/plate (${
                          PLATE_META[screenLoad.plate].short
                        } at ${settings.angles[screenLoad.plate]}°)`
                      : "No enabled plates"
                  }
                />
              </ul>
              <button
                type="button"
                className="preflight-copy"
                onClick={copyJobTicket}
              >
                <Copy size={14} aria-hidden="true" />
                Copy job ticket
              </button>
            </section>
          </StagePanel>
        </aside>

        <section
          className={[
            "canvas-stage",
            dragging ? "dragging" : "",
            spaceHeld ? "pan-armed" : "",
            panning ? "panning" : "",
            activeStage === "artwork" && !spaceHeld ? "artwork-placeable" : "",
            placingArtwork ? "artwork-placing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-testid="stage-surface"
          data-pan-armed={spaceHeld ? "true" : "false"}
          data-artwork-placeable={
            activeStage === "artwork" && !spaceHeld ? "true" : "false"
          }
          data-artwork-dragging={placingArtwork ? "true" : "false"}
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
          <div className="stage-toolbar">
            <div className="view-status">
              <Sparkles size={14} />
              <span>
                {activeStage === "artwork"
                  ? placingArtwork
                    ? "Placing artwork in document pixels"
                    : "Drag artwork to place · Space-drag pans proof"
                  : "Live browser preview"}
              </span>
            </div>
          </div>

          <div className="stage-body">
            <div className="canvas-scroll">
              <div
                className="artboard-wrap"
                style={{
                  width: `${zoom}%`,
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                }}
                onDoubleClick={() => setZoom(76)}
              >
                <canvas
                  ref={canvasRef}
                  data-testid="artwork-canvas"
                  aria-label="Live CMYK halftone preview"
                  onPointerDown={(event) => {
                    if (
                      activeStage !== "artwork" ||
                      spaceHeld ||
                      event.button !== 0
                    ) {
                      return;
                    }
                    const bounds = event.currentTarget.getBoundingClientRect();
                    if (
                      event.clientX < bounds.left ||
                      event.clientX > bounds.right ||
                      event.clientY < bounds.top ||
                      event.clientY > bounds.bottom ||
                      bounds.width <= 0 ||
                      bounds.height <= 0
                    ) {
                      return;
                    }
                    const sheet = getSheetPixelDimensions(
                      documentSettings.sheetSize,
                      documentSettings.orientation,
                    );
                    event.preventDefault();
                    event.stopPropagation();
                    artworkPlacementStart.current = {
                      x: event.clientX,
                      y: event.clientY,
                      offsetX: documentSettings.offsetX,
                      offsetY: documentSettings.offsetY,
                      pixelsPerScreenX: sheet.width / bounds.width,
                      pixelsPerScreenY: sheet.height / bounds.height,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setPlacingArtwork(true);
                  }}
                  onPointerMove={(event) => {
                    const start = artworkPlacementStart.current;
                    if (!start || spaceHeld) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const offsetX = Math.min(
                      6000,
                      Math.max(
                        -6000,
                        start.offsetX +
                          Math.round(
                            (event.clientX - start.x) * start.pixelsPerScreenX,
                          ),
                      ),
                    );
                    const offsetY = Math.min(
                      6000,
                      Math.max(
                        -6000,
                        start.offsetY +
                          Math.round(
                            (event.clientY - start.y) * start.pixelsPerScreenY,
                          ),
                      ),
                    );
                    setDocumentSettings((current) => ({
                      ...current,
                      offsetX,
                      offsetY,
                    }));
                  }}
                  onPointerUp={(event) => {
                    if (!artworkPlacementStart.current) return;
                    event.preventDefault();
                    event.stopPropagation();
                    artworkPlacementStart.current = null;
                    setPlacingArtwork(false);
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                  }}
                  onPointerCancel={(event) => {
                    if (!artworkPlacementStart.current) return;
                    event.stopPropagation();
                    artworkPlacementStart.current = null;
                    setPlacingArtwork(false);
                  }}
                />
                <span className="artboard-label" data-testid="artboard-label">
                  {activePlate === "composite"
                    ? hiddenPlates.length === 0
                      ? "Composite proof"
                      : hiddenPlates.length === PLATES.length
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
                onClick={() => setZoom((value) => Math.max(35, value - 8))}
              >
                <ZoomOut size={17} />
              </button>
              <NumericField
                id="zoom"
                label="Zoom"
                value={zoom}
                min={35}
                max={110}
                step={1}
                unit="%"
                defaultValue={76}
                showSlider={false}
                hint="Changes only the proof view, never the exported artwork."
                onChange={setZoom}
              />
              <input
                type="range"
                data-testid="zoom-slider"
                min={35}
                max={110}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                aria-label="Preview zoom"
                aria-valuetext={`${zoom} percent`}
                aria-describedby="numeric-zoom-unit numeric-zoom-hint"
              />
              <button
                className="icon-button"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => setZoom((value) => Math.min(110, value + 8))}
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
        </section>
      </section>

      <div className="desktop-only" data-testid="desktop-only">
        <p className="desktop-only-title">Open on a desktop</p>
        <p className="desktop-only-body">
          {PRODUCT_NAME} drives press separations at full resolution and needs a
          pointer and a large canvas. Open this on a desktop browser.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={onFileChange}
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

      <SessionBadge />
    </main>
  );
}

type StagePanelProps = {
  id: StudioStageId;
  number: string;
  label: string;
  description: string;
  active: boolean;
  final?: boolean;
  onBack?: () => void;
  onNext?: () => void;
  onReset?: () => void;
  children: ReactNode;
};

function StagePanel({
  id,
  number,
  label,
  description,
  active,
  final = false,
  onBack,
  onNext,
  onReset,
  children,
}: StagePanelProps) {
  return (
    <section
      className={`control-step ${final ? "final-step" : ""}`}
      id={id}
      role="tabpanel"
      aria-labelledby={`stage-tab-${id}`}
      data-testid={`stage-panel-${id}`}
      hidden={!active}
    >
      <header className="control-step-heading">
        <span className="step-number">{number}</span>
        <span>
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
        {onReset ? (
          <button
            type="button"
            className="stage-reset-button"
            aria-label={`Reset ${label} controls`}
            title={`Reset ${label} controls`}
            onClick={onReset}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="control-step-body">{children}</div>
      <nav className="control-step-nav" aria-label={`${label} stage navigation`}>
        {onBack ? (
          <button type="button" className="stage-nav-button" onClick={onBack}>
            Previous
          </button>
        ) : (
          <span />
        )}
        {onNext ? (
          <button type="button" className="stage-nav-button" onClick={onNext}>
            Next stage
          </button>
        ) : null}
      </nav>
    </section>
  );
}

function PreflightItem({
  review,
  label,
  value,
}: {
  review: boolean;
  label: string;
  value: string;
}) {
  return (
    <li
      className={review ? "needs-review" : ""}
      data-status={review ? "review" : "clear"}
    >
      {review ? (
        <AlertTriangle size={14} aria-hidden="true" />
      ) : (
        <Check size={14} aria-hidden="true" />
      )}
      <span>
        <strong>{label}</strong>
        <small>{value}</small>
      </span>
    </li>
  );
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
