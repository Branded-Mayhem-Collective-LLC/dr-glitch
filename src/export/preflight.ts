/**
 * Pure export preflight engine. Evaluates a frozen ProjectCoreV1 against a
 * target and produces PreflightIssue records with stable machine codes.
 *
 * Severity contract:
 * - "block" issues make the export impossible or dangerous and cannot be
 *   overridden (missing assets, invalid geometry, resource limits).
 * - "warn" issues require a revision-bound confirmation: the UI stores the
 *   revision each warning was computed against and re-confirms when the
 *   project revision moves.
 */

import type {
  Id,
  PerspectiveQuadV1,
  PlateId,
  PreflightIssue,
  ProjectCoreV1,
  Sha256,
  TransformV1,
  Vec2,
} from "../core/types";
import { customRegistrationPeakBytes } from "../core/registration-memory";
import { RESOURCE_POLICY, type ResourcePolicy } from "../core/resource-policy";
import { croppedSize, transformedBounds, type Bounds } from "../editor";
import {
  estimateGridCandidates,
  MAX_GRID_CANDIDATES,
  MAX_RASTER_GRID_POINTS,
  planRender,
  type PlanOutputModel,
  type RenderPlan,
} from "../render";
/* The SAME settings-aware layer-model builder the production render
 * service plans with — admission and execution share one model source. */
import { planLayerModels } from "./worker-render-service";
import { legacyEngineEligible } from "./current-engine";
import { legacyCanvasPeakBytes } from "./legacy-memory";
import {
  estimateGridPoints,
  MAX_DIFFUSION_RASTER_PIXELS,
  MAX_DIFFUSION_SVG_RUNS,
  MAX_EXPORT_GRID_POINTS,
} from "../studio/halftone";
import { SHEET_SIZES } from "../studio/document-model";
import { DOCUMENT_DPI } from "../core/types";
import {
  contributingLayers,
  contributingPlates,
  MAX_BUFFERED_PLATE_PACKAGE_BYTES,
  MAX_STREAMED_SVG_PLATE_BYTES,
  resolveMatte,
  resolveRegistration,
  type ExportTarget,
} from "./targets";

/* ------------------------------------------------------------------ */
/* Asset inputs                                                        */
/* ------------------------------------------------------------------ */

/**
 * Narrow view of the asset store the caller resolves before preflight.
 * Mirrors AssetRecordV1 plus integrity results; defined locally so the
 * engine stays decoupled from the storage layer.
 */
export type AssetInfo = {
  sha256: Sha256;
  kind: "raster" | "svg";
  /** Bytes are present and decoded successfully. */
  ok: boolean;
  /** SVG failed the strict sanitizer (unsafe content); always a hard block. */
  unsafeSvg?: boolean;
  width: number;
  height: number;
  byteLength: number;
};

/* ------------------------------------------------------------------ */
/* Stable issue codes                                                  */
/* ------------------------------------------------------------------ */

export const BLOCK_CODES = [
  "asset-missing",
  "asset-corrupt",
  "svg-unsafe",
  "transform-invalid",
  "quad-invalid",
  "artboard-empty",
  "artboard-pixels-exceeded",
  "artboard-edge-exceeded",
  "no-printable-layers",
  "no-visible-plates",
  "layer-not-found",
  "vector-ineligible",
  "grid-points-exceeded",
  "diffusion-raster-exceeded",
  "render-peak-exceeded",
  "streaming-unsupported",
  "vector-knockout-unsupported",
  "polarity-vector-unsupported",
  "delivery-exceeded",
  "stream-registration-unsupported",
  "svg-entry-bytes-exceeded",
  "archive-entries-exceeded",
  "archive-bytes-exceeded",
] as const;

export const WARN_CODES = [
  "angle-unusual",
  "angle-duplicate",
  "polarity-negative",
  "layer-hidden-excluded",
  "plate-hidden-excluded",
  "registration-off-plates",
  "registration-on-composite",
  "selected-layer-hidden",
  "artboard-below-preset",
  "opacity-below-one",
] as const;

export type PreflightBlockCode = (typeof BLOCK_CODES)[number];
export type PreflightWarnCode = (typeof WARN_CODES)[number];
export type PreflightCode = PreflightBlockCode | PreflightWarnCode;

/** Conventional process screen angles the engine ships as defaults. */
export const CONVENTIONAL_ANGLES: Record<PlateId, number> = {
  cyan: 15,
  magenta: 75,
  yellow: 0,
  black: 45,
};

/**
 * @deprecated Legacy per-pixel peak heuristic, superseded by planRender's
 * real per-form model (src/render/planner.ts) which preflight now consults.
 * Kept exported for existing consumers; do not add new uses.
 */
export const RENDER_PEAK_BYTES_PER_PIXEL = 24;

/** Raw RGBA bytes per pixel used to bound uncompressed archive size. */
const ARCHIVE_BYTES_PER_PIXEL = 4;

/* ------------------------------------------------------------------ */
/* Delivery planning contract (wave G2)                                 */
/* ------------------------------------------------------------------ */

/**
 * Conservative raw-byte estimate of a target's delivered output — the ONE
 * planning contract shared by preflight and the export flow's delivery
 * plan. Raster outputs are bounded by uncompressed RGBA; raster plate
 * packages by plates × RGBA (the ARCHIVE_BYTES_PER_PIXEL model of the
 * archive caps). VECTOR packages scale with MARKS/RUNS, not pixels: their
 * estimate sums the per-plate mark/run byte bounds (per-shape maxima over
 * representative mark strings at full double precision) plus per-entry
 * envelope overhead. Compressed outputs may come in far smaller; delivery
 * is planned on the bound, never on hoped-for compression.
 */
