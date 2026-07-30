import { describe, expect, it } from "vitest";
import { withPngDpi } from "../../src/studio/png-dpi";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: number[]): Uint8Array {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    bytes[4 + index] = type.charCodeAt(index);
  }
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));

  return bytes;
}

function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function blobFromBytes(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

function minimalPng(extraChunks: Uint8Array[] = []): Uint8Array {
  const ihdr = chunk("IHDR", [
    0, 0, 0, 1, // width
    0, 0, 0, 1, // height
    8, 6, 0, 0, 0, // 8-bit RGBA, standard compression/filter, no interlace
  ]);
  // One transparent RGBA scanline in a zlib stream using an uncompressed block.
  const idat = chunk("IDAT", [
    0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff,
    0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x05, 0x00, 0x01,
  ]);

  return join([PNG_SIGNATURE, ihdr, ...extraChunks, idat, chunk("IEND", [])]);
}

type ParsedChunk = {
  type: string;
  data: Uint8Array;
  bytes: Uint8Array;
  storedCrc: number;
};

function parseChunks(png: Uint8Array): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = PNG_SIGNATURE.length;

  while (offset < png.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    chunks.push({
      type: String.fromCharCode(...png.subarray(offset + 4, offset + 8)),
      data: png.slice(offset + 8, offset + 8 + length),
      bytes: png.slice(offset, end),
      storedCrc: view.getUint32(offset + 8 + length),
    });
    offset = end;
  }

  return chunks;
}

describe("withPngDpi", () => {
  it("adds a valid 240 DPI pHYs chunk immediately before IDAT", async () => {
    const source = minimalPng();
    const output = new Uint8Array(await (await withPngDpi(blobFromBytes(source), 240)).arrayBuffer());
    const chunks = parseChunks(output);
    const phys = chunks.find((item) => item.type === "pHYs");

    expect(output.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(chunks.map((item) => item.type)).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
    expect(phys?.data.length).toBe(9);
    expect(new DataView(phys!.data.buffer).getUint32(0)).toBe(9449);
    expect(new DataView(phys!.data.buffer).getUint32(4)).toBe(9449);
    expect(phys?.data[8]).toBe(1);
    expect(phys?.storedCrc).toBe(crc32(phys!.bytes.subarray(4, 17)));
  });

  it("replaces every existing pHYs chunk without changing other chunks", async () => {
    const oldPhys = chunk("pHYs", [0, 0, 11, 184, 0, 0, 11, 184, 1]);
    const text = chunk("tEXt", Array.from(new TextEncoder().encode("Software\u0000Halftone")));
    const duplicatePhys = chunk("pHYs", [0, 0, 23, 112, 0, 0, 23, 112, 1]);
    const source = minimalPng([oldPhys, text, duplicatePhys]);
    const sourceChunks = parseChunks(source);
    const output = new Uint8Array(await (await withPngDpi(blobFromBytes(source), 240)).arrayBuffer());
    const outputChunks = parseChunks(output);

    expect(outputChunks.map((item) => item.type)).toEqual(["IHDR", "tEXt", "pHYs", "IDAT", "IEND"]);
    expect(outputChunks.filter((item) => item.type === "pHYs")).toHaveLength(1);

    for (const type of ["IHDR", "tEXt", "IDAT", "IEND"]) {
      expect(outputChunks.find((item) => item.type === type)?.bytes).toEqual(
        sourceChunks.find((item) => item.type === type)?.bytes,
      );
    }
  });

  it("rejects non-PNG data with a documented TypeError contract", async () => {
    const promise = withPngDpi(blobFromBytes(new Uint8Array([1, 2, 3, 4])), 240);

    await expect(promise).rejects.toBeInstanceOf(TypeError);
    await expect(promise).rejects.toThrow("withPngDpi expected a PNG Blob");
  });
});
