import {
  calculateArtworkPlacement,
  DOCUMENT_DPI,
  getSheetPixelDimensions,
  type DocumentSettings,
} from "./document-model";
import { customShapeStamp, preparedCustomShapeSvg } from "./custom-shape";
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
// Default 11×15 CMYK is 38,016,000 plate-pixels. The 40M ceiling keeps that
// job available while preventing larger multi-plate jobs from allocating the
// repeated Float32 working fields without an explicit size reduction.
export const MAX_DIFFUSION_RASTER_PIXELS = 40_000_000;
// SVG output is measured by coalesced horizontal runs, not halftone cells.
export const MAX_DIFFUSION_SVG_RUNS = 2_000_000;

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
  /** Exports own and release stamps; interactive previews may cache them. */
  cacheCustomStamps?: boolean;
  /** Preserve alpha in formats that support it instead of painting paper. */
  transparent?: boolean;
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

function deterministicNoise(x: number, y: number, channelIndex: number) {
  let state = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(channelIndex + 1, 83492791)) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 2246822507) >>> 0;
  return (state / 0xffffffff) * 2 - 1;
}

function boxBlurField(field: Float32Array, width: number, height: number, radius: number) {
  const horizontal = new Float32Array(field.length);
  const output = new Float32Array(field.length);
  for (let y = 0; y < height; y += 1) {
    let total = 0;
    for (let x = -radius; x <= radius; x += 1) total += sampleCoverage(field, width, height, x, y);
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = total / (radius * 2 + 1);
      total += sampleCoverage(field, width, height, x + radius + 1, y) - sampleCoverage(field, width, height, x - radius, y);
    }
  }
  for (let x = 0; x < width; x += 1) {
    let total = 0;
    for (let y = -radius; y <= radius; y += 1) total += sampleCoverage(horizontal, width, height, x, y);
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = total / (radius * 2 + 1);
      total += sampleCoverage(horizontal, width, height, x, y + radius + 1) - sampleCoverage(horizontal, width, height, x, y - radius);
    }
  }
  return output;
}

function preprocessDiffusionField(
  field: Float32Array,
  width: number,
  height: number,
  settings: HalftoneSettings,
  channelIndex: number,
) {
  const datamoshed = buildGlitchField(field, width, height, {
    ...settings,
    sliceShift: 0,
    verticalSliceShift: 0,
    gridWarp: 0,
  }, channelIndex);
  const denoise = clamp(settings.diffusionDenoise ?? 0, -1, 1);
  const filtered = datamoshed.slice();
  if (denoise > 0) {
    const radius = Math.max(1, Math.round(1 + denoise * 2));
    const blurred = boxBlurField(datamoshed, width, height, radius);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const center = datamoshed[index];
        const average = blurred[index];
        const edgeWeight = clamp(1 - Math.abs(center - average) * 4);
        filtered[index] = clamp(center + (average - center) * denoise * edgeWeight);
      }
    }
  } else if (denoise < 0) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        filtered[index] = clamp(datamoshed[index] + deterministicNoise(x, y, channelIndex) * -denoise * 0.18);
      }
    }
  }

  const strength = clamp(settings.diffusionSharpenStrength ?? 0);
  if (strength <= 0) return filtered;
  const radius = Math.max(1, Math.round(settings.diffusionSharpenRadius ?? 1));
  const blurred = boxBlurField(filtered, width, height, radius);
  const sharpened = filtered.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      sharpened[index] = clamp(filtered[index] + (filtered[index] - blurred[index]) * strength);
    }
  }
  return sharpened;
}

