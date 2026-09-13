/**
 * Artwork import intake — the single validation seam for the Select-panel
 * upload card and the canvas drag-drop.
 *
 * Every artwork file is validated at the BYTES level BEFORE any browser
 * decoder runs:
 * - Rasters go through src/io/raster-validator (magic-byte sniffing,
 *   declared-MIME and filename-extension cross-checks, APNG / animated-WebP
 *   rejection, header-level dimension + pixel quotas) and then through the
 *   legacy dimension caps (16,384 px per side / 100 MP) against the HEADER
 *   dimensions — still pre-decode.
 * - SVGs go through src/io/svg-sanitizer with the "artwork" profile; only
 *   the canonical reconstructed markup ever leaves this module.
 *
 * Typed failures carry the validator's stable code plus the studio's
 * established user-facing copy (the migrated e2e specs pin those strings);
 * the validator's own message is preserved on `detail`.
 *
 * NOTE for tests: bytes are read through file.slice().arrayBuffer() — the
 * stale-selection e2e coverage instruments File.prototype.slice to stall a
 * specific read, and this module must stay observable through that seam.
 */
import {
  RasterValidationError,
  validateRaster,
  type RasterErrorCode,
  type RasterInfo,
} from "../io/raster-validator";
import {
  SvgValidationError,
  sanitizeSvg,
  type SanitizedSvg,
  type SvgErrorCode,
} from "../io/svg-sanitizer";
import { RESOURCE_POLICY } from "../core/resource-policy";

export const MAX_IMAGE_BYTES = RESOURCE_POLICY.maxRasterBytes;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = RESOURCE_POLICY.maxRasterPixels;

/** Legacy UX copy, pinned by the migrated e2e specs. */
const COPY = {
  unsupportedType: "Choose a PNG, JPG, WebP, or SVG image.",
  empty: "That image is empty.",
  tooLarge: "Choose an image smaller than 50 MB.",
  wrongFormat: "That file does not contain the selected PNG, JPG, or WebP format.",
  malformed: "That image could not be opened.",
  animated: "Animated images are not supported. Choose a still PNG, JPG, or WebP.",
  invalidDimensions: "That image has invalid dimensions.",
  oversized: "Choose an image no larger than 16,384 px per side and 100 megapixels.",
  unreadable: "That image could not be read.",
} as const;

export type ArtworkIntakeCode =
  | RasterErrorCode
  | SvgErrorCode
  | "unsupported-type"
  | "unreadable";

export class ArtworkIntakeError extends Error {
  readonly code: ArtworkIntakeCode;
  /** The underlying validator's own message (diagnostic, not UX copy). */
  readonly detail: string;
  constructor(code: ArtworkIntakeCode, message: string, detail = message) {
    super(message);
    this.name = "ArtworkIntakeError";
    this.code = code;
    this.detail = detail;
  }
}

export type ArtworkIntake =
  | { kind: "raster"; bytes: Uint8Array; info: RasterInfo }
  | { kind: "svg"; sanitized: SanitizedSvg };

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function extensionOf(name: string): string | null {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : null;
}

function isSvgSelection(file: Pick<File, "name" | "type">): boolean {
  return file.type.toLowerCase() === "image/svg+xml" || extensionOf(file.name) === "svg";
}

function uxMessageFor(code: RasterErrorCode): string {
  switch (code) {
    case "raster-empty":
      return COPY.empty;
    case "raster-too-large":
      return COPY.tooLarge;
    case "raster-unknown-format":
    case "raster-format-mismatch":
      return COPY.wrongFormat;
    case "raster-animated":
      return COPY.animated;
    case "raster-dimensions-invalid":
      return COPY.invalidDimensions;
    case "raster-pixels-exceeded":
      return COPY.oversized;
    // Full-decode validation codes (archive trust boundary) group with the
    // malformed case: the bytes passed the cheap header gate but failed
    // (or could not run) a real decode — the same "could not be read" case.
    case "raster-malformed":
    case "raster-unsupported":
    case "raster-decode-failed":
    case "raster-decode-dimensions":
    case "raster-decode-unavailable":
      return COPY.malformed;
  }
}

