"use client";

import {
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
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
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import InkRail from "./InkRail";
import { CHROME_INK, COMPOSITE_INK } from "./inks";
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

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span className="range-label">
        <span>{label}</span>
        <output>
          {Number.isInteger(value) ? value : value.toFixed(2)}
          {suffix}
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function StepHeader({
  number,
  title,
  complete,
}: {
  number: string;
  title: string;
  complete?: boolean;
}) {
  return (
    <div className="step-header">
      <span className={`step-number ${complete ? "complete" : ""}`}>
        {complete ? <Check size={13} /> : number}
      </span>
      <span>{title}</span>
    </div>
  );
}

export default function HalftoneStudio() {
  const [source, setSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(
    null,
  );
  const [sourceName, setSourceName] = useState("DRC sample artwork");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activePlate, setActivePlate] = useState<Plate>("composite");
  const [zoom, setZoom] = useState(76);
  const [registration, setRegistration] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const renderFrame = useRef<number | null>(null);

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

  const handleToggleVisible = useCallback(
    (plate: Exclude<Plate, "composite">) => {
      setSettings((current) => ({
        ...current,
        visible: { ...current.visible, [plate]: !current.visible[plate] },
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
          <div className="inspector-heading">
            <div>
              <span className="eyebrow">Recipe</span>
              <h1>Build your separation</h1>
            </div>
            <button className="icon-button" title="Collapse panel" aria-label="Collapse panel">
              <PanelLeftClose size={18} />
            </button>
          </div>

          <section className="control-step">
            <StepHeader number="1" title="Artwork" complete={Boolean(source)} />
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

          <section className="control-step">
            <StepHeader number="2" title="Screen" />
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
              <RangeControl
                label="Cell size"
                value={settings.cellSize}
                min={5}
                max={28}
                step={1}
                suffix=" px"
                onChange={(value) => updateSetting("cellSize", value)}
              />
              <RangeControl
                label="Contrast"
                value={settings.contrast}
                min={0.5}
                max={2}
                step={0.05}
                suffix="×"
                onChange={(value) => updateSetting("contrast", value)}
              />
              <RangeControl
                label="Exposure"
                value={settings.exposure}
                min={-0.3}
                max={0.3}
                step={0.01}
                onChange={(value) => updateSetting("exposure", value)}
              />
            </div>
          </section>

          <section className="control-step">
            <StepHeader number="3" title="Plate angles" />
            <div className="plate-list">
              {PLATES.map((plate) => {
                const meta = PLATE_META[plate];
                return (
                  <div className="plate-row" key={plate}>
                    <button
                      className="visibility-button"
                      title={`${settings.visible[plate] ? "Hide" : "Show"} ${meta.label}`}
                      aria-label={`${settings.visible[plate] ? "Hide" : "Show"} ${meta.label}`}
                      onClick={() =>
                        updateSetting("visible", {
                          ...settings.visible,
                          [plate]: !settings.visible[plate],
                        })
                      }
                    >
                      {settings.visible[plate] ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                    <span
                      className="plate-swatch"
                      style={{ background: meta.color }}
                      aria-hidden="true"
                    >
                      {meta.short}
                    </span>
                    <span className="plate-name">{meta.label}</span>
                    <label className="angle-field">
                      <input
                        type="number"
                        min={0}
                        max={90}
                        value={settings.angles[plate]}
                        onChange={(event) =>
                          updateSetting("angles", {
                            ...settings.angles,
                            [plate]: Number(event.target.value),
                          })
                        }
                      />
                      <span>°</span>
                    </label>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="control-step final-step">
            <StepHeader number="4" title="Output" />
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
            <RangeControl
              label="Ink density"
              value={settings.opacity}
              min={0.35}
              max={1}
              step={0.01}
              onChange={(value) => updateSetting("opacity", value)}
            />
          </section>
        </aside>

        <section
          className={`canvas-stage ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={onDrop}
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
            />

            <div className="canvas-scroll">
              <div
                className="artboard-wrap"
                style={{ width: `${zoom}%` }}
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
              <input
                type="range"
                min={35}
                max={110}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                aria-label="Preview zoom"
              />
              <button
                className="icon-button"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => setZoom((value) => Math.min(110, value + 8))}
              >
                <ZoomIn size={17} />
              </button>
              <output>{zoom}%</output>
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
