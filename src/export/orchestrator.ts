/**
 * Export job orchestration. Freezes a project revision, drives a
 * renderer-agnostic RenderService through the target's steps with progress
 * callbacks, and assembles the complete output in memory before anything is
 * delivered — an export either finishes whole or produces nothing.
 *
 * Cancellation is explicit only (job.cancel()); the orchestrator never
 * abandons a job on its own. Delivery prefers File System Access streaming
 * where available (Chrome/Edge) and falls back to a Blob download under
 * RESOURCE_POLICY.maxBlobDownloadBytes.
 */

import { createId } from "../core/id";
import { RESOURCE_POLICY } from "../core/resource-policy";
import { SVG_TEXT_CHUNK_CHARS } from "../core/stream-memory";
/* Direct instrumentation import (not the render index) keeps this module
 * dependency-light for the many node unit suites that import it. */
import { retainAllocation } from "../render/instrumentation";
import type { Id, PlateId, ProjectCoreV1, Sha256 } from "../core/types";
import type { CustomShapeAsset } from "../studio/custom-shape-data";
import { buildPlateJobSettings, manifestLayer } from "./job-settings";
import {
  invertPlateInk,
  invertPlateInkRows,
  mirrorRasterHorizontal,
  mirrorRgbaRowsHorizontal,
  paintRegistrationMarks,
  paintRegistrationMarksRows,
  polarityApplies,
  transformExportRaster,
  transformExportSvg,
} from "./output-transforms";
import type { PngRowEncoder } from "./png-stream";
import {
  contributingPlates,
  formatMime,
  MAX_BUFFERED_PLATE_PACKAGE_BYTES,
  MAX_STREAMED_SVG_PLATE_BYTES,
  plateFileName,
  plateSettingsFileName,
  resolveMatte,
  resolveRegistration,
  targetFileName,
  type ExportTarget,
  type PlatePackageTarget,
} from "./targets";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ExportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportError";
    this.code = code;
  }
}

export class ExportCancelledError extends ExportError {
  constructor() {
    super("export-cancelled", "Export cancelled");
    this.name = "ExportCancelledError";
  }
}

/* ------------------------------------------------------------------ */
/* Render service contract                                             */
/* ------------------------------------------------------------------ */

/** Plain pixel payload exchanged with the renderer; RGBA, unassociated alpha. */
export type RasterData = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type RenderRequestOptions = {
  /** Frozen core revision this render belongs to. */
  revision: number;
  registration: boolean;
  /** Matte color to paint behind the artwork, or null to keep alpha. */
  matte: string | null;
  signal: AbortSignal;
  /** 0..1 progress within this render step. */
  onProgress?: (fraction: number) => void;
};

/**
 * Band consumer for TRUE STREAMING plate delivery (wave G2): the renderer
 * pushes each composed plate's RGBA rows (plate-raster convention: constant
 * ink RGB, coverage in alpha) top-to-bottom, gapless, one plate at a time
 * in press order. `writeBand` backpressure is REAL — the renderer's
 * band-credit window stalls until it resolves, so a slow sink bounds the
 * whole pipeline instead of queueing an output's worth of bands.
 */
export type PlateBandDelivery = {
  beginPlate(plate: PlateId, signal?: AbortSignal): void | Promise<void>;
  writeBand(
    plate: PlateId,
    rowStart: number,
    rowCount: number,
    rgbaRows: Uint8ClampedArray,
    signal?: AbortSignal,
  ): void | Promise<void>;
  /** Every band of `plate` was delivered; its accumulators are freed. */
  endPlate(plate: PlateId, signal?: AbortSignal): void | Promise<void>;
};

/**
 * Renderer boundary. The lead binds this to the worker renderer; a default
 * binding to the current single-layer engine lives in current-engine.ts.
 */
export type RenderService = {
  /** Compatibility canvas service can paint positive registration natively. */
  streamRegistration?(core: ProjectCoreV1): boolean;
  renderComposite(core: ProjectCoreV1, options: RenderRequestOptions): Promise<RasterData>;
  renderPlate(
    core: ProjectCoreV1,
    plate: PlateId,
    options: RenderRequestOptions,
  ): Promise<RasterData>;
  /** Genuine vector plate output; only called after vector eligibility passed. */
  renderPlateSvg(
    core: ProjectCoreV1,
    plate: PlateId,
    options: RenderRequestOptions,
  ): Promise<string>;
  /** Full-artboard transparent render of a single layer, placement preserved. */
  renderLayer(
    core: ProjectCoreV1,
    layerId: Id,
    options: RenderRequestOptions,
  ): Promise<RasterData>;
  /**
   * Deliver plate rows with backpressure. The worker renders bounded bands;
   * the separately admitted compatibility service retains one full canvas.
   * Registration is requested off unless streamRegistration permits it:
   * marks are the orchestrator's band-wise final pass so polarity/mirror
   * ordering matches the buffered pipeline exactly. Optional because
   * fallback/legacy services may not provide it; the delivery plan only
   * streams when the bound service does.
   */
  streamPlates?(
    core: ProjectCoreV1,
    plates: PlateId[],
    options: RenderRequestOptions,
    delivery: PlateBandDelivery,
  ): Promise<void>;
};