/** Pre-flight on caller-controlled metadata only (no bytes read yet). */
export function validateImageFile(file: Pick<File, "name" | "type" | "size">): string | null {
  if (!RASTER_TYPES.has(file.type.toLowerCase()) && !isSvgSelection(file)) {
    return COPY.unsupportedType;
  }
  if (file.size === 0) return COPY.empty;
  if (file.size > MAX_IMAGE_BYTES) return COPY.tooLarge;
  return null;
}

/**
 * Legacy header-dimension cap, now applied to the raster HEADER dimensions
 * (pre-decode) and re-checked against decoded dimensions as belt-and-braces.
 */
export function validateImageDimensions(width: number, height: number): string | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return COPY.invalidDimensions;
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    return COPY.oversized;
  }
  return null;
}

/**
 * Validate one selected artwork file at the bytes level, BEFORE any decode.
 * Returns the validated bytes (raster) or the canonical sanitized markup
 * (SVG); throws ArtworkIntakeError with the studio's UX copy on rejection.
 */
export async function validateArtworkFile(file: File): Promise<ArtworkIntake> {
  const metaError = validateImageFile(file);
  if (metaError) {
    throw new ArtworkIntakeError(
      metaError === COPY.unsupportedType ? "unsupported-type"
        : metaError === COPY.empty ? "raster-empty" : "raster-too-large",
      metaError,
    );
  }

  let bytes: Uint8Array;
  try {
    // Read through slice() — see the module note about the e2e stall seam.
    bytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
  } catch {
    throw new ArtworkIntakeError("unreadable", COPY.unreadable);
  }

  if (isSvgSelection(file)) {
    let sanitized: SanitizedSvg;
    try {
      sanitized = sanitizeSvg(new TextDecoder().decode(bytes), "artwork");
    } catch (error) {
      if (error instanceof SvgValidationError) {
        // The sanitizer's typed message IS the UX copy for SVG rejections.
        throw new ArtworkIntakeError(error.code, error.message);
      }
      throw new ArtworkIntakeError("unreadable", COPY.unreadable);
    }
    // Never trust SVG-declared dimensions for rasterization: the same
    // pre-decode area caps rasters get apply BEFORE any canvas allocation.
    const width = Math.round(sanitized.width);
    const height = Math.round(sanitized.height);
    if (!Number.isFinite(sanitized.width) || !Number.isFinite(sanitized.height)
      || width <= 0 || height <= 0) {
      throw new ArtworkIntakeError("raster-dimensions-invalid", COPY.invalidDimensions);
    }
    const svgDimensionError = validateImageDimensions(width, height);
    if (svgDimensionError) {
      throw new ArtworkIntakeError(
        svgDimensionError === COPY.oversized ? "raster-pixels-exceeded" : "raster-dimensions-invalid",
        svgDimensionError,
      );
    }
    return { kind: "svg", sanitized };
  }

  let info: RasterInfo;
  try {
    const declaredType = file.type ? { declaredType: file.type } : {};
    const filename = extensionOf(file.name) !== null ? { filename: file.name } : {};
    info = validateRaster(bytes, { ...declaredType, ...filename });
  } catch (error) {
    if (error instanceof RasterValidationError) {
      throw new ArtworkIntakeError(error.code, uxMessageFor(error.code), error.message);
    }
    throw new ArtworkIntakeError("unreadable", COPY.unreadable);
  }

  // Legacy studio caps, enforced against the HEADER dimensions pre-decode.
  const dimensionError = validateImageDimensions(info.width, info.height);
  if (dimensionError) {
    throw new ArtworkIntakeError(
      dimensionError === COPY.oversized ? "raster-pixels-exceeded" : "raster-dimensions-invalid",
      dimensionError,
    );
  }
  return { kind: "raster", bytes, info };
}