export function buildDiffusionField(
  pixels: ImageData,
  plate: Exclude<Plate, "composite">,
  settings: HalftoneSettings,
) {
  const base = new Float32Array(pixels.width * pixels.height);
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const index = (y * pixels.width + x) * 4;
      base[y * pixels.width + x] = coverageFor(plate, pixels.data[index], pixels.data[index + 1], pixels.data[index + 2], settings);
    }
  }
  const source = preprocessDiffusionField(base, pixels.width, pixels.height, settings, PLATES.indexOf(plate));
  const result = new Float32Array(source.length);
  const kernels: Record<string, Array<[number, number, number]>> = {
    "floyd-steinberg": [[0, 1, 7 / 16], [1, -1, 3 / 16], [1, 0, 5 / 16], [1, 1, 1 / 16]],
    "jarvis-judice-ninke": [[0, 1, 7 / 48], [0, 2, 5 / 48], [1, -2, 3 / 48], [1, -1, 5 / 48], [1, 0, 7 / 48], [1, 1, 5 / 48], [1, 2, 3 / 48], [2, -2, 1 / 48], [2, -1, 3 / 48], [2, 0, 5 / 48], [2, 1, 3 / 48], [2, 2, 1 / 48]],
    stucki: [[0, 1, 8 / 42], [0, 2, 4 / 42], [1, -2, 2 / 42], [1, -1, 4 / 42], [1, 0, 8 / 42], [1, 1, 4 / 42], [1, 2, 2 / 42], [2, -2, 1 / 42], [2, -1, 2 / 42], [2, 0, 4 / 42], [2, 1, 2 / 42], [2, 2, 1 / 42]],
    burkes: [[0, 1, 8 / 32], [0, 2, 4 / 32], [1, -2, 4 / 32], [1, -1, 8 / 32], [1, 0, 4 / 32], [1, 1, 2 / 32], [1, 2, 2 / 32]],
    atkinson: [[0, 1, 1 / 8], [0, 2, 1 / 8], [1, -1, 1 / 8], [1, 0, 1 / 8], [1, 1, 1 / 8], [2, 0, 1 / 8]],
  };
  const algorithm = settings.diffusionAlgorithm ?? "floyd-steinberg";
  const kernel = algorithm === "none" ? [] : kernels[algorithm] ?? kernels["floyd-steinberg"];
  const levels = Math.max(2, Math.round(settings.diffusionLevels ?? 8));
  const intensity = clamp(settings.diffusionIntensity ?? 0.5);
  for (let y = 0; y < pixels.height; y += 1) {
    const reverse = y % 2 === 1;
    for (let step = 0; step < pixels.width; step += 1) {
      const x = reverse ? pixels.width - 1 - step : step;
      const fieldIndex = y * pixels.width + x;
      let value = source[fieldIndex];
      value += diffusionOffset(x, y, settings.diffusionModulation, (settings.diffusionModStrength ?? 0.5) * 0.25);
      if ((settings.directionalBias ?? 0) > 0) {
        const angle = ((settings.directionalBiasAngle ?? 0) * Math.PI) / 180;
        value += Math.sin(x * Math.cos(angle) + y * Math.sin(angle)) * (settings.directionalBias ?? 0) * 0.08;
      }
      if ((settings.brokenKernel ?? 0) > 0) value += (((x * 7 + y * 11) % 5) - 2) * (settings.brokenKernel ?? 0) * 0.03;
      if ((settings.errorOverflow ?? 0) > 0 && (x + y) % 9 === 0) value += (settings.errorOverflow ?? 0) * 0.12;
      if ((settings.diffusionReset ?? 0) > 0 && y % Math.max(2, Math.round(24 - (settings.diffusionReset ?? 0) * 20)) === 0) value = source[fieldIndex];
      if ((settings.crossChannelBleed ?? 0) > 0) value += (settings.crossChannelBleed ?? 0) * 0.02;
      value = clamp(value + (result[fieldIndex] || 0));
      const quantized = Math.round(value * (levels - 1)) / (levels - 1);
      result[fieldIndex] = quantized;
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
  context.globalAlpha = clamp(settings.opacity);
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
  cacheStamp = true,
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.7;
  context.strokeStyle = "#121416";
  context.lineWidth = Math.max(0.5, weight);
  const customMark = registrationShape ? customShapeStamp(registrationShape, "#121416", size * 2, { cache: cacheStamp }) : null;

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
  if (customMark && !cacheStamp) customMark.width = customMark.height = 0;
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
  cacheStamp = true,
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
  const field = buildCoverageField(pixels, plate, settings);
  const half = diagonal / 2 + cell;
  const centerX = width / 2;
  const centerY = height / 2;
  const stamp = settings.dotShape === "custom" && settings.customShape
    ? customShapeStamp(settings.customShape, monochrome ? "#111214" : meta.color, cell * 1.04, { cache: cacheStamp })
    : null;

  context.save();
  context.fillStyle = monochrome ? "#111214" : meta.color;
  context.globalAlpha = clamp(settings.opacity);
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
      const insideArtwork = x >= contentOutput.minX && x <= contentOutput.maxX && y >= contentOutput.minY && y <= contentOutput.maxY;
      if (!insideArtwork) continue;
      const coverage = field[sampleY * sourceWidth + sampleX];
      const dotSize = cell * Math.sqrt(coverage) * 1.04;
      if (stamp) {
        if (dotSize > 0.12) context.drawImage(stamp, x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
      } else {
        drawDot(context, x, y, dotSize, settings.dotShape, (settings.strokeWidth ?? 1) * scale);
      }
    }
  }

  context.restore();
  if (stamp && !cacheStamp) stamp.width = stamp.height = 0;
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
  const context = target.getContext("2d", { alpha: options.transparent ?? false });
  if (!context) return;

  if (!options.transparent) {
    context.fillStyle = options.paper ?? "#eeeae0";
    context.fillRect(0, 0, width, height);
  }
  if (!options.transparent && ((options.paper ?? "").toLowerCase() === "#000000" || (options.paper ?? "").toLowerCase() === "#111214")) {
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
  try {
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
    const needsOpacityLayer = clamp(settings.opacity) < 1;
    const plateCanvas = needsOpacityLayer ? document.createElement("canvas") : target;
    if (needsOpacityLayer) {
      plateCanvas.width = width;
      plateCanvas.height = height;
    }
    const plateContext = needsOpacityLayer ? plateCanvas.getContext("2d") : context;
    if (!plateContext) continue;
    const opaqueSettings = needsOpacityLayer ? { ...settings, opacity: 1 } : settings;
    if (settings.diffusionEnabled) {
      renderDiffusionPlate(plateContext, pixels, activePlate, opaqueSettings, width, height, monochrome);
    } else {
      renderPlateDots(
        plateContext,
        pixels,
        activePlate,
        opaqueSettings,
        width,
        height,
        sampleCanvas.width,
        sampleCanvas.height,
        renderScale,
        minimumCellSize,
        monochrome,
        options.cacheCustomStamps ?? true,
      );
    }
    if (needsOpacityLayer) {
      context.save();
      context.globalAlpha = clamp(settings.opacity);
      context.globalCompositeOperation = monochrome ? "source-over" : "multiply";
      context.drawImage(plateCanvas, 0, 0);
      context.restore();
      plateCanvas.width = plateCanvas.height = 0;
    }
  }

  if (options.registration) drawRegistration(context, width, height, options.registrationSize, options.registrationOffset, options.registrationWeight, options.registrationShape, options.registrationMode, options.cacheCustomStamps ?? true);
  } finally {
    sampleCanvas.width = sampleCanvas.height = 0;
  }
}

