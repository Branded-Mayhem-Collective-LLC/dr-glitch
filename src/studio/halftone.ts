import {
  calculateArtworkPlacement,
  DOCUMENT_DPI,
  getSheetPixelDimensions,
  type DocumentSettings,
} from "./document-model";
import { customShapeStamp } from "./custom-shape";
import type { CustomShapeAsset } from "./custom-shape-data";

export type Plate = "composite" | "cyan" | "magenta" | "yellow" | "black";
export const DOT_SHAPES = ["round", "square", "diamond", "line", "triangle", "cross", "circle-outline", "custom"] as const;
export type DotShape = (typeof DOT_SHAPES)[number];

export type HalftoneSettings = {
  cellSize: number;
  frayedXEdge: number;
  frayedYEdge: number;
  opacity: number;
  dotShape: DotShape;
  invert: boolean;
  /** Optional for compatibility with settings saved before desktop parity. */
  grayscale?: boolean;
  strokeWidth?: number;
  customShape?: CustomShapeAsset;
  angles: Record<Exclude<Plate, "composite">, number>;
  visible: Record<Exclude<Plate, "composite">, boolean>;
  diffusionEnabled?: boolean;
  diffusionAlgorithm?: "none" | "floyd-steinberg" | "jarvis-judice-ninke" | "stucki" | "burkes" | "atkinson";
  diffusionModulation?: "none" | "column" | "row" | "dispersed" | "medium" | "heavy" | "circuit" | "tilt" | "grid";
  diffusionModStrength?: number;
  diffusionIntensity?: number;
  diffusionLevels?: number;
  diffusionSharpenStrength?: number;
  diffusionSharpenRadius?: number;
  diffusionDenoise?: number;
  brokenKernel?: number;
  directionalBias?: number;
  directionalBiasAngle?: number;
  errorOverflow?: number;
  diffusionReset?: number;
  crossChannelBleed?: number;
  sliceShift?: number;
  sliceSize?: number;
  verticalSliceShift?: number;
  verticalSliceSize?: number;
  gridWarp?: number;
  warpScale?: number;
  smearDrag?: number;
  smearLength?: number;
  smearVertical?: boolean;
  macroblockCorrupt?: number;
  macroblockDropout?: number;
  blockShift?: number;
  blockShiftSize?: number;
  channelDesync?: number;
  bitmapSort?: number;
  bitmapSortVertical?: boolean;
};

export const PLATES: Exclude<Plate, "composite">[] = [
  "cyan",
  "magenta",
  "yellow",
  "black",
];

export function processPlates(settings: HalftoneSettings): Exclude<Plate, "composite">[] {
  return settings.grayscale ? ["black"] : PLATES;
}

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
  registrationSize?: number;
  registrationOffset?: number;
  registrationWeight?: number;
  registrationShape?: CustomShapeAsset;
  registrationMode?: "corners" | "centered";
};

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function glitchSamplePoint(x: number, y: number, width: number, height: number, settings: HalftoneSettings) {
  let sampleX = x;
  let sampleY = y;
  const sliceSize = Math.max(2, settings.sliceSize ?? 20);
  const verticalSliceSize = Math.max(2, settings.verticalSliceSize ?? 20);
  if ((settings.sliceShift ?? 0) > 0) {
    const band = Math.floor(y / sliceSize);
    sampleX += ((band * 37) % (settings.sliceShift! * 2 + 1)) - settings.sliceShift!;
  }
  if ((settings.verticalSliceShift ?? 0) > 0) {
    const band = Math.floor(x / verticalSliceSize);
    sampleY += ((band * 53) % (settings.verticalSliceShift! * 2 + 1)) - settings.verticalSliceShift!;
  }
  if ((settings.gridWarp ?? 0) > 0) {
    const scale = Math.max(2, settings.warpScale ?? 100);
    sampleX += Math.sin(y / scale) * settings.gridWarp!;
    sampleY += Math.cos(x / scale) * settings.gridWarp!;
  }
  if ((settings.smearDrag ?? 0) > 0) {
    const distance = ((x * 17 + y * 31) % Math.max(1, settings.smearLength ?? 24)) * settings.smearDrag!;
    if (settings.smearVertical) sampleY += distance;
    else sampleX += distance;
  }
  if ((settings.blockShift ?? 0) > 0) {
    const block = Math.max(4, settings.blockShiftSize ?? 16);
    sampleX += (Math.floor(x / block) % 3 - 1) * settings.blockShift! * block * 2;
    sampleY += (Math.floor(y / block) % 3 - 1) * settings.blockShift! * block * 2;
  }
  if ((settings.channelDesync ?? 0) > 0) sampleX += settings.channelDesync! * Math.max(8, (settings.blockShiftSize ?? 16) * 2);
  return { x: Math.max(0, Math.min(width - 1, Math.round(sampleX))), y: Math.max(0, Math.min(height - 1, Math.round(sampleY))) };
}

