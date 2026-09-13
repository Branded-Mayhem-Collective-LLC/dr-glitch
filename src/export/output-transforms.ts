/**
 * Output-stage transforms applied at export encoding time: polarity and
 * press mirror. These are the ONLY output-space operations in the pipeline;
 * per-layer recipe inverts act earlier, in coverage space (see the
 * OutputDefaultsV1.polarity contract in src/core/types.ts).
 *
 * POLARITY (plates only). A raster plate encodes ink coverage in its ALPHA
 * channel over an ink-colored RGB (#111214, legacy plate ink). "negative"
 * inverts that coverage per pixel over the plate's full printable area — the
 * entire artboard rectangle: alpha' = 255 − alpha, RGB forced to the plate
 * ink color everywhere (transparent pixels carry undefined RGB, and a
 * negative makes them ink). POLARITY APPLIES TO ARTWORK COVERAGE ONLY:
 * registration marks are the FINAL content pass, painted UNCHANGED (normal
 * ink) after polarity — on a negative the artwork renders without marks,
 * the coverage inverts, and the marks are then painted on top (see the
 * orchestrator's plate pipeline). Matte never interacts with polarity
 * because plates are always transparent-backed (resolveMatte). Polarity
 * does NOT apply to composite or selected-layer exports — those are proofs/
 * artwork cutouts, not press plates. Negative SVG plate packages are
 * refused in preflight ("polarity-vector-unsupported"): a genuine vector
 * negative needs boolean geometry subtraction, and emitting white-filled
 * marks over a black field would smuggle paint-order tricks into claimed
 * vector output.
 *
 * PRESS MIRROR (every target). Horizontally flips the COMPLETED sheet —
 * raster rows reverse pixel order; SVG plates wrap their content in a
 * translate(width) scale(-1,1) group. One rule: registration marks are in
 * the sheet before the mirror (they are the final content pass) and flip
 * with it, so marks, screens, and artwork all stay mutually registered.
 */

import type { ArtboardV1, OutputDefaultsV1, RegistrationV1 } from "../core/types";
import type { ExportTarget } from "./targets";
import type { RasterData } from "./orchestrator";

/** Legacy plate ink color #111214 (r, g, b). */
export const PLATE_INK_RGB: readonly [number, number, number] = [0x11, 0x12, 0x14];

/** Legacy registration ink #121416 at 70% alpha. */
const REGISTRATION_RGB: readonly [number, number, number] = [0x12, 0x14, 0x16];
const REGISTRATION_ALPHA = 0.7;

/** Legacy registration mark layout (size/offset defaults, corner/centered). */
export function registrationPoints(
  registration: RegistrationV1,
  width: number,
  height: number,
): { points: [number, number][]; size: number; weight: number } {
  const size = registration.size ?? Math.max(7, Math.round(Math.min(width, height) * 0.014));
  const offset = registration.offset ?? Math.max(14, Math.round(Math.min(width, height) * 0.035));
  const weight = Math.max(0.5, registration.weight);
  const points: [number, number][] =
    registration.mode === "centered"
      ? [
          [width / 2, offset],
          [width / 2, height - offset],
        ]
      : [
          [offset, offset],
          [width - offset, offset],
          [offset, height - offset],
          [width - offset, height - offset],
        ];
  return { points, size, weight };
}

/**
 * Paint built-in registration marks (circle r = 0.58·size stroke +
 * crosshair of half-length size, #121416 at 70% alpha, source-over) into a
 * raster IN PLACE. Binary stroke coverage at pixel centers — a DOM-free
 * stand-in for the legacy canvas stroke; geometry, colors, and layout match
 * the legacy defaults exactly. Marks are always the FINAL content pass:
 * polarity never touches them (see transformExportRaster).
 */
