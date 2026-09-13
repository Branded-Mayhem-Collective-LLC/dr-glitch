import { bridgeNativeSavePicker } from "./save-picker";
import { readFile } from "node:fs/promises";
import { expect, type Download, type Page } from "@playwright/test";
import JSZip from "jszip";

/**
 * Download capture and byte-level format oracles, following the parsing
 * patterns already proven in studio-ux.spec.ts and desktop-parity.spec.ts.
 */

export type CapturedDownload = {
  download: Download;
  filename: string;
  bytes: Buffer;
};

/** Run `trigger` and capture the download it causes. */
export async function captureDownload(
  page: Page,
  trigger: () => Promise<void>,
): Promise<CapturedDownload> {
  await bridgeNativeSavePicker(page);
  const waiting = page.waitForEvent("download");
  await trigger();
  const download = await waiting;
  const path = await download.path();
  expect(path).not.toBeNull();
  return {
    download,
    filename: download.suggestedFilename(),
    bytes: await readFile(path!),
  };
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** 240 DPI expressed as the pHYs pixels-per-meter value. */
export const PHYS_240_DPI_PPM = 9449;

export function expectPngSignature(bytes: Uint8Array): void {
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
}

export type PngChunk = { type: string; length: number; dataOffset: number };

export function pngChunks(bytes: Uint8Array): {
  chunks: PngChunk[];
  view: DataView;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    chunks.push({ type, length, dataOffset: offset + 8 });
    offset += length + 12;
    if (type === "IEND") break;
  }
  return { chunks, view };
}

/** Asserts exactly one pHYs chunk declaring 240 DPI on both axes (meters). */
export function expectSinglePhys240Dpi(bytes: Uint8Array): void {
  expectPngSignature(bytes);
  const { chunks, view } = pngChunks(bytes);
  const phys = chunks.filter(({ type }) => type === "pHYs");
  expect(phys).toHaveLength(1);
  expect(phys[0].length).toBe(9);
  expect(view.getUint32(phys[0].dataOffset)).toBe(PHYS_240_DPI_PPM);
  expect(view.getUint32(phys[0].dataOffset + 4)).toBe(PHYS_240_DPI_PPM);
  expect(bytes[phys[0].dataOffset + 8]).toBe(1);
}

export function pngDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  expectPngSignature(bytes);
  const { chunks, view } = pngChunks(bytes);
  const ihdr = chunks.find(({ type }) => type === "IHDR");
  expect(ihdr).toBeDefined();
  return {
    width: view.getUint32(ihdr!.dataOffset),
    height: view.getUint32(ihdr!.dataOffset + 4),
  };
}

/* ------------------------------------------------------------------ */
/* JPEG / TIFF                                                         */
/* ------------------------------------------------------------------ */

export function expectJpegSignature(bytes: Uint8Array): void {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  expect(bytes[2]).toBe(0xff);
}

export type JfifDensity = { unit: number; x: number; y: number };

/**
 * Parses the ACTUAL JFIF APP0 density from JPEG bytes (independent
 * implementation — deliberately not the app's writer). Returns null when
 * no JFIF APP0 segment precedes the first scan.
 */
export function parseJfifDensity(bytes: Uint8Array): JfifDensity | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isJfif =
      marker === 0xe0 &&
      length >= 16 &&
      bytes[offset + 4] === 0x4a && // J
      bytes[offset + 5] === 0x46 && // F
      bytes[offset + 6] === 0x49 && // I
      bytes[offset + 7] === 0x46 && // F
      bytes[offset + 8] === 0x00;
    if (isJfif) {
      const base = offset + 11; // skip marker(2) length(2) id(5) version(2)
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

/** Asserts a REAL JFIF density of 240 DPI on both axes (unit 1 = inches). */
export function expectJfif240Dpi(bytes: Uint8Array): void {
  expectJpegSignature(bytes);
  expect(parseJfifDensity(bytes)).toEqual({ unit: 1, x: 240, y: 240 });
}

export function expectTiffSignature(bytes: Uint8Array): void {
  const littleEndian =
    bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const bigEndian =
    bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  expect(littleEndian || bigEndian).toBe(true);
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

/** File entry names in the archive (directories excluded). */
export async function zipEntryNames(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  return Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
}

export async function zipFileBytes(
  bytes: Uint8Array,
  name: string | RegExp,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const entry =
    typeof name === "string"
      ? zip.file(name)
      : (zip.file(name)[0] ?? null);
  expect(entry, `zip entry ${String(name)}`).not.toBeNull();
  return entry!.async("uint8array");
}

export async function zipFileText(
  bytes: Uint8Array,
  name: string | RegExp,
): Promise<string> {
  const raw = await zipFileBytes(bytes, name);
  return Buffer.from(raw).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* In-page PNG pixel probing                                           */
/* ------------------------------------------------------------------ */

export type PngAlphaStats = {
  width: number;
  height: number;
  /** Bounding box of pixels with alpha > 0, or null when fully transparent. */
  opaqueBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Alpha of the four corner pixels. */
  cornerAlphas: [number, number, number, number];
  transparentPixelCount: number;
  opaquePixelCount: number;
};

/**
 * Decodes PNG bytes inside the page (createImageBitmap + canvas) and returns
 * alpha statistics — used to verify transparent selected-layer exports and
 * placement preservation without a Node-side PNG decoder.
 */
export async function pngAlphaStats(
  page: Page,
  bytes: Uint8Array,
): Promise<PngAlphaStats> {
  const base64 = Buffer.from(bytes).toString("base64");
  return page.evaluate(async (encoded) => {
    const raw = atob(encoded);
    const data = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) {
      data[index] = raw.charCodeAt(index);
    }
    const bitmap = await createImageBitmap(
      new Blob([data], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const { width, height } = canvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let transparentPixelCount = 0;
    let opaquePixelCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = pixels[(y * width + x) * 4 + 3];
        if (alpha > 0) {
          opaquePixelCount++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        } else {
          transparentPixelCount++;
        }
      }
    }
    const alphaAt = (x: number, y: number) => pixels[(y * width + x) * 4 + 3];
    return {
      width,
      height,
      opaqueBounds:
        opaquePixelCount > 0 ? { minX, minY, maxX, maxY } : null,
      cornerAlphas: [
        alphaAt(0, 0),
        alphaAt(width - 1, 0),
        alphaAt(0, height - 1),
        alphaAt(width - 1, height - 1),
      ] as [number, number, number, number],
      transparentPixelCount,
      opaquePixelCount,
    };
  }, base64);
}

/**
 * Decodes PNG bytes in the page and samples one pixel's RGBA — used for
 * output-polarity plate probes where alpha statistics are not enough.
 */
export async function pngPixelSample(
  page: Page,
  bytes: Uint8Array,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const base64 = Buffer.from(bytes).toString("base64");
  return page.evaluate(
    async ({ encoded, sampleX, sampleY }) => {
      const raw = atob(encoded);
      const data = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) {
        data[index] = raw.charCodeAt(index);
      }
      const bitmap = await createImageBitmap(new Blob([data], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const pixel = context.getImageData(sampleX, sampleY, 1, 1).data;
      return [pixel[0], pixel[1], pixel[2], pixel[3]] as [
        number,
        number,
        number,
        number,
      ];
    },
    { encoded: base64, sampleX: x, sampleY: y },
  );
}
