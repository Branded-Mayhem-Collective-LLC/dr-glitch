/**
 * Raster HEADER-ONLY pre-decode validation: magic-byte sniffing,
 * declared-type/extension cross-checks, animation rejection (APNG, animated
 * WebP), and header-level dimension extraction so pixel quotas are enforced
 * BEFORE any decoder runs. All rejections are typed RasterValidationError
 * values with stable codes.
 *
 * IMPORTANT: validateRaster() inspects HEADERS ONLY and returns RasterInfo —
 * it never proves the pixel payload decodes. Persist/commit/at-rest-verify
 * decisions require FULL content validation: validateRasterPayload() in
 * raster-decoder.ts, which runs these cheap gates first and then a complete
 * decode through an injectable adapter, returning the distinct
 * DecodedRasterInfo type so the two levels cannot be confused.
 */
import { RESOURCE_POLICY, type ResourcePolicy } from "../core/resource-policy";

export type RasterFormat = "png" | "jpeg" | "webp";

export type RasterInfo = {
  format: RasterFormat;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

export type RasterErrorCode =
  | "raster-empty"
  | "raster-too-large"
  | "raster-unknown-format"
  | "raster-format-mismatch"
  | "raster-malformed"
  | "raster-animated"
  | "raster-unsupported"
  | "raster-dimensions-invalid"
  | "raster-pixels-exceeded"
  // Full-content (payload) validation failures — thrown by raster-decoder.ts.
  | "raster-decode-failed"
  | "raster-decode-dimensions"
  | "raster-decode-unavailable";

export class RasterValidationError extends Error {
  readonly code: RasterErrorCode;
  constructor(code: RasterErrorCode, message: string) {
    super(message);
    this.name = "RasterValidationError";
    this.code = code;
  }
}

export type RasterPolicy = Pick<ResourcePolicy, "maxRasterBytes" | "maxRasterPixels">;

export type RasterValidationOptions = {
  /** Caller-declared MIME type (e.g. File.type); checked against sniffed bytes when present. */
  declaredType?: string;
  /** Filename whose extension is checked against sniffed bytes when present. */
  filename?: string;
  policy?: RasterPolicy;
};

/** Hard per-side cap: keeps width*height inside safe integer arithmetic. */
const MAX_SIDE = 1_000_000;

const MIME: Record<RasterFormat, RasterInfo["mime"]> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const EXTENSIONS: Record<string, RasterFormat> = {
  png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp",
};

function fail(code: RasterErrorCode, message: string): never {
  throw new RasterValidationError(code, message);
}

function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (offset + signature.length > bytes.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Identify the container from magic bytes; null when nothing matches. */
export function sniffRasterFormat(bytes: Uint8Array): RasterFormat | null {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return bytes[offset] << 8 | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | bytes[offset + 1] << 8;
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Walk PNG chunks: IHDR dimensions; acTL before IDAT marks an APNG. */
function parsePng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33) fail("raster-malformed", "Truncated PNG.");
  if (fourcc(bytes, 12) !== "IHDR" || u32be(bytes, 8) !== 13) fail("raster-malformed", "PNG is missing a valid IHDR chunk.");
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  let offset = 8;
  let chunks = 0;
  while (offset + 8 <= bytes.length) {
    if (++chunks > 10_000) fail("raster-malformed", "PNG has too many chunks.");
    const length = u32be(bytes, offset);
    const type = fourcc(bytes, offset + 4);
    if (length > bytes.length - offset - 12) {
      // Truncated tail chunks are a decode concern, not a header one, unless
      // we have not yet ruled animation out.
      if (type === "acTL") fail("raster-animated", "APNG animation is not supported.");
      fail("raster-malformed", "PNG chunk exceeds the file size.");
    }
    if (type === "acTL") fail("raster-animated", "APNG animation is not supported.");
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + length;
  }
  return { width, height };
}

/** Scan JPEG markers for a supported SOF segment. */
function parseJpeg(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  let steps = 0;
  while (offset + 4 <= bytes.length) {
    if (++steps > 10_000) fail("raster-malformed", "JPEG has too many segments.");
    if (bytes[offset] !== 0xff) fail("raster-malformed", "Invalid JPEG marker stream.");
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) { offset++; marker = bytes[offset + 1]; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9) break; // EOI without SOF
    const length = u16be(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) fail("raster-malformed", "Truncated JPEG segment.");
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) {
        fail("raster-unsupported", "Unsupported JPEG encoding (only baseline, extended, and progressive).");
      }
      if (length < 7) fail("raster-malformed", "Truncated JPEG frame header.");
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) };
    }
    if (marker === 0xda) break; // SOS reached without SOF
    offset += 2 + length;
  }
  fail("raster-malformed", "JPEG frame header not found.");
}

