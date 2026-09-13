/**
 * ZIP writing for .drglitch project archives and plate packages via
 * @zip.js/zip.js. Two writers with an explicit DETERMINISM SPLIT:
 *
 * - writeArchive (BUFFERED): entries are written strictly in caller order
 *   with a fixed timestamp, no data descriptors, and no extended metadata,
 *   so identical input bytes produce identical archives. The
 *   archive-determinism tests bind to THIS writer only.
 * - createStreamingArchiveWriter (STREAMING, wave G2): entry data flows
 *   incrementally to a caller-supplied byte sink (an FSA writable) and
 *   sizes/CRCs are unknown up front, so entries carry DATA DESCRIPTORS —
 *   the archive is standards-valid and readable by the hardened reader,
 *   but NOT byte-identical to the buffered writer's output. Streaming is a
 *   delivery form, never a persistence format contract; every determinism
 *   or hash oracle must keep using the buffered writer.
 *
 * Both writers validate entry names like untrusted input (same rules as
 * the hardened reader — defense in depth) and reject case-insensitive
 * duplicate names. No zip64 unless an entry needs it.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { MAX_ZIP_STREAM_CHUNK_BYTES } from "../core/stream-memory";
import { ArchiveValidationError, validateEntryName } from "./zip-reader";

export type ArchiveInputEntry = {
  /** Forward-slash relative path; validated like untrusted input. */
  name: string;
  data: Uint8Array;
  /** Set false for already-compressed payloads (PNG/JPEG/WebP) to store them. */
  compress?: boolean;
};

export type WriteArchiveOptions = {
  /** Deflate level for compressed entries (default 6). */
  level?: number;
  /** Cooperative cancellation for entry reads/deflate and final delivery. */
  signal?: AbortSignal;
  /**
   * Conservative upper bound for the finished archive. Pre-sizing prevents
   * the buffered writer's geometric growth from retaining an extra capacity
   * buffer at peak. Callers must still verify the actual result against the
   * same bound.
   */
  initialCapacityBytes?: number;
};

function throwIfWriteAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Fixed archive timestamp: output must not leak wall-clock time and must be reproducible. */
export const ARCHIVE_EPOCH = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/** Write entries in the given order and return the archive bytes. */
export async function writeArchive(entries: readonly ArchiveInputEntry[], options: WriteArchiveOptions = {}): Promise<Uint8Array> {
  throwIfWriteAborted(options.signal);
  const seen = new Set<string>();
  for (const entry of entries) {
    validateEntryName(entry.name);
    const key = entry.name.normalize("NFC").toLowerCase();
    if (seen.has(key)) {
      throw new ArchiveValidationError("archive-duplicate-entry", `Duplicate entry "${entry.name}" (case-insensitive).`);
    }
    seen.add(key);
  }
  if (
    options.initialCapacityBytes !== undefined &&
    (!Number.isSafeInteger(options.initialCapacityBytes) || options.initialCapacityBytes <= 0)
  ) {
    throw new RangeError("initialCapacityBytes must be a positive safe integer.");
  }
  const writer = new ZipWriter(new Uint8ArrayWriter(options.initialCapacityBytes), {
    useWebWorkers: false,
    keepOrder: true,
    dataDescriptor: false,
    extendedTimestamp: false,
  });
  try {
    for (const entry of entries) {
      throwIfWriteAborted(options.signal);
      await writer.add(entry.name, new Uint8ArrayReader(entry.data), {
        lastModDate: ARCHIVE_EPOCH,
        level: entry.compress === false ? 0 : options.level ?? 6,
        signal: options.signal,
      });
    }
  } catch (error) {
    // On cancellation, do not spend more time finalizing an archive that can
    // never be delivered; all storage is in-memory and becomes collectible.
    if (!options.signal?.aborted) {
      try { await writer.close(); } catch { /* original error wins */ }
    }
    throw error;
  }
  throwIfWriteAborted(options.signal);
  const archive = await writer.close();
  throwIfWriteAborted(options.signal);
  return archive;
}

/* ------------------------------------------------------------------ */
/* Streaming writer (wave G2)                                          */
/* ------------------------------------------------------------------ */

/** Byte sink the streaming writer drains into (an FSA writable wrapper). */
export type ArchiveByteSink = {
  write(chunk: Uint8Array, signal?: AbortSignal): void | Promise<void>;
};

export type StreamingEntryOptions = {
  /** Set false for already-compressed payloads (PNG) to store them. */
  compress?: boolean;
  /** Deflate level for compressed entries (default 6). */
  level?: number;
};

