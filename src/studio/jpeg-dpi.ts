/**
 * JFIF density stamping for exported JPEGs.
 *
 * Canvas `toBlob("image/jpeg")` emits a JFIF APP0 whose density is the
 * meaningless default (unit 0, 1×1 aspect), so a 240-DPI press proof
 * carried no truthful resolution metadata. withJpegDpi rewrites (or
 * inserts) the JFIF APP0 segment with unit 1 (dots per inch) and the given
 * X/Y density — pure byte surgery, no re-encode, pixel data untouched.
 *
 * parseJpegDensity is the matching reader used by tests to verify actual
 * bytes rather than trusting the writer.
 */

const SOI = 0xffd8;
const APP0 = 0xffe0;
const JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"

export type JpegDensity = {
  /** 0 = aspect only, 1 = dots per inch, 2 = dots per cm. */
  unit: number;
  x: number;
  y: number;
};

function isJfifApp0(bytes: Uint8Array, segmentStart: number): boolean {
  // segmentStart points at the 0xFF of the APP0 marker.
  for (let index = 0; index < JFIF_ID.length; index += 1) {
    if (bytes[segmentStart + 4 + index] !== JFIF_ID[index]) return false;
  }
  return true;
}

/**
 * Reads the JFIF density of a JPEG byte stream, or null when no JFIF APP0
 * segment exists before the first scan.
 */
export function parseJpegDensity(bytes: Uint8Array): JpegDensity | null {
  if (bytes.length < 4 || ((bytes[0] << 8) | bytes[1]) !== SOI) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = (bytes[offset] << 8) | bytes[offset + 1];
    if (marker === 0xffd9 || marker === 0xffda) return null; // EOI / SOS
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker === APP0 && length >= 16 && isJfifApp0(bytes, offset)) {
      const base = offset + 4 + JFIF_ID.length + 2; // skip id + version
      return {
        unit: bytes[base],
        x: (bytes[base + 1] << 8) | bytes[base + 2],
        y: (bytes[base + 3] << 8) | bytes[base + 4],
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Builds a JFIF 1.02 APP0 segment carrying the density (unit 1 = DPI). */
function jfifSegment(dpi: number): Uint8Array {
  const segment = new Uint8Array(18);
  segment[0] = 0xff;
  segment[1] = 0xe0;
  segment[2] = 0x00;
  segment[3] = 16; // length (excludes the marker itself)
  segment.set(JFIF_ID, 4);
  segment[9] = 1; // version 1.02
  segment[10] = 2;
  segment[11] = 1; // unit: dots per inch
  segment[12] = (dpi >> 8) & 0xff;
  segment[13] = dpi & 0xff;
  segment[14] = (dpi >> 8) & 0xff;
  segment[15] = dpi & 0xff;
  segment[16] = 0; // no thumbnail
  segment[17] = 0;
  return segment;
}

/**
 * Returns the JPEG with a JFIF APP0 density of `dpi` in both axes (unit 1).
 * An existing JFIF APP0 is rewritten in place (thumbnail preserved); a
 * stream without one gains a fresh segment directly after SOI.
 *
 * Rejects with TypeError when the Blob is not a JPEG.
 */
export async function withJpegDpi(blob: Blob, dpi: number): Promise<Blob> {
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 0xffff) {
    throw new RangeError("withJpegDpi expected dpi to be a positive value ≤ 65535");
  }
  const rounded = Math.round(dpi);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 4 || ((bytes[0] << 8) | bytes[1]) !== SOI) {
    throw new TypeError("withJpegDpi expected a JPEG Blob (invalid SOI marker)");
  }

  // Locate an existing JFIF APP0 before the first scan.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = (bytes[offset] << 8) | bytes[offset + 1];
    if (marker === 0xffd9 || marker === 0xffda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === APP0 && length >= 16 && isJfifApp0(bytes, offset)) {
      const output = bytes.slice();
      const base = offset + 4 + JFIF_ID.length + 2;
      output[base] = 1; // dots per inch
      output[base + 1] = (rounded >> 8) & 0xff;
      output[base + 2] = rounded & 0xff;
      output[base + 3] = (rounded >> 8) & 0xff;
      output[base + 4] = rounded & 0xff;
      return new Blob([output], { type: blob.type || "image/jpeg" });
    }
    offset += 2 + length;
  }

  // No JFIF APP0: insert one directly after SOI (JFIF's required position).
  const segment = jfifSegment(rounded);
  const output = new Uint8Array(bytes.length + segment.length);
  output.set(bytes.subarray(0, 2), 0);
  output.set(segment, 2);
  output.set(bytes.subarray(2), 2 + segment.length);
  return new Blob([output], { type: blob.type || "image/jpeg" });
}
