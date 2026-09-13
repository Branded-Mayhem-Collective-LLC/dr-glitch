/**
 * Studio export flow — the app-layer binding between the workspace UI and
 * the REAL export subsystem. Every UI export (topbar Export ➝ Preflight/
 * Export panel) runs through here:
 *
 *   ProjectCoreV1 + referenced assets
 *     → evaluate() preflight with EXPLICIT probed capabilities
 *     → warning acknowledgement (revision-bound, createWarningGate)
 *     → startExport() on the orchestrator over createRoutedRenderService
 *       (the tested legacyEngineEligible predicate is the ONLY parity gate;
 *        the UI never special-cases the legacy engine)
 *     → whole-or-nothing delivery (Blob downloads under the applicable
 *       cap; plate packages use a stricter 32 MiB in-memory ceiling).
 *
 * Extras owned here:
 * - withRenderStepDelay: the dev-build progress/cancel test seam
 *   (localStorage drglitch.debug.export-tile-delay-ms; production builds
 *   never install it).
 * - withCustomRegistration: main-thread custom registration marks for the
 *   worker renderer. The WorkerRenderService itself refuses custom
 *   registration shapes (workers cannot rasterize SVG); this wrapper
 *   provides the stamp source instead of editing the service — it renders
 *   with registration off and paints/injects the marks as the engine's
 *   final pass, using the exact legacy geometry.
 *
 * React-free and DOM-free: fully unit-testable with fake services.
 */

import type {
  ProjectCoreV1,
  RegistrationV1,
  Sha256,
  PreflightIssue,
} from "../core/types";
import { RESOURCE_POLICY, type ResourcePolicy } from "../core/resource-policy";
/* Direct module imports (not the export index) keep node unit tests from
 * pulling browser-only encoder modules. */
import {
  estimateDeliveredBytes,
  evaluate,
  targetSupportsStreaming,
  type AssetInfo,
} from "../export/preflight";
import {
  startExport,
  startStreamingExport,
  totalExportBytes,
  ExportCancelledError,
  ExportError,
  type DeliveryOptions,
  type ExportEncoders,
  type ExportFile,
  type ExportJobOptions,
  type ExportProgress,
  type ExportStreamSink,
  type RasterData,
  type RenderRequestOptions,
  type RenderService,
  type StreamingExportJob,
} from "../export/orchestrator";
import {
  MAX_BUFFERED_PLATE_PACKAGE_BYTES,
  resolveRegistration,
  targetFileName,
  type ExportTarget,
} from "../export/targets";
import {
  preflightCapabilitiesFrom,
  type EnvironmentCapabilities,
} from "./capabilities";
import { captureHandledError, stableErrorCode, startAppSpan } from "../telemetry/sentry";

/* ------------------------------------------------------------------ */
/* Referenced assets → AssetInfo                                       */
/* ------------------------------------------------------------------ */

/** Every content-addressed asset a core references (layers, dots, marks). */
export function collectReferencedAssetIds(core: ProjectCoreV1): Sha256[] {
  const ids = new Set<Sha256>();
  for (const layer of core.layers) {
    ids.add(layer.assetId);
    const shapeId = layer.recipe.halftone.customShapeAssetId;
    if (shapeId !== null) ids.add(shapeId);
  }
  if (core.registration.customShapeAssetId !== null) {
    ids.add(core.registration.customShapeAssetId);
  }
  return [...ids];
}

export type AssetInfoLookup = (assetId: Sha256) => AssetInfo | null;

/**
 * The slice of AssetRepository the flow needs (kept structural for tests).
 * getRecord performs the repository's structural validation (record shape,
 * key match, blob present with byteLength agreeing with the record) and
 * THROWS on a damaged row; getBlob with verifyHash re-hashes the bytes so
 * same-key/same-length poisoned blobs cannot pass.
 */
export type AssetRecordSource = {
  getRecord(
    sha256: Sha256,
    kind: "raster" | "svg",
  ): Promise<
    | { kind: string; mime?: string; byteLength: number; width: number; height: number }
    | undefined
  >;
  getBlob?(
    sha256: Sha256,
    kind: "raster" | "svg",
    options?: { verifyHash?: boolean },
  ): Promise<Blob>;
};

