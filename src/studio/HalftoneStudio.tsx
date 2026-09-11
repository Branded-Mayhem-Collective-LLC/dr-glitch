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
import CustomShapeDialog from "./CustomShapeDialog";
import { importCustomShape, prepareCustomShape } from "./custom-shape";
import type { CustomShapeAsset } from "./custom-shape-data";
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
  processPlates,
  Plate,
  renderHalftone,
  renderPlateSvg,
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
import { validateImageDimensions, validateImageFile, validateImageSignature } from "./image-file";
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

import { DEFAULT_SETTINGS, DIFFUSION_DEFAULTS, GLITCH_DEFAULTS } from "./settings-defaults";

const CMYK_PRESETS = [
  { id: "preset-1", label: "Preset 1 · C15 M75 Y0 K45", angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 } },
  { id: "preset-2", label: "Preset 2 · C105 M75 Y90 K15", angles: { cyan: 105, magenta: 75, yellow: 90, black: 15 } },
  { id: "preset-3", label: "Preset 3 · C15 M45 Y0 K75", angles: { cyan: 15, magenta: 45, yellow: 0, black: 75 } },
  { id: "preset-4", label: "Preset 4 · C165 M45 Y90 K105", angles: { cyan: 165, magenta: 45, yellow: 90, black: 105 } },
] as const;

const STAGE_DEFINITIONS = [
  {
    id: "artwork",
    number: "01",
    label: "Artboard",
    description: "Confirm the source file before building the screen.",
  },
  {
    id: "halftone-cmyk",
    number: "02",
    label: "Halftone / CMYK",
    description: "Build the dot pattern, screen angles, and plate mix.",
  },
  {
    id: "diffusion",
    number: "03",
    label: "Diffusion",
    description: "Shape ink distribution with diffusion and glitch controls.",
  },
  {
    id: "glitch",
    number: "04",
    label: "Glitch",
    description: "Slice, warp, smear, corrupt, and sort the source field.",
  },
  {
    id: "output",
    number: "05",
    label: "Output / Registration",
    description: "Finish the plate package and press handoff.",
  },
] as const;

type StudioStageId = (typeof STAGE_DEFINITIONS)[number]["id"];