export function paintRegistrationMarks(raster: RasterData, registration: RegistrationV1): void {
  const { width, height, data } = raster;
  const { points, size, weight } = registrationPoints(registration, width, height);
  const radius = size * 0.58;
  const halfStroke = weight / 2;
  const [sourceRed, sourceGreen, sourceBlue] = REGISTRATION_RGB;
  for (const [centerX, centerY] of points) {
    const left = Math.max(0, Math.floor(centerX - size - weight));
    const right = Math.min(width - 1, Math.ceil(centerX + size + weight));
    const top = Math.max(0, Math.floor(centerY - size - weight));
    const bottom = Math.min(height - 1, Math.ceil(centerY + size + weight));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x + 0.5 - centerX;
        const dy = y + 0.5 - centerY;
        const onCircle = Math.abs(Math.hypot(dx, dy) - radius) <= halfStroke;
        const onCross =
          (Math.abs(dx) <= halfStroke && Math.abs(dy) <= size) ||
          (Math.abs(dy) <= halfStroke && Math.abs(dx) <= size);
        if (!onCircle && !onCross) continue;
        const index = (y * width + x) * 4;
        const destinationAlpha = data[index + 3] / 255;
        const outAlpha = REGISTRATION_ALPHA + destinationAlpha * (1 - REGISTRATION_ALPHA);
        const keep = (destinationAlpha * (1 - REGISTRATION_ALPHA)) / outAlpha;
        const add = REGISTRATION_ALPHA / outAlpha;
        data[index] = sourceRed * add + data[index] * keep;
        data[index + 1] = sourceGreen * add + data[index + 1] * keep;
        data[index + 2] = sourceBlue * add + data[index + 2] * keep;
        data[index + 3] = outAlpha * 255;
      }
    }
  }
}

/**
 * Band-aware registration painter (wave G2 streamed delivery): paints the
 * SAME built-in marks as paintRegistrationMarks, restricted to the rows
 * [rowStart, rowStart + rowCount) of a full-height sheet, into an RGBA row
 * band IN PLACE. Per-pixel math, point order, and compositing are shared
 * with the whole-raster painter, so band-partitioned output is
 * byte-identical to painting the assembled sheet.
 */
export function paintRegistrationMarksRows(
  rows: Uint8ClampedArray,
  rowStart: number,
  rowCount: number,
  width: number,
  height: number,
  registration: RegistrationV1,
): void {
  const { points, size, weight } = registrationPoints(registration, width, height);
  const radius = size * 0.58;
  const halfStroke = weight / 2;
  const [sourceRed, sourceGreen, sourceBlue] = REGISTRATION_RGB;
  const bandEnd = rowStart + rowCount;
  for (const [centerX, centerY] of points) {
    const left = Math.max(0, Math.floor(centerX - size - weight));
    const right = Math.min(width - 1, Math.ceil(centerX + size + weight));
    const top = Math.max(rowStart, Math.max(0, Math.floor(centerY - size - weight)));
    const bottom = Math.min(bandEnd - 1, Math.min(height - 1, Math.ceil(centerY + size + weight)));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x + 0.5 - centerX;
        const dy = y + 0.5 - centerY;
        const onCircle = Math.abs(Math.hypot(dx, dy) - radius) <= halfStroke;
        const onCross =
          (Math.abs(dx) <= halfStroke && Math.abs(dy) <= size) ||
          (Math.abs(dy) <= halfStroke && Math.abs(dx) <= size);
        if (!onCircle && !onCross) continue;
        const index = ((y - rowStart) * width + x) * 4;
        const destinationAlpha = rows[index + 3] / 255;
        const outAlpha = REGISTRATION_ALPHA + destinationAlpha * (1 - REGISTRATION_ALPHA);
        const keep = (destinationAlpha * (1 - REGISTRATION_ALPHA)) / outAlpha;
        const add = REGISTRATION_ALPHA / outAlpha;
        rows[index] = sourceRed * add + rows[index] * keep;
        rows[index + 1] = sourceGreen * add + rows[index + 1] * keep;
        rows[index + 2] = sourceBlue * add + rows[index + 2] * keep;
        rows[index + 3] = outAlpha * 255;
      }
    }
  }
}

/** Polarity is an output-stage plate operation; proofs/cutouts are exempt. */
export function polarityApplies(target: ExportTarget): boolean {
  return target.kind === "plate-package";
}

/**
 * Invert a raster plate's ink coverage: alpha' = 255 − alpha, RGB set to the
 * plate ink color on every pixel. Input pixels must follow the plate-raster
 * convention (coverage in alpha).
 */