/** Read WebP dimensions from VP8/VP8L/VP8X; reject any animation signal. */
function parseWebp(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 20) fail("raster-malformed", "Truncated WebP.");
  const chunk = fourcc(bytes, 12);
  const size = (bytes[16] | bytes[17] << 8 | bytes[18] << 16) + bytes[19] * 0x1000000;
  const payload = 20;
  if (chunk === "VP8 ") {
    if (bytes.length < payload + 10 || size < 10) fail("raster-malformed", "Truncated WebP frame.");
    if ((bytes[payload] & 0x01) !== 0) fail("raster-malformed", "WebP does not start with a key frame.");
    if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) {
      fail("raster-malformed", "Invalid WebP frame signature.");
    }
    return { width: u16le(bytes, payload + 6) & 0x3fff, height: u16le(bytes, payload + 8) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes.length < payload + 5 || size < 5) fail("raster-malformed", "Truncated WebP lossless header.");
    if (bytes[payload] !== 0x2f) fail("raster-malformed", "Invalid WebP lossless signature.");
    const b1 = bytes[payload + 1], b2 = bytes[payload + 2], b3 = bytes[payload + 3], b4 = bytes[payload + 4];
    const width = 1 + ((b2 & 0x3f) << 8 | b1);
    const height = 1 + ((b4 & 0x0f) << 10 | b3 << 2 | b2 >> 6);
    return { width, height };
  }
  if (chunk === "VP8X") {
    if (bytes.length < payload + 10) fail("raster-malformed", "Truncated WebP extended header.");
    if ((bytes[payload] & 0x02) !== 0) fail("raster-animated", "Animated WebP is not supported.");
    // Belt and braces: an ANIM/ANMF chunk means animation even without the flag.
    let offset = payload + size + (size % 2);
    let steps = 0;
    while (offset + 8 <= bytes.length) {
      if (++steps > 10_000) fail("raster-malformed", "WebP has too many chunks.");
      const type = fourcc(bytes, offset);
      if (type === "ANIM" || type === "ANMF") fail("raster-animated", "Animated WebP is not supported.");
      const chunkSize = (bytes[offset + 4] | bytes[offset + 5] << 8 | bytes[offset + 6] << 16) + bytes[offset + 7] * 0x1000000;
      if (offset + 8 + chunkSize > bytes.length) break;
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return { width: 1 + u24le(bytes, payload + 4), height: 1 + u24le(bytes, payload + 7) };
  }
  fail("raster-malformed", "Unknown WebP variant.");
}

/**
 * HEADER-ONLY validation of untrusted raster bytes — no pixel is decoded.
 * Returns header facts on success; throws RasterValidationError on any
 * violation. Never treat this as proof the payload decodes: persist, commit,
 * and at-rest verification must go through validateRasterPayload()
 * (raster-decoder.ts), whose DecodedRasterInfo return type marks a raster
 * whose FULL content actually decoded.
 */
export function validateRaster(bytes: Uint8Array, options: RasterValidationOptions = {}): RasterInfo {
  const policy = options.policy ?? RESOURCE_POLICY;
  if (bytes.length === 0) fail("raster-empty", "The image file is empty.");
  if (bytes.length > policy.maxRasterBytes) {
    fail("raster-too-large", `The image exceeds ${policy.maxRasterBytes} bytes.`);
  }
  const format = sniffRasterFormat(bytes);
  if (!format) fail("raster-unknown-format", "The file is not a PNG, JPEG, or WebP image.");
  if (options.declaredType !== undefined) {
    const declared = options.declaredType.toLowerCase();
    if (declared !== MIME[format]) {
      fail("raster-format-mismatch", `The file claims ${declared || "no type"} but contains ${MIME[format]} data.`);
    }
  }
  if (options.filename !== undefined) {
    const extension = options.filename.toLowerCase().split(".").pop() ?? "";
    if (EXTENSIONS[extension] !== format) {
      fail("raster-format-mismatch", `The .${extension} extension does not match the ${format} content.`);
    }
  }
  const { width, height } = format === "png" ? parsePng(bytes) : format === "jpeg" ? parseJpeg(bytes) : parseWebp(bytes);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > MAX_SIDE || height > MAX_SIDE) {
    fail("raster-dimensions-invalid", "The image header declares invalid dimensions.");
  }
  if (width * height > policy.maxRasterPixels) {
    fail("raster-pixels-exceeded", `The image exceeds ${policy.maxRasterPixels} pixels before decode.`);
  }
  return { format, mime: MIME[format], width, height };
}
