import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_BREADCRUMB_CATEGORIES,
  ALLOWED_TAG_KEYS,
  bucketLayerCount,
  bucketPixelCount,
  bucketTiming,
  buildSentryInitOptions,
  captureAppError,
  captureHandledError,
  filterIntegrations,
  initTelemetry,
  isErrorReported,
  isTelemetryEnabled,
  markErrorReported,
  readTelemetryEnv,
  REDACTED_TRANSACTION_NAME,
  resetTelemetryForTests,
  sanitizeFrameFilename,
  scrubBreadcrumb,
  scrubEvent,
  scrubTransactionEvent,
  stableErrorCode,
  startAppSpan,
  traceAppOperation,
  type SentryEventLike,
  type SentryModuleLike,
} from "../../src/telemetry/sentry";

afterEach(() => {
  resetTelemetryForTests();
});

function makeFakeSentry() {
  const initCalls: Record<string, unknown>[] = [];
  const captured: SentryEventLike[] = [];
  const sentry: SentryModuleLike = {
    init: (options) => {
      initCalls.push(options);
    },
    captureEvent: (event) => {
      captured.push(event);
    },
  };
  return { sentry, initCalls, captured };
}

describe("disabled without a DSN", () => {
  it("never loads or initializes Sentry when the env has no DSN", async () => {
    let loaderCalls = 0;
    const enabled = await initTelemetry({
      env: { dsn: null, release: null, environment: "production", privateValidation: false },
      loadSentry: async () => {
        loaderCalls += 1;
        return makeFakeSentry().sentry;
      },
    });
    expect(enabled).toBe(false);
    expect(loaderCalls).toBe(0);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("captureAppError is an inert no-op before init", () => {
    expect(() => captureAppError("export-failed", { timingMs: 100 })).not.toThrow();
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("reads a missing/blank env as disabled", () => {
    expect(readTelemetryEnv({}).dsn).toBeNull();
    expect(readTelemetryEnv({ VITE_SENTRY_DSN: "   " }).dsn).toBeNull();
    expect(readTelemetryEnv(undefined).dsn).toBeNull();
  });
});

describe("init options when configured", () => {
  const env = {
    dsn: "https://public@example.ingest.invalid/1",
    release: "a".repeat(40),
    environment: "production",
    privateValidation: false,
  };

  it("initializes with strict settings", async () => {
    const { sentry, initCalls } = makeFakeSentry();
    const enabled = await initTelemetry({ env, loadSentry: async () => sentry });
    expect(enabled).toBe(true);
    expect(isTelemetryEnabled()).toBe(true);
    expect(initCalls).toHaveLength(1);
    const options = initCalls[0];
    expect(options.sendDefaultPii).toBe(false);
    expect(options.sampleRate).toBe(1.0);
    expect(options.tracesSampleRate).toBe(0.1);
    expect(options.sendClientReports).toBe(false);
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
    expect(options.integrations).toBe(filterIntegrations);
  });

  it("traces at 100% only under the explicit private-validation flag", () => {
    expect(buildSentryInitOptions({ ...env, privateValidation: true }).tracesSampleRate).toBe(1.0);
    expect(buildSentryInitOptions(env).tracesSampleRate).toBe(0.1);
  });

  it("keeps Replay out of the integration list", () => {
    const filtered = filterIntegrations([
      { name: "Replay" },
      { name: "ReplayCanvas" },
      { name: "Breadcrumbs" },
      { name: "GlobalHandlers" },
      { name: "Dedupe" },
    ]);
    expect(filtered.map(({ name }) => name)).toEqual(["GlobalHandlers", "Dedupe"]);
    expect(filtered.some(({ name }) => /replay/i.test(name))).toBe(false);
  });
});

describe("event scrubbing (beforeSend)", () => {
  const dirtyEvent: SentryEventLike = {
    event_id: "abc123",
    timestamp: 1_757_700_000,
    platform: "javascript",
    level: "error",
    release: "a".repeat(40),
    environment: "production",
    message: "Failed loading /Users/michael/art/secret-client-logo.png",
    transaction: "/studio?project=super-secret",
    server_name: "michaels-macbook",
    modules: { react: "19.0.0" },
    user: { id: "user-77", email: "michael@brandedmayhem.com", ip_address: "10.0.0.2" },
    request: { url: "https://studio.example.com/?project=abc", headers: { Cookie: "session" } },
    extra: { manifest: { assets: ["secret.svg"] }, svg: "<svg onload=x/>" },
    contexts: { canvas: { dataUrl: "data:image/png;base64,AAAA" } },
    tags: {
      error_code: "export-failed",
      timing_bucket: "2-10s",
      project_name: "Secret Client",
      layer_id: "layer-9",
      cap_offscreen_canvas: true,
      cap_BAD_KEY: true,
    },
    fingerprint: ["custom", "Secret Client"],
    breadcrumbs: [
      { category: "ui.click", message: "button#export-secret", data: { dom: "<button/>" } },
      { category: "fetch", message: "GET /api/projects/secret" },
      { category: "app.export", level: "info", timestamp: 1, message: "leaky message", data: { file: "x.png" } },
    ],
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Cannot read secret-client-logo.png at /Users/michael/art",
          mechanism: { handled: true },
          stacktrace: {
            frames: [
              {
                filename: "https://studio.example.com/assets/index-Bq2zabcd.js?v=3#frag",
                          lineno: 42,
                colno: 7,
                vars: { projectName: "secret" },
                abs_path: "https://studio.example.com/assets/index-Bq2zabcd.js",
              },
              { filename: "C:\\Users\\michael\\app\\studio.js", function: "onClick", lineno: 1 },
            ],
          },
        },
      ],
    },
  };

  it("removes every forbidden field", () => {
    const scrubbed = scrubEvent(dirtyEvent);
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.contexts).toBeUndefined();
    expect(scrubbed.message).toBeUndefined();
    expect(scrubbed.transaction).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(scrubbed.modules).toBeUndefined();
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("Secret");
    expect(serialized).not.toContain("michael");
    expect(serialized).not.toContain("svg");
    expect(serialized).not.toContain("example.com");
  });

  it("keeps only allowlisted and capability tags", () => {
    const scrubbed = scrubEvent(dirtyEvent);
    expect(scrubbed.tags).toEqual({
      error_code: "export-failed",
      timing_bucket: "2-10s",
      cap_offscreen_canvas: "true",
    });
    for (const key of Object.keys(scrubbed.tags ?? {})) {
      expect(ALLOWED_TAG_KEYS.has(key) || key.startsWith("cap_")).toBe(true);
    }
  });

  it("replaces the exception value with the stable error code", () => {
    const scrubbed = scrubEvent(dirtyEvent);
    const [entry] = scrubbed.exception!.values!;
    expect(entry.type).toBe("AppError");
    expect(entry.value).toBe("export-failed");
    expect(scrubbed.fingerprint).toEqual(["export-failed"]);
  });

  it("redacts the exception value when no error code exists", () => {
    const scrubbed = scrubEvent({
      exception: { values: [{ type: "Error", value: "path /a/b/c.png" }] },
    });
    expect(scrubbed.exception!.values![0].value).toBe("[redacted]");
    expect(scrubbed.fingerprint).toBeUndefined();
  });

  it("sanitizes stack frames to pathless filenames", () => {
    const scrubbed = scrubEvent(dirtyEvent);
    const frames = scrubbed.exception!.values![0].stacktrace!.frames!;
    expect(frames[0]).toEqual({
      filename: "~/assets/index-Bq2zabcd.js",
      lineno: 42,
      colno: 7,
    });
    expect(frames[0].vars).toBeUndefined();
    expect(frames[0].abs_path).toBeUndefined();
    expect(frames[1].filename).toBe("[redacted]");
  });

  it("drops default breadcrumbs and strips allowlisted ones to category metadata", () => {
    const scrubbed = scrubEvent(dirtyEvent);
    expect(scrubbed.breadcrumbs).toEqual([{ category: "app.export", level: "info", timestamp: 1 }]);
  });
});

