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

type RenderOptions = {
  plate?: Plate;
  width?: number;
  height?: number;
  paper?: string;
  registration?: boolean;
  monochromePlate?: boolean;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function coverageFor(
  plate: Exclude<Plate, "composite">,
  red: number,
  green: number,
  blue: number,
  settings: HalftoneSettings,
) {
  let value = 0;
  if (plate === "cyan") value = 1 - red / 255;
  if (plate === "magenta") value = 1 - green / 255;
  if (plate === "yellow") value = 1 - blue / 255;
  if (plate === "black") {
    value = Math.min(1 - red / 255, 1 - green / 255, 1 - blue / 255);
  }

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
  monochrome: boolean,
) {
  if (!settings.visible[plate]) return;

  const meta = PLATE_META[plate];
  const angle = (settings.angles[plate] * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const cell = Math.max(3, settings.cellSize * scale);
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
  const width = Math.max(1, Math.round(options.width ?? naturalWidth));
  const height = Math.max(1, Math.round(options.height ?? naturalHeight));
  const plate = options.plate ?? "composite";

  target.width = width;
  target.height = height;
  const context = target.getContext("2d", { alpha: false });
  if (!context) return;

  context.fillStyle = options.paper ?? "#eeeae0";
  context.fillRect(0, 0, width, height);

  const sampleCanvas = document.createElement("canvas");
  const sampleScale = Math.min(1, 1100 / Math.max(width, height));
  sampleCanvas.width = Math.max(1, Math.round(width * sampleScale));
  sampleCanvas.height = Math.max(1, Math.round(height * sampleScale));
  const sampleContext = sampleCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!sampleContext) return;
  sampleContext.drawImage(source, 0, 0, sampleCanvas.width, sampleCanvas.height);
  const pixels = sampleContext.getImageData(
    0,
    0,
    sampleCanvas.width,
    sampleCanvas.height,
  );
  const renderScale = width / naturalWidth;

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