/**
 * WORST-CASE encoding/container overhead for one raster payload of
 * `rawBytes` (with `rows` scanlines) delivered as PNG inside a ZIP entry:
 * - PNG filtering: +1 byte per scanline;
 * - zlib stored-block ceiling: +5 bytes per 64 KiB block +11 fixed
 *   (header + adler) — deflate can EXCEED input on incompressible data,
 *   and the stored-block bound is the standard worst case;
 * - PNG chunk framing: +12 bytes per IDAT slice (64 KiB slicing assumed)
 *   plus signature/IHDR/pHYs/IEND ≈ 128 fixed;
 * - ZIP container: local + central headers + data descriptor ≈ 384 per
 *   entry (name counted twice by the caller).
 * Routing keys off THIS conservative figure so a cap-boundary export
 * decides buffered-vs-streamed BEFORE render — there is no post-render
 * switch to a picker (which would have no user activation left).
 */
export function estimateRasterEntryDeliveredBytes(rawBytes: number, rows: number): number {
  const filtered = rawBytes + rows;
  const zlib = filtered + Math.ceil(filtered / 65_535) * 5 + 11;
  const pngFramed = zlib + Math.ceil(zlib / 65_536) * 12 + 128;
  // CANVAS-ENCODER MARGIN: the buffered path encodes through the browser's
  // canvas PNG encoder (kept for byte-parity with the shipped oracles), so
  // the formal stream-encoder bound above gains a measured 5% + 4 KiB
  // safety factor covering encoder-specific filter/framing choices; the
  // STREAM encoder needs no factor — its 64 KiB IDAT coalescing enforces
  // the framing bound by construction.
  return Math.ceil(pngFramed * 1.05) + 4096 + 384;
}

export function estimateDeliveredBytes(core: ProjectCoreV1, target: ExportTarget): number {
  const width = Math.max(0, core.artboard.widthPx);
  const height = Math.max(0, core.artboard.heightPx);
  const pixels = width * height;
  if (target.kind === "plate-package") {
    const plates = contributingPlates(core.separation);
    if (target.format === "svg") {
      const layers = contributingLayers(core, target);
      const registrationBytes =
        resolveRegistration(target, core.output) &&
        core.registration.customShapeAssetId !== null
          ? SVG_CUSTOM_REGISTRATION_ALLOWANCE_BYTES
          : 0;
      let total = 0;
      for (const plate of plates) {
        total +=
          estimateSvgPlateBytes(core, layers, plate) +
          SVG_ENTRY_OVERHEAD_BYTES +
          registrationBytes;
      }
      return total + estimatePlateManifestBytes(core);
    }
    return (
      plates.length * estimateRasterEntryDeliveredBytes(pixels * ARCHIVE_BYTES_PER_PIXEL, height) +
      estimatePlateManifestBytes(core)
    );
  }
  // Single files: PNG worst case covers TIFF (raw + fixed header) and the
  // conservative JPEG bound alike.
  return estimateRasterEntryDeliveredBytes(pixels * ARCHIVE_BYTES_PER_PIXEL, height);
}

/**
 * Which targets have a genuinely streamable delivery form (wave G2 format
 * decisions): plate packages stream (PNG band-wise, SVG entry-buffered
 * under MAX_STREAMED_SVG_PLATE_BYTES); composite/selected-layer PNG and
 * TIFF stream chunk-wise from the finished raster; JPEG alone hard-blocks
 * above the threshold — its only encoder is canvas.toBlob, which has no
 * incremental form.
 */
export function targetSupportsStreaming(target: ExportTarget): boolean {
  return target.kind === "plate-package" || target.format !== "jpeg";
}

/**
 * Per-shape SVG mark byte maxima, measured from svgDotMark's templates at
 * full JS double precision (each coordinate up to ~18 characters) and
 * rounded up. The conservativeness test regenerates worst-case marks and
 * asserts these bounds hold.
 */
export const SVG_MARK_ESTIMATE_BYTES: Record<string, number> = {
  round: 80,
  square: 112,
  diamond: 200,
  triangle: 168,
  cross: 288,
  line: 144,
  "circle-outline": 152,
  custom: 152,
};

/** Estimated SVG text bytes per diffusion run rect. */
export const STREAMED_SVG_RUN_ESTIMATE_BYTES = 64;

/** Per-entry envelope: SVG header/defs/registration + ZIP entry records. */
export const SVG_ENTRY_OVERHEAD_BYTES = 64 * 1024;

/** Custom registration source plus symbol/use wrappers in one SVG plate. */
export const SVG_CUSTOM_REGISTRATION_ALLOWANCE_BYTES = 512 * 1024;

/** job-settings.json base plus worst-case JSON escaping for embedded SVGs. */
export const PLATE_MANIFEST_BASE_BYTES = 64 * 1024;
export const PLATE_MANIFEST_CUSTOM_DOT_BYTES = 2 * 1024 * 1024;
export const PLATE_MANIFEST_CUSTOM_REGISTRATION_BYTES = 512 * 1024;

export function estimatePlateManifestBytes(core: ProjectCoreV1): number {
  const hasCustomDot = core.layers.some(
    (layer) =>
      layer.recipe.halftone.dotShape === "custom" &&
      layer.recipe.halftone.customShapeAssetId !== null,
  );
  return (
    PLATE_MANIFEST_BASE_BYTES +
    (hasCustomDot ? PLATE_MANIFEST_CUSTOM_DOT_BYTES : 0) +
    (core.registration.customShapeAssetId !== null
      ? PLATE_MANIFEST_CUSTOM_REGISTRATION_BYTES
      : 0)
  );
}

/** Conservative JS/string-builder envelope for SVG assembly. */
export const SVG_ASSEMBLY_FIXED_BYTES = 8 * 1024 * 1024;
export const SVG_ASSEMBLY_BYTES_PER_UTF8_BYTE = 8;
export const SVG_ASSEMBLY_BYTES_PER_FRAGMENT = 64;

/** Alternating covered pixels yield at most ceil(width / 2) runs per row. */
export function estimateMaxDiffusionSvgRuns(width: number, height: number): number {
  return Math.min(
    Math.max(0, height) * Math.ceil(Math.max(0, width) / 2),
    MAX_DIFFUSION_SVG_RUNS,
  );
}

