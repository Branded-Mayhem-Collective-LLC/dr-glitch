import { afterEach, expect, it, vi } from "vitest";
import { loadImageBlob } from "../../src/io/image-load";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["load", "error", "abort", "timeout"] as const)("releases the image URL exactly once after %s, including late events", async (outcome) => {
  vi.useFakeTimers();
  let image!: { src: string; onload: (() => void) | null; onerror: (() => void) | null };
  vi.stubGlobal("Image", class {
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { image = this; }
  });
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: revoke });
  const controller = new AbortController();
  const pending = loadImageBlob(new Blob(["test"]), { signal: controller.signal, timeoutMs: 25 });
  const settled = pending.then(() => "loaded", () => "rejected");
  const lateLoad = image.onload!;
  const lateError = image.onerror!;
  if (outcome === "load") lateLoad();
  else if (outcome === "error") lateError();
  else if (outcome === "abort") controller.abort();
  else await vi.advanceTimersByTimeAsync(25);
  expect(await settled).toBe(outcome === "load" ? "loaded" : "rejected");
  lateLoad(); lateError(); controller.abort();
  await vi.runAllTimersAsync();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test");
  expect(image.onload).toBeNull();
  expect(image.onerror).toBeNull();
  expect(image.src).toBe(outcome === "load" ? "blob:test" : "");
});
