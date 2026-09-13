/**
 * Session cache resolving content-addressed assets to drawable objects.
 * Images decode from stored Blobs to HTMLImageElements; custom-shape SVGs
 * decode to the studio's CustomShapeAsset shape. Loads are lazy and
 * subscribers are notified when something becomes available. Browser-only.
 */
import type { Sha256 } from "../core/types";
import type { AssetRepository } from "../storage";
import type { CustomShapeAsset } from "../studio/custom-shape-data";
import type { RasterData } from "../export/orchestrator";

function assetAbortError(): DOMException {
  return new DOMException("The asset decode was aborted.", "AbortError");
}

function throwIfAssetAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw assetAbortError();
}

function raceAssetSignal<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.then((value) => disposeLate?.(value), () => undefined);
    return Promise.reject(assetAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      reject(assetAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) disposeLate?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!aborted) reject(error);
      },
    );
  });
}

type LoadingImageEntry = {
  status: "loading";
  epoch: number;
  controller: AbortController;
  image?: HTMLImageElement;
  url?: string;
};

type ImageEntry =
  | LoadingImageEntry
  | { status: "ready"; epoch: number; image: HTMLImageElement; url?: string }
  | { status: "failed"; epoch: number };

export class AssetCache {
  private readonly images = new Map<Sha256, ImageEntry>();
  private readonly rasters = new Map<Sha256, Promise<RasterData>>();
  private readonly shapes = new Map<Sha256, CustomShapeAsset | "loading" | "failed">();
  private readonly urls = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  /** Nested export-suspension count; >0 ⇒ raster reads bypass the cache. */
  private rasterSuspends = 0;
  /** Bumped per suspension; diagnostic partner to the cleared cache map. */
  private rasterEpoch = 0;

  constructor(private readonly assets: AssetRepository) {}

  /** True once dispose() ran; a disposed cache never resolves new loads. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private revokeUrl(url: string | undefined): void {
    if (!url || !this.urls.delete(url)) return;
    URL.revokeObjectURL(url);
  }

  private stopLoading(entry: LoadingImageEntry): void {
    entry.controller.abort();
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image.removeAttribute("src");
    }
    this.revokeUrl(entry.url);
    entry.url = undefined;
  }

  private dropImageEntry(entry: ImageEntry): void {
    if (entry.status === "loading") this.stopLoading(entry);
    else if (entry.status === "ready") this.revokeUrl(entry.url);
  }

  private ownsImageLoad(sha256: Sha256, owner: LoadingImageEntry): boolean {
    return (
      this.images.get(sha256) === owner &&
      owner.epoch === this.rasterEpoch &&
      !this.disposed &&
      this.rasterSuspends === 0 &&
      !owner.controller.signal.aborted
    );
  }

  /** Registers an already-decoded image (import path) to skip a re-decode. */
  primeImage(sha256: Sha256, image: HTMLImageElement): void {
    if (this.disposed || this.rasterSuspends > 0) return;
    const existing = this.images.get(sha256);
    if (existing) this.dropImageEntry(existing);
    this.images.set(sha256, { status: "ready", epoch: this.rasterEpoch, image });
    this.notify();
  }

  primeCustomShape(sha256: Sha256, shape: CustomShapeAsset): void {
    this.shapes.set(sha256, shape);
    this.notify();
  }

  /** Returns the image when ready; kicks off the load otherwise. */
  getImage(sha256: Sha256): HTMLImageElement | null {
    // IMMEDIATE no-work guard while an export is in flight: the
    // suspension's own invalidation notify would otherwise trigger the
    // exact repository read + decode it exists to prevent (the epoch
    // guard only drops the RESULT; this guard drops the WORK). Consumers
    // see a pending image and re-resolve lazily after resume.
    if (this.disposed || this.rasterSuspends > 0) return null;
    const entry = this.images.get(sha256);
    if (entry?.status === "ready") return entry.image;
    if (entry) return null;
    const owner: LoadingImageEntry = {
      status: "loading",
      epoch: this.rasterEpoch,
      controller: new AbortController(),
    };
    this.images.set(sha256, owner);
    void this.loadImage(sha256, owner);
    return null;
  }

