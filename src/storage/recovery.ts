/**
 * RecoveryJournal: debounced crash-recovery journaling. Committed edits are
 * scheduled (~750ms debounce per project) and flushed to the recovery store
 * without ever touching the projects store, so the last explicit save can
 * never be corrupted by journaling.
 *
 * Quota policy: when a flush hits QuotaExceededError the record stays in
 * memory (latestInMemory), a typed StorageQuotaError is surfaced, and the
 * journal keeps accepting newer schedules so no work is lost while the user
 * frees space or saves elsewhere.
 */
import type { Id, RecoveryRecordV1 } from "../core/types";
import type { StorageBackend } from "./backend";
import type { TimerHandle, TimerHost } from "./clock";
import { systemTimer } from "./clock";
import { CorruptRecordError, StorageQuotaError, isQuotaExceededError } from "./errors";
import { validateStoredRecoveryRecord } from "./validate";

export const RECOVERY_DEBOUNCE_MS = 750;

export type RecoveryJournalOptions = {
  debounceMs?: number;
  timer?: TimerHost;
  /** Receives flush failures from debounced (fire-and-forget) flushes. */
  onError?: (error: unknown) => void;
};

export class RecoveryJournal {
  private readonly debounceMs: number;
  private readonly timer: TimerHost;
  private readonly onError: (error: unknown) => void;
  private readonly pending = new Map<Id, RecoveryRecordV1>();
  private readonly timers = new Map<Id, TimerHandle>();

  constructor(
    private readonly backend: StorageBackend,
    options: RecoveryJournalOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? RECOVERY_DEBOUNCE_MS;
    this.timer = options.timer ?? systemTimer;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Journal a committed edit; coalesces per project within the debounce window. */
  scheduleJournal(record: RecoveryRecordV1): void {
    this.pending.set(record.projectId, record);
    const existing = this.timers.get(record.projectId);
    if (existing !== undefined) this.timer.clear(existing);
    const handle = this.timer.set(() => {
      this.timers.delete(record.projectId);
      void this.flushProject(record.projectId).catch(this.onError);
    }, this.debounceMs);
    this.timers.set(record.projectId, handle);
  }

  /** Flush all pending journals immediately (lifecycle events: hide, close, save). */
  async flushNow(): Promise<void> {
    for (const [projectId, handle] of this.timers) {
      this.timer.clear(handle);
      this.timers.delete(projectId);
    }
    for (const projectId of [...this.pending.keys()]) {
      await this.flushProject(projectId);
    }
  }

  /** The unpersisted in-memory copy, if a journal is pending or quota-stuck. */
  latestInMemory(projectId: Id): RecoveryRecordV1 | undefined {
    return this.pending.get(projectId);
  }

  /**
   * The stored (flushed) journal record for a project, revalidated on read.
   * A corrupt record is discarded — console warning plus journal clear — and
   * reported as absent, so recovery can never inject damaged state; the last
   * explicit save stays untouched.
   */
  async load(projectId: Id): Promise<RecoveryRecordV1 | null> {
    const stored = await this.backend.get<unknown>("recovery", projectId);
    if (stored === undefined) return null;
    try {
      return validateStoredRecoveryRecord(projectId, stored);
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      console.warn(
        `Discarding corrupt recovery journal for project "${projectId}":`,
        error.cause ?? error,
      );
      await this.backend.delete("recovery", projectId);
      return null;
    }
  }

  /**
   * Recovery for the given canonical save base, or null when the stored
   * journal is absent, corrupt (discarded with a warning), stale (recorded
   * against a DIFFERENT base — discarded), or not ahead of the base.
   *
   * Base-binding invariant: a record is eligible ONLY when its own
   * `savedRevision` equals the current canonical savedRevision AND its
   * `revision` is ahead of that base. Session revisions are rebased counters
   * (casToken + edits-past-save), so a numerically large revision on an OLD
   * base must never outrank newer canonical state: after another tab's save,
   * a rename (which bumps the base), or a crash between the project write
   * and the journal clear, the old-base record is STALE by definition — the
   * save that bumped the base already captured that work, and edits made
   * after it are re-journaled on the new base (see performSave). Stale
   * records are deleted on load, never restored.
   */
  async loadNewer(projectId: Id, savedRevision: number): Promise<RecoveryRecordV1 | null> {
    const stored = await this.load(projectId);
    if (!stored) return null;
    if (stored.savedRevision !== savedRevision) {
      console.warn(
        `Discarding stale recovery journal for project "${projectId}" ` +
          `(journal base ${stored.savedRevision}, canonical base ${savedRevision})`,
      );
      await this.backend.delete("recovery", projectId);
      return null;
    }
    return stored.revision > savedRevision ? stored : null;
  }

  /** Drop the journal after explicit Save or Revert. */
  async clear(projectId: Id): Promise<void> {
    this.pending.delete(projectId);
    const handle = this.timers.get(projectId);
    if (handle !== undefined) {
      this.timer.clear(handle);
      this.timers.delete(projectId);
    }
    await this.backend.delete("recovery", projectId);
  }

  private async flushProject(projectId: Id): Promise<void> {
    const record = this.pending.get(projectId);
    if (!record) return;
    try {
      await this.backend.put("recovery", projectId, record);
    } catch (error) {
      if (isQuotaExceededError(error)) {
        // Keep the in-memory copy; the last explicit save is untouched.
        throw new StorageQuotaError(
          `Recovery journal for project ${projectId} could not be persisted: storage quota exceeded`,
          { cause: error },
        );
      }
      throw error;
    }
    // Only clear if no newer record was scheduled while the put was in flight.
    if (this.pending.get(projectId) === record) {
      this.pending.delete(projectId);
    }
  }
}
