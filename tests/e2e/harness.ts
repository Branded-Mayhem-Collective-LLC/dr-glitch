import { createDemoArtwork, renderHalftone, PLATES, type HalftoneSettings } from "../../src/studio/halftone";

const settings: HalftoneSettings = {
  cellSize: 12,
  frayedXEdge: 0,
  frayedYEdge: 0,
  opacity: 0.84,
  dotShape: "round",
  invert: false,
  angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
  visible: { cyan: true, magenta: true, yellow: true, black: true },
};

declare global {
  interface Window { renderAll: () => Record<string, string>; }
}

window.renderAll = () => {
  const source = createDemoArtwork();
  const target = document.getElementById("target") as HTMLCanvasElement;
  const out: Record<string, string> = {};
  for (const plate of ["composite", ...PLATES] as const) {
    renderHalftone(source, target, settings, {
      plate, width: 320, height: 320, registration: false,
    });
    out[plate] = target.toDataURL("image/png");
  }
  return out;
};
