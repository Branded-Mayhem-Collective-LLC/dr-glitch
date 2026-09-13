/**
 * Diffusion kernels — DOM-free re-implementations of deterministicNoise,
 * diffusionOffset, boxBlurField, preprocessDiffusionField, and
 * buildDiffusionField from src/studio/halftone.ts, plus a band-streaming
 * variant of the error-diffusion loop.
 *
 * PARITY CONTRACT: numerically bit-identical to the studio originals.
 * Error diffusion is inherently sequential; banding bounds working memory,
 * it never reorders the scan. processBandedDiffusion must remain bit-identical
 * to the whole-image loop for every band height.
 *
 * The preprocess chain also has a *Coop variant that awaits a Checkpoint
 * between row chunks of each pass (datamosh, blur, noise, sharpen) — the
 * same loops, so bit-identical — letting a busy worker observe cancellation
 * DURING the diffusion preprocess. Allocation order is memory-lean but the
 * written bytes are identical: every output buffer is fully written by its
 * pass before it is read, so `allocField` replaces the original `.slice()`
 * seeds without changing a single result value.
 */
import { clamp, type RasterData } from "../raster";
import {
  allocField,
  chunkRowsFor,
  releaseField,
  retainAllocation,
  type Checkpoint,
} from "../instrumentation";
import { plateChannelIndex, type RenderPlateId, type RenderSettings } from "../settings";
import { buildCoverageBase, buildCoverageBaseCoop } from "./coverage";
import { buildGlitchField, buildGlitchFieldCoop } from "./glitch";
import { sampleFieldNearest } from "../raster";

/** Parity with src/studio/halftone.ts diffusionOffset. */
export function diffusionOffset(
  x: number,
  y: number,
  mode: RenderSettings["diffusionModulation"],
  strength: number,
): number {
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

/** Parity with src/studio/halftone.ts deterministicNoise. */
export function deterministicNoise(x: number, y: number, channelIndex: number): number {
  let state = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(channelIndex + 1, 83492791)) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 2246822507) >>> 0;
  return (state / 0xffffffff) * 2 - 1;
}

function boxBlurHorizontalRows(
  field: Float32Array,
  horizontal: Float32Array,
  width: number,
  height: number,
  radius: number,
  yStart: number,
  yEnd: number,
): void {
  for (let y = yStart; y < yEnd; y += 1) {
    let total = 0;
    for (let x = -radius; x <= radius; x += 1) total += sampleFieldNearest(field, width, height, x, y);
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = total / (radius * 2 + 1);
      total += sampleFieldNearest(field, width, height, x + radius + 1, y) - sampleFieldNearest(field, width, height, x - radius, y);
    }
  }
}

function boxBlurVerticalColumns(
  horizontal: Float32Array,
  output: Float32Array,
  width: number,
  height: number,
  radius: number,
  xStart: number,
  xEnd: number,
): void {
  for (let x = xStart; x < xEnd; x += 1) {
    let total = 0;
    for (let y = -radius; y <= radius; y += 1) total += sampleFieldNearest(horizontal, width, height, x, y);
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = total / (radius * 2 + 1);
      total += sampleFieldNearest(horizontal, width, height, x, y + radius + 1) - sampleFieldNearest(horizontal, width, height, x, y - radius);
    }
  }
}

/** Parity with src/studio/halftone.ts boxBlurField. */
export function boxBlurField(field: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = allocField(field.length, "field", "blur-horizontal");
  let horizontalOwned = true;
  let output: Float32Array | null = null;
  let completed = false;
  try {
    output = allocField(field.length, "field", "blur-output");
    boxBlurHorizontalRows(field, horizontal, width, height, radius, 0, height);
    boxBlurVerticalColumns(horizontal, output, width, height, radius, 0, width);
    releaseField(horizontal, "field", "blur-horizontal");
    horizontalOwned = false;
    completed = true;
    return output;
  } finally {
    if (horizontalOwned) releaseField(horizontal, "field", "blur-horizontal");
    if (!completed && output) releaseField(output, "field", "blur-output");
  }
}

