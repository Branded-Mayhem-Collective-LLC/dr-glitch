import { useEffect, useRef, useState } from "react";
import { customShapeStamp, importCustomShape, prepareCustomShape } from "./custom-shape";
import type { CustomShapeAsset } from "./custom-shape-data";

type Props = {
  current?: CustomShapeAsset;
  onApply: (shape: CustomShapeAsset) => void;
  onCancel: () => void;
};

export default function CustomShapeDialog({ current, onApply, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const request = useRef(0);
  const [candidate, setCandidate] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      request.current++;
      element.close();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const target = canvas.current;
    if (!target) return;
    const context = target.getContext("2d")!;
    context.clearRect(0, 0, target.width, target.height);
    if (candidate) {
      prepareCustomShape(candidate).then(() => {
        if (cancelled) return;
        const stamp = customShapeStamp(candidate, "#101010", target.width);
        context.drawImage(stamp, 0, 0, target.width, target.height);
      }).catch(() => { if (!cancelled) setError("The SVG preview could not be prepared."); });
    }
    return () => { cancelled = true; };
  }, [candidate]);

  async function selectFile(file?: File) {
    if (!file) return;
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const shape = await importCustomShape(file);
      if (id === request.current) setCandidate(shape);
    } catch (reason) {
      if (id === request.current) setError(reason instanceof Error ? reason.message : "This SVG could not be imported.");
    } finally { if (id === request.current) setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="custom-shape-dialog" aria-labelledby="custom-shape-title"
      aria-describedby="custom-shape-description"
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.shiftKey) return;
        if (document.activeElement === useButton.current) {
          event.preventDefault();
          chooseButton.current?.focus();
        }
      }}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2 id="custom-shape-title">Import custom shape</h2>
      <p id="custom-shape-description">Choose an SVG to repeat as your halftone dot. Empty margins are trimmed and the shape stretches to fill a square.</p>
      <div className="custom-shape-drop" data-testid="custom-shape-drop"
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void selectFile(event.dataTransfer.files[0]); }}>
        <button ref={chooseButton} type="button" className="button secondary" autoFocus onClick={() => picker.current?.click()}>Choose SVG</button>
        <p>or drop an .svg file here · up to 1 MB</p>
      </div>
      <input ref={picker} type="file" accept=".svg,image/svg+xml" hidden data-testid="custom-shape-file"
        onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ""; }} />
      <div className="custom-shape-preview">
        <canvas ref={canvas} width={240} height={240} aria-label="Custom dot shape preview" />
        <span data-testid="custom-shape-filename">{candidate?.filename ?? "No shape selected"}</span>
      </div>
      {busy && <p role="status">Preparing SVG preview…</p>}
      {error && <p className="custom-shape-error" role="alert">{error}</p>}
      <div className="custom-shape-actions">
        <button type="button" className="button secondary" onClick={onCancel}>Cancel</button>
        <button ref={useButton} type="button" className="button primary" disabled={!candidate || busy || Boolean(error)}
          onClick={() => { if (candidate) onApply(candidate); }}>Use shape</button>
      </div>
    </dialog>
  );
}
