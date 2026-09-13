/**
 * Strictly redacted Sentry integration.
 *
 * Security contract:
 * - Without VITE_SENTRY_DSN, every API here is an inert no-op and
 *   @sentry/react is never even loaded (dynamic import happens only after a
 *   DSN is found). No project, DSN, token, or network state is created here.
 * - When configured: errors 100%, traces 10% in production (100% only under
 *   the explicit private-validation flag), sendDefaultPii false, no Replay.
 * - Outbound events pass a strict ALLOWLIST rebuild: only release/version,
 *   environment, stable error code, sanitized stack (pathless filenames),
 *   timing bucket, browser capability booleans, and coarse layer/pixel
 *   buckets survive. Everything else — user identity, filenames, project or
 *   layer ids/names, manifests, SVG, artwork-derived data, DOM/canvas data,
 *   request data, default breadcrumbs — is stripped by construction.
 */

import { TELEMETRY_ERROR_CODES } from "./error-codes";

/* ------------------------------------------------------------------ */
/* Narrow Sentry surface (avoids a static @sentry/react dependency)    */
/* ------------------------------------------------------------------ */

export type SentryIntegrationLike = { name: string };

export type SentryStackFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  [key: string]: unknown;
};

export type SentryEventLike = {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  release?: string;
  environment?: string;
  message?: unknown;
  transaction?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  user?: unknown;
  request?: unknown;
  breadcrumbs?: SentryBreadcrumbLike[] | { values?: SentryBreadcrumbLike[] };
  contexts?: Record<string, unknown>;
  fingerprint?: string[];
  modules?: unknown;
  server_name?: unknown;
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: SentryStackFrame[] };
      mechanism?: unknown;
      [key: string]: unknown;
    }[];
  };
  [key: string]: unknown;
};

export type SentryBreadcrumbLike = {
  category?: string;
  level?: string;
  timestamp?: number;
  message?: string;
  data?: unknown;
  type?: string;
  [key: string]: unknown;
};

export type SentryModuleLike = {
  init(options: Record<string, unknown>): unknown;
  captureEvent(event: SentryEventLike): unknown;
  captureException?(error: Error, context: { tags: Record<string, unknown> }): unknown;
  startInactiveSpan?(options: { name: string; op: string; forceTransaction: boolean; attributes: Record<string, string> }): {
    end(): void;
    setStatus(status: { code: number; message?: string }): void;
  };
};

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

export type TelemetryEnv = {
  dsn: string | null;
  release: string | null;
  environment: string;
  /** Explicit private-validation flag: traces at 100% instead of 10%. */
  privateValidation: boolean;
};

export function readTelemetryEnv(
  raw: Record<string, unknown> | undefined = readImportMetaEnv(),
): TelemetryEnv {
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  const flag = (value: unknown): boolean => value === true || value === "true" || value === "1";
  return {
    dsn: text(raw?.VITE_SENTRY_DSN),
    release: text(raw?.VITE_SENTRY_RELEASE),
    environment: text(raw?.VITE_SENTRY_ENVIRONMENT) ?? "production",
    privateValidation: flag(raw?.VITE_SENTRY_PRIVATE_VALIDATION),
  };
}

function readImportMetaEnv(): Record<string, unknown> | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Allowlists                                                          */
/* ------------------------------------------------------------------ */

/** Tag keys that may leave the app. Everything else is dropped. */
export const ALLOWED_TAG_KEYS = new Set([
  "error_code",
  "timing_bucket",
  "layer_count_bucket",
  "pixel_count_bucket",
]);

/** Capability tag prefix: cap_<name> booleans only. */
const CAPABILITY_TAG_PREFIX = "cap_";
const CAPABILITY_KEYS = new Set(["offscreen_canvas", "module_workers", "file_system_access", "web_locks", "broadcast_channel", "indexed_db", "opfs", "create_image_bitmap"]);
const CAPABILITY_KEY_PATTERN = { test: (key: string) => CAPABILITY_KEYS.has(key) };
const TAG_VALUES: Record<string, ReadonlySet<string>> = {
  error_code: TELEMETRY_ERROR_CODES,
  timing_bucket: new Set(["unknown", "<100ms", "100-500ms", "500ms-2s", "2-10s", ">10s"]),
  layer_count_bucket: new Set(["unknown", "0", "1", "2-4", "5-8", "9-16", "17-32", ">32"]),
  pixel_count_bucket: new Set(["unknown", "<1MP", "1-5MP", "5-20MP", "20-100MP", ">100MP"]),
};
const RELEASE_PATTERN = /^[a-f0-9]{40}$/;
const ENVIRONMENTS = new Set(["production", "private-validation"]);
const HEX_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;
const DEBUG_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LEVELS = new Set(["fatal", "error", "warning", "info", "debug", "log"]);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export const APP_OPERATIONS = new Set(["app.preview", "app.import", "app.export", "app.save"]);
export type AppOperation = "app.preview" | "app.import" | "app.export" | "app.save";

