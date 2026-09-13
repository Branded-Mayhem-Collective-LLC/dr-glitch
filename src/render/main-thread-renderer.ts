/**
 * Reduced-performance fallback implementing StreamingRenderPort on the main
 * thread for environments without module workers (or where worker
 * construction failed). Runs the same executor over typed arrays; it never
 * requires OffscreenCanvas — when that API is absent the executor returns
 * per-layer kernel data ("layer-data") and the app's visible canvas draws
 * it, which is exactly the current engine's main-thread drawing model.
 *
 * Streaming export sessions run through the same StreamingExportSession as
 * the export worker (beginExport / submitLayer / finalizeExport), with the
 * same one-session-at-a-time, idle-only policy; single-shot jobs submitted
 * during a session queue and run after it ends. Halftone layers inside a
 * session still need OffscreenCanvas (the session reports
 * "stream-compose-unavailable" otherwise); diffusion-only sessions run
 * everywhere.
 *
 * Time-slicing: work yields to the event loop between layers/plates/bands
 * via setTimeout so pointer interaction stays responsive, at reduced
 * throughput compared to the worker path. Preview semantics match the
 * preview worker: newer revisions supersede in-flight ones at the next
 * yield point.
 */
import { DraftFieldCache } from "./draft";
import { executeRenderJob, RenderJobError } from "./executor";
import { yieldToEventLoop } from "./instrumentation";
import {
  discardPayload,
  type RenderExportBandAckRequest,
  type RenderExportBeginRequest,
  type RenderExportFinalizeRequest,
  type RenderExportLayerRequest,
  type RenderJobRequest,
  type RenderWorkerEvent,
  type Revision,
  type StreamingRenderPort,
} from "./protocol";
import { StreamingExportSession } from "./streaming";

/** Real macrotask yield without the nested-setTimeout 4ms clamp. */
function macrotask(): Promise<void> {
  return yieldToEventLoop();
}

export class MainThreadRenderer implements StreamingRenderPort {
  private readonly listeners = new Set<(event: RenderWorkerEvent) => void>();
  private readonly queue: RenderJobRequest[] = [];
  private readonly cancelled = new Set<Revision>();
  private readonly draftCache = new DraftFieldCache();
  private readonly replaceable: boolean;
  private latestRevision: Revision = -Infinity;
  private running = false;
  private disposed = false;
  private session: StreamingExportSession | null = null;
  private sessionWork: Promise<void> = Promise.resolve();

  /** `replaceable` mirrors the preview worker; pass false for export-style jobs. */
  constructor(replaceable = true) {
    this.replaceable = replaceable;
  }

  submit(job: RenderJobRequest): void {
    if (this.disposed) return;
    if (this.replaceable) {
      this.latestRevision = Math.max(this.latestRevision, job.revision);
      for (const stale of this.queue.splice(0)) {
        this.emit({ type: "cancelled", revision: stale.revision });
      }
    }
    this.queue.push(job);
    void this.runNext();
  }

  beginExport(request: RenderExportBeginRequest): void {
    if (this.disposed) return;
    if (this.session || this.running || this.queue.length > 0) {
      this.emit({
        type: "error",
        revision: request.revision,
        code: "export-session-busy",
        message: "A streaming export session needs an idle renderer.",
      });
      return;
    }
    const created = new StreamingExportSession(request, {
      isCancelled: () => this.disposed || this.cancelled.has(request.revision),
      emit: (event) => this.emit(event),
      yieldPoint: macrotask,
      onEnd: () => {
        if (this.session === created) this.session = null;
        void this.runNext();
      },
    });
    if (created.start()) this.session = created;
  }

  submitLayer(request: RenderExportLayerRequest): void {
    this.routeSessionRequest(request);
  }

  finalizeExport(request: RenderExportFinalizeRequest): void {
    this.routeSessionRequest(request);
  }

  ackBand(request: RenderExportBandAckRequest): void {
    // Credit return for a windowed session; stale/absent sessions ignore it.
    if (this.disposed) return;
    if (this.session && this.session.revision === request.revision) {
      this.session.ackBand();
    }
  }

  cancel(revision: Revision): void {
    this.cancelled.add(revision);
    if (this.session && this.session.revision === revision) this.session.requestCancel();
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].revision === revision) {
        this.queue.splice(index, 1);
        this.emit({ type: "cancelled", revision });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.draftCache.clear();
    this.session?.destroy();
    this.session = null;
    this.emit({ type: "disposed" });
    this.listeners.clear();
  }

  onEvent(listener: (event: RenderWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private routeSessionRequest(request: RenderExportLayerRequest | RenderExportFinalizeRequest): void {
    if (this.disposed) {
      if (request.type === "submit-layer") request.layer.customStamp?.close();
      return;
    }
    const active = this.session;
    if (!active) {
      // A dropped submit-layer still owns its transferred stamp.
      if (request.type === "submit-layer") request.layer.customStamp?.close();
      // Messages racing a cancel are expected; anything else is a bug.
      if (!this.cancelled.has(request.revision)) {
        this.emit({
          type: "error",
          revision: request.revision,
          code: "export-session-missing",
          message: "No open streaming export session for this request.",
        });
      }
      return;
    }
    this.sessionWork = this.sessionWork.then(() => active.handle(request)).catch(() => undefined);
  }

  private emit(event: RenderWorkerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private isStale(revision: Revision): boolean {
    return this.cancelled.has(revision) || (this.replaceable && revision !== this.latestRevision);
  }

  private async runNext(): Promise<void> {
    if (this.running || this.disposed || this.session) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    try {
      if (this.isStale(job.revision)) {
        this.emit({ type: "cancelled", revision: job.revision });
        return;
      }
      const payload = await executeRenderJob(job, {
        isCancelled: () => this.disposed || this.isStale(job.revision),
        onProgress: (phase, plate, ratio) => {
          this.emit({ type: "progress", revision: job.revision, phase, plate, ratio });
        },
        yieldPoint: macrotask,
        draftCache: this.draftCache,
      });
      if (!payload || this.isStale(job.revision) || this.disposed) {
        if (payload) discardPayload(payload);
        this.emit({ type: "cancelled", revision: job.revision });
        return;
      }
      this.emit({ type: "result", revision: job.revision, kind: job.kind, payload });
    } catch (error) {
      const code = error instanceof RenderJobError ? error.code : "job-failed";
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", revision: job.revision, code, message });
    } finally {
      this.cancelled.delete(job.revision);
      this.running = false;
      void this.runNext();
    }
  }
}