function glitchCoverage(coverage: number, x: number, y: number, settings: HalftoneSettings) {
  let result = coverage;
  const corrupt = settings.macroblockCorrupt ?? 0;
  if (corrupt > 0 && ((Math.floor(x / Math.max(4, settings.blockShiftSize ?? 16)) + Math.floor(y / Math.max(4, settings.blockShiftSize ?? 16))) % 10) / 10 < corrupt) {
    if (((x * 19 + y * 7) % 100) / 100 < (settings.macroblockDropout ?? 0.25)) result = 0;
    else result = Math.round(result * 4) / 4;
  }
  if ((settings.bitmapSort ?? 0) > 0 && ((settings.bitmapSortVertical ? x : y) % 9) < settings.bitmapSort! * 9) result = Math.round(result * 5) / 5;
  return clamp(result);
}

function sampleCoverage(field: Float32Array, width: number, height: number, x: number, y: number) {
  const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sampleY = Math.max(0, Math.min(height - 1, Math.round(y)));
  return field[sampleY * width + sampleX];
}

function bitmapSortField(field: Float32Array, width: number, height: number, amount: number, vertical: boolean, seed: number) {
  if (amount <= 0) return field;
  const result = field.slice();
  const lineCount = vertical ? width : height;
  const count = Math.max(1, Math.min(lineCount, Math.floor(lineCount * clamp(amount))));
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const lines = Array.from({ length: lineCount }, (_, index) => index);
  for (let index = lineCount - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [lines[index], lines[swap]] = [lines[swap], lines[index]];
  }
  for (let selected = 0; selected < count; selected += 1) {
    const lineIndex = lines[selected];
    const length = vertical ? height : width;
    const line = Array.from({ length }, (_, offset) => vertical
      ? result[offset * width + lineIndex]
      : result[lineIndex * width + offset]);
    let start = -1;
    const finish = (end: number) => {
      if (start < 0) return;
      line.slice(start, end).sort((left, right) => left - right).forEach((value, offset) => {
        line[start + offset] = value;
      });
      start = -1;
    };
    for (let offset = 0; offset <= length; offset += 1) {
      const active = offset < length && line[offset] > 0.1;
      if (active && start < 0) start = offset;
      if (!active) finish(offset);
    }
    for (let offset = 0; offset < length; offset += 1) {
      if (vertical) result[offset * width + lineIndex] = line[offset];
      else result[lineIndex * width + offset] = line[offset];
    }
  }
  return result;
}

