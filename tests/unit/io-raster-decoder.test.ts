/**
 * Full raster payload validation (validateRasterPayload + the injectable
 * RasterDecoder adapter): headers can lie about the payload, so persist/
 * commit/at-rest decisions require a complete decode. These tests use
 * CORRECT-HASH fixtures — the bytes are internally consistent (valid
 * signatures, headers, chunk CRCs) and only the payload is broken — so the
 * cheap gates pass and ONLY the full decode catches them.
 */
import { describe, expect, it, vi } from "vitest";
import {
  defaultRasterDecoder,
  validateRasterPayload,
  type RasterDecoder,
} from "../../src/io/raster-decoder";
import { RasterValidationError, validateRaster } from "../../src/io/raster-validator";
import { makePng } from "./io-raster-validator.test";
import {
  makeDecodablePng,
  makeJpeg,
  makeWebp,
  referenceRasterDecoder,
} from "./helpers/raster-fixtures";

async function rejects(bytes: Uint8Array, code: string, decoder: RasterDecoder = referenceRasterDecoder) {
  try {
    await validateRasterPayload(bytes, { decoder });
  } catch (error) {
    expect(error).toBeInstanceOf(RasterValidationError);
    expect((error as RasterValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected payload rejection ${code}`);
}

describe("validateRasterPayload — full content validation", () => {
  it("valid static PNG/JPEG/WebP payloads pass and carry the payloadValidated brand", async () => {
    for (const bytes of [makeDecodablePng(6, 4), makeJpeg(6, 4), makeWebp(6, 4)]) {
      const info = await validateRasterPayload(bytes, { decoder: referenceRasterDecoder });
      expect(info.payloadValidated).toBe(true);
      expect(info.width).toBe(6);
      expect(info.height).toBe(4);
      // The header inspection alone accepts the same bytes — proving the
      // fixtures are header-valid and only decode strength separates levels.
      expect(validateRaster(bytes)).toMatchObject({ width: 6, height: 4 });
    }
  });

  it("truncated PNG IDAT: header-valid, decode fails typed", async () => {
    const bytes = makeDecodablePng(8, 8, { truncateIdat: true });
    expect(validateRaster(bytes)).toMatchObject({ format: "png", width: 8, height: 8 });
    await rejects(bytes, "raster-decode-failed");
  });

  it("corrupt PNG IDAT: header-valid, decode fails typed", async () => {
    const bytes = makeDecodablePng(8, 8, { corruptIdat: true });
    expect(validateRaster(bytes)).toMatchObject({ format: "png" });
    await rejects(bytes, "raster-decode-failed");
  });

  it("SOF-only JPEG (no scan): header-valid, decode fails typed", async () => {
    const bytes = makeJpeg(8, 8, { scan: "sof-only" });
    expect(validateRaster(bytes)).toMatchObject({ format: "jpeg", width: 8, height: 8 });
    await rejects(bytes, "raster-decode-failed");
  });

  it("scan-truncated JPEG (no EOI): header-valid, decode fails typed", async () => {
    const bytes = makeJpeg(8, 8, { scan: "truncated" });
    expect(validateRaster(bytes)).toMatchObject({ format: "jpeg" });
    await rejects(bytes, "raster-decode-failed");
  });

  it("incomplete WebP payload: header-valid, decode fails typed", async () => {
    const bytes = makeWebp(8, 8, { incomplete: true });
    expect(validateRaster(bytes)).toMatchObject({ format: "webp", width: 8, height: 8 });
    await rejects(bytes, "raster-decode-failed");
  });

  it("decoded-vs-declared dimension disagreement rejects typed", async () => {
    const bytes = makeDecodablePng(8, 8);
    const lyingDecoder: RasterDecoder = { decode: async () => ({ width: 8, height: 9 }) };
    await rejects(bytes, "raster-decode-dimensions", lyingDecoder);
  });

  it("animation is rejected by the cheap gates BEFORE the decoder ever runs", async () => {
    const decode = vi.fn();
    const spyDecoder: RasterDecoder = { decode };
    await rejects(makePng(8, 8, { acTL: true }), "raster-animated", spyDecoder);
    expect(decode).not.toHaveBeenCalled();
  });

  it("header failures never reach the decoder either", async () => {
    const decode = vi.fn();
    await rejects(new Uint8Array([1, 2, 3, 4]), "raster-unknown-format", { decode });
    expect(decode).not.toHaveBeenCalled();
  });

  it("an abort from the operation signal is rethrown untouched (not misfiled as an asset defect)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      validateRasterPayload(makeDecodablePng(4, 4), {
        decoder: referenceRasterDecoder,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("defaultRasterDecoder — fail closed outside the browser", () => {
  it("refuses to decode with the typed raster-decode-unavailable code in node", async () => {
    // Unit tests run in node: no createImageBitmap, no DOM Image pipeline.
    // Header-only must never silently count as fully valid, so the default
    // decoder is a typed refusal until a real decoder is injected.
    await rejects(makeDecodablePng(4, 4), "raster-decode-unavailable", defaultRasterDecoder());
  });
});