export function invertPlateInk(raster: RasterData): RasterData {
  const { width, height, data } = raster;
  const out = new Uint8ClampedArray(data.length);
  const [red, green, blue] = PLATE_INK_RGB;
  for (let index = 0; index < data.length; index += 4) {
    out[index] = red;
    out[index + 1] = green;
    out[index + 2] = blue;
    out[index + 3] = 255 - data[index + 3];
  }
  return { data: out, width, height };
}

/**
 * Convert premultiplied plate-ink rows (Float32 coverage) into RGBA plate
 * rows following the plate-raster convention: constant plate ink RGB with
 * coverage in the alpha channel — exactly the bytes createPlateRaster +
 * writePlateInkRows produce for the buffered path.
 */
export function plateInkRowsToRgba(ink: Float32Array, pixelCount: number): Uint8ClampedArray {
  const rows = new Uint8ClampedArray(pixelCount * 4);
  const [red, green, blue] = PLATE_INK_RGB;
  for (let index = 0; index < pixelCount; index += 1) {
    const at = index * 4;
    rows[at] = red;
    rows[at + 1] = green;
    rows[at + 2] = blue;
    const coverage = ink[index];
    rows[at + 3] = (coverage <= 0 ? 0 : coverage >= 1 ? 1 : coverage) * 255;
  }
  return rows;
}

/** In-place band variant of invertPlateInk: alpha' = 255 − alpha, ink RGB. */
export function invertPlateInkRows(rows: Uint8ClampedArray): void {
  const [red, green, blue] = PLATE_INK_RGB;
  for (let index = 0; index < rows.length; index += 4) {
    rows[index] = red;
    rows[index + 1] = green;
    rows[index + 2] = blue;
    rows[index + 3] = 255 - rows[index + 3];
  }
}

/** In-place per-row horizontal mirror of RGBA row bands (press mirror). */
export function mirrorRgbaRowsHorizontal(rows: Uint8ClampedArray, width: number): void {
  const rowCount = rows.length / (width * 4);
  for (let y = 0; y < rowCount; y += 1) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width >> 1; x += 1) {
      const left = rowBase + x * 4;
      const right = rowBase + (width - 1 - x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const keep = rows[left + channel];
        rows[left + channel] = rows[right + channel];
        rows[right + channel] = keep;
      }
    }
  }
}

/** Horizontal (left↔right) mirror of an RGBA raster. */
export function mirrorRasterHorizontal(raster: RasterData): RasterData {
  const { width, height, data } = raster;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const from = rowBase + x * 4;
      const to = rowBase + (width - 1 - x) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return { data: out, width, height };
}

/**
 * Horizontal mirror of an SVG plate document: wraps everything inside the
 * root <svg> element in a translate(width) scale(-1,1) group, so marks and
 * artwork flip together. `widthPx` is the viewBox width in document px.
 */
export function mirrorSvgHorizontal(svg: string, widthPx: number): string {
  const openEnd = svg.indexOf(">");
  const closeStart = svg.lastIndexOf("</svg>");
  if (openEnd < 0 || closeStart < 0 || closeStart <= openEnd) return svg;
  const head = svg.slice(0, openEnd + 1);
  const body = svg.slice(openEnd + 1, closeStart);
  const tail = svg.slice(closeStart);
  return `${head}<g transform="translate(${widthPx} 0) scale(-1 1)">${body}</g>${tail}`;
}

/**
 * Apply the document's output transforms to one finished export raster:
 * polarity first (plates only), then press mirror (every target). Identity
 * settings return the input untouched.
 */
export function transformExportRaster(
  raster: RasterData,
  target: ExportTarget,
  output: OutputDefaultsV1,
): RasterData {
  let result = raster;
  if (output.polarity === "negative" && polarityApplies(target)) {
    result = invertPlateInk(result);
  }
  if (output.pressMirror) result = mirrorRasterHorizontal(result);
  return result;
}

/**
 * Apply the document's output transforms to one finished SVG plate. Negative
 * polarity has no genuine vector form and must have been blocked upstream.
 */
export function transformExportSvg(
  svg: string,
  output: OutputDefaultsV1,
  artboard: Pick<ArtboardV1, "widthPx">,
): string {
  return output.pressMirror ? mirrorSvgHorizontal(svg, artboard.widthPx) : svg;
}
