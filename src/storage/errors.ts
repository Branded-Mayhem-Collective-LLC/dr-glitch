/**
 * Typed storage errors. Callers branch on `instanceof`, never on message
 * text. Every error carries a stable machine `code`.
 */

export class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

/**
 * Compare-and-swap failure: the stored savedRevision no longer matches the
 * revision the writer loaded. The write was rejected; nothing was
 * overwritten.
 */
export class ConflictError extends StorageError {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(projectId: string, expectedRevision: number, actualRevision: number) {
    super(
      "conflict",
      `Project ${projectId} save rejected: expected savedRevision ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "ConflictError";
    this.projectId = projectId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** A referenced project, asset, or staging area does not exist. */
export class NotFoundError extends StorageError {
  readonly subject: string;

  constructor(subject: string, key: string) {
    super("not-found", `${subject} not found: ${key}`);
    this.name = "NotFoundError";
    this.subject = subject;
  }
}

/**
 * Persistent storage is full. The failed payload is preserved in memory by
 * the caller (see RecoveryJournal); the last explicit save is untouched.
 */
export class StorageQuotaError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("quota-exceeded", message, options);
    this.name = "StorageQuotaError";
  }
}

/**
 * An at-rest record failed structural validation on read (corruption threat
 * model: IndexedDB rows are untrusted until revalidated). The message is
 * user-presentable; `store`/`key` identify the damaged row and `cause`
 * carries the underlying schema violation for logging.
 */
export class CorruptRecordError extends StorageError {
  readonly store: string;
  readonly key: string;

  constructor(store: string, key: string, options?: ErrorOptions) {
    super(
      "corrupt-record",
      `The stored ${store} record “${key}” is damaged and cannot be used.`,
      options,
    );
    this.name = "CorruptRecordError";
    this.store = store;
    this.key = key;
  }
}

/** True for browser QuotaExceededError DOMExceptions and our typed error. */
export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof StorageQuotaError) return true;
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return named.name === "QuotaExceededError" || named.code === 22;
}
