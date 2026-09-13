/** AssetCache integrity, suspension, stale-owner, and cancellation contracts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetCache } from "../../src/app/asset-cache";
import {
  AssetIntegrityError,
  type AssetRepository,
  type RasterDecodeSnapshot,
} from "../../src/storage";

const SHA = "a".repeat(64);
const RECORD = Object.freeze({
  sha256: SHA,
  kind: "raster" as const,
  mime: "image/png",
  byteLength: 4,
  width: 2,
  height: 2,
  createdAt: 1,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function poisonedRepository() {
  const poison = new AssetIntegrityError(
    "asset-hash-mismatch",
    SHA,
    "stored bytes hash differently",
  );
  const openArtworkDecodeSnapshot = vi.fn().mockRejectedValue(poison);
  const getVerifiedBlob = vi.fn();
  const getBlob = vi.fn();
  return {
    repo: {
      openArtworkDecodeSnapshot,
      getVerifiedBlob,
      getBlob,
    } as unknown as AssetRepository,
    openArtworkDecodeSnapshot,
    getVerifiedBlob,
    getBlob,
  };
}

function snapshot(): RasterDecodeSnapshot {
  return {
    record: RECORD,
    verify: vi.fn(async () => new Blob([new Uint8Array(4)], { type: "image/png" })),
  };
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

class ControlledImage {
  static instances: ControlledImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 2;
  naturalHeight = 2;
  removed = false;
  private source = "";

  constructor() {
    ControlledImage.instances.push(this);
  }

  set src(value: string) {
    this.source = value;
  }

  get src(): string {
    return this.source;
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.source = "";
      this.removed = true;
    }
  }
}

function installImageHarness(): { revoke: ReturnType<typeof vi.fn> } {
  ControlledImage.instances.length = 0;
  const revoke = vi.fn();
  vi.stubGlobal("Image", ControlledImage);
  vi.stubGlobal("HTMLImageElement", ControlledImage);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:test-${ControlledImage.instances.length}`),
    revokeObjectURL: revoke,
  });
  return { revoke };
}

describe("AssetCache verified raster reads", () => {
  it("uses the bound decode snapshot and fails closed on poison", async () => {
    const { repo, openArtworkDecodeSnapshot, getVerifiedBlob, getBlob } = poisonedRepository();
    const cache = new AssetCache(repo);

    await expect(cache.imageWhenReady(SHA)).rejects.toThrow(/could not be decoded/);
    expect(openArtworkDecodeSnapshot).toHaveBeenCalledWith(
      SHA,
      "raster",
      expect.any(AbortSignal),
    );
    expect(getVerifiedBlob).not.toHaveBeenCalled();
    expect(getBlob).not.toHaveBeenCalled();
    expect(cache.getImage(SHA)).toBeNull();
  });

  it("getRasterData also fails closed before canvas access", async () => {
    const { repo } = poisonedRepository();
    const cache = new AssetCache(repo);
    await expect(cache.getRasterData(SHA)).rejects.toThrow(/could not be decoded/);
  });

  it("the suspension notification cannot start repository/decode work and primeImage is ignored", () => {
    const openArtworkDecodeSnapshot = vi.fn();
    const cache = new AssetCache({ openArtworkDecodeSnapshot } as unknown as AssetRepository);
    cache.subscribe(() => cache.getImage(SHA));
    cache.suspendRasters();
    cache.primeImage(SHA, {} as HTMLImageElement);
    expect(openArtworkDecodeSnapshot).not.toHaveBeenCalled();
    expect(cache.imageCacheSize).toBe(0);
  });

  it("suspension aborts an in-flight repository owner and clears it", async () => {
    let receivedSignal: AbortSignal | undefined;
    const openArtworkDecodeSnapshot = vi.fn((_sha, _kind, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<RasterDecodeSnapshot>(() => undefined);
    });
    const cache = new AssetCache({ openArtworkDecodeSnapshot } as unknown as AssetRepository);
    cache.getImage(SHA);
    await flushMicrotasks();
    expect(receivedSignal?.aborted).toBe(false);
    cache.suspendRasters();
    expect(receivedSignal?.aborted).toBe(true);
    expect(cache.imageCacheSize).toBe(0);
  });

  it("a primed image wins over a stale async load", async () => {
    installImageHarness();
    const repo = {
      openArtworkDecodeSnapshot: vi.fn(async () => snapshot()),
    } as unknown as AssetRepository;
    const cache = new AssetCache(repo);
    cache.getImage(SHA);
    await flushMicrotasks();
    const stale = ControlledImage.instances[0];
    expect(stale).toBeDefined();
    const staleOnload = stale.onload!;
    const primed = new ControlledImage() as unknown as HTMLImageElement;
    cache.primeImage(SHA, primed);
    staleOnload();
    await flushMicrotasks();
    expect(cache.getImage(SHA)).toBe(primed);
    expect(stale.removed).toBe(true);
  });

  it("imageWhenReady survives suspend/resume and resolves only the new epoch owner", async () => {
    installImageHarness();
    const repo = {
      openArtworkDecodeSnapshot: vi.fn(async () => snapshot()),
    } as unknown as AssetRepository;
    const cache = new AssetCache(repo);
    const pending = cache.imageWhenReady(SHA);
    await flushMicrotasks();
    const oldImage = ControlledImage.instances[0];
    cache.suspendRasters();
    expect(oldImage.removed).toBe(true);
    cache.resumeRasters();
    await flushMicrotasks();
    const freshImage = ControlledImage.instances[1];
    expect(freshImage).toBeDefined();
    freshImage.onload?.();
    await expect(pending).resolves.toBe(freshImage);
    expect(cache.getImage(SHA)).toBe(freshImage);
  });

  it("caller cancellation closes a late ImageBitmap without canvas readback", async () => {
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    const createImageBitmap = vi.fn(
      () => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; }),
    );
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const repo = {
      openArtworkDecodeSnapshot: vi.fn(async () => snapshot()),
    } as unknown as AssetRepository;
    const cache = new AssetCache(repo);
    cache.suspendRasters();
    const controller = new AbortController();
    const pending = cache.getTransferableRasterData(SHA, controller.signal);
    await flushMicrotasks();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveBitmap({ width: 2, height: 2, close } as unknown as ImageBitmap);
    await flushMicrotasks();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
