/** Four-step browser workflow from 1906158, backed by the retained engine API. */
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Download, Eye, EyeOff, FolderOpen } from "lucide-react";
import SessionBadge from "../auth/SessionBadge";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import { useStudioApi } from "../workspace/studio-api";
import { HalftonePanel } from "../workspace/panels/HalftonePanel";
import { DiffusionPanel } from "../workspace/panels/DiffusionPanel";
import { GlitchPanel } from "../workspace/panels/GlitchPanel";
import { CMYK_PRESETS } from "../workspace/panels/cmyk-presets";
import type { ExportTarget } from "../export/targets";
import { DOCUMENT_DPI, SHEET_SIZES, type SheetSizeId } from "./document-model";
import { PLATES, PLATE_META } from "./halftone";
import NumericField from "./NumericField";
import "./browser-workflow.css";

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="browser-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

/** All tabs stay keyboard-reachable, as native buttons with explicit pressed state. */
export function PreviewTabs() {
  const api = useStudioApi();
  return <div className="browser-plate-tabs" role="group" aria-label="Preview plate">
    {(["composite", ...PLATES] as const).map((plate) => <button key={plate} type="button"
      aria-pressed={api.activePlate === plate}
      disabled={api.settings.grayscale && plate !== "black" && plate !== "composite"}
      onClick={() => api.soloPlate(plate)}>{plate === "composite" ? "Composite" : PLATE_META[plate].short}</button>)}
  </div>;
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <section className="browser-step" aria-labelledby={`browser-step-${number}`}>
    <h2 id={`browser-step-${number}`}><span>{number}</span>{title}</h2>{children}
  </section>;
}