export function renderPlateSvg(
  source: HTMLImageElement | HTMLCanvasElement,
  settings: HalftoneSettings,
  plate: Exclude<Plate, "composite">,
  options: RenderOptions = {},
) {
  if (settings.dotShape === "custom" && !settings.customShape) throw new Error("Import an SVG before rendering custom dots.");
  const naturalWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const naturalHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const documentDimensions = options.document
    ? getSheetPixelDimensions(options.document.sheetSize, options.document.orientation)
    : null;
  const { width, height } = documentDimensions
    ? getDocumentTargetDimensions(documentDimensions.width, documentDimensions.height, options.width, options.height)
    : { width: Math.max(1, Math.round(options.width ?? naturalWidth)), height: Math.max(1, Math.round(options.height ?? naturalHeight)) };
  const shapes: string[] = [];
  const definitions: string[] = [];
  const customDots = settings.dotShape === "custom" && settings.customShape;
  if (customDots && !settings.diffusionEnabled) definitions.push(svgSymbol(customDots, "dot-shape"));

  // Keep hidden plates at the job's full dimensions, including registration.
  if (settings.visible[plate] && (!settings.grayscale || plate === "black")) {
    const sampleCanvas = document.createElement("canvas");
    const sampleScale = options.preview ? Math.min(1, 1100 / Math.max(width, height)) : 1;
    sampleCanvas.width = Math.max(1, Math.round(width * sampleScale));
    sampleCanvas.height = Math.max(1, Math.round(height * sampleScale));
    const sw = sampleCanvas.width;
    const sh = sampleCanvas.height;
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) throw new Error("SVG export could not create a sampling canvas");
    if (options.document && documentDimensions) {
      sampleContext.fillStyle = "#ffffff";
      sampleContext.fillRect(0, 0, sw, sh);
      drawDocumentArtwork(sampleContext, source, naturalWidth, naturalHeight, options.document, documentDimensions.width, documentDimensions.height, sw, sh);
    } else {
      sampleContext.drawImage(source, 0, 0, sw, sh);
    }
    const pixels = sampleContext.getImageData(0, 0, sw, sh);
    if (settings.diffusionEnabled) {
      const field = buildDiffusionField(pixels, plate, settings);
      const pw = width / sw;
      const ph = height / sh;
      // Coalesce adjacent bitmap pixels into vector runs; preserve the raster
      // renderer's threshold and quarter-pixel overlap.
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw;) {
          if (field[y * sw + x] < 0.5) { x++; continue; }
          const from = x++;
          while (x < sw && field[y * sw + x] >= 0.5) x++;
          if (shapes.length >= MAX_DIFFUSION_SVG_RUNS) throw new Error("SVG export exceeds the diffusion run limit.");
          shapes.push(`<rect x="${from * pw}" y="${y * ph}" width="${(x - from) * pw + 0.25}" height="${ph + 0.25}"/>`);
        }
      }
    } else {
      const field = buildCoverageField(pixels, plate, settings);
      const content = visibleContentBounds(pixels);
      const angle = (settings.angles[plate] * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const scale = documentDimensions ? width / documentDimensions.width : width / naturalWidth;
      const minimumCell = documentDimensions ? (options.preview ? 3 : 0.01) : 3;
      const cell = Math.max(minimumCell, settings.cellSize * scale);
      const half = Math.ceil(Math.hypot(width, height)) / 2 + cell;
      if (estimateGridPoints(width, height, cell, settings.angles[plate]) > MAX_EXPORT_GRID_POINTS) {
        throw new Error("SVG export exceeds the vector mark limit. Increase cell size.");
      }
      for (let u = -half; u <= half; u += cell) {
        for (let v = -half; v <= half; v += cell) {
          const x = width / 2 + u * cos - v * sin;
          const y = height / 2 + u * sin + v * cos;
          if (x < -cell || y < -cell || x > width + cell || y > height + cell) continue;
          if (x < content.minX / sw * width || x > content.maxX / sw * width ||
              y < content.minY / sh * height || y > content.maxY / sh * height) continue;
          const sx = Math.max(0, Math.min(sw - 1, Math.round(x / width * sw)));
          const sy = Math.max(0, Math.min(sh - 1, Math.round(y / height * sh)));
          const size = cell * Math.sqrt(field[sy * sw + sx]) * 1.04;
          if (size <= 0.12) continue;
          shapes.push(customDots ? svgUse("dot-shape", x, y, size)
            : svgDot(x, y, size, settings.dotShape, (settings.strokeWidth ?? 1) * scale));
        }
      }
    }
  }
  let registration = "";
  if (options.registration) {
    const size = options.registrationSize ?? Math.max(7, Math.round(Math.min(width, height) * 0.014));
    const offset = options.registrationOffset ?? Math.max(14, Math.round(Math.min(width, height) * 0.035));
    const points = options.registrationMode === "centered"
      ? [[width / 2, offset], [width / 2, height - offset]]
      : [[offset, offset], [width - offset, offset], [offset, height - offset], [width - offset, height - offset]];
    if (options.registrationShape) {
      definitions.push(svgSymbol(options.registrationShape, "registration-shape"));
      registration = points.map(([x, y]) => `<g opacity="0.7">${svgUse("registration-shape", x, y, size)}</g>`).join("");
    } else {
      const radius = size * 0.58;
      const marks = points.map(([x, y]) => `<g opacity="0.7"><circle cx="${x}" cy="${y}" r="${radius}"/><path d="M ${x - size} ${y} h ${2 * size} M ${x} ${y - size} v ${2 * size}"/></g>`).join("");
      registration = `<g fill="none" stroke="#000000" stroke-width="${Math.max(0.5, options.registrationWeight ?? 1)}">${marks}</g>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(width / DOCUMENT_DPI).toFixed(4)}in" height="${(height / DOCUMENT_DPI).toFixed(4)}in" viewBox="0 0 ${width} ${height}"><defs>${definitions.join("")}</defs><g fill="#000000" stroke="none" opacity="${clamp(settings.opacity)}">${shapes.join("")}</g>${registration}</svg>`;
}

function svgSymbol(asset: CustomShapeAsset, id: string) {
  // Preparation validates saved assets for both raster and vector output.
  // IDs are internal constants, never filenames.
  const svg = preparedCustomShapeSvg(asset);
  return svg.replace(/^<svg\b/, `<symbol id="${id}"`).replace(/<\/svg>$/, "</symbol>");
}

function svgUse(id: string, x: number, y: number, size: number) {
  return `<use href="#${id}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"/>`;
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
  if (shape === "circle-outline" && strokeWidth < radius) return `<circle cx="${x}" cy="${y}" r="${Math.max(0, radius - strokeWidth / 2)}" fill="none" stroke="#000000" stroke-width="${strokeWidth}"/>`;
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
