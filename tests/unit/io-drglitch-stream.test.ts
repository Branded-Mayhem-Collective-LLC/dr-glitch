/**
 * .drglitch streamed export (wave G2), DIRECT-level coverage: the frozen
 * metadata-only plan (planDrglitchExport: exact UTF-8 metadata sizes, real
 * record byteLengths, typed failure on missing rows, ZERO body reads), the
 * streamed entry-wise packager (exportDrglitchToSink: importable output,
 * TOCTOU rejection against the frozen manifest — streamed AND buffered —
 * cap enforcement BEFORE the overflowing write, pre-aborted signals write
 * nothing, cancel mid-entry aborts the archive), and single-body-per-entry
 * accounting.
 */
import { describe, expect, it } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { ProjectEnvelopeV1 } from "../../src/core/types";
import {
  DRGLITCH_MAX_PROJECT_BYTES,
  exportDrglitch,
  exportDrglitchToSink,
  importDrglitch,
  planDrglitchExport,
  type StagingSink,
} from "../../src/io/drglitch";
import { sha256Hex } from "../../src/io/sha256";
import { SVG_PROFILE_LIMITS } from "../../src/io/svg-sanitizer";
import { referenceRasterDecoder } from "./helpers/raster-fixtures";

const encoder = new TextEncoder();

/** Well-known valid 1x1 transparent PNG (same as the io-drglitch suite). */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const HALFTONE = { cellSize: 12, dotShape: "round" as const, customShapeAssetId: null, invert: false, strokeWidth: 1, frayedXEdge: 0, frayedYEdge: 0 };
const DIFFUSION = { algorithm: "none" as const, modulation: "none" as const, modStrength: 0, intensity: 0, levels: 2, sharpenStrength: 0, sharpenRadius: 1, denoise: 0, brokenKernel: 0, directionalBias: 0, directionalBiasAngle: 0, errorOverflow: 0, reset: 0, crossChannelBleed: 0, invert: false };
const GLITCH = { enabled: false, sliceShift: 0, sliceSize: 0, verticalSliceShift: 0, verticalSliceSize: 0, gridWarp: 0, warpScale: 0, smearDrag: 0, smearLength: 0, smearVertical: false, macroblockCorrupt: 0, macroblockDropout: 0, blockShift: 0, blockShiftSize: 0, channelDesync: 0, bitmapSort: 0, bitmapSortVertical: false };

function makeEnvelope(assetId: string): ProjectEnvelopeV1 {
  return {
    schema: 1,
    id: "original-id",
    title: "Ünïcode Project — τεστ", // multibyte title exercises UTF-8 sizing
    createdAt: 1,
    updatedAt: 2,
    savedRevision: 7,
    core: {
      schema: 1,
      artboard: { widthPx: 960, heightPx: 1440, presetId: "custom", background: "white" },
      layers: [
        {
          id: "layer-1",
          name: "Layer",
          assetId,
          visible: true,
          locked: false,
          opacity: 1,
          crop: null,
          transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, flipH: false, flipV: false, skew: { x: 0, y: 0 }, perspective: null },
          recipe: { mode: "halftone", halftone: { ...HALFTONE }, diffusion: { ...DIFFUSION }, glitch: { ...GLITCH } },
        },
      ],
      separation: {
        mode: "cmyk",
        angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
        visible: { cyan: true, magenta: true, yellow: true, black: true },
      },
      registration: { size: null, offset: null, weight: 1, mode: "corners", customShapeAssetId: null },
      guides: { horizontal: [], vertical: [], locked: false, visible: true },
      grid: { visible: false, size: 24 },
      snapping: { enabled: true, toGuides: true, toGrid: true, toLayers: true, toArtboard: true },
      output: { polarity: "positive", pressMirror: false, registrationOnPlates: true, registrationOnComposite: false },
      unitPreference: "px",
    },
    snapshots: [],
  } as ProjectEnvelopeV1;
}