describe("breadcrumb scrubbing (beforeBreadcrumb)", () => {
  it("drops every non-allowlisted category", () => {
    for (const category of ["ui.click", "fetch", "xhr", "console", "navigation", "dom", undefined]) {
      expect(scrubBreadcrumb({ category, message: "x" })).toBeNull();
    }
  });

  it("keeps allowlisted categories without message or data", () => {
    for (const category of ALLOWED_BREADCRUMB_CATEGORIES) {
      const crumb = scrubBreadcrumb({ category, message: "secret", data: { a: 1 }, timestamp: 2 });
      expect(crumb).toEqual({ category, timestamp: 2 });
    }
  });
});

describe("stack filename sanitizer", () => {
  it("strips URLs, paths, queries, and fragments", () => {
    expect(sanitizeFrameFilename("https://a.example/assets/app-XYabcdef.js?v=1#f")).toBe("~/assets/app-XYabcdef.js");
    expect(sanitizeFrameFilename("/srv/app/dist/chunk.js")).toBe("[redacted]");
    expect(sanitizeFrameFilename("C:\\app\\main.js")).toBe("[redacted]");
    expect(sanitizeFrameFilename("webpack://app/./src/x.ts")).toBe("[redacted]");
    expect(sanitizeFrameFilename("plain.js")).toBe("[redacted]");
    expect(sanitizeFrameFilename(undefined)).toBe("[redacted]");
    expect(sanitizeFrameFilename("data:text/javascript;base64,AAA")).toBe("[redacted]");
  });
});

