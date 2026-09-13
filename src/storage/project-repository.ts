/**
 * ProjectRepository: canonical local project library. All writes that could
 * race another tab go through savedRevision compare-and-swap inside one
 * backend transaction; a losing writer gets a typed ConflictError and
 * nothing is overwritten.
 *
 * Trash model: moving a project to Trash writes a TrashRecordV1 keyed by
 * project id while the envelope stays in the projects store (so Trash
 * remains an asset-GC root). Restore deletes the trash record; permanent
 * deletion removes envelope, trash record, and recovery record together.
 */
import type { Id, ProjectCoreV1, ProjectEnvelopeV1, TrashRecordV1 } from "../core/types";
import { createId } from "../core/id";
import type { StorageBackend } from "./backend";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { ConflictError, CorruptRecordError, NotFoundError } from "./errors";
import { validateStoredEnvelope, validateStoredTrashRecord } from "./validate";

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Library card data; core/snapshots stay on disk until load(). */
export type ProjectSummary = {
  id: Id;
  title: string;
  createdAt: number;
  updatedAt: number;
  savedRevision: number;
  snapshotCount: number;
};

export type ProjectRepositoryOptions = {
  now?: Clock;
  newId?: () => Id;
};

function toSummary(envelope: ProjectEnvelopeV1): ProjectSummary {
  return {
    id: envelope.id,
    title: envelope.title,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    savedRevision: envelope.savedRevision,
    snapshotCount: envelope.snapshots.length,
  };
}

export class ProjectRepository {
  private readonly now: Clock;
  private readonly newId: () => Id;

  constructor(
    private readonly backend: StorageBackend,
    options: ProjectRepositoryOptions = {},
  ) {
    this.now = options.now ?? systemClock;
    this.newId = options.newId ?? createId;
  }

