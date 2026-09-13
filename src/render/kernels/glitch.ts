/**
 * Glitch kernels — DOM-free re-implementations of glitchSamplePoint,
 * bitmapSortField, and buildGlitchField from src/studio/halftone.ts.
 *
 * PARITY CONTRACT: these must stay numerically bit-identical to the studio
 * originals. Do not "improve" arithmetic, reorder operations, or change
 * defaults without updating the parity oracle in tests/unit/render-*.test.ts.
 *
 * STRUCTURE: the whole-image passes are written as a single stepped core
 * (generator yielding at chunk boundaries) consumed by two drivers:
 * buildGlitchField (synchronous, the original signature) and
 * buildGlitchFieldCoop (awaits a Checkpoint between chunks so a busy worker
 * can process cancel messages mid-pass — including DURING the bitmap sort).
 * Both drivers run the exact same loops, so their outputs are bit-identical
 * by construction.
 *
 * MEMORY: allocations are observed through instrumentation helpers, and the
 * pass allocates only what the active settings need — an inactive glitch
 * is an IDENTITY (returns the input, zero allocation, exactly the planner's
 * one-field price), an active one holds at most three concurrent fields
 * (input + remap + block-shift snapshot) plus the sort copy when sorting.
 */
import { clamp, sampleFieldNearest } from "../raster";
import {
  allocField,
  chunkRowsFor,
  copyField,
  releaseField,
  type Checkpoint,
} from "../instrumentation";
import type { RenderSettings } from "../settings";

export type GlitchSample = { x: number; y: number };

