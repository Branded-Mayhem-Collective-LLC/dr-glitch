/**
 * JFIF density stamping/parsing (wave F item G: exported JPEGs must carry
 * REAL 240-DPI metadata, verified from actual bytes — never signature-only).
 */
import { describe, expect, it } from "vitest";
import { parseJpegDensity, withJpegDpi } from "../../src/studio/jpeg-dpi";

/** Minimal JPEG: SOI + JFIF APP0 (unit 0, 1×1 — the canvas-encoder shape) + EOI. */
function jpegWithDefaultJfif(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.01
    0x00, // unit 0 (aspect only)
    0x00, 0x01, 0x00, 0x01, // density 1×1
    0x00, 0x00, // no thumbnail
    0xff, 0xd9, // EOI
  ]);
}

/** JPEG without any JFIF APP0 (e.g. EXIF-first encoders). */
function jpegWithoutJfif(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

describe("parseJpegDensity", () => {
  it("reads the JFIF unit and density", () => {
    expect(parseJpegDensity(jpegWithDefaultJfif())).toEqual({ unit: 0, x: 1, y: 1 });
  });

  it("returns null without a JFIF APP0 or for non-JPEG bytes", () => {
    expect(parseJpegDensity(jpegWithoutJfif())).toBeNull();
    expect(parseJpegDensity(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("withJpegDpi", () => {
  it("rewrites an existing JFIF APP0 to unit 1 at the requested DPI", async () => {
    const blob = new Blob([jpegWithDefaultJfif().buffer as ArrayBuffer], { type: "image/jpeg" });
    const stamped = new Uint8Array(await (await withJpegDpi(blob, 240)).arrayBuffer());
    expect(parseJpegDensity(stamped)).toEqual({ unit: 1, x: 240, y: 240 });
    // Same length: rewritten in place, no segment duplication.
    expect(stamped.length).toBe(jpegWithDefaultJfif().length);
    // Trailer intact.
    expect(Array.from(stamped.slice(-2))).toEqual([0xff, 0xd9]);
  });

  it("inserts a fresh JFIF APP0 directly after SOI when none exists", async () => {
    const blob = new Blob([jpegWithoutJfif().buffer as ArrayBuffer], { type: "image/jpeg" });
    const stamped = new Uint8Array(await (await withJpegDpi(blob, 240)).arrayBuffer());
    expect(parseJpegDensity(stamped)).toEqual({ unit: 1, x: 240, y: 240 });
    expect(Array.from(stamped.slice(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it("rejects non-JPEG blobs and out-of-range dpi", async () => {
    await expect(withJpegDpi(new Blob([new Uint8Array([0, 1]).buffer as ArrayBuffer]), 240)).rejects.toThrow(
      TypeError,
    );
    await expect(
      withJpegDpi(new Blob([jpegWithoutJfif().buffer as ArrayBuffer]), 0),
    ).rejects.toThrow(RangeError);
  });
});