function buildGlitchField(
  field: Float32Array,
  width: number,
  height: number,
  settings: HalftoneSettings,
  channelIndex: number,
) {
  const transformed = new Float32Array(field.length);
  const block = Math.max(4, settings.blockShiftSize ?? 16);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const point = glitchSamplePoint(x, y, width, height, settings);
      const channelShift = (settings.channelDesync ?? 0) * (channelIndex + 1) * block * 2;
      transformed[y * width + x] = sampleCoverage(field, width, height, point.x + channelShift, point.y);
    }
  }

  const corrupt = settings.macroblockCorrupt ?? 0;
  const shift = settings.blockShift ?? 0;
  const dropout = settings.macroblockDropout ?? 0.25;
  const result = transformed.slice();
  for (let y = 0; y < height; y += block) {
    for (let x = 0; x < width; x += block) {
      const hash = (x * 73856093 + y * 19349663 + channelIndex * 83492791) >>> 0;
      const probability = (hash % 1000) / 1000;
      if (corrupt > 0 && probability < corrupt) {
        for (let row = y; row < Math.min(height, y + block); row += 1) {
          for (let column = x; column < Math.min(width, x + block); column += 1) {
            if (probability < dropout * corrupt) result[row * width + column] = 0;
            else result[row * width + column] = Math.round(result[row * width + column] * 4) / 4;
          }
        }
      }
      if (shift > 0) {
        const dx = (((hash >>> 8) % 5) - 2) * shift * block;
        const dy = (((hash >>> 16) % 5) - 2) * shift * block;
        for (let row = y; row < Math.min(height, y + block); row += 1) {
          for (let column = x; column < Math.min(width, x + block); column += 1) {
            result[row * width + column] = sampleCoverage(transformed, width, height, column + dx, row + dy);
          }
        }
      }
    }
  }
  return bitmapSortField(result, width, height, settings.bitmapSort ?? 0, settings.bitmapSortVertical ?? false, 99 + channelIndex * 17);
}

function buildCoverageField(pixels: ImageData, plate: Exclude<Plate, "composite">, settings: HalftoneSettings) {
  const base = new Float32Array(pixels.width * pixels.height);
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const index = (y * pixels.width + x) * 4;
      base[y * pixels.width + x] = coverageFor(plate, pixels.data[index], pixels.data[index + 1], pixels.data[index + 2], settings);
    }
  }
  return applyFrayedEdges(
    buildGlitchField(base, pixels.width, pixels.height, settings, PLATES.indexOf(plate)),
    pixels.width,
    pixels.height,
    settings.frayedXEdge,
    settings.frayedYEdge,
  );
}

function applyFrayedEdges(field: Float32Array, width: number, height: number, xAmount: number, yAmount: number) {
  const result = field.slice();
  const contentRows: number[] = [];
  const contentColumns: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (field[y * width + x] > 0.1) {
        contentRows.push(y);
        break;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      if (field[y * width + x] > 0.1) {
        contentColumns.push(x);
        break;
      }
    }
  }
  if (contentRows.length === 0 || contentColumns.length === 0) return result;

  const maxXShift = Math.floor(Math.max(0, xAmount) * 1.5);
  const maxYShift = Math.floor(Math.max(0, yAmount) * 1.5);
  const frayWidth = Math.max(10, maxXShift * 2);
  const frayHeight = Math.max(10, maxYShift * 2);
  const left = contentColumns[0];
  const right = contentColumns[contentColumns.length - 1];
  const top = contentRows[0];
  const bottom = contentRows[contentRows.length - 1];
  const hash = (value: number) => (Math.imul(value ^ 0x9e3779b9, 2654435761) >>> 0);

  if (xAmount > 0 && maxXShift > 0) {
    for (const y of contentRows) {
      const leftInset = hash(y * 17 + 701) % (maxXShift + 1);
      const rightInset = hash(y * 31 + 907) % (maxXShift + 1);
      if (leftInset > 0 && leftInset < frayWidth) {
        for (let x = left; x < Math.min(width, left + leftInset); x += 1) result[y * width + x] = 0;
      }
      if (rightInset > 0 && rightInset < frayWidth) {
        for (let x = Math.max(0, right - rightInset); x <= right; x += 1) result[y * width + x] = 0;
      }
    }
  }
  if (yAmount > 0 && maxYShift > 0) {
    for (const x of contentColumns) {
      const topInset = hash(x * 17 + 1301) % (maxYShift + 1);
      const bottomInset = hash(x * 31 + 1709) % (maxYShift + 1);
      if (topInset > 0 && topInset < frayHeight) {
        for (let y = top; y < Math.min(height, top + topInset); y += 1) result[y * width + x] = 0;
      }
      if (bottomInset > 0 && bottomInset < frayHeight) {
        for (let y = Math.max(0, bottom - bottomInset); y <= bottom; y += 1) result[y * width + x] = 0;
      }
    }
  }
  return result;
}

