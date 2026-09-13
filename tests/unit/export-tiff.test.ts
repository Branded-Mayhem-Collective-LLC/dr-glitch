import { describe, expect, it } from "vitest";
import { encodeTiff, encodeTiffGray, encodeTiffRgba } from "../../src/export/tiff";

/** Minimal little-endian TIFF parser used to verify our own output. */
type ParsedEntry = { type: number; count: number; values: number[] };

function parseTiff(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(0, true)).toBe(0x4949); // "II" little-endian
  expect(view.getUint16(2, true)).toBe(42);
  const ifdOffset = view.getUint32(4, true);
  const entryCount = view.getUint16(ifdOffset, true);
  const entries = new Map<number, ParsedEntry>();
  const tagOrder: number[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    const cursor = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(cursor, true);
    const type = view.getUint16(cursor + 2, true);
    const count = view.getUint32(cursor + 4, true);
    const values: number[] = [];
    if (type === 3 && count === 1) {
      values.push(view.getUint16(cursor + 8, true));
    } else if (type === 3 && count <= 2) {
      values.push(view.getUint16(cursor + 8, true), view.getUint16(cursor + 10, true));
    } else if (type === 4 && count === 1) {
      values.push(view.getUint32(cursor + 8, true));
    } else if (type === 3) {
      const offset = view.getUint32(cursor + 8, true);
      for (let item = 0; item < count; item += 1) {
        values.push(view.getUint16(offset + item * 2, true));
      }
    } else if (type === 5) {
      const offset = view.getUint32(cursor + 8, true);
      for (let item = 0; item < count; item += 1) {
        values.push(
          view.getUint32(offset + item * 8, true) / view.getUint32(offset + item * 8 + 4, true),
        );
      }
    } else {
      values.push(view.getUint32(cursor + 8, true));
    }
    entries.set(tag, { type, count, values });
    tagOrder.push(tag);
  }

  const nextIfd = view.getUint32(ifdOffset + 2 + entryCount * 12, true);
  return { entries, tagOrder, nextIfd };
}

function tagValue(parsed: ReturnType<typeof parseTiff>, tag: number): number {
  const entry = parsed.entries.get(tag);
  expect(entry, `tag ${tag} present`).toBeDefined();
  return entry!.values[0];
}

describe("encodeTiff (RGBA)", () => {
  const width = 3;
  const height = 2;
  const pixels = new Uint8Array(width * height * 4).map((_, index) => index % 251);
  const bytes = encodeTiffRgba(width, height, pixels);
  const parsed = parseTiff(bytes);

  it("writes a valid little-endian header and single IFD", () => {
    expect(parsed.nextIfd).toBe(0);
  });

  it("writes IFD entries in ascending tag order", () => {
    const sorted = [...parsed.tagOrder].sort((a, b) => a - b);
    expect(parsed.tagOrder).toEqual(sorted);
  });

  it("describes uncompressed chunky RGBA", () => {
    expect(tagValue(parsed, 256)).toBe(width);
    expect(tagValue(parsed, 257)).toBe(height);
    expect(parsed.entries.get(258)!.values).toEqual([8, 8, 8, 8]);
    expect(tagValue(parsed, 259)).toBe(1); // no compression
    expect(tagValue(parsed, 262)).toBe(2); // RGB photometric
    expect(tagValue(parsed, 277)).toBe(4); // samples per pixel
    expect(tagValue(parsed, 278)).toBe(height); // rows per strip
    expect(tagValue(parsed, 284)).toBe(1); // chunky planar config
    expect(tagValue(parsed, 338)).toBe(2); // unassociated alpha
  });

  it("carries 240 DPI resolution tags in inches", () => {
    expect(tagValue(parsed, 282)).toBe(240);
    expect(tagValue(parsed, 283)).toBe(240);
    expect(tagValue(parsed, 296)).toBe(2); // inch
  });

  it("stores the pixel data verbatim in one strip", () => {
    const stripOffset = tagValue(parsed, 273);
    const stripBytes = tagValue(parsed, 279);
    expect(stripBytes).toBe(pixels.length);
    expect(bytes.subarray(stripOffset, stripOffset + stripBytes)).toEqual(pixels);
    expect(stripOffset + stripBytes).toBe(bytes.length);
  });

  it("accepts Uint8ClampedArray canvas data", () => {
    const clamped = new Uint8ClampedArray(width * height * 4);
    expect(() => encodeTiffRgba(width, height, clamped)).not.toThrow();
  });
});

describe("encodeTiff (grayscale)", () => {
  const width = 4;
  const height = 3;
  const pixels = new Uint8Array(width * height).map((_, index) => index * 5);
  const bytes = encodeTiffGray(width, height, pixels, 300);
  const parsed = parseTiff(bytes);

  it("describes 8-bit BlackIsZero grayscale", () => {
    expect(tagValue(parsed, 258)).toBe(8);
    expect(tagValue(parsed, 262)).toBe(1); // BlackIsZero
    expect(tagValue(parsed, 277)).toBe(1);
    expect(parsed.entries.has(338)).toBe(false); // no extra samples
  });

  it("honors a custom dpi", () => {
    expect(tagValue(parsed, 282)).toBe(300);
    expect(tagValue(parsed, 283)).toBe(300);
  });

  it("stores grayscale pixels verbatim", () => {
    const stripOffset = tagValue(parsed, 273);
    expect(bytes.subarray(stripOffset, stripOffset + pixels.length)).toEqual(pixels);
  });
});

describe("encodeTiff validation", () => {
  it("rejects invalid dimensions", () => {
    expect(() =>
      encodeTiff({ width: 0, height: 1, data: new Uint8Array(0), color: "gray" }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTiff({ width: 1.5, height: 1, data: new Uint8Array(6), color: "rgba" }),
    ).toThrow(RangeError);
  });

  it("rejects sample-length mismatches", () => {
    expect(() =>
      encodeTiff({ width: 2, height: 2, data: new Uint8Array(15), color: "rgba" }),
    ).toThrow(/expected 16 sample bytes/);
  });

  it("rejects a non-positive dpi", () => {
    expect(() =>
      encodeTiff({ width: 1, height: 1, data: new Uint8Array(1), color: "gray", dpi: 0 }),
    ).toThrow(RangeError);
  });
});