function eventMetadata(event: SentryEventLike): SentryEventLike {
  return {
    ...(event.event_id && HEX_ID.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(finite(event.timestamp) ? { timestamp: event.timestamp } : {}),
    platform: "javascript",
    ...(event.release && RELEASE_PATTERN.test(event.release) ? { release: event.release } : {}),
    ...(event.environment && ENVIRONMENTS.has(event.environment) ? { environment: event.environment } : {}),
  };
}

/** Only breadcrumbs we emit ourselves may pass, and only their category. */
export const ALLOWED_BREADCRUMB_CATEGORIES = new Set([
  "app.lifecycle",
  "app.render",
  "app.export",
]);

const REDACTED = "[redacted]";

/* ------------------------------------------------------------------ */
/* Buckets                                                             */
/* ------------------------------------------------------------------ */

export function bucketTiming(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  if (milliseconds < 100) return "<100ms";
  if (milliseconds < 500) return "100-500ms";
  if (milliseconds < 2000) return "500ms-2s";
  if (milliseconds < 10_000) return "2-10s";
  return ">10s";
}

export function bucketLayerCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "unknown";
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 4) return "2-4";
  if (count <= 8) return "5-8";
  if (count <= 16) return "9-16";
  if (count <= 32) return "17-32";
  return ">32";
}

export function bucketPixelCount(pixels: number): string {
  if (!Number.isFinite(pixels) || pixels < 0) return "unknown";
  if (pixels < 1_000_000) return "<1MP";
  if (pixels < 5_000_000) return "1-5MP";
  if (pixels < 20_000_000) return "5-20MP";
  if (pixels < 100_000_000) return "20-100MP";
  return ">100MP";
}

/* ------------------------------------------------------------------ */
/* Scrubbers (pure; unit-tested directly)                              */
/* ------------------------------------------------------------------ */

/**
 * Reduces a stack frame filename to a pathless basename: URLs, origins,
 * directories, query strings, and fragments are all removed.
 */
export function sanitizeFrameFilename(filename: string | undefined): string {
  if (!filename) return REDACTED;
  // Preserve only a compiled Vite asset path, which the private source map
  // bundle can match. Local paths and user-supplied filenames never pass.
  const path = filename.split(/[?#]/, 1)[0];
  const match = /(?:^|\/)assets\/([A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.m?js)$/.exec(path);
  return match ? `~/assets/${match[1]}` : REDACTED;
}

export function sanitizeStackFrames(
  frames: SentryStackFrame[] | undefined,
): SentryStackFrame[] | undefined {
  if (!frames) return undefined;
  return frames.slice(-50).map((frame) => ({
    filename: sanitizeFrameFilename(frame.filename),
    ...(Number.isSafeInteger(frame.lineno) && frame.lineno! > 0 ? { lineno: frame.lineno } : {}),
    ...(Number.isSafeInteger(frame.colno) && frame.colno! >= 0 ? { colno: frame.colno } : {}),
  }));
}

function allowedTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!tags) return result;
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string" && TAG_VALUES[key]?.has(value)) {
      result[key] = value;
    } else if (
      key.startsWith(CAPABILITY_TAG_PREFIX) &&
      CAPABILITY_KEY_PATTERN.test(key.slice(CAPABILITY_TAG_PREFIX.length)) &&
      (typeof value === "boolean" || value === "true" || value === "false")
    ) {
      result[key] = String(value);
    }
  }
  return result;
}

/**
 * beforeBreadcrumb: everything is dropped except breadcrumbs we emit under
 * an allowlisted category — and even those keep only category, level, and
 * timestamp. Default browser breadcrumbs (dom, navigation, fetch, xhr,
 * console, ui.click, ...) never pass.
 */