function visibleContentBounds(pixels: ImageData) {
  let minX = pixels.width;
  let minY = pixels.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const index = (y * pixels.width + x) * 4;
      const luminance = 0.299 * pixels.data[index] + 0.587 * pixels.data[index + 1] + 0.114 * pixels.data[index + 2];
      if (luminance >= 250) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX
    ? { minX: 0, minY: 0, maxX: pixels.width - 1, maxY: pixels.height - 1 }
    : { minX, minY, maxX, maxY };
}

function diffusionOffset(x: number, y: number, mode: HalftoneSettings["diffusionModulation"], strength: number) {
  if (!mode || mode === "none" || strength <= 0) return 0;
  const column = ((x % 4) - 1.5) / 3;
  const row = ((y % 4) - 1.5) / 3;
  const dispersed = (((x * 17 + y * 31) % 7) - 3) / 3;
  if (mode === "column") return column * strength;
  if (mode === "row") return row * strength;
  if (mode === "dispersed") return dispersed * strength;
  if (mode === "medium") return Math.sin((x + y) * 0.8) * strength;
  if (mode === "heavy") return Math.sin(x * 1.7 + y * 1.3) * strength;
  if (mode === "circuit") return ((x % 6 === 0 ? 1 : 0) - (y % 6 === 0 ? 1 : 0)) * strength;
  if (mode === "tilt") return ((x - y) % 8) / 8 * strength;
  return (((x % 4 === 0 ? 1 : 0) + (y % 4 === 0 ? 1 : 0)) - 0.5) * strength;
}

export function applyDiffusion(value: number, x: number, y: number, settings: HalftoneSettings) {
  if (!settings.diffusionEnabled) return value;
  const intensity = clamp(settings.diffusionIntensity ?? 0.5);
  const levels = Math.max(2, Math.round(settings.diffusionLevels ?? 8));
  const denoise = settings.diffusionDenoise ?? 0;
  const algorithm = settings.diffusionAlgorithm ?? "floyd-steinberg";
  const noise = denoise === 0 ? 0 : (((x * 13 + y * 29) % 11) - 5) / 5 * Math.abs(denoise) * (denoise > 0 ? 1 : -1);
  let adjusted = value + noise + diffusionOffset(x, y, settings.diffusionModulation, (settings.diffusionModStrength ?? 0.5) * 0.25);
  const kernelPattern = algorithm === "none"
    ? 0
    : algorithm === "floyd-steinberg"
      ? ((x + y) % 2 ? 1 : -1)
      : algorithm === "jarvis-judice-ninke"
        ? Math.sin((x * 0.7 + y * 0.4))
        : algorithm === "stucki"
          ? Math.cos((x * 0.5 - y * 0.8))
          : algorithm === "burkes"
            ? ((x % 3) - 1) * 0.8
            : Math.sin((x + y) * 1.4);
  adjusted += kernelPattern * intensity * 0.14;
  const quantized = Math.round(clamp(adjusted) * (levels - 1)) / (levels - 1);
  const sharpenRadius = Math.max(1, settings.diffusionSharpenRadius ?? 1);
  const sharpened = (quantized - 0.5) * (1 + (settings.diffusionSharpenStrength ?? 0) * sharpenRadius / 3) + 0.5;
  return clamp(value * (1 - intensity * 0.35) + sharpened * (intensity * 0.65));
}