function makeSink() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
    write(chunk: Uint8Array) {
      chunks.push(chunk.slice());
    },
  };
}

function memStagingSink(): StagingSink {
  return { allocate: () => undefined, write: () => undefined, commit: () => undefined, abort: () => undefined };
}

async function fixture() {
  const pngSha = await sha256Hex(PNG);
  const envelope = makeEnvelope(pngSha);
  let bodyReads = 0;
  const getAsset = (sha: string) => {
    bodyReads += 1;
    return sha === pngSha ? { bytes: PNG, ext: "png" as const } : null;
  };
  const getThumbnail = () => null;
  const getRecord = async (sha: string) =>
    sha === pngSha
      ? {
          sha256: pngSha,
          kind: "raster" as const,
          byteLength: PNG.length,
          mime: "image/png",
          width: 1,
          height: 1,
        }
      : undefined;
  const getBoundSource = async (sha: string) => {
    const record = await getRecord(sha);
    if (!record) return undefined;
    return {
      record,
      readBytes: async () => {
        bodyReads += 1;
        return PNG;
      },
    };
  };
  return {
    pngSha,
    envelope,
    getAsset,
    getThumbnail,
    getRecord,
    getBoundSource,
    bodyReads: () => bodyReads,
  };
}

describe("planDrglitchExport", () => {
  it("plans metadata-only (ZERO body reads), UTF-8-exact JSON sizes, real record byteLengths, ZIP overhead", async () => {
    const { envelope, getRecord, getBoundSource, bodyReads, pngSha } = await fixture();
    const plan = await planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord });
    expect(bodyReads()).toBe(0); // never a body during planning
    const project = plan.entries.find((entry) => entry.kind === "project")!;
    // Exact UTF-8 byte count — .length on the multibyte title would lie.
    const serialized = JSON.stringify(plan.envelope);
    expect(project.byteLength).toBe(encoder.encode(serialized).length);
    expect(project.byteLength).toBeGreaterThan(serialized.length);
    const asset = plan.entries.find((entry) => entry.kind === "asset")!;
    expect(asset.sha256).toBe(pngSha);
    expect(asset.byteLength).toBe(PNG.length);
    expect(plan.largestEntryBytes).toBe(Math.max(project.byteLength, PNG.length));
    expect(plan.totalEntryBytes).toBe(
      plan.entries.reduce((sum, entry) => sum + entry.byteLength, 0),
    );
    expect(plan.bufferedPeakBytes).toBe(plan.totalEntryBytes + 2 * plan.estimatedBytes);
    // Conservative: the estimate dominates the ACTUAL streamed bytes.
    const sink = makeSink();
    await exportDrglitchToSink({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", sink, plan, getBoundSource });
    expect(plan.estimatedBytes).toBeGreaterThanOrEqual(sink.bytes().length);
  });

  it("fails the plan TYPED on a missing record — a broken project surfaces pre-picker, never as a zero count", async () => {
    const { envelope } = await fixture();
    await expect(
      planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord: async () => undefined }),
    ).rejects.toMatchObject({ code: "asset-missing" });
  });

  it("rejects an oversized raster row from metadata before any body allocation", async () => {
    const { envelope, pngSha, bodyReads } = await fixture();
    await expect(
      planDrglitchExport({
        envelope,
        appVersion: "0.1.0",
        getRecord: async () => ({
          sha256: pngSha,
          kind: "raster",
          mime: "image/png",
          byteLength: RESOURCE_POLICY.maxRasterBytes + 1,
          width: 1,
          height: 1,
        }),
      }),
    ).rejects.toMatchObject({ code: "asset-invalid" });
    expect(bodyReads()).toBe(0);
  });

  it("accepts the raster byte cap exactly and rejects cap + 1", async () => {
    const { envelope, pngSha } = await fixture();
    const recordAt = (byteLength: number) => ({
      sha256: pngSha,
      kind: "raster" as const,
      mime: "image/png",
      byteLength,
      width: 1,
      height: 1,
    });
    await expect(
      planDrglitchExport({
        envelope,
        appVersion: "0.1.0",
        getRecord: async () => recordAt(RESOURCE_POLICY.maxRasterBytes),
      }),
    ).resolves.toMatchObject({ entries: expect.any(Array) });
    await expect(
      planDrglitchExport({
        envelope,
        appVersion: "0.1.0",
        getRecord: async () => recordAt(RESOURCE_POLICY.maxRasterBytes + 1),
      }),
    ).rejects.toMatchObject({ code: "asset-invalid" });
  });

  it("uses the strictest SVG role cap, exact inclusive and +1 rejected", async () => {
    const { pngSha } = await fixture();
    const svgSha = "b".repeat(64);
    const cases = [
      {
        name: "artwork",
        cap: SVG_PROFILE_LIMITS.artwork.maxBytes,
        envelope: makeEnvelope(svgSha),
      },
      {
        name: "custom-dot",
        cap: SVG_PROFILE_LIMITS["custom-dot"].maxBytes,
        envelope: (() => {
          const value = makeEnvelope(pngSha);
          value.core.layers[0].recipe.halftone.customShapeAssetId = svgSha;
          return value;
        })(),
      },
      {
        name: "custom-dot + registration-mark",
        cap: SVG_PROFILE_LIMITS["registration-mark"].maxBytes,
        envelope: (() => {
          const value = makeEnvelope(pngSha);
          value.core.layers[0].recipe.halftone.customShapeAssetId = svgSha;
          value.core.registration.customShapeAssetId = svgSha;
          return value;
        })(),
      },
    ];
    for (const testCase of cases) {
      const getRecord = async (sha: string, _kind: "asset" | "thumbnail") =>
        sha === svgSha
          ? {
              sha256: svgSha,
              kind: "svg" as const,
              mime: "image/svg+xml",
              byteLength: testCase.cap,
              width: 1,
              height: 1,
            }
          : {
              sha256: pngSha,
              kind: "raster" as const,
              mime: "image/png",
              byteLength: PNG.length,
              width: 1,
              height: 1,
            };
      await expect(
        planDrglitchExport({
          envelope: testCase.envelope,
          appVersion: "0.1.0",
          getRecord,
        }),
        testCase.name,
      ).resolves.toMatchObject({ entries: expect.any(Array) });
      await expect(
        planDrglitchExport({
          envelope: testCase.envelope,
          appVersion: "0.1.0",
          getRecord: async (sha, kind) => {
            const record = await getRecord(sha, kind);
            return sha === svgSha ? { ...record, byteLength: testCase.cap + 1 } : record;
          },
        }),
        testCase.name,
      ).rejects.toMatchObject({ code: "asset-invalid" });
    }
  });

  it("rejects malformed dimensions and generated metadata before any source body", async () => {
    const { envelope, pngSha, bodyReads } = await fixture();
    await expect(
      planDrglitchExport({
        envelope,
        appVersion: "0.1.0",
        getRecord: async () => ({
          sha256: pngSha,
          kind: "raster",
          mime: "image/png",
          byteLength: PNG.length,
          width: 1.5,
          height: 1,
        }),
      }),
    ).rejects.toMatchObject({ code: "asset-invalid" });
    let providerCalls = 0;
    await expect(
      planDrglitchExport({
        envelope,
        appVersion: "x".repeat(65),
        getRecord: async () => {
          providerCalls += 1;
          return undefined;
        },
      }),
    ).rejects.toMatchObject({ code: "manifest-invalid" });
    expect(providerCalls).toBe(0);
    expect(bodyReads()).toBe(0);
    expect(DRGLITCH_MAX_PROJECT_BYTES).toBeGreaterThan(0);
  });

  it("cancels a cooperative metadata provider without waiting for its normal result", async () => {
    const { envelope } = await fixture();
    const controller = new AbortController();
    let providerAborted = false;
    const pending = planDrglitchExport({
      envelope,
      appVersion: "0.1.0",
      signal: controller.signal,
      getRecord: async (_sha, _kind, signal) =>
        new Promise((_, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerAborted).toBe(true);
  });
});

describe("exportDrglitchToSink", () => {
  it("streams an archive that importDrglitch accepts end to end", async () => {
    const { envelope, getBoundSource, getRecord } = await fixture();
    const plan = await planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord });
    const sink = makeSink();
    const { bytesWritten } = await exportDrglitchToSink({ decoder: referenceRasterDecoder,
      envelope,
      appVersion: "0.1.0",
      sink,
      plan,
      getBoundSource,
    });
    expect(bytesWritten).toBe(sink.bytes().length);
    await importDrglitch(sink.bytes(), {
      sink: memStagingSink(),
      decoder: referenceRasterDecoder,
      newProjectId: () => "imported-id",
      now: () => 1000,
    });
  });

  it("TOCTOU: a row swapped between plan and write rejects typed on BOTH delivery modes", async () => {
    const { envelope, getRecord, pngSha } = await fixture();
    const plan = await planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord });
    // Swap the ROW post-plan: same key, different stored size. With the
    // split record provider the divergence is caught from METADATA —
    // BEFORE any body is materialized (blob-level zero-read proof).
    let bodyReads = 0;
    const swappedBound = async (sha: string) =>
      sha === pngSha
        ? {
            record: {
              sha256: pngSha,
              kind: "raster" as const,
              byteLength: PNG.length + 8,
              mime: "image/png",
              width: 1,
              height: 1,
            },
            readBytes: async () => {
              bodyReads += 1;
              return new Uint8Array(PNG.length + 8);
            },
          }
        : undefined;
    const sink = makeSink();
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        sink,
        plan,
        getBoundSource: swappedBound,
      }),
    ).rejects.toMatchObject({ code: "plan-mismatch" });
    await expect(
      exportDrglitch({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        plan,
        getBoundSource: swappedBound,
      }),
    ).rejects.toMatchObject({ code: "plan-mismatch" });
    expect(bodyReads).toBe(0); // rejected pre-materialization on BOTH paths
    // Frozen execution deliberately refuses split legacy providers rather
    // than materializing a body whose metadata is not transactionally bound.
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        sink: makeSink(),
        plan,
        getAsset: () => {
          bodyReads += 1;
          return { bytes: new Uint8Array(PNG.length + 8), ext: "png" as const };
        },
        getThumbnail: () => null,
      }),
    ).rejects.toMatchObject({ code: "plan-mismatch" });
    expect(bodyReads).toBe(0);
    // An asset OUTSIDE the frozen plan is refused BEFORE its body read.
    const foreignPlan = { ...plan, entries: plan.entries.filter((entry) => entry.kind !== "asset") };
    let bodyRead = false;
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        sink: makeSink(),
        plan: foreignPlan,
        getBoundSource: async () => ({
          record: {
            sha256: pngSha,
            kind: "raster",
            byteLength: PNG.length,
            mime: "image/png",
            width: 1,
            height: 1,
          },
          readBytes: async () => {
            bodyRead = true;
            return PNG;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "plan-mismatch" });
    expect(bodyRead).toBe(false); // membership rejected pre-materialization
  });

  it("rejects a same-size thumbnail MIME swap before reading its bound body", async () => {
    const { envelope, pngSha, getRecord } = await fixture();
    envelope.snapshots = [
      {
        id: "snap-1",
        name: "Checkpoint",
        createdAt: 5,
        thumbnailId: pngSha,
        core: structuredClone(envelope.core),
      },
    ];
    const plannedRecord = async (sha: string, kind: "asset" | "thumbnail") =>
      kind === "thumbnail"
        ? {
            sha256: pngSha,
            kind: "thumbnail" as const,
            mime: "image/png",
            byteLength: PNG.length,
            width: 1,
            height: 1,
          }
        : getRecord(sha);
    const plan = await planDrglitchExport({
      envelope,
      appVersion: "0.1.0",
      getRecord: plannedRecord,
    });

    const run = async (streamed: boolean) => {
      let thumbnailReads = 0;
      const getBoundSource = async (_sha: string, kind: "asset" | "thumbnail") => ({
        record:
          kind === "thumbnail"
            ? {
                sha256: pngSha,
                kind: "thumbnail" as const,
                mime: "image/jpeg",
                byteLength: PNG.length,
                width: 1,
                height: 1,
              }
            : {
                sha256: pngSha,
                kind: "raster" as const,
                mime: "image/png",
                byteLength: PNG.length,
                width: 1,
                height: 1,
              },
        readBytes: async () => {
          if (kind === "thumbnail") thumbnailReads += 1;
          return PNG;
        },
      });
      const promise = streamed
        ? exportDrglitchToSink({ decoder: referenceRasterDecoder,
            envelope,
            appVersion: "0.1.0",
            plan,
            sink: makeSink(),
            getBoundSource,
          })
        : exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", plan, getBoundSource });
      await expect(promise).rejects.toMatchObject({ code: "plan-mismatch" });
      expect(thumbnailReads).toBe(0);
    };
    await run(true);
    await run(false);
  });

  it("enforces the compressed cap BEFORE the overflowing write reaches the sink", async () => {
    const { envelope, getAsset, getThumbnail } = await fixture();
    let written = 0;
    const sink = {
      write: (chunk: Uint8Array) => {
        written += chunk.length;
      },
    };
    const tinyPolicy = { ...RESOURCE_POLICY, maxArchiveCompressedBytes: 64 };
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", sink, getAsset, getThumbnail, policy: tinyPolicy }),
    ).rejects.toMatchObject({ code: "archive-too-large" });
    // Nothing past the cap ever reached the sink.
    expect(written).toBeLessThanOrEqual(64);
  });

  it("a PRE-ABORTED signal writes NOTHING; cancel mid-stream stops between entries", async () => {
    const { envelope, getAsset, getThumbnail } = await fixture();
    const aborted = new AbortController();
    aborted.abort();
    const sink = makeSink();
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        sink,
        signal: aborted.signal,
        getAsset,
        getThumbnail,
      }),
    ).rejects.toThrow();
    expect(sink.bytes().length).toBe(0);

    const controller = new AbortController();
    const sink2 = makeSink();
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        sink: sink2,
        signal: controller.signal,
        getAsset: () => {
          // Cancel lands while the asset body is being fetched.
          controller.abort();
          return { bytes: PNG, ext: "png" as const };
        },
        getThumbnail,
      }),
    ).rejects.toThrow();
  });

  it("reads each asset body exactly ONCE through plan → execute (single materialization)", async () => {
    const { envelope, getBoundSource, getRecord, bodyReads } = await fixture();
    const plan = await planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord });
    expect(bodyReads()).toBe(0);
    const sink = makeSink();
    await exportDrglitchToSink({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", sink, plan, getBoundSource });
    expect(bodyReads()).toBe(1);
  });

  it("rejects a same-metadata, same-length poisoned body by hash on both delivery modes", async () => {
    const { envelope, getRecord, pngSha } = await fixture();
    const plan = await planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord });
    const poisoned = PNG.slice();
    poisoned[poisoned.length - 1] ^= 0xff;
    for (const streamed of [false, true]) {
      let reads = 0;
      const getBoundSource = async () => ({
        record: await getRecord(pngSha) as NonNullable<Awaited<ReturnType<typeof getRecord>>>,
        readBytes: async () => {
          reads += 1;
          return poisoned;
        },
      });
      const run = streamed
        ? exportDrglitchToSink({ decoder: referenceRasterDecoder,
            envelope,
            appVersion: "0.1.0",
            plan,
            sink: makeSink(),
            getBoundSource,
          })
        : exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", plan, getBoundSource });
      await expect(run).rejects.toMatchObject({ code: "asset-hash-mismatch" });
      expect(reads).toBe(1);
    }
  });

  it("enforces buffered peak admission before reads while streaming remains eligible", async () => {
    const exactFixture = await fixture();
    const plan = await planDrglitchExport({
      envelope: exactFixture.envelope,
      appVersion: "0.1.0",
      getRecord: exactFixture.getRecord,
    });
    const exactPolicy = { ...RESOURCE_POLICY, maxRenderPeakBytes: plan.bufferedPeakBytes };
    await expect(
      exportDrglitch({ decoder: referenceRasterDecoder,
        envelope: exactFixture.envelope,
        appVersion: "0.1.0",
        plan,
        policy: exactPolicy,
        getBoundSource: exactFixture.getBoundSource,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);

    const refusedFixture = await fixture();
    const lowPolicy = { ...RESOURCE_POLICY, maxRenderPeakBytes: plan.bufferedPeakBytes - 1 };
    await expect(
      exportDrglitch({ decoder: referenceRasterDecoder,
        envelope: refusedFixture.envelope,
        appVersion: "0.1.0",
        plan,
        policy: lowPolicy,
        getBoundSource: refusedFixture.getBoundSource,
      }),
    ).rejects.toMatchObject({ code: "archive-working-set" });
    expect(refusedFixture.bodyReads()).toBe(0);

    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope: refusedFixture.envelope,
        appVersion: "0.1.0",
        plan,
        policy: lowPolicy,
        sink: makeSink(),
        getBoundSource: refusedFixture.getBoundSource,
      }),
    ).resolves.toMatchObject({ bytesWritten: expect.any(Number) });
    expect(RESOURCE_POLICY.maxRenderPeakBytes).toBeGreaterThanOrEqual(
      3 * RESOURCE_POLICY.maxBlobDownloadBytes,
    );
  });

  it("post-close cancellation arbitration: a signal that fired during close never reports success", async () => {
    const { envelope, getAsset, getThumbnail } = await fixture();
    const controller = new AbortController();
    let entries = 0;
    const sink = {
      write: () => {
        entries += 1;
        // Fire the cancel while the FINAL bytes (central directory) drain.
        if (entries > 2) controller.abort();
      },
    };
    await expect(
      exportDrglitchToSink({ decoder: referenceRasterDecoder,
        envelope,
        appVersion: "0.1.0",
        sink,
        signal: controller.signal,
        getAsset,
        getThumbnail,
      }),
    ).rejects.toThrow();
  });

  it("cancels a blocked sink write bounded and aborts the sink exactly once", async () => {
    const { envelope, getRecord, getBoundSource } = await fixture();
    const plan = await planDrglitchExport({ envelope, appVersion: "0.1.0", getRecord });
    const controller = new AbortController();
    let writeStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let rejectWrite: ((reason: unknown) => void) | null = null;
    let aborts = 0;
    const pending = exportDrglitchToSink({ decoder: referenceRasterDecoder,
      envelope,
      appVersion: "0.1.0",
      plan,
      getBoundSource,
      signal: controller.signal,
      sink: {
        write: () => {
          writeStarted!();
          return new Promise<void>((_resolve, reject) => {
            rejectWrite = reject;
          });
        },
        abort: () => {
          aborts += 1;
          rejectWrite?.(new DOMException("Aborted", "AbortError"));
        },
      },
    });
    pending.catch(() => undefined);
    await started;
    const cancelledAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - cancelledAt).toBeLessThan(200);
    expect(aborts).toBe(1);
  });
});
