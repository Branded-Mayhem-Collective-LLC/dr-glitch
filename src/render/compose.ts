/**
 * Plate-stack composition with artwork-stack/knockout semantics, plus the
 * pure proof-compositing math (CMYK multiply model, PLATE_META colors).
 *
 * Per plate, each layer contributes ink coverage (0..1 fraction of the pixel
 * carrying ink on that plate) and alpha (0..1 layer coverage of the pixel:
 * source alpha × geometry). Layers compose bottom-to-top with premultiplied
 * Porter-Duff source-over:
 *
 * - transparent upper pixels (alpha 0) reveal lower ink;
 * - opaque upper pixels with zero ink (alpha 1, ink 0) knock lower ink out;
 * - partial alpha blends proportionally;
 * - layer opacity multiplies alpha exactly once, here and nowhere else.
 *
 * The merged plates feed both proof and export; source alpha is explicit and
 * individual layers are never white-matted.
 */
import { allocField, releaseField } from "./instrumentation";
import { clamp, type RasterData } from "./raster";
import { PLATE_PROOF_COLORS, PLATE_SEQUENCE, type RenderPlateId } from "./settings";

export type PlateLayerOutput = {
  /** Ink coverage per pixel, 0..1, straight (not premultiplied by alpha). */
  ink: Float32Array;
  /** Layer coverage per pixel, 0..1 (source alpha × rendered geometry). */
  alpha: Float32Array;
  /** Layer opacity 0..1; multiplies alpha exactly once during composition. */
  opacity: number;
};

export type ComposedPlate = {
  /** Premultiplied ink: ink × effective alpha; the fraction of pixel inked. */
  inkPremultiplied: Float32Array;
  /** Composited coverage (Porter-Duff over of effective alphas). */
  alpha: Float32Array;
};

/**
 * Compose one plate from a bottom-to-top ordered layer stack.
 * All arrays must share `pixelCount` length.
 */
export function composePlate(layers: PlateLayerOutput[], pixelCount: number): ComposedPlate {
  // Untracked on purpose: these fields transfer out with the single-shot
  // payload, so their retention belongs to the receiving side's ledger.
  const inkPremultiplied = new Float32Array(pixelCount);
  const alpha = new Float32Array(pixelCount);
  for (const layer of layers) {
    if (layer.ink.length !== pixelCount || layer.alpha.length !== pixelCount) {
      throw new Error("composePlate: layer field length does not match pixelCount");
    }
    const opacity = clamp(layer.opacity);
    for (let index = 0; index < pixelCount; index += 1) {
      const layerAlpha = clamp(layer.alpha[index]) * opacity;
      const layerInkPremultiplied = clamp(layer.ink[index]) * layerAlpha;
      const keep = 1 - layerAlpha;
      inkPremultiplied[index] = layerInkPremultiplied + inkPremultiplied[index] * keep;
      alpha[index] = layerAlpha + alpha[index] * keep;
    }
  }
  return { inkPremultiplied, alpha };
}

/**
 * Streaming variant of composePlate's inner loop: fold one layer's ink/alpha
 * rows into a plate accumulator over the span starting at
 * `accumulatorOffset`. Op-for-op identical to composePlate — same clamps,
 * same multiply/add order — so accumulating a stack layer-by-layer (in
 * bottom-to-top order) in any band partition is bit-identical to the
 * whole-image compose.
 */
export function accumulateLayerBand(
  accumulator: ComposedPlate,
  ink: Float32Array,
  inkOffset: number,
  alpha: Float32Array,
  alphaOffset: number,
  opacity: number,
  accumulatorOffset: number,
  pixelCount: number,
): void {
  const opacityClamped = clamp(opacity);
  const { inkPremultiplied, alpha: composedAlpha } = accumulator;
  for (let index = 0; index < pixelCount; index += 1) {
    const layerAlpha = clamp(alpha[alphaOffset + index]) * opacityClamped;
    const layerInkPremultiplied = clamp(ink[inkOffset + index]) * layerAlpha;
    const keep = 1 - layerAlpha;
    inkPremultiplied[accumulatorOffset + index] =
      layerInkPremultiplied + inkPremultiplied[accumulatorOffset + index] * keep;
    composedAlpha[accumulatorOffset + index] =
      layerAlpha + composedAlpha[accumulatorOffset + index] * keep;
  }
}

/** Straight (unpremultiplied) ink coverage of a composed plate; 0 where alpha is 0. */
export function plateInkCoverage(plate: ComposedPlate): Float32Array {
  const out = new Float32Array(plate.inkPremultiplied.length);
  for (let index = 0; index < out.length; index += 1) {
    const alpha = plate.alpha[index];
    out[index] = alpha > 0 ? plate.inkPremultiplied[index] / alpha : 0;
  }
  return out;
}

/** A fully opaque alpha field (legacy single-layer compatibility). */
export function opaqueAlphaField(pixelCount: number): Float32Array {
  return new Float32Array(pixelCount).fill(1);
}

/**
 * Pure proof compositing: multiply each plate's ink over the paper color,
 * matching the canvas engine's opaque plate color + "multiply" composite.
 * With premultiplied ink coverage c and plate color P (0..255), each channel
 * becomes rgb × (1 − c × (1 − P/255)) — identity where c = 0, rgb × P/255
 * where c = 1. Plates apply in press order C, M, Y, K.
 */
