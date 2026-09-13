/**
 * PERFORMANCE GATE (wave G1) — eight DISTINCT 3600×5280 layers through the
 * production render path, in a real Chromium page with real module workers:
 *
 * 1. real-canvas tiled-vs-whole rasterization identity (plan.tiles path);
 * 2. controlled draft scrub loop: p95 draft latency ≤ 150 ms and ZERO
 *    main-thread long tasks (>50 ms) during the interaction window;
 * 3. exact settle parity with a single-shot render (hash compare at probe
 *    scale 0.25 — the full sheet has NO runnable single-shot form by
 *    design; full-resolution streamed/single-shot bit-identity is proven
 *    per band height in tests/unit/render-streaming-equivalence.test.ts);
 * 4. full-sheet CMYK PNG package through the REAL studio export path:
 *    IndexedDB AssetRepository → AssetCache → startStudioExport →
 *    WorkerRenderService → CompressionStream PNG → zip.js → native OPFS.
 *    Process memory peak ≤ 768 MiB measured with
 *    performance.measureUserAgentSpecificMemory (the page is made
 *    crossOriginIsolated by injecting COOP/COEP on every same-origin
 *    response). The gate FAILS when that API is unavailable — it never
 *    passes on usedJSHeapSize or any weaker proxy; the app-side allocation
 *    ledger and the planner model are reported alongside it.
 *
 * Run serially: DRG_E2E_PORT=4343 npx playwright test tests/e2e/perf-benchmark.spec.ts --workers=1
 */
import http from "node:http";
import { expect, test } from "@playwright/test";

const BUDGET_BYTES = 768 * 1024 * 1024;
const UPSTREAM_PORT = Number(process.env.DRG_E2E_PORT ?? 4343);

test.describe.configure({ mode: "serial" });
// Full-sheet export alone renders 32 (plate, layer) passes at 19 MP.
test.setTimeout(900_000);

// FULL Chromium (not the headless shell) with site isolation left on:
// performance.measureUserAgentSpecificMemory — the only honest
// process-wide meter — needs both. The memory gate FAILS rather than
// passing on a weaker metric when the API is unavailable.
test.use({
  channel: "chromium",
  launchOptions: { ignoreDefaultArgs: ["--disable-site-isolation-trials"] },
});

/**
 * COOP/COEP must arrive on REAL network responses for Chromium to grant
 * crossOriginIsolated (route.fulfill cannot), and dedicated worker scripts
 * under require-corp must themselves carry COEP. A pass-through proxy in
 * front of the vite dev server adds the headers to every response — no
 * server configuration is touched.
 */
let proxy: http.Server;
let proxyPort: number;