/**
 * Conservative allowance for ONE custom-dot <symbol> definition embedded
 * per custom-shape layer (sanitized source markup plus symbol wrapper).
 * Upper-bounds the sanitizer's accepted input; counted once per
 * custom-dot layer in every plate entry.
 */
export const SVG_CUSTOM_SYMBOL_ALLOWANCE_BYTES = 1024 * 1024;

/* Shared with the packagers' actual-byte enforcement (targets.ts); the
 * ESTIMATE gate here is the admission story, the packagers' measured
 * UTF-8 check is the safety story — both stand. */
export { MAX_STREAMED_SVG_PLATE_BYTES };

/** Conservative SVG text bytes for ONE plate's entry. */
export function estimateSvgPlateBytes(
  core: ProjectCoreV1,
  layers: ProjectCoreV1["layers"],
  plate: PlateId,
): number {
  let bytes = 0;
  for (const layer of layers) {
    if (layer.recipe.mode === "halftone") {
      const markBytes =
        SVG_MARK_ESTIMATE_BYTES[layer.recipe.halftone.dotShape] ?? SVG_MARK_ESTIMATE_BYTES.cross;
      if (layer.recipe.halftone.dotShape === "custom") {
        // Each custom-dot layer embeds its sanitized shape as a <symbol>
        // definition in every plate entry.
        bytes += SVG_CUSTOM_SYMBOL_ALLOWANCE_BYTES;
      }
      bytes +=
        estimateGridPoints(
          core.artboard.widthPx,
          core.artboard.heightPx,
          Math.max(0.01, layer.recipe.halftone.cellSize),
          core.separation.angles[plate],
        ) * markBytes;
    } else if (layer.recipe.mode === "diffusion") {
      bytes +=
        estimateMaxDiffusionSvgRuns(core.artboard.widthPx, core.artboard.heightPx) *
        STREAMED_SVG_RUN_ESTIMATE_BYTES;
    }
  }
  return bytes;
}

/** Worst per-plate SVG entry estimate across a package's plates. */
export function estimateSvgPlateEntryBytes(
  core: ProjectCoreV1,
  layers: ProjectCoreV1["layers"],
  plates: PlateId[],
): number {
  let worst = 0;
  for (const plate of plates) {
    worst = Math.max(
      worst,
      estimateSvgPlateBytes(core, layers, plate) + SVG_ENTRY_OVERHEAD_BYTES,
    );
  }
  return worst;
}

/** Conservative number of separately retained SVG mark/run fragments. */
export function estimateSvgPlateFragments(
  core: ProjectCoreV1,
  layers: ProjectCoreV1["layers"],
  plate: PlateId,
): number {
  let fragments = 8; // document/header/defs/registration/group envelope
  for (const layer of layers) {
    fragments += 1; // layer group
    if (layer.recipe.mode === "halftone") {
      fragments += estimateGridPoints(
        core.artboard.widthPx,
        core.artboard.heightPx,
        Math.max(0.01, layer.recipe.halftone.cellSize),
        core.separation.angles[plate],
      );
      if (layer.recipe.halftone.dotShape === "custom") fragments += 1;
    } else if (layer.recipe.mode === "diffusion") {
      fragments += estimateMaxDiffusionSvgRuns(
        core.artboard.widthPx,
        core.artboard.heightPx,
      );
    }
  }
  return fragments;
}

/**
 * Peak residency of the renderer's array-of-fragments plus joined UTF-16
 * strings and packaging copies. The multiplier intentionally covers both
 * character and UTF-8 forms; fragment slots/objects are priced separately.
 */
export function estimateSvgAssemblyPeakBytes(
  finalUtf8Bytes: number,
  fragmentCount: number,
): number {
  return (
    finalUtf8Bytes * SVG_ASSEMBLY_BYTES_PER_UTF8_BYTE +
    fragmentCount * SVG_ASSEMBLY_BYTES_PER_FRAGMENT +
    SVG_ASSEMBLY_FIXED_BYTES
  );
}

/* ------------------------------------------------------------------ */
/* Geometry validation                                                 */
/* ------------------------------------------------------------------ */

function isFiniteVec(vec: Vec2): boolean {
  return Number.isFinite(vec.x) && Number.isFinite(vec.y);
}

/** Null when valid, otherwise a human-readable reason. */
export function invalidTransformReason(transform: TransformV1): string | null {
  if (!isFiniteVec(transform.position)) return "its position is not a finite number";
  if (!isFiniteVec(transform.scale)) return "its scale is not a finite number";
  if (transform.scale.x === 0 || transform.scale.y === 0) return "its scale collapses to zero area";
  if (!Number.isFinite(transform.rotation)) return "its rotation is not a finite number";
  if (!isFiniteVec(transform.skew)) return "its skew is not a finite number";
  return null;
}

/**
 * Null when valid. A valid quad is finite, strictly convex with consistent
 * winding (which also excludes self-intersection for a 4-gon), and has
 * non-trivial area. A null quad means "no perspective" and is valid.
 */
export function invalidQuadReason(quad: PerspectiveQuadV1): string | null {
  if (quad === null) return null;
  if (quad.length !== 4 || quad.some((point) => !isFiniteVec(point))) {
    return "its perspective corners are not finite points";
  }
  let area = 0;
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const a = quad[index];
    const b = quad[(index + 1) % 4];
    const c = quad[(index + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return "its perspective corners are collinear";
    const crossSign = Math.sign(cross);
    if (sign === 0) sign = crossSign;
    else if (crossSign !== sign) return "its perspective quad is concave or self-intersecting";
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area / 2) < 1) return "its perspective quad has near-zero area";
  return null;
}

/* ------------------------------------------------------------------ */
/* Vector eligibility                                                  */
/* ------------------------------------------------------------------ */

export type VectorEligibility = {
  eligible: boolean;
  /** Layers that force raster output, with the reason. */
  ineligibleLayers: { layerId: Id; reason: string }[];
};