export function scrubBreadcrumb(breadcrumb: SentryBreadcrumbLike): SentryBreadcrumbLike | null {
  if (!breadcrumb.category || !ALLOWED_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) return null;
  return {
    category: breadcrumb.category,
    ...(breadcrumb.level && LEVELS.has(breadcrumb.level) ? { level: breadcrumb.level } : {}),
    ...(finite(breadcrumb.timestamp) ? { timestamp: breadcrumb.timestamp } : {}),
  };
}

/**
 * beforeSend: rebuilds the outbound event from scratch so unknown fields
 * can never leak. The stable error code (tags.error_code) becomes the
 * exception value and fingerprint; the original message/value is dropped
 * because it may embed filenames, ids, or artwork-derived text.
 */
export function scrubEvent(event: SentryEventLike): SentryEventLike {
  const tags = allowedTags(event.tags);
  const errorCode = tags.error_code;

  const exceptionValues = (event.exception?.values ?? []).map((entry) => ({
    type: "AppError",
    value: errorCode ?? REDACTED,
    ...(entry.stacktrace?.frames
      ? { stacktrace: { frames: sanitizeStackFrames(entry.stacktrace.frames) } }
      : {}),
  }));

  const rawBreadcrumbs = Array.isArray(event.breadcrumbs)
    ? event.breadcrumbs
    : (event.breadcrumbs?.values ?? []);
  const breadcrumbs = rawBreadcrumbs
    .map(scrubBreadcrumb)
    .filter((crumb): crumb is SentryBreadcrumbLike => crumb !== null);

  const images = (event.debug_meta as { images?: unknown[] } | undefined)?.images;
  const safeImages = Array.isArray(images) ? images.flatMap((image) => {
    if (!image || typeof image !== "object") return [];
    const item = image as Record<string, unknown>;
    const codeFile = sanitizeFrameFilename(typeof item.code_file === "string" ? item.code_file : undefined);
    return typeof item.debug_id === "string" && DEBUG_ID.test(item.debug_id) && codeFile !== REDACTED
      ? [{ type: "sourcemap", debug_id: item.debug_id, code_file: codeFile }] : [];
  }) : [];
  return {
    ...eventMetadata(event),
    level: event.level && LEVELS.has(event.level) ? event.level : "error",
    ...(safeImages.length ? { debug_meta: { images: safeImages } } : {}),
    tags,
    ...(errorCode ? { fingerprint: [errorCode] } : {}),
    ...(exceptionValues.length > 0 ? { exception: { values: exceptionValues } } : {}),
    ...(breadcrumbs.length > 0 ? { breadcrumbs } : {}),
  };
}

/** Integration filter: no Replay, no default breadcrumb collector. */
export function filterIntegrations(
  integrations: SentryIntegrationLike[],
): SentryIntegrationLike[] {
  return integrations.filter((integration) =>
    ["GlobalHandlers", "InboundFilters", "Dedupe"].includes(integration.name),
  );
}

/**
 * beforeSendTransaction: sampled traces are kept (tracesSampleRate > 0), so
 * every transaction envelope is rebuilt from scratch under the same
 * allowlist philosophy as scrubEvent. The transaction NAME is replaced by a
 * fixed constant — route strings can embed `?project=<id>` and similar
 * document-derived values — and spans, request data, breadcrumbs, and all
 * non-trace contexts are dropped entirely (span descriptions carry URLs and
 * resource names). Only the trace ids and the SDK-generated op survive.
 */
export const REDACTED_TRANSACTION_NAME = "app";

