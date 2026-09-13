import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RasterValidationError, sniffRasterFormat, validateRaster } from "../../src/io/raster-validator";

/* ------------------------------------------------------------------ */
/* Programmatic fixtures                                               */
/* ------------------------------------------------------------------ */

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function makePng(width: number, height: number, { acTL = false } = {}): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA; header-only fixture, never decoded
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr)];
  if (acTL) parts.push(pngChunk("acTL", new Uint8Array(8)));
  parts.push(pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(64)))), pngChunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

function makeJpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  const sof = new Uint8Array([0xff, sofMarker, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return concat([new Uint8Array([0xff, 0xd8]), app0, sof, new Uint8Array([0xff, 0xd9])]);
}

function riff(chunks: Array<[string, Uint8Array]>): Uint8Array {
  const body: Uint8Array[] = [new Uint8Array([0x57, 0x45, 0x42, 0x50])]; // WEBP
  for (const [fourcc, data] of chunks) {
    const header = new Uint8Array(8);
    for (let i = 0; i < 4; i++) header[i] = fourcc.charCodeAt(i);
    new DataView(header.buffer).setUint32(4, data.length, true);
    body.push(header, data);
    if (data.length % 2) body.push(new Uint8Array(1));
  }
  const payload = concat(body);
  const head = new Uint8Array(8);
  head.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  new DataView(head.buffer).setUint32(4, payload.length, true);
  return concat([head, payload]);
}

function makeWebpLossless(width: number, height: number): Uint8Array {
  const packed = (width - 1) | (height - 1) << 14; // then 1 alpha bit + 3 version bits = 0
  const data = new Uint8Array([0x2f, packed & 0xff, packed >> 8 & 0xff, packed >> 16 & 0xff, packed >> 24 & 0xff, 0]);
  return riff([["VP8L", data]]);
}

function makeWebpLossy(width: number, height: number): Uint8Array {
  const data = new Uint8Array([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0]);
  return riff([["VP8 ", data]]);
}

function makeWebpExtended(width: number, height: number, { animatedFlag = false, animChunk = false } = {}): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = animatedFlag ? 0x02 : 0x00;
  const view = new DataView(data.buffer);
  view.setUint32(4, width - 1, true); // 24-bit; low 3 bytes land correctly
  data[7] = (height - 1) & 0xff; data[8] = (height - 1) >> 8 & 0xff; data[9] = (height - 1) >> 16 & 0xff;
  const chunks: Array<[string, Uint8Array]> = [["VP8X", data]];
  if (animChunk) chunks.push(["ANIM", new Uint8Array(6)]);
  chunks.push(["VP8L", makeWebpLossless(width, height).subarray(20)]);
  return riff(chunks);
}

function rejects(bytes: Uint8Array, code: string, options: Parameters<typeof validateRaster>[1] = {}) {
  try {
    validateRaster(bytes, options);
  } catch (error) {
    expect(error).toBeInstanceOf(RasterValidationError);
    expect((error as RasterValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection ${code}`);
}

/* ------------------------------------------------------------------ */

describe("raster-validator formats and dimensions", () => {
  it("sniffs magic bytes", () => {
    expect(sniffRasterFormat(makePng(4, 4))).toBe("png");
    expect(sniffRasterFormat(makeJpeg(4, 4))).toBe("jpeg");
    expect(sniffRasterFormat(makeWebpLossless(4, 4))).toBe("webp");
    expect(sniffRasterFormat(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  it("extracts dimensions from headers without decoding", () => {
    expect(validateRaster(makePng(320, 200))).toMatchObject({ format: "png", width: 320, height: 200 });
    expect(validateRaster(makeJpeg(641, 480))).toMatchObject({ format: "jpeg", width: 641, height: 480 });
    expect(validateRaster(makeJpeg(641, 480, 0xc2))).toMatchObject({ width: 641, height: 480 });
    expect(validateRaster(makeWebpLossless(1023, 511))).toMatchObject({ format: "webp", width: 1023, height: 511 });
    expect(validateRaster(makeWebpLossy(300, 200))).toMatchObject({ width: 300, height: 200 });
    expect(validateRaster(makeWebpExtended(2000, 1000))).toMatchObject({ width: 2000, height: 1000 });
  });

  it("rejects empty and unknown data", () => {
    rejects(new Uint8Array(0), "raster-empty");
    rejects(new TextEncoder().encode("plain text, not an image"), "raster-unknown-format");
  });

  it("rejects oversized files and oversized header dimensions before decode", () => {
    rejects(makePng(4, 4), "raster-too-large", { policy: { maxRasterBytes: 10, maxRasterPixels: 100_000_000 } });
    // 400 megapixels declared in a file only a few hundred bytes long.
    rejects(makePng(20_000, 20_000), "raster-pixels-exceeded");
    rejects(makePng(0, 16), "raster-dimensions-invalid");
  });

  it("rejects unsupported JPEG encodings and truncated headers", () => {
    rejects(makeJpeg(10, 10, 0xc3), "raster-unsupported");
    rejects(makeJpeg(10, 10).subarray(0, 6), "raster-malformed");
    rejects(concat([new Uint8Array([0xff, 0xd8]), new Uint8Array([0xff, 0xd9])]), "raster-malformed");
  });
});

describe("raster-validator animation rejection", () => {
  it("rejects APNG via acTL before IDAT", () => {
    rejects(makePng(8, 8, { acTL: true }), "raster-animated");
  });

  it("rejects animated WebP via the VP8X animation bit", () => {
    rejects(makeWebpExtended(8, 8, { animatedFlag: true }), "raster-animated");
  });

  it("rejects animated WebP via an ANIM chunk even without the flag", () => {
    rejects(makeWebpExtended(8, 8, { animChunk: true }), "raster-animated");
  });
});

describe("raster-validator disguise rejection", () => {
  it("rejects declared-MIME mismatches", () => {
    rejects(makeJpeg(4, 4), "raster-format-mismatch", { declaredType: "image/png" });
    rejects(makePng(4, 4), "raster-format-mismatch", { declaredType: "image/webp" });
    expect(validateRaster(makePng(4, 4), { declaredType: "image/PNG" }).format).toBe("png");
  });

  it("rejects extension disguises, including PNG bytes named .svg", () => {
    rejects(makePng(4, 4), "raster-format-mismatch", { filename: "innocent.svg" });
    rejects(makeWebpLossless(4, 4), "raster-format-mismatch", { filename: "photo.jpg" });
    expect(validateRaster(makePng(4, 4), { filename: "ok.png" }).format).toBe("png");
    expect(validateRaster(makeJpeg(4, 4), { filename: "ok.JPEG" }).format).toBe("jpeg");
  });
});
