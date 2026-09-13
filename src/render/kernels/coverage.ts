/**
 * Coverage kernels — DOM-free re-implementations of rgbToCmyk, coverageFor,
 * buildCoverageField, applyFrayedEdges, and visibleContentBounds from
 * src/studio/halftone.ts, operating on RasterData instead of ImageData.
 *
 * PARITY CONTRACT: numerically bit-identical to the studio originals.
 * Note the originals ignore the alpha channel by design; source alpha is
 * handled explicitly at composition time (compose.ts), never here.
 *
 * Each whole-image pass also has a *Coop variant that awaits a Checkpoint
 * between row chunks — the same loops, so bit-identical — letting a busy
 * worker observe cancellation during coverage separation and fraying.
 */
import { clamp, type RasterData } from "../raster";
import {
  allocField,
  chunkRowsFor,
  copyField,
  releaseField,
  type Checkpoint,
} from "../instrumentation";
import { plateChannelIndex, type RenderPlateId, type RenderSettings } from "../settings";
import { buildGlitchField, buildGlitchFieldCoop } from "./glitch";

export type ContentBounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Parity with src/studio/halftone.ts rgbToCmyk. */
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

/** Parity with src/studio/halftone.ts coverageFor. */
export function coverageFor(
  plate: RenderPlateId,
  red: number,
  green: number,
  blue: number,
  settings: RenderSettings,
): number {
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

/**
 * Row loop of buildCoverageBase with coverageFor's arithmetic INLINED in
 * the exact original operation order (allocation-free hot loop; coverageFor
 * allocates an object per pixel via rgbToCmyk). Bit-identical by
 * construction — the coverage parity suite runs both against the studio
 * original.
 */
function coverageBaseRows(
  base: Float32Array,
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
  yStart: number,
  yEnd: number,
): void {
  const { data, width } = pixels;
  const grayscale = settings.grayscale === true;
  const invert = settings.invert;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      let coverage = 0;
      if (luminance < 250) {
        if (grayscale) {
          if (plate === "black") {
            const gray = Math.round(clamp(luminance, 0, 255)) / 255;
            coverage = clamp(Math.pow(invert ? gray : 1 - gray, 0.75));
          }
        } else {
          const cyan = 1 - clamp(red, 0, 255) / 255;
          const magenta = 1 - clamp(green, 0, 255) / 255;
          const yellow = 1 - clamp(blue, 0, 255) / 255;
          const black = Math.min(cyan, magenta, yellow);
          const value =
            plate === "cyan"
              ? clamp(cyan - black)
              : plate === "magenta"
                ? clamp(magenta - black)
                : plate === "yellow"
                  ? clamp(yellow - black)
                  : black;
          if (value === 0 && !invert) {
            coverage = 0;
          } else {
            const clamped = clamp(value);
            coverage = invert ? 1 - clamped : clamped;
          }
        }
      }
      base[y * width + x] = coverage;
    }
  }
}

/** Per-pixel coverage of a raster before glitch/fray; the shared field base. */
export function buildCoverageBase(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
): Float32Array {
  const base = allocField(pixels.width * pixels.height, "field", "coverage-base");
  coverageBaseRows(base, pixels, plate, settings, 0, pixels.height);
  return base;
}

/** Cooperative buildCoverageBase: bit-identical, checkpointed between row chunks. */
export async function buildCoverageBaseCoop(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
  checkpoint: Checkpoint,
  rowsPerChunk = chunkRowsFor(pixels.width),
): Promise<Float32Array> {
  const base = allocField(pixels.width * pixels.height, "field", "coverage-base");
  let completed = false;
  try {
    for (let y = 0; y < pixels.height; y += rowsPerChunk) {
      if (y > 0 && checkpoint) await checkpoint();
      coverageBaseRows(base, pixels, plate, settings, y, Math.min(pixels.height, y + rowsPerChunk));
    }
    completed = true;
    return base;
  } finally {
    if (!completed) releaseField(base, "field", "coverage-base");
  }
}

