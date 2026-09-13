/**
 * Full raster CONTENT validation through an injectable decoder adapter.
 *
 * The header gates in raster-validator.ts are cheap and run first (signature,
 * declared-type/extension cross-checks, animation rejection, header
 * dimensions, byte/pixel bombs) — but headers can lie about the payload:
 * truncated or corrupt PNG IDAT streams, SOF-only or scan-truncated JPEGs,
 * and incomplete WebP payloads all carry valid headers. A raster is accepted
 * for persist/commit/at-rest-verify ONLY after validateRasterPayload()
 * fully decodes it and the decoded dimensions equal the parsed header.
 *
 * The decoder is an injected adapter:
 * - production (browser): createBrowserRasterDecoder() — createImageBitmap
 *   (a complete decode) with an <img> fallback; decoded resources are closed.
 * - non-DOM environments (unit tests, tooling): an explicit decoder MUST be
 *   injected. defaultRasterDecoder() fails CLOSED with the typed
 *   "raster-decode-unavailable" code — header-only validation can never
 *   silently count as full validation.
 *
 * Distinct names/types keep the two levels apart: validateRaster() returns
 * RasterInfo (header inspection); validateRasterPayload() returns
 * DecodedRasterInfo (full content validation).
 */
import { loadImageBlob } from "./image-load";
import {
  RasterValidationError,
  validateRaster,
  type RasterInfo,
  type RasterValidationOptions,
} from "./raster-validator";

/** Dimensions observed by an actual full decode of the payload. */
export type DecodedRasterDimensions = { width: number; height: number };

/** A prompt result and, for uncancellable native work, its actual cleanup lifetime. */
export type RasterDecodePromise = Promise<DecodedRasterDimensions> & {
  resourcesSettled?: Promise<void>;
};

/**
 * Adapter that must FULLY decode the payload (every pixel), resolve the
 * decoded dimensions, reject on any malformed/truncated payload, close any
 * decoder resources it opened, and stop early when `signal` aborts.
 */
export interface RasterDecoder {
  decode(
    bytes: Uint8Array,
    mime: RasterInfo["mime"],
    signal?: AbortSignal,
  ): RasterDecodePromise;
}

/**
 * Proof-of-decode result: header facts PLUS the payloadValidated brand.
 * Only validateRasterPayload() produces this type; APIs that persist or
 * trust raster content should demand it instead of RasterInfo.
 */
export type DecodedRasterInfo = RasterInfo & { readonly payloadValidated: true };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The raster decode was aborted.", "AbortError");
  }
}

/**
 * Production decoder over the browser's real image pipeline.
 * createImageBitmap() performs a complete decode; the bitmap is closed
 * before returning. Environments without createImageBitmap fall back to an
 * <img> element plus img.decode().
 */
export function createBrowserRasterDecoder(): RasterDecoder {
  return {
    decode(bytes, mime, signal) {
      throwIfAborted(signal);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: mime });
      const native = (async () => {
        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(blob);
          try { return { width: bitmap.width, height: bitmap.height }; }
          finally { bitmap.close(); }
        }
        const image = await loadImageBlob(blob, { signal });
        try {
          if (typeof image.decode === "function") await image.decode();
          return { width: image.naturalWidth, height: image.naturalHeight };
        } finally { image.removeAttribute("src"); }
      })();
      const resourcesSettled = native.then(() => undefined, () => undefined);
      const result: RasterDecodePromise = new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("The raster decode was aborted.", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        native.then(
          (value) => { signal?.removeEventListener("abort", abort); if (signal?.aborted) abort(); else resolve(value); },
          (error) => { signal?.removeEventListener("abort", abort); reject(error); },
        );
        if (signal?.aborted) abort();
      });
      // Cancellation settles the operation promptly. The ledger must retain
      // the native window until this separate promise observes bitmap.close.
      result.resourcesSettled = resourcesSettled;
      return result;
    },
  };
}

/** True when this environment can actually decode rasters in production. */
export function hasBrowserRasterDecoder(): boolean {
  return (
    typeof createImageBitmap === "function" ||
    (typeof Image === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function")
  );
}

/**
 * Fail-closed default: the real browser decoder when the environment has
 * one, otherwise a decoder whose decode() throws the typed
 * "raster-decode-unavailable" error. Non-DOM callers (unit tests, tooling)
 * MUST inject an explicit decoder — header-only checks never silently count
 * as full validation.
 */
export function defaultRasterDecoder(): RasterDecoder {
  if (hasBrowserRasterDecoder()) return createBrowserRasterDecoder();
  return {
    decode() {
      throw new RasterValidationError(
        "raster-decode-unavailable",
        "No raster decoder is available in this environment; inject a RasterDecoder explicitly (header-only validation never counts as full content validation).",
      );
    },
  };
}

export type RasterPayloadValidationOptions = RasterValidationOptions & {
  /** The injected full-decode adapter (required — there is no silent skip). */
  decoder: RasterDecoder;
  /** Called before awaiting a decoder with a separate native cleanup lifetime. */
  onResourcesSettled?: (settled: Promise<void>) => void;
  /** Operation-scoped cancellation; forwarded to the decoder. */
  signal?: AbortSignal;
};

/**
 * FULL content validation: header gates first (cheap rejections — including
 * animation — happen before any decoder work), then a complete decode
 * through the injected adapter, then decoded-vs-header dimension equality.
 * Returns the branded DecodedRasterInfo; throws RasterValidationError with
 * "raster-decode-failed" / "raster-decode-dimensions" codes on payload
 * violations. An abort from `signal` is rethrown untouched so operation
 * budgets keep their own typed cancellation error.
 */
export async function validateRasterPayload(
  bytes: Uint8Array,
  options: RasterPayloadValidationOptions,
): Promise<DecodedRasterInfo> {
  const header = validateRaster(bytes, options);
  let decoded: DecodedRasterDimensions;
  try {
    const pending = options.decoder.decode(bytes, header.mime, options.signal);
    if (pending.resourcesSettled) options.onResourcesSettled?.(pending.resourcesSettled);
    decoded = await pending;
  } catch (error) {
    if (error instanceof RasterValidationError) throw error;
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RasterValidationError(
      "raster-decode-failed",
      `The ${header.format} payload failed to decode fully: ${message}`,
    );
  }
  if (decoded.width !== header.width || decoded.height !== header.height) {
    throw new RasterValidationError(
      "raster-decode-dimensions",
      `Decoded dimensions ${decoded.width}x${decoded.height} disagree with the declared header ${header.width}x${header.height}.`,
    );
  }
  return { ...header, payloadValidated: true };
}