/** Cooperative boxBlurField: bit-identical, checkpointed between row/column chunks. */
export async function boxBlurFieldCoop(
  field: Float32Array,
  width: number,
  height: number,
  radius: number,
  checkpoint: Checkpoint,
  rowsPerChunk = chunkRowsFor(width),
): Promise<Float32Array> {
  const horizontal = allocField(field.length, "field", "blur-horizontal");
  let horizontalOwned = true;
  let output: Float32Array | null = null;
  let completed = false;
  try {
    output = allocField(field.length, "field", "blur-output");
    for (let y = 0; y < height; y += rowsPerChunk) {
      if (y > 0 && checkpoint) await checkpoint();
      boxBlurHorizontalRows(field, horizontal, width, height, radius, y, Math.min(height, y + rowsPerChunk));
    }
    const columnsPerChunk = Math.max(1, Math.floor((rowsPerChunk * width) / Math.max(1, height)));
    for (let x = 0; x < width; x += columnsPerChunk) {
      if (checkpoint) await checkpoint();
      boxBlurVerticalColumns(horizontal, output, width, height, radius, x, Math.min(width, x + columnsPerChunk));
    }
    releaseField(horizontal, "field", "blur-horizontal");
    horizontalOwned = false;
    completed = true;
    return output;
  } finally {
    if (horizontalOwned) releaseField(horizontal, "field", "blur-horizontal");
    if (!completed && output) releaseField(output, "field", "blur-output");
  }
}

/* ------------------------------------------------------------------ */
/* Preprocess (datamosh → denoise/noise → sharpen)                     */
/* ------------------------------------------------------------------ */

function datamoshSettings(settings: RenderSettings): RenderSettings {
  return { ...settings, sliceShift: 0, verticalSliceShift: 0, gridWarp: 0 };
}

function denoiseRows(
  filtered: Float32Array,
  datamoshed: Float32Array,
  blurred: Float32Array,
  width: number,
  denoise: number,
  yStart: number,
  yEnd: number,
): void {
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const center = datamoshed[index];
      const average = blurred[index];
      const edgeWeight = clamp(1 - Math.abs(center - average) * 4);
      filtered[index] = clamp(center + (average - center) * denoise * edgeWeight);
    }
  }
}

function noiseRows(
  filtered: Float32Array,
  datamoshed: Float32Array,
  width: number,
  denoise: number,
  channelIndex: number,
  yStart: number,
  yEnd: number,
): void {
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      filtered[index] = clamp(datamoshed[index] + deterministicNoise(x, y, channelIndex) * -denoise * 0.18);
    }
  }
}

function sharpenRows(
  sharpened: Float32Array,
  filtered: Float32Array,
  blurred: Float32Array,
  width: number,
  strength: number,
  yStart: number,
  yEnd: number,
): void {
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      sharpened[index] = clamp(filtered[index] + (filtered[index] - blurred[index]) * strength);
    }
  }
}

/** Parity with src/studio/halftone.ts preprocessDiffusionField. */
export function preprocessDiffusionField(
  field: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  channelIndex: number,
): Float32Array {
  const owned = new Map<Float32Array, string>();
  const own = (value: Float32Array, label: string) => {
    if (value !== field) owned.set(value, label);
  };
  const drop = (value: Float32Array, label: string) => {
    if (!owned.delete(value)) return;
    releaseField(value, "field", label);
  };
  const transfer = (value: Float32Array) => {
    owned.delete(value);
    return value;
  };
  try {
    const datamoshed = buildGlitchField(field, width, height, datamoshSettings(settings), channelIndex);
    own(datamoshed, "datamosh");
    const denoise = clamp(settings.diffusionDenoise ?? 0, -1, 1);
    let filtered = datamoshed;
    if (denoise > 0) {
      const radius = Math.max(1, Math.round(1 + denoise * 2));
      const blurred = boxBlurField(datamoshed, width, height, radius);
      own(blurred, "blur-output");
      filtered = allocField(field.length, "field", "denoise");
      own(filtered, "denoise");
      denoiseRows(filtered, datamoshed, blurred, width, denoise, 0, height);
      drop(blurred, "blur-output");
      drop(datamoshed, "datamosh");
    } else if (denoise < 0) {
      filtered = allocField(field.length, "field", "noise");
      own(filtered, "noise");
      noiseRows(filtered, datamoshed, width, denoise, channelIndex, 0, height);
      drop(datamoshed, "datamosh");
    }

    const strength = clamp(settings.diffusionSharpenStrength ?? 0);
    if (strength <= 0) return transfer(filtered);
    const radius = Math.max(1, Math.round(settings.diffusionSharpenRadius ?? 1));
    const blurred = boxBlurField(filtered, width, height, radius);
    own(blurred, "blur-output");
    const sharpened = allocField(field.length, "field", "sharpen");
    own(sharpened, "sharpen");
    sharpenRows(sharpened, filtered, blurred, width, strength, 0, height);
    drop(blurred, "blur-output");
    drop(filtered, "preprocess-filtered");
    return transfer(sharpened);
  } finally {
    for (const [value, label] of owned) releaseField(value, "field", label);
  }
}