/* ------------------------------------------------------------------ */
/* Encoder contract                                                    */
/* ------------------------------------------------------------------ */

export type ZipEntry = { name: string; data: Blob | string };

/**
 * Encoding boundary so the orchestrator stays DOM-free and testable. The
 * browser implementation (encoders.ts) uses canvas + png-dpi + tiff.ts and
 * lazy-loads @zip.js/zip.js (swap to src/io zip-writer once it lands).
 */
export type ExportEncoders = {
  encodePng(raster: RasterData, dpi: number): Promise<Blob>;
  encodeJpeg(raster: RasterData, quality: number): Promise<Blob>;
  encodeTiff(raster: RasterData, dpi: number): Promise<Blob>;
  zip(entries: ZipEntry[], signal?: AbortSignal): Promise<Blob>;
};

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export type ExportFile = { name: string; blob: Blob };

export type ExportPhase = "render" | "encode" | "package";

export type ExportProgress = {
  phase: ExportPhase;
  /** Completed work units (renders/encodes) out of total. */
  completed: number;
  total: number;
  /** Fractional progress 0..1 across the whole job. */
  fraction: number;
};

/** Owned custom stamp plus a bounded document-coordinate raster painter. */
export type RegistrationRowPainter = {
  paintRows(rows: Uint8ClampedArray, rowStart: number, rowCount: number, signal?: AbortSignal): Promise<void>;
  dispose(): void;
};

export type ExportJobOptions = {
  core: ProjectCoreV1;
  /** Project revision frozen for the lifetime of this job. */
  revision: number;
  /**
   * The ARTWORK SOURCE name (primary layer's original filename / source
   * name) — the legacy naming base for every artifact and the manifest's
   * `source` field. Deliberately NOT the project title: renaming a project
   * must never change film artifact names, and .drglitch archives (which do
   * use the title) are a different subsystem. Multi-layer projects use the
   * PRIMARY layer's source name (documented decision); an empty name falls
   * back to "untitled" via exportBaseName.
   */
  sourceName: string;
  target: ExportTarget;
  render: RenderService;
  encoders: ExportEncoders;
  dpi?: number;
  /**
   * Main-thread painter for CUSTOM registration marks painted AFTER
   * negative polarity (see the plate pipeline below). Built-in marks use
   * the DOM-free painter; custom shapes need this canvas-backed hook.
   */
  prepareCustomRegistration?: (
    registration: ProjectCoreV1["registration"], width: number, height: number, signal?: AbortSignal,
  ) => Promise<RegistrationRowPainter>;
  paintCustomRegistration?: (
    raster: RasterData,
    registration: ProjectCoreV1["registration"],
  ) => Promise<void>;
  /**
   * Resolves a sanitized custom-shape SVG asset (custom dot shape or custom
   * registration mark) so the plate-package job manifest can echo it the way
   * the legacy manifest did (settings.customShape / registrationShape). The
   * lead wires this to the session AssetCache (customShapeWhenReady); when
   * absent those manifest keys are omitted.
   */
  resolveCustomShape?: (assetId: Sha256) => Promise<CustomShapeAsset>;
  onProgress?: (progress: ExportProgress) => void;
};

export type ExportJob = {
  id: Id;
  revision: number;
  target: ExportTarget;
  /** Resolves with the complete output; rejects without partial output. */
  result: Promise<ExportFile[]>;
  /** Explicit cancel — the only way a running job stops early. */
  cancel(): void;
};

const JPEG_QUALITY = 0.92;
const DEFAULT_DPI = 240;

export function startExport(options: ExportJobOptions): ExportJob {
  const controller = new AbortController();
  // Freeze: the job renders this deep copy no matter what the caller
  // mutates afterwards. The revision travels with every render request.
  const frozenCore = structuredClone(options.core);
  const job: ExportJob = {
    id: createId(),
    revision: options.revision,
    target: options.target,
    result: runJob(frozenCore, options, controller.signal),
    cancel: () => controller.abort(),
  };
  return job;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelledError();
}

/**
 * ACTUAL per-entry SVG byte cap (safety story; the preflight estimate is
 * the admission story): the measured UTF-8 size of ONE plate's SVG text
 * must stay under the entry-buffered residency bound BEFORE any of it is
 * packaged — enforced by BOTH the buffered and streamed packagers.
 */
