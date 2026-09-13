/**
 * Programmatic raster fixtures with REAL, internally consistent payloads,
 * plus the reference RasterDecoder unit tests inject (unit tests run in
 * node, where the production browser decoder does not exist and the
 * fail-closed default refuses to decode).
 *
 * The reference decoder performs a structural FULL-payload decode:
 * - PNG: chunk walk (IHDR/IDAT/IEND), real zlib inflation of the
 *   concatenated IDAT stream, and an exact decoded-byte-count check against
 *   the IHDR geometry — truncated or corrupt IDAT genuinely fails.
 * - JPEG: requires a frame header (SOF), a scan (SOS) with entropy data, and
 *   the EOI terminator — SOF-only and scan-truncated payloads fail.
 * - WebP: requires the RIFF size to match the file and every chunk to fit —
 *   incomplete payloads fail.
 * Decoded dimensions come from the actual payload structures.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { RasterDecoder } from "../../../src/io/raster-decoder";

/* ------------------------------------------------------------------ */
/* Byte helpers                                                        */
/* ------------------------------------------------------------------ */

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32le(value: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function ascii(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concat(ascii(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

export type PngFixtureOptions = {
  /** Varies pixel content so different seeds get different content hashes. */
  seed?: string;
  /** Cut the deflate stream short: chunk structure stays valid, decode fails. */
  truncateIdat?: boolean;
  /** Corrupt the deflate stream in place (chunk CRC recomputed): decode fails. */
  corruptIdat?: boolean;
};

/** Real 8-bit RGBA PNG with genuine zlib-deflated scanlines. */
export function makeDecodablePng(width: number, height: number, options: PngFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const ihdr = concat(u32be(width), u32be(height), Uint8Array.of(8, 6, 0, 0, 0));
  const stride = 1 + width * 4;
  const rawScanlines = new Uint8Array(height * stride);
  let seedState = 0;
  for (const c of options.seed ?? "png") seedState = (seedState * 31 + c.charCodeAt(0)) >>> 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    rawScanlines[row] = 0; // filter: None
    for (let x = 0; x < width * 4; x++) {
      seedState = (seedState * 1664525 + 1013904223) >>> 0;
      rawScanlines[row + 1 + x] = seedState & 0xff;
    }
  }
  let deflated = new Uint8Array(deflateSync(rawScanlines));
  if (options.truncateIdat) deflated = deflated.slice(0, Math.max(2, deflated.length - 8));
  if (options.corruptIdat) {
    deflated = deflated.slice();
    const at = Math.min(4, deflated.length - 1);
    deflated[at] ^= 0xff;
    if (deflated.length > 6) deflated[at + 2] ^= 0xa5;
  }
  return concat(PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflated), pngChunk("IEND", new Uint8Array(0)));
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 45) throw new Error("PNG too short to decode");
  const width = readU32be(bytes, 16);
  const height = readU32be(bytes, 20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  const channels = PNG_CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const idatParts: Uint8Array[] = [];
  let sawEnd = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32be(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (offset + 12 + length > bytes.length) throw new Error(`PNG chunk ${type} exceeds the file`);
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    if (readU32be(bytes, offset + 8 + length) !== crc32(body)) throw new Error(`PNG chunk ${type} CRC mismatch`);
    if (type === "IDAT") idatParts.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset += 12 + length;
  }
  if (!sawEnd) throw new Error("PNG has no IEND");
  if (!idatParts.length) throw new Error("PNG has no IDAT");
  const inflated = new Uint8Array(inflateSync(concat(...idatParts)));
  if (interlace === 0) {
    const bitsPerPixel = channels * bitDepth;
    const stride = 1 + Math.ceil((width * bitsPerPixel) / 8);
    if (inflated.length !== height * stride) {
      throw new Error(`PNG decoded to ${inflated.length} bytes, expected ${height * stride}`);
    }
  }
  return { width, height };
}

/* ------------------------------------------------------------------ */
/* JPEG                                                                */
/* ------------------------------------------------------------------ */

export type JpegFixtureOptions = {
  /** "full" = SOF+SOS+entropy+EOI; "sof-only" = no scan; "truncated" = scan without EOI. */
  scan?: "full" | "sof-only" | "truncated";
};

/** Structurally consistent baseline JPEG fixture (grayscale, 1 component). */
export function makeJpeg(width: number, height: number, options: JpegFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const scan = options.scan ?? "full";
  const soi = Uint8Array.of(0xff, 0xd8);
  const sof = Uint8Array.of(
    0xff, 0xc0, 0x00, 0x0b, // SOF0, length 11
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, // one component
    0x01, 0x11, 0x00, // component 1, sampling 1x1, quant table 0
  );
  const eoi = Uint8Array.of(0xff, 0xd9);
  if (scan === "sof-only") return concat(soi, sof, eoi);
  const sos = Uint8Array.of(
    0xff, 0xda, 0x00, 0x08, // SOS, length 8
    0x01, 0x01, 0x00, // one component, tables
    0x00, 0x3f, 0x00, // spectral selection
  );
  const entropy = Uint8Array.of(0x25, 0x51, 0x12, 0x77, 0x3a, 0x0c, 0x59, 0x6e);
  if (scan === "truncated") return concat(soi, sof, sos, entropy);
  return concat(soi, sof, sos, entropy, eoi);
}

function decodeJpeg(bytes: Uint8Array): { width: number; height: number } {
  let width = -1;
  let height = -1;
  let sosAt = -1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("invalid JPEG marker stream");
    const marker = bytes[offset + 1];
    if (marker === 0xd9) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) throw new Error("truncated JPEG segment");
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      width = (bytes[offset + 7] << 8) | bytes[offset + 8];
    }
    if (marker === 0xda) {
      sosAt = offset + 2 + length;
      break;
    }
    offset += 2 + length;
  }
  if (width < 0) throw new Error("JPEG has no frame header");
  if (sosAt < 0) throw new Error("JPEG has no scan (SOS)");
  if (bytes.length < sosAt + 3) throw new Error("JPEG scan has no entropy data");
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error("JPEG scan is truncated (no EOI)");
  }
  return { width, height };
}