export function proofCompositeCmyk(
  plates: Partial<Record<RenderPlateId, ComposedPlate>>,
  width: number,
  height: number,
  paper: readonly [number, number, number] = [238, 234, 224],
): RasterData {
  const pixelCount = width * height;
  const red = new Float32Array(pixelCount).fill(paper[0] / 255);
  const green = new Float32Array(pixelCount).fill(paper[1] / 255);
  const blue = new Float32Array(pixelCount).fill(paper[2] / 255);
  for (const plateId of PLATE_SEQUENCE) {
    const plate = plates[plateId];
    if (!plate) continue;
    if (plate.inkPremultiplied.length !== pixelCount) {
      throw new Error("proofCompositeCmyk: plate field length does not match dimensions");
    }
    const [plateRed, plateGreen, plateBlue] = PLATE_PROOF_COLORS[plateId];
    const absorbRed = 1 - plateRed / 255;
    const absorbGreen = 1 - plateGreen / 255;
    const absorbBlue = 1 - plateBlue / 255;
    for (let index = 0; index < pixelCount; index += 1) {
      const coverage = clamp(plate.inkPremultiplied[index]);
      red[index] *= 1 - coverage * absorbRed;
      green[index] *= 1 - coverage * absorbGreen;
      blue[index] *= 1 - coverage * absorbBlue;
    }
  }
  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    data[index * 4] = red[index] * 255;
    data[index * 4 + 1] = green[index] * 255;
    data[index * 4 + 2] = blue[index] * 255;
    data[index * 4 + 3] = 255;
  }
  return { data, width, height };
}

/* ------------------------------------------------------------------ */
/* Streaming proof accumulation                                        */
/* ------------------------------------------------------------------ */

/**
 * Incremental form of proofCompositeCmyk for streaming exports (and for
 * consumers deriving a composite from emitted plate bands). Create the
 * accumulator once, fold each plate's premultiplied ink as it completes —
 * IN PRESS ORDER (PLATE_SEQUENCE), because float multiplication is applied
 * in exactly proofCompositeCmyk's order — then quantize rows to RGBA. The
 * resulting bytes are bit-identical to the single-shot proof.
 */
export type ProofAccumulator = {
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  width: number;
  height: number;
};

/** Paper-filled proof accumulator; parity with proofCompositeCmyk's init. */
export function createProofAccumulator(
  width: number,
  height: number,
  paper: readonly [number, number, number] = [238, 234, 224],
): ProofAccumulator {
  const pixelCount = width * height;
  return {
    red: allocField(pixelCount, "proof", "proof-red").fill(paper[0] / 255),
    green: allocField(pixelCount, "proof", "proof-green").fill(paper[1] / 255),
    blue: allocField(pixelCount, "proof", "proof-blue").fill(paper[2] / 255),
    width,
    height,
  };
}

/** Ledger release for a proof accumulator's three fields (last reference drop). */
export function releaseProofAccumulator(accumulator: ProofAccumulator): void {
  releaseField(accumulator.red, "proof", "proof-red");
  releaseField(accumulator.green, "proof", "proof-green");
  releaseField(accumulator.blue, "proof", "proof-blue");
}

/**
 * Multiply one plate's premultiplied ink into the accumulator over
 * [start, end). Same absorb factors and per-pixel ops as proofCompositeCmyk.
 */
export function foldPlateIntoProof(
  accumulator: ProofAccumulator,
  plate: RenderPlateId,
  inkPremultiplied: Float32Array,
  start = 0,
  end = inkPremultiplied.length,
): void {
  const [plateRed, plateGreen, plateBlue] = PLATE_PROOF_COLORS[plate];
  const absorbRed = 1 - plateRed / 255;
  const absorbGreen = 1 - plateGreen / 255;
  const absorbBlue = 1 - plateBlue / 255;
  const { red, green, blue } = accumulator;
  for (let index = start; index < end; index += 1) {
    const coverage = clamp(inkPremultiplied[index]);
    red[index] *= 1 - coverage * absorbRed;
    green[index] *= 1 - coverage * absorbGreen;
    blue[index] *= 1 - coverage * absorbBlue;
  }
}

/**
 * Band variant of foldPlateIntoProof for consumers folding emitted
 * plate-band buffers (0-based rows) into an accumulator at an absolute
 * pixel offset. Same absorb factors and per-pixel op order, so folding a
 * plate band-by-band is bit-identical to folding it whole.
 */
export function foldPlateRowsIntoProof(
  accumulator: ProofAccumulator,
  plate: RenderPlateId,
  inkRows: Float32Array,
  accumulatorOffset: number,
  pixelCount: number = inkRows.length,
): void {
  const [plateRed, plateGreen, plateBlue] = PLATE_PROOF_COLORS[plate];
  const absorbRed = 1 - plateRed / 255;
  const absorbGreen = 1 - plateGreen / 255;
  const absorbBlue = 1 - plateBlue / 255;
  const { red, green, blue } = accumulator;
  for (let index = 0; index < pixelCount; index += 1) {
    const coverage = clamp(inkRows[index]);
    const at = accumulatorOffset + index;
    red[at] *= 1 - coverage * absorbRed;
    green[at] *= 1 - coverage * absorbGreen;
    blue[at] *= 1 - coverage * absorbBlue;
  }
}

/** Quantize `rowCount` accumulator rows starting at `rowStart` to RGBA bytes. */
export function quantizeProofRows(
  accumulator: ProofAccumulator,
  rowStart: number,
  rowCount: number,
): Uint8ClampedArray {
  const { red, green, blue, width } = accumulator;
  const data = new Uint8ClampedArray(rowCount * width * 4);
  const base = rowStart * width;
  for (let index = 0; index < rowCount * width; index += 1) {
    data[index * 4] = red[base + index] * 255;
    data[index * 4 + 1] = green[base + index] * 255;
    data[index * 4 + 2] = blue[base + index] * 255;
    data[index * 4 + 3] = 255;
  }
  return data;
}