function assertSvgEntryBytes(svg: string): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let offset = 0; offset < svg.length; offset += 1024 * 1024) {
    bytes += encoder.encode(svg.slice(offset, offset + 1024 * 1024)).length;
    if (bytes > MAX_STREAMED_SVG_PLATE_BYTES) {
      throw new ExportError(
        "svg-entry-bytes-exceeded",
        `A single vector plate produced more than ${Math.round(MAX_STREAMED_SVG_PLATE_BYTES / (1024 * 1024))} MiB ` +
          "of SVG text; increase cell size or export raster plates.",
      );
    }
  }
  return bytes;
}

function assertBufferedPackageBytes(bytes: number): void {
  if (bytes <= MAX_BUFFERED_PLATE_PACKAGE_BYTES) return;
  throw new ExportError(
    "delivery-exceeded",
    `The plate package exceeded the ${Math.round(MAX_BUFFERED_PLATE_PACKAGE_BYTES / (1024 * 1024))} MiB ` +
      "safe in-memory packaging limit; use File System Access streaming.",
  );
}

/**
 * Prompt cancellation for the encode/package phases: cancel() must reject
 * the job within its latency budget even while an encoder (canvas toBlob,
 * TIFF assembly, ZIP) is mid-flight and cannot itself be interrupted. The
 * abandoned promise settles in the background with its result dropped; the
 * job keeps the no-partial-output guarantee because nothing after the
 * rejection ever reads it.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
}

async function runJob(
  core: ProjectCoreV1,
  options: ExportJobOptions,
  signal: AbortSignal,
): Promise<ExportFile[]> {
  const { target, render, encoders, sourceName } = options;
  const dpi = options.dpi ?? DEFAULT_DPI;
  const registration = resolveRegistration(target, core.output);
  const matte = resolveMatte(target, core.artboard);
  // REGISTRATION IS THE FINAL CONTENT PASS: polarity inverts ARTWORK plate
  // coverage only, never the marks. On a negative plate the artwork renders
  // WITHOUT registration, polarity inverts it, and the marks are painted
  // afterwards as normal ink; the press mirror then flips the completed
  // sheet so artwork and marks stay mutually registered. Positive plates
  // keep the engines' native (legacy byte-exact) registration pass.
  const negativePlates = core.output.polarity === "negative" && polarityApplies(target);

  async function paintRegistrationAfterPolarity(raster: RasterData): Promise<void> {
    if (core.registration.customShapeAssetId !== null) {
      if (!options.paintCustomRegistration) {
        throw new ExportError(
          "registration-shape-unsupported",
          "Custom registration marks need a main-thread painter for negative plates.",
        );
      }
      await options.paintCustomRegistration(raster, core.registration);
      return;
    }
    paintRegistrationMarks(raster, core.registration);
  }

  const plates = target.kind === "plate-package" ? contributingPlates(core.separation) : [];
  // Work units: one render + one encode per output, plus packaging for zips.
  const totalUnits = target.kind === "plate-package" ? plates.length * 2 + 1 : 2;
  let completedUnits = 0;
  const report = (phase: ExportPhase) => {
    options.onProgress?.({
      phase,
      completed: completedUnits,
      total: totalUnits,
      fraction: totalUnits === 0 ? 1 : completedUnits / totalUnits,
    });
  };
  const advance = (phase: ExportPhase) => {
    completedUnits += 1;
    report(phase);
  };

  const requestOptions = (overrides?: Partial<RenderRequestOptions>): RenderRequestOptions => ({
    revision: options.revision,
    registration,
    matte,
    signal,
    ...overrides,
  });

  try {
    throwIfAborted(signal);
    report("render");

    if (target.kind === "composite") {
      // Output transforms (press mirror; polarity is plate-only) apply to the
      // finished render, immediately before encoding.
      const raster = transformExportRaster(
        await abortable(render.renderComposite(core, requestOptions()), signal),
        target,
        core.output,
      );
      throwIfAborted(signal);
      advance("render");
      const blob =
        target.format === "png"
          ? await abortable(encoders.encodePng(raster, dpi), signal)
          : target.format === "jpeg"
            ? await abortable(encoders.encodeJpeg(raster, JPEG_QUALITY), signal)
            : await abortable(encoders.encodeTiff(raster, dpi), signal);
      throwIfAborted(signal);
      advance("encode");
      return [{ name: targetFileName(target, sourceName, core.separation.mode), blob }];
    }

    if (target.kind === "selected-layer") {
      const raster = transformExportRaster(
        await abortable(render.renderLayer(core, target.layerId, requestOptions()), signal),
        target,
        core.output,
      );
      throwIfAborted(signal);
      advance("render");
      const blob =
        target.format === "png"
          ? await abortable(encoders.encodePng(raster, dpi), signal)
          : await abortable(encoders.encodeTiff(raster, dpi), signal);
      throwIfAborted(signal);
      advance("encode");
      return [{ name: targetFileName(target, sourceName, core.separation.mode), blob }];
    }

    // Plate package: render and encode every plate, then package once.
    // Everything is staged in memory; the zip only exists after each plate
    // succeeded, so a failure or cancel emits nothing.
    const entries: ZipEntry[] = [];
    let bufferedPackageBytes = 0;
    if (target.format === "svg" && core.output.polarity === "negative") {
      // Preflight blocks this earlier; refuse defensively — a vector negative
      // has no genuine geometric form (see output-transforms.ts).
      throw new ExportError(
        "polarity-vector-unsupported",
        "Negative polarity has no genuine vector form; export raster plates or switch polarity to positive.",
      );
    }
    for (const plate of plates) {
      throwIfAborted(signal);
      if (target.format === "svg") {
        const svg = transformExportSvg(
          await abortable(render.renderPlateSvg(core, plate, requestOptions()), signal),
          core.output,
          core.artboard,
        );
        throwIfAborted(signal);
        bufferedPackageBytes += assertSvgEntryBytes(svg);
        assertBufferedPackageBytes(bufferedPackageBytes);
        advance("render");
        entries.push({ name: plateFileName(sourceName, plate, "svg"), data: svg });
        advance("encode");
      } else {
        // Registration is the FINAL content pass: on a negative the artwork
        // renders WITHOUT marks, polarity inverts the artwork coverage, the
        // marks paint on top as normal ink, then the press mirror flips the
        // completed sheet. Positive plates keep the engines' native
        // (legacy byte-exact) registration pass and mirror last.
        let raster = await abortable(
          render.renderPlate(
            core,
            plate,
            requestOptions(negativePlates ? { registration: false } : undefined),
          ),
          signal,
        );
        if (negativePlates) {
          raster = invertPlateInk(raster);
          if (registration) await paintRegistrationAfterPolarity(raster);
        }
        if (core.output.pressMirror) raster = mirrorRasterHorizontal(raster);
        throwIfAborted(signal);
        advance("render");
        const blob = await abortable(encoders.encodePng(raster, dpi), signal);
        throwIfAborted(signal);
        bufferedPackageBytes += blob.size;
        assertBufferedPackageBytes(bufferedPackageBytes);
        entries.push({ name: plateFileName(sourceName, plate, "png"), data: blob });
        advance("encode");
      }
    }
    // Job manifest: the legacy content contract (settings/document/output
    // echo, exactly what this job rendered) plus the workstation's
    // schema/revision/target binding. See job-settings.ts.
    const manifest = await abortable(
      buildPlateManifestEntry(core, options, target, plates, registration, dpi),
      signal,
    );
    throwIfAborted(signal);
    bufferedPackageBytes += new TextEncoder().encode(manifest.data).byteLength;
    assertBufferedPackageBytes(bufferedPackageBytes);
    entries.push({ name: manifest.name, data: manifest.data });
    throwIfAborted(signal);
    const archive = await abortable(encoders.zip(entries, signal), signal);
    throwIfAborted(signal);
    assertBufferedPackageBytes(archive.size);
    advance("package");
    return [{ name: targetFileName(target, sourceName, core.separation.mode), blob: archive }];
  } catch (error) {
    if (signal.aborted) throw new ExportCancelledError();
    if (error instanceof ExportError) throw error;
    throw new ExportError("export-failed", "Export failed", { cause: error });
  }
}

/**
 * The plate-package job manifest entry, shared byte-for-byte by the
 * buffered and streamed packagers (legacy settings/document/output echo
 * plus the workstation's schema/revision/target binding — job-settings.ts).
 */
