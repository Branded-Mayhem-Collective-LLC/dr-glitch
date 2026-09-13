/**
 * Preview render worker (Vite module worker). Consumers construct it with:
 *
 *   new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" })
 *
 * Policy: preview jobs are replaceable — a newer revision supersedes older
 * ones and stale results are discarded/closed, never delivered. OffscreenCanvas
 * and createImageBitmap are feature-detected in the executor; without them the
 * worker returns typed-array layer data for main-thread drawing.
 *
 * Crash replacement: this worker is stateless between jobs. On worker error,
 * the consumer terminates it, creates a new instance, and resubmits the
 * latest revision.
 */
import { startWorkerHarness } from "./worker-harness";

startWorkerHarness(
  self as unknown as Parameters<typeof startWorkerHarness>[0],
  "preview",
);
