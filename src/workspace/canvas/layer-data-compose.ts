/**
 * Reduced-path preview compositing — pure typed-array math that turns
 * render-worker payloads into drawable RGBA rasters on the main thread.
 *
 * Two payload situations reach this module:
 * - form "plates": the worker composed each plate (knockout semantics) and,
 *   for composite views, already delivered the proof raster. Plate views
 *   convert one plate's premultiplied ink into monochrome #111214 ink over
 *   paper — the legacy monochromePlate convention.
 * - form "layer-data" (no OffscreenCanvas anywhere): per-layer kernel
 *   outputs arrive raw. Ink derivation per mode: HALFTONE rasterizes dot
 *   placements through an injected rasterizer (canvas-backed in the app,
 *   deterministic fake in tests); DIFFUSION thresholds the field at 0.5
 *   (renderDiffusionPlate parity); CLEAN uses the field POINTWISE as ink —
 *   field-as-ink, no screening. Plates then compose bottom-to-top with the
 *   same composePlate/proofCompositeCmyk math the workers use, so the
 *   reduced path and the worker path stay in exact behavioral agreement.
 */

import {
  clamp,
  composePlate,
  proofCompositeCmyk,
  type ComposedPlate,
  type LayerPlateData,
  type PlateLayerOutput,
  type RenderPlateId,
  type RenderResultPayload,
} from "../../render";
import type { RasterData } from "../../export/orchestrator";

/** Legacy monochrome plate ink (#111214). */
export const PLATE_VIEW_INK: readonly [number, number, number] = [0x11, 0x12, 0x14];

/** Rasterize halftone dot placements to an ink field (canvas in the app). */
export type HalftoneRasterizer = (
  layer: LayerPlateData,
  width: number,
  height: number,
) => Float32Array;

/** Nearest-neighbor field resample (identical to the executor's mapping). */
export function resampleFieldNearest(
  field: Float32Array,
  sampleWidth: number,
  sampleHeight: number,
  width: number,
  height: number,
): Float32Array {
  if (sampleWidth === width && sampleHeight === height) return field;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sampleY = Math.max(
      0,
      Math.min(sampleHeight - 1, Math.round((y / height) * sampleHeight)),
    );
    for (let x = 0; x < width; x += 1) {
      const sampleX = Math.max(
        0,
        Math.min(sampleWidth - 1, Math.round((x / width) * sampleWidth)),
      );
      out[y * width + x] = field[sampleY * sampleWidth + sampleX];
    }
  }
  return out;
}

/** One layer's ink field at output size, per its mode (see module header). */
export function layerDataInk(
  layer: LayerPlateData,
  width: number,
  height: number,
  rasterizeHalftone: HalftoneRasterizer,
): Float32Array {
  if (layer.mode === "halftone") {
    return rasterizeHalftone(layer, width, height);
  }
  const field = new Float32Array(layer.field.buffer);
  const resampled = resampleFieldNearest(
    field,
    layer.field.width,
    layer.field.height,
    width,
    height,
  );
  if (layer.mode === "clean") {
    // Field-as-ink, pointwise: continuous-tone coverage IS the ink.
    const ink = resampled === field ? field.slice() : resampled;
    for (let index = 0; index < ink.length; index += 1) ink[index] = clamp(ink[index]);
    return ink;
  }
  // Diffusion: binary mask at the 0.5 threshold (renderDiffusionPlate parity).
  const ink = resampled === field ? field.slice() : resampled;
  for (let index = 0; index < ink.length; index += 1) {
    ink[index] = ink[index] < 0.5 ? 0 : 1;
  }
  return ink;
}

/** The layer's source-alpha field at output size. */
export function layerDataAlpha(
  layer: LayerPlateData,
  width: number,
  height: number,
): Float32Array {
  return resampleFieldNearest(
    new Float32Array(layer.alpha.buffer),
    layer.alpha.width,
    layer.alpha.height,
    width,
    height,
  );
}

/**
 * Compose a "layer-data" payload into per-plate knockout-composited plates.
 * `layerOpacities` maps layerIndex → opacity (the payload does not carry it).
 */