function buildDiffusionField(
  pixels: ImageData,
  plate: Exclude<Plate, "composite">,
  settings: HalftoneSettings,
) {
  const result = new Float32Array(pixels.width * pixels.height);
  const kernels: Record<string, Array<[number, number, number]>> = {
    "floyd-steinberg": [[0, 1, 7 / 16], [1, -1, 3 / 16], [1, 0, 5 / 16], [1, 1, 1 / 16]],
    "jarvis-judice-ninke": [[0, 1, 7 / 48], [0, 2, 5 / 48], [1, -2, 3 / 48], [1, -1, 5 / 48], [1, 0, 7 / 48], [1, 1, 5 / 48], [1, 2, 3 / 48], [2, -2, 1 / 48], [2, -1, 3 / 48], [2, 0, 5 / 48], [2, 1, 3 / 48], [2, 2, 1 / 48]],
    stucki: [[0, 1, 8 / 42], [0, 2, 4 / 42], [1, -2, 2 / 42], [1, -1, 4 / 42], [1, 0, 8 / 42], [1, 1, 4 / 42], [1, 2, 2 / 42], [2, -2, 1 / 42], [2, -1, 2 / 42], [2, 0, 4 / 42], [2, 1, 2 / 42], [2, 2, 1 / 42]],
    burkes: [[0, 1, 8 / 32], [0, 2, 4 / 32], [1, -2, 4 / 32], [1, -1, 8 / 32], [1, 0, 4 / 32], [1, 1, 2 / 32], [1, 2, 2 / 32]],
    atkinson: [[0, 1, 1 / 8], [0, 2, 1 / 8], [1, -1, 1 / 8], [1, 0, 1 / 8], [1, 1, 1 / 8], [2, 0, 1 / 8]],
  };
  const kernel = kernels[settings.diffusionAlgorithm ?? "floyd-steinberg"] ?? kernels["floyd-steinberg"];
  const levels = Math.max(2, Math.round(settings.diffusionLevels ?? 8));
  const intensity = clamp(settings.diffusionIntensity ?? 0.5);
  for (let y = 0; y < pixels.height; y += 1) {
    const reverse = y % 2 === 1;
    for (let step = 0; step < pixels.width; step += 1) {
      const x = reverse ? pixels.width - 1 - step : step;
      const index = (y * pixels.width + x) * 4;
      let value = coverageFor(plate, pixels.data[index], pixels.data[index + 1], pixels.data[index + 2], settings);
      value += diffusionOffset(x, y, settings.diffusionModulation, (settings.diffusionModStrength ?? 0.5) * 0.25);
      if ((settings.directionalBias ?? 0) > 0) {
        const angle = ((settings.directionalBiasAngle ?? 0) * Math.PI) / 180;
        value += Math.sin(x * Math.cos(angle) + y * Math.sin(angle)) * (settings.directionalBias ?? 0) * 0.08;
      }
      if ((settings.brokenKernel ?? 0) > 0) value += (((x * 7 + y * 11) % 5) - 2) * (settings.brokenKernel ?? 0) * 0.03;
      if ((settings.errorOverflow ?? 0) > 0 && (x + y) % 9 === 0) value += (settings.errorOverflow ?? 0) * 0.12;
      if ((settings.diffusionReset ?? 0) > 0 && y % Math.max(2, Math.round(24 - (settings.diffusionReset ?? 0) * 20)) === 0) value = coverageFor(plate, pixels.data[index], pixels.data[index + 1], pixels.data[index + 2], settings);
      if ((settings.crossChannelBleed ?? 0) > 0) value += (settings.crossChannelBleed ?? 0) * 0.02;
      value = clamp(value + (result[y * pixels.width + x] || 0));
      const quantized = Math.round(value * (levels - 1)) / (levels - 1);
      result[y * pixels.width + x] = quantized;
      const error = (value - quantized) * intensity;
      for (const [dy, rawDx, weight] of kernel) {
        const dx = reverse ? -rawDx : rawDx;
        const targetX = x + dx;
        const targetY = y + dy;
        if (targetX >= 0 && targetX < pixels.width && targetY >= 0 && targetY < pixels.height) {
          result[targetY * pixels.width + targetX] += error * weight;
        }
      }
    }
  }
  return result;
}