/**
 * A layer qualifies for genuine vector plate output when its mode produces
 * discrete marks (halftone dots or diffusion runs). A clean continuous-tone
 * layer has no vector representation: it allows raster plates but disables
 * SVG plates. Hidden raster is never smuggled into claimed vector output.
 *
 * MULTI-LAYER RULE: a stack of two or more contributing layers exports
 * vector plates only when EVERY layer is halftone mode (the marks of
 * non-overlapping halftone layers simply union; the knockout-overlap rule
 * is enforced separately in evaluate). Diffusion keeps its legacy vector
 * path as a single contributing layer only — run-length rects from two
 * stacked diffusion fields cannot encode knockout in paint-order-free
 * vector output.
 */
export function vectorPlateEligibility(core: ProjectCoreV1): VectorEligibility {
  const visible = core.layers.filter((layer) => layer.visible);
  const ineligibleLayers: { layerId: Id; reason: string }[] = [];
  for (const layer of visible) {
    if (layer.recipe.mode === "clean") {
      ineligibleLayers.push({
        layerId: layer.id,
        reason:
          "continuous-tone (clean) layers have no vector mark representation; " +
          "use a raster plate package or switch the layer to Halftone or Diffusion",
      });
    } else if (layer.recipe.mode === "diffusion" && visible.length > 1) {
      ineligibleLayers.push({
        layerId: layer.id,
        reason:
          "diffusion layers export vector plates only as a single layer; " +
          "use a raster plate package for mixed or multi-layer stacks",
      });
    }
  }
  return { eligible: ineligibleLayers.length === 0, ineligibleLayers };
}

/** Positive-area intersection test for two document-space bounds. */
function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/* ------------------------------------------------------------------ */
/* Evaluate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Environment capabilities preflight rules depend on. Defaults are feature-
 * detected from the current global scope; tests inject explicit values.
 */
export type PreflightCapabilities = {
  /** OffscreenCanvas exists — streamed halftone rasterization needs it. */
  offscreenCanvas?: boolean;
  /** File System Access streaming exists (Chrome/Edge large-file delivery). */
  fileSystemAccess?: boolean;
};

function detectCapabilities(): Required<PreflightCapabilities> {
  return {
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    fileSystemAccess:
      typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function",
  };
}

export type PreflightOptions = {
  /** Core revision the issues bind to (warnings require re-confirmation on change). */
  revision?: number;
  policy?: ResourcePolicy;
  capabilities?: PreflightCapabilities;
};