export function BrowserWorkflow({ canvas }: { canvas: ReactNode }) {
  const api = useStudioApi();
  const { settings, documentSettings: doc } = api;
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const state = useSyncExternalStore(
    (listener) => api.exportSession.subscribe(listener),
    () => api.exportSession.getState(),
  );
  const targets: Array<[string, ExportTarget]> = [
    ["Composite PNG", { kind: "composite", format: "png" }],
    ["Composite JPG", { kind: "composite", format: "jpeg" }],
    ["Composite TIFF", { kind: "composite", format: "tiff" }],
    [settings.grayscale ? "Grayscale K plate package" : "CMYK plate package", { kind: "plate-package", format: "png" }],
    ["Vector SVG plate package", { kind: "plate-package", format: "svg" }],
  ];
  function exportArtwork(target: ExportTarget) {
    if (state.run) return;
    const block = api.exportPipeline.evaluate(target).find((issue) => issue.severity === "block");
    if (block) { setExportError(block.message); return; }
    setExportError(null);
    // Keep the existing quick-export contract: preflight blocks enforced,
    // then the same session-owned cancellable, bounded delivery pipeline.
    api.exportSession.start(target, (chosen, hooks) => api.exportPipeline.start(chosen, hooks));
    if (exportMenu.current) exportMenu.current.open = false;
  }
  const registrationEnabled = api.output.registrationOnPlates || api.output.registrationOnComposite;
  return <>
    <header className="browser-topbar">
      <div><strong>{PRODUCT_NAME}</strong><small>{PRODUCT_TAGLINE}</small></div>
      <span className="browser-source" title={api.sourceName}>{api.sourceName} · Local session</span>
      <nav aria-label="Application actions">
        <button type="button" onClick={api.requestArtworkFile}><FolderOpen size={16} />Open artwork</button>
        <details className="browser-export-menu" ref={exportMenu}>
          <summary><Download size={16} />{state.run ? "Preparing…" : "Export"}</summary>
          <div>{targets.map(([label, target]) => <button key={label} type="button" disabled={state.run !== null}
            onClick={() => exportArtwork(target)}>{label}</button>)}</div>
        </details>
      </nav>
    </header>
    <div className="browser-layout">
      <aside className="browser-inspector" aria-label="Separation controls">
        <h1>Build your separation</h1>
        <SessionBadge />
        <Step number={1} title="Artwork">
          <button className="browser-upload" onClick={api.requestArtworkFile}>
            <strong>{api.sourceName}</strong><small>{api.sourceMeta}</small><span>Replace artwork</span>
          </button>
          <label className="select-field"><span>Sheet size</span><select value={doc.sheetSize}
            onChange={(event) => api.updateDocument({ sheetSize: event.target.value as SheetSizeId })}>
            {SHEET_SIZES.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.label}</option>)}
          </select></label>
          <label className="select-field"><span>Orientation</span><select value={doc.orientation}
            onChange={(event) => api.updateDocument({ orientation: event.target.value as "portrait" | "landscape" })}>
            <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
          </select></label>
          <NumericField id="artworkScale" label="Scale" value={doc.scalePercent} min={10} max={400} step={1} unit="%" onChange={(scalePercent) => api.updateDocument({ scalePercent })} />
          <button type="button" onClick={api.fitArtworkToSheet}>Fit artwork to sheet</button>
          <Toggle label="Mirror artwork" checked={doc.mirrorImage} onChange={(mirrorImage) => api.updateDocument({ mirrorImage })} />
          {doc.mirrorImage && <label className="select-field"><span>Mirror direction</span><select value={doc.mirrorDirection}
            onChange={(event) => api.updateDocument({ mirrorDirection: event.target.value as "horizontal" | "vertical" })}>
            <option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
          </select></label>}
          <label className="select-field"><span>Proof background</span><select value={doc.background}
            onChange={(event) => api.updateDocument({ background: event.target.value as "white" | "black" })}>
            <option value="white">White</option><option value="black">Black</option>
          </select></label>
          <small>{api.outputDimensions.width} × {api.outputDimensions.height} px · {DOCUMENT_DPI} DPI</small>
        </Step>
        <Step number={2} title="Screen">
          <HalftonePanel />
          <details><summary>Diffusion</summary><DiffusionPanel /></details>
          <details><summary>Glitch</summary><GlitchPanel /></details>
        </Step>
        <Step number={3} title="Plate angles">
          <Toggle label="Grayscale (K only)" checked={settings.grayscale ?? false} onChange={(value) => api.updateSetting("grayscale", value)} />
          <label className="select-field"><span>Angle preset</span><select defaultValue="" disabled={settings.grayscale}
            onChange={(event) => { const preset = CMYK_PRESETS.find((item) => item.id === event.target.value); if (preset) api.setAngles({ ...preset.angles }); event.target.value = ""; }}>
            <option value="">Choose angles…</option>{CMYK_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select></label>
          {PLATES.map((plate) => <div className="browser-plate-row" key={plate}>
            <label className="browser-visibility"><input type="checkbox" aria-label={`${PLATE_META[plate].label} visible`}
              checked={settings.visible[plate]} disabled={settings.grayscale && plate !== "black"}
              onChange={() => api.togglePlateVisible(plate)} />{settings.visible[plate] ? <Eye size={16} /> : <EyeOff size={16} />}</label>
            <NumericField id={`angle-${plate}`} label={`${PLATE_META[plate].label} angle`} value={settings.angles[plate]}
              min={0} max={359.9} step={0.1} unit="°" disabled={settings.grayscale && plate !== "black"}
              onChange={(angle) => api.setPlateAngle(plate, angle)} />
          </div>)}
        </Step>
        <Step number={4} title="Output">
          <NumericField id="inkDensity" label="Ink density" value={settings.opacity} min={0} max={1} step={0.01} onChange={(value) => api.updateSetting("opacity", value)} />
          <Toggle label="Invert dots" checked={api.output.polarity === "negative"} onChange={(negative) => api.updateOutput({ polarity: negative ? "negative" : "positive" })} />
          <Toggle label="Press mirror" checked={api.output.pressMirror} onChange={(pressMirror) => api.updateOutput({ pressMirror })} />
          <Toggle label="Registration on plate packages" checked={api.output.registrationOnPlates} onChange={api.setRegistrationEnabled} />
          <Toggle label="Registration on composite" checked={api.output.registrationOnComposite} onChange={api.setCompositeRegistration} />
          <label className="select-field"><span>Registration layout</span><select value={api.registrationMode} disabled={!registrationEnabled}
            onChange={(event) => api.setRegistrationMode(event.target.value as "corners" | "centered")}>
            <option value="corners">Four corners</option><option value="centered">Top / bottom centered</option>
          </select></label>
          <NumericField id="registrationSize" label="Registration size" value={api.registrationSize} min={20} max={600} step={1} unit="px" disabled={!registrationEnabled} onChange={api.setRegistrationSize} />
          <NumericField id="registrationOffset" label="Registration offset" value={api.registrationOffset} min={10} max={1000} step={1} unit="px" disabled={!registrationEnabled} onChange={api.setRegistrationOffset} />
          <NumericField id="registrationWeight" label="Registration weight" value={api.registrationWeight} min={1} max={20} step={0.5} unit="px" disabled={!registrationEnabled} onChange={api.setRegistrationWeight} />
          <button type="button" onClick={api.requestRegistrationFile}>{api.registrationShape ? "Replace registration SVG" : "Import registration SVG"}</button>
          {api.registrationShape && <small>{api.registrationShape.filename}</small>}
          <p>{api.enabledPlates.length}/{api.applicablePlates.length} plates enabled · {api.preflight.screenLoad.marks.toLocaleString("en-US")} estimated marks per plate</p>
          {api.preflight.hiddenPlates.length > 0 && <p>Hidden plates: {api.preflight.hiddenPlates.map((plate) => PLATE_META[plate].short).join(", ")}</p>}
          {api.preflight.sharedAngleGroups.length > 0 && <p>Some plates share a screen angle. Check the composite proof for moiré.</p>}
          <button type="button" onClick={api.copyJobTicket}>Copy job ticket</button>
          <button type="button" onClick={api.resetOutput}>Reset output controls</button>
          <div className="browser-output-buttons">{targets.map(([label, target]) => <button key={label} type="button" disabled={state.run !== null} onClick={() => exportArtwork(target)}>{label}</button>)}</div>
        </Step>
      </aside>
      {canvas}
    </div>
    {state.run && <div className="browser-export-progress" role="status">
      <label>Export progress <progress max={1} value={state.run.progress} /></label>
      <button type="button" onClick={() => api.exportSession.cancel()}>Cancel Export</button>
    </div>}
    {exportError && <div className="browser-export-error" role="alert">{exportError}<button type="button" onClick={() => setExportError(null)}>Dismiss export error</button></div>}
  </>;
}