/** Parity with src/studio/halftone.ts buildCoverageField. */
export function buildCoverageField(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
): Float32Array {
  const base = buildCoverageBase(pixels, plate, settings);
  let owned: Float32Array | null = base;
  let ownedLabel = "coverage-base";
  try {
    const glitched = buildGlitchField(base, pixels.width, pixels.height, settings, plateChannelIndex(plate));
    if (glitched !== base) {
      releaseField(base, "field", "coverage-base");
      owned = glitched;
      ownedLabel = "glitch-copy";
    }
    const frayed = applyFrayedEdges(glitched, pixels.width, pixels.height, settings.frayedXEdge, settings.frayedYEdge);
    if (frayed !== glitched) {
      releaseField(glitched, "field", "glitch-copy");
      owned = frayed;
      ownedLabel = "fray";
    }
    owned = null;
    return frayed;
  } finally {
    if (owned) releaseField(owned, "field", ownedLabel);
  }
}

/**
 * Cooperative buildCoverageField: the exact coverage → glitch → fray chain,
 * checkpointed inside each pass. Bit-identical to buildCoverageField.
 */
export async function buildCoverageFieldCoop(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
  checkpoint: Checkpoint,
): Promise<Float32Array> {
  const base = await buildCoverageBaseCoop(pixels, plate, settings, checkpoint);
  let owned: Float32Array | null = base;
  let ownedLabel = "coverage-base";
  try {
    const glitched = await buildGlitchFieldCoop(
      base,
      pixels.width,
      pixels.height,
      settings,
      plateChannelIndex(plate),
      checkpoint,
    );
    if (glitched !== base) {
      releaseField(base, "field", "coverage-base");
      owned = glitched;
      ownedLabel = "glitch-copy";
    }
    if (checkpoint) await checkpoint();
    const frayed = applyFrayedEdges(glitched, pixels.width, pixels.height, settings.frayedXEdge, settings.frayedYEdge);
    if (frayed !== glitched) {
      releaseField(glitched, "field", "glitch-copy");
      owned = frayed;
      ownedLabel = "fray";
    }
    owned = null;
    return frayed;
  } finally {
    if (owned) releaseField(owned, "field", ownedLabel);
  }
}

/**
 * Clean continuous-tone field: separation coverage with the layer's glitch
 * applied, and nothing else. Clean mode contributes this field directly as
 * plate ink (no screening, no diffusion, no threshold). Glitch runs before
 * the mode kernel exactly as in halftone mode (buildCoverageField); frayed
 * edges are a halftone-recipe effect and never apply to clean layers.
 * Pointwise output — band partitions of the result are bit-identical.
 */
export function buildCleanField(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
): Float32Array {
  const base = buildCoverageBase(pixels, plate, settings);
  let owned: Float32Array | null = base;
  let ownedLabel = "coverage-base";
  try {
    const glitched = buildGlitchField(base, pixels.width, pixels.height, settings, plateChannelIndex(plate));
    if (glitched !== base) {
      releaseField(base, "field", "coverage-base");
      owned = glitched;
      ownedLabel = "glitch-copy";
    }
    owned = null;
    return glitched;
  } finally {
    if (owned) releaseField(owned, "field", ownedLabel);
  }
}

/** Cooperative buildCleanField: bit-identical, checkpointed inside each pass. */
export async function buildCleanFieldCoop(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
  checkpoint: Checkpoint,
): Promise<Float32Array> {
  const base = await buildCoverageBaseCoop(pixels, plate, settings, checkpoint);
  let owned: Float32Array | null = base;
  let ownedLabel = "coverage-base";
  try {
    const glitched = await buildGlitchFieldCoop(
      base,
      pixels.width,
      pixels.height,
      settings,
      plateChannelIndex(plate),
      checkpoint,
    );
    if (glitched !== base) {
      releaseField(base, "field", "coverage-base");
      owned = glitched;
      ownedLabel = "glitch-copy";
    }
    owned = null;
    return glitched;
  } finally {
    if (owned) releaseField(owned, "field", ownedLabel);
  }
}

/** Parity with src/studio/halftone.ts applyFrayedEdges. */
export function applyFrayedEdges(
  field: Float32Array,
  width: number,
  height: number,
  xAmount: number,
  yAmount: number,
): Float32Array {
  const maxXShift = Math.floor(Math.max(0, xAmount) * 1.5);
  const maxYShift = Math.floor(Math.max(0, yAmount) * 1.5);
  if (maxXShift <= 0 && maxYShift <= 0) {
    // No inset can be applied (the loops below are guarded by these exact
    // conditions): the copy the original returned is bit-identical to the
    // input, so skip the content scans and the copy alike.
    return field;
  }
  const result = copyField(field, "field", "fray");
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

/** Parity with src/studio/halftone.ts visibleContentBounds. */
export function visibleContentBounds(pixels: RasterData): ContentBounds {
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