export function scrubTransactionEvent(event: SentryEventLike): SentryEventLike {
  const source = event.contexts?.trace as Record<string, unknown> | undefined;
  const trace = source && typeof source.trace_id === "string" && HEX_ID.test(source.trace_id) &&
    typeof source.span_id === "string" && SPAN_ID.test(source.span_id) ? {
      trace_id: source.trace_id, span_id: source.span_id,
      op: typeof source.op === "string" && APP_OPERATIONS.has(source.op) ? source.op : "app",
    } : undefined;
  const spans = Array.isArray(event.spans) ? event.spans.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const span = raw as Record<string, unknown>;
    if (typeof span.op !== "string" || !APP_OPERATIONS.has(span.op) ||
        typeof span.trace_id !== "string" || !HEX_ID.test(span.trace_id) ||
        typeof span.span_id !== "string" || !SPAN_ID.test(span.span_id) ||
        !finite(span.start_timestamp) || !finite(span.timestamp)) return [];
    return [{ op: span.op, description: span.op, trace_id: span.trace_id, span_id: span.span_id,
      ...(typeof span.parent_span_id === "string" && SPAN_ID.test(span.parent_span_id) ? { parent_span_id: span.parent_span_id } : {}),
      start_timestamp: span.start_timestamp, timestamp: span.timestamp }];
  }) : [];
  return {
    ...eventMetadata(event),
    ...(finite(event.start_timestamp) ? { start_timestamp: event.start_timestamp } : {}),
    type: "transaction",
    transaction: event.transaction && APP_OPERATIONS.has(event.transaction) ? event.transaction : REDACTED_TRANSACTION_NAME,
    tags: allowedTags({ ...(source?.data && typeof source.data === "object" ? source.data : {}), ...event.tags }),
    ...(trace ? { contexts: { trace } } : {}),
    ...(spans.length ? { spans } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Handled-error registry (duplicate suppression)                      */
/* ------------------------------------------------------------------ */

/**
 * Errors already reported through a HANDLED capture (captureHandledError /
 * captureAppError with a cause). The SDK's global handlers (window.onerror,
 * onunhandledrejection) receive the ORIGINAL exception object as the event
 * hint; beforeSend drops any event whose originalException carries this
 * mark, so one real failure can never produce both a handled and a global
 * report.
 */
let reportedErrors = new WeakSet<object>();

export function markErrorReported(error: unknown): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    reportedErrors.add(error as object);
  }
}

export function isErrorReported(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    reportedErrors.has(error as object)
  );
}

/* ------------------------------------------------------------------ */
/* Init and capture                                                    */
/* ------------------------------------------------------------------ */

type TelemetryState = {
  enabled: boolean;
  sentry: SentryModuleLike | null;
  env: TelemetryEnv | null;
};

const state: TelemetryState = { enabled: false, sentry: null, env: null };

export function isTelemetryEnabled(): boolean {
  return state.enabled;
}

/** Test hook: return telemetry to the pristine disabled state. */
export function resetTelemetryForTests(): void {
  state.enabled = false;
  state.sentry = null;
  state.env = null;
  reportedErrors = new WeakSet<object>();
}

export type InitTelemetryOptions = {
  env?: TelemetryEnv;
  /** Injectable loader; defaults to lazily importing @sentry/react. */
  loadSentry?: () => Promise<SentryModuleLike>;
};

export function buildSentryInitOptions(env: TelemetryEnv): Record<string, unknown> {
  return {
    dsn: env.dsn,
    ...(env.release ? { release: env.release } : {}),
    environment: env.environment,
    sendDefaultPii: false,
    sampleRate: 1.0,
    tracesSampleRate: env.privateValidation ? 1.0 : 0.1,
    maxBreadcrumbs: 10,
    sendClientReports: false,
    autoSessionTracking: false,
    integrations: filterIntegrations,
    beforeSend: (event: SentryEventLike, hint?: { originalException?: unknown }) =>
      hint && isErrorReported(hint.originalException) ? null : scrubEvent(event),
    beforeSendTransaction: (event: SentryEventLike) => scrubTransactionEvent(event),
    beforeBreadcrumb: (breadcrumb: SentryBreadcrumbLike) => scrubBreadcrumb(breadcrumb),
  };
}

/**
 * Initializes telemetry when — and only when — a DSN is configured through
 * the environment. Returns true when Sentry was actually initialized.
 */
export async function initTelemetry(options: InitTelemetryOptions = {}): Promise<boolean> {
  const env = options.env ?? readTelemetryEnv();
  if (!env.dsn) {
    state.enabled = false;
    state.sentry = null;
    state.env = null;
    return false;
  }
  const loadSentry =
    options.loadSentry ??
    (async () => (await import("@sentry/react")) as unknown as SentryModuleLike);
  try {
    const sentry = await loadSentry();
    sentry.init(buildSentryInitOptions(env));
    state.enabled = true;
    state.sentry = sentry;
    state.env = env;
    return true;
  } catch {
    // Observability must never stop the workstation from opening.
    state.enabled = false; state.sentry = null; state.env = null;
    return false;
  }
}

export type AppErrorContext = {
  timingMs?: number;
  layerCount?: number;
  pixelCount?: number;
  /** Browser capability booleans; keys become cap_<name> tags. */
  capabilities?: Record<string, boolean>;
  /** Kept locally for the console; never sent. */
  cause?: unknown;
};

const ERROR_CODE_PATTERN = { test: (code: string) => TELEMETRY_ERROR_CODES.has(code) };

