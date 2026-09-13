/**
 * Hardened ZIP reading over @zip.js/zip.js. Every archive that reaches the
 * app goes through this module, which enforces:
 *
 * - compressed size and entry-count quotas before extraction,
 * - strict filename validation (no absolute paths, "..", backslashes, drive
 *   letters, control characters; UTF-8 only; case-insensitive duplicates),
 * - encrypted entries rejected,
 * - zip.js strictness "strict": ambiguous archives another tool could parse
 *   differently are rejected (prepended/appended data, trailing central-
 *   directory data, multiple end-of-central-directory records, raw duplicate
 *   names, and local headers disagreeing with the central directory),
 * - overlapping local-entry data ranges rejected (zip.js checkOverlappingEntry;
 *   a central directory whose records alias each other's bytes is an attack),
 * - CRC-32 verification on every entry,
 * - per-entry and cumulative uncompressed quotas enforced DURING streaming
 *   extraction (decompression-bomb defense: lying headers cannot help),
 * - a working-set ceiling on the bytes retained in memory for one archive,
 * - an overall timeout plus an injectable AbortSignal (ImportOperation).
 *
 * Two extraction APIs share one validation core:
 *
 * readArchive() inflates EVERY entry up front and retains them all (Map),
 * with the whole declared total bounded by the working-set ceiling. It suits
 * small archives and tooling/tests.
 *
 * openArchiveStream() is the importer's API: entries inflate ONE AT A TIME on
 * demand, each into a single exact-size buffer charged against an injected
 * WorkingSetLedger (which already carries the resident compressed input), and
 * released the moment the caller hands the bytes onward. The retained peak is
 * therefore compressed input + a bounded streaming window — never the sum of
 * all inflated entries.
 *
 * All rejections are typed ArchiveValidationError values with stable codes.
 */
import {
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_ENCRYPTED,
  ERR_INVALID_CRC32,
  ERR_INVALID_PASSWORD,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_OVERLAPPING_ENTRY,
  ERR_UNSAFE_FILENAME,
  Uint8ArrayReader,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import { RESOURCE_POLICY, type ResourcePolicy } from "../core/resource-policy";
import {
  ArchiveValidationError,
  ImportOperation,
  WorkingSetLedger,
  type ArchiveErrorCode,
} from "./operation";

export { ArchiveValidationError, ImportOperation, WorkingSetLedger };
export type { ArchiveErrorCode };

export type ArchivePolicy = Pick<
  ResourcePolicy,
  "maxArchiveEntries" | "maxArchiveCompressedBytes" | "maxArchiveUncompressedBytes"
>;

export type ReadArchiveOptions = {
  policy?: ArchivePolicy;
  /** External cancellation; combined with the internal timeout. */
  signal?: AbortSignal;
  /** Overall wall-clock budget for the whole archive. */
  timeoutMs?: number;
  /**
   * Ceiling on the total uncompressed bytes this call may retain in memory
   * for one archive (default {@link DEFAULT_MAX_WORKING_SET_BYTES}). This is
   * the io-layer working-memory budget for a single read-everything call;
   * ResourcePolicy.maxArchiveUncompressedBytes remains the absolute cap on
   * what an archive may declare/inflate and is enforced independently.
   * Enforced against declared sizes up front AND against actually streamed
   * bytes during extraction, so lying headers cannot evade it.
   */
  maxWorkingSetBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/** Default per-import working-memory ceiling: 512 MiB of retained bytes. */
export const DEFAULT_MAX_WORKING_SET_BYTES = 512 * 1024 * 1024;
const MAX_NAME_LENGTH = 512;

function fail(code: ArchiveErrorCode, message: string): never {
  throw new ArchiveValidationError(code, message);
}

/**
 * Validate one archive entry name. Directories may pass names with one
 * trailing slash. Exported for zip-writer (defense in depth) and tests.
 */
export function validateEntryName(name: string, { directory = false }: { directory?: boolean } = {}): void {
  if (!name || name.length > MAX_NAME_LENGTH) fail("archive-bad-filename", "Entry name is empty or too long.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) fail("archive-bad-filename", "Entry name contains control characters.");
  if (name.includes("\\")) fail("archive-bad-filename", `Backslash path "${name}" is rejected.`);
  if (name.startsWith("/")) fail("archive-bad-filename", `Absolute path "${name}" is rejected.`);
  if (/^[a-z]:/i.test(name)) fail("archive-bad-filename", `Drive-letter path "${name}" is rejected.`);
  const path = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (!path) fail("archive-bad-filename", "Entry name is empty.");
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail("archive-bad-filename", `Traversal or empty segment in "${name}" is rejected.`);
    }
  }
}

/** Case-insensitive, unicode-normalized duplicate key. */
function duplicateKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function utf8Name(entry: Entry): string {
  const raw = entry.rawFilename;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("archive-filename-encoding", "Entry name is not valid UTF-8.");
  }
}