  /**
   * Live (non-trashed) projects, most recently updated first. At-rest rows
   * are structurally validated; a corrupt row is skipped (with a console
   * warning) instead of crashing the library view.
   */
  async list(): Promise<ProjectSummary[]> {
    const [keys, trash] = await Promise.all([
      this.backend.getAllKeys("projects"),
      this.backend.getAllKeys("trash"),
    ]);
    const trashed = new Set(trash);
    const summaries: ProjectSummary[] = [];
    for (const key of keys) {
      if (trashed.has(key)) continue;
      const raw = await this.backend.get<unknown>("projects", key);
      if (raw === undefined) continue;
      try {
        summaries.push(toSummary(validateStoredEnvelope(key, raw)));
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        console.warn(`Skipping corrupt project record "${key}":`, error.cause ?? error);
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Loads and structurally revalidates one envelope. Throws NotFoundError
   * for a missing row and CorruptRecordError for a damaged one — callers
   * surface the latter as an open error without touching the stored row.
   */
  async load(id: Id): Promise<ProjectEnvelopeV1> {
    const envelope = await this.backend.get<unknown>("projects", id);
    if (envelope === undefined) throw new NotFoundError("project", id);
    return validateStoredEnvelope(id, envelope);
  }

  /** Create and persist a new project; savedRevision starts at 1. */
  async create(title: string, core: ProjectCoreV1): Promise<ProjectEnvelopeV1> {
    const timestamp = this.now();
    const envelope: ProjectEnvelopeV1 = {
      schema: 1,
      id: this.newId(),
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      savedRevision: 1,
      core: structuredClone(core),
      snapshots: [],
    };
    await this.backend.put("projects", envelope.id, envelope);
    return envelope;
  }

  /**
   * Atomic first save of an in-memory (unsaved) project: the COMPLETE
   * envelope — core, snapshots, and title — lands as one transactional
   * write with savedRevision 1. Refuses to overwrite an existing row
   * (ConflictError), so a retry after success cannot clobber concurrent
   * work. On failure nothing is persisted and the caller's in-memory
   * envelope stays authoritative.
   */
  async createFromEnvelope(envelope: ProjectEnvelopeV1): Promise<ProjectEnvelopeV1> {
    const timestamp = this.now();
    const installed: ProjectEnvelopeV1 = {
      ...structuredClone(envelope),
      createdAt: timestamp,
      updatedAt: timestamp,
      savedRevision: 1,
    };
    await this.backend.transaction(["projects"], async (tx) => {
      const stored = await tx.get<ProjectEnvelopeV1>("projects", installed.id);
      if (stored) {
        throw new ConflictError(installed.id, 0, stored.savedRevision);
      }
      await tx.put("projects", installed.id, installed);
    });
    return installed;
  }

  /**
   * Explicit Save with compare-and-swap. `envelope.savedRevision` must equal
   * the stored revision (the value the writer loaded); on mismatch the write
   * is rejected with ConflictError and the stored project is untouched. On
   * success the revision increments and the saved envelope is returned.
   */
  async saveExplicit(envelope: ProjectEnvelopeV1): Promise<ProjectEnvelopeV1> {
    const timestamp = this.now();
    const saved: ProjectEnvelopeV1 = {
      ...structuredClone(envelope),
      savedRevision: envelope.savedRevision + 1,
      updatedAt: timestamp,
    };
    await this.backend.transaction(["projects"], async (tx) => {
      const stored = await tx.get<ProjectEnvelopeV1>("projects", envelope.id);
      if (!stored) throw new NotFoundError("project", envelope.id);
      if (stored.savedRevision !== envelope.savedRevision) {
        throw new ConflictError(envelope.id, envelope.savedRevision, stored.savedRevision);
      }
      await tx.put("projects", envelope.id, saved);
    });
    return saved;
  }

  /** Rename bumps savedRevision so a stale concurrent save conflicts instead of reverting the title. */
  async rename(id: Id, title: string): Promise<ProjectEnvelopeV1> {
    const timestamp = this.now();
    let renamed: ProjectEnvelopeV1 | undefined;
    await this.backend.transaction(["projects"], async (tx) => {
      const stored = await tx.get<ProjectEnvelopeV1>("projects", id);
      if (!stored) throw new NotFoundError("project", id);
      renamed = {
        ...stored,
        title,
        savedRevision: stored.savedRevision + 1,
        updatedAt: timestamp,
      };
      await tx.put("projects", id, renamed);
    });
    return renamed as ProjectEnvelopeV1;
  }

  /** Deep-copy a project (core + snapshots) under a new id and title. */
  async duplicate(id: Id, title?: string): Promise<ProjectEnvelopeV1> {
    const source = await this.load(id);
    const timestamp = this.now();
    const copy: ProjectEnvelopeV1 = {
      ...structuredClone(source),
      id: this.newId(),
      title: title ?? `${source.title} copy`,
      createdAt: timestamp,
      updatedAt: timestamp,
      savedRevision: 1,
    };
    await this.backend.put("projects", copy.id, copy);
    return copy;
  }

  async moveToTrash(id: Id): Promise<TrashRecordV1> {
    const deletedAt = this.now();
    let record: TrashRecordV1 | undefined;
    await this.backend.transaction(["projects", "trash"], async (tx) => {
      const stored = await tx.get<ProjectEnvelopeV1>("projects", id);
      if (!stored) throw new NotFoundError("project", id);
      record = {
        projectId: id,
        deletedAt,
        expiresAt: deletedAt + TRASH_RETENTION_MS,
        title: stored.title,
      };
      await tx.put("trash", id, record);
    });
    return record as TrashRecordV1;
  }

  /** Trash rows are validated on read; corrupt rows are skipped with a warning. */
  async listTrash(): Promise<TrashRecordV1[]> {
    const keys = await this.backend.getAllKeys("trash");
    const records: TrashRecordV1[] = [];
    for (const key of keys) {
      const raw = await this.backend.get<unknown>("trash", key);
      if (raw === undefined) continue;
      try {
        records.push(validateStoredTrashRecord(key, raw));
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        console.warn(`Skipping corrupt trash record "${key}":`, error.cause ?? error);
      }
    }
    return records.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async restore(id: Id): Promise<ProjectEnvelopeV1> {
    const envelope = await this.load(id);
    await this.backend.delete("trash", id);
    return envelope;
  }

  /** Remove envelope, trash record, and recovery journal together. */
  async deletePermanently(id: Id): Promise<void> {
    await this.backend.transaction(["projects", "trash", "recovery"], async (tx) => {
      await tx.delete("projects", id);
      await tx.delete("trash", id);
      await tx.delete("recovery", id);
    });
  }

  async emptyTrash(): Promise<number> {
    // Keyed sweep: even a corrupt trash row (garbage fields) is removed,
    // because trash rows are keyed by project id.
    const keys = await this.backend.getAllKeys("trash");
    for (const key of keys) {
      await this.deletePermanently(key);
    }
    return keys.length;
  }

  /** Permanently delete trash entries past their 30-day expiry. */
  async sweepExpiredTrash(): Promise<number> {
    const keys = await this.backend.getAllKeys("trash");
    const cutoff = this.now();
    let swept = 0;
    for (const key of keys) {
      const raw = await this.backend.get<unknown>("trash", key);
      if (raw === undefined) continue;
      let expired: boolean;
      try {
        expired = validateStoredTrashRecord(key, raw).expiresAt <= cutoff;
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        // A corrupt trash row has no trustworthy expiry. Drop ONLY the trash
        // marker (the project envelope, if intact, returns to the library) —
        // never destroy project data on the say-so of a damaged row.
        console.warn(`Dropping corrupt trash record "${key}":`, error.cause ?? error);
        await this.backend.delete("trash", key);
        continue;
      }
      if (expired) {
        await this.deletePermanently(key);
        swept += 1;
      }
    }
    return swept;
  }
}
