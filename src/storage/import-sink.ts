/**
 * Adapter binding the io importer's StagingSink boundary to this
 * subsystem's atomic ImportStaging. One adapter serves one import: the io
 * side allocates, streams validated assets, then commits the rebuilt
 * envelope; we stage everything and install atomically. The io-assigned
 * project id stays authoritative — the injected id hook hands it to
 * ImportStaging's commit so the installed envelope keeps the id the
 * importer returned.
 */
import type { StagingSink } from "../io/drglitch";
import type { AssetRecordV1, Id, ProjectEnvelopeV1 } from "../core/types";
import { createId } from "../core/id";
import type { StorageBackend } from "./backend";
import { ImportStaging, type StagingHandle } from "./staging";
import { StorageError } from "./errors";

export class StorageStagingSink implements StagingSink {
  private handle: StagingHandle | null = null;
  private commitProjectId: Id | null = null;
  private readonly staging: ImportStaging;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly lifecycleAbort = new AbortController();
  private state: "open" | "committing" | "committed" | "aborting" | "aborted" = "open";
  private abortPromise: Promise<void> | null = null;

  /** The atomically installed envelope, set once commit succeeds. */
  installed: ProjectEnvelopeV1 | null = null;

  constructor(backend: StorageBackend) {
    this.staging = new ImportStaging(backend, {
      newId: () => this.commitProjectId ?? createId(),
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private linkedSignal(external?: AbortSignal): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const removers: Array<() => void> = [];
    for (const upstream of [this.lifecycleAbort.signal, ...(external ? [external] : [])]) {
      const forward = () => controller.abort(upstream.reason);
      if (upstream.aborted) forward();
      else {
        upstream.addEventListener("abort", forward, { once: true });
        removers.push(() => upstream.removeEventListener("abort", forward));
      }
    }
    return {
      signal: controller.signal,
      dispose: () => removers.splice(0).forEach((remove) => remove()),
    };
  }

  private assertOpen(): void {
    if (this.state === "aborted" || this.state === "aborting") {
      throw new StorageError("staging-aborted", "Import staging was already aborted.");
    }
    if (this.state === "committed") {
      throw new StorageError("staging-committed", "Import staging was already committed.");
    }
  }

  allocate(
    _plan?: { projectId: Id; assetCount: number; totalAssetBytes: number },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.handle) {
        throw new StorageError("staging-already-allocated", "Import staging already allocated.");
      }
      const linked = this.linkedSignal(signal);
      try {
        this.handle = await this.staging.begin(linked.signal);
      } finally {
        linked.dispose();
      }
    });
  }

  write(record: AssetRecordV1, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!this.handle) {
        throw new StorageError("staging-not-allocated", "Import staging not allocated.");
      }
      const linked = this.linkedSignal(signal);
      try {
        // Blob snapshots its BlobPart by contract. Passing the exact view
        // removes the former explicit ArrayBuffer allocation + JS copy; the
        // import ledger conservatively accounts for an implementation copy
        // during this await.
        const blob = new Blob([bytes as unknown as BlobPart], { type: record.mime });
        await this.handle.stageAsset(record, blob, linked.signal);
      } finally {
        linked.dispose();
      }
    });
  }

  commit(envelope: ProjectEnvelopeV1, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!this.handle) {
        throw new StorageError("staging-not-allocated", "Import staging not allocated.");
      }
      this.state = "committing";
      const linked = this.linkedSignal(signal);
      try {
        await this.handle.stageProject(envelope, linked.signal);
        this.commitProjectId = envelope.id;
        const installed = await this.handle.commit({ signal: linked.signal });
        // ImportStaging returns only after the backend transaction's atomic
        // commit settles. This assignment and state transition are therefore
        // terminal success; a queued abort must not delete or relabel it.
        this.installed = installed;
        this.handle = null;
        this.state = "committed";
      } catch (error) {
        if (this.state === "committing") this.state = "open";
        throw error;
      } finally {
        this.commitProjectId = null;
        linked.dispose();
      }
    });
  }

  abort(reason?: unknown): Promise<void> {
    // Interrupt an in-flight allocate/write/commit immediately. Cleanup is
    // serialized behind that mutation so no late continuation can recreate a
    // row after the staging area has been removed.
    this.lifecycleAbort.abort(reason);
    if (this.abortPromise) return this.abortPromise;
    const cleanup = this.enqueue(async () => {
      if (this.state === "committed" || this.state === "aborted") return;
      const handle = this.handle;
      this.state = "aborting";
      if (handle) await handle.abort();
      // Retire the handle only after cleanup succeeds. A rejected cleanup
      // keeps the real handle reachable so a later abort/dispose retry can
      // purge the rows instead of silently becoming a no-op.
      this.handle = null;
      this.state = "aborted";
    });
    this.abortPromise = cleanup.then(
      () => undefined,
      (error: unknown) => {
        this.abortPromise = null;
        throw error;
      },
    );
    return this.abortPromise;
  }
}
