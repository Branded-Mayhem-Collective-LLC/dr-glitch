/**
 * WorkerRenderPort — RenderPort client over the preview render worker.
 *
 * Wraps a Worker-like message channel in the protocol's port interface so
 * consumers (PreviewService) never touch Worker directly and the
 * MainThreadRenderer fallback stays interchangeable. Submit transfers the
 * job's raster buffers and custom stamps (jobTransferables).
 *
 * Crash replacement: workers keep no state a consumer cannot rebuild. When
 * the worker errors at the channel level, this port terminates it, emits a
 * `worker-crashed` error event (revision null), and lazily constructs a
 * fresh worker on the next submit. The consumer owns resubmission of its
 * latest revision (PreviewService rebuilds the job — transferred buffers
 * cannot be replayed).
 */

import {
  exportLayerTransferables,
  jobTransferables,
  type RenderExportBandAckRequest,
  type RenderExportBeginRequest,
  type RenderExportFinalizeRequest,
  type RenderExportLayerRequest,
  type RenderJobRequest,
  type RenderPort,
  type RenderWorkerEvent,
  type Revision,
  type StreamingRenderPort,
} from "../render";

/** The subset of Worker this port needs; tests can fake it. */
export type PreviewWorkerLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

/** Construct the real preview module worker (browser only). */
export function createPreviewWorker(): PreviewWorkerLike {
  return new Worker(new URL("../render/preview.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as PreviewWorkerLike;
}

/** Construct the real export module worker (browser only). */
export function createExportWorker(): PreviewWorkerLike {
  return new Worker(new URL("../render/export.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as PreviewWorkerLike;
}

export class WorkerRenderPort implements RenderPort {
  private readonly listeners = new Set<(event: RenderWorkerEvent) => void>();
  private worker: PreviewWorkerLike | null = null;
  private disposed = false;

  constructor(private readonly factory: () => PreviewWorkerLike) {}

  private ensureWorker(): PreviewWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.factory();
    worker.onmessage = (event) => this.emit(event.data as RenderWorkerEvent);
    worker.onerror = () => {
      // The worker is unusable; replace it lazily on the next submit and
      // tell the consumer so it can resubmit its latest revision.
      this.teardownWorker();
      this.emit({
        type: "error",
        revision: null,
        code: "worker-crashed",
        message: "The preview render worker crashed and was replaced.",
      });
    };
    this.worker = worker;
    return worker;
  }

  private teardownWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private emit(event: RenderWorkerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Post a raw protocol request (streaming subclass reuses this). */
  protected post(message: unknown, transfer?: Transferable[]): void {
    if (this.disposed) return;
    this.ensureWorker().postMessage(message, transfer);
  }

  submit(job: RenderJobRequest): void {
    this.post(job, jobTransferables(job));
  }

  cancel(revision: Revision): void {
    if (this.disposed || !this.worker) return;
    this.worker.postMessage({ type: "cancel", revision });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.teardownWorker();
    }
    this.emit({ type: "disposed" });
    this.listeners.clear();
  }

  onEvent(listener: (event: RenderWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/**
 * StreamingRenderPort client over the export worker: the same contract the
 * MainThreadRenderer implements directly, realized by postMessage-ing the
 * session requests (submit-layer transfers its raster/stamp buffers).
 */
export class StreamingWorkerRenderPort
  extends WorkerRenderPort
  implements StreamingRenderPort
{
  beginExport(request: RenderExportBeginRequest): void {
    this.post(request);
  }

  submitLayer(request: RenderExportLayerRequest): void {
    this.post(request, exportLayerTransferables(request));
  }

  finalizeExport(request: RenderExportFinalizeRequest): void {
    this.post(request);
  }

  ackBand(request: RenderExportBandAckRequest): void {
    this.post(request);
  }
}