/**
 * Cooperative preprocessDiffusionField: the exact datamosh → denoise/noise →
 * sharpen chain, checkpointed inside each pass. Bit-identical output.
 */
export async function preprocessDiffusionFieldCoop(
  field: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  channelIndex: number,
  checkpoint: Checkpoint,
): Promise<Float32Array> {
  const owned = new Map<Float32Array, string>();
  const own = (value: Float32Array, label: string) => {
    if (value !== field) owned.set(value, label);
  };
  const drop = (value: Float32Array, label: string) => {
    if (!owned.delete(value)) return;
    releaseField(value, "field", label);
  };
  const transfer = (value: Float32Array) => {
    owned.delete(value);
    return value;
  };
  try {
    const rowsPerChunk = chunkRowsFor(width);
    const datamoshed = await buildGlitchFieldCoop(
      field,
      width,
      height,
      datamoshSettings(settings),
      channelIndex,
      checkpoint,
    );
    own(datamoshed, "datamosh");
    const denoise = clamp(settings.diffusionDenoise ?? 0, -1, 1);
    let filtered = datamoshed;
    if (denoise > 0) {
      const radius = Math.max(1, Math.round(1 + denoise * 2));
      const blurred = await boxBlurFieldCoop(datamoshed, width, height, radius, checkpoint, rowsPerChunk);
      own(blurred, "blur-output");
      filtered = allocField(field.length, "field", "denoise");
      own(filtered, "denoise");
      for (let y = 0; y < height; y += rowsPerChunk) {
        if (y > 0 && checkpoint) await checkpoint();
        denoiseRows(filtered, datamoshed, blurred, width, denoise, y, Math.min(height, y + rowsPerChunk));
      }
      drop(blurred, "blur-output");
      drop(datamoshed, "datamosh");
    } else if (denoise < 0) {
      filtered = allocField(field.length, "field", "noise");
      own(filtered, "noise");
      for (let y = 0; y < height; y += rowsPerChunk) {
        if (y > 0 && checkpoint) await checkpoint();
        noiseRows(filtered, datamoshed, width, denoise, channelIndex, y, Math.min(height, y + rowsPerChunk));
      }
      drop(datamoshed, "datamosh");
    }

    const strength = clamp(settings.diffusionSharpenStrength ?? 0);
    if (strength <= 0) return transfer(filtered);
    const radius = Math.max(1, Math.round(settings.diffusionSharpenRadius ?? 1));
    const blurred = await boxBlurFieldCoop(filtered, width, height, radius, checkpoint, rowsPerChunk);
    own(blurred, "blur-output");
    const sharpened = allocField(field.length, "field", "sharpen");
    own(sharpened, "sharpen");
    for (let y = 0; y < height; y += rowsPerChunk) {
      if (y > 0 && checkpoint) await checkpoint();
      sharpenRows(sharpened, filtered, blurred, width, strength, y, Math.min(height, y + rowsPerChunk));
    }
    drop(blurred, "blur-output");
    drop(filtered, "preprocess-filtered");
    return transfer(sharpened);
  } finally {
    for (const [value, label] of owned) releaseField(value, "field", label);
  }
}

/** Error kernels; parity with the table inside src/studio/halftone.ts buildDiffusionField. */
export const DIFFUSION_KERNELS: Record<string, Array<[number, number, number]>> = {
  "floyd-steinberg": [[0, 1, 7 / 16], [1, -1, 3 / 16], [1, 0, 5 / 16], [1, 1, 1 / 16]],
  "jarvis-judice-ninke": [[0, 1, 7 / 48], [0, 2, 5 / 48], [1, -2, 3 / 48], [1, -1, 5 / 48], [1, 0, 7 / 48], [1, 1, 5 / 48], [1, 2, 3 / 48], [2, -2, 1 / 48], [2, -1, 3 / 48], [2, 0, 5 / 48], [2, 1, 3 / 48], [2, 2, 1 / 48]],
  stucki: [[0, 1, 8 / 42], [0, 2, 4 / 42], [1, -2, 2 / 42], [1, -1, 4 / 42], [1, 0, 8 / 42], [1, 1, 4 / 42], [1, 2, 2 / 42], [2, -2, 1 / 42], [2, -1, 2 / 42], [2, 0, 4 / 42], [2, 1, 2 / 42], [2, 2, 1 / 42]],
  burkes: [[0, 1, 8 / 32], [0, 2, 4 / 32], [1, -2, 4 / 32], [1, -1, 8 / 32], [1, 0, 4 / 32], [1, 1, 2 / 32], [1, 2, 2 / 32]],
  atkinson: [[0, 1, 1 / 8], [0, 2, 1 / 8], [1, -1, 1 / 8], [1, 0, 1 / 8], [1, 1, 1 / 8], [2, 0, 1 / 8]],
};