/**
 * Captures an application error under the allowlist. Only the stable code
 * and coarse buckets leave the device; the cause stays local. A no-op until
 * initTelemetry ran with a configured DSN.
 */
export function captureAppError(code: string, context: AppErrorContext = {}): void {
  // Mark the cause even while disabled: the mark is what keeps a handled
  // error from double-reporting through the global handlers, and marking is
  // free — no event exists without a DSN either way.
  if (context.cause !== undefined) markErrorReported(context.cause);
  if (!state.enabled || !state.sentry) return;
  const safeCode = ERROR_CODE_PATTERN.test(code) ? code : "invalid-error-code";
  const tags: Record<string, unknown> = { error_code: safeCode };
  if (context.timingMs !== undefined) tags.timing_bucket = bucketTiming(context.timingMs);
  if (context.layerCount !== undefined) {
    tags.layer_count_bucket = bucketLayerCount(context.layerCount);
  }
  if (context.pixelCount !== undefined) {
    tags.pixel_count_bucket = bucketPixelCount(context.pixelCount);
  }
  for (const [key, value] of Object.entries(context.capabilities ?? {})) {
    if (CAPABILITY_KEY_PATTERN.test(key) && typeof value === "boolean") {
      tags[`${CAPABILITY_TAG_PREFIX}${key}`] = value;
    }
  }
  // The event passes beforeSend (scrubEvent) again inside the SDK; building
  // it clean here means the allowlist holds even at the call site.
  try {
    if (state.sentry.captureException) {
      const report = new Error(safeCode);
      // SDK parsing/debug-ID matching happens before the final scrubber.
      // Only compiled asset locations and line/column survive that scrub.
      if (context.cause instanceof Error && context.cause.stack) report.stack = context.cause.stack;
      state.sentry.captureException(report, { tags });
    } else {
      state.sentry.captureEvent(scrubEvent({
        level: "error", release: state.env?.release ?? undefined, environment: state.env?.environment,
        tags, exception: { values: [{ type: "AppError", value: safeCode }] },
      }));
    }
  } catch { /* A failed SDK cannot change an application's error handling. */ }
}

/** Coerce an untrusted candidate (e.g. a typed error's .code) to a stable code. */
export function stableErrorCode(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && ERROR_CODE_PATTERN.test(candidate)
    ? candidate
    : fallback;
}

/**
 * The ONE entry point for reporting a real, HANDLED failure:
 * - exactly one event per error object — a failure that flows through
 *   several handlers (journal onError, save catch, UI surface) reports once;
 * - the error object is marked so the SDK's global handlers skip it if it
 *   escapes anyway (see beforeSend);
 * - a no-op without a configured DSN, like everything else here.
 */
export function captureHandledError(
  code: string,
  error: unknown,
  context: Omit<AppErrorContext, "cause"> = {},
): void {
  if (isErrorReported(error)) return;
  captureAppError(code, { ...context, cause: error });
  // Primitives (thrown strings) cannot be marked; captureAppError marked
  // object causes already. Marking here again is a harmless no-op.
  markErrorReported(error);
}


/** Manual fixed-name root span; no DOM, navigation, resource or HTTP instrumentation. */
export function startAppSpan(operation: AppOperation, context: Pick<AppErrorContext, "layerCount" | "pixelCount"> = {}): (error?: unknown) => void {
  if (!state.enabled || !state.sentry?.startInactiveSpan || !APP_OPERATIONS.has(operation)) return () => undefined;
  try {
    const attributes: Record<string, string> = {};
    if (context.layerCount !== undefined) attributes.layer_count_bucket = bucketLayerCount(context.layerCount);
    if (context.pixelCount !== undefined) attributes.pixel_count_bucket = bucketPixelCount(context.pixelCount);
    const span = state.sentry.startInactiveSpan({ name: operation, op: operation, forceTransaction: true, attributes });
    let ended = false;
    return (error) => {
      if (ended) return;
      ended = true;
      try {
        span.setStatus({ code: error === undefined ? 1 : 2, ...(error === undefined ? {} : { message: "operation_failed" }) });
        span.end();
      } catch { /* Telemetry is advisory. */ }
    };
  } catch { return () => undefined; }
}

export async function traceAppOperation<T>(operation: AppOperation, action: () => Promise<T>): Promise<T> {
  const finish = startAppSpan(operation);
  try { const value = await action(); finish(); return value; }
  catch (error) { finish(error); throw error; }
}