/** Parity with src/studio/halftone.ts glitchSamplePoint. */
export function glitchSamplePoint(
  x: number,
  y: number,
  width: number,
  height: number,
  settings: RenderSettings,
): GlitchSample {
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

/** True when any glitch pass would change the field. */
export function glitchActive(settings: RenderSettings): boolean {
  return (
    (settings.sliceShift ?? 0) > 0 ||
    (settings.verticalSliceShift ?? 0) > 0 ||
    (settings.gridWarp ?? 0) > 0 ||
    (settings.smearDrag ?? 0) > 0 ||
    (settings.blockShift ?? 0) > 0 ||
    (settings.channelDesync ?? 0) > 0 ||
    (settings.macroblockCorrupt ?? 0) > 0 ||
    (settings.bitmapSort ?? 0) > 0
  );
}

/* ------------------------------------------------------------------ */
/* Bitmap sort                                                         */
/* ------------------------------------------------------------------ */

/**
 * Stepped core of bitmapSortField: identical arithmetic and iteration order
 * to the studio original, yielding between chunks of selected lines so the
 * cooperative driver can honor cancellation DURING the sort.
 */
function* bitmapSortSteps(
  field: Float32Array,
  width: number,
  height: number,
  amount: number,
  vertical: boolean,
  seed: number,
  linesPerChunk: number,
): Generator<void, Float32Array> {
  if (amount <= 0) return field;
  const result = copyField(field, "field", "bitmap-sort");
  let completed = false;
  try {
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
      if (selected > 0 && selected % linesPerChunk === 0) yield;
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
    completed = true;
    return result;
  } finally {
    if (!completed) releaseField(result, "field", "bitmap-sort");
  }
}

function runSync<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

async function runCoop<T>(steps: Generator<void, T>, checkpoint: Checkpoint): Promise<T> {
  let completed = false;
  try {
    for (;;) {
      const next = steps.next();
      if (next.done) {
        completed = true;
        return next.value;
      }
      if (checkpoint) await checkpoint();
    }
  } finally {
    // A checkpoint rejects while the generator is suspended OUTSIDE its
    // body. Close it explicitly so its ownership finalizers run.
    if (!completed) steps.return(undefined as T);
  }
}

/** Parity with src/studio/halftone.ts bitmapSortField. */
export function bitmapSortField(
  field: Float32Array,
  width: number,
  height: number,
  amount: number,
  vertical: boolean,
  seed: number,
): Float32Array {
  return runSync(bitmapSortSteps(field, width, height, amount, vertical, seed, Number.MAX_SAFE_INTEGER));
}

/** Cooperative bitmapSortField: bit-identical, checkpointed between line chunks. */
export function bitmapSortFieldCoop(
  field: Float32Array,
  width: number,
  height: number,
  amount: number,
  vertical: boolean,
  seed: number,
  checkpoint: Checkpoint,
  linesPerChunk = 64,
): Promise<Float32Array> {
  return runCoop(bitmapSortSteps(field, width, height, amount, vertical, seed, linesPerChunk), checkpoint);
}

/* ------------------------------------------------------------------ */
/* Full glitch pass                                                    */
/* ------------------------------------------------------------------ */

/**
 * Stepped core of buildGlitchField. Iteration order and arithmetic match the
 * studio original exactly; only the ALLOCATION strategy is settings-aware:
 *
 * - nothing active: the input itself (byte-faithful by definition — the
 *   original produced an exact copy via identity remap + slice + no-ops);
 * - macroblock corrupt WITHOUT block shift: quantize/zero in place on the
 *   remapped field (each pixel is visited once, so in-place equals the
 *   original write-to-copy);
 * - block shift: the remapped field is snapshotted first because shifted
 *   blocks re-sample the UNMODIFIED remap, exactly as the original did.
 */
function* glitchSteps(
  field: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  channelIndex: number,
  rowsPerChunk: number,
): Generator<void, Float32Array> {
  if (!glitchActive(settings)) {
    // Identity: no pass would change a value, so return the INPUT itself —
    // zero allocation, matching the planner's one-field price for an
    // inactive glitch. Callers treat kernel outputs as immutable, and every
    // release site guards with `!==` identity checks.
    return field;
  }

  const transformed = allocField(field.length, "field", "glitch-remap");
  let transformedOwned = true;
  let result: Float32Array | null = null;
  let resultOwned = false;
  let completed = false;
  try {
    const block = Math.max(4, settings.blockShiftSize ?? 16);
    for (let y = 0; y < height; y += 1) {
      if (y > 0 && y % rowsPerChunk === 0) yield;
      for (let x = 0; x < width; x += 1) {
        const point = glitchSamplePoint(x, y, width, height, settings);
        const channelShift = (settings.channelDesync ?? 0) * (channelIndex + 1) * block * 2;
        transformed[y * width + x] = sampleFieldNearest(field, width, height, point.x + channelShift, point.y);
      }
    }

    const corrupt = settings.macroblockCorrupt ?? 0;
    const shift = settings.blockShift ?? 0;
    const dropout = settings.macroblockDropout ?? 0.25;
    // The block-shift pass re-samples the frozen remap; corrupt-only passes
    // operate in place (identical bytes — every pixel is written at most once
    // per pass from its own or the frozen field's value).
    result = shift > 0 ? copyField(transformed, "field", "glitch-blocks") : transformed;
    resultOwned = result !== transformed;
    if (corrupt > 0 || shift > 0) {
      const blockRowsPerChunk = Math.max(1, Math.floor(rowsPerChunk / block)) * block;
      for (let y = 0; y < height; y += block) {
        if (y > 0 && y % blockRowsPerChunk === 0) yield;
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
                result[row * width + column] = sampleFieldNearest(transformed, width, height, column + dx, row + dy);
              }
            }
          }
        }
      }
    }
    if (result !== transformed) {
      releaseField(transformed, "field", "glitch-remap");
      transformedOwned = false;
    }

    const sorted = yield* bitmapSortSteps(
      result,
      width,
      height,
      settings.bitmapSort ?? 0,
      settings.bitmapSortVertical ?? false,
      99 + channelIndex * 17,
      64,
    );
    if (sorted !== result) {
      releaseField(result, "field", "glitch-blocks");
      if (resultOwned) resultOwned = false;
      else transformedOwned = false;
    }
    completed = true;
    return sorted;
  } finally {
    if (!completed) {
      if (resultOwned && result) releaseField(result, "field", "glitch-blocks");
      if (transformedOwned) releaseField(transformed, "field", "glitch-remap");
    }
  }
}

/** Parity with src/studio/halftone.ts buildGlitchField. */
export function buildGlitchField(
  field: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  channelIndex: number,
): Float32Array {
  return runSync(glitchSteps(field, width, height, settings, channelIndex, Number.MAX_SAFE_INTEGER));
}

/**
 * Cooperative buildGlitchField: bit-identical output, awaiting `checkpoint`
 * between row/block/sort-line chunks so cancellation is observable DURING
 * the remap, macroblock, and bitmap-sort passes.
 */
export function buildGlitchFieldCoop(
  field: Float32Array,
  width: number,
  height: number,
  settings: RenderSettings,
  channelIndex: number,
  checkpoint: Checkpoint,
  rowsPerChunk = chunkRowsFor(Math.max(1, width)),
): Promise<Float32Array> {
  return runCoop(glitchSteps(field, width, height, settings, channelIndex, rowsPerChunk), checkpoint);
}
