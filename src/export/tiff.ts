/**
 * Minimal baseline TIFF writer for export: uncompressed, single strip,
 * little-endian, with 240-DPI resolution tags. Supports 8-bit RGBA
 * (unassociated alpha, as produced by canvas getImageData) and 8-bit
 * grayscale. IFD entries are written in ascending tag order as the TIFF 6.0
 * specification requires.
 *
 * The composite path in HalftoneStudio.tsx carries its own inline RGBA
 * encoder without resolution tags; this module supersedes it for the
 * workstation export pipeline (duplication noted for the lead).
 */

export const TIFF_DEFAULT_DPI = 240;

export type TiffColorType = "rgba" | "gray";

export type TiffEncodeOptions = {
  width: number;
  height: number;
  /** Interleaved samples: RGBA (4/px) or grayscale (1/px). */
  data: Uint8Array | Uint8ClampedArray;
  color: TiffColorType;
  /** Resolution written into XResolution/YResolution; defaults to 240 DPI. */
  dpi?: number;
};

/* TIFF field types. */
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

type IfdEntry = {
  tag: number;
  type: number;
  count: number;
  /** Inline value or absolute offset for out-of-line data. */
  value: number;
};

/**
 * Everything before the pixel strip — header, IFD, out-of-line values —
 * with offsets computed purely from sizes, so the SAME preamble serves the
 * buffered encoder and the streamed chunk generator (their concatenated
 * bytes are identical by construction; tested).
 */
export function buildTiffPreamble(
  width: number,
  height: number,
  color: TiffColorType,
  dpi: number,
): Uint8Array {
  return encodeTiffPreambleInto(width, height, color, dpi, null);
}

export function encodeTiff(options: TiffEncodeOptions): Uint8Array {
  const { width, height, data, color } = options;
  const dpi = options.dpi ?? TIFF_DEFAULT_DPI;
  const samplesPerPixel = color === "rgba" ? 4 : 1;
  const pixelBytes = width * height * samplesPerPixel;
  if (data.length !== pixelBytes) {
    throw new RangeError(
      `encodeTiff expected ${pixelBytes} sample bytes for ${width}x${height} ${color}, got ${data.length}`,
    );
  }
  return encodeTiffPreambleInto(width, height, color, dpi, data);
}

