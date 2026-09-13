/**
 * One operation-scoped trust/resource envelope for archive imports.
 *
 * ImportOperation carries ONE wall-clock deadline plus ONE AbortSignal for an
 * entire import: pre-size-gated file read, incremental ZIP extraction,
 * metadata/JSON parsing, hashing, full media validation, staging writes, and
 * the atomic commit all check the SAME budget at every async boundary and
 * inside long loops. Cancellation and timeout surface as the same typed
 * ArchiveValidationError codes ("archive-aborted" / "archive-timeout") no
 * matter which stage they preempt.
 *
 * WorkingSetLedger is the honest memory account for one import: every buffer
 * the operation retains (the resident compressed input INCLUDED — the ZIP
 * reader random-accesses it for the whole operation) is charged against one
 * ceiling, and released as soon as the bytes are handed to the staging sink.
 * `peak` records the true high-water mark so tests can prove the streaming
 * window instead of trusting a comment.
 */

export type ArchiveErrorCode =
  | "archive-invalid"
  | "archive-ambiguous"
  | "archive-too-large"
  | "archive-entry-count"
  | "archive-bad-filename"
  | "archive-filename-encoding"
  | "archive-duplicate-entry"
  | "archive-encrypted"
  | "archive-entry-overlap"
  | "archive-entry-too-large"
  | "archive-uncompressed-quota"
  | "archive-working-set"
  | "archive-size-mismatch"
  | "archive-crc-mismatch"
  | "archive-timeout"
  | "archive-aborted"
  /* Streaming writer state guards (wave G2, zip-writer.ts). */
  | "archive-writer-closed"
  | "archive-write-conflict";

export class ArchiveValidationError extends Error {
  readonly code: ArchiveErrorCode;
  constructor(code: ArchiveErrorCode, message: string) {
    super(message);
    this.name = "ArchiveValidationError";
    this.code = code;
  }
}

function fail(code: ArchiveErrorCode, message: string): never {
  throw new ArchiveValidationError(code, message);
}

export type ImportOperationOptions = {
  /** External cancellation (UI cancel button); combined with the deadline. */
  signal?: AbortSignal;
  /** Wall-clock budget for the WHOLE operation. */
  timeoutMs: number;
};

/**
 * Deadline + cancellation for one whole import. Timers can starve while
 * decompression/hashing stays on the microtask queue, so the deadline is
 * also enforced inline by checkpoint() at every step — the timer merely
 * aborts in-flight zip.js/decoder work early via `signal`.
 */
export class ImportOperation {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly externalSignal: AbortSignal | null;
  private readonly onExternalAbort = (): void => this.controller.abort();
  private timedOutFlag = false;
  readonly deadline: number;

  constructor(options: ImportOperationOptions) {
    this.deadline = Date.now() + options.timeoutMs;
    this.externalSignal = options.signal ?? null;
    if (this.externalSignal) {
      if (this.externalSignal.aborted) this.controller.abort();
      else this.externalSignal.addEventListener("abort", this.onExternalAbort, { once: true });
    }
    this.timer = setTimeout(() => this.markTimedOut(), options.timeoutMs);
  }

  /** Abort signal for in-flight async work (zip.js getData, decoders). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get timedOut(): boolean {
    return this.timedOutFlag || Date.now() > this.deadline;
  }

  /** Record that the deadline passed and abort in-flight work. */
  markTimedOut(): void {
    this.timedOutFlag = true;
    this.controller.abort();
  }

  /**
   * Enforce the budget NOW. Called at every async boundary and inside long
   * loops (per archive entry, per hash chunk, around every decoder call and
   * staging write). Deadline wins over external abort, matching the
   * streaming extractor's historical behavior.
   */
  checkpoint(): void {
    if (this.timedOutFlag || Date.now() > this.deadline) {
      this.markTimedOut();
      fail("archive-timeout", "Archive processing exceeded the time budget.");
    }
    if (this.externalSignal?.aborted || this.controller.signal.aborted) {
      fail("archive-aborted", "Archive processing was aborted.");
    }
  }

  /** Release the timer and external-signal listener. Idempotent. */
  dispose(): void {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
  }
}

/**
 * Honest retained-bytes account for one import. Charge every buffer the
 * operation keeps alive (compressed input included) and release each one the
 * moment it is handed off; exceeding `maxBytes` is a typed
 * "archive-working-set" rejection BEFORE the offending allocation is used.
 */
export class WorkingSetLedger {
  private retainedBytes = 0;
  private peakBytes = 0;

  constructor(readonly maxBytes: number) {}

  /** Bytes currently charged to the operation. */
  get retained(): number {
    return this.retainedBytes;
  }

  /** True high-water mark over the operation's lifetime (tests assert this). */
  get peak(): number {
    return this.peakBytes;
  }

  /** Would retaining `extraBytes` more push the account past the ceiling? */
  wouldExceed(extraBytes: number): boolean {
    return this.retainedBytes + extraBytes > this.maxBytes;
  }

  /** Charge `byteLength` retained bytes; throws when the ceiling is crossed. */
  retain(byteLength: number, what: string): void {
    const prospective = this.retainedBytes + byteLength;
    if (prospective > this.maxBytes) {
      fail(
        "archive-working-set",
        `"${what}" pushed the import past the ${this.maxBytes}-byte working-memory ceiling.`,
      );
    }
    // Mutate only after admission succeeds. A rejected retain must not poison
    // the account or inflate its measured high-water mark.
    this.retainedBytes = prospective;
    if (prospective > this.peakBytes) this.peakBytes = prospective;
  }

  /** Release previously retained bytes (handed to the sink or discarded). */
  release(byteLength: number): void {
    this.retainedBytes = Math.max(0, this.retainedBytes - byteLength);
  }
}
