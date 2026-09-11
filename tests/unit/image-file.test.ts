import { describe, expect, it } from "vitest";
import {
  validateImageSignature,
  MAX_IMAGE_BYTES,
  validateImageDimensions,
  validateImageFile,
} from "../../src/studio/image-file";

describe("artwork resource limits", () => {
  it("checks format signatures instead of trusting MIME labels", async () => {
    for (const [type, bytes] of [
      ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
      ["image/jpeg", [255, 216, 255, 224]],
      ["image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
    ] as const) {
      expect(await validateImageSignature(new File([new Uint8Array(bytes)], "image", { type }))).toBeNull();
    }
    expect(await validateImageSignature(new File(["GIF89a"], "pretend.jpg", { type: "image/jpeg" }))).toMatch(/format/);
    expect(await validateImageSignature(new File(["<svg/>"], "pretend.png", { type: "image/png" }))).toMatch(/format/);
    expect(await validateImageSignature(new File([], "empty.png", { type: "image/png" }))).toMatch(/format/);
  });
  it.each(["image/png", "image/jpeg", "image/webp"])("accepts %s", (type) => {
    expect(validateImageFile({ type, size: 1024 })).toBeNull();
  });

  it("rejects unsupported, empty, and oversized files", () => {
    expect(validateImageFile({ type: "image/svg+xml", size: 100 })).toMatch(/PNG/);
    expect(validateImageFile({ type: "image/png", size: 0 })).toMatch(/empty/);
    expect(validateImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toMatch(/50 MB/);
  });

  it("bounds decoded dimensions and total pixels", () => {
    expect(validateImageDimensions(10_000, 10_000)).toBeNull();
    expect(validateImageDimensions(16_385, 1)).toMatch(/16,384/);
    expect(validateImageDimensions(10_001, 10_000)).toMatch(/100 megapixels/);
    expect(validateImageDimensions(0, 100)).toMatch(/invalid/);
  });
});