async function buildPlateManifestEntry(
  core: ProjectCoreV1,
  options: ExportJobOptions,
  target: PlatePackageTarget,
  plates: PlateId[],
  registration: boolean,
  dpi: number,
): Promise<{ name: string; data: string }> {
  const layer = manifestLayer(core);
  const customShapeId =
    layer?.recipe.halftone.dotShape === "custom"
      ? layer.recipe.halftone.customShapeAssetId
      : null;
  const customShape =
    customShapeId !== null && options.resolveCustomShape
      ? await options.resolveCustomShape(customShapeId)
      : undefined;
  const registrationShape =
    core.registration.customShapeAssetId !== null && options.resolveCustomShape
      ? await options.resolveCustomShape(core.registration.customShapeAssetId)
      : undefined;
  return {
    name: plateSettingsFileName(options.sourceName, target.format),
    data: buildPlateJobSettings({
      core,
      revision: options.revision,
      target,
      sourceName: options.sourceName,
      registration,
      plates,
      dpi,
      customShape,
      registrationShape,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* TRUE STREAMING export (wave G2)                                     */
/* ------------------------------------------------------------------ */

/**
 * Byte sink for streamed delivery — a wrapper over the File System Access
 * writable the caller opened INSIDE the user gesture. abort() abandons the
 * TRANSACTIONAL temp write (writable.abort discards it and preserves any
 * pre-existing picked file's contents — the target is never removed);
 * close() is only called after the archive completed wholly and atomically
 * replaces the target.
 */
export type ExportStreamSink = {
  /** Must settle promptly when `signal` aborts (normally by aborting the writable). */
  write(chunk: Uint8Array, signal?: AbortSignal): void | Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

export type StreamedExportFile = {
  name: string;
  /** Total archive bytes drained into the sink. */
  bytesWritten: number;
};

export type StreamingExportJobOptions = ExportJobOptions & {
  sink: ExportStreamSink;
};

export type StreamingExportJob = {
  id: Id;
  revision: number;
  target: ExportTarget;
  /** Resolves after the sink was CLOSED (whole archive) — never partially. */
  result: Promise<StreamedExportFile>;
  cancel(): void;
};

/**
 * TRUE STREAMING plate-package export: bounded encoder/ZIP chunks flow to
 * the sink DURING the render — plate bands → incremental PNG encode →
 * streamed ZIP entries (data descriptors) → writable — and no complete
 * Blob[], ZIP, or output Uint8Array ever exists.
 *
 * FORMAT DECISIONS (documented, honest):
 * - plate-package PNG: genuinely streams (band-credited renderer sink →
 *   createPngRowEncoder → streaming ZIP entry).
 * - plate-package SVG: streams ENTRY-WISE — one plate's SVG text exists at
 *   a time (bounded by the vector mark caps, orders of magnitude below the
 *   raster threshold) and drains into its ZIP entry before the next plate
 *   renders.
 * - composite / selected-layer (PNG/JPEG/TIFF): NEVER claimed to stream.
 *   Their raw size is policy-bounded (maxArtboardPixels × 4 ≈ 80 MiB) far
 *   below the streaming threshold; anything over the threshold without a
 *   streamable form is hard-blocked in preflight BEFORE rendering.
 *
 * CANCEL covers picker (caller), write, close, and encode: the abort
 * signal breaks a blocked encoder write, aborts the streaming archive
 * (which NEVER finalizes a central directory after abort), and the
 * transactional sink is aborted so its temporary bytes are discarded. The
 * band-credit window bounds in-flight data end to end (see planner.ts
 * STREAM_DELIVERY_BAND_WINDOW).
 */
export function startStreamingExport(options: StreamingExportJobOptions): StreamingExportJob {
  const controller = new AbortController();
  const frozenCore = structuredClone(options.core);
  return {
    id: createId(),
    revision: options.revision,
    target: options.target,
    result: runStreamingJob(frozenCore, options, controller.signal),
    cancel: () => controller.abort(),
  };
}

async function runStreamingJob(
  core: ProjectCoreV1,
  options: StreamingExportJobOptions,
  signal: AbortSignal,
): Promise<StreamedExportFile> {
  const { target, render, sink, sourceName } = options;
  /**
   * SINK OWNERSHIP begins the moment this job receives the open writable:
   * ONE memoized abort — shared by the abort listener, every validation
   * exit, and the catch path — guarantees the partial file is abandoned
   * exactly once and a pending sink.write/close is unblocked immediately
   * (an FSA writable rejects its pending operations when aborted). Success
   * is the only path that reaches sink.close().
   */
  let customRegistration: RegistrationRowPainter | null = null;
  let sinkAbort: Promise<void> | null = null;
  let committed = false;
  const abortSink = (): Promise<void> => {
    sinkAbort ??= sink.abort().catch(() => undefined);
    return sinkAbort;
  };
  const encoderRef: { current: PngRowEncoder | null } = { current: null };
  const archiveRef: { current: import("../io/zip-writer").StreamingArchiveWriter | null } = {
    current: null,
  };
  const onAbort = () => {
    if (committed) return; // close won the arbitration; the file survives
    const cancelled = new ExportCancelledError();
    encoderRef.current?.abort(cancelled);
    if (archiveRef.current) void archiveRef.current.abort(cancelled);
    // IMMEDIATELY: a pending sink.write (or the pending close) keeps
    // zip.js/the commit blocked; only aborting the sink itself unblocks
    // them so teardown proceeds within the cancellation budget.
    void abortSink();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  /**
   * CLOSE ARBITRATION as ONE compare-and-swap terminal cell on the
   * ORIGINAL close promise: the close-fulfillment callback and the abort
   * callback each attempt an atomic decide-and-settle — the first writer
   * wins, both terminal states are ABSORBING (committed never becomes
   * aborted; aborted never becomes committed — a close fulfilling after an
   * abort won is discarded, contained), and exactly ONE settlement reaches
   * the caller. No wrapper promise, no second racing chain.
   */
  let closeTerminal: "pending" | "committed" | "aborted" = "pending";
  const closeWithArbitration = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const decideAbort = () => {
        if (closeTerminal !== "pending") return; // absorbing
        closeTerminal = "aborted";
        reject(new ExportCancelledError());
      };
      if (signal.aborted || sinkAbort) {
        decideAbort();
        return;
      }
      signal.addEventListener("abort", decideAbort, { once: true });
      Promise.resolve()
        .then(() => {
          // DEFERRAL GUARD: if abort won the CAS before this microtask
          // ran, close is NEVER invoked on the aborted sink.
          if (closeTerminal !== "pending") return undefined;
          return sink.close();
        })
        .then(
          () => {
            // CAS commit IN the close's own fulfillment continuation.
            if (closeTerminal !== "pending") return; // abort won; discard
            closeTerminal = "committed";
            committed = true;
            signal.removeEventListener("abort", onAbort);
            signal.removeEventListener("abort", decideAbort);
            resolve();
          },
          (error: unknown) => {
            // A settled state machine takes no further listener fires.
            signal.removeEventListener("abort", decideAbort);
            if (closeTerminal !== "pending") return; // contained
            closeTerminal = "aborted";
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
  let bytesWritten = 0;
  /** Ledger-charged sink write shared by the archive and single-file paths. */
  const chargedWrite = async (
    chunk: Uint8Array,
    writeSignal: AbortSignal = signal,
  ): Promise<void> => {
    // Receiver ledger: encoded chunks are charged between encode and
    // sink-accept so packaging retention is observable end to end.
    const retainedBytes = Math.max(chunk.byteLength, chunk.buffer.byteLength);
    const releaseChunk = retainAllocation(
      retainedBytes,
      "encode",
      "stream-chunk-write",
    );
    // Defer invocation so a synchronous hostile-sink throw belongs to the
    // tracked promise and therefore releases this captured receipt.
    const write = Promise.resolve().then(() => sink.write(chunk, writeSignal));
    void write.then(releaseChunk, releaseChunk);
    await write;
    bytesWritten += chunk.byteLength;
  };
  try {
    // Defense-in-depth validations (preflight blocks these BEFORE the
    // picker ever opens; reaching one here still abandons the sink).
    const dpi = options.dpi ?? DEFAULT_DPI;
    const registration = resolveRegistration(target, core.output);
    const matte = resolveMatte(target, core.artboard);
    if (target.kind === "plate-package") {
      if (target.format === "svg" && core.output.polarity === "negative") {
        throw new ExportError(
          "polarity-vector-unsupported",
          "Negative polarity has no genuine vector form; export raster plates or switch polarity to positive.",
        );
      }
    } else if (target.format === "jpeg") {
      // JPEG has no incremental encoder (canvas only) — the one format
      // that hard-blocks above the threshold instead of streaming.
      throw new ExportError(
        "stream-target-unsupported",
        "JPEG has no streamed form; export PNG or TIFF, or reduce the export size.",
      );
    }
    const plates = contributingPlates(core.separation);
    const negativePlates = core.output.polarity === "negative" && polarityApplies(target);
    const { widthPx: width, heightPx: height } = core.artboard;
    const totalUnits = target.kind === "plate-package" ? plates.length * 2 + 1 : 3;
    let completedUnits = 0;
    // CONTAINED progress: a throwing consumer callback must never enter
    // the failure path — in particular the post-commit advance must never
    // abort a successfully closed file.
    const report = (phase: ExportPhase, partialUnit = 0) => {
      try {
        options.onProgress?.({
          phase,
          completed: completedUnits,
          total: totalUnits,
          fraction: totalUnits === 0 ? 1 : (completedUnits + partialUnit) / totalUnits,
        });
      } catch {
        /* progress is advisory; contained */
      }
    };
    const advance = (phase: ExportPhase) => {
      completedUnits += 1;
      report(phase);
    };
    const requestOptions = (overrides?: Partial<RenderRequestOptions>): RenderRequestOptions => ({
      revision: options.revision,
      registration,
      matte,
      signal,
      ...overrides,
    });

    if (target.kind !== "plate-package") {
      // SINGLE-FILE STREAMING (composite / selected-layer PNG and TIFF):
      // the render itself follows the buffered pipeline exactly — the full
      // output raster is part of the render model (collector finalize) —
      // but the ENCODED bytes stream to the sink in bounded chunks and no
      // complete Blob/byte-array of the output ever exists.
      throwIfAborted(signal);
      report("render");
      const raster = transformExportRaster(
        await abortable(
          target.kind === "composite"
            ? render.renderComposite(core, requestOptions())
            : render.renderLayer(core, target.layerId, requestOptions()),
          signal,
        ),
        target,
        core.output,
      );
      throwIfAborted(signal);
      advance("render");
      // Signal-raced imports: a never-settling module load must not hang
      // cancellation.
      const chunks =
        target.format === "png"
          ? (await abortable(import("./png-stream"), signal)).streamPngChunks(raster, { dpi, signal })
          : (await abortable(import("./tiff"), signal)).streamTiffRgbaChunks(raster, { dpi, signal });
      for await (const chunk of chunks) {
        throwIfAborted(signal);
        await abortable(Promise.resolve(chargedWrite(chunk)), signal);
      }
      advance("encode");
      // COMMIT ARBITRATION — the CAS terminal cell (closeWithArbitration).
      await closeWithArbitration();
      advance("package");
      return {
        name: targetFileName(target, sourceName, core.separation.mode),
        bytesWritten,
      };
    }

    // Lazy import keeps @zip.js/zip.js out of the main bundle (same rule
    // as the buffered encoder path).
    const { createStreamingArchiveWriter } = await abortable(import("../io/zip-writer"), signal);
    const archive = createStreamingArchiveWriter({ write: chargedWrite });
    // The abort listener reaches the archive through this ref — assigned
    // BEFORE any entry work so cancellation can always abort zip.js.
    archiveRef.current = archive;
    throwIfAborted(signal);
    report("render");
    if (target.format === "svg") {
      // ENTRY-BUFFERED (documented honesty bound: preflight's
      // svg-entry-bytes-exceeded cap): ONE plate's SVG string is resident
      // at a time and is CHUNK-ENCODED into its archive entry — 1 MiB
      // slices through TextEncoder — so no second full-document byte copy
      // ever exists alongside the string.
      for (const plate of plates) {
        throwIfAborted(signal);
        const svg = transformExportSvg(
          await abortable(render.renderPlateSvg(core, plate, requestOptions()), signal),
          core.output,
          core.artboard,
        );
        throwIfAborted(signal);
        // ACTUAL byte cap BEFORE the first entry byte is written.
        assertSvgEntryBytes(svg);
        advance("render");
        await abortable(
          archive.addEntry(plateFileName(sourceName, plate, "svg"), svgTextChunkStream(svg, signal), {
            compress: true,
          }),
          signal,
        );
        advance("encode");
      }
    } else {
      if (!render.streamPlates) {
        throw new ExportError(
          "stream-unsupported",
          "The bound renderer has no band delivery path for streamed plate packages.",
        );
      }
      const nativeRegistration = registration && !negativePlates && (render.streamRegistration?.(core) ?? false);
      if (registration && !nativeRegistration && core.registration.customShapeAssetId !== null) {
        if (!options.prepareCustomRegistration) {
          throw new ExportError("registration-shape-unsupported", "Custom registration marks need a band painter.");
        }
        const prepared = options.prepareCustomRegistration(core.registration, width, height, signal);
        // A resolver may finish after cancellation. Release its owned stamp
        // on that late completion instead of stranding native canvas memory.
        void prepared.then((painter) => { if (signal.aborted) painter.dispose(); }, () => undefined);
        customRegistration = await abortable(prepared, signal);
      }
      const { createPngRowEncoder } = await abortable(import("./png-stream"), signal);
      let entryDone: Promise<void> | null = null;
      // Signal-raced: the renderer already aborts through the request
      // signal, but a defective implementation must not hang cancellation.
      await abortable(render.streamPlates(core, plates, requestOptions({ registration: nativeRegistration }), {
        beginPlate: (plate) => {
          const encoder = createPngRowEncoder(width, height, { dpi });
          encoderRef.current = encoder;
          // Stored (PNG payloads are already compressed) — same rule as the
          // buffered writer. A failed entry aborts the encoder so a blocked
          // band write can never deadlock on a dead consumer.
          entryDone = archive.addEntry(plateFileName(sourceName, plate, "png"), encoder.readable, {
            compress: false,
          });
          entryDone.catch((error: unknown) => encoder.abort(error));
        },
        writeBand: async (_plate, rowStart, rowCount, rows, bandSignal) => {
          throwIfAborted(signal);
          // Band-wise output pipeline, ordered exactly like the buffered
          // path: polarity inverts artwork coverage, marks paint after
          // polarity as the final content pass, the press mirror flips the
          // completed rows.
          if (negativePlates) invertPlateInkRows(rows);
          if (registration && !nativeRegistration) {
            if (customRegistration) await customRegistration.paintRows(rows, rowStart, rowCount, signal);
            else paintRegistrationMarksRows(rows, rowStart, rowCount, width, height, core.registration);
          }
          if (core.output.pressMirror) mirrorRgbaRowsHorizontal(rows, width);
          await encoderRef.current!.writeRows(rows, bandSignal ?? signal);
          report("render", (rowStart + rowCount) / height);
        },
        endPlate: async (_plate, bandSignal) => {
          await encoderRef.current!.end(bandSignal ?? signal);
          await abortable(entryDone!, signal);
          encoderRef.current = null;
          advance("render");
          advance("encode");
        },
      }), signal);
    }
    const manifest = await abortable(
      buildPlateManifestEntry(core, options, target, plates, registration, dpi),
      signal,
    );
    throwIfAborted(signal);
    await abortable(
      archive.addEntry(manifest.name, new TextEncoder().encode(manifest.data)),
      signal,
    );
    await abortable(archive.close(), signal);
    throwIfAborted(signal);
    // COMMIT ARBITRATION — the CAS terminal cell (closeWithArbitration):
    // cancellation stays LIVE through the pending close and wins if it
    // fires first; a close that fulfills first commits atomically in its
    // own continuation, after which cancels are no-ops.
    await closeWithArbitration();
    advance("package");
    return {
      name: targetFileName(target, sourceName, core.separation.mode),
      bytesWritten,
    };
  } catch (error) {
    if (committed) {
      // The file is durably closed; NOTHING here may abort or abandon it.
      // (Only contained/advisory work runs after the commit point, so this
      // is defensive.)
      throw error instanceof ExportError ? error : new ExportError("export-failed", "Export failed", { cause: error });
    }
    const reason = signal.aborted ? new ExportCancelledError() : error;
    encoderRef.current?.abort(reason);
    if (archiveRef.current) await archiveRef.current.abort(reason);
    // NEVER close after a failure: abandon the partial file through the
    // memoized abort. BOUNDED settlement: the caller's ≤250ms cancellation
    // contract must not hinge on a hanging writable.abort — after the
    // bound the abort continues detached (error-contained) and the UA's
    // underlying cleanup may lag.
    await Promise.race([
      abortSink(),
      new Promise<void>((resolve) => setTimeout(resolve, ABORT_SETTLE_BOUND_MS)),
    ]);
    if (signal.aborted) throw new ExportCancelledError();
    if (error instanceof ExportError) throw error;
    throw new ExportError("export-failed", "Export failed", { cause: error });
  } finally {
    customRegistration?.dispose();
    signal.removeEventListener("abort", onAbort);
  }
}

/** Encode a bounded SVG string as conservative UTF-8 chunks. */
function svgTextChunkStream(svg: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal.aborted) {
        controller.error(new ExportCancelledError());
        return;
      }
      if (offset >= svg.length) {
        controller.close();
        return;
      }
      const chunk = svg.slice(offset, offset + SVG_TEXT_CHUNK_CHARS);
      offset += SVG_TEXT_CHUNK_CHARS;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

/**
 * INTERNAL settlement bound for streamed-delivery teardown: deliberately
 * 200ms — under the caller-facing ≤250ms cancellation contract — so
 * dispatch/scheduling overhead on top of the race still lands the
 * END-TO-END observed cancel inside the contract. The detached abort
 * continues with contained errors; UA-level cleanup may lag.
 */
export const ABORT_SETTLE_BOUND_MS = 200;

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

type SaveFilePickerLike = (options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}>;

/** Feature-detected File System Access streaming (Chrome/Edge). */
export function supportsFileSystemAccess(scope: object = globalThis): boolean {
  return "showSaveFilePicker" in scope;
}

export function totalExportBytes(files: ExportFile[]): number {
  return files.reduce((total, file) => total + file.blob.size, 0);
}

export type DeliveryOptions = {
  /** Blob-download fallback sink (anchor download). */
  saveBlob: (file: ExportFile) => void;
  maxBlobBytes?: number;
  /** Injectable for tests; defaults to globalThis.showSaveFilePicker. */
  showSaveFilePicker?: SaveFilePickerLike;
};

/**
 * Delivers finished export files. Uses File System Access when available;
 * otherwise falls back to Blob downloads when the payload fits under the
 * policy cap. Oversized payloads without File System Access fail loudly —
 * never partially.
 */
export async function deliverExportFiles(
  files: ExportFile[],
  options: DeliveryOptions,
): Promise<"file-system-access" | "blob-download"> {
  const maxBlobBytes = options.maxBlobBytes ?? RESOURCE_POLICY.maxBlobDownloadBytes;
  const picker =
    options.showSaveFilePicker ??
    (supportsFileSystemAccess()
      ? ((globalThis as { showSaveFilePicker?: SaveFilePickerLike }).showSaveFilePicker?.bind(
          globalThis,
        ) ?? undefined)
      : undefined);

  if (picker) {
    for (const file of files) {
      const handle = await picker({
        suggestedName: file.name,
        types: [
          {
            accept: {
              [file.blob.type || formatMime("png")]: [`.${file.name.split(".").pop() ?? "bin"}`],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(file.blob);
      await writable.close();
    }
    return "file-system-access";
  }

  if (totalExportBytes(files) > maxBlobBytes) {
    throw new ExportError(
      "export-too-large",
      "This export is larger than the in-memory download limit. Use Chrome or Edge, " +
        "which can stream large exports directly to disk.",
    );
  }
  for (const file of files) options.saveBlob(file);
  return "blob-download";
}
