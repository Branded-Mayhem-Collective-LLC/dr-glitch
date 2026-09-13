/**
 * Artwork import intake (src/studio/image-file.ts): the UI upload/drag-drop
 * validation seam. Everything here runs at the BYTES level — animated and
 * oversized-header fixtures must be rejected BEFORE any decoder could run,
 * and SVG artwork must round-trip through the strict "artwork" sanitizer
 * into canonical markup.
 */
import { describe, expect, it } from "vitest";
import {
  ArtworkIntakeError,
  MAX_IMAGE_BYTES,
  validateArtworkFile,
  validateImageDimensions,
  validateImageFile,
} from "../../src/studio/image-file";
import { sanitizeSvg } from "../../src/io/svg-sanitizer";

/* ------------------------------------------------------------------ */
/* Byte fixtures                                                       */
/* ------------------------------------------------------------------ */

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC is not validated pre-decode; zeros suffice for header parsing.
  return out;
}

function pngBytes(width: number, height: number, extraChunks: Uint8Array[] = []): Uint8Array {
  const ihdrData = new Uint8Array(13);
  const view = new DataView(ihdrData.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdrData),
    ...extraChunks,
    pngChunk("IDAT", new Uint8Array([0])),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Minimal animated-WebP: VP8X header with the animation flag set. */
function animatedWebpBytes(): Uint8Array {
  const bytes = new Uint8Array(40);
  const ascii = (text: string, at: number) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii("RIFF", 0);
  bytes[4] = 32; // riff size (unchecked)
  ascii("WEBP", 8);
  ascii("VP8X", 12);
  bytes[16] = 10; // chunk size
  bytes[20] = 0x02; // flags: ANIMATION
  // 24-bit canvas dimensions minus one (small).
  bytes[24] = 9;
  bytes[27] = 9;
  return bytes;
}

function fileOf(bytes: Uint8Array | string, name: string, type: string): File {
  const part = typeof bytes === "string" ? bytes : (bytes.slice().buffer as ArrayBuffer);
  return new File([part], name, { type });
}

async function intakeError(file: File): Promise<ArtworkIntakeError> {
  try {
    await validateArtworkFile(file);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtworkIntakeError);
    return error as ArtworkIntakeError;
  }
  throw new Error("expected the intake to reject");
}

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#000"/></svg>';

/* ------------------------------------------------------------------ */
/* Metadata pre-checks (legacy copy preserved)                         */
/* ------------------------------------------------------------------ */

describe("validateImageFile", () => {
  it("accepts the supported types and svg selections", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
      expect(validateImageFile({ name: "a", type, size: 1024 })).toBeNull();
    }
    expect(validateImageFile({ name: "shape.svg", type: "", size: 10 })).toBeNull();
  });

  it("rejects unsupported types, empty and oversized files", () => {
    expect(validateImageFile({ name: "a.gif", type: "image/gif", size: 100 })).toMatch(/PNG/);
    expect(validateImageFile({ name: "a.png", type: "image/png", size: 0 })).toMatch(/empty/);
    expect(
      validateImageFile({ name: "a.png", type: "image/png", size: MAX_IMAGE_BYTES + 1 }),
    ).toMatch(/50 MB/);
  });
});

describe("validateImageDimensions", () => {
  it("keeps the legacy 16,384-per-side / 100 MP caps", () => {
    expect(validateImageDimensions(10_000, 10_000)).toBeNull();
    expect(validateImageDimensions(16_385, 1)).toMatch(/16,384/);
    expect(validateImageDimensions(10_001, 10_000)).toMatch(/100 megapixels/);
    expect(validateImageDimensions(0, 100)).toMatch(/invalid/);
  });
});

/* ------------------------------------------------------------------ */
/* Bytes-level raster intake                                           */
/* ------------------------------------------------------------------ */

