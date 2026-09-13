/**
 * Default browser implementations of the ExportEncoders boundary.
 *
 * PNG: canvas encode + pHYs 240-DPI chunk via studio/png-dpi.
 * JPEG: canvas encode (matte was already painted by the renderer) + JFIF
 * 240-DPI density via studio/jpeg-dpi.
 * TIFF: pure encoder from tiff.ts.
 * ZIP: the io agent's hardened deterministic writer (src/io/zip-writer),
 * lazy-loaded so @zip.js/zip.js stays out of the main bundle. Plate PNGs
 * are stored uncompressed; text entries deflate.
 */

import { DOCUMENT_DPI } from "../core/types";
import { withJpegDpi } from "../studio/jpeg-dpi";
import { withPngDpi } from "../studio/png-dpi";
import { encodeTiffRgba } from "./tiff";
import { ExportError, type ExportEncoders, type RasterData, type ZipEntry } from "./orchestrator";

function rasterToCanvas(raster: RasterData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d");
  if (!context) throw new ExportError("export-failed", "Could not create an encoding canvas");
  // Canvas ImageData requires a non-shared buffer; RasterData always uses one.
  context.putImageData(
    new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
    0,
    0,
  );
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new ExportError("export-failed", `Canvas could not encode ${type}`)),
      type,
      quality,
    );
  });
}

async function createZipBlob(entries: ZipEntry[], signal?: AbortSignal): Promise<Blob> {
  const { writeArchive } = await import("../io/zip-writer");
  const encoder = new TextEncoder();
  const inputs: { name: string; data: Uint8Array; compress: boolean }[] = [];
  let inputBytes = 0;
  let nameBytes = 0;
  for (const entry of entries) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const data =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : new Uint8Array(await entry.data.arrayBuffer());
    inputBytes += data.byteLength;
    nameBytes += encoder.encode(entry.name).byteLength;
    inputs.push({
      name: entry.name,
      data,
      // PNG payloads are already compressed; store them for speed and size.
      compress: !/\.png$/i.test(entry.name),
    });
  }
  // Deflate's stored-block ceiling plus ZIP records. This prevents the
  // buffered writer from geometrically growing a second capacity buffer.
  const deflateOverhead = Math.ceil(inputBytes / 65_535) * 5 + 11 * inputs.length;
  const zipRecords = nameBytes * 2 + inputs.length * 512 + 65_536;
  const initialCapacityBytes = Math.max(1, inputBytes + deflateOverhead + zipRecords);
  const bytes = await writeArchive(inputs, { signal, initialCapacityBytes });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (bytes.byteLength > initialCapacityBytes) {
    throw new ExportError(
      "delivery-exceeded",
      "The buffered archive exceeded its conservative pre-sized memory bound.",
    );
  }
  const blobView: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  return new Blob([blobView], { type: "application/zip" });
}

export const BROWSER_EXPORT_ENCODERS: ExportEncoders = {
  async encodePng(raster, dpi) {
    const blob = await canvasToBlob(rasterToCanvas(raster), "image/png");
    return withPngDpi(blob, dpi);
  },
  async encodeJpeg(raster, quality) {
    const blob = await canvasToBlob(rasterToCanvas(raster), "image/jpeg", quality);
    // Truthful press metadata: canvas encoders emit a meaningless JFIF
    // density (unit 0, 1×1 aspect); stamp the real document DPI.
    return withJpegDpi(blob, DOCUMENT_DPI);
  },
  async encodeTiff(raster, dpi) {
    const bytes = encodeTiffRgba(raster.width, raster.height, raster.data, dpi);
    return new Blob([bytes.buffer as ArrayBuffer], { type: "image/tiff" });
  },
  zip: createZipBlob,
};

/** Anchor-click Blob download used as the delivery fallback sink. */
export function downloadExportBlob(file: { name: string; blob: Blob }): void {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
