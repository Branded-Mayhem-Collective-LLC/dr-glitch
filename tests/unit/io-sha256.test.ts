import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexAbortable } from "../../src/io/sha256";

function patternedBytes(length: number): Uint8Array {
  return new Uint8Array(length).map((_, index) => (index * 31 + 17) & 0xff);
}

describe("sha256HexAbortable", () => {
  it("matches WebCrypto across padding and cooperative chunk boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1024 * 1024 + 17]) {
      const bytes = patternedBytes(length);
      await expect(sha256HexAbortable(bytes, () => undefined)).resolves.toBe(
        await sha256Hex(bytes),
      );
    }
  });

  it("allows an abort event to preempt a large browser-style hash", async () => {
    const controller = new AbortController();
    const pending = sha256HexAbortable(patternedBytes(4 * 1024 * 1024), () => {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    });
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