function renderDiffusionPlate(
  context: CanvasRenderingContext2D,
  pixels: ImageData,
  plate: Exclude<Plate, "composite">,
  settings: HalftoneSettings,
  width: number,
  height: number,
  monochrome: boolean,
) {
  if (!settings.visible[plate] || (settings.grayscale && plate !== "black")) return;
  const field = buildDiffusionField(pixels, plate, settings);
  const meta = PLATE_META[plate];
  const pixelWidth = width / pixels.width;
  const pixelHeight = height / pixels.height;
  context.save();
  context.globalAlpha = 1;
  context.globalCompositeOperation = monochrome ? "source-over" : "multiply";
  context.fillStyle = monochrome ? "#111214" : meta.color;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (field[y * pixels.width + x] < 0.5) continue;
      context.fillRect(x * pixelWidth, y * pixelHeight, pixelWidth + 0.25, pixelHeight + 0.25);
    }
  }
  context.restore();
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

  if (settings.grayscale && plate !== "black") return 0;
  if (settings.grayscale) {
    // Desktop _arr_gray_cached: Pillow L luminance, polarity, then gamma 0.75.
    const gray = Math.round(clamp(luminance, 0, 255)) / 255;
    const coverage = Math.pow(settings.invert ? gray : 1 - gray, 0.75);
    return clamp(coverage);
  }
  let value = rgbToCmyk(red, green, blue)[plate];

  if (value === 0 && !settings.invert) return 0;

  value = clamp(value);
  return settings.invert ? 1 - value : value;
}

