/**
 * Export target model. Describes every supported export destination —
 * composite raster, plate packages, selected-layer cutouts — plus the
 * per-target registration defaults, alpha/matte rules, bounds, and file
 * naming that preflight and the orchestrator share.
 */

import type {
  ArtboardV1,
  Id,
  LayerV1,
  OutputDefaultsV1,
  PlateId,
  ProjectCoreV1,
  SeparationV1,
} from "../core/types";

/* ------------------------------------------------------------------ */
/* Target shapes                                                       */
/* ------------------------------------------------------------------ */

export type CompositeFormat = "png" | "jpeg" | "tiff";
export type PlatePackageFormat = "png" | "svg";
export type SelectedLayerFormat = "png" | "tiff";

export type CompositeTarget = {
  kind: "composite";
  format: CompositeFormat;
  /** Explicit override; when undefined the document default applies. */
  registration?: boolean;
};

export type PlatePackageTarget = {
  kind: "plate-package";
  format: PlatePackageFormat;
  registration?: boolean;
};

export type SelectedLayerTarget = {
  kind: "selected-layer";
  format: SelectedLayerFormat;
  layerId: Id;
  registration?: boolean;
};

export type ExportTarget = CompositeTarget | PlatePackageTarget | SelectedLayerTarget;

export type ExportFormat = CompositeFormat | PlatePackageFormat | SelectedLayerFormat;

/* ------------------------------------------------------------------ */
/* Registration defaults                                               */
/* ------------------------------------------------------------------ */

/**
 * Registration defaults: ON for plate packages, OFF for composite and
 * selected-layer exports. The document's OutputDefaultsV1 provides the
 * document-level default; an explicit target.registration always wins.
 * Selected-layer exports never inherit a document default — they are a
 * placement-preserving cutout, so registration is off unless overridden.
 */
export function resolveRegistration(target: ExportTarget, output: OutputDefaultsV1): boolean {
  if (target.registration !== undefined) return target.registration;
  if (target.kind === "plate-package") return output.registrationOnPlates;
  if (target.kind === "composite") return output.registrationOnComposite;
  return false;
}

/* ------------------------------------------------------------------ */
/* Format metadata                                                     */
/* ------------------------------------------------------------------ */

export function formatSupportsAlpha(format: ExportFormat): boolean {
  return format === "png" || format === "tiff" || format === "svg";
}

export function formatMime(format: ExportFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "tiff":
      return "image/tiff";
    case "svg":
      return "image/svg+xml";
  }
}

export function formatExtension(format: ExportFormat): string {
  switch (format) {
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
    case "tiff":
      return "tiff";
    case "svg":
      return "svg";
  }
}

/* ------------------------------------------------------------------ */
/* Bounds, alpha, matte                                                */
/* ------------------------------------------------------------------ */

/** Every export target renders the full artboard at document pixels. */
export function exportBounds(artboard: ArtboardV1): { width: number; height: number } {
  return { width: artboard.widthPx, height: artboard.heightPx };
}

/**
 * Composite matte color for the target, or null when the output keeps
 * transparency. The artboard background is a proof/matte preference only —
 * it never creates plate ink, so plate packages and selected-layer exports
 * are always transparent. JPEG cannot carry alpha and always mattes.
 */
export function resolveMatte(target: ExportTarget, artboard: ArtboardV1): string | null {
  if (target.kind !== "composite") return null;
  if (target.format === "jpeg") {
    return artboard.background === "black" ? "#000000" : "#ffffff";
  }
  if (artboard.background === "white") return "#ffffff";
  if (artboard.background === "black") return "#000000";
  return null;
}

/** True when the target's pixels preserve source alpha end to end. */
export function targetIsTransparent(target: ExportTarget, artboard: ArtboardV1): boolean {
  return resolveMatte(target, artboard) === null && formatSupportsAlpha(target.format);
}

/* ------------------------------------------------------------------ */
/* Contributing layers and plates                                      */
/* ------------------------------------------------------------------ */

/** Visible layers that contribute ink to the given target. */
export function contributingLayers(core: ProjectCoreV1, target: ExportTarget): LayerV1[] {
  if (target.kind === "selected-layer") {
    const layer = core.layers.find(({ id }) => id === target.layerId);
    return layer ? [layer] : [];
  }
  return core.layers.filter((layer) => layer.visible);
}

/** Plates that a plate package or composite render will actually produce. */
export function contributingPlates(separation: SeparationV1): PlateId[] {
  const plates: PlateId[] = separation.mode === "grayscale"
    ? ["black"]
    : ["cyan", "magenta", "yellow", "black"];
  return plates.filter((plate) => separation.visible[plate]);
}