function translate(error: unknown, timedOut: () => boolean): never {
  if (error instanceof ArchiveValidationError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === ERR_INVALID_CRC32 || /crc32/i.test(message)) {
    fail("archive-crc-mismatch", "Entry data failed CRC verification.");
  }
  if (message === ERR_INVALID_UNCOMPRESSED_SIZE || /uncompressed size/i.test(message)) {
    fail("archive-size-mismatch", "Entry data does not match its declared size.");
  }
  if (message === ERR_UNSAFE_FILENAME || /unsafe filename/i.test(message)) {
    fail("archive-bad-filename", "The archive contains an unsafe entry name.");
  }
  if (message === ERR_OVERLAPPING_ENTRY || /overlapping entry/i.test(message)) {
    fail("archive-entry-overlap", "The archive contains entries whose data ranges overlap.");
  }
  if (message === ERR_AMBIGUOUS_ARCHIVE || /ambiguous/i.test(message)) {
    fail("archive-ambiguous", "The archive is ambiguous: another tool could parse it differently.");
  }
  if (message === ERR_ENCRYPTED || message === ERR_INVALID_PASSWORD || /encrypted/i.test(message)) {
    fail("archive-encrypted", "Encrypted archives are not supported.");
  }
  if ((error instanceof DOMException && error.name === "AbortError") || /abort/i.test(message)) {
    if (timedOut()) fail("archive-timeout", "Archive processing exceeded the time budget.");
    fail("archive-aborted", "Archive processing was aborted.");
  }
  fail("archive-invalid", `The archive is invalid: ${message}`);
}

/** One validated, extractable central-directory record. */
type ScannedEntry = { entry: FileEntry; name: string; declared: number };

/**
 * strictness "strict" rejects any archive another tool could interpret
 * differently (prepended/appended data, trailing central-directory data,
 * multiple end-of-central-directory records, raw duplicate names, and any
 * local header disagreeing with its central-directory record).
 * checkOverlappingEntry makes zip.js compare every entry's local data range
 * (local header through data descriptor) against every range already read
 * and throw ERR_OVERLAPPING_ENTRY on intersection; both extraction APIs read
 * every non-directory entry of an ACCEPTED archive, so any pairwise overlap
 * is caught before acceptance.
 */
function openReader(bytes: Uint8Array): ZipReader<unknown> {
  return new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    strictness: "strict",
    checkOverlappingEntry: true,
  });
}

/**
 * Read and validate the central directory: names, duplicates, encryption,
 * per-entry and cumulative DECLARED-size quotas (policy only — working-set
 * ceilings are per-API). Returns non-directory entries in archive order.
 */
async function scanEntries(
  reader: ZipReader<unknown>,
  policy: ArchivePolicy,
  timedOut: () => boolean,
): Promise<ScannedEntry[]> {
  let entries: Entry[];
  try {
    entries = await reader.getEntries();
  } catch (error) {
    translate(error, timedOut);
  }
  if (entries.length > policy.maxArchiveEntries) {
    fail("archive-entry-count", `The archive exceeds ${policy.maxArchiveEntries} entries.`);
  }
  const seen = new Set<string>();
  let declaredTotal = 0;
  const scanned: ScannedEntry[] = [];
  for (const entry of entries) {
    const name = utf8Name(entry);
    validateEntryName(name, { directory: entry.directory });
    const key = duplicateKey(entry.directory ? name.replace(/\/$/, "") : name);
    if (seen.has(key)) fail("archive-duplicate-entry", `Duplicate entry "${name}" (case-insensitive).`);
    seen.add(key);
    if (entry.encrypted) fail("archive-encrypted", `Entry "${name}" is encrypted.`);
    if (entry.directory) continue;
    if (entry.uncompressedSize > policy.maxArchiveUncompressedBytes) {
      fail("archive-entry-too-large", `Entry "${name}" declares more than ${policy.maxArchiveUncompressedBytes} bytes.`);
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > policy.maxArchiveUncompressedBytes) {
      fail("archive-uncompressed-quota", "The archive declares more uncompressed data than allowed.");
    }
    scanned.push({ entry, name, declared: entry.uncompressedSize });
  }
  return scanned;
}