describe("validateArtworkFile — rasters", () => {
  it("accepts a healthy PNG and returns its header facts", async () => {
    const intake = await validateArtworkFile(fileOf(pngBytes(64, 32), "ok.png", "image/png"));
    if (intake.kind !== "raster") throw new Error("expected a raster intake");
    expect(intake.info).toMatchObject({ format: "png", width: 64, height: 32 });
  });

  it("rejects APNG (acTL) BEFORE decode with the animated code", async () => {
    const acTL = pngChunk("acTL", new Uint8Array(8));
    const error = await intakeError(
      fileOf(pngBytes(64, 32, [acTL]), "anim.png", "image/png"),
    );
    expect(error.code).toBe("raster-animated");
    expect(error.message).toMatch(/Animated/);
  });

  it("rejects animated WebP (VP8X animation flag) before decode", async () => {
    const error = await intakeError(fileOf(animatedWebpBytes(), "anim.webp", "image/webp"));
    expect(error.code).toBe("raster-animated");
  });

  it("rejects oversized HEADER dimensions before decode", async () => {
    // 100,000² px header: pre-decode pixel quota (never reaches a decoder).
    const huge = await intakeError(
      fileOf(pngBytes(100_000, 100_000), "huge.png", "image/png"),
    );
    expect(huge.code).toBe("raster-pixels-exceeded");
    // 20,000 px on one side: passes raw quotas, hits the legacy per-side cap
    // against the HEADER dimensions.
    const wide = await intakeError(fileOf(pngBytes(20_000, 100), "wide.png", "image/png"));
    expect(wide.code).toBe("raster-pixels-exceeded");
    expect(wide.message).toMatch(/16,384/);
  });

  it("rejects declared-type/content mismatches with the legacy copy", async () => {
    const error = await intakeError(fileOf("GIF89a", "disguised.jpg", "image/jpeg"));
    expect(error.message).toMatch(/does not contain/);
  });

  it("rejects extension/content mismatches (bytes-level cross-check)", async () => {
    const error = await intakeError(fileOf(pngBytes(8, 8), "sneaky.jpg", "image/png"));
    expect(error.code).toBe("raster-format-mismatch");
    expect(error.message).toMatch(/does not contain/);
  });

  it("rejects truncated rasters as unopenable", async () => {
    const error = await intakeError(
      fileOf(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "broken.png", "image/png"),
    );
    expect(error.message).toMatch(/could not be opened/);
  });
});

/* ------------------------------------------------------------------ */
/* SVG artwork intake                                                  */
/* ------------------------------------------------------------------ */

describe("validateArtworkFile — SVG artwork", () => {
  it("rejects PNG bytes disguised as .svg", async () => {
    const error = await intakeError(fileOf(pngBytes(8, 8), "pretend.svg", "image/svg+xml"));
    expect(String(error.code)).toMatch(/^svg-/);
  });

  it("rejects unsafe SVG with the sanitizer's own message", async () => {
    const error = await intakeError(
      fileOf(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
        "evil.svg",
        "image/svg+xml",
      ),
    );
    expect(String(error.code)).toMatch(/^svg-/);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("accepts safe SVG and returns CANONICAL markup (sanitizer fixed point)", async () => {
    const intake = await validateArtworkFile(fileOf(SAFE_SVG, "art.svg", "image/svg+xml"));
    if (intake.kind !== "svg") throw new Error("expected an svg intake");
    // Canonical: sanitizing the stored form again is byte-identical.
    expect(sanitizeSvg(intake.sanitized.svg, "artwork").svg).toBe(intake.sanitized.svg);
    expect(intake.sanitized.width).toBe(100);
    expect(intake.sanitized.height).toBe(100);
  });

  it("never trusts SVG-declared dimensions: pathological sizes rejected pre-decode", async () => {
    const dimensions = async (attrs: string) =>
      intakeError(
        fileOf(
          `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="1" height="1" fill="#000"/></svg>`,
          "bomb.svg",
          "image/svg+xml",
        ),
      );
    // Enormous rasterization area (400 MP) — rejected before any canvas.
    // The sanitizer's profile-scaled pixel-area ceiling (artwork: 100 MP)
    // now fires FIRST with its own typed code; the studio dimension gate
    // stays behind it as defense in depth.
    const huge = await dimensions('viewBox="0 0 20000 20000"');
    expect(huge.code).toBe("svg-area-exceeded");
    // Per-side cap against declared width/height.
    const wide = await dimensions('width="17000" height="10" viewBox="0 0 17000 10"');
    expect(wide.code).toBe("raster-pixels-exceeded");
    // Invalid numbers never reach allocation (sanitizer or dimension gate).
    const bad = await dimensions('width="NaN" height="10"');
    expect(String(bad.code)).toMatch(/svg-|raster-dimensions-invalid/);
  });
});