/** Furthest row (dy) any kernel pushes error to; sizes the banded carry window. */
export const DIFFUSION_MAX_ROW_REACH = 2;

function resolveKernel(settings: RenderSettings): Array<[number, number, number]> {
  const algorithm = settings.diffusionAlgorithm ?? "floyd-steinberg";
  return algorithm === "none" ? [] : DIFFUSION_KERNELS[algorithm] ?? DIFFUSION_KERNELS["floyd-steinberg"];
}

/**
 * Serpentine error-diffusion scan of a preprocessed source field.
 * Parity with the quantization loop inside src/studio/halftone.ts
 * buildDiffusionField.
 */
export function diffuseField(
  source: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
): Float32Array {
  const result = allocField(source.length, "field", "diffuse");
  let completed = false;
  try {
    const kernel = resolveKernel(settings);
    const levels = Math.max(2, Math.round(settings.diffusionLevels ?? 8));
    const intensity = clamp(settings.diffusionIntensity ?? 0.5);
    for (let y = 0; y < height; y += 1) {
      const reverse = y % 2 === 1;
      for (let step = 0; step < width; step += 1) {
        const x = reverse ? width - 1 - step : step;
        const fieldIndex = y * width + x;
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
          if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
            result[targetY * width + targetX] += error * weight;
          }
        }
      }
    }
    completed = true;
    return result;
  } finally {
    if (!completed) releaseField(result, "field", "diffuse");
  }
}

/** Parity with src/studio/halftone.ts buildDiffusionField (coverage → preprocess → diffuse). */
export function buildDiffusionField(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
): Float32Array {
  const base = buildCoverageBase(pixels, plate, settings);
  let owned: Float32Array | null = base;
  let ownedLabel = "coverage-base";
  try {
    const source = preprocessDiffusionField(base, pixels.width, pixels.height, settings, plateChannelIndex(plate));
    if (source !== base) {
      releaseField(base, "field", "coverage-base");
      owned = source;
      ownedLabel = "preprocess-result";
    }
    const result = diffuseField(source, pixels.width, pixels.height, settings);
    releaseField(source, "field", "preprocess-result");
    owned = null;
    return result;
  } finally {
    if (owned) releaseField(owned, "field", ownedLabel);
  }
}

/**
 * Cooperative buildDiffusionField: coverage and preprocess run checkpointed;
 * the sequential serpentine scan runs whole (its banded form is what the
 * streaming session uses for in-scan granularity). Bit-identical output.
 */
export async function buildDiffusionFieldCoop(
  pixels: RasterData,
  plate: RenderPlateId,
  settings: RenderSettings,
  checkpoint: Checkpoint,
): Promise<Float32Array> {
  const base = await buildCoverageBaseCoop(pixels, plate, settings, checkpoint);
  let owned: Float32Array | null = base;
  let ownedLabel = "coverage-base";
  try {
    const source = await preprocessDiffusionFieldCoop(
      base,
      pixels.width,
      pixels.height,
      settings,
      plateChannelIndex(plate),
      checkpoint,
    );
    if (source !== base) {
      releaseField(base, "field", "coverage-base");
      owned = source;
      ownedLabel = "preprocess-result";
    }
    if (checkpoint) await checkpoint();
    const result = diffuseField(source, pixels.width, pixels.height, settings);
    releaseField(source, "field", "preprocess-result");
    owned = null;
    return result;
  } finally {
    if (owned) releaseField(owned, "field", ownedLabel);
  }
}

type BandedDiffusionState = {
  window: Float32Array;
  kernel: Array<[number, number, number]>;
  levels: number;
  intensity: number;
  band: number;
};

function createBandedState(width: number, settings: RenderSettings, bandHeight: number): BandedDiffusionState {
  const band = Math.max(1, Math.floor(bandHeight));
  return {
    window: allocField((band + DIFFUSION_MAX_ROW_REACH) * width, "band", "diffusion-window"),
    kernel: resolveKernel(settings),
    levels: Math.max(2, Math.round(settings.diffusionLevels ?? 8)),
    intensity: clamp(settings.diffusionIntensity ?? 0.5),
    band,
  };
}