export function composeLayerDataPlates(
  payload: Extract<RenderResultPayload, { form: "layer-data" }>,
  plates: RenderPlateId[],
  layerOpacities: readonly number[],
  rasterizeHalftone: HalftoneRasterizer,
): Partial<Record<RenderPlateId, ComposedPlate>> {
  const { width, height } = payload;
  const composed: Partial<Record<RenderPlateId, ComposedPlate>> = {};
  for (const plate of plates) {
    const plateLayers: PlateLayerOutput[] = [];
    // Payload entries are emitted plate-major, layer order preserved
    // (bottom-to-top) — filter keeps that order.
    for (const layer of payload.layers) {
      if (layer.plate !== plate) continue;
      plateLayers.push({
        ink: layerDataInk(layer, width, height, rasterizeHalftone),
        alpha: layerDataAlpha(layer, width, height),
        opacity: clamp(layerOpacities[layer.layerIndex] ?? 1),
      });
    }
    composed[plate] = composePlate(plateLayers, width * height);
  }
  return composed;
}

/**
 * Alpha-preserving proof compose for a TRANSPARENT artboard background.
 *
 * Model: the artwork stack is a film. Per pixel, coverage A is the composed
 * stack alpha (identical across plates by construction; max() is used for
 * robustness against an absent plate). Within the covered region the
 * STRAIGHT ink coverage (inkPremultiplied / A) filters white light with the
 * same multiplicative absorb factors proofCompositeCmyk uses, and the
 * result carries straight alpha A — so compositing the returned raster
 * over any ground reproduces the covered/uncovered split exactly, and a
 * fully uncovered pixel is genuinely transparent (alpha 0).
 */
export function proofCompositeTransparent(
  composed: Partial<Record<RenderPlateId, ComposedPlate>>,
  width: number,
  height: number,
): RasterData {
  const pixelCount = width * height;
  const alpha = new Float32Array(pixelCount);
  for (const plate of Object.values(composed)) {
    if (!plate) continue;
    for (let index = 0; index < pixelCount; index += 1) {
      const value = clamp(plate.alpha[index]);
      if (value > alpha[index]) alpha[index] = value;
    }
  }
  // Straight-coverage plates, then the shared white-light multiply.
  const straight: Partial<Record<RenderPlateId, ComposedPlate>> = {};
  for (const [plateId, plate] of Object.entries(composed) as Array<
    [RenderPlateId, ComposedPlate | undefined]
  >) {
    if (!plate) continue;
    const ink = new Float32Array(pixelCount);
    for (let index = 0; index < pixelCount; index += 1) {
      const coverage = alpha[index];
      ink[index] = coverage > 0 ? clamp(plate.inkPremultiplied[index] / coverage) : 0;
    }
    straight[plateId] = { inkPremultiplied: ink, alpha: plate.alpha };
  }
  const overWhite = proofCompositeCmyk(straight, width, height, [255, 255, 255]);
  for (let index = 0; index < pixelCount; index += 1) {
    overWhite.data[index * 4 + 3] = Math.round(alpha[index] * 255);
  }
  return overWhite;
}

/**
 * Composite proof raster from composed plates (press order): over paper
 * when given, alpha-preserving (transparent background) when paper is null.
 */
export function proofRasterFromComposed(
  composed: Partial<Record<RenderPlateId, ComposedPlate>>,
  width: number,
  height: number,
  paper: readonly [number, number, number] | null,
): RasterData {
  if (paper === null) return proofCompositeTransparent(composed, width, height);
  return proofCompositeCmyk(composed, width, height, paper);
}

/**
 * Monochrome plate-view raster: premultiplied ink coverage over paper in the
 * legacy #111214 plate ink. An absent/empty ink field yields plain paper.
 */
export function plateViewRaster(
  ink: Float32Array | null,
  width: number,
  height: number,
  paper: readonly [number, number, number],
  inkRgb: readonly [number, number, number] = PLATE_VIEW_INK,
): RasterData {
  const data = new Uint8ClampedArray(width * height * 4);
  const [paperRed, paperGreen, paperBlue] = paper;
  const [inkRed, inkGreen, inkBlue] = inkRgb;
  for (let index = 0; index < width * height; index += 1) {
    const coverage = ink ? clamp(ink[index]) : 0;
    const at = index * 4;
    data[at] = inkRed * coverage + paperRed * (1 - coverage);
    data[at + 1] = inkGreen * coverage + paperGreen * (1 - coverage);
    data[at + 2] = inkBlue * coverage + paperBlue * (1 - coverage);
    data[at + 3] = 255;
  }
  return { data, width, height };
}