/* ------------------------------------------------------------------ */
/* File naming                                                         */
/* ------------------------------------------------------------------ */

export const PLATE_SHORT: Record<PlateId, string> = {
  cyan: "C",
  magenta: "M",
  yellow: "Y",
  black: "K",
};

/**
 * Filesystem-safe base name derived from the ARTWORK SOURCE name. This is
 * BYTE-FOR-BYTE the shipped studio's cleanName (git HEAD
 * src/studio/HalftoneStudio.tsx):
 *
 *   name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()
 *
 * — strip ONE trailing dot-segment, replace each run of other characters
 * with a single "-", lowercase. No extra collapsing or trimming: leading/
 * trailing separators and "-" survivors are the shipped contract
 * ("DR.GLITCH sample artwork" → "dr"; "###" → "-"; " a b " → "-a-b-").
 * The ONLY deliberate extension: an empty result (empty source name) falls
 * back to "untitled" so a file name always exists — shipped code never hit
 * this because a source always had a filename.
 */
export function exportBaseName(sourceName: string): string {
  const cleaned = sourceName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .toLowerCase();
  return cleaned === "" ? "untitled" : cleaned;
}

/** Folder (and ZIP base) name for the vector plate package — legacy shape. */
export function svgPlateFolderName(sourceName: string): string {
  return `${exportBaseName(sourceName)}_SVG_Plates`;
}

/**
 * Download filename for a target, based on the ARTWORK SOURCE name (legacy
 * cleanName(sourceName) semantics — never the project title). Composite and
 * raster-plate names follow the shipped studio exactly
 * (`<base>-halftone.<ext>`, `<base>-CMYK-plates.zip` / `<base>-K-plates.zip`,
 * `<base>_SVG_Plates.zip`); the raster plate ZIP therefore needs the
 * separation mode. Selected-layer exports are new to the workstation and
 * use the coverage-map contract (`<base>-layer.<ext>`).
 */
export function targetFileName(
  target: ExportTarget,
  sourceName: string,
  separationMode: SeparationV1["mode"],
): string {
  const base = exportBaseName(sourceName);
  if (target.kind === "composite") return `${base}-halftone.${formatExtension(target.format)}`;
  if (target.kind === "plate-package") {
    if (target.format === "svg") return `${svgPlateFolderName(sourceName)}.zip`;
    return `${base}-${separationMode === "grayscale" ? "K" : "CMYK"}-plates.zip`;
  }
  return `${base}-layer.${formatExtension(target.format)}`;
}

/**
 * ZIP entry name for one plate. Legacy shapes: raster plates sit at the
 * archive root as `<base>-C-plate.png`; vector plates sit inside the
 * package folder as `<base>_SVG_Plates/C.svg`.
 */
export function plateFileName(sourceName: string, plate: PlateId, format: PlatePackageFormat): string {
  if (format === "svg") return `${svgPlateFolderName(sourceName)}/${PLATE_SHORT[plate]}.svg`;
  return `${exportBaseName(sourceName)}-${PLATE_SHORT[plate]}-plate.png`;
}

/**
 * ZIP entry name for the job manifest: archive root for raster packages,
 * inside the package folder for vector packages — both legacy placements.
 */
export function plateSettingsFileName(sourceName: string, format: PlatePackageFormat): string {
  if (format === "svg") return `${svgPlateFolderName(sourceName)}/job-settings.json`;
  return "job-settings.json";
}

/** Human-readable target description for dialogs and progress UI. */
export function describeTarget(target: ExportTarget): string {
  if (target.kind === "composite") {
    return `Composite ${target.format.toUpperCase()} — full artboard`;
  }
  if (target.kind === "plate-package") {
    return target.format === "svg"
      ? "Plate package — vector SVG ZIP"
      : "Plate package — 240-DPI PNG ZIP";
  }
  return `Selected layer ${target.format.toUpperCase()} — transparent, placement preserved`;
}

/**
 * Residency cap for ONE vector plate's SVG text (wave G2 entry-buffered
 * honesty bound). Lives here so BOTH admission (preflight estimate) and
 * the packagers (actual UTF-8 byte enforcement before the first entry
 * byte is written) share one constant without an import cycle.
 */
export const MAX_STREAMED_SVG_PLATE_BYTES = 32 * 1024 * 1024;

/**
 * Whole-package ceiling for the legacy in-memory ZIP path. Above this
 * bound plate packages must use the sequential File System Access path.
 * This is deliberately lower than the generic Blob-download cap: the
 * buffered packager temporarily owns encoded entries, ZIP input copies,
 * and the finished Blob at the same time.
 */
export const MAX_BUFFERED_PLATE_PACKAGE_BYTES = 32 * 1024 * 1024;