/* ------------------------------------------------------------------ */
/* WebP                                                                */
/* ------------------------------------------------------------------ */

export type WebpFixtureOptions = {
  /** Truncate the payload so the RIFF size lies about the file. */
  incomplete?: boolean;
};

/** Structurally consistent lossless (VP8L) WebP fixture. */
export function makeWebp(width: number, height: number, options: WebpFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const w = width - 1;
  const h = height - 1;
  const dimBits = Uint8Array.of(
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f, // alpha=0, version=0
  );
  const payload = concat(Uint8Array.of(0x2f), dimBits, Uint8Array.of(0x11, 0x22, 0x33, 0x44, 0x55, 0x66));
  const padded = payload.length % 2 ? concat(payload, Uint8Array.of(0)) : payload;
  const full = concat(
    ascii("RIFF"),
    u32le(4 + 8 + padded.length),
    ascii("WEBP"),
    ascii("VP8L"),
    u32le(payload.length),
    padded,
  );
  return options.incomplete ? full.slice(0, Math.max(25, full.length - 4)) : full;
}

function decodeWebp(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 30) throw new Error("WebP too short to decode");
  const riffSize = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] * 0x1000000);
  if (riffSize + 8 !== bytes.length) {
    throw new Error(`WebP RIFF declares ${riffSize + 8} bytes but the file has ${bytes.length}`);
  }
  let offset = 12;
  let dims: { width: number; height: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] * 0x1000000);
    if (offset + 8 + size > bytes.length) throw new Error(`WebP chunk ${type} exceeds the file`);
    if (type === "VP8L") {
      if (bytes[offset + 8] !== 0x2f) throw new Error("invalid VP8L signature");
      const b1 = bytes[offset + 9];
      const b2 = bytes[offset + 10];
      const b3 = bytes[offset + 11];
      const b4 = bytes[offset + 12];
      dims = {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
      };
    }
    if (type === "VP8 ") {
      dims = {
        width: (bytes[offset + 14] | (bytes[offset + 15] << 8)) & 0x3fff,
        height: (bytes[offset + 16] | (bytes[offset + 17] << 8)) & 0x3fff,
      };
    }
    offset += 8 + size + (size % 2);
  }
  if (!dims) throw new Error("WebP has no image chunk");
  return dims;
}

/* ------------------------------------------------------------------ */
/* Reference decoder                                                   */
/* ------------------------------------------------------------------ */

/** Structural full-payload decoder for node unit tests (see module doc). */
export const referenceRasterDecoder: RasterDecoder = {
  async decode(bytes, mime, signal) {
    if (signal?.aborted) {
      throw new DOMException("The raster decode was aborted.", "AbortError");
    }
    switch (mime) {
      case "image/png":
        return decodePng(bytes);
      case "image/jpeg":
        return decodeJpeg(bytes);
      case "image/webp":
        return decodeWebp(bytes);
      default:
        throw new Error(`unsupported mime ${mime as string}`);
    }
  },
};
