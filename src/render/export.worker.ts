/**
 * Export render worker (Vite module worker). Consumers construct it with:
 *
 *   new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" })
 *
 * Policy: export jobs freeze their inputs at submit time (buffers transfer
 * with the message, so the worker owns an immutable snapshot of the frozen
 * project revision), queue FIFO, emit progress, and end only on completion,
 * explicit cancel(revision), or error. New preview activity never displaces
 * a running export — exports live in this dedicated worker.
 *
 * Crash replacement: stateless between jobs; on worker error the consumer
 * terminates it, creates a new instance, and reissues the export from its
 * frozen project revision.
 */
import { startWorkerHarness } from "./worker-harness";

startWorkerHarness(
  self as unknown as Parameters<typeof startWorkerHarness>[0],
  "export",
);