export function evaluate(
  core: ProjectCoreV1,
  assets: AssetInfo[],
  target: ExportTarget,
  options: PreflightOptions = {},
): PreflightIssue[] {
  const revision = options.revision ?? 0;
  const policy = options.policy ?? RESOURCE_POLICY;
  const capabilities = { ...detectCapabilities(), ...options.capabilities };
  const issues: PreflightIssue[] = [];
  const assetById = new Map(assets.map((asset) => [asset.sha256, asset]));

  const block = (
    code: PreflightBlockCode,
    message: string,
    subject?: { layerId?: Id; assetId?: Sha256 },
    discriminator = "",
  ) => {
    issues.push({
      id: `${code}@${subject?.layerId && subject.assetId ? `${subject.layerId}:${subject.assetId}` : subject?.layerId ?? subject?.assetId ?? discriminator}`,
      severity: "block",
      code,
      message,
      ...(subject ? { subject } : {}),
      revision,
    });
  };
  const warn = (
    code: PreflightWarnCode,
    message: string,
    subject?: { layerId?: Id; assetId?: Sha256 },
    discriminator = "",
  ) => {
    issues.push({
      id: `${code}@${subject?.layerId ?? subject?.assetId ?? discriminator}`,
      severity: "warn",
      code,
      message,
      ...(subject ? { subject } : {}),
      revision,
    });
  };

  /* Artboard ------------------------------------------------------- */

  const { widthPx, heightPx } = core.artboard;
  const artboardValid =
    Number.isSafeInteger(widthPx) && Number.isSafeInteger(heightPx) && widthPx > 0 && heightPx > 0;
  if (!artboardValid) {
    block("artboard-empty", "The artboard has zero area; there is nothing to export.");
  }
  const artboardPixels = artboardValid ? widthPx * heightPx : 0;
  if (artboardValid && artboardPixels > policy.maxArtboardPixels) {
    block(
      "artboard-pixels-exceeded",
      `The artboard is ${artboardPixels.toLocaleString("en-US")} pixels; the limit is ` +
        `${policy.maxArtboardPixels.toLocaleString("en-US")}. Reduce the artboard size.`,
    );
  }
  if (
    artboardValid &&
    (widthPx > policy.maxArtboardEdge || heightPx > policy.maxArtboardEdge)
  ) {
    block(
      "artboard-edge-exceeded",
      `The artboard's longest edge exceeds ${policy.maxArtboardEdge.toLocaleString("en-US")} pixels. ` +
        "Reduce the artboard width or height.",
    );
  }

  /* Selected layer ------------------------------------------------- */

  if (target.kind === "selected-layer") {
    const layer = core.layers.find(({ id }) => id === target.layerId);
    if (!layer) {
      block(
        "layer-not-found",
        "The selected layer no longer exists in this project.",
        { layerId: target.layerId },
      );
    } else if (!layer.visible) {
      warn(
        "selected-layer-hidden",
        `"${layer.name}" is hidden; the export will include it anyway.`,
        { layerId: layer.id },
      );
    }
  }

  /* Layers: assets and geometry ------------------------------------ */

  const layers = contributingLayers(core, target);
  const checkAsset = (assetId: Sha256, owner: string, layerId?: Id) => {
    const asset = assetById.get(assetId);
    const subject = { ...(layerId ? { layerId } : {}), assetId };
    if (!asset) {
      block("asset-missing", `${owner} references an asset that is missing from storage.`, subject);
      return;
    }
    if (asset.unsafeSvg) {
      block("svg-unsafe", `${owner} references an SVG that failed the safety sanitizer.`, subject);
      return;
    }
    if (!asset.ok) {
      block("asset-corrupt", `${owner} references an asset that could not be decoded.`, subject);
    }
  };

  for (const layer of layers) {
    checkAsset(layer.assetId, `Layer "${layer.name}"`, layer.id);
    if (layer.recipe.mode === "halftone" && layer.recipe.halftone.dotShape === "custom") {
      const shapeId = layer.recipe.halftone.customShapeAssetId;
      if (shapeId === null) {
        block(
          "asset-missing",
          `Layer "${layer.name}" uses a custom dot shape but no shape SVG is set.`,
          { layerId: layer.id },
        );
      } else {
        checkAsset(shapeId, `Layer "${layer.name}" custom dot shape`, layer.id);
      }
    }

    const transformReason = invalidTransformReason(layer.transform);
    if (transformReason) {
      block(
        "transform-invalid",
        `Layer "${layer.name}" cannot render: ${transformReason}.`,
        { layerId: layer.id },
      );
    }
    const quadReason = invalidQuadReason(layer.transform.perspective);
    if (quadReason) {
      block("quad-invalid", `Layer "${layer.name}" cannot render: ${quadReason}.`, {
        layerId: layer.id,
      });
    }
  }

  /* Printable content ---------------------------------------------- */

  if (target.kind !== "selected-layer" && layers.length === 0) {
    block(
      "no-printable-layers",
      core.layers.length === 0
        ? "The project has no layers; there is nothing to export."
        : "Every layer is hidden; there is nothing to export.",
    );
  }

  const plates = contributingPlates(core.separation);
  if (target.kind === "plate-package" && plates.length === 0) {
    block("no-visible-plates", "Every plate is hidden; a plate package needs at least one plate.");
  }

  /* Registration mark asset ---------------------------------------- */

  const registrationOn = resolveRegistration(target, core.output);
  if (registrationOn && core.registration.customShapeAssetId !== null) {
    checkAsset(core.registration.customShapeAssetId, "The registration mark");
  }

  /* Vector eligibility --------------------------------------------- */

  if (target.kind === "plate-package" && target.format === "svg") {
    const eligibility = vectorPlateEligibility(core);
    for (const { layerId, reason } of eligibility.ineligibleLayers) {
      const layer = core.layers.find(({ id }) => id === layerId);
      block(
        "vector-ineligible",
        `Layer "${layer?.name ?? layerId}" disables vector plates: ${reason}.`,
        { layerId },
      );
    }

    if (core.output.polarity === "negative") {
      block(
        "polarity-vector-unsupported",
        "Negative polarity has no genuine vector form (it would require boolean geometry " +
          "subtraction). Export raster plates, or switch output polarity to positive.",
      );
    }

    // KNOCKOUT RULE: multi-layer vector plates are only genuine when no
    // upper layer can knock out lower ink. Vector marks union in paint
    // order and cannot encode knockout, so any overlap between the
    // document-space bounds of two contributing layers disables SVG plates.
    if (layers.length > 1) {
      const layerBounds = layers.flatMap((layer) => {
        const asset = assetById.get(layer.assetId);
        if (!asset || !asset.ok) return []; // already blocked above
        const size = croppedSize(layer.crop, asset.width, asset.height);
        return [{ layer, bounds: transformedBounds(layer.transform, size) }];
      });
      outer: for (let first = 0; first < layerBounds.length; first += 1) {
        for (let second = first + 1; second < layerBounds.length; second += 1) {
          if (boundsOverlap(layerBounds[first].bounds, layerBounds[second].bounds)) {
            block(
              "vector-knockout-unsupported",
              `Layers "${layerBounds[first].layer.name}" and "${layerBounds[second].layer.name}" overlap; ` +
                "overlapping layers would need knockout, which vector plates cannot encode. " +
                "Export raster plates or separate the layers.",
              { layerId: layerBounds[second].layer.id },
            );
            break outer;
          }
        }
      }
    }

    if (artboardValid) {
      for (const plate of plates) {
        const points = layers
          .filter((layer) => layer.recipe.mode === "halftone")
          .reduce(
            (total, layer) =>
              total +
              estimateGridPoints(
                widthPx,
                heightPx,
                Math.max(0.01, layer.recipe.halftone.cellSize),
                core.separation.angles[plate],
              ),
            0,
          );
        if (points > MAX_EXPORT_GRID_POINTS) {
          block(
            "grid-points-exceeded",
            `The ${plate} plate needs about ${Math.round(points).toLocaleString("en-US")} vector ` +
              `marks; the limit is ${MAX_EXPORT_GRID_POINTS.toLocaleString("en-US")}. ` +
              "Increase cell size to export vector plates.",
            undefined,
            plate,
          );
          break;
        }
      }
    }
  }

  /* Resource estimates ---------------------------------------------- */

  if (artboardValid) {
    // Halftone grid gates (memory + traversal; see the halftone-grid cap
    // docs). The CANDIDATE gate applies to EVERY halftone target — vector
    // included (the walker scans the same lattice for SVG); the raster
    // POINT gate complements the stricter vector mark cap below.
    const svgTarget = target.kind === "plate-package" && target.format === "svg";
    outerGrid: for (const plate of plates.length > 0 ? plates : (["black"] as PlateId[])) {
      for (const layer of layers) {
        if (layer.recipe.mode !== "halftone") continue;
        const cell = Math.max(0.01, layer.recipe.halftone.cellSize);
        if (!svgTarget) {
          const points = estimateGridPoints(widthPx, heightPx, cell, core.separation.angles[plate]);
          if (points > MAX_RASTER_GRID_POINTS) {
            block(
              "grid-points-exceeded",
              `Layer "${layer.name}" needs about ${Math.round(points).toLocaleString("en-US")} halftone ` +
                `dots on the ${plate} plate; the limit is ${MAX_RASTER_GRID_POINTS.toLocaleString("en-US")}. ` +
                "Increase cell size.",
              { layerId: layer.id },
            );
            break outerGrid;
          }
        }
        const candidates = estimateGridCandidates(widthPx, heightPx, cell);
        if (candidates > MAX_GRID_CANDIDATES) {
          block(
            "grid-points-exceeded",
            `Layer "${layer.name}" would scan about ${Math.round(candidates).toLocaleString("en-US")} ` +
              `screen-lattice candidates per plate; the limit is ` +
              `${MAX_GRID_CANDIDATES.toLocaleString("en-US")}. Increase cell size.`,
            { layerId: layer.id },
          );
          break outerGrid;
        }
      }
    }

    const diffusionLayerCount = layers.filter((layer) => layer.recipe.mode === "diffusion").length;
    if (diffusionLayerCount > 0 && target.kind !== "selected-layer") {
      const diffusionPixels = artboardPixels * Math.max(1, plates.length) * diffusionLayerCount;
      if (diffusionPixels > MAX_DIFFUSION_RASTER_PIXELS) {
        block(
          "diffusion-raster-exceeded",
          `Estimated diffusion work is ${diffusionPixels.toLocaleString("en-US")} plate-pixels; ` +
            `the limit is ${MAX_DIFFUSION_RASTER_PIXELS.toLocaleString("en-US")}. ` +
            "Reduce the artboard size or enable fewer plates.",
        );
      }
    } else if (target.kind === "selected-layer" && diffusionLayerCount > 0) {
      if (artboardPixels > MAX_DIFFUSION_RASTER_PIXELS) {
        block(
          "diffusion-raster-exceeded",
          "Estimated diffusion work exceeds the plate-pixel limit. Reduce the artboard size.",
        );
      }
    }

    // EXECUTED-PLAN admission (wave G2 honesty): model exactly the plan(s)
    // the render service computes for THIS target — the SAME settings-aware
    // planLayerModels the service plans with, real record-backed source
    // dimensions, and the app-side output model — so admit/reject can never
    // diverge from execution (worker-render-service plan call sites).
    const models = planLayerModels(core, layers, (layerAssetId) => {
      const asset = assetById.get(layerAssetId);
      return asset && asset.ok && asset.kind === "raster"
        ? { width: asset.width, height: asset.height, byteLength: asset.byteLength }
        : null;
    });
    const planWith = (plateCount: number, wantsProof: boolean, output: PlanOutputModel) =>
      planRender(
        {
          sampleWidth: widthPx,
          sampleHeight: heightPx,
          outputWidth: widthPx,
          outputHeight: heightPx,
          plateCount: Math.max(1, plateCount),
          layerCount: Math.max(1, layers.length),
          wantsProof,
          layers: models,
          output,
        },
        policy.maxRenderPeakBytes,
      );

    const deliveredBytes = estimateDeliveredBytes(core, target);
    const bufferedDeliveryCap =
      target.kind === "plate-package"
        ? Math.min(policy.maxBlobDownloadBytes, MAX_BUFFERED_PLATE_PACKAGE_BYTES)
        : policy.maxBlobDownloadBytes;
    const overCap = deliveredBytes > bufferedDeliveryCap;
    const streamedDelivery =
      overCap &&
      capabilities.fileSystemAccess &&
      target.kind === "plate-package";
    const streamedRasterPackage =
      streamedDelivery && target.kind === "plate-package" && target.format === "png";
    const legacyCanvasDelivery = streamedRasterPackage && legacyEngineEligible(core, (id) => assetById.get(id) ?? null);

    let chosen: RenderPlan;
    let admitted: boolean;
    if (target.kind === "plate-package") {
      if (target.format === "svg") {
        // The SVG renderer executes one forced single-shot layer-data job
        // per layer, then formats that layer's marks. It never runs the
        // streamed raster executor and never needs OffscreenCanvas.
        const svgPlans =
          models.length > 0
            ? models.map((layer) =>
                planRender(
                  {
                    sampleWidth: widthPx,
                    sampleHeight: heightPx,
                    outputWidth: widthPx,
                    outputHeight: heightPx,
                    plateCount: 1,
                    layerCount: 1,
                    wantsProof: false,
                    layers: [layer],
                  },
                  policy.maxRenderPeakBytes,
                ),
              )
            : [planWith(1, false, { kind: "plate" })];
        const worst = svgPlans.reduce((current, candidate) =>
          candidate.singleShotPeakBytes > current.singleShotPeakBytes ? candidate : current,
        );
        chosen = {
          ...worst,
          form: "single-shot",
          estimatedPeakBytes: worst.singleShotPeakBytes,
          workerPeakBytes: worst.singleShotPeakBytes,
          appPeakBytes: 0,
          withinBudget: worst.singleShotPeakBytes <= worst.budgetBytes,
        };
        admitted = chosen.withinBudget;
      } else if (legacyCanvasDelivery) {
        const source = assetById.get(layers[0].assetId)!;
        const peak = legacyCanvasPeakBytes(core, source);
        const plan = planWith(1, false, { kind: "plate", streamedSink: true });
        admitted = peak <= policy.maxRenderPeakBytes;
        chosen = { ...plan, form: "single-shot", estimatedPeakBytes: peak, withinBudget: admitted };
      } else if (streamedRasterPackage) {
        // ADMIT-SHAPE === EXECUTE-SHAPE: streamPlates runs ONE streamed
        // session over every plate with the bounded sink share, and gates
        // on the streamed estimate — mirror both here.
        const plan = planWith(plates.length, false, { kind: "plate", streamedSink: true });
        admitted = plan.streamable && plan.streamedPeakBytes <= plan.budgetBytes;
        chosen = {
          ...plan,
          form: "streamed",
          estimatedPeakBytes: plan.streamedPeakBytes,
          withinBudget: admitted,
        };
      } else {
        // Buffered PNG packages render one plate at a time while retaining
        // prior encoded entries for final packaging.
        const encodedPlateBytes = estimateRasterEntryDeliveredBytes(
          artboardPixels * ARCHIVE_BYTES_PER_PIXEL,
          heightPx,
        );
        const plan = planWith(1, false, {
          kind: "plate",
          retainedEncodes: Math.max(0, plates.length - 1),
          encodeBytesPerPixel: encodedPlateBytes / Math.max(1, artboardPixels),
        });
        const pngRewritePeakBytes = plan.estimatedPeakBytes + 3 * encodedPlateBytes;
        admitted = plan.withinBudget && pngRewritePeakBytes <= plan.budgetBytes;
        chosen = {
          ...plan,
          estimatedPeakBytes: Math.max(plan.estimatedPeakBytes, pngRewritePeakBytes),
          withinBudget: admitted,
        };
      }
    } else {
      // Composite/selected-layer: the service admits when EITHER the
      // opaque-proof form (white matte + OffscreenCanvas) or the collector
      // form fits (renderCompositeOf's proofPlan/collector pair).
      const opaqueWhite = resolveMatte(target, core.artboard) === "#ffffff";
      const collector = planWith(plates.length, false, { kind: "composite", whiteMatte: false });
      const proofPlan =
        opaqueWhite && capabilities.offscreenCanvas
          ? planWith(plates.length, true, { kind: "composite", whiteMatte: true })
          : null;
      const proofAdmitted = proofPlan !== null && proofPlan.withinBudget;
      chosen = proofAdmitted && proofPlan ? proofPlan : collector;
      admitted = proofAdmitted || collector.withinBudget;
    }
    if (target.kind === "plate-package" && target.format === "svg") {
      const registrationBytes =
        registrationOn && core.registration.customShapeAssetId !== null
          ? SVG_CUSTOM_REGISTRATION_ALLOWANCE_BYTES
          : 0;
      let assemblyPeakBytes: number;
      if (streamedDelivery) {
        assemblyPeakBytes = 0;
        for (const plate of plates) {
          const entryBytes =
            estimateSvgPlateBytes(core, layers, plate) +
            SVG_ENTRY_OVERHEAD_BYTES +
            registrationBytes;
          assemblyPeakBytes = Math.max(
            assemblyPeakBytes,
            estimateSvgAssemblyPeakBytes(
              entryBytes,
              estimateSvgPlateFragments(core, layers, plate),
            ),
          );
        }
      } else {
        const fragments = plates.reduce(
          (total, plate) =>
            total + estimateSvgPlateFragments(core, layers, plate),
          0,
        );
        assemblyPeakBytes = estimateSvgAssemblyPeakBytes(deliveredBytes, fragments);
      }
      const combinedPeakBytes = chosen.estimatedPeakBytes + assemblyPeakBytes;
      if (combinedPeakBytes > policy.maxRenderPeakBytes) {
        admitted = false;
        chosen = { ...chosen, estimatedPeakBytes: combinedPeakBytes };
      }
    }
    if (
      target.kind === "plate-package" &&
      !streamedDelivery
    ) {
      // Buffered ZIP peak after all renders: original entries + converted
      // inputs + pre-sized writer/output + final Blob snapshot, with a fixed
      // container allowance. This phase is not concurrent with rendering.
      const bufferedZipPeakBytes = deliveredBytes * 5 + SVG_ASSEMBLY_FIXED_BYTES;
      if (bufferedZipPeakBytes > policy.maxRenderPeakBytes) {
        admitted = false;
        chosen = {
          ...chosen,
          estimatedPeakBytes: Math.max(chosen.estimatedPeakBytes, bufferedZipPeakBytes),
        };
      }
    }
    if (registrationOn && core.registration.customShapeAssetId !== null && target.format !== "svg") {
      const peak = chosen.estimatedPeakBytes + customRegistrationPeakBytes(core.artboard.widthPx);
      chosen = { ...chosen, estimatedPeakBytes: peak, withinBudget: peak <= policy.maxRenderPeakBytes };
      admitted = admitted && chosen.withinBudget;
    }
    if (!admitted) {
      block(
        "render-peak-exceeded",
        `Rendering would need about ${Math.round(chosen.estimatedPeakBytes / (1024 * 1024))} MiB ` +
          `of working memory even in the streamed form; the budget is ` +
          `${Math.round(policy.maxRenderPeakBytes / (1024 * 1024))} MiB. Reduce the artboard size.`,
      );
    } else if (
      !legacyCanvasDelivery && (chosen.form === "streamed" || streamedRasterPackage) &&
      !capabilities.offscreenCanvas &&
      layers.some((layer) => layer.recipe.mode === "halftone")
    ) {
      block(
        "streaming-unsupported",
        "This export needs the streamed render form, and streamed halftone rasterization " +
          "(including custom dot stamps) requires OffscreenCanvas, which this browser lacks. " +
          "Reduce the artboard size or export from Chrome or Edge.",
      );
    }

    // DELIVERY FEASIBILITY for EVERY target family (wave G2): outputs above
    // the Blob cap need a genuinely streamable form AND File System Access;
    // otherwise the export hard-blocks HERE — before the picker opens and
    // before any render or allocation. Sizes follow the conservative
    // raw-byte planning contract (estimateDeliveredBytes): compressed
    // formats may have fit, but delivery is planned on the bound, never on
    // hope.
    if (overCap) {
      const mib = Math.round(deliveredBytes / (1024 * 1024));
      if (!targetSupportsStreaming(target)) {
        block(
          "delivery-exceeded",
          `The finished JPEG is estimated at ${mib} MiB — larger than the in-memory download ` +
            "limit, and JPEG has no streamed form. Export PNG or TIFF, or reduce the artboard size.",
        );
      } else if (!capabilities.fileSystemAccess) {
        block(
          "delivery-exceeded",
          `This export is estimated at ${mib} MiB — larger than the safe in-memory delivery limit, ` +
            "and this browser cannot stream exports to disk. Use Chrome or Edge, or reduce " +
            "the artboard size.",
        );
      }
    }

    // PER-ENTRY SVG residency cap — independent of the delivery size: one
    // plate's whole SVG text is resident while it is assembled and packaged,
    // so the honesty bound applies to every vector package. Buffered packages
    // additionally use the lower package-total delivery cap above.
    if (target.kind === "plate-package" && target.format === "svg") {
      const entryBytes = estimateSvgPlateEntryBytes(core, layers, plates);
      const registrationBytes =
        registrationOn && core.registration.customShapeAssetId !== null
          ? SVG_CUSTOM_REGISTRATION_ALLOWANCE_BYTES
          : 0;
      const boundedEntryBytes = entryBytes + registrationBytes;
      if (boundedEntryBytes > MAX_STREAMED_SVG_PLATE_BYTES) {
        block(
          "svg-entry-bytes-exceeded",
          `A single vector plate is estimated at ${Math.round(boundedEntryBytes / (1024 * 1024))} MiB ` +
            `of SVG text; packages hold one plate's text at a time and cap it at ` +
            `${Math.round(MAX_STREAMED_SVG_PLATE_BYTES / (1024 * 1024))} MiB. ` +
            "Increase cell size or export raster plates.",
        );
      }
    }

    if (target.kind === "plate-package") {
      const entries = plates.length + 1; // plates + job manifest
      if (entries > policy.maxArchiveEntries) {
        block(
          "archive-entries-exceeded",
          `The plate package would contain ${entries} entries; the limit is ` +
            `${policy.maxArchiveEntries}.`,
        );
      }
      const uncompressed = plates.length * artboardPixels * ARCHIVE_BYTES_PER_PIXEL;
      if (uncompressed > policy.maxArchiveUncompressedBytes) {
        block(
          "archive-bytes-exceeded",
          `The plate package would hold about ${Math.round(uncompressed / (1024 * 1024))} MiB ` +
            "of plate data, beyond the archive limit. Reduce the artboard size or plate count.",
        );
      }
    }
  }

  /* Warnings --------------------------------------------------------- */

  addWarnings(core, target, plates, registrationOn, warn);

  return issues;
}