export default function HalftoneStudio() {
  const artworkLoadRef = useRef(0);
  const artworkUrlRef = useRef<string | undefined>(undefined);
  const artworkImageRef = useRef<HTMLImageElement | undefined>(undefined);
  const registrationLoadRef = useRef(0);
  const [source, setSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(
    null,
  );
  const [sourceName, setSourceName] = useState(`${PRODUCT_NAME} sample artwork`);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(
    () => ({ ...DEFAULT_DOCUMENT_SETTINGS }),
  );
  const [selectedPlate, setActivePlate] = useState<Plate>("composite");
  const activePlate = settings.grayscale && selectedPlate !== "composite" ? "black" : selectedPlate;
  const applicablePlates = useMemo(() => processPlates(settings), [settings]);
  const [zoom, setZoom] = useState(76);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [activeStage, setActiveStage] = useState<StudioStageId>("artwork");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [registration, setRegistration] = useState(true);
  const [registrationSize, setRegistrationSize] = useState(120);
  const [registrationOffset, setRegistrationOffset] = useState(120);
  const [registrationWeight, setRegistrationWeight] = useState(2);
  const [registrationShape, setRegistrationShape] = useState<CustomShapeAsset>();
  const [registrationMode, setRegistrationMode] = useState<"corners" | "centered">("corners");

  useEffect(() => () => {
    artworkLoadRef.current++;
    registrationLoadRef.current++;
    if (artworkImageRef.current) {
      artworkImageRef.current.onload = artworkImageRef.current.onerror = null;
      artworkImageRef.current.src = "";
    }
    if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current);
  }, []);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [customShapeOpen, setCustomShapeOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const patternPreviewRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const registrationFileRef = useRef<HTMLInputElement>(null);
  const renderFrame = useRef<number | null>(null);
  const panStart = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
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
      paper: documentSettings.background === "black" ? "#111214" : "#F4F1E9",
      registration,
      registrationSize,
      registrationOffset,
      registrationWeight,
      registrationShape,
      registrationMode,
      monochromePlate: true,
      document: documentSettings,
      preview: true,
    });
  }, [activePlate, documentSettings, registration, registrationMode, registrationOffset, registrationShape, registrationSize, registrationWeight, settings, source]);

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
    if (settings.grayscale && plate !== "black" && plate !== "composite") return;
    setActivePlate(plate);
  }, [settings.grayscale]);

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

  useEffect(() => {
    const canvas = patternPreviewRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const size = 80;
    const scale = window.devicePixelRatio || 1;
    const frayedXEdge = Number(settings.frayedXEdge ?? 0);
    const frayedYEdge = Number(settings.frayedYEdge ?? 0);
    canvas.width = size * scale;
    canvas.height = size * scale;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = "#f4f1e9";
    context.fillRect(0, 0, size, size);
    const colors = ["#00a9c8", "#e53578", "#f0d422", "#202226"] as const;
    const plates = ["cyan", "magenta", "yellow", "black"] as const;
    for (let plateIndex = 0; plateIndex < plates.length; plateIndex += 1) {
      const plate = plates[plateIndex];
      if (activePlate !== "composite" && plate !== activePlate) continue;
      if (!settings.visible[plate] || (settings.grayscale && plate !== "black")) continue;
      const angle = (settings.angles[plate] * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      context.fillStyle = colors[plateIndex];
      context.globalAlpha = settings.grayscale ? 0.82 : 0.48;
      const cell = Math.max(5, Math.min(14, settings.cellSize * 0.72));
      for (let u = -80; u <= 160; u += cell) {
        for (let v = -80; v <= 160; v += cell) {
          const x = 40 + u * cos - v * sin;
          const y = 40 + u * sin + v * cos;
          if (x < -4 || y < -4 || x > 84 || y > 84) continue;
          const edgeX = Math.min(x, size - x);
          const edgeY = Math.min(y, size - y);
          const fray = Math.min(
            1,
            frayedXEdge === 0 ? 1 : edgeX / (frayedXEdge * 0.8),
            frayedYEdge === 0 ? 1 : edgeY / (frayedYEdge * 0.8),
          );
          const radius = Math.max(1.5, cell * 0.32 * fray);
          context.beginPath();
          if (settings.dotShape === "square") context.rect(x - radius, y - radius, radius * 2, radius * 2);
          else if (settings.dotShape === "triangle") {
            context.moveTo(x, y - radius);
            context.lineTo(x + radius, y + radius);
            context.lineTo(x - radius, y + radius);
            context.closePath();
          } else context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    context.globalAlpha = 1;
  }, [activePlate, settings.angles, settings.cellSize, settings.dotShape, settings.frayedXEdge, settings.frayedYEdge, settings.grayscale, settings.visible]);

  function cyclePatternPlate() {
    const sequence: Plate[] = ["composite", ...applicablePlates];
    const next = sequence[(sequence.indexOf(activePlate) + 1) % sequence.length];
    setActivePlate(next);
  }

  // §1: "a print tool that misleads the eye about ink is broken." renderHalftone
  // blanks any plate (including every plate inside a composite render) whose
  // settings.visible flag is off, so the proof can go blank while its label
  // still claims to show something. hiddenPlates drives the same label logic
  // for both the single-plate case (already handled below) and composite.
  const hiddenPlates = useMemo(
    () => applicablePlates.filter((plate) => !settings.visible[plate]),
    [settings.visible, applicablePlates],
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
  const screenLoad = applicablePlates.filter((plate) => settings.visible[plate]).reduce<{
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

  function resetHalftoneCmyk() {
    setSettings((current) => ({
      ...current,
      cellSize: DEFAULT_SETTINGS.cellSize,
      frayedXEdge: DEFAULT_SETTINGS.frayedXEdge,
      frayedYEdge: DEFAULT_SETTINGS.frayedYEdge,
      dotShape: DEFAULT_SETTINGS.dotShape,
      strokeWidth: DEFAULT_SETTINGS.strokeWidth,
      grayscale: DEFAULT_SETTINGS.grayscale,
      angles: { ...DEFAULT_SETTINGS.angles },
      visible: { ...DEFAULT_SETTINGS.visible },
    }));
    setActivePlate("composite");
    setNotice("Halftone / CMYK controls reset");
  }

  function resetArtwork() {
    setDocumentSettings({ ...DEFAULT_DOCUMENT_SETTINGS });
    setNotice("Artwork controls reset");
  }

  function applyCmykPreset(presetId: string) {
    const preset = CMYK_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setSettings((current) => ({ ...current, angles: { ...preset.angles } }));
    setActivePlate("composite");
    setNotice(`${preset.label} loaded`);
  }

  function resetOutput() {
    registrationLoadRef.current++;
    setSettings((current) => ({
      ...current,
      opacity: 1,
      invert: false,
    }));
    setRegistration(true);
    setRegistrationSize(120);
    setRegistrationOffset(120);
    setRegistrationWeight(2);
    setRegistrationShape(undefined);
    setRegistrationMode("corners");
    setNotice("Output controls reset");
  }

  function setRegistrationEnabled(enabled: boolean) {
    registrationLoadRef.current++;
    setRegistration(enabled);
    setRegistrationSize(120);
    setRegistrationOffset(120);
    setRegistrationWeight(2);
    setRegistrationShape(undefined);
    setRegistrationMode("corners");
  }

  function resetDiffusion() {
    setSettings((current) => ({
      ...current,
      ...DIFFUSION_DEFAULTS,
    }));
    setNotice("Diffusion controls reset");
  }

  function resetGlitch() {
    setSettings((current) => ({
      ...current,
      ...GLITCH_DEFAULTS,
    }));
    setNotice("Glitch controls reset");
  }

  function jobTicketText() {
    const visible = applicablePlates.filter((plate) => settings.visible[plate])
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
      `Mirror: ${
        documentSettings.mirrorImage
          ? titleCase(documentSettings.mirrorDirection)
          : "Off"
      }`,
      `Dot: ${settings.dotShape}`,
      ...(settings.dotShape === "custom" && settings.customShape ? [`Custom SVG: ${settings.customShape.filename} (stretched to square)`] : []),
      `Color mode: ${settings.grayscale ? "Grayscale (K)" : "CMYK"}`,
      `Outline stroke: ${settings.strokeWidth ?? 1}px`,
      `Cell size: ${settings.cellSize}px`,
      `Angles: ${applicablePlates.map(
        (plate) => `${PLATE_META[plate].short} ${settings.angles[plate]}°`,
      ).join(" · ")}`,
      `Enabled plates: ${visible || "None"}`,
      `Registration marks: ${registration ? "Included" : "Off"}`,
      `Registration size: ${registrationSize}px`,
      `Registration offset: ${registrationOffset}px`,
      `Registration weight: ${registrationWeight}px`,
      `Registration mode: ${registrationMode === "centered" ? "Top/bottom centered" : "Four corners"}`,
      ...(registrationShape ? [`Registration SVG: ${registrationShape.filename}`] : []),
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

  async function loadFile(file: File) {
    const request = ++artworkLoadRef.current;
    if (artworkImageRef.current) {
      artworkImageRef.current.onload = artworkImageRef.current.onerror = null;
      artworkImageRef.current.src = "";
      artworkImageRef.current = undefined;
    }
    if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current);
    artworkUrlRef.current = undefined;
    const fileError = validateImageFile(file);
    if (fileError) {
      setNotice(fileError);
      return;
    }
    const signatureError = await validateImageSignature(file);
    if (request !== artworkLoadRef.current) return;
    if (signatureError) { setNotice(signatureError); return; }
    const url = URL.createObjectURL(file);
    artworkUrlRef.current = url;
    const image = new Image();
    artworkImageRef.current = image;
    image.onload = () => {
      if (artworkImageRef.current === image) artworkImageRef.current = undefined;
      URL.revokeObjectURL(url);
      if (artworkUrlRef.current === url) artworkUrlRef.current = undefined;
      if (request !== artworkLoadRef.current) return;
      const dimensionError = validateImageDimensions(image.naturalWidth, image.naturalHeight);
      if (dimensionError) {
        setNotice(dimensionError);
        return;
      }
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
    };
    image.onerror = () => {
      if (artworkImageRef.current === image) artworkImageRef.current = undefined;
      URL.revokeObjectURL(url);
      if (artworkUrlRef.current === url) artworkUrlRef.current = undefined;
      if (request === artworkLoadRef.current) setNotice("That image could not be opened.");
    };
    image.src = url;
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
    event.target.value = "";
  }

  async function onRegistrationFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++registrationLoadRef.current;
    try {
      const shape = await importCustomShape(file);
      if (request !== registrationLoadRef.current) return;
      setRegistrationShape(shape);
      setRegistration(true);
      setNotice(`Registration mark loaded: ${shape.filename}`);
    } catch (error) {
      if (request !== registrationLoadRef.current) return;
      setNotice(error instanceof Error ? error.message : "That registration SVG could not be imported.");
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  }

  async function exportArtwork(kind: "png" | "svg" | "jpg" | "tiff" | "plates") {
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
      if (settings.dotShape === "custom" && settings.customShape) await prepareCustomShape(settings.customShape);
      if (registrationShape) await prepareCustomShape(registrationShape);

      if (kind !== "plates") {
        if (kind === "svg") {
          const baseName = cleanName(sourceName);
          const svgZip = new JSZip();
          const folder = `${baseName}_SVG_Plates`;
          for (const plate of applicablePlates) {
            const svg = renderPlateSvg(source, settings, plate, {
              width,
              height,
              document: documentSettings,
              registration, registrationSize, registrationOffset, registrationWeight,
              registrationShape, registrationMode,
            });
            svgZip.file(`${folder}/${settings.grayscale ? "K" : PLATE_META[plate].short}.svg`, svg);
          }
          svgZip.file(`${folder}/job-settings.json`, JSON.stringify({
            source: sourceName,
            document: documentSettings,
            settings,
            plates: applicablePlates,
            registration, registrationSize, registrationOffset, registrationWeight,
            registrationShape, registrationMode,
            output: { width, height, dpi: DOCUMENT_DPI },
            fill: "#000000",
            vector: true,
          }, null, 2));
          const svgPackage = await svgZip.generateAsync({ type: "blob" });
          downloadBlob(svgPackage, `${folder}.zip`);
          setNotice("Vector SVG plate package exported");
          return;
        }
        const canvas = document.createElement("canvas");
        renderHalftone(source, canvas, settings, {
          plate: "composite",
          width,
          height,
          registration,
          registrationSize,
          registrationOffset,
          registrationWeight,
          registrationShape,
          registrationMode,
          paper: documentSettings.background === "black" ? "#000000" : "#ffffff",
          document: documentSettings,
        });
        const baseName = cleanName(sourceName);
        let blob: Blob | null;
        let filename: string;
        if (kind === "tiff") {
          blob = new Blob([encodeRgbaTiff(canvas)], { type: "image/tiff" });
          filename = `${baseName}-halftone.tiff`;
        } else {
          blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, kind === "jpg" ? "image/jpeg" : "image/png", 0.92),
          );
          filename = `${baseName}-halftone.${kind}`;
        }
        if (!blob) throw new Error("Export failed");
        const output = kind === "png" ? await withPngDpi(blob, DOCUMENT_DPI) : blob;
        downloadBlob(output, filename);
        setNotice(`Composite ${kind.toUpperCase()} exported`);
      } else {
        const zip = new JSZip();
        for (const plate of applicablePlates) {
          const canvas = document.createElement("canvas");
          renderHalftone(source, canvas, settings, {
            plate,
            width,
            height,
            registration,
            paper: documentSettings.background === "black" ? "#000000" : "#ffffff",
            monochromePlate: true,
            document: documentSettings,
            registrationSize,
            registrationOffset,
            registrationWeight,
            registrationShape,
            registrationMode,
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
              registrationSize,
              registrationOffset,
              registrationWeight,
              registrationShape,
              registrationMode,
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
        downloadBlob(blob, `${cleanName(sourceName)}-${settings.grayscale ? "K" : "CMYK"}-plates.zip`);
        setNotice(`${settings.grayscale ? "Grayscale K" : "CMYK"} plate package exported`);
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
                <button onClick={() => exportArtwork("png")}>
                  <MonitorUp size={17} />
                  <span>
                    <strong>Composite PNG</strong>
                    <small>Ready for sharing and proofing</small>
                  </span>
                </button>
                <button onClick={() => exportArtwork("svg")}>
                  <MonitorUp size={17} />
                  <span>
                    <strong>Vector SVG plate package</strong>
                    <small>CMYK or K SVGs in a folder ZIP</small>
                  </span>
                </button>
                <button onClick={() => exportArtwork("jpg")}>
                  <MonitorUp size={17} />
                  <span>
                    <strong>Composite JPG</strong>
                    <small>Flattened JPEG proof</small>
                  </span>
                </button>
                <button onClick={() => exportArtwork("tiff")}>
                  <MonitorUp size={17} />
                  <span>
                    <strong>Composite TIFF</strong>
                    <small>Uncompressed RGBA TIFF proof</small>
                  </span>
                </button>
                <button onClick={() => exportArtwork("plates")}>
                  <Layers3 size={17} />
                  <span>
                    <strong>{settings.grayscale ? "Grayscale K plate package" : "CMYK plate package"}</strong>
                    <small>{settings.grayscale ? "One monochrome K PNG plate + settings" : "Four monochrome PNG plates + settings"}</small>
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
          <button
            className="icon-button inspector-collapse-button"
            title={inspectorCollapsed ? "Expand panel" : "Collapse panel"}
            aria-label={inspectorCollapsed ? "Expand panel" : "Collapse panel"}
            aria-expanded={!inspectorCollapsed}
            onClick={() => setInspectorCollapsed((current) => !current)}
          >
            {inspectorCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>

          <StagePanel
            id="artwork"
            number="01"
            label="Artwork"
            description="Confirm the source file before building the screen."
            active={activeStage === "artwork"}
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

              <div className="artwork-control-group">
                <span className="artwork-control-label">Background</span>
                <div className="segmented-control" role="group" aria-label="Background">
                  {(["white", "black"] as const).map((background) => (
                    <button
                      key={background}
                      type="button"
                      data-testid={`artwork-background-${background}`}
                      aria-pressed={documentSettings.background === background}
                      onClick={() =>
                        setDocumentSettings((current) => ({
                          ...current,
                          background,
                        }))
                      }
                    >
                      {titleCase(background)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="artwork-action-row">
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
            id="halftone-cmyk"
            number="02"
            label="Halftone / CMYK"
            description="Set the dot geometry, CMYK angles, and plate mix."
            active={activeStage === "halftone-cmyk"}
            onReset={resetHalftoneCmyk}
          >
            <div className="halftone-cmyk-top-controls">
              <label className="select-field">
                <span>Dot shape</span>
                <select
                  value={settings.dotShape}
                  onChange={(event) => {
                    if (event.target.value === "custom") setCustomShapeOpen(true);
                    else updateSetting("dotShape", event.target.value as HalftoneSettings["dotShape"]);
                  }}
                >
                  <option value="round">Round</option>
                  <option value="square">Square</option>
                  <option value="diamond">Diamond</option>
                  <option value="line">Line</option>
                  <option value="triangle">Triangle</option>
                  <option value="cross">Cross</option>
                  <option value="circle-outline">Circle outline</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label className="select-field">
                <span>Color mode</span>
                <select value={settings.grayscale ? "grayscale" : "cmyk"}
                  onChange={(event) => updateSetting("grayscale", event.target.value === "grayscale")}>
                  <option value="cmyk">CMYK</option>
                  <option value="grayscale">Grayscale (K)</option>
                </select>
              </label>
              {settings.grayscale && (
                <label className="toggle-row">
                  <span>
                    <strong>Invert grayscale</strong>
                    <small>Invert the black and white image.</small>
                  </span>
                  <input
                    type="checkbox"
                    data-testid="grayscale-invert"
                    checked={settings.invert}
                    onChange={(event) => updateSetting("invert", event.target.checked)}
                  />
                </label>
              )}
            </div>
            {settings.customShape && (
              <div className="custom-shape-current">
                <span data-testid="current-custom-shape">{settings.customShape.filename}</span>
                <button type="button" className="button secondary" onClick={() => setCustomShapeOpen(true)}>Replace SVG</button>
              </div>
            )}
            <div className="halftone-cmyk-preview-row">
              <div className="screen-angle-box">
                <div className="halftone-cmyk-section-label">CMYK angles</div>
                <span className="screen-angle-viewing" data-testid="active-plate-label">
                  {activePlate === "composite" ? "Viewing: Composite" : `Viewing: ${PLATE_META[activePlate].label}`}
                </span>
                <InkRail
                  activePlate={activePlate}
                  settings={settings}
                  onSolo={handleSolo}
                  onToggleVisible={handleToggleVisible}
                  onAngleChange={handleAngleChange}
                />
                <label className="select-field cmyk-preset-field">
                  <span>CMYK presets</span>
                  <select
                    data-testid="cmyk-preset"
                    defaultValue=""
                    onChange={(event) => applyCmykPreset(event.target.value)}
                  >
                    <option value="" disabled>Select a CMYK preset</option>
                    {CMYK_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="halftone-cmyk-header">
              <div className="pattern-preview-card">
                <div>
                  <strong>Dot pattern</strong>
                  <small>Live CMYK screen preview</small>
                </div>
                <button
                  type="button"
                  className="pattern-preview-button"
                  onClick={cyclePatternPlate}
                  title="Click to cycle the active plate"
                  aria-label={`Dot pattern preview, viewing ${activePlate === "composite" ? "composite" : PLATE_META[activePlate].label}. Click to cycle plates.`}
                >
                  <canvas ref={patternPreviewRef} width={80} height={80} data-testid="cmyk-pattern-preview" aria-label="CMYK dot pattern preview" />
                </button>
              </div>
            </div>
            </div>
            <div className="field-grid">
              {settings.dotShape === "circle-outline" && (
                <NumericField id="strokeWidth" label="Outline stroke" value={settings.strokeWidth ?? 1}
                  min={0.25} max={10} step={0.01} unit="px" defaultValue={1}
                  hint="Thickness inside the circle, in 240-DPI document pixels."
                  onChange={(value) => updateSetting("strokeWidth", value)} />
              )}
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
              <NumericField id="frayedXEdge" label="Frayed X edge" value={settings.frayedXEdge}
                min={0} max={100} step={1} unit="px" defaultValue={0}
                hint="Frays the left and right edges of the halftone field."
                onChange={(value) => updateSetting("frayedXEdge", value)} />
              <NumericField id="frayedYEdge" label="Frayed Y edge" value={settings.frayedYEdge}
                min={0} max={100} step={1} unit="px" defaultValue={0}
                hint="Frays the top and bottom edges of the halftone field."
                onChange={(value) => updateSetting("frayedYEdge", value)} />
            </div>
          </StagePanel>

          <StagePanel
            id="diffusion"
            number="03"
            label="Diffusion"
            description="Shape ink distribution with diffusion and glitch controls."
            active={activeStage === "diffusion"}
            onReset={resetDiffusion}
          >
            <label className="toggle-row">
              <span>
                <strong>Enable diffusion</strong>
                <small>Quantize coverage with an error-diffusion texture.</small>
              </span>
              <input
                type="checkbox"
                checked={settings.diffusionEnabled ?? false}
                onChange={(event) => updateSetting("diffusionEnabled", event.target.checked)}
              />
            </label>
            <div className="diffusion-section-label">Diffusion</div>
            <div className="field-grid">
              <label className="select-field">
                <span>Algorithm</span>
                <select
                  value={settings.diffusionAlgorithm ?? "floyd-steinberg"}
                  onChange={(event) => updateSetting("diffusionAlgorithm", event.target.value as HalftoneSettings["diffusionAlgorithm"])}
                >
                  <option value="none">None</option>
                  <option value="floyd-steinberg">Floyd-Steinberg</option>
                  <option value="jarvis-judice-ninke">Jarvis-Judice-Ninke</option>
                  <option value="stucki">Stucki</option>
                  <option value="burkes">Burkes</option>
                  <option value="atkinson">Atkinson</option>
                </select>
              </label>
              <label className="select-field">
                <span>Modulation</span>
                <select
                  value={settings.diffusionModulation ?? "none"}
                  onChange={(event) => updateSetting("diffusionModulation", event.target.value as HalftoneSettings["diffusionModulation"])}
                >
                  {(["none", "column", "row", "dispersed", "medium", "heavy", "circuit", "tilt", "grid"] as const).map((mode) => (
                    <option key={mode} value={mode}>{titleCase(mode)}</option>
                  ))}
                </select>
              </label>
              <NumericField id="diffusionModStrength" label="Modulation strength" value={Math.round((settings.diffusionModStrength ?? 0.5) * 100)} min={0} max={100} step={1} unit="%" defaultValue={50} onChange={(value) => updateSetting("diffusionModStrength", value / 100)} />
              <NumericField id="diffusionIntensity" label="Intensity" value={Math.round((settings.diffusionIntensity ?? 0.5) * 100)} min={0} max={100} step={1} unit="%" defaultValue={50} onChange={(value) => updateSetting("diffusionIntensity", value / 100)} />
              <NumericField id="diffusionLevels" label="Levels" value={settings.diffusionLevels ?? 8} min={2} max={32} step={1} unit="" defaultValue={8} onChange={(value) => updateSetting("diffusionLevels", value)} />
              <NumericField id="diffusionSharpenStrength" label="Sharpen strength" value={Math.round((settings.diffusionSharpenStrength ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("diffusionSharpenStrength", value / 100)} />
              <NumericField id="diffusionSharpenRadius" label="Sharpen radius" value={settings.diffusionSharpenRadius ?? 1} min={1} max={10} step={1} unit="px" defaultValue={1} onChange={(value) => updateSetting("diffusionSharpenRadius", value)} />
              <NumericField id="diffusionDenoise" label="Denoise / noise" value={Math.round((settings.diffusionDenoise ?? 0) * 100)} min={-100} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("diffusionDenoise", value / 100)} />
            </div>
          </StagePanel>

          <StagePanel
            id="output"
            number="05"
            label="Output / Registration"
            description="Finish the plate package and press handoff."
            active={activeStage === "output"}
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
                onChange={(event) => setRegistrationEnabled(event.target.checked)}
              />
            </label>
            <label className="select-field">
              <span>Registration layout</span>
              <select
                value={registrationMode}
                disabled={!registration}
                onChange={(event) => setRegistrationMode(event.target.value as "corners" | "centered")}
              >
                <option value="corners">Four corners</option>
                <option value="centered">Top / bottom centered</option>
              </select>
            </label>
            <NumericField id="registrationSize" label="Registration size" value={registrationSize} min={20} max={600} step={1} unit="px" defaultValue={120} onChange={setRegistrationSize} />
            <NumericField id="registrationOffset" label="Registration offset" value={registrationOffset} min={10} max={1000} step={1} unit="px" defaultValue={120} onChange={setRegistrationOffset} />
            <NumericField id="registrationWeight" label="Registration weight" value={registrationWeight} min={1} max={20} step={0.5} unit="px" defaultValue={2} onChange={setRegistrationWeight} />
            <div className="registration-import-row">
              <input ref={registrationFileRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(event) => void onRegistrationFileChange(event)} />
              <button type="button" className="button secondary" onClick={() => registrationFileRef.current?.click()}>
                {registrationShape ? "Replace registration SVG" : "Import registration SVG"}
              </button>
              {registrationShape && <span>{registrationShape.filename}</span>}
            </div>
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
                      ? settings.grayscale ? "Grayscale uses the K screen angle" : "All four angles are distinct"
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

          <StagePanel
            id="glitch"
            number="04"
            label="Glitch"
            description="Slice, warp, smear, corrupt, and sort the source field."
            active={activeStage === "glitch"}
            onReset={resetGlitch}
          >
            {!settings.diffusionEnabled ? <>
              <div className="diffusion-section-label">Slice and warp</div>
              <div className="field-grid">
              <NumericField id="sliceShift" label="Slice shift" value={settings.sliceShift ?? 0} min={0} max={150} step={1} unit="px" defaultValue={0} onChange={(value) => updateSetting("sliceShift", value)} />
              <NumericField id="sliceSize" label="Slice size" value={settings.sliceSize ?? 20} min={2} max={200} step={1} unit="px" defaultValue={20} onChange={(value) => updateSetting("sliceSize", value)} />
              <NumericField id="verticalSliceShift" label="Vertical slice shift" value={settings.verticalSliceShift ?? 0} min={0} max={150} step={1} unit="px" defaultValue={0} onChange={(value) => updateSetting("verticalSliceShift", value)} />
              <NumericField id="verticalSliceSize" label="Vertical slice size" value={settings.verticalSliceSize ?? 20} min={2} max={200} step={1} unit="px" defaultValue={20} onChange={(value) => updateSetting("verticalSliceSize", value)} />
              <NumericField id="gridWarp" label="Grid warp" value={settings.gridWarp ?? 0} min={0} max={200} step={1} unit="px" defaultValue={0} onChange={(value) => updateSetting("gridWarp", value)} />
              <NumericField id="warpScale" label="Warp scale" value={settings.warpScale ?? 100} min={10} max={500} step={1} unit="%" defaultValue={100} onChange={(value) => updateSetting("warpScale", value)} />
              </div>
            </> : <>
              <div className="diffusion-section-label">Diffusion glitches</div>
              <div className="field-grid">
                <NumericField id="brokenKernel" label="Broken kernel" value={Math.round((settings.brokenKernel ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("brokenKernel", value / 100)} />
                <NumericField id="directionalBias" label="Directional bias" value={Math.round((settings.directionalBias ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("directionalBias", value / 100)} />
                <NumericField id="directionalBiasAngle" label="Bias angle" value={settings.directionalBiasAngle ?? 0} min={0} max={360} step={1} unit="°" defaultValue={0} onChange={(value) => updateSetting("directionalBiasAngle", value)} />
                <NumericField id="errorOverflow" label="Error overflow" value={Math.round((settings.errorOverflow ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("errorOverflow", value / 100)} />
                <NumericField id="diffusionReset" label="Diffusion reset" value={Math.round((settings.diffusionReset ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("diffusionReset", value / 100)} />
                <NumericField id="crossChannelBleed" label="Cross-channel bleed" value={Math.round((settings.crossChannelBleed ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("crossChannelBleed", value / 100)} />
              </div>
            </>}
            <div className="diffusion-section-label">Datamosh</div>
            <div className="field-grid">
              <NumericField id="smearDrag" label="Smear drag" value={Math.round((settings.smearDrag ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("smearDrag", value / 100)} />
              <NumericField id="smearLength" label="Smear length" value={settings.smearLength ?? 24} min={4} max={120} step={1} unit="px" defaultValue={24} onChange={(value) => updateSetting("smearLength", value)} />
              <label className="toggle-row"><span><strong>Vertical smear</strong><small>Drag smear along the Y axis.</small></span><input type="checkbox" checked={settings.smearVertical ?? false} onChange={(event) => updateSetting("smearVertical", event.target.checked)} /></label>
              <NumericField id="macroblockCorrupt" label="Macroblock corrupt" value={Math.round((settings.macroblockCorrupt ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("macroblockCorrupt", value / 100)} />
              <NumericField id="macroblockDropout" label="Dropout mix" value={Math.round((settings.macroblockDropout ?? 0.25) * 100)} min={0} max={100} step={1} unit="%" defaultValue={25} onChange={(value) => updateSetting("macroblockDropout", value / 100)} />
              <NumericField id="blockShift" label="Block shift" value={Math.round((settings.blockShift ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("blockShift", value / 100)} />
              <NumericField id="blockShiftSize" label="Block size" value={settings.blockShiftSize ?? 16} min={4} max={64} step={1} unit="px" defaultValue={16} onChange={(value) => updateSetting("blockShiftSize", value)} />
              <NumericField id="channelDesync" label="Channel desync" value={Math.round((settings.channelDesync ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("channelDesync", value / 100)} />
              <NumericField id="bitmapSort" label="Bitmap sort" value={Math.round((settings.bitmapSort ?? 0) * 100)} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(value) => updateSetting("bitmapSort", value / 100)} />
              <label className="toggle-row"><span><strong>Vertical bitmap sort</strong><small>Sort along the Y axis.</small></span><input type="checkbox" checked={settings.bitmapSortVertical ?? false} onChange={(event) => updateSetting("bitmapSortVertical", event.target.checked)} /></label>
            </div>
          </StagePanel>
        </aside>

        <section
          className={[
            "canvas-stage",
            dragging ? "dragging" : "",
            spaceHeld ? "pan-armed" : "",
            panning ? "panning" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-testid="stage-surface"
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
          <div className="stage-toolbar">
            <div className="view-status">
              <Sparkles size={14} />
              <span>
                {activeStage === "artwork" ? "Centered artwork proof · Space-drag pans" : "Live browser preview"}
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
                  aria-label={settings.grayscale ? "Live grayscale halftone preview" : "Live CMYK halftone preview"}
                />
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
      {customShapeOpen && (
        <CustomShapeDialog current={settings.customShape}
          onCancel={() => setCustomShapeOpen(false)}
          onApply={(customShape) => {
            setSettings((current) => ({ ...current, dotShape: "custom", customShape }));
            setCustomShapeOpen(false);
            setNotice(`Custom shape loaded: ${customShape.filename}`);
          }} />
      )}
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

function encodeRgbaTiff(canvas: HTMLCanvasElement) {
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!pixels) throw new Error("TIFF export could not read the rendered canvas");

  const entryCount = 10;
  const ifdOffset = 8;
  const bitsOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const pixelOffset = bitsOffset + 8;
  const buffer = new ArrayBuffer(pixelOffset + pixels.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4949, false);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);

  let entry = ifdOffset + 2;
  const writeEntry = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
    entry += 12;
  };

  writeEntry(256, 4, 1, canvas.width);
  writeEntry(257, 4, 1, canvas.height);
  writeEntry(258, 3, 4, bitsOffset);
  writeEntry(259, 3, 1, 1);
  writeEntry(262, 3, 1, 2);
  writeEntry(273, 4, 1, pixelOffset);
  writeEntry(277, 3, 1, 4);
  writeEntry(278, 4, 1, canvas.height);
  writeEntry(279, 4, 1, pixels.length);
  writeEntry(284, 3, 1, 1);
  view.setUint32(entry, 0, true);
  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);
  view.setUint16(bitsOffset + 6, 8, true);
  bytes.set(pixels, pixelOffset);
  return buffer;
}