function diffuseBand(
  state: BandedDiffusionState,
  source: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  rowBase: number,
): { rowsInBand: number; rows: Float32Array } {
  const { window, kernel, levels, intensity, band } = state;
  const rowsInBand = Math.min(band, height - rowBase);
  for (let localY = 0; localY < rowsInBand; localY += 1) {
    const y = rowBase + localY;
    const reverse = y % 2 === 1;
    for (let step = 0; step < width; step += 1) {
      const x = reverse ? width - 1 - step : step;
      const sourceIndex = y * width + x;
      const windowIndex = localY * width + x;
      let value = source[sourceIndex];
      value += diffusionOffset(x, y, settings.diffusionModulation, (settings.diffusionModStrength ?? 0.5) * 0.25);
      if ((settings.directionalBias ?? 0) > 0) {
        const angle = ((settings.directionalBiasAngle ?? 0) * Math.PI) / 180;
        value += Math.sin(x * Math.cos(angle) + y * Math.sin(angle)) * (settings.directionalBias ?? 0) * 0.08;
      }
      if ((settings.brokenKernel ?? 0) > 0) value += (((x * 7 + y * 11) % 5) - 2) * (settings.brokenKernel ?? 0) * 0.03;
      if ((settings.errorOverflow ?? 0) > 0 && (x + y) % 9 === 0) value += (settings.errorOverflow ?? 0) * 0.12;
      if ((settings.diffusionReset ?? 0) > 0 && y % Math.max(2, Math.round(24 - (settings.diffusionReset ?? 0) * 20)) === 0) value = source[sourceIndex];
      if ((settings.crossChannelBleed ?? 0) > 0) value += (settings.crossChannelBleed ?? 0) * 0.02;
      value = clamp(value + (window[windowIndex] || 0));
      const quantized = Math.round(value * (levels - 1)) / (levels - 1);
      window[windowIndex] = quantized;
      const error = (value - quantized) * intensity;
      for (const [dy, rawDx, weight] of kernel) {
        const dx = reverse ? -rawDx : rawDx;
        const targetX = x + dx;
        const targetY = y + dy;
        if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
          window[(localY + dy) * width + targetX] += error * weight;
        }
      }
    }
  }
  const rows = window.slice(0, rowsInBand * width);
  // Carry accumulated error rows to the front of the window, clear the rest.
  window.copyWithin(0, rowsInBand * width, (rowsInBand + DIFFUSION_MAX_ROW_REACH) * width);
  window.fill(0, DIFFUSION_MAX_ROW_REACH * width);
  return { rowsInBand, rows };
}

/**
 * Band-streaming error diffusion. Processes rows strictly top-to-bottom in
 * bands of `bandHeight` rows while holding only bandHeight + 2 rows of
 * working state; the two rows of accumulated error beyond each band carry
 * across the boundary, so the emitted rows are bit-identical to
 * diffuseField's whole-image result for every band height >= 1.
 *
 * `onBand` receives a fresh Float32Array copy per band (safe to transfer).
 */
export function processBandedDiffusion(
  source: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  bandHeight: number,
  onBand: (rowStart: number, rowCount: number, rows: Float32Array) => void,
): void {
  const state = createBandedState(width, settings, bandHeight);
  try {
    for (let rowBase = 0; rowBase < height; rowBase += state.band) {
      const { rowsInBand, rows } = diffuseBand(state, source, width, height, settings, rowBase);
      const releaseRows = retainAllocation(rows.byteLength, "band", "diffusion-output-band");
      try {
        onBand(rowBase, rowsInBand, rows);
      } finally {
        releaseRows();
      }
    }
  } finally {
    releaseField(state.window, "band", "diffusion-window");
  }
}

/**
 * Cooperative processBandedDiffusion: awaits `checkpoint` (and the async
 * consumer) between bands so a busy worker observes cancellation at band
 * granularity DURING the scan. Emitted rows are bit-identical to the sync
 * variant for every band height.
 */
export async function processBandedDiffusionCoop(
  source: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  bandHeight: number,
  onBand: (rowStart: number, rowCount: number, rows: Float32Array) => void | Promise<void>,
  checkpoint: Checkpoint,
): Promise<void> {
  const state = createBandedState(width, settings, bandHeight);
  try {
    for (let rowBase = 0; rowBase < height; rowBase += state.band) {
      if (rowBase > 0 && checkpoint) await checkpoint();
      const { rowsInBand, rows } = diffuseBand(state, source, width, height, settings, rowBase);
      // The callback borrows this fresh band until its returned promise
      // settles. Capture the receipt before it can transfer/detach `rows`.
      const releaseRows = retainAllocation(rows.byteLength, "band", "diffusion-output-band");
      try {
        await onBand(rowBase, rowsInBand, rows);
      } finally {
        releaseRows();
      }
    }
  } finally {
    releaseField(state.window, "band", "diffusion-window");
  }
}