  private async loadImage(sha256: Sha256, owner: LoadingImageEntry): Promise<void> {
    try {
      // Hash/header verification and this native image decode are bound to
      // ONE captured row. The repository deliberately skips its configured
      // throwaway decoder here, so this image is the sole full payload decode.
      const snapshot = await this.assets.openArtworkDecodeSnapshot(
        sha256,
        "raster",
        owner.controller.signal,
      );
      const blob = await snapshot.verify(owner.controller.signal);
      if (!this.ownsImageLoad(sha256, owner)) return;
      const url = URL.createObjectURL(blob);
      owner.url = url;
      this.urls.add(url);
      const image = new Image();
      owner.image = image;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          image.onload = null;
          image.onerror = null;
          image.removeAttribute("src");
          reject(new DOMException("The image decode was aborted.", "AbortError"));
        };
        owner.controller.signal.addEventListener("abort", onAbort, { once: true });
        image.onload = () => {
          owner.controller.signal.removeEventListener("abort", onAbort);
          image.onload = null;
          image.onerror = null;
          resolve();
        };
        image.onerror = () => {
          owner.controller.signal.removeEventListener("abort", onAbort);
          image.onload = null;
          image.onerror = null;
          reject(new Error("decode failed"));
        };
        image.src = url;
      });
      if (
        image.naturalWidth !== snapshot.record.width ||
        image.naturalHeight !== snapshot.record.height
      ) {
        throw new Error("decoded image dimensions disagree with stored metadata");
      }
      if (!this.ownsImageLoad(sha256, owner)) return;
      owner.url = undefined;
      this.images.set(sha256, {
        status: "ready",
        epoch: owner.epoch,
        image,
        url,
      });
    } catch {
      if (this.images.get(sha256) === owner) {
        if (this.ownsImageLoad(sha256, owner)) {
          this.stopLoading(owner);
          this.images.set(sha256, { status: "failed", epoch: owner.epoch });
          this.notify();
        } else {
          this.stopLoading(owner);
          this.images.delete(sha256);
        }
      } else {
        this.stopLoading(owner);
      }
    }
    if (this.images.get(sha256)?.status === "ready") this.notify();
  }

  /**
   * Decoded straight-alpha RGBA pixels for the PreviewService / export
   * sources seam. Reuses the image decode (getImage/loadImage) and caches
   * the pixel read per asset; the caller must NOT mutate the result or
   * transfer its buffer (the PreviewService copies buffers before
   * transferring them to workers; transfer consumers use
   * getTransferableRasterData).
   */
  async getRasterData(sha256: Sha256, signal?: AbortSignal): Promise<RasterData> {
    // Suspended (export in flight): pass-through decode, NEVER cached —
    // the export's per-pass reads must not rebuild the ~raster-per-layer
    // co-residency the suspension exists to eliminate.
    if (this.rasterSuspends > 0) return this.readRasterData(sha256, signal);
    let pending = this.rasters.get(sha256);
    if (!pending) {
      const fresh = this.readRasterData(sha256);
      pending = fresh;
      this.rasters.set(sha256, fresh);
      // Epoch-guarded cleanup: only remove the entry this promise still
      // owns — a rejection settling after a suspend/resume cycle must not
      // evict a newer cached decode under the same key.
      fresh.catch(() => {
        if (this.rasters.get(sha256) === fresh) this.rasters.delete(sha256);
      });
    }
    return raceAssetSignal(pending, signal);
  }

  /**
   * CALLER-OWNED decode for TRANSFER consumers (the export worker path):
   * the returned buffer may be transferred/detached freely because it is
   * never a cached entry — a private copy of the shared decode (or a fresh
   * uncached decode while rasters are suspended). Also self-heals a cache
   * entry that a legacy consumer detached: zero-length pixels for a
   * non-empty image evict the poisoned entry and decode fresh.
   */
  async getTransferableRasterData(sha256: Sha256, signal?: AbortSignal): Promise<RasterData> {
    if (this.rasterSuspends > 0) return this.readRasterData(sha256, signal);
    const shared = await this.getRasterData(sha256, signal);
    if (shared.data.byteLength === 0 && shared.width * shared.height !== 0) {
      this.rasters.delete(sha256);
      return this.readRasterData(sha256, signal);
    }
    return { data: shared.data.slice(), width: shared.width, height: shared.height };
  }

  /**
   * EXPORT SUSPENSION (audit residual 1 — decode-cache co-residency): the
   * decoded-raster cache is one of TWO owners of the same bytes (the
   * PreviewService decode cache is the other); both are evicted for the
   * duration of an export and refill lazily afterwards. Re-entrant
   * (suspend counts nest); each suspend bumps the epoch so a decode that
   * was already in flight can never repopulate the cache after eviction.
   * Persistence is untouched — asset Blobs in storage remain durable.
   */
  suspendRasters(): void {
    this.rasterSuspends += 1;
    this.rasterEpoch += 1;
    this.rasters.clear();
    // WARM-IMAGE EVICTION: ready HTMLImageElements (and their object
    // URLs) release for the export's duration too — a previewed
    // multi-layer project must not hold every warm decoded surface beside
    // the export's working set. Previews re-decode lazily on resume.
    for (const entry of this.images.values()) this.dropImageEntry(entry);
    this.images.clear();
    // Defensive cleanup for any URL whose entry lost a race before install.
    for (const url of [...this.urls]) this.revokeUrl(url);
    // Invalidate React consumers: components holding refs to the evicted
    // images must re-resolve through the epoch-guarded path, not keep
    // painting from (or re-triggering loads of) dead sources.
    this.notify();
  }

  resumeRasters(): void {
    if (this.rasterSuspends > 0) this.rasterSuspends -= 1;
    if (this.rasterSuspends === 0) this.notify();
  }

  /** Test/diagnostic seam: entries currently retained by the raster cache. */
  get rasterCacheSize(): number {
    return this.rasters.size;
  }

  /** Test/diagnostic seam: decoded images currently retained. */
  get imageCacheSize(): number {
    return this.images.size;
  }

  /**
   * Suspension epoch (diagnostic): the map only ever gains entries
   * synchronously at request time — never after an await — so clearing it
   * plus the identity-guarded rejection cleanup IS the repopulation guard;
   * the epoch lets tests assert a suspension actually happened.
   */
  get rasterSuspendEpoch(): number {
    return this.rasterEpoch;
  }

  private async readRasterData(sha256: Sha256, signal?: AbortSignal): Promise<RasterData> {
    // EPHEMERAL decode while suspended: exports never touch the
    // preview-owned image cache at all (one-directional isolation) — the
    // verified blob decodes on a transient surface that is closed/dropped
    // after readback, so no per-pass residue accumulates.
    if (this.rasterSuspends > 0) return this.readRasterDataEphemeral(sha256, signal);
    const image = await this.imageWhenReady(sha256, signal);
    throwIfAssetAborted(signal);
    return AssetCache.readPixels(image, image.naturalWidth, image.naturalHeight);
  }

  private async loadImageEphemeral(
    sha256: Sha256,
    signal?: AbortSignal,
  ): Promise<HTMLImageElement> {
    const snapshot = await this.assets.openArtworkDecodeSnapshot(sha256, "raster", signal);
    const blob = await snapshot.verify(signal);
    throwIfAssetAborted(signal);
    return this.decodeImageBlob(
      blob,
      snapshot.record.width,
      snapshot.record.height,
      signal,
    );
  }

  private async decodeImageBlob(
    blob: Blob,
    expectedWidth: number,
    expectedHeight: number,
    signal?: AbortSignal,
  ): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          image.onload = null;
          image.onerror = null;
          image.removeAttribute("src");
          reject(assetAbortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        image.onload = () => {
          signal?.removeEventListener("abort", onAbort);
          image.onload = null;
          image.onerror = null;
          resolve();
        };
        image.onerror = () => {
          signal?.removeEventListener("abort", onAbort);
          image.onload = null;
          image.onerror = null;
          reject(new Error("decode failed"));
        };
        image.src = url;
      });
      if (
        image.naturalWidth !== expectedWidth ||
        image.naturalHeight !== expectedHeight
      ) {
        throw new Error("decoded image dimensions disagree with stored metadata");
      }
      throwIfAssetAborted(signal);
      return image;
    } finally {
      image.onload = null;
      image.onerror = null;
      // Post-load revoke: the decoded element stays drawable; nothing is
      // retained by this cache.
      URL.revokeObjectURL(url);
    }
  }

  private async readRasterDataEphemeral(
    sha256: Sha256,
    signal?: AbortSignal,
  ): Promise<RasterData> {
    const snapshot = await this.assets.openArtworkDecodeSnapshot(sha256, "raster", signal);
    const blob = await snapshot.verify(signal);
    throwIfAssetAborted(signal);
    if (snapshot.record.kind !== "svg" && typeof createImageBitmap === "function") {
      const bitmap = await raceAssetSignal(
        createImageBitmap(blob),
        signal,
        (late) => late.close(),
      );
      try {
        if (bitmap.width !== snapshot.record.width || bitmap.height !== snapshot.record.height) {
          throw new Error("decoded bitmap dimensions disagree with stored metadata");
        }
        throwIfAssetAborted(signal);
        return AssetCache.readPixels(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    }
    const image = await this.decodeImageBlob(
      blob,
      snapshot.record.width,
      snapshot.record.height,
      signal,
    );
    throwIfAssetAborted(signal);
    // The Image reference drops with this scope — never stored.
    return AssetCache.readPixels(image, image.naturalWidth, image.naturalHeight);
  }

  private static readPixels(
    source: CanvasImageSource,
    width: number,
    height: number,
  ): RasterData {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create a decode canvas");
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, width, height);
    return { data: pixels.data, width: pixels.width, height: pixels.height };
  }

  /** Resolves once the image entry becomes ready (kicking off the load). */
  imageWhenReady(sha256: Sha256, signal?: AbortSignal): Promise<HTMLImageElement> {
    // Suspended (export in flight): EPHEMERAL image — decoded for this
    // caller only, never stored, its object URL revoked after decode —
    // so the legacy-engine export path works during suspension without
    // repopulating the warm image cache (and can never deadlock on the
    // no-store guard in loadImage).
    if (this.rasterSuspends > 0) return this.loadImageEphemeral(sha256, signal);
    if (this.disposed) {
      return Promise.reject(new Error("The layer's source asset could not be decoded."));
    }
    if (signal?.aborted) return Promise.reject(assetAbortError());
    const ready = this.getImage(sha256);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, image?: HTMLImageElement) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(image!);
      };
      const onAbort = () => finish(assetAbortError());
      const check = () => {
        if (this.disposed) {
          finish(new Error("The layer's source asset could not be decoded."));
          return;
        }
        // A regular preview wait survives export suspension. The suspension
        // notification cancels/clears its old owner; the resume notification
        // restarts a fresh current-epoch load here.
        if (this.rasterSuspends > 0) return;
        const readyImage = this.getImage(sha256);
        if (readyImage) {
          finish(undefined, readyImage);
          return;
        }
        const entry = this.images.get(sha256);
        if (entry?.status === "failed") {
          finish(new Error("The layer's source asset could not be decoded."));
        }
      };
      const unsubscribe = this.subscribe(check);
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  /** Custom-dot / registration SVG as the studio's CustomShapeAsset. */
  getCustomShape(sha256: Sha256): CustomShapeAsset | null {
    const entry = this.shapes.get(sha256);
    if (entry && entry !== "loading" && entry !== "failed") return entry;
    if (entry) return null;
    this.shapes.set(sha256, "loading");
    void this.loadShape(sha256);
    return null;
  }

  private async loadShape(sha256: Sha256): Promise<void> {
    try {
      // verifyHash: stored SVG text is re-hashed against its content
      // address so a same-key poisoned row cannot masquerade as the asset.
      const blob = await this.assets.getBlob(sha256, "raster", { verifyHash: true });
      if (this.disposed) return;
      const svg = await blob.text();
      // INJECTION GATE: raw stored SVG is NEVER handed onward. The bytes
      // must be a strict-sanitizer canonical fixed point for a shape role
      // (canonical intake guarantees this for every legitimately imported
      // shape); tampered or legacy non-canonical rows fail closed and
      // surface as load failures / preflight blocks.
      const { sanitizeSvg } = await import("../io/svg-sanitizer");
      const canonical = (["custom-dot", "registration-mark"] as const).some((profile) => {
        try {
          return sanitizeSvg(svg, profile).svg === svg;
        } catch {
          return false;
        }
      });
      if (!canonical) throw new Error("stored SVG is not canonical sanitized markup");
      // The stored filename is intentionally not persisted (assets are
      // content-addressed); a generic display name stands in.
      this.shapes.set(sha256, { filename: "custom-shape.svg", svg });
    } catch {
      this.shapes.set(sha256, "failed");
    }
    this.notify();
  }

  /** Resolves once the custom-shape entry becomes ready (kicking off the load). */
  customShapeWhenReady(sha256: Sha256): Promise<CustomShapeAsset> {
    const ready = this.getCustomShape(sha256);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const check = () => {
        const entry = this.shapes.get(sha256);
        if (entry && entry !== "loading" && entry !== "failed") {
          unsubscribe();
          resolve(entry);
        } else if (entry === "failed" || this.disposed) {
          unsubscribe();
          reject(new Error("The custom SVG shape could not be loaded."));
        }
      };
      const unsubscribe = this.subscribe(check);
      check();
    });
  }

  /**
   * Main-thread prepared custom-dot stamp as a transferable ImageBitmap —
   * the WorkerRenderSources.resolveCustomStamp / PreviewSources seam.
   * A fresh bitmap is created per call because transfer consumes it.
   */
  async getCustomStampBitmap(sha256: Sha256, sizePx: number): Promise<ImageBitmap> {
    const shape = await this.customShapeWhenReady(sha256);
    const { prepareCustomShape, customShapeStamp } = await import("../studio/custom-shape");
    await prepareCustomShape(shape);
    // customShapeStamp sizes its canvas at 2× the maximum dot size; the
    // worker reads only the alpha channel, so the ink color is arbitrary.
    const stamp = customShapeStamp(shape, "#000000", sizePx / 2);
    return createImageBitmap(stamp);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rasterEpoch += 1;
    for (const entry of this.images.values()) this.dropImageEntry(entry);
    for (const url of [...this.urls]) this.revokeUrl(url);
    this.images.clear();
    this.rasters.clear();
    this.shapes.clear();
    // Wake pending imageWhenReady/customShapeWhenReady waiters so they
    // observe the disposed state and reject instead of hanging forever.
    this.notify();
    this.listeners.clear();
  }
}