export type LoadAssetInfoOptions = {
  /**
   * Re-hash blob bytes (getBlob verifyHash) and, for svg-kind records,
   * require the stored markup to be a strict-sanitizer canonical fixed
   * point for SOME shape role. Callers should memoize per assetId — the
   * hash walk reads whole blobs.
   */
  verify?: boolean;
};

/** True when `svg` is byte-identical to its own strict sanitation for a role. */
async function isCanonicalShapeSvg(svg: string): Promise<boolean> {
  const { sanitizeSvg } = await import("../io/svg-sanitizer");
  for (const profile of ["custom-dot", "registration-mark", "artwork"] as const) {
    try {
      if (sanitizeSvg(svg, profile).svg === svg) return true;
    } catch {
      /* try the next role */
    }
  }
  return false;
}

const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Resolve AssetInfo for every referenced asset from the repository records
 * (raster first, then svg — custom shapes are stored under the svg kind).
 *
 * Typed statuses (consumed by evaluate() as hard blocks BEFORE any render):
 * - absent from the map            → asset-missing
 * - ok: false                      → asset-corrupt (structural damage,
 *   byteLength/hash mismatch, wrong MIME for the kind, bad dimensions)
 * - unsafeSvg: true                → svg-unsafe (stored SVG is not the
 *   sanitizer's canonical fixed point — tampered or legacy bytes)
 * Corruption never resolves optimistically: a thrown validation error
 * becomes ok:false, not a missing entry.
 */
export async function loadAssetInfos(
  core: ProjectCoreV1,
  source: AssetRecordSource,
  options: LoadAssetInfoOptions = {},
): Promise<Map<Sha256, AssetInfo>> {
  const infos = new Map<Sha256, AssetInfo>();
  await Promise.all(
    collectReferencedAssetIds(core).map(async (id) => {
      let record: Awaited<ReturnType<AssetRecordSource["getRecord"]>>;
      let kind: "raster" | "svg" = "raster";
      let corrupt = false;
      try {
        record = await source.getRecord(id, "raster");
        if (record) kind = record.kind === "svg" ? "svg" : "raster";
        if (!record) {
          record = await source.getRecord(id, "svg");
          if (record) kind = record.kind === "svg" ? "svg" : "raster";
        }
      } catch {
        corrupt = true;
      }
      if (!record && !corrupt) return; // genuinely missing
      const width = record?.width ?? 0;
      const height = record?.height ?? 0;
      const byteLength = record?.byteLength ?? 0;
      let ok = !corrupt;
      let unsafeSvg = false;
      if (ok && record) {
        // MIME must agree with the stored kind (metadata is untrusted).
        const mime = record.mime?.toLowerCase();
        if (mime !== undefined) {
          if (kind === "svg" && mime !== "image/svg+xml") ok = false;
          if (kind === "raster" && !RASTER_MIMES.has(mime)) ok = false;
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          ok = false;
        }
      }
      if (ok && options.verify && source.getBlob) {
        try {
          const blob = await source.getBlob(id, kind, { verifyHash: true });
          if (kind === "svg") {
            unsafeSvg = !(await isCanonicalShapeSvg(await blob.text()));
          }
        } catch {
          ok = false;
        }
      }
      infos.set(id, {
        sha256: id,
        kind,
        ok,
        ...(unsafeSvg ? { unsafeSvg } : {}),
        width,
        height,
        byteLength,
      });
    }),
  );
  return infos;
}

/**
 * Preflight for one target with EXPLICIT environment capabilities from the
 * probe (src/app/capabilities). Missing lookups are simply absent from the
 * asset list, which evaluate() reports as hard asset-missing blocks.
 */
export function preflightForTarget(
  core: ProjectCoreV1,
  lookup: AssetInfoLookup,
  target: ExportTarget,
  revision: number,
  env: EnvironmentCapabilities,
  policy: ResourcePolicy = RESOURCE_POLICY,
): PreflightIssue[] {
  const assets: AssetInfo[] = [];
  for (const id of collectReferencedAssetIds(core)) {
    const info = lookup(id);
    if (info) assets.push(info);
  }
  return evaluate(core, assets, target, {
    revision,
    policy,
    capabilities: preflightCapabilitiesFrom(env),
  });
}

/* ------------------------------------------------------------------ */
/* Revision-bound warning acknowledgement                              */
/* ------------------------------------------------------------------ */

export type WarningGate = {
  /** Warn issues that still need explicit confirmation (empty = go). */
  unconfirmed(issues: PreflightIssue[]): PreflightIssue[];
  /** Record the user's "Export Anyway" for exactly these issues. */
  confirm(issues: PreflightIssue[]): void;
};

function warningFingerprint(issues: PreflightIssue[]): string {
  return issues
    .filter((issue) => issue.severity === "warn")
    .map((issue) => `${issue.id}@r${issue.revision}`)
    .sort()
    .join("|");
}

/**
 * Confirmation binds to the exact warn set AND the core revision the
 * issues were computed against: any further edit (new revision) or any
 * change in the warning set demands re-confirmation.
 */
export function createWarningGate(): WarningGate {
  let confirmed: string | null = null;
  return {
    unconfirmed(issues) {
      const warns = issues.filter((issue) => issue.severity === "warn");
      if (warns.length === 0) return [];
      return warningFingerprint(issues) === confirmed ? [] : warns;
    },
    confirm(issues) {
      confirmed = warningFingerprint(issues);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Render service wrappers                                             */
/* ------------------------------------------------------------------ */

/**
 * Dev-only test seam: delay every render step by `delayMs()` so export
 * progress and cancellation are deterministically observable from
 * Playwright. Install ONLY in dev builds; with delayMs() <= 0 the wrapper
 * is pass-through.
 */
export function withRenderStepDelay(
  service: RenderService,
  delayMs: () => number,
): RenderService {
  async function pause(signal: AbortSignal): Promise<void> {
    const delay = delayMs();
    if (!(delay > 0)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      function done() {
        signal.removeEventListener("abort", done);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
  const delayed: RenderService = {
    streamRegistration: service.streamRegistration?.bind(service),
    async renderComposite(core, options) {
      await pause(options.signal);
      return service.renderComposite(core, options);
    },
    async renderPlate(core, plate, options) {
      await pause(options.signal);
      return service.renderPlate(core, plate, options);
    },
    async renderPlateSvg(core, plate, options) {
      await pause(options.signal);
      return service.renderPlateSvg(core, plate, options);
    },
    async renderLayer(core, layerId, options) {
      await pause(options.signal);
      return service.renderLayer(core, layerId, options);
    },
  };
  if (service.streamPlates) {
    const streamPlates = service.streamPlates.bind(service);
    // Streamed delivery: the dev delay applies PER BAND so Playwright can
    // observe mid-stream progress and cancel deterministically. pause()
    // races the abort signal — a cancelled export never sits out a delay.
    delayed.streamPlates = async (core, plates, options, delivery) => {
      await pause(options.signal);
      return streamPlates(core, plates, options, {
        beginPlate: (plate, signal) => delivery.beginPlate(plate, signal),
        writeBand: async (plate, rowStart, rowCount, rows, signal) => {
          await pause(options.signal);
          return delivery.writeBand(plate, rowStart, rowCount, rows, signal);
        },
        endPlate: (plate, signal) => delivery.endPlate(plate, signal),
      });
    };
  }
  return delayed;
}

/** Legacy registration mark geometry (drawRegistration parity). */
export function registrationLayout(
  registration: RegistrationV1,
  width: number,
  height: number,
): { points: [number, number][]; size: number; offset: number; weight: number } {
  const size = registration.size ?? Math.max(7, Math.round(Math.min(width, height) * 0.014));
  const offset = registration.offset ?? Math.max(14, Math.round(Math.min(width, height) * 0.035));
  const weight = Math.max(0.5, registration.weight);
  const points: [number, number][] =
    registration.mode === "centered"
      ? [
          [width / 2, offset],
          [width / 2, height - offset],
        ]
      : [
          [offset, offset],
          [width - offset, offset],
          [offset, height - offset],
          [width - offset, height - offset],
        ];
  return { points, size, offset, weight };
}

/** Main-thread painting hooks for custom registration shapes. */
export type CustomRegistrationPainter = {
  prepareRows: NonNullable<ExportJobOptions["prepareCustomRegistration"]>;
  /** Paint the custom marks into the finished raster IN PLACE. */
  paintRaster(raster: RasterData, registration: RegistrationV1): Promise<void>;
  /** SVG fragment (symbol + uses) appended as the final SVG group. */
  svgFragment(
    registration: RegistrationV1,
    width: number,
    height: number,
  ): Promise<string>;
};

/**
 * Custom registration marks for the worker renderer: when the document
 * carries a custom registration shape and the target wants registration,
 * the inner service renders WITHOUT registration and this wrapper paints
 * the marks afterwards (registration is the engine's final pass), using a
 * main-thread prepared stamp. Built-in marks pass through untouched.
 */
export function withCustomRegistration(
  service: RenderService,
  painter: CustomRegistrationPainter,
): RenderService {
  const isCustom = (core: ProjectCoreV1, options: RenderRequestOptions) =>
    options.registration && core.registration.customShapeAssetId !== null;

  async function raster(
    core: ProjectCoreV1,
    options: RenderRequestOptions,
    render: (options: RenderRequestOptions) => Promise<RasterData>,
  ): Promise<RasterData> {
    if (!isCustom(core, options)) return render(options);
    const result = await render({ ...options, registration: false });
    await painter.paintRaster(result, core.registration);
    return result;
  }

  const wrapped: RenderService = {
    streamRegistration: service.streamRegistration?.bind(service),
    renderComposite: (core, options) =>
      raster(core, options, (patched) => service.renderComposite(core, patched)),
    renderPlate: (core, plate, options) =>
      raster(core, options, (patched) => service.renderPlate(core, plate, patched)),
    renderLayer: (core, layerId, options) =>
      raster(core, options, (patched) => service.renderLayer(core, layerId, patched)),
    async renderPlateSvg(core, plate, options) {
      if (!isCustom(core, options)) return service.renderPlateSvg(core, plate, options);
      const svg = await service.renderPlateSvg(core, plate, {
        ...options,
        registration: false,
      });
      const fragment = await painter.svgFragment(
        core.registration,
        core.artboard.widthPx,
        core.artboard.heightPx,
      );
      return svg.replace(/<\/svg>\s*$/, `${fragment}</svg>`);
    },
  };
  if (service.streamPlates) {
    // The orchestrator paints registration after polarity, using its owned
    // band painter. The renderer receives registration:false in this path.
    const streamPlates = service.streamPlates.bind(service);
    wrapped.streamPlates = (core, plates, options, delivery) =>
      streamPlates(core, plates, options, delivery);
  }
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* Export suspension registry (audit residual 1)                       */
/* ------------------------------------------------------------------ */

/**
 * Decode-cache co-residency control: caches that hold decoded rasters
 * (PreviewService, AssetCache) register here; every export suspends them
 * for its duration — caches evict immediately and refill lazily after —
 * so an export's working set never sits beside ~hundreds of MiB of decode
 * caches. Registration is done by the studio shell (wiring hunk); the
 * registry lives HERE so the flow needs no component plumbing.
 */
export type ExportSuspendable = {
  suspendForExport(): void;
  resumeAfterExport(): void;
};

const exportSuspendables = new Set<ExportSuspendable>();
/** Active export-suspension depth; registrants arriving while >0 are
 *  suspended AT BIRTH so a cache created mid-export is never unsuspended. */
let exportSuspensionDepth = 0;

export function registerExportSuspendable(suspendable: ExportSuspendable): () => void {
  exportSuspendables.add(suspendable);
  if (exportSuspensionDepth > 0) {
    try {
      suspendable.suspendForExport();
    } catch {
      /* a broken cache must not block the export */
    }
  }
  return () => void exportSuspendables.delete(suspendable);
}

/** Test/diagnostic seam. */
export function exportSuspensionActive(): boolean {
  return exportSuspensionDepth > 0;
}

/**
 * Suspend every registered cache; returns an idempotent resume.
 *
 * EDGE-TRIGGERED: registrants are suspended only on the global 0→1
 * transition and resumed only on the final 1→0 edge; a late registrant at
 * depth>0 gets exactly ONE suspend at birth and wakes at that same final
 * edge — so overlapping export cycles can never resume a cache early.
 */
function suspendCachesForExport(): () => void {
  exportSuspensionDepth += 1;
  if (exportSuspensionDepth === 1) {
    for (const suspendable of [...exportSuspendables]) {
      try {
        suspendable.suspendForExport();
      } catch {
        /* a broken cache must not block the export */
      }
    }
  }
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    exportSuspensionDepth = Math.max(0, exportSuspensionDepth - 1);
    if (exportSuspensionDepth > 0) return;
    for (const suspendable of [...exportSuspendables]) {
      try {
        suspendable.resumeAfterExport();
      } catch {
        /* resume is best-effort; caches refill lazily anyway */
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Delivery planning (wave G2)                                         */
/* ------------------------------------------------------------------ */

export type ExportDeliveryPlan = {
  /** Conservative planning-contract estimate (estimateDeliveredBytes). */
  estimatedBytes: number;
  /** "buffered": whole-Blob path, byte-identical to the legacy pipeline.
   *  "stream": gesture-scoped picker + true streaming delivery. */
  mode: "buffered" | "stream";
};

/** ONE decision point for buffered-vs-streamed delivery. */
export function planExportDelivery(
  core: ProjectCoreV1,
  target: ExportTarget,
  options: { maxBlobBytes?: number } = {},
): ExportDeliveryPlan {
  const estimatedBytes = estimateDeliveredBytes(core, target);
  const genericCap = options.maxBlobBytes ?? RESOURCE_POLICY.maxBlobDownloadBytes;
  const cap =
    target.kind === "plate-package"
      ? Math.min(genericCap, MAX_BUFFERED_PLATE_PACKAGE_BYTES)
      : genericCap;
  return { estimatedBytes, mode: estimatedBytes > cap ? "stream" : "buffered" };
}

/** Dev-build seam: lower the streaming threshold so Playwright exercises
 *  the REAL streamed path on small fixtures. Production builds never read
 *  the key. */
export const EXPORT_STREAM_THRESHOLD_STORAGE_KEY = "drglitch.debug.export-stream-threshold-bytes";

export function readDevStreamThreshold(): number | null {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      EXPORT_STREAM_THRESHOLD_STORAGE_KEY,
    );
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* File System Access seam                                             */
/* ------------------------------------------------------------------ */

/**
 * Writable slice of FileSystemFileHandle the streamed path needs.
 *
 * TRANSACTIONAL-ABORT SEMANTICS: createWritable writes into a temp/swap
 * file and atomically replaces the target only on close(); writable.abort()
 * discards the temp bytes and PRESERVES any pre-existing file contents.
 * The flow therefore NEVER removes the picked file — the user may have
 * selected an existing file, and deletion would destroy their data.
 */
export type SaveFileHandle = {
  createWritable(): Promise<{
    write(data: Uint8Array | Blob): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
  }>;
};

/**
 * The gesture-scoped save picker seam. Defaults to the global
 * showSaveFilePicker; tests and Playwright inject doubles here (or replace
 * the global — both work, the global is read at call time).
 */
export type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

function globalSaveFilePicker(): SaveFilePicker | null {
  const host = globalThis as { showSaveFilePicker?: SaveFilePicker };
  return typeof host.showSaveFilePicker === "function"
    ? host.showSaveFilePicker.bind(globalThis)
    : null;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/* ------------------------------------------------------------------ */
/* Start + deliver                                                     */
/* ------------------------------------------------------------------ */

/** A delivered artifact: streamed outputs carry no Blob (bytes on disk). */
export type StudioExportedFile = { name: string; blob: Blob | null };

export type StudioExportRun = {
  /** Explicit cancel — the only way a running export stops early. */
  cancel(): void;
  /** Resolves after DELIVERY (whole output or nothing). */
  done: Promise<StudioExportedFile[]>;
};

export type StartStudioExportOptions = {
  core: ProjectCoreV1;
  /** Session revision frozen into the job and every render request. */
  revision: number;
  /**
   * ARTWORK SOURCE name (primary layer's original filename) — the legacy
   * artifact-naming base and job-settings `source`. NEVER the project
   * title (renaming a project must not change press artifact names).
   */
  sourceName: string;
  target: ExportTarget;
  render: RenderService;
  encoders: ExportEncoders;
  deliver(files: ExportFile[]): Promise<unknown>;
  onProgress?(progress: ExportProgress): void;
  /**
   * Custom-shape resolver forwarded to the orchestrator so plate-package
   * job-settings.json can echo settings.customShape / registrationShape.
   */
  resolveCustomShape?: ExportJobOptions["resolveCustomShape"];
  /** Custom-mark painter for the post-polarity registration pass. */
  paintCustomRegistration?: ExportJobOptions["paintCustomRegistration"];
  prepareCustomRegistration?: ExportJobOptions["prepareCustomRegistration"];
  /**
   * Streaming-threshold override (tests). When omitted, the dev seam
   * (readDevStreamThreshold) and then the resource policy apply.
   */
  maxBlobBytes?: number;
  /**
   * Gesture-scoped save picker for the streamed path. Omitted ⇒ the global
   * showSaveFilePicker at call time; explicit null models a browser
   * without File System Access (the flow then fails typed, pre-render).
   */
  saveFilePicker?: SaveFilePicker | null;
};

/**
 * Attach the export telemetry boundary: one scrubbed stable-code event per
 * real failure (render worker crash, encode, packaging, delivery) — the
 * typed ExportError code when shaped like one, "export-failed" otherwise.
 * Explicit cancellation is not a failure.
 */
function withExportTelemetry<T>(core: ProjectCoreV1, done: Promise<T>): Promise<T> {
  const finish = startAppSpan("app.export", { layerCount: core.layers.length, pixelCount: core.artboard.widthPx * core.artboard.heightPx });
  return done.then((result) => { finish(); return result; }).catch((error: unknown) => {
    finish(error);
    if (!(error instanceof ExportCancelledError)) {
      captureHandledError(
        stableErrorCode((error as { code?: unknown } | null)?.code, "export-failed"),
        error,
        {
          layerCount: core.layers.length,
          pixelCount: core.artboard.widthPx * core.artboard.heightPx,
        },
      );
    }
    throw error;
  });
}

/**
 * Start one studio export. ONE delivery decision (planExportDelivery):
 *
 * - "buffered" (small exports): the legacy whole-or-nothing pipeline,
 *   byte-identical — render → encode → Blob(s) → options.deliver.
 * - "stream" (above the applicable in-memory threshold): the GESTURE-SCOPED picker
 *   opens synchronously inside this call (Export Now click), the FSA
 *   writable is created, decode caches suspend, and bounded encoder/ZIP
 *   chunks stream to disk DURING the render. No Blob of the output ever
 *   exists; cancel covers picker (dismiss = clean cancellation), write,
 *   encode, and close; transactional abort discards the temporary write.
 *   Preflight blocks the stream-impossible combinations (no FSA,
 *   JPEG, custom registration marks) BEFORE this point; the same gates are
 *   re-checked here pre-picker so no user activation is ever spent on a
 *   refusal.
 */
export function startStudioExport(options: StartStudioExportOptions): StudioExportRun {
  const cap =
    options.maxBlobBytes ?? readDevStreamThreshold() ?? RESOURCE_POLICY.maxBlobDownloadBytes;
  const plan = planExportDelivery(options.core, options.target, { maxBlobBytes: cap });
  if (plan.mode === "stream") return startStreamedStudioExport(options, plan);

  // SUSPENSION OWNERSHIP: acquired before the fallible construction; if
  // startExport throws synchronously (unclonable core, id failure) the
  // resume runs immediately — ownership transfers to the promise's
  // .finally only once it is actually attached. resume is idempotent, so
  // the success path can never double-resume.
  const resume = suspendCachesForExport();
  let job: ReturnType<typeof startExport>;
  try {
    job = startExport({
      core: options.core,
      revision: options.revision,
      sourceName: options.sourceName,
      target: options.target,
      render: options.render,
      encoders: options.encoders,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.resolveCustomShape ? { resolveCustomShape: options.resolveCustomShape } : {}),
      ...(options.paintCustomRegistration
        ? { paintCustomRegistration: options.paintCustomRegistration }
        : {}),
    });
  } catch (error) {
    resume();
    throw error;
  }
  const done = withExportTelemetry(
    options.core,
    job.result
      .then(async (files) => {
        await options.deliver(files);
        return files as StudioExportedFile[];
      })
      .finally(resume),
  );
  return { cancel: () => job.cancel(), done };
}

function startStreamedStudioExport(
  options: StartStudioExportOptions,
  plan: ExportDeliveryPlan,
): StudioExportRun {
  const { core, target } = options;
  const cancelController = new AbortController();
  let job: StreamingExportJob | null = null;
  const cancel = () => {
    cancelController.abort();
    job?.cancel();
  };
  const fail = (error: ExportError): StudioExportRun => ({
    cancel: () => undefined,
    done: withExportTelemetry(core, Promise.reject(error)),
  });

  // PRE-PICKER GATES (mirroring preflight): a refusal must never spend the
  // user's activation on a picker dialog.
  if (!targetSupportsStreaming(target)) {
    return fail(
      new ExportError(
        "delivery-exceeded",
        "This export is larger than the in-memory download limit and JPEG has no streamed " +
          "form. Export PNG or TIFF, or reduce the artboard size.",
      ),
    );
  }
  if (target.kind === "plate-package" && target.format !== "svg" &&
      resolveRegistration(target, core.output) && core.registration.customShapeAssetId !== null &&
      !options.prepareCustomRegistration) {
    return fail(new ExportError("registration-shape-unsupported", "Custom registration marks need a band painter."));
  }
  const picker =
    options.saveFilePicker !== undefined ? options.saveFilePicker : globalSaveFilePicker();
  if (!picker) {
    return fail(
      new ExportError(
        "delivery-exceeded",
        `This export is estimated at ${Math.round(plan.estimatedBytes / (1024 * 1024))} MiB — ` +
          "larger than the in-memory download limit, and this browser cannot stream exports " +
          "to disk. Use Chrome or Edge, or reduce the artboard size.",
      ),
    );
  }

  // GESTURE-SCOPED: the picker opens SYNCHRONOUSLY inside the Export Now
  // click task, before any render work, so transient user activation is
  // still live. showSaveFilePicker can also throw SYNCHRONOUSLY
  // (SecurityError without activation) — contained as a typed pre-render
  // failure so the export session never wedges.
  const suggestedName = targetFileName(target, options.sourceName, core.separation.mode);
  const extension = suggestedName.split(".").pop() ?? "zip";
  let pickerPromise: Promise<SaveFileHandle>;
  try {
    pickerPromise = picker({
      suggestedName,
      types: [
        {
          accept: {
            [extension === "zip" ? "application/zip" : `image/${extension === "tiff" ? "tiff" : extension}`]:
              [`.${extension}`],
          },
        },
      ],
    });
  } catch (error) {
    return fail(
      new ExportError("export-failed", "Could not open a save destination", { cause: error }),
    );
  }
  // A rejection must never surface as unhandled before done is awaited.
  pickerPromise.catch(() => undefined);

  /** Race a native await against cancel; the loser continues DETACHED. */
  const raceCancel = <T,>(promise: Promise<T>): Promise<T> => {
    const signal = cancelController.signal;
    if (signal.aborted) return Promise.reject(new ExportCancelledError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new ExportCancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  };

  const done = (async (): Promise<StudioExportedFile[]> => {
    let handle: SaveFileHandle;
    try {
      // Cancel settles promptly even while the native dialog is pending;
      // a LATE picker resolution is dropped untouched (never mutated,
      // never written, never removed).
      handle = await raceCancel(pickerPromise);
    } catch (error) {
      if (error instanceof ExportCancelledError) throw error;
      // User dismissed the picker: a clean no-op — nothing rendered,
      // nothing written, preview state untouched.
      if (isAbortError(error)) throw new ExportCancelledError();
      throw new ExportError("export-failed", "Could not open a save destination", {
        cause: error,
      });
    }
    let writable: Awaited<ReturnType<SaveFileHandle["createWritable"]>>;
    const writablePromise = Promise.resolve().then(() => handle.createWritable());
    writablePromise.catch(() => undefined);
    try {
      writable = await raceCancel(writablePromise);
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        // A LATE writable from the detached native call is aborted exactly
        // once, error-contained — transactional abort keeps any
        // pre-existing picked file intact.
        void writablePromise
          .then((late) => late.abort?.())
          .catch(() => undefined);
        throw error;
      }
      throw new ExportError("export-failed", "Could not open the export file for writing", {
        cause: error,
      });
    }
    // Cache suspension happens AFTER the picker/writable opened (a
    // dismissed picker never disturbs preview state) and BEFORE the render
    // begins.
    const resume = suspendCachesForExport();
    let writableAbort: Promise<void> | null = null;
    const abortWritable = (): Promise<void> => {
      writableAbort ??= Promise.resolve()
        .then(() => writable.abort?.())
        .then(() => undefined)
        .catch(() => undefined);
      return writableAbort;
    };
    const sink: ExportStreamSink = {
      write: (chunk, signal) => {
        // Return the UNDERLYING native write settlement as the ownership
        // boundary. The orchestrator races job cancellation independently,
        // so the UI still settles promptly; returning an abort-raced facade
        // here would make its `stream-chunk-write` receipt release while the
        // FileSystemWritableFileStream could still retain `chunk`.
        const pending = Promise.resolve().then(() => writable.write(chunk));
        pending.catch(() => undefined);
        if (!signal) return pending;
        if (signal.aborted) {
          void abortWritable();
          return pending;
        }
        const onAbort = () => void abortWritable();
        signal.addEventListener("abort", onAbort, { once: true });
        void pending.then(
          () => signal.removeEventListener("abort", onAbort),
          () => signal.removeEventListener("abort", onAbort),
        );
        return pending;
      },
      close: () => writable.close(),
      // Aborted terminal state = writable.abort() ONLY: the transactional
      // temp write is discarded and a pre-existing picked file survives
      // with its original contents. Never remove()/delete the target.
      abort: abortWritable,
    };
    try {
      job = startStreamingExport({
        core,
        revision: options.revision,
        sourceName: options.sourceName,
        target,
        render: options.render,
        encoders: options.encoders,
        sink,
        ...(options.prepareCustomRegistration ? { prepareCustomRegistration: options.prepareCustomRegistration } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.resolveCustomShape ? { resolveCustomShape: options.resolveCustomShape } : {}),
        ...(options.paintCustomRegistration
          ? { paintCustomRegistration: options.paintCustomRegistration }
          : {}),
      });
      if (cancelController.signal.aborted) job.cancel();
      const result = await job.result;
      return [{ name: result.name, blob: null }];
    } catch (error) {
      // Post-writable ownership: a SYNCHRONOUS startStreamingExport throw
      // (before the job existed to own the sink) must still abandon the
      // writable — no orphaned locks or stranded temp writes.
      if (!job) await sink.abort().catch(() => undefined);
      throw error;
    } finally {
      resume();
    }
  })();

  return { cancel, done: withExportTelemetry(core, done) };
}

export type StudioDeliveryOptions = {
  saveBlob(file: ExportFile): void;
  /** File System Access picker when the environment provides one. */
  showSaveFilePicker?: DeliveryOptions["showSaveFilePicker"];
  maxBlobBytes?: number;
};

/**
 * Delivery policy for BUFFERED outputs: plain Blob downloads under the
 * policy cap. There is deliberately NO post-render File System Access
 * branch anymore (wave G2): a picker opened after the render has no user
 * activation left, so routing decides buffered-vs-streamed BEFORE render
 * on the conservative preflight estimate — an oversized buffered payload
 * reaching this point is a routing bug and fails loudly instead of
 * popping an activation-less dialog.
 */
export async function deliverStudioExport(
  files: ExportFile[],
  options: StudioDeliveryOptions,
): Promise<"blob-download"> {
  const maxBlobBytes = options.maxBlobBytes ?? RESOURCE_POLICY.maxBlobDownloadBytes;
  if (totalExportBytes(files) <= maxBlobBytes) {
    for (const file of files) options.saveBlob(file);
    return "blob-download";
  }
  throw new ExportError(
    "export-too-large",
    "This export is larger than the in-memory download limit. Use Chrome or Edge, " +
      "which can stream large exports directly to disk.",
  );
}