test.beforeAll(async () => {
  proxy = http.createServer((request, response) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: UPSTREAM_PORT,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...upstreamResponse.headers,
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  proxyPort = typeof address === "object" && address ? address.port : 0;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  await page.goto(`http://127.0.0.1:${proxyPort}/tests/e2e/harness-perf.html`);
  await page.waitForFunction(() => window.perfReady === true, undefined, { timeout: 60_000 });
});

test("real canvas: canonical tile schedule deterministic for EVERY dot shape; single-canvas deviation bounded", async ({ page }) => {
  const result = await page.evaluate(() => window.perfApi.tiledIdentity());
  console.log(`[perf] tiled identity: ${JSON.stringify(result.shapes)}`);
  // Contract (see executor.ts TILING CONTRACT): the canonical planner
  // schedule is part of the output definition — repeated runs are
  // byte-identical and every production path shares the schedule, so
  // cross-path outputs agree byte-for-byte (service parity test below +
  // unit equivalence suites). A single artboard-sized canvas is NOT a
  // production path: Skia rasterizes paths in 26.6 fixed point (1/64 px),
  // so integer-translated geometry snaps to a different 1/64 sub-grid and
  // an antialiased edge can shift by up to 1/64 px — on a pixel crossed by
  // two edges (rings, thin bars, acute polygon tips) the coverage delta
  // reaches ~0.35 alpha. Measured across all seven shapes (this suite):
  // maxΔ 0.21–0.35 on 0.05%–0.24% of pixels. Gate: ≤ 92/255 (0.36) per
  // pixel on < 0.5% of pixels, per shape.
  expect(result.shapes.length).toBe(7);
  for (const shape of result.shapes) {
    expect(shape.dots, shape.shape).toBeGreaterThan(500);
    expect(shape.deterministic, shape.shape).toBe(true);
    expect(shape.maxDelta, shape.shape).toBeLessThanOrEqual(92 / 255);
    expect(shape.mismatchFraction, shape.shape).toBeLessThan(0.005);
  }
});

test("real service: streamed and single-shot composite bytes are identical", async ({ page }) => {
  const parity = await page.evaluate(() => window.perfApi.serviceStreamParity());
  console.log(`[perf] service stream parity: ${JSON.stringify(parity)}`);
  expect(parity.forms[0]).toBe("single-shot");
  expect(parity.singleHash).toBe(parity.streamedHash);
  expect(parity.equal).toBe(true);
});

test("draft scrub: p95 ≤ 150ms, no >50ms main-thread tasks during interaction", async ({ page }) => {
  const scrub = await page.evaluate(() => window.perfApi.scrub(30), undefined);
  console.log(
    `[perf] draft ${scrub.draftWidth}×${scrub.draftHeight}: WARM median ${scrub.median.toFixed(1)}ms ` +
      `p95 ${scrub.p95.toFixed(1)}ms; COLD samples ${JSON.stringify(scrub.coldSamples.map((sample) => Math.round(sample)))} ` +
      `(max ${scrub.coldMax.toFixed(1)}ms); exact settle ${scrub.settleMs.toFixed(0)}ms; longtasks ${JSON.stringify(scrub.longTasks)}`,
  );
  expect(scrub.samples.length).toBe(30);
  expect(scrub.coldSamples.length).toBe(3);
  // The scrub ends with the REAL exact settle (idle plan fired): the
  // adaptive-draft gate must schedule it even at equal public scales.
  expect(scrub.exactDelivered).toBe(true);
  // WARM steady-state gate; the COLD path is reported above, not hidden —
  // production pays it once per opened document (worker/JIT warm-up and
  // the first draft-cache fill persist on the preview worker), never per
  // interaction.
  expect(scrub.p95).toBeLessThanOrEqual(150);
  // The long-task watch covers the WHOLE loop, cold frames included;
  // PerformanceObserver("longtask") only reports tasks > 50ms — there must
  // be none at all.
  expect(scrub.longTasks).toEqual([]);
});

test("exact settle matches a single-shot render (hash at probe scale)", async ({ page }) => {
  const parity = await page.evaluate(() => window.perfApi.settleParity());
  console.log(`[perf] settle parity: exact=${parity.exact} single=${parity.single}`);
  expect(parity.exact).toBe(parity.single);
  expect(parity.equal).toBe(true);
});

test("production delivery edges: pre-render refusal and native OPFS cancel arbitration", async ({ page }) => {
  test.setTimeout(300_000);
  const result = await page.evaluate(() => window.perfApi.productionEdges());
  console.log(`[perf] production edges: ${JSON.stringify(result)}`);

  // Natural >256 MiB route with no FSA: both preflight and the direct
  // startStudioExport defense-in-depth gate refuse before decode, cache
  // suspension, rendering, or buffered delivery.
  expect(result.noFsa.preflightBlockCodes).toContain("delivery-exceeded");
  expect(result.noFsa.exportCode).toBe("delivery-exceeded");
  expect(result.noFsa.decodeSnapshots).toBe(0);
  expect(result.noFsa.suspends).toBe(0);
  expect(result.noFsa.resumes).toBe(0);
  expect(result.noFsa.deliverCalls).toBe(0);

  // Cancellation does not pretend a hostile, still-pending write released
  // its buffers. The native OPFS temp write is aborted, the original target
  // survives, and the captured receipt releases only when the write really
  // settles after the harness opens its gate.
  expect(result.blockedWrite.opfsHandleTag).toBe("[object FileSystemFileHandle]");
  expect(result.blockedWrite.exportCode).toBe("export-cancelled");
  expect(result.blockedWrite.cancelMs).toBeLessThanOrEqual(250);
  expect(result.blockedWrite.aborts).toBe(1);
  expect(result.blockedWrite.closes).toBe(0);
  expect(result.blockedWrite.preservedText).toBe("sentinel-write");
  expect(result.blockedWrite.ledgerWhileHostileWriteRetained.currentBytes).toBeGreaterThan(0);
  expect(result.blockedWrite.ledgerDrained).toBe(true);
  expect(result.blockedWrite.ledgerAfterHostileWriteSettled.currentBytes).toBe(0);
  expect(result.blockedWrite.ledgerAfterHostileWriteSettled.liveAllocations).toBe(0);

  // The same first-terminal-wins rule holds while native close is pending:
  // abort wins, the late close is contained, and no temporary bytes commit.
  expect(result.closeRace.exportCode).toBe("export-cancelled");
  expect(result.closeRace.cancelMs).toBeLessThanOrEqual(250);
  expect(result.closeRace.aborts).toBe(1);
  expect(result.closeRace.closeCalls).toBe(1);
  expect(result.closeRace.preservedText).toBe("sentinel-close");
  expect(result.closeRace.ledgerDrained).toBe(true);
  expect(result.closeRace.ledger.currentBytes).toBe(0);
  expect(result.closeRace.ledger.liveAllocations).toBe(0);
  expect(result.suspendsAfterEdges).toBe(2);
  expect(result.resumesAfterEdges).toBe(2);
  expect(result.decodeSnapshotsAfterEdges).toBeGreaterThanOrEqual(5);
});

test("full-sheet production export: native streamed ZIP stays within the 768 MiB process budget", async ({ page }) => {
  test.setTimeout(1_200_000);
  const isolated = await page.evaluate(() => window.perfApi.crossOriginIsolated());
  console.log(`[perf] crossOriginIsolated=${isolated}`);
  const result = await page.evaluate(() => window.perfApi.runProductionExport());
  console.log(
    `[perf] production export ${result.width}×${result.height} ${result.artifact.name} ` +
      `(${(result.artifact.size / 1048576).toFixed(1)}MiB) in ${(result.ms / 1000).toFixed(1)}s; ` +
      `plan(form=${result.plan.form} est=${(result.plan.estimatedPeakBytes / 1048576).toFixed(1)}MiB ` +
      `worker=${(result.plan.workerPeakBytes / 1048576).toFixed(1)}MiB app=${(result.plan.appPeakBytes / 1048576).toFixed(1)}MiB); ` +
      `ledger(peak=${(result.ledger.peakBytes / 1048576).toFixed(1)}MiB current=${(result.ledger.currentBytes / 1048576).toFixed(1)}MiB); ` +
      `delivery(est=${(result.delivery.estimatedBytes / 1048576).toFixed(1)}MiB writes=${result.delivery.writes} ` +
      `maxChunk=${result.delivery.maxRetainedWriteBytes}); ` +
      `decodeSnapshots=${result.storage.decodeSnapshotsDuringExport}; ` +
      `memory(${result.memory.api} baseline=${result.memory.baselineBytes} peak=${result.memory.peakBytes} ` +
      `samples=${result.memory.samples})`,
  );
  expect(result.ok).toBe(true);
  expect(result.runtime.crossOriginIsolated).toBe(true);
  expect(result.runtime.moduleWorkers).toBe(true);
  expect(result.runtime.offscreenCanvas).toBe(true);
  expect(result.runtime.compressionStream).toBe(true);
  expect(result.runtime.opfsHandleTag).toBe("[object FileSystemFileHandle]");
  expect(result.preflightBlockCodes).toEqual([]);
  expect(result.progressEvents).toBeGreaterThan(10);
  // The unmodified production policy makes this 4-plate sheet stream. No
  // dev threshold is involved and the buffered delivery callback is inert.
  expect(result.delivery.estimatedBytes).toBeGreaterThan(256 * 1024 * 1024);
  expect(result.delivery.mode).toBe("stream");
  expect(result.delivery.resultBlobWasNull).toBe(true);
  expect(result.delivery.bufferedDeliverCalls).toBe(0);
  expect(result.delivery.writes).toBeGreaterThan(1);
  expect(result.delivery.maxConcurrentWrites).toBe(1);
  expect(result.delivery.maxRetainedWriteBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(result.delivery.closes).toBe(1);
  expect(result.delivery.aborts).toBe(0);
  expect(result.delivery.acceptedBytes).toBe(result.artifact.size);

  // Bounded file inspection only: ZIP local header, first stored PNG entry,
  // and an EOCD in the final 65,557 bytes. The test never materializes the
  // completed archive in memory.
  expect(result.artifact.firstEntryName).toBe("production-proof-C-plate.png");
  expect(result.artifact.zipLocalHeader).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(result.artifact.pngSignature).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(result.artifact.hasEocd).toBe(true);

  // Real record-bound decodes: one warm cache fill before export, then one
  // uncached decode per (plate, layer) in the streamed session.
  expect(result.storage.records).toBe(8);
  expect(result.storage.encodedBytes.every((bytes) => bytes > 0 && bytes <= 50 * 1024 * 1024)).toBe(true);
  expect(result.storage.decodeSnapshotsBeforeExport).toBe(1);
  expect(result.storage.decodeSnapshotsDuringExport).toBe(4 * 8);

  // Suspension evicts both AssetCache owners. A subscriber deliberately
  // re-reads getImage during the invalidation notification; the entry guard
  // must prevent that notification from starting repository/decode work.
  expect(result.suspension.imageCacheBefore).toBe(1);
  expect(result.suspension.rasterCacheBefore).toBe(1);
  expect(result.suspension.suspends).toBe(1);
  expect(result.suspension.resumes).toBe(1);
  expect(result.suspension.epochDelta).toBe(1);
  expect(result.suspension.imageCacheAtSuspend).toBe(0);
  expect(result.suspension.rasterCacheAtSuspend).toBe(0);
  expect(result.suspension.notifications).toBe(1);
  expect(result.suspension.readsTriggeredByNotification).toBe(0);
  expect(result.suspension.activeAtFirstProgress).toBe(true);
  expect(result.suspension.imageCacheAtFirstProgress).toBe(0);
  expect(result.suspension.rasterCacheAtFirstProgress).toBe(0);
  // The plan admits the job (no hard block) and models it inside budget.
  expect(result.plan.form).toBe("streamed");
  expect(result.plan.withinBudget).toBe(true);
  expect(result.plan.estimatedPeakBytes).toBeLessThanOrEqual(BUDGET_BYTES);
  // The allocation ledger here is a PAGE-REALM diagnostic only (the export
  // worker has its own uninstrumented realm): it bounds the app-side share,
  // never the process. UASM above is the sole process-wide gate metric.
  expect(result.ledger.peakBytes).toBeLessThanOrEqual(result.plan.appPeakBytes + 128 * 1024 * 1024);
  expect(result.ledger.currentBytes).toBe(0);
  expect(result.ledger.liveAllocations).toBe(0);
  // MEASURED process peak: performance.measureUserAgentSpecificMemory ONLY
  // (page + dedicated workers of the agent cluster). The gate FAILS when
  // the precise API is unavailable — it never passes on the bucketed
  // usedJSHeapSize stub or any weaker proxy.
  expect(result.memory.api).toBe("measureUserAgentSpecificMemory");
  expect(result.memory.peakBytes).not.toBeNull();
  expect(result.memory.peakBytes!).toBeLessThanOrEqual(BUDGET_BYTES);
});
