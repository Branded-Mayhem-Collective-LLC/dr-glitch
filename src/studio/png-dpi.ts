const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PHYS_TYPE = new Uint8Array([112, 72, 89, 115]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

type PngChunk = {
  start: number;
  end: number;
  isIdat: boolean;
  isIend: boolean;
  isPhys: boolean;
};

function hasBytesAt(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset + expected.length > bytes.length) return false;

  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }

  return true;
}

function isChunkType(bytes: Uint8Array, offset: number, type: string): boolean {
  return (
    bytes[offset] === type.charCodeAt(0) &&
    bytes[offset + 1] === type.charCodeAt(1) &&
    bytes[offset + 2] === type.charCodeAt(2) &&
    bytes[offset + 3] === type.charCodeAt(3)
  );
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createPhysChunk(pixelsPerMeter: number): Uint8Array {
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, 9);
  chunk.set(PHYS_TYPE, 4);
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  return chunk;
}

/**
 * Returns the PNG with one pHYs chunk immediately before its first IDAT chunk.
 *
 * Rejects with TypeError when the Blob does not have a PNG signature and with
 * Error when the signed PNG byte stream has an invalid chunk layout.
 */
export async function withPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  if (!Number.isFinite(dpi) || dpi <= 0 || pixelsPerMeter > 0xffffffff) {
    throw new RangeError("withPngDpi expected dpi to be a positive, finite value");
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!hasBytesAt(bytes, 0, PNG_SIGNATURE)) {
    throw new TypeError("withPngDpi expected a PNG Blob (invalid PNG signature)");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let firstIdatStart = -1;
  let parsedEnd = offset;
  let foundIend = false;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) {
      throw new Error("withPngDpi received a malformed PNG chunk");
    }

    const dataLength = view.getUint32(offset);
    if (dataLength > bytes.length - offset - 12) {
      throw new Error("withPngDpi received a truncated PNG chunk");
    }

    const typeOffset = offset + 4;
    const end = offset + 12 + dataLength;
    const isIdat = isChunkType(bytes, typeOffset, "IDAT");
    const isIend = isChunkType(bytes, typeOffset, "IEND");
    const isPhys = isChunkType(bytes, typeOffset, "pHYs");

    if (isIdat && firstIdatStart < 0) firstIdatStart = offset;
    chunks.push({ start: offset, end, isIdat, isIend, isPhys });
    offset = end;
    parsedEnd = end;

    if (isIend) {
      foundIend = true;
      break;
    }
  }

  if (firstIdatStart < 0 || !foundIend) {
    throw new Error("withPngDpi expected PNG IDAT and IEND chunks");
  }

  const physChunk = createPhysChunk(pixelsPerMeter);
  const outputLength =
    bytes.length +
    physChunk.length -
    chunks.reduce((total, chunk) => total + (chunk.isPhys ? chunk.end - chunk.start : 0), 0);
  const output = new Uint8Array(outputLength);
  let writeOffset = 0;

  output.set(PNG_SIGNATURE, writeOffset);
  writeOffset += PNG_SIGNATURE.length;

  for (const chunk of chunks) {
    if (chunk.start === firstIdatStart) {
      output.set(physChunk, writeOffset);
      writeOffset += physChunk.length;
    }
    if (chunk.isPhys) continue;

    const originalChunk = bytes.subarray(chunk.start, chunk.end);
    output.set(originalChunk, writeOffset);
    writeOffset += originalChunk.length;
  }

  if (parsedEnd < bytes.length) {
    const trailingBytes = bytes.subarray(parsedEnd);
    output.set(trailingBytes, writeOffset);
  }

  return new Blob([output], { type: blob.type || "image/png" });
}
