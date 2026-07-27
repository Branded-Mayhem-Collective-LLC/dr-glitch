"use client";

import {
  Check,
  ChevronDown,
  Download,
  FileImage,
  FolderOpen,
  HelpCircle,
  ImagePlus,
  Layers3,
  MonitorUp,
  PanelLeftClose,
  Sparkles,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import JSZip from "jszip";
import SessionBadge from "../auth/SessionBadge";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import InkRail from "./InkRail";
import { CHROME_INK, COMPOSITE_INK } from "./inks";
import NumericField from "./NumericField";
import StageSpine, { type Stage } from "./StageSpine";
import { isInteractiveTarget, useStudioKeys } from "./useStudioKeys";
import {
  createDemoArtwork,
  HalftoneSettings,
  PLATE_META,
  PLATES,
  Plate,
  renderHalftone,
} from "./halftone";
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

export default function HalftoneStudio() {
  const [source, setSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(
    null,
  );
  const [sourceName, setSourceName] = useState("DRC sample artwork");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activePlate, setActivePlate] = useState<Plate>("composite");
  const [zoom, setZoom] = useState(76);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [activeStage, setActiveStage] = useState("artwork");
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

  useEffect(() => {
    const timeout = window.setTimeout(() => setSource(createDemoArtwork()), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const render = useCallback(() => {
    if (!source || !canvasRef.current) return;
    const sourceWidth =
      source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const sourceHeight =
      source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    const maxDimension = 980;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    renderHalftone(source, canvasRef.current, settings, {
      plate: activePlate,
      width: sourceWidth * scale,
      height: sourceHeight * scale,
      paper: "#eee9de",
      registration,
      monochromePlate: true,
    });
  }, [activePlate, registration, settings, source]);

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

  // §1: "a print tool that misleads the eye about ink is broken." renderHalftone
  // blanks any plate (including every plate inside a composite render) whose
  // settings.visible flag is off, so the proof can go blank while its label
  // still claims to show something. hiddenPlates drives the same label logic
  // for both the single-plate case (already handled below) and composite.
  const hiddenPlates = useMemo(
    () => PLATES.filter((plate) => !settings.visible[plate]),
    [settings.visible],
  );

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
    setExportOpen(false);
    setExporting(true);
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    try {
      const sourceWidth =
        source instanceof HTMLImageElement ? source.naturalWidth : source.width;
      const sourceHeight =
        source instanceof HTMLImageElement ? source.naturalHeight : source.height;
      const exportScale = Math.min(1, 2800 / Math.max(sourceWidth, sourceHeight));
      const width = Math.round(sourceWidth * exportScale);
      const height = Math.round(sourceHeight * exportScale);

      if (kind === "composite") {
        const canvas = document.createElement("canvas");
        renderHalftone(source, canvas, settings, {
          plate: "composite",
          width,
          height,
          registration,
          paper: "#ffffff",
        });
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error("Export failed");
        downloadBlob(blob, `${cleanName(sourceName)}-halftone.png`);
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
          });
          const data = canvas.toDataURL("image/png").split(",")[1];
          zip.file(
            `${cleanName(sourceName)}-${PLATE_META[plate].short}-plate.png`,
            data,
            { base64: true },
          );
        }
        zip.file(
          "job-settings.json",
          JSON.stringify({ source: sourceName, settings, registration }, null, 2),
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

  const stages: Stage[] = [
    {
      id: "artwork",
      number: "01",
      label: "Artwork",
      complete: Boolean(source),
    },
    {
      id: "screen",
      number: "02",
      label: "Screen",
      complete: false,
    },
    {
      id: "separation",
      number: "03",
      label: "Separation",
      complete: false,
    },
    {
      id: "output",
      number: "04",
      label: "Output",
      complete: false,
    },
  ];

  function jumpToStage(id: string) {
    setActiveStage(id);
    document.getElementById(id)?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
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
              {exporting ? <span className="spinner" /> : <Download size={16} />}
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

      <section className="workspace">
        <aside className="inspector">
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
            <button className="icon-button" title="Collapse panel" aria-label="Collapse panel">
              <PanelLeftClose size={18} />
            </button>
          </div>

          <section className="control-step" id="artwork">
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
          </section>

          <section className="control-step" id="screen">
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
                hint="Shifts overall coverage toward more ink or more paper."
                onChange={(value) => updateSetting("exposure", value / 100)}
              />
            </div>
          </section>

          <section className="control-step" id="separation">
            <p className="control-note">
              Set each 0–359° screen angle in the persistent plate rail beside
              the proof.
            </p>
          </section>

          <section className="control-step final-step" id="output">
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
              hint="Changes the opacity of every plate in the composite proof."
              onChange={(value) => updateSetting("opacity", value / 100)}
            />
          </section>
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
            <span className="active-plate-label" data-testid="active-plate-label">
              Viewing: {activePlate === "composite" ? "Composite" : PLATE_META[activePlate].label}
            </span>
            <div className="view-status">
              <Sparkles size={14} />
              <span>Live browser preview</span>
            </div>
          </div>

          <div className="stage-body">
            <InkRail
              activePlate={activePlate}
              settings={settings}
              onSolo={handleSolo}
              onToggleVisible={handleToggleVisible}
              onAngleChange={handleAngleChange}
            />

            <div className="canvas-scroll">
              <div
                className="artboard-wrap"
                style={{
                  width: `${zoom}%`,
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                }}
                onDoubleClick={() => setZoom(76)}
              >
                <canvas ref={canvasRef} aria-label="Live CMYK halftone preview" />
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

function cleanName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