export type StreamingArchiveWriter = {
  /**
   * Add one entry. `data` may be a whole buffer or a ReadableStream whose
   * chunks arrive incrementally (a streaming encoder's output); the
   * returned promise resolves once the entry — including its data
   * descriptor — has been fully drained into the sink.
   *
   * SEQUENTIAL CONTRACT: entries are added strictly one at a time — a
   * second addEntry while one is in flight rejects with
   * "archive-write-conflict" (a byte sink has one write head; interleaved
   * entries would be silent corruption, so the writer refuses instead of
   * queueing).
   */
  addEntry(
    name: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    options?: StreamingEntryOptions,
  ): Promise<void>;
  /** Write the central directory; the archive in the sink is complete. */
  close(): Promise<void>;
  /**
   * Abandon the archive: the internal AbortSignal rejects any in-flight
   * add, NOTHING further is written (in particular the central directory
   * is NEVER finalized — a cancelled archive must end as an aborted
   * partial, never a well-formed truncated ZIP), and the sink's existing
   * bytes are the CALLER's to discard (abort the writable / remove the
   * partial file). Idempotent. Callers abort their own entry-source
   * encoders alongside this so a stalled source settles too.
   */
  abort(reason?: unknown): Promise<void>;
};

/**
 * Streaming archive writer over a byte sink. Entry-by-entry with data
 * descriptors (sizes/CRCs follow the data); see the determinism split in
 * the module header. The fixed ARCHIVE_EPOCH timestamp still applies —
 * streamed archives must not leak wall-clock time either.
 */
export function createStreamingArchiveWriter(
  sink: ArchiveByteSink,
  options: WriteArchiveOptions = {},
): StreamingArchiveWriter {
  const seen = new Set<string>();
  const controller = new AbortController();
  let state: "open" | "closing" | "closed" | "failed" | "aborted" = "open";
  let abortReason: unknown = null;
  let inFlight = false;
  let sinkFailure: unknown = null;
  const writer = new ZipWriter(
    new WritableStream<Uint8Array>({
      async write(chunk) {
        // After abort NOTHING reaches the sink — neither trailing entry
        // bytes nor central-directory/EOCD records.
        if (state === "aborted") throw abortReason;
        const retainedBytes = Math.max(chunk.byteLength, chunk.buffer.byteLength);
        if (retainedBytes > MAX_ZIP_STREAM_CHUNK_BYTES) {
          throw new ArchiveValidationError(
            "archive-entry-too-large",
            `The streaming ZIP writer emitted an over-limit ${retainedBytes}-byte retained chunk.`,
          );
        }
        try {
          await sink.write(chunk, controller.signal);
        } catch (error) {
          sinkFailure = error;
          throw error;
        }
      },
    }),
    {
      useWebWorkers: false,
      keepOrder: true,
      dataDescriptor: true,
      extendedTimestamp: false,
    },
  );
  const asError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));
  const rethrow = (error: unknown): never => {
    // Surface the abort reason or the sink's own failure (writable
    // aborted, disk error) over zip.js's wrapper when they exist.
    if (state === "aborted") throw asError(abortReason);
    throw asError(sinkFailure ?? error);
  };
  const guardOpen = (): void => {
    if (state === "aborted") throw asError(abortReason);
    if (state !== "open") {
      throw new ArchiveValidationError(
        "archive-writer-closed",
        "The streaming archive writer is closed; no further entries or closes are accepted.",
      );
    }
  };
  return {
    async addEntry(name, data, entryOptions = {}) {
      guardOpen();
      if (inFlight) {
        throw new ArchiveValidationError(
          "archive-write-conflict",
          "addEntry called while another entry is still being written; entries are strictly sequential.",
        );
      }
      validateEntryName(name);
      const key = name.normalize("NFC").toLowerCase();
      if (seen.has(key)) {
        throw new ArchiveValidationError(
          "archive-duplicate-entry",
          `Duplicate entry "${name}" (case-insensitive).`,
        );
      }
      seen.add(key);
      const reader = data instanceof Uint8Array ? new Uint8ArrayReader(data) : data;
      inFlight = true;
      try {
        await writer.add(name, reader, {
          lastModDate: ARCHIVE_EPOCH,
          level: entryOptions.compress === false ? 0 : entryOptions.level ?? options.level ?? 6,
          signal: controller.signal,
        });
      } catch (error) {
        rethrow(error);
      } finally {
        inFlight = false;
      }
    },
    async close() {
      guardOpen();
      if (inFlight) {
        throw new ArchiveValidationError(
          "archive-write-conflict",
          "close called while an entry is still being written.",
        );
      }
      state = "closing";
      // Read through a function so control-flow narrowing never hides the
      // concurrent abort()-side transition from the checks below.
      const currentState = (): "open" | "closing" | "closed" | "failed" | "aborted" => state;
      try {
        await writer.close();
        // FIRST-TERMINAL-WINS on the close side too: an abort that landed
        // while the close's final write was pending is terminal — the late
        // close never overwrites aborted with closed or exposes success.
        if (currentState() === "aborted") throw asError(abortReason);
        state = "closed";
      } catch (error) {
        if (currentState() === "closing") state = "failed";
        rethrow(error);
      }
    },
    async abort(reason) {
      // Terminal first-wins: a completed (or failed) close is immutable.
      // Aborting during `closing` still wins and makes that close reject.
      if (state === "aborted" || state === "closed" || state === "failed") return;
      state = "aborted";
      abortReason = reason ?? new Error("Streaming archive aborted");
      // The signal rejects the in-flight add and stops zip.js from pulling
      // its source; the sink guard above blocks every later byte. The
      // underlying writable is aborted by the CALLER (sink owner) — never
      // closed/finalized from here.
      controller.abort(abortReason);
    },
  };
}