/** Shared implementation: preamble alone (data null) or the whole file. */
function encodeTiffPreambleInto(
  width: number,
  height: number,
  color: TiffColorType,
  dpi: number,
  data: Uint8Array | Uint8ClampedArray | null,
): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("encodeTiff expected positive integer dimensions");
  }
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError("encodeTiff expected a positive, finite dpi");
  }
  const samplesPerPixel = color === "rgba" ? 4 : 1;
  const pixelBytes = width * height * samplesPerPixel;

  const entryCount = color === "rgba" ? 14 : 13;
  const headerBytes = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  // Out-of-line data: BitsPerSample array (RGBA only) then two RATIONALs.
  const bitsOffset = headerBytes + ifdBytes;
  const bitsBytes = color === "rgba" ? 8 : 0;
  const xResOffset = bitsOffset + bitsBytes;
  const yResOffset = xResOffset + 8;
  const pixelOffset = yResOffset + 8;

  const buffer = new ArrayBuffer(data ? pixelOffset + pixelBytes : pixelOffset);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Header: little-endian ("II"), magic 42, first IFD immediately after.
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, headerBytes, true);

  const entries: IfdEntry[] = [
    { tag: 256, type: TYPE_LONG, count: 1, value: width }, // ImageWidth
    { tag: 257, type: TYPE_LONG, count: 1, value: height }, // ImageLength
    color === "rgba"
      ? { tag: 258, type: TYPE_SHORT, count: 4, value: bitsOffset } // BitsPerSample
      : { tag: 258, type: TYPE_SHORT, count: 1, value: 8 },
    { tag: 259, type: TYPE_SHORT, count: 1, value: 1 }, // Compression: none
    { tag: 262, type: TYPE_SHORT, count: 1, value: color === "rgba" ? 2 : 1 }, // Photometric
    { tag: 273, type: TYPE_LONG, count: 1, value: pixelOffset }, // StripOffsets
    { tag: 277, type: TYPE_SHORT, count: 1, value: samplesPerPixel }, // SamplesPerPixel
    { tag: 278, type: TYPE_LONG, count: 1, value: height }, // RowsPerStrip
    { tag: 279, type: TYPE_LONG, count: 1, value: pixelBytes }, // StripByteCounts
    { tag: 282, type: TYPE_RATIONAL, count: 1, value: xResOffset }, // XResolution
    { tag: 283, type: TYPE_RATIONAL, count: 1, value: yResOffset }, // YResolution
    { tag: 284, type: TYPE_SHORT, count: 1, value: 1 }, // PlanarConfiguration: chunky
    { tag: 296, type: TYPE_SHORT, count: 1, value: 2 }, // ResolutionUnit: inch
  ];
  if (color === "rgba") {
    entries.push({ tag: 338, type: TYPE_SHORT, count: 1, value: 2 }); // ExtraSamples: unassociated alpha
  }
  if (entries.length !== entryCount) {
    throw new Error("encodeTiff entry count mismatch");
  }

  view.setUint16(headerBytes, entryCount, true);
  let cursor = headerBytes + 2;
  for (const entry of entries) {
    view.setUint16(cursor, entry.tag, true);
    view.setUint16(cursor + 2, entry.type, true);
    view.setUint32(cursor + 4, entry.count, true);
    if (entry.type === TYPE_SHORT && entry.count === 1) {
      view.setUint16(cursor + 8, entry.value, true);
    } else {
      view.setUint32(cursor + 8, entry.value, true);
    }
    cursor += 12;
  }
  view.setUint32(cursor, 0, true); // no next IFD

  if (color === "rgba") {
    for (let sample = 0; sample < 4; sample += 1) {
      view.setUint16(bitsOffset + sample * 2, 8, true);
    }
  }

  // DPI as an exact rational: dpi may be fractional, so scale by 10000.
  const denominator = Number.isInteger(dpi) ? 1 : 10_000;
  const numerator = Math.round(dpi * denominator);
  for (const offset of [xResOffset, yResOffset]) {
    view.setUint32(offset, numerator, true);
    view.setUint32(offset + 4, denominator, true);
  }

  if (data) bytes.set(data, pixelOffset);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Streamed TIFF (wave G2)                                             */
/* ------------------------------------------------------------------ */

export type TiffStreamOptions = {
  dpi?: number;
  signal?: AbortSignal;
  /** Rows per yielded band (default ≈4 MiB of sample bytes). */
  bandRows?: number;
};

const TIFF_BAND_TARGET_BYTES = 4 * 1024 * 1024;

/**
 * Streamed single-strip RGBA TIFF: yields the preamble, then bounded
 * row-band copies of the pixel strip. Concatenating every yielded chunk is
 * BYTE-IDENTICAL to encodeTiffRgba(width, height, data, dpi) — the strip
 * is uncompressed, so banding it changes nothing. No complete encoded file
 * ever exists; peak retention is one band copy.
 */
export async function* streamTiffRgbaChunks(
  raster: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
  options: TiffStreamOptions = {},
): AsyncGenerator<Uint8Array, void, void> {
  const { width, height, data } = raster;
  const dpi = options.dpi ?? TIFF_DEFAULT_DPI;
  const rowBytes = width * 4;
  if (data.length !== rowBytes * height) {
    throw new RangeError("streamTiffRgbaChunks expected a full RGBA raster");
  }
  yield buildTiffPreamble(width, height, "rgba", dpi);
  const bandRows = Math.max(1, options.bandRows ?? Math.floor(TIFF_BAND_TARGET_BYTES / rowBytes));
  for (let rowStart = 0; rowStart < height; rowStart += bandRows) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const rows = Math.min(bandRows, height - rowStart);
    const source = data.subarray(rowStart * rowBytes, (rowStart + rows) * rowBytes);
    // A copy per band: the consumer may retain the chunk across awaits.
    yield source instanceof Uint8ClampedArray
      ? new Uint8Array(source)
      : source.slice();
  }
}

/** Convenience wrapper for canvas-style RGBA pixel data. */
export function encodeTiffRgba(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
  dpi = TIFF_DEFAULT_DPI,
): Uint8Array {
  return encodeTiff({ width, height, data, color: "rgba", dpi });
}

/** Convenience wrapper for single-channel grayscale data. */
export function encodeTiffGray(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
  dpi = TIFF_DEFAULT_DPI,
): Uint8Array {
  return encodeTiff({ width, height, data, color: "gray", dpi });
}