/**
 * Inflate one entry into ONE exact-size buffer (no chunk list plus
 * contiguous copy), enforcing the deadline and the caller's quota checks on
 * every streamed chunk so lying size fields cannot smuggle a decompression
 * bomb past the headers.
 */
async function inflateEntry(
  scanned: ScannedEntry,
  operation: ImportOperation,
  onChunk: (prospectiveEntryBytes: number) => void,
): Promise<Uint8Array> {
  const { entry, name, declared } = scanned;
  const data = new Uint8Array(declared);
  let written = 0;
  // zip.js may wrap stream errors; keep ours so the typed code survives.
  let violation: ArchiveValidationError | null = null;
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      const next = written + chunk.length;
      try {
        if (Date.now() > operation.deadline) {
          operation.markTimedOut();
          fail("archive-timeout", "Archive processing exceeded the time budget.");
        }
        onChunk(next);
        if (next > declared) {
          fail("archive-size-mismatch", `Entry "${name}" inflated past its declared size during extraction.`);
        }
      } catch (error) {
        if (error instanceof ArchiveValidationError) violation = error;
        throw error;
      }
      data.set(chunk, written);
      written = next;
    },
  });
  try {
    await entry.getData(sink, { checkSignature: true, signal: operation.signal, useWebWorkers: false });
  } catch (error) {
    if (violation) throw violation;
    translate(error, () => operation.timedOut);
  }
  if (written !== declared) {
    fail("archive-size-mismatch", `Entry "${name}" does not match its declared size.`);
  }
  return data;
}

/**
 * Read and fully validate an untrusted ZIP archive into memory. Returns the
 * entries in archive order as name -> bytes. Directory entries are validated
 * and counted but carry no data. Retains ALL inflated entries at once — the
 * declared total is bounded by `maxWorkingSetBytes`; importers needing a
 * bounded streaming window use {@link openArchiveStream} instead.
 */
