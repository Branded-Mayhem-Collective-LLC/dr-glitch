import {
  calculateArtworkPlacement,
  getSheetPixelDimensions,
  type DocumentSettings,
} from "./document-model";

export type Plate = "composite" | "cyan" | "magenta" | "yellow" | "black";
export type DotShape = "round" | "square" | "diamond" | "line";

export type HalftoneSettings = {
  cellSize: number;
  contrast: number;
  exposure: number;
  opacity: number;
  dotShape: DotShape;
  invert: boolean;
  angles: Record<Exclude<Plate, "composite">, number>;
  visible: Record<Exclude<Plate, "composite">, boolean>;
};

export const PLATES: Exclude<Plate, "composite">[] = [
  "cyan",
  "magenta",
  "yellow",
  "black",
];

export const PLATE_META = {
  cyan: { label: "Cyan", short: "C", color: "#00a9c8" },
  magenta: { label: "Magenta", short: "M", color: "#e53578" },
  yellow: { label: "Yellow", short: "Y", color: "#f0d422" },
  black: { label: "Black", short: "K", color: "#202226" },
} as const;

export const MAX_EXPORT_GRID_POINTS = 2_000_000;

export type RenderOptions = {
  plate?: Plate;
  width?: number;
  height?: number;
  paper?: string;
  registration?: boolean;
  monochromePlate?: boolean;
  document?: DocumentSettings;
  preview?: boolean;
};

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function estimateGridPoints(
  width: number,
  height: number,
  cellSize: number,
  angleDegrees: number,
) {
  const angle = (angleDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const effectiveWidth = width * cos + height * sin;
  const effectiveHeight = width * sin + height * cos;
  const cell = Math.max(1e-6, cellSize);
  const columns = Math.max(1, Math.ceil(effectiveWidth / cell));
  const rows = Math.max(1, Math.ceil(effectiveHeight / cell));

  return columns * rows;
}

export function rgbToCmyk(red: number, green: number, blue: number) {
  const cyan = 1 - clamp(red, 0, 255) / 255;
  const magenta = 1 - clamp(green, 0, 255) / 255;
  const yellow = 1 - clamp(blue, 0, 255) / 255;
  const black = Math.min(cyan, magenta, yellow);

  return {
    cyan: clamp(cyan - black),
    magenta: clamp(magenta - black),
    yellow: clamp(yellow - black),
    black,
  };
}

export function coverageFor(
  plate: Exclude<Plate, "composite">,
  red: number,
  green: number,
  blue: number,
  settings: HalftoneSettings,
) {
  const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
  if (luminance >= 250) return 0;

  let value = rgbToCmyk(red, green, blue)[plate];

  if (value === 0 && !settings.invert) return 0;

  value = (value - 0.5) * settings.contrast + 0.5 + settings.exposure;
  value = clamp(value);
  return settings.invert ? 1 - value : value;
}

function drawDot(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  shape: DotShape,
) {
  if (size <= 0.12) return;

  const radius = size / 2;
  context.beginPath();

  if (shape === "square") {
    context.rect(x - radius, y - radius, size, size);
  } else if (shape === "diamond") {
    context.moveTo(x, y - radius);
    context.lineTo(x + radius, y);
    context.lineTo(x, y + radius);
    context.lineTo(x - radius, y);
    context.closePath();
  } else if (shape === "line") {
    context.roundRect(x - radius, y - size * 0.16, size, size * 0.32, size * 0.16);
  } else {
    context.arc(x, y, radius, 0, Math.PI * 2);
  }

  context.fill();
}

function drawRegistration(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const inset = Math.max(14, Math.round(Math.min(width, height) * 0.035));
  const size = Math.max(7, Math.round(Math.min(width, height) * 0.014));
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.7;
  context.strokeStyle = "#121416";
  context.lineWidth = Math.max(1, width / 900);

  for (const [x, y] of [
    [inset, inset],
    [width - inset, inset],
    [inset, height - inset],
    [width - inset, height - inset],
  ]) {
    context.beginPath();
    context.arc(x, y, size * 0.58, 0, Math.PI * 2);
    context.moveTo(x - size, y);
    context.lineTo(x + size, y);
    context.moveTo(x, y - size);
    context.lineTo(x, y + size);
    context.stroke();
  }
  context.restore();
}

function renderPlateDots(
  context: CanvasRenderingContext2D,
  pixels: ImageData,
  plate: Exclude<Plate, "composite">,
  settings: HalftoneSettings,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  minimumCellSize: number,
  monochrome: boolean,
) {
  if (!settings.visible[plate]) return;

  const meta = PLATE_META[plate];
  const angle = (settings.angles[plate] * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const cell = Math.max(minimumCellSize, settings.cellSize * scale);
  const half = diagonal / 2 + cell;
  const centerX = width / 2;
  const centerY = height / 2;

  context.save();
  context.fillStyle = monochrome ? "#111214" : meta.color;
  context.globalAlpha = settings.opacity;
  context.globalCompositeOperation = monochrome ? "source-over" : "multiply";

  for (let u = -half; u <= half; u += cell) {
    for (let v = -half; v <= half; v += cell) {
      const x = centerX + u * cos - v * sin;
      const y = centerY + u * sin + v * cos;
      if (x < -cell || y < -cell || x > width + cell || y > height + cell) continue;

      const sampleX = Math.min(
        sourceWidth - 1,
        Math.max(0, Math.round((x / width) * sourceWidth)),
      );
      const sampleY = Math.min(
        sourceHeight - 1,
        Math.max(0, Math.round((y / height) * sourceHeight)),
      );
      const index = (sampleY * sourceWidth + sampleX) * 4;
      const coverage = coverageFor(
        plate,
        pixels.data[index],
        pixels.data[index + 1],
        pixels.data[index + 2],
        settings,
      );
      const dotSize = cell * Math.sqrt(coverage) * 1.04;
      drawDot(context, x, y, dotSize, settings.dotShape);
    }
  }

  context.restore();
}

function getDocumentTargetDimensions(
  documentWidth: number,
  documentHeight: number,
  width?: number,
  height?: number,
) {
  let scale = 1;

  if (width !== undefined && height !== undefined) {
    scale = Math.min(width / documentWidth, height / documentHeight);
  } else if (width !== undefined) {
    scale = width / documentWidth;
  } else if (height !== undefined) {
    scale = height / documentHeight;
  }

  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  return {
    width: Math.max(1, Math.round(documentWidth * scale)),
    height: Math.max(1, Math.round(documentHeight * scale)),
  };
}

function drawDocumentArtwork(
  context: CanvasRenderingContext2D,
  source: HTMLImageElement | HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
  document: DocumentSettings,
  documentWidth: number,
  documentHeight: number,
  sampleWidth: number,
  sampleHeight: number,
) {
  const placement = calculateArtworkPlacement({
    sourceWidth,
    sourceHeight,
    sheetWidth: documentWidth,
    sheetHeight: documentHeight,
    scalePercent: document.scalePercent,
    offsetX: document.offsetX,
    offsetY: document.offsetY,
  });
  const scaleX = sampleWidth / documentWidth;
  const scaleY = sampleHeight / documentHeight;
  const x = placement.x * scaleX;
  const y = placement.y * scaleY;
  const width = placement.width * scaleX;
  const height = placement.height * scaleY;

  context.save();

  if (document.mirrorImage) {
    if (document.mirrorDirection === "horizontal") {
      context.translate(x + width, y);
      context.scale(-1, 1);
    } else {
      context.translate(x, y + height);
      context.scale(1, -1);
    }
    context.drawImage(source, 0, 0, width, height);
  } else {
    context.drawImage(source, x, y, width, height);
  }

  context.restore();
}

export function renderHalftone(
  source: HTMLImageElement | HTMLCanvasElement,
  target: HTMLCanvasElement,
  settings: HalftoneSettings,
  options: RenderOptions = {},
) {
  const naturalWidth =
    source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const naturalHeight =
    source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const documentDimensions = options.document
    ? getSheetPixelDimensions(
        options.document.sheetSize,
        options.document.orientation,
      )
    : null;
  const targetDimensions = documentDimensions
    ? getDocumentTargetDimensions(
        documentDimensions.width,
        documentDimensions.height,
        options.width,
        options.height,
      )
    : {
        width: Math.max(1, Math.round(options.width ?? naturalWidth)),
        height: Math.max(1, Math.round(options.height ?? naturalHeight)),
      };
  const { width, height } = targetDimensions;
  const plate = options.plate ?? "composite";

  target.width = width;
  target.height = height;
  const context = target.getContext("2d", { alpha: false });
  if (!context) return;

  context.fillStyle = options.paper ?? "#eeeae0";
  context.fillRect(0, 0, width, height);

  const sampleCanvas = document.createElement("canvas");
  const sampleScale = options.preview
    ? Math.min(1, 1100 / Math.max(width, height))
    : 1;
  sampleCanvas.width = Math.max(1, Math.round(width * sampleScale));
  sampleCanvas.height = Math.max(1, Math.round(height * sampleScale));
  const sampleContext = sampleCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!sampleContext) return;

  if (options.document && documentDimensions) {
    sampleContext.fillStyle = "#ffffff";
    sampleContext.fillRect(0, 0, sampleCanvas.width, sampleCanvas.height);
    drawDocumentArtwork(
      sampleContext,
      source,
      naturalWidth,
      naturalHeight,
      options.document,
      documentDimensions.width,
      documentDimensions.height,
      sampleCanvas.width,
      sampleCanvas.height,
    );
  } else {
    sampleContext.drawImage(source, 0, 0, sampleCanvas.width, sampleCanvas.height);
  }

  const pixels = sampleContext.getImageData(
    0,
    0,
    sampleCanvas.width,
    sampleCanvas.height,
  );
  const renderScale = documentDimensions
    ? width / documentDimensions.width
    : width / naturalWidth;
  const minimumCellSize = documentDimensions
    ? options.preview
      ? 3
      : 0.01
    : 3;

  const activePlates = plate === "composite" ? PLATES : [plate];
  for (const activePlate of activePlates) {
    renderPlateDots(
      context,
      pixels,
      activePlate,
      settings,
      width,
      height,
      sampleCanvas.width,
      sampleCanvas.height,
      renderScale,
      minimumCellSize,
      Boolean(options.monochromePlate && plate !== "composite"),
    );
  }

  if (options.registration) drawRegistration(context, width, height);
}

export function createDemoArtwork() {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  const gradient = context.createLinearGradient(0, 0, 1200, 900);
  gradient.addColorStop(0, "#ff6b35");
  gradient.addColorStop(0.48, "#f7c948");
  gradient.addColorStop(1, "#0a87a9");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 900);

  context.fillStyle = "#f6efe2";
  context.beginPath();
  context.arc(610, 430, 285, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#16212d";
  context.font = "800 155px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText("PRINT", 600, 420);
  context.fillText("LOUD", 600, 570);

  context.strokeStyle = "#f15a29";
  context.lineWidth = 34;
  context.beginPath();
  context.arc(610, 430, 340, 0.15, Math.PI * 1.6);
  context.stroke();

  context.fillStyle = "#e42f67";
  context.beginPath();
  context.arc(1020, 150, 105, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#07aabd";
  context.fillRect(80, 640, 190, 190);
  return canvas;
}
