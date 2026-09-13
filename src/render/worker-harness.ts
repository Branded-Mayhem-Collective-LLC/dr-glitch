/**
 * Message-loop harness shared by preview.worker.ts and export.worker.ts.
 * The two workers differ only in replacement policy:
 *
 * - "preview": jobs are replaceable. A newer revision supersedes any
 *   in-flight or queued job; superseded work aborts at the next yield point
 *   and its results are discarded (bitmaps closed), never delivered.
 * - "export": jobs are frozen. They queue FIFO, run to completion with
 *   progress, and end only via explicit cancel(revision) or error. Export
 *   harnesses additionally host streaming export sessions (begin-export /
 *   submit-layer / finalize-export; see streaming.ts): one session at a
 *   time, opened only while the worker is idle; single-shot jobs submitted
 *   during a session queue and run after it ends.
 *
 * Crash replacement: the harness holds no document state — every job is
 * self-contained and a session can be reopened from the consumer's frozen
 * revision — so consumers recover from a dead worker by terminating it,
 * constructing a fresh one, and resubmitting their latest revision.
 */
import { DraftFieldCache } from "./draft";
import { executeRenderJob, RenderJobError } from "./executor";
import { yieldToEventLoop } from "./instrumentation";
import {
  discardPayload,
  payloadTransferables,
  type RenderJobRequest,
  type RenderWorkerEvent,
  type RenderWorkerRequest,
  type Revision,
} from "./protocol";
import { StreamingExportSession } from "./streaming";

export type HarnessMode = "preview" | "export";

type PostMessageScope = {
  postMessage: (message: RenderWorkerEvent, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

/**
 * Yield to the worker macrotask queue so cancel/supersede messages arrive.
 * MessageChannel-based (yieldToEventLoop): chunked kernels yield thousands
 * of times per full-sheet job, and nested setTimeout(0) is clamped to ~4ms
 * past depth 5 — which alone would add seconds per export and break the
 * draft latency budget.
 */
function macrotask(): Promise<void> {
  return yieldToEventLoop();
}

export function startWorkerHarness(scope: PostMessageScope, mode: HarnessMode): void {
  const queue: RenderJobRequest[] = [];
  const cancelled = new Set<Revision>();
  const draftCache = new DraftFieldCache();
  let latestRevision: Revision = -Infinity;
  let running = false;
  let disposed = false;
  let session: StreamingExportSession | null = null;
  let sessionWork: Promise<void> = Promise.resolve();

  const isStale = (revision: Revision) =>
    cancelled.has(revision) || (mode === "preview" && revision !== latestRevision);

  const runNext = async (): Promise<void> => {
    if (running || disposed || session) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    try {
      if (isStale(job.revision)) {
        scope.postMessage({ type: "cancelled", revision: job.revision });
        return;
      }
      const payload = await executeRenderJob(job, {
        isCancelled: () => disposed || isStale(job.revision),
        onProgress: (phase, plate, ratio) => {
          scope.postMessage({ type: "progress", revision: job.revision, phase, plate, ratio });
        },
        yieldPoint: macrotask,
        draftCache,
      });
      if (!payload) {
        scope.postMessage({ type: "cancelled", revision: job.revision });
        return;
      }
      if (isStale(job.revision) || disposed) {
        discardPayload(payload);
        scope.postMessage({ type: "cancelled", revision: job.revision });
        return;
      }
      scope.postMessage(
        { type: "result", revision: job.revision, kind: job.kind, payload },
        payloadTransferables(payload),
      );
    } catch (error) {
      const code = error instanceof RenderJobError ? error.code : "job-failed";
      const message = error instanceof Error ? error.message : String(error);
      scope.postMessage({ type: "error", revision: job.revision, code, message });
    } finally {
      cancelled.delete(job.revision);
      running = false;
      void runNext();
    }
  };

  scope.onmessage = (event: MessageEvent) => {
    const request = event.data as RenderWorkerRequest;
    if (request.type === "dispose") {
      disposed = true;
      queue.length = 0;
      draftCache.clear();
      session?.destroy();
      session = null;
      scope.postMessage({ type: "disposed" });
      return;
    }
    if (request.type === "cancel") {
      cancelled.add(request.revision);
      if (session && session.revision === request.revision) session.requestCancel();
      // Drop queued (not yet running) instances immediately.
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].revision === request.revision) {
          queue.splice(index, 1);
          scope.postMessage({ type: "cancelled", revision: request.revision });
        }
      }
      return;
    }
    if (request.type === "begin-export") {
      if (disposed) return;
      if (mode !== "export") {
        scope.postMessage({
          type: "error",
          revision: request.revision,
          code: "export-session-unsupported",
          message: "Streaming export sessions run only on export workers.",
        });
        return;
      }
      if (session || running || queue.length > 0) {
        scope.postMessage({
          type: "error",
          revision: request.revision,
          code: "export-session-busy",
          message: "A streaming export session needs an idle export worker.",
        });
        return;
      }
      const created = new StreamingExportSession(request, {
        isCancelled: () => disposed || cancelled.has(request.revision),
        emit: (message, transfer) => scope.postMessage(message, transfer),
        yieldPoint: macrotask,
        onEnd: () => {
          if (session === created) session = null;
          void runNext();
        },
      });
      if (created.start()) session = created;
      return;
    }
    if (request.type === "band-ack") {
      // Credit return for a windowed session; stale/absent sessions ignore
      // it (band-acks racing a cancel or session end are expected).
      if (!disposed && session && session.revision === request.revision) {
        session.ackBand();
      }
      return;
    }
    if (request.type === "submit-layer" || request.type === "finalize-export") {
      if (disposed) {
        if (request.type === "submit-layer") request.layer.customStamp?.close();
        return;
      }
      const active = session;
      if (!active) {
        // A dropped submit-layer still owns its transferred stamp.
        if (request.type === "submit-layer") request.layer.customStamp?.close();
        // Messages racing a cancel are expected; anything else is a bug.
        if (!cancelled.has(request.revision)) {
          scope.postMessage({
            type: "error",
            revision: request.revision,
            code: "export-session-missing",
            message: "No open streaming export session for this request.",
          });
        }
        return;
      }
      sessionWork = sessionWork.then(() => active.handle(request)).catch(() => undefined);
      return;
    }
    if (request.type === "job") {
      if (disposed) return;
      if (mode === "preview") {
        latestRevision = Math.max(latestRevision, request.revision);
        // Replaceable: anything still queued is already superseded.
        for (const stale of queue.splice(0)) {
          scope.postMessage({ type: "cancelled", revision: stale.revision });
        }
      }
      queue.push(request);
      void runNext();
    }
  };
}