export async function readArchive(bytes: Uint8Array, options: ReadArchiveOptions = {}): Promise<Map<string, Uint8Array>> {
  const policy = options.policy ?? RESOURCE_POLICY;
  const maxWorkingSetBytes = options.maxWorkingSetBytes ?? DEFAULT_MAX_WORKING_SET_BYTES;
  if (bytes.length > policy.maxArchiveCompressedBytes) {
    fail("archive-too-large", `The archive exceeds ${policy.maxArchiveCompressedBytes} compressed bytes.`);
  }
  const operation = new ImportOperation({
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const reader = openReader(bytes);
  try {
    operation.checkpoint();
    const scanned = await scanEntries(reader, policy, () => operation.timedOut);
    let declaredTotal = 0;
    for (const { name, declared } of scanned) {
      declaredTotal += declared;
      if (declaredTotal > maxWorkingSetBytes) {
        fail("archive-working-set", `Entry "${name}" pushes the archive past the ${maxWorkingSetBytes}-byte working-memory ceiling for one call.`);
      }
    }
    const result = new Map<string, Uint8Array>();
    let streamedTotal = 0;
    for (const item of scanned) {
      operation.checkpoint();
      const data = await inflateEntry(item, operation, (next) => {
        if (streamedTotal + next > policy.maxArchiveUncompressedBytes) {
          fail("archive-uncompressed-quota", `Entry "${item.name}" pushed the archive past its uncompressed quota during extraction.`);
        }
        if (streamedTotal + next > maxWorkingSetBytes) {
          fail("archive-working-set", `Entry "${item.name}" pushed the call past its working-memory ceiling during extraction.`);
        }
      });
      streamedTotal += data.length;
      result.set(item.name, data);
    }
    return result;
  } finally {
    operation.dispose();
    try { await reader.close(); } catch { /* reader already failed; original error wins */ }
  }
}

export type ArchiveStreamOptions = {
  policy?: ArchivePolicy;
  /** The ONE operation budget shared by the whole import. */
  operation: ImportOperation;
  /**
   * The import's retained-bytes account. The caller must already have
   * charged the resident compressed input; every read() charges the entry's
   * declared size BEFORE allocating and release() refunds it once the bytes
   * are handed onward.
   */
  ledger: WorkingSetLedger;
};

/**
 * Handle over one validated archive: entries inflate one at a time via
 * read() and stay charged to the ledger until release(). Each entry may be
 * extracted at most once (the strict importer reads every entry of an
 * accepted archive exactly once, which also completes the pairwise
 * overlapping-range check).
 */
export type ArchiveStream = {
  /** Non-directory entry names in archive order. */
  readonly names: readonly string[];
  has(name: string): boolean;
  /** Declared uncompressed size — for byte caps BEFORE extraction. */
  sizeOf(name: string): number;
  /** Inflate one entry into one exact-size ledger-charged buffer. */
  read(name: string): Promise<Uint8Array>;
  /** Refund a previously read entry's bytes from the ledger. Idempotent. */
  release(name: string): void;
  close(): Promise<void>;
};

/**
 * Open an untrusted ZIP for windowed extraction. All central-directory
 * validation (names, duplicates, encryption, declared-size quotas) happens
 * up front; the working-set ceiling is enforced up front against
 * compressed-input + largest single entry and again on every actual
 * allocation, so the retained peak stays at compressed input + a bounded
 * streaming window.
 */
export async function openArchiveStream(bytes: Uint8Array, options: ArchiveStreamOptions): Promise<ArchiveStream> {
  const policy = options.policy ?? RESOURCE_POLICY;
  const { operation, ledger } = options;
  if (bytes.length > policy.maxArchiveCompressedBytes) {
    fail("archive-too-large", `The archive exceeds ${policy.maxArchiveCompressedBytes} compressed bytes.`);
  }
  const reader = openReader(bytes);
  let scanned: ScannedEntry[];
  try {
    operation.checkpoint();
    scanned = await scanEntries(reader, policy, () => operation.timedOut);
    // Fail BEFORE any extraction when even the largest single entry cannot
    // fit in the window next to what the ledger already retains (the
    // resident compressed input): the sink must never see a doomed import.
    let largest = 0;
    for (const { declared } of scanned) largest = Math.max(largest, declared);
    if (ledger.wouldExceed(largest)) {
      fail("archive-working-set", `The archive's largest entry (${largest} bytes) cannot fit inside the ${ledger.maxBytes}-byte working-memory ceiling alongside the retained compressed input.`);
    }
  } catch (error) {
    try { await reader.close(); } catch { /* original error wins */ }
    throw error;
  }
  type EntryState = ScannedEntry & { state: "unread" | "retained" | "released" };
  const byName = new Map<string, EntryState>(
    scanned.map((item) => [item.name, { ...item, state: "unread" as const }]),
  );
  let streamedTotal = 0;
  let closed = false;
  const lookup = (name: string): EntryState => {
    const item = byName.get(name);
    if (!item) fail("archive-invalid", `The archive has no entry "${name}".`);
    return item;
  };
  return {
    names: scanned.map((item) => item.name),
    has: (name) => byName.has(name),
    sizeOf: (name) => lookup(name).declared,
    async read(name) {
      const item = lookup(name);
      if (item.state !== "unread") {
        fail("archive-invalid", `Entry "${name}" was already extracted; each entry streams exactly once.`);
      }
      operation.checkpoint();
      // Charge BEFORE allocating: a violation is a typed rejection, not an
      // out-of-memory crash mid-import.
      ledger.retain(item.declared, name);
      try {
        const data = await inflateEntry(item, operation, (next) => {
          if (streamedTotal + next > policy.maxArchiveUncompressedBytes) {
            fail("archive-uncompressed-quota", `Entry "${name}" pushed the archive past its uncompressed quota during extraction.`);
          }
        });
        streamedTotal += data.length;
        item.state = "retained";
        return data;
      } catch (error) {
        ledger.release(item.declared);
        throw error;
      }
    },
    release(name) {
      const item = byName.get(name);
      if (item && item.state === "retained") {
        item.state = "released";
        ledger.release(item.declared);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Callers normally release each window as soon as it reaches the sink,
      // but every exit path (parse failure, sink failure, cancellation) owns
      // this final safety net. Refund all still-retained entries exactly once.
      for (const item of byName.values()) {
        if (item.state === "retained") {
          item.state = "released";
          ledger.release(item.declared);
        }
      }
      try { await reader.close(); } catch { /* already failed; original error wins */ }
    },
  };
}