describe("buckets", () => {
  it("buckets timing coarsely", () => {
    expect(bucketTiming(50)).toBe("<100ms");
    expect(bucketTiming(300)).toBe("100-500ms");
    expect(bucketTiming(1500)).toBe("500ms-2s");
    expect(bucketTiming(5000)).toBe("2-10s");
    expect(bucketTiming(60_000)).toBe(">10s");
    expect(bucketTiming(Number.NaN)).toBe("unknown");
  });

  it("buckets layer and pixel counts coarsely", () => {
    expect(bucketLayerCount(0)).toBe("0");
    expect(bucketLayerCount(3)).toBe("2-4");
    expect(bucketLayerCount(32)).toBe("17-32");
    expect(bucketPixelCount(500_000)).toBe("<1MP");
    expect(bucketPixelCount(12_000_000)).toBe("5-20MP");
  });
});

describe("captureAppError", () => {
  it("sends only the allowlisted shape once configured", async () => {
    const { sentry, captured } = makeFakeSentry();
    await initTelemetry({
      env: {
        dsn: "https://public@example.ingest.invalid/1",
        release: "a".repeat(40),
        environment: "production",
        privateValidation: false,
      },
      loadSentry: async () => sentry,
    });
    captureAppError("render-worker-crash", {
      timingMs: 1200,
      layerCount: 6,
      pixelCount: 19_000_000,
      capabilities: { offscreen_canvas: true, "BAD KEY": true },
      cause: new Error("full of /local/paths and names"),
    });
    expect(captured).toHaveLength(1);
    const event = captured[0];
    expect(event.tags).toEqual({
      error_code: "render-worker-crash",
      timing_bucket: "500ms-2s",
      layer_count_bucket: "5-8",
      pixel_count_bucket: "5-20MP",
      cap_offscreen_canvas: "true",
    });
    expect(event.exception!.values![0].value).toBe("render-worker-crash");
    expect(event.fingerprint).toEqual(["render-worker-crash"]);
    expect(event.release).toBe("a".repeat(40));
    expect(JSON.stringify(event)).not.toContain("local/paths");
  });

  it("keeps the whole outbound event free of names planted across EVERY envelope field", async () => {
    const { sentry, captured } = makeFakeSentry();
    await initTelemetry({
      env: {
        dsn: "https://public@example.ingest.invalid/1",
        release: "a".repeat(40),
        environment: "production",
        privateValidation: false,
      },
      loadSentry: async () => sentry,
    });
    captureAppError("storage-quota", {
      cause: new Error("QuotaExceededError while saving Secret Client Artwork.png"),
    });
    const serialized = JSON.stringify(captured[0]);
    for (const leak of ["Secret", "Artwork.png", "Quota Victim", "project=", "request", "url"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("normalizes malformed error codes at the call site", async () => {
    const { sentry, captured } = makeFakeSentry();
    await initTelemetry({
      env: {
        dsn: "https://public@example.ingest.invalid/1",
        release: null,
        environment: "production",
        privateValidation: false,
      },
      loadSentry: async () => sentry,
    });
    captureAppError("Not A Code! /with/path");
    expect(captured[0].tags!.error_code).toBe("invalid-error-code");
  });
});

describe("transaction scrubbing (beforeSendTransaction)", () => {
  const dirtyTransaction: SentryEventLike = {
    event_id: "tx1",
    type: "transaction",
    platform: "javascript",
    start_timestamp: 100,
    timestamp: 101,
    release: "a".repeat(40),
    environment: "production",
    transaction: "/?project=secret-project-id-77",
    transaction_info: { source: "url" },
    request: { url: "https://studio.example.com/?project=secret-project-id-77" },
    user: { id: "user-1" },
    tags: { error_code: "ignored-for-tx", routing: "/studio", layer_name: "Secret Layer" },
    contexts: {
      trace: {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "bbbbbbbbbbbbbbbb",
        op: "pageload",
        data: { "document.title": "Secret Client — DR.GLITCH" },
      },
      browser: { name: "Chrome" },
    },
    spans: [
      { description: "GET /assets/secret-client-logo.png", op: "resource.img" },
    ],
    breadcrumbs: [{ category: "ui.click", message: "button Secret" }],
    measurements: { lcp: { value: 2100 } },
  };

  it("rebuilds transactions: fixed name, trace ids only, everything else dropped", () => {
    const scrubbed = scrubTransactionEvent(dirtyTransaction);
    expect(scrubbed.transaction).toBe(REDACTED_TRANSACTION_NAME);
    expect(scrubbed.type).toBe("transaction");
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.spans).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.measurements).toBeUndefined();
    expect(scrubbed.contexts).toEqual({
      trace: {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "bbbbbbbbbbbbbbbb",
        op: "app",
      },
    });
    expect(scrubbed.tags).toEqual({});
    const serialized = JSON.stringify(scrubbed);
    for (const leak of ["secret", "Secret", "example.com", "project=", "logo.png"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("is installed as beforeSendTransaction in the init options", () => {
    const options = buildSentryInitOptions({
      dsn: "https://public@example.ingest.invalid/1",
      release: null,
      environment: "production",
      privateValidation: false,
    });
    const beforeSendTransaction = options.beforeSendTransaction as (
      event: SentryEventLike,
    ) => SentryEventLike;
    expect(typeof beforeSendTransaction).toBe("function");
    expect(beforeSendTransaction(dirtyTransaction).transaction).toBe(REDACTED_TRANSACTION_NAME);
  });
});

describe("duplicate suppression (handled captures vs global handlers)", () => {
  const env = {
    dsn: "https://public@example.ingest.invalid/1",
    release: null,
    environment: "production",
    privateValidation: false,
  };

  it("beforeSend drops events whose originalException was already reported", () => {
    const options = buildSentryInitOptions(env);
    const beforeSend = options.beforeSend as (
      event: SentryEventLike,
      hint?: { originalException?: unknown },
    ) => SentryEventLike | null;
    const error = new Error("boom");
    const globalEvent: SentryEventLike = {
      exception: { values: [{ type: "Error", value: "boom" }] },
    };
    // Unmarked: the global report passes (scrubbed).
    expect(beforeSend(globalEvent, { originalException: error })).not.toBeNull();
    // After a handled capture marked it: the global report is dropped.
    markErrorReported(error);
    expect(beforeSend(globalEvent, { originalException: error })).toBeNull();
    // Events with no hint (our own captureEvent payloads) always pass.
    expect(beforeSend(globalEvent)).not.toBeNull();
  });

  it("captureHandledError reports exactly once per error object", async () => {
    const { sentry, captured } = makeFakeSentry();
    await initTelemetry({ env, loadSentry: async () => sentry });
    const error = new Error("QuotaExceededError: db full");
    captureHandledError("storage-quota", error);
    captureHandledError("storage-quota", error); // journal retry
    captureHandledError("storage-write-failed", error); // second surface
    expect(captured).toHaveLength(1);
    expect(captured[0].tags!.error_code).toBe("storage-quota");
    expect(isErrorReported(error)).toBe(true);
  });

  it("captureAppError marks its cause even while telemetry is disabled", () => {
    const error = new Error("later escapes to window.onerror");
    captureAppError("export-failed", { cause: error });
    expect(isErrorReported(error)).toBe(true);
  });

  it("captureHandledError emits nothing without a DSN", () => {
    const error = new Error("no dsn");
    captureHandledError("storage-quota", error);
    expect(isTelemetryEnabled()).toBe(false);
    // Still marked, so a later global handler cannot leak it either.
    expect(isErrorReported(error)).toBe(true);
  });
});

describe("stableErrorCode", () => {
  it("passes through well-formed codes and falls back otherwise", () => {
    expect(stableErrorCode("archive-too-large", "x")).toBe("archive-too-large");
    expect(stableErrorCode("Not a code", "export-failed")).toBe("export-failed");
    expect(stableErrorCode(42, "export-failed")).toBe("export-failed");
    expect(stableErrorCode(undefined, "export-failed")).toBe("export-failed");
  });
});


describe("release telemetry privacy and spans", () => {
  const env = { dsn: "https://public@example.ingest.invalid/1", release: "a".repeat(40), environment: "production", privateValidation: false };
  it("contains SDK import/init failures so application boot can continue", async () => {
    expect(await initTelemetry({ env, loadSentry: async () => { throw new Error("offline"); } })).toBe(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(await initTelemetry({ env, loadSentry: async () => ({ init: () => { throw new Error("init"); }, captureEvent: () => undefined }) })).toBe(false);
  });
  it("starts and ends real SDK spans once with only fixed names and coarse attributes", async () => {
    const events: unknown[] = [];
    const sentry: SentryModuleLike = { init: () => undefined, captureEvent: () => undefined,
      startInactiveSpan: (options) => { events.push(options); return { setStatus: (status) => events.push(status), end: () => events.push("end") }; } };
    await initTelemetry({ env, loadSentry: async () => sentry });
    const finish = startAppSpan("app.export", { layerCount: 8, pixelCount: 19_000_000 });
    finish(); finish();
    expect(events).toEqual([{ name: "app.export", op: "app.export", forceTransaction: true,
      attributes: { layer_count_bucket: "5-8", pixel_count_bucket: "5-20MP" } }, { code: 1 }, "end"]);
    await expect(traceAppOperation("app.save", async () => { throw new Error("private filename"); })).rejects.toThrow("private filename");
    expect(JSON.stringify(events)).not.toContain("private filename");
  });
  it("drops arbitrary values in otherwise allowed fields and is idempotent", () => {
    const dirty = { release: "customer-name", environment: "customer-name", level: "customer-name",
      tags: { error_code: "customer-name", timing_bucket: "customer-name", pixel_count_bucket: "customer-name", cap_customer_name: true, cap_offscreen_canvas: true },
      exception: { values: [{ type: "customer-name", value: "customer-name", stacktrace: { frames: [{ filename: "/art/customer-name.js", function: "customer-name", lineno: 7 }] } }] } };
    const event = scrubEvent(dirty);
    expect(JSON.stringify(event)).not.toContain("customer-name");
    expect(JSON.stringify(event)).not.toContain("cap_customer_name");
    expect(scrubEvent(event)).toEqual(event);
  });
  it("preserves only validated source-map debug metadata and compiled stack positions", () => {
    const event = scrubEvent({ debug_meta: { images: [
      { type: "sourcemap", debug_id: "12345678-abcd-1234-abcd-123456789abc", code_file: "https://studio.example/assets/index-abcdefgh.js?private=1", secret: "private" },
      { type: "sourcemap", debug_id: "private", code_file: "/art/private.js" },
    ] } });
    expect(event.debug_meta).toEqual({ images: [{ type: "sourcemap", debug_id: "12345678-abcd-1234-abcd-123456789abc", code_file: "~/assets/index-abcdefgh.js" }] });
    expect(scrubEvent(event)).toEqual(event);
  });
  it("keeps fixed application spans and rejects automatic resource descriptions", () => {
    const event = scrubTransactionEvent({ transaction: "app.import", spans: [
      { op: "app.save", description: "private.svg", trace_id: "a".repeat(32), span_id: "b".repeat(16), start_timestamp: 1, timestamp: 2, data: { filename: "private.svg" } },
      { op: "resource.img", description: "private.svg", trace_id: "a".repeat(32), span_id: "c".repeat(16), start_timestamp: 1, timestamp: 2 },
    ] });
    expect(event.transaction).toBe("app.import");
    expect(event.spans).toHaveLength(1);
    expect(JSON.stringify(event)).not.toContain("private.svg");
  });
});
