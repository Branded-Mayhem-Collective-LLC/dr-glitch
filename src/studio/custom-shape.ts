import type { CustomShapeAsset } from "./custom-shape-data";

type Bounds = { x: number; y: number; width: number; height: number };
type Prepared = { svg: string; image: HTMLImageElement; stamps: Map<string, HTMLCanvasElement> };
// Active settings retain their assets; abandoned candidates can be collected.
const prepared = new WeakMap<CustomShapeAsset, Prepared>();
const preparing = new WeakMap<CustomShapeAsset, Promise<void>>();
const ANALYSIS_SIZE = 2048;

function withBounds(svg: string, bounds: Bounds) {
  return svg.replace(/viewBox="[^"]*"/, `viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"`);
}

async function loadSvg(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { image.src = ""; reject(new Error("SVG preview took too long. Simplify the shape and try again.")); }, 10_000);
      image.onload = () => { window.clearTimeout(timeout); resolve(); };
      image.onerror = () => { window.clearTimeout(timeout); reject(new Error("This SVG could not be rendered. Export it as plain SVG and try again.")); };
      image.src = url;
    });
    return image;
  } finally { URL.revokeObjectURL(url); }
}

/** Measure reconstructed geometry in an isolated tree, never uploaded markup. */
function geometryBounds(svg: string): Bounds {
  const parsed = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:1024px;height:1024px;opacity:0;pointer-events:none";
  host.setAttribute("aria-hidden", "true");
  host.attachShadow({ mode: "closed" }).appendChild(root);
  document.body.appendChild(host);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  try {
    const inverse = root.getCTM()!.inverse();
    for (const shape of root.querySelectorAll<SVGGraphicsElement>("path,rect,circle,ellipse,polygon,polyline,line")) {
      const style = getComputedStyle(shape);
      if (style.display === "none" || style.visibility !== "visible") continue;
      const bounds = shape.getBBox();
      const ctm = shape.getCTM();
      if (!ctm) continue;
      const matrix = inverse.multiply(ctm);
      // Conservative stroke bounds; the subsequent alpha scan removes padding.
      const stroke = style.stroke === "none" ? 0 : parseFloat(style.strokeWidth);
      const padding = stroke * Math.max(1, Number(style.strokeMiterlimit) || 4) / 2;
      for (const x of [bounds.x - padding, bounds.x + bounds.width + padding]) {
        for (const y of [bounds.y - padding, bounds.y + bounds.height + padding]) {
          const point = new DOMPoint(x, y).matrixTransform(matrix);
          minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
          minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
        }
      }
    }
  } finally { host.remove(); }
  const width = maxX - minX, height = maxY - minY;
  if (![minX, minY, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || Math.max(width, height) > 1e9) {
    throw new Error("This SVG has no visible two-dimensional shape. Add a fill or stroke before importing.");
  }
  return { x: minX, y: minY, width, height };
}

/**
 * Import an SVG as a custom dot / registration shape.
 *
 * Intake first runs the studio's permissive reconstruction (viewBox
 * defaulting, solid-black paint normalization, whitespace trim), then the
 * STORED markup is validated against the STRICT src/io sanitizer profile —
 * the exact validator .drglitch import applies — so every shape the studio
 * accepts is guaranteed to re-import cleanly from a project archive.
 * Shapes the archive sanitizer would refuse (CSS display/visibility,
 * inherit paints, …) are rejected at import time with the sanitizer's own
 * message instead of failing later on re-open.
 */
export async function importCustomShape(
  file: File,
  profile: "custom-dot" | "registration-mark" = "custom-dot",
): Promise<CustomShapeAsset> {
  const { checkSvgFile, sanitizeSvg } = await import("./custom-shape-data");
  const { sanitizeSvg: sanitizeStrict } = await import("../io/svg-sanitizer");
  checkSvgFile(file.name, file.size);
  const svg = sanitizeSvg(await file.text());
  const bounds = geometryBounds(svg);
  const image = await loadSvg(withBounds(svg, bounds));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ANALYSIS_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
  const pixels = context.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE).data;
  let minX = ANALYSIS_SIZE, minY = ANALYSIS_SIZE, maxX = -1, maxY = -1;
  for (let y = 0; y < ANALYSIS_SIZE; y++) {
    for (let x = 0; x < ANALYSIS_SIZE; x++) {
      if (pixels[(y * ANALYSIS_SIZE + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error("This SVG has no visible fill or stroke.");
  const tight = {
    x: bounds.x + minX / ANALYSIS_SIZE * bounds.width,
    y: bounds.y + minY / ANALYSIS_SIZE * bounds.height,
    width: (maxX - minX + 1) / ANALYSIS_SIZE * bounds.width,
    height: (maxY - minY + 1) / ANALYSIS_SIZE * bounds.height,
  };
  // CANONICAL AT INGESTION: the asset carries the STRICT sanitizer's
  // reconstructed markup — the exact form the hardened .drglitch exporter
  // demands byte-equality with — so the stored bytes, their SHA-256 asset
  // id, and every project reference are canonical from the start
  // (sanitizeSvg is a fixed point on its own output). The permissive
  // render-form wrapper (custom-shape-data sanitizeSvg: 1024² +
  // preserveAspectRatio="none" stretch) is re-applied at RENDER time by
  // prepareCustomShape, so rasterized stamps are unchanged; the strict
  // root keeps the tight viewBox, which is all the stamp geometry needs.
  const canonical = sanitizeStrict(withBounds(svg, tight), profile).svg;
  const asset = { filename: file.name, svg: canonical };
  await prepareCustomShape(asset);
  return asset;
}

/** Call before rendering imported settings; keeps the hot dot loop synchronous. */
export async function prepareCustomShape(asset: CustomShapeAsset): Promise<void> {
  if (prepared.has(asset)) return;
  const pending = preparing.get(asset);
  if (pending) return pending;
  const promise = import("./custom-shape-data").then(async ({ sanitizeSvg }) => {
    const svg = sanitizeSvg(asset.svg);
    const image = await loadSvg(svg);
    prepared.set(asset, { svg, image, stamps: new Map() });
  });
  preparing.set(asset, promise);
  try { await promise; } finally { preparing.delete(asset); }
}

/** The same sanitized asset used by raster stamps, without loading XML in the initial bundle. */
export function preparedCustomShapeSvg(asset: CustomShapeAsset): string {
  const ready = prepared.get(asset);
  if (!ready) throw new Error("The custom SVG is not ready to render.");
  return ready.svg;
}

export function customShapeStamp(asset: CustomShapeAsset, color: string, maximumDotSize: number, options: { cache?: boolean } = {}): HTMLCanvasElement {
  const ready = prepared.get(asset);
  if (!ready) throw new Error("The custom SVG is not ready to render.");
  // Two samples per output pixel, bounded by the renderer's supported cell sizes.
  const resolution = Math.min(2048, Math.max(16, Math.ceil(maximumDotSize * 2)));
  const key = `${color}:${resolution}`;
  const cached = options.cache === false ? undefined : ready.stamps.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = resolution;
  const context = canvas.getContext("2d")!;
  context.drawImage(ready.image, 0, 0, resolution, resolution);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, resolution, resolution);
  // Avoid retaining a new canvas for every slider position.
  if (options.cache !== false) {
    if (ready.stamps.size >= 12) ready.stamps.delete(ready.stamps.keys().next().value!);
    ready.stamps.set(key, canvas);
  }
  return canvas;
}