function addWarnings(
  core: ProjectCoreV1,
  target: ExportTarget,
  plates: PlateId[],
  registrationOn: boolean,
  warn: (
    code: PreflightWarnCode,
    message: string,
    subject?: { layerId?: Id; assetId?: Sha256 },
    discriminator?: string,
  ) => void,
): void {
  // Screen angles: unconventional or colliding angles risk moiré on press.
  const seenAngles = new Map<number, PlateId>();
  for (const plate of plates) {
    const angle = core.separation.angles[plate];
    if (angle !== CONVENTIONAL_ANGLES[plate]) {
      warn(
        "angle-unusual",
        `The ${plate} screen is at ${angle}° (conventional is ${CONVENTIONAL_ANGLES[plate]}°). ` +
          "Unusual angles can produce visible moiré on press.",
        undefined,
        plate,
      );
    }
    const normalized = ((angle % 90) + 90) % 90;
    const collidingPlate = seenAngles.get(normalized);
    if (collidingPlate !== undefined) {
      warn(
        "angle-duplicate",
        `The ${collidingPlate} and ${plate} screens share the ${normalized}° lattice; ` +
          "overlapping screens at one angle print as a single muddy screen.",
        undefined,
        `${collidingPlate}+${plate}`,
      );
    } else {
      seenAngles.set(normalized, plate);
    }
  }

  if (core.output.polarity === "negative") {
    warn(
      "polarity-negative",
      "Output polarity is negative: ink and open area are inverted at output. " +
        "Confirm your film or plate process expects a negative.",
    );
  }

  if (target.kind !== "selected-layer") {
    for (const layer of core.layers) {
      if (!layer.visible) {
        warn(
          "layer-hidden-excluded",
          `Hidden layer "${layer.name}" is excluded from this export.`,
          { layerId: layer.id },
        );
      }
    }
  }

  if (target.kind === "plate-package") {
    const allPlates: PlateId[] =
      core.separation.mode === "grayscale" ? ["black"] : ["cyan", "magenta", "yellow", "black"];
    for (const plate of allPlates) {
      if (!core.separation.visible[plate]) {
        warn(
          "plate-hidden-excluded",
          `The ${plate} plate is hidden and will be omitted from the package.`,
          undefined,
          plate,
        );
      }
    }
    if (!registrationOn) {
      warn(
        "registration-off-plates",
        "Registration marks are off for this plate package. Plates without registration " +
          "cannot be aligned on press.",
      );
    }
  } else if (registrationOn) {
    warn(
      "registration-on-composite",
      "Registration marks are on for this proof export; they will print in the artwork.",
    );
  }

  // Press readiness: artboard smaller than its named preset, or smaller than
  // the smallest supported sheet for custom sizes.
  const preset = SHEET_SIZES.find(({ id }) => id === core.artboard.presetId);
  if (preset) {
    const presetWidth = Math.round(preset.widthInches * DOCUMENT_DPI);
    const presetHeight = Math.round(preset.heightInches * DOCUMENT_DPI);
    const matchesPreset =
      (core.artboard.widthPx === presetWidth && core.artboard.heightPx === presetHeight) ||
      (core.artboard.widthPx === presetHeight && core.artboard.heightPx === presetWidth);
    if (
      !matchesPreset &&
      core.artboard.widthPx * core.artboard.heightPx < presetWidth * presetHeight
    ) {
      warn(
        "artboard-below-preset",
        `The artboard is smaller than the ${preset.label} preset it names; ` +
          "the printed sheet will not fill the expected size.",
      );
    }
  }

  const visibleLayers = target.kind === "selected-layer"
    ? core.layers.filter(({ id }) => id === target.layerId)
    : core.layers.filter((layer) => layer.visible);
  for (const layer of visibleLayers) {
    if (layer.opacity < 1) {
      warn(
        "opacity-below-one",
        `Layer "${layer.name}" prints at ${Math.round(layer.opacity * 100)}% opacity. ` +
          "Partial opacity halftones as lighter coverage; confirm this is intended for press.",
        { layerId: layer.id },
      );
    }
  }
}