export function drawDot(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  shape: DotShape,
  strokeWidth = 1,
) {
  if (size <= 0.12) return;
  if (shape === "custom") throw new Error("Custom dots require a prepared SVG stamp.");

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
  } else if (shape === "triangle") {
    context.moveTo(x, y - radius);
    context.lineTo(x + radius, y + radius);
    context.lineTo(x - radius, y + radius);
    context.closePath();
  } else if (shape === "cross") {
    // Desktop sprite uses two intersecting bars at 28% of its diameter.
    const halfBar = size * 0.14;
    context.rect(x - halfBar, y - radius, halfBar * 2, size);
    context.rect(x - radius, y - halfBar, size, halfBar * 2);
  } else if (shape === "circle-outline") {
    // Keep the stroke inside the dot footprint, as the desktop mask does.
    context.arc(x, y, radius, 0, Math.PI * 2);
    const innerRadius = Math.max(0, radius - strokeWidth);
    if (innerRadius > 0) {
      context.moveTo(x + innerRadius, y);
      context.arc(x, y, innerRadius, 0, Math.PI * 2, true);
    }
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
  size = Math.max(7, Math.round(Math.min(width, height) * 0.014)),
  offset = Math.max(14, Math.round(Math.min(width, height) * 0.035)),
  weight = 1,
  registrationShape?: CustomShapeAsset,
  mode: "corners" | "centered" = "corners",
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.7;
  context.strokeStyle = "#121416";
  context.lineWidth = Math.max(0.5, weight);
  const customMark = registrationShape ? customShapeStamp(registrationShape, "#121416", size * 2) : null;

  const points = mode === "centered"
    ? [[width / 2, offset], [width / 2, height - offset]]
    : [[offset, offset], [width - offset, offset], [offset, height - offset], [width - offset, height - offset]];
  for (const [x, y] of points) {
    if (customMark) {
      context.drawImage(customMark, x - size / 2, y - size / 2, size, size);
      continue;
    }
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
  if (!settings.visible[plate] || (settings.grayscale && plate !== "black")) return;

  const meta = PLATE_META[plate];
  const angle = (settings.angles[plate] * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const cell = Math.max(minimumCellSize, settings.cellSize * scale);
  const content = visibleContentBounds(pixels);
  const contentOutput = {
    minX: content.minX / sourceWidth * width,
    minY: content.minY / sourceHeight * height,
    maxX: content.maxX / sourceWidth * width,
    maxY: content.maxY / sourceHeight * height,
  };
  const diffusionField = settings.diffusionEnabled ? buildDiffusionField(pixels, plate, settings) : null;
  const glitchField = settings.diffusionEnabled ? null : buildCoverageField(pixels, plate, settings);
  const half = diagonal / 2 + cell;
  const centerX = width / 2;
  const centerY = height / 2;
  const stamp = settings.dotShape === "custom" && settings.customShape
    ? customShapeStamp(settings.customShape, monochrome ? "#111214" : meta.color, cell * 1.04)
    : null;

  context.save();
  context.fillStyle = monochrome ? "#111214" : meta.color;
  context.globalAlpha = 1;
  context.globalCompositeOperation = monochrome ? "source-over" : "multiply";

  for (let u = -half; u <= half; u += cell) {
    for (let v = -half; v <= half; v += cell) {
      const x = centerX + u * cos - v * sin;
      const y = centerY + u * sin + v * cos;
      if (x < -cell || y < -cell || x > width + cell || y > height + cell) continue;

      const sourceX = Math.round((x / width) * sourceWidth);
      const sourceY = Math.round((y / height) * sourceHeight);
      const sampleX = Math.max(0, Math.min(sourceWidth - 1, sourceX));
      const sampleY = Math.max(0, Math.min(sourceHeight - 1, sourceY));
      const index = (sampleY * sourceWidth + sampleX) * 4;
      const insideArtwork = x >= contentOutput.minX && x <= contentOutput.maxX && y >= contentOutput.minY && y <= contentOutput.maxY;
      if (!insideArtwork) continue;
      const coverage = diffusionField
        ? glitchCoverage(diffusionField[sampleY * sourceWidth + sampleX], x, y, settings)
        : glitchField![sampleY * sourceWidth + sampleX];
      const dotSize = cell * Math.sqrt(coverage) * 1.04;
      if (stamp) {
        if (dotSize > 0.12) context.drawImage(stamp, x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
      } else {
        drawDot(context, x, y, dotSize, settings.dotShape, (settings.strokeWidth ?? 1) * scale);
      }
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
  if (settings.dotShape === "custom" && !settings.customShape) throw new Error("Import an SVG before rendering custom dots.");
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
  if ((options.paper ?? "").toLowerCase() === "#000000" || (options.paper ?? "").toLowerCase() === "#111214") {
    context.fillStyle = "#ffffff";
    if (documentDimensions && options.document) {
      const placement = calculateArtworkPlacement({
        sourceWidth: naturalWidth,
        sourceHeight: naturalHeight,
        sheetWidth: documentDimensions.width,
        sheetHeight: documentDimensions.height,
        scalePercent: options.document.scalePercent,
      });
      const scaleX = width / documentDimensions.width;
      const scaleY = height / documentDimensions.height;
      context.fillRect(
        placement.x * scaleX,
        placement.y * scaleY,
        placement.width * scaleX,
        placement.height * scaleY,
      );
    } else {
      context.fillRect(0, 0, width, height);
    }
  }

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

  const activePlates = plate === "composite" ? processPlates(settings) : [plate];
  for (const activePlate of activePlates) {
    const monochrome = Boolean(settings.grayscale || (options.monochromePlate && plate !== "composite"));
    if (settings.diffusionEnabled) {
      renderDiffusionPlate(context, pixels, activePlate, settings, width, height, monochrome);
    } else {
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
        monochrome,
      );
    }
  }

  if (options.registration) drawRegistration(context, width, height, options.registrationSize, options.registrationOffset, options.registrationWeight, options.registrationShape, options.registrationMode);
}

export function renderPlateSvg(
  source: HTMLImageElement | HTMLCanvasElement,
  settings: HalftoneSettings,
  plate: Exclude<Plate, "composite">,
  options: RenderOptions = {},
) {
  if (!settings.visible[plate] || (settings.grayscale && plate !== "black")) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g fill="#000000"/></svg>`;
  }
  const naturalWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const naturalHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const documentDimensions = options.document
    ? getSheetPixelDimensions(options.document.sheetSize, options.document.orientation)
    : null;
  const width = options.width ?? documentDimensions?.width ?? naturalWidth;
  const height = options.height ?? documentDimensions?.height ?? naturalHeight;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = width;
  sampleCanvas.height = height;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) throw new Error("SVG export could not create a sampling canvas");
  sampleContext.fillStyle = "#ffffff";
  sampleContext.fillRect(0, 0, width, height);
  if (options.document && documentDimensions) {
    drawDocumentArtwork(sampleContext, source, naturalWidth, naturalHeight, options.document, documentDimensions.width, documentDimensions.height, width, height);
  } else {
    sampleContext.drawImage(source, 0, 0, width, height);
  }
  const pixels = sampleContext.getImageData(0, 0, width, height);
  const field = buildCoverageField(pixels, plate, settings);
  const content = visibleContentBounds(pixels);
  const angle = (settings.angles[plate] * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cell = Math.max(0.01, settings.cellSize);
  const diagonal = Math.ceil(Math.hypot(width, height));
  const half = diagonal / 2 + cell;
  const centerX = width / 2;
  const centerY = height / 2;
  const shapes: string[] = [];
  for (let u = -half; u <= half; u += cell) {
    for (let v = -half; v <= half; v += cell) {
      const x = centerX + u * cos - v * sin;
      const y = centerY + u * sin + v * cos;
      if (x < -cell || y < -cell || x > width + cell || y > height + cell) continue;
      const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
      const sampleY = Math.max(0, Math.min(height - 1, Math.round(y)));
      if (sampleX < content.minX || sampleX > content.maxX || sampleY < content.minY || sampleY > content.maxY) continue;
      const coverage = field[sampleY * width + sampleX];
      const size = cell * Math.sqrt(coverage) * 1.04;
      if (size <= 0.12) continue;
      shapes.push(svgDot(x, y, size, settings.dotShape, settings.strokeWidth ?? 1));
    }
  }
  const physicalWidth = (width / DOCUMENT_DPI).toFixed(4);
  const physicalHeight = (height / DOCUMENT_DPI).toFixed(4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${physicalWidth}in" height="${physicalHeight}in" viewBox="0 0 ${width} ${height}"><g fill="#000000" stroke="none">${shapes.join("")}</g></svg>`;
}

function svgDot(x: number, y: number, size: number, shape: DotShape, strokeWidth: number) {
  const radius = size / 2;
  if (shape === "square") return `<rect x="${x - radius}" y="${y - radius}" width="${size}" height="${size}"/>`;
  if (shape === "diamond") return `<path d="M ${x} ${y - radius} L ${x + radius} ${y} L ${x} ${y + radius} L ${x - radius} ${y} Z"/>`;
  if (shape === "triangle") return `<path d="M ${x} ${y - radius} L ${x + radius} ${y + radius} L ${x - radius} ${y + radius} Z"/>`;
  if (shape === "cross") {
    const bar = size * 0.14;
    return `<path d="M ${x - bar} ${y - radius} H ${x + bar} V ${y + radius} H ${x - bar} Z M ${x - radius} ${y - bar} H ${x + radius} V ${y + bar} H ${x - radius} Z"/>`;
  }
  if (shape === "line") return `<rect x="${x - radius}" y="${y - size * 0.16}" width="${size}" height="${size * 0.32}" rx="${size * 0.16}"/>`;
  if (shape === "circle-outline") return `<circle cx="${x}" cy="${y}" r="${Math.max(0, radius - strokeWidth / 2)}" fill="none" stroke="#000000" stroke-width="${strokeWidth}"/>`;
  return `<circle cx="${x}" cy="${y}" r="${radius}"/>`;
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
