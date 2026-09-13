import { createBrowserRasterDecoder } from "../../src/io/raster-decoder";
import { describe, expect, it, vi } from "vitest";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import type { AssetRecordV1, ProjectEnvelopeV1 } from "../../src/core/types";
import { DrglitchError, DRGLITCH_MAX_MANIFEST_BYTES, DRGLITCH_MAX_PROJECT_BYTES, exportDrglitch, exportDrglitchToSink, planDrglitchExport, importDrglitch, type ExportDrglitchOptions, type StagingSink } from "../../src/io/drglitch";
import { sha256Hex } from "../../src/io/sha256";
import { sanitizeSvg } from "../../src/io/svg-sanitizer";
import { ArchiveValidationError, WorkingSetLedger, readArchive } from "../../src/io/zip-reader";
import { writeArchive, type ArchiveInputEntry } from "../../src/io/zip-writer";
import { makeDecodablePng, makeJpeg, makeWebp, referenceRasterDecoder } from "./helpers/raster-fixtures";
import { makePng } from "./io-raster-validator.test";

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Well-known valid 1x1 transparent PNG. */
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
));

const NONCANONICAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 10 10"><rect id="keepout"   width="4" height="4" fill="#FF0000"/></svg>';

const HALFTONE = { cellSize: 12, dotShape: "round" as const, customShapeAssetId: null, invert: false, strokeWidth: 1, frayedXEdge: 0, frayedYEdge: 0 };
const DIFFUSION = { algorithm: "none" as const, modulation: "none" as const, modStrength: 0, intensity: 0, levels: 2, sharpenStrength: 0, sharpenRadius: 1, denoise: 0, brokenKernel: 0, directionalBias: 0, directionalBiasAngle: 0, errorOverflow: 0, reset: 0, crossChannelBleed: 0, invert: false };
const GLITCH = { enabled: false, sliceShift: 0, sliceSize: 0, verticalSliceShift: 0, verticalSliceSize: 0, gridWarp: 0, warpScale: 0, smearDrag: 0, smearLength: 0, smearVertical: false, macroblockCorrupt: 0, macroblockDropout: 0, blockShift: 0, blockShiftSize: 0, channelDesync: 0, bitmapSort: 0, bitmapSortVertical: false };

function makeLayer(assetId: string, id = "layer-1") {
  return {
    id, name: "Layer", assetId, visible: true, locked: false, opacity: 1, crop: null,
    transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, flipH: false, flipV: false, skew: { x: 0, y: 0 }, perspective: null },
    recipe: { mode: "halftone" as const, halftone: { ...HALFTONE }, diffusion: { ...DIFFUSION }, glitch: { ...GLITCH } },
  };
}

function makeCore(assetId: string) {
  return {
    schema: 1 as const,
    artboard: { widthPx: 960, heightPx: 1440, presetId: "custom", background: "white" as const },
    layers: [makeLayer(assetId)],
    separation: {
      mode: "cmyk" as const,
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
    },
    registration: { size: null, offset: null, weight: 1, mode: "corners" as const, customShapeAssetId: null },
    guides: { horizontal: [], vertical: [], locked: false, visible: true },
    grid: { visible: false, size: 24 },
    snapping: { enabled: true, toGuides: true, toGrid: true, toLayers: true, toArtboard: true },
    output: { polarity: "positive" as const, pressMirror: false, registrationOnPlates: true, registrationOnComposite: false },
    unitPreference: "px" as const,
  };
}

function makeEnvelope(assetId: string): ProjectEnvelopeV1 {
  return {
    schema: 1, id: "original-id", title: "Test Project", createdAt: 1, updatedAt: 2, savedRevision: 7,
    core: makeCore(assetId), snapshots: [],
  };
}

function memSink() {
  const events: string[] = [];
  const assets = new Map<string, { record: AssetRecordV1; bytes: Uint8Array }>();
  let committed: ProjectEnvelopeV1 | null = null;
  const sink: StagingSink = {
    allocate: () => { events.push("allocate"); },
    write: (record, bytes) => { assets.set(record.sha256, { record, bytes }); events.push(`write:${record.kind}`); },
    commit: (envelope) => { committed = envelope; events.push("commit"); },
    abort: () => { events.push("abort"); },
  };
  return { sink, events, assets, committed: () => committed };
}

const MANIFEST = encoder.encode(JSON.stringify({ format: "drglitch", schema: 1, appVersion: "0.1.0" }));

async function buildArchive(envelope: unknown, extra: ArchiveInputEntry[], manifest: Uint8Array = MANIFEST): Promise<Uint8Array> {
  return writeArchive([
    { name: "manifest.json", data: manifest },
    { name: "project.json", data: encoder.encode(JSON.stringify(envelope)) },
    ...extra,
  ]);
}

async function expectImportError(bytes: Uint8Array, code: string, sink = memSink().sink) {
  try {
    await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, newProjectId: () => "new-id", now: () => 1000 });
  } catch (error) {
    expect(error).toBeInstanceOf(DrglitchError);
    expect((error as DrglitchError).code).toBe(code);
    return;
  }
  throw new Error(`expected import rejection ${code}`);
}

/* ------------------------------------------------------------------ */

describe("drglitch export", () => {
  it("writes manifest, project, deduplicated assets, and thumbnails deterministically", async () => {
    const pngSha = await sha256Hex(PNG);
    const envelope = makeEnvelope(pngSha);
    envelope.snapshots = [{ id: "snap-1", name: "Checkpoint", createdAt: 5, thumbnailId: pngSha, core: makeCore(pngSha) }];
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0.1.0",
      getAsset: (sha) => (sha === pngSha ? { bytes: PNG, ext: "png" } : null),
      getThumbnail: (sha) => (sha === pngSha ? PNG : null),
    });
    const entries = await readArchive(bytes);
    expect([...entries.keys()]).toEqual(["manifest.json", "project.json", `assets/${pngSha}.png`, `thumbnails/${pngSha}.png`]);
    const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
    expect(manifest).toEqual({ format: "drglitch", schema: 1, appVersion: "0.1.0" });
    const project = JSON.parse(new TextDecoder().decode(entries.get("project.json")));
    expect(project.savedRevision).toBe(7); // captures current working state
    expect(Object.keys(project).sort()).toEqual(["core", "createdAt", "id", "savedRevision", "schema", "snapshots", "title", "updatedAt"]);
  });

  it("refuses to export missing or hash-mismatched assets", async () => {
    const pngSha = await sha256Hex(PNG);
    const envelope = makeEnvelope(pngSha);
    await expect(exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "0", getAsset: () => null, getThumbnail: () => null }))
      .rejects.toMatchObject({ code: "asset-missing" });
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0",
      getAsset: () => ({ bytes: PNG.slice(0, 20), ext: "png" as const }),
      getThumbnail: () => null,
    })).rejects.toMatchObject({ code: "asset-hash-mismatch" });
  });

  it("strips unknown fields so history/workspace state can never leak into the file", async () => {
    const pngSha = await sha256Hex(PNG);
    const envelope = { ...makeEnvelope(pngSha), history: ["secret"], workspace: { dockWidth: 400 } } as unknown as ProjectEnvelopeV1;
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0", getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
    });
    const project = new TextDecoder().decode((await readArchive(bytes)).get("project.json"));
    expect(project).not.toMatch(/history|workspace|secret/);
  });
});

describe("drglitch export policy enforcement", () => {
  async function fixtures() {
    const pngSha = await sha256Hex(PNG);
    const svgBytes = encoder.encode(sanitizeSvg(NONCANONICAL_SVG, "artwork").svg);
    const svgSha = await sha256Hex(svgBytes);
    const envelope = makeEnvelope(pngSha);
    envelope.core.layers = [makeLayer(pngSha, "a"), makeLayer(svgSha, "b")];
    envelope.snapshots = [{ id: "snap-1", name: "S", createdAt: 5, thumbnailId: pngSha, core: makeCore(pngSha) }];
    const getAsset = (sha: string) => (sha === pngSha ? { bytes: PNG, ext: "png" as const } : { bytes: svgBytes, ext: "svg" as const });
    const getThumbnail = () => PNG;
    return { pngSha, svgBytes, svgSha, envelope, getAsset, getThumbnail };
  }

  it("symmetry: every archive export accepts is importable under the same policy, including at the exact caps", async () => {
    const { envelope, getAsset, getThumbnail } = await fixtures();
    // Measure the real totals of an accepted export, then pin the policy
    // EXACTLY at those totals: export must still accept, and a same-policy
    // import must accept the result.
    const generous = await exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", getAsset, getThumbnail });
    const parts = await readArchive(generous);
    const uncompressed = [...parts.values()].reduce((total, bytes) => total + bytes.length, 0);
    const policy = { ...RESOURCE_POLICY, maxArchiveEntries: parts.size, maxArchiveUncompressedBytes: uncompressed };
    const atCap = await exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "0.1.0", getAsset, getThumbnail, policy });
    const { sink, committed } = memSink();
    const installed = await importDrglitch(atCap, { sink, policy, decoder: referenceRasterDecoder, newProjectId: () => "new-id", now: () => 1000 });
    expect(installed.core.layers).toHaveLength(2);
    expect(committed()).toEqual(installed);
    // One entry / one byte under the caps must refuse to export at all.
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0.1.0", getAsset, getThumbnail,
      policy: { ...policy, maxArchiveEntries: parts.size - 1 },
    })).rejects.toMatchObject({ name: "DrglitchError", code: "archive-entry-count" });
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0.1.0", getAsset, getThumbnail,
      policy: { ...policy, maxArchiveUncompressedBytes: uncompressed - 1 },
    })).rejects.toMatchObject({ name: "DrglitchError", code: "archive-uncompressed-quota" });
  });

  it("refuses exports past the working-memory ceiling a default importer would enforce", async () => {
    const { envelope, getAsset, getThumbnail } = await fixtures();
    await expect(exportDrglitch({ decoder: referenceRasterDecoder, envelope, appVersion: "0", getAsset, getThumbnail, maxWorkingSetBytes: 100 }))
      .rejects.toMatchObject({ name: "DrglitchError", code: "archive-working-set" });
  });

  it("refuses exports whose archive exceeds the compressed-size cap", async () => {
    const { envelope, getAsset, getThumbnail } = await fixtures();
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0", getAsset, getThumbnail,
      policy: { ...RESOURCE_POLICY, maxArchiveCompressedBytes: 256 },
    })).rejects.toMatchObject({ name: "DrglitchError", code: "archive-too-large" });
  });

  it("refuses per-asset bytes over the raster policy at export", async () => {
    const pngSha = await sha256Hex(PNG);
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
      policy: { ...RESOURCE_POLICY, maxRasterBytes: 10 },
    })).rejects.toMatchObject({ name: "DrglitchError", code: "asset-invalid" });
  });

  it("refuses disguised media in both directions at export", async () => {
    // SVG bytes under a .png extension.
    const svgBytes = encoder.encode(sanitizeSvg(NONCANONICAL_SVG, "artwork").svg);
    const svgSha = await sha256Hex(svgBytes);
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(svgSha), appVersion: "0",
      getAsset: () => ({ bytes: svgBytes, ext: "png" as const }), getThumbnail: () => null,
    })).rejects.toMatchObject({ code: "asset-invalid" });
    // PNG bytes under a .svg extension.
    const pngSha = await sha256Hex(PNG);
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "svg" as const }), getThumbnail: () => null,
    })).rejects.toMatchObject({ code: "asset-invalid" });
  });

  it("refuses non-canonical SVG at export (storage is supposed to hold canonical bytes)", async () => {
    const raw = encoder.encode(NONCANONICAL_SVG);
    const rawSha = await sha256Hex(raw);
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(rawSha), appVersion: "0",
      getAsset: () => ({ bytes: raw, ext: "svg" as const }), getThumbnail: () => null,
    })).rejects.toMatchObject({ code: "asset-invalid" });
  });

  it("refuses invalid thumbnails at export", async () => {
    const pngSha = await sha256Hex(PNG);
    const svgBytes = encoder.encode(sanitizeSvg(NONCANONICAL_SVG, "artwork").svg);
    const svgSha = await sha256Hex(svgBytes);
    const envelope = makeEnvelope(pngSha);
    envelope.snapshots = [{ id: "snap-1", name: "S", createdAt: 3, thumbnailId: svgSha, core: makeCore(pngSha) }];
    await expect(exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }),
      getThumbnail: () => svgBytes,
    })).rejects.toMatchObject({ name: "DrglitchError", code: "thumbnail-invalid" });
  });
});

describe("drglitch import round trip", () => {
  it("installs with a new local id, fresh timestamps, and savedRevision 0", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0.1.0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
    });
    const { sink, events, assets, committed } = memSink();
    const installed = await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, newProjectId: () => "new-id", now: () => 1000 });
    expect(installed.id).toBe("new-id");
    expect(installed.savedRevision).toBe(0);
    expect(installed.createdAt).toBe(1000);
    expect(installed.title).toBe("Test Project");
    expect(installed.core.layers[0].assetId).toBe(pngSha);
    expect(committed()).toEqual(installed);
    expect(events).toEqual(["allocate", "write:raster", "commit"]);
    expect(assets.get(pngSha)?.record).toMatchObject({ kind: "raster", mime: "image/png", width: 1, height: 1 });
  });

  it("delivers each staged asset's bytes to the sink exactly once", async () => {
    const pngSha = await sha256Hex(PNG);
    // Two distinct pre-canonicalized SVG assets (no remap) plus a PNG thumbnail:
    // three different content hashes staged by one import.
    const svgA = encoder.encode(sanitizeSvg(NONCANONICAL_SVG, "artwork").svg);
    const svgB = encoder.encode(sanitizeSvg(NONCANONICAL_SVG.replace("#FF0000", "#00FF00"), "artwork").svg);
    const svgShaA = await sha256Hex(svgA);
    const svgShaB = await sha256Hex(svgB);
    const envelope = makeEnvelope(svgShaA);
    envelope.core.layers = [makeLayer(svgShaA, "a"), makeLayer(svgShaB, "b")];
    envelope.snapshots = [{ id: "snap-1", name: "S", createdAt: 5, thumbnailId: pngSha, core: makeCore(svgShaA) }];
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope, appVersion: "0",
      getAsset: (sha) => ({ bytes: sha === svgShaA ? svgA : svgB, ext: "svg" }),
      getThumbnail: () => PNG,
    });
    const writes: Array<{ sha256: string; bytes: Uint8Array }> = [];
    const { sink } = memSink();
    const write = sink.write;
    sink.write = (record, data) => { writes.push({ sha256: record.sha256, bytes: data }); return write(record, data); };
    await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder });
    // Two assets + one thumbnail: one write each, no re-delivery, and every
    // delivered buffer is a distinct allocation (no shared or repeated copies).
    expect(writes).toHaveLength(3);
    expect(new Set(writes.map((entry) => entry.sha256)).size).toBe(3);
    expect(new Set(writes.map((entry) => entry.bytes)).size).toBe(3);
    for (const entry of writes) {
      expect(entry.bytes.byteOffset).toBe(0);
      expect(entry.bytes.buffer.byteLength).toBe(entry.bytes.length);
    }
  });

  it("aborts staging and rethrows when commit fails", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
    });
    const { sink, events } = memSink();
    sink.commit = () => { throw new Error("quota exceeded"); };
    await expect(importDrglitch(bytes, { sink, decoder: referenceRasterDecoder })).rejects.toThrow("quota exceeded");
    expect(events).toEqual(["allocate", "write:raster", "abort"]);
  });
});

describe("drglitch import attacks", () => {
  it("rejects future manifest schemas safely without touching the sink", async () => {
    const pngSha = await sha256Hex(PNG);
    const future = encoder.encode(JSON.stringify({ format: "drglitch", schema: 2, appVersion: "9.9.9" }));
    const bytes = await buildArchive(makeEnvelope(pngSha), [{ name: `assets/${pngSha}.png`, data: PNG }], future);
    const { sink, events } = memSink();
    await expectImportError(bytes, "future-schema", sink);
    expect(events).toEqual([]);
  });

  it("rejects missing or foreign manifests", async () => {
    const pngSha = await sha256Hex(PNG);
    await expectImportError(await writeArchive([{ name: "project.json", data: encoder.encode("{}") }]), "manifest-missing");
    const foreign = encoder.encode(JSON.stringify({ format: "other-app", schema: 1, appVersion: "1" }));
    await expectImportError(await buildArchive(makeEnvelope(pngSha), [{ name: `assets/${pngSha}.png`, data: PNG }], foreign), "manifest-invalid");
  });

  it("rejects structurally invalid projects", async () => {
    const pngSha = await sha256Hex(PNG);
    const envelope = makeEnvelope(pngSha);
    envelope.core.layers[0].opacity = 2;
    await expectImportError(await buildArchive(envelope, [{ name: `assets/${pngSha}.png`, data: PNG }]), "project-invalid");
    const nonObject = await buildArchive([1, 2, 3], []);
    await expectImportError(nonObject, "project-invalid");
  });

  it("rejects missing asset references", async () => {
    const pngSha = await sha256Hex(PNG);
    await expectImportError(await buildArchive(makeEnvelope(pngSha), []), "asset-missing");
  });

  it("rejects hash-mismatched assets (renamed content)", async () => {
    const pngSha = await sha256Hex(PNG);
    const tampered = PNG.slice();
    tampered[tampered.length - 20] ^= 0xff;
    const bytes = await buildArchive(makeEnvelope(pngSha), [{ name: `assets/${pngSha}.png`, data: tampered }]);
    await expectImportError(bytes, "asset-hash-mismatch");
  });

  it("rejects disguised media in both directions", async () => {
    // SVG bytes under a .png asset name.
    const svgBytes = encoder.encode(NONCANONICAL_SVG);
    const svgSha = await sha256Hex(svgBytes);
    await expectImportError(
      await buildArchive(makeEnvelope(svgSha), [{ name: `assets/${svgSha}.png`, data: svgBytes }]),
      "asset-invalid",
    );
    // PNG bytes under a .svg asset name.
    const pngSha = await sha256Hex(PNG);
    await expectImportError(
      await buildArchive(makeEnvelope(pngSha), [{ name: `assets/${pngSha}.svg`, data: PNG }]),
      "asset-invalid",
    );
  });

  it("rejects unsafe SVG assets with the sanitizer's diagnosis", async () => {
    const evil = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script><rect width="1" height="1"/></svg>');
    const evilSha = await sha256Hex(evil);
    const bytes = await buildArchive(makeEnvelope(evilSha), [{ name: `assets/${evilSha}.svg`, data: evil }]);
    await expectImportError(bytes, "asset-invalid");
  });

  it("rejects unreferenced archive entries", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await buildArchive(makeEnvelope(pngSha), [
      { name: `assets/${pngSha}.png`, data: PNG },
      { name: "assets/stowaway.bin", data: encoder.encode("payload") },
    ]);
    await expectImportError(bytes, "unexpected-entry");
  });

  it("rejects missing referenced thumbnails", async () => {
    const pngSha = await sha256Hex(PNG);
    const envelope = makeEnvelope(pngSha);
    envelope.snapshots = [{ id: "snap-1", name: "S", createdAt: 3, thumbnailId: pngSha, core: makeCore(pngSha) }];
    const bytes = await buildArchive(envelope, [{ name: `assets/${pngSha}.png`, data: PNG }]);
    await expectImportError(bytes, "thumbnail-missing");
  });

  it("enforces the layer cap through the injected policy", async () => {
    const pngSha = await sha256Hex(PNG);
    const envelope = makeEnvelope(pngSha);
    envelope.core.layers = [makeLayer(pngSha, "a"), makeLayer(pngSha, "b")];
    const bytes = await buildArchive(envelope, [{ name: `assets/${pngSha}.png`, data: PNG }]);
    const { sink } = memSink();
    await expect(importDrglitch(bytes, {
      sink,
      decoder: referenceRasterDecoder,
      policy: { ...(await import("../../src/core/resource-policy")).RESOURCE_POLICY, maxLayers: 1 },
    })).rejects.toMatchObject({ code: "project-invalid" });
  });

  it("rejects imports past the working-memory ceiling before the sink sees anything", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
    });
    const { sink, events } = memSink();
    await expect(importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, maxWorkingSetBytes: 256 }))
      .rejects.toMatchObject({ name: "ArchiveValidationError", code: "archive-working-set" });
    expect(events).toEqual([]);
  });

  it("honors the import time budget with a typed timeout and an untouched sink", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
    });
    const { sink, events } = memSink();
    try {
      // A negative budget puts the deadline firmly in the past regardless of
      // how fast this small archive parses.
      await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, timeoutMs: -1 });
      throw new Error("expected archive-timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).code).toBe("archive-timeout");
    }
    expect(events).toEqual([]);
  });

  it("aborts staging when a sink write fails partway", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await exportDrglitch({ decoder: referenceRasterDecoder,
      envelope: makeEnvelope(pngSha), appVersion: "0",
      getAsset: () => ({ bytes: PNG, ext: "png" as const }), getThumbnail: () => null,
    });
    const { sink, events } = memSink();
    sink.write = () => { throw new Error("disk full"); };
    await expect(importDrglitch(bytes, { sink, decoder: referenceRasterDecoder })).rejects.toThrow("disk full");
    expect(events).toEqual(["allocate", "abort"]);
  });

  it("neutralizes pathologically deep project JSON: typed rejection or stripped, never a crash", async () => {
    const pngSha = await sha256Hex(PNG);
    const depth = 200_000;
    const deepJson = `{"junk":${"[".repeat(depth)}${"]".repeat(depth)},${JSON.stringify(makeEnvelope(pngSha)).slice(1)}`;
    const bytes = await writeArchive([
      { name: "manifest.json", data: MANIFEST },
      { name: "project.json", data: encoder.encode(deepJson) },
      { name: `assets/${pngSha}.png`, data: PNG },
    ]);
    const { sink } = memSink();
    try {
      // Engines with iterative JSON.parse accept the depth; reconstruction
      // must then strip the deep unknown field so it never reaches storage.
      const installed = await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, newProjectId: () => "new-id", now: () => 1000 });
      expect(JSON.stringify(installed)).not.toContain("junk");
    } catch (error) {
      // Engines with recursive JSON.parse overflow inside the guarded parse
      // and must surface the stable typed code instead of a raw RangeError.
      expect(error).toBeInstanceOf(DrglitchError);
      expect((error as DrglitchError).code).toBe("project-invalid");
    }
  });

  it("re-canonicalizes non-canonical SVG assets and remaps their references", async () => {
    const svgBytes = encoder.encode(NONCANONICAL_SVG);
    const svgSha = await sha256Hex(svgBytes);
    const canonical = sanitizeSvg(NONCANONICAL_SVG, "artwork").svg;
    const canonicalSha = await sha256Hex(encoder.encode(canonical));
    expect(canonicalSha).not.toBe(svgSha);
    const bytes = await buildArchive(makeEnvelope(svgSha), [{ name: `assets/${svgSha}.svg`, data: svgBytes }]);
    const { sink, assets, committed } = memSink();
    const installed = await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder });
    expect(installed.core.layers[0].assetId).toBe(canonicalSha);
    expect(committed()?.core.layers[0].assetId).toBe(canonicalSha);
    const staged = assets.get(canonicalSha);
    expect(staged?.record).toMatchObject({ kind: "svg", mime: "image/svg+xml" });
    expect(new TextDecoder().decode(staged?.bytes)).toBe(canonical);
    expect(new TextDecoder().decode(staged?.bytes)).not.toContain("keepout");
  });
});

/* ------------------------------------------------------------------ */
/* Full decode validation (payload, not header-only)                   */
/* ------------------------------------------------------------------ */

describe("drglitch full raster decode validation", () => {
  async function archiveWithAsset(data: Uint8Array, ext: "png" | "jpg" | "webp") {
    const sha = await sha256Hex(data);
    return { sha, bytes: await buildArchive(makeEnvelope(sha), [{ name: `assets/${sha}.${ext}`, data }]) };
  }

  it("valid static PNG, JPEG, and WebP payloads import and stage", async () => {
    const png = makeDecodablePng(16, 12, { seed: "ok-png" });
    const jpeg = makeJpeg(16, 12);
    const webp = makeWebp(16, 12);
    const [pngSha, jpegSha, webpSha] = await Promise.all([png, jpeg, webp].map((b) => sha256Hex(b)));
    const envelope = makeEnvelope(pngSha);
    envelope.core.layers = [makeLayer(pngSha, "a"), makeLayer(jpegSha, "b"), makeLayer(webpSha, "c")];
    const bytes = await buildArchive(envelope, [
      { name: `assets/${pngSha}.png`, data: png },
      { name: `assets/${jpegSha}.jpg`, data: jpeg },
      { name: `assets/${webpSha}.webp`, data: webp },
    ]);
    const { sink, assets, committed } = memSink();
    await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder });
    expect(committed()).not.toBeNull();
    expect(assets.get(pngSha)?.record).toMatchObject({ mime: "image/png", width: 16, height: 12 });
    expect(assets.get(jpegSha)?.record).toMatchObject({ mime: "image/jpeg", width: 16, height: 12 });
    expect(assets.get(webpSha)?.record).toMatchObject({ mime: "image/webp", width: 16, height: 12 });
  });

  it("correct-hash truncated PNG IDAT aborts exactly once; nothing commits", async () => {
    const { bytes } = await archiveWithAsset(makeDecodablePng(8, 8, { truncateIdat: true }), "png");
    const { sink, events, committed } = memSink();
    await expectImportError(bytes, "asset-invalid", sink);
    expect(committed()).toBeNull();
    expect(events).toEqual(["allocate", "abort"]);
  });

  it("correct-hash corrupt PNG IDAT rejects before commit", async () => {
    const { bytes } = await archiveWithAsset(makeDecodablePng(8, 8, { corruptIdat: true }), "png");
    await expectImportError(bytes, "asset-invalid");
  });

  it("correct-hash SOF-only JPEG rejects before commit", async () => {
    const { bytes } = await archiveWithAsset(makeJpeg(8, 8, { scan: "sof-only" }), "jpg");
    await expectImportError(bytes, "asset-invalid");
  });

  it("correct-hash scan-truncated JPEG rejects before commit", async () => {
    const { bytes } = await archiveWithAsset(makeJpeg(8, 8, { scan: "truncated" }), "jpg");
    await expectImportError(bytes, "asset-invalid");
  });

  it("correct-hash incomplete WebP payload rejects before commit", async () => {
    const { bytes } = await archiveWithAsset(makeWebp(8, 8, { incomplete: true }), "webp");
    await expectImportError(bytes, "asset-invalid");
  });

  it("decoded-vs-declared dimension disagreement rejects", async () => {
    const { bytes } = await archiveWithAsset(makeDecodablePng(8, 8), "png");
    const { sink, events } = memSink();
    try {
      await importDrglitch(bytes, { sink, decoder: { decode: async () => ({ width: 9, height: 8 }) } });
      throw new Error("expected asset-invalid");
    } catch (error) {
      expect(error).toBeInstanceOf(DrglitchError);
      expect((error as DrglitchError).code).toBe("asset-invalid");
      expect((error as DrglitchError).message).toContain("raster-decode-dimensions");
    }
    expect(events).toEqual(["allocate", "abort"]);
  });

  it("animated rasters are rejected by the cheap gates: the decoder never runs", async () => {
    const animated = makePng(8, 8, { acTL: true });
    const { bytes } = await archiveWithAsset(animated, "png");
    const decode = vi.fn();
    const { sink } = memSink();
    await expect(importDrglitch(bytes, { sink, decoder: { decode } })).rejects.toMatchObject({
      code: "asset-invalid",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("thumbnails get the same full decode: truncated thumbnail rejects typed", async () => {
    const png = makeDecodablePng(8, 8, { seed: "art" });
    const pngSha = await sha256Hex(png);
    const badThumb = makeDecodablePng(4, 4, { seed: "thumb", truncateIdat: true });
    const thumbSha = await sha256Hex(badThumb);
    const envelope = makeEnvelope(pngSha);
    envelope.snapshots = [{ id: "snap-1", name: "S", createdAt: 5, thumbnailId: thumbSha, core: makeCore(pngSha) }];
    const bytes = await buildArchive(envelope, [
      { name: `assets/${pngSha}.png`, data: png },
      { name: `thumbnails/${thumbSha}.png`, data: badThumb },
    ]);
    await expectImportError(bytes, "thumbnail-invalid");
  });

  it("fails CLOSED without an injected decoder outside the browser", async () => {
    const { bytes } = await archiveWithAsset(makeDecodablePng(8, 8), "png");
    const { sink, committed } = memSink();
    try {
      await importDrglitch(bytes, { sink });
      throw new Error("expected asset-invalid");
    } catch (error) {
      expect(error).toBeInstanceOf(DrglitchError);
      expect((error as DrglitchError).message).toContain("raster-decode-unavailable");
    }
    expect(committed()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* One operation-scoped budget                                         */
/* ------------------------------------------------------------------ */

describe("drglitch operation budget and cancellation", () => {
  it("cancelling DURING staging aborts exactly once with zero committed state", async () => {
    const pngA = makeDecodablePng(8, 8, { seed: "a" });
    const pngB = makeDecodablePng(8, 8, { seed: "b" });
    const [shaA, shaB] = await Promise.all([sha256Hex(pngA), sha256Hex(pngB)]);
    const envelope = makeEnvelope(shaA);
    envelope.core.layers = [makeLayer(shaA, "a"), makeLayer(shaB, "b")];
    const bytes = await buildArchive(envelope, [
      { name: `assets/${shaA}.png`, data: pngA },
      { name: `assets/${shaB}.png`, data: pngB },
    ]);
    const controller = new AbortController();
    const { sink, events, committed } = memSink();
    const write = sink.write;
    sink.write = (record, data) => {
      // The user cancels while the first asset is being staged.
      controller.abort();
      return write(record, data);
    };
    try {
      await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, signal: controller.signal });
      throw new Error("expected archive-aborted");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).code).toBe("archive-aborted");
    }
    expect(committed()).toBeNull();
    // Exactly-once cleanup: one abort, no commit, and staging stopped after
    // the write that observed the cancellation.
    expect(events.filter((event) => event === "abort")).toHaveLength(1);
    expect(events).toEqual(["allocate", "write:raster", "abort"]);
  });

  it("a pre-aborted signal rejects before the sink sees anything", async () => {
    const pngSha = await sha256Hex(PNG);
    const bytes = await buildArchive(makeEnvelope(pngSha), [{ name: `assets/${pngSha}.png`, data: PNG }]);
    const controller = new AbortController();
    controller.abort();
    const { sink, events } = memSink();
    await expect(
      importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ArchiveValidationError", code: "archive-aborted" });
    expect(events).toEqual([]);
  });

  it("manifest.json over its dedicated byte cap rejects BEFORE parsing", async () => {
    const pngSha = await sha256Hex(PNG);
    const hugeManifest = encoder.encode(JSON.stringify({ format: "drglitch", schema: 1, appVersion: "0" }) + " ".repeat(DRGLITCH_MAX_MANIFEST_BYTES));
    const bytes = await buildArchive(makeEnvelope(pngSha), [{ name: `assets/${pngSha}.png`, data: PNG }], hugeManifest);
    const { sink, events } = memSink();
    await expectImportError(bytes, "manifest-invalid", sink);
    expect(events).toEqual([]);
  });

  it("project.json over its dedicated byte cap rejects BEFORE parsing", async () => {
    const huge = encoder.encode("x".repeat(DRGLITCH_MAX_PROJECT_BYTES + 1));
    const bytes = await writeArchive([
      { name: "manifest.json", data: MANIFEST },
      { name: "project.json", data: huge },
    ]);
    const { sink, events } = memSink();
    await expectImportError(bytes, "project-invalid", sink);
    expect(events).toEqual([]);
  });

  it("reports progress phases and per-asset counts to the UI seam", async () => {
    const png = makeDecodablePng(8, 8, { seed: "progress" });
    const sha = await sha256Hex(png);
    const bytes = await buildArchive(makeEnvelope(sha), [{ name: `assets/${sha}.png`, data: png }]);
    const { sink } = memSink();
    const phases: string[] = [];
    let lastCounts: { assetsDone: number; assetsTotal: number } | null = null;
    await importDrglitch(bytes, {
      sink,
      decoder: referenceRasterDecoder,
      onProgress: (progress) => {
        phases.push(progress.phase);
        lastCounts = { assetsDone: progress.assetsDone, assetsTotal: progress.assetsTotal };
      },
    });
    expect(phases[0]).toBe("extract");
    expect(phases).toContain("validate");
    expect(phases).toContain("stage");
    expect(phases[phases.length - 1]).toBe("commit");
    expect(lastCounts).toEqual({ assetsDone: 1, assetsTotal: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Honest retained-memory model                                        */
/* ------------------------------------------------------------------ */

describe("drglitch memory model (instrumented ledger)", () => {
  it("charges one entry plus its native decode window and releases all operation receipts", async () => {
    // Three incompressible PNG assets so the window sizes are meaningful.
    const pngs = [
      makeDecodablePng(64, 64, { seed: "m1" }),
      makeDecodablePng(64, 64, { seed: "m2" }),
      makeDecodablePng(96, 64, { seed: "m3" }),
    ];
    const shas = await Promise.all(pngs.map((png) => sha256Hex(png)));
    const envelope = makeEnvelope(shas[0]);
    envelope.core.layers = shas.map((sha, index) => makeLayer(sha, `layer-${index}`));
    const bytes = await buildArchive(envelope, shas.map((sha, index) => ({
      name: `assets/${sha}.png`,
      data: pngs[index],
      compress: false,
    })));

    // Entry sizes as the importer sees them (declared uncompressed sizes).
    const entrySizes = [...(await readArchive(bytes)).values()].map((data) => data.length);
    const largestEntry = Math.max(...entrySizes);
    const decodeWindows = pngs.map((png, index) => 3 * png.length + (index === 2 ? 96 : 64) * 64 * 4);

    const ledger = new WorkingSetLedger(64 * 1024 * 1024);
    const { sink, assets } = memSink();
    const deliveredBytes: number[] = [];
    const write = sink.write;
    sink.write = (record, data) => { deliveredBytes.push(data.length); return write(record, data); };
    await importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, ledger });

    // Source window + two possible encoded copies + a decoded RGBA surface.
    // Native decode can exceed the sum of compressed entries: compare the
    // complete per-entry working windows, never compressed bytes alone.
    expect(ledger.peak).toBe(bytes.length + Math.max(largestEntry, ...decodeWindows));
    expect(ledger.peak).toBeLessThan(bytes.length + decodeWindows.reduce((sum, size) => sum + size, 0));
    expect(ledger.retained).toBe(0);
    // Each asset's bytes were delivered to the sink exactly once.
    expect(deliveredBytes).toHaveLength(3);
    expect(assets.size).toBe(3);
    expect(deliveredBytes.reduce((a, b) => a + b, 0)).toBe(pngs.reduce((a, b) => a + b.length, 0));
  });

  it("an archive whose largest entry cannot fit beside the compressed input rejects before extraction", async () => {
    const png = makeDecodablePng(64, 64, { seed: "big" });
    const sha = await sha256Hex(png);
    const bytes = await buildArchive(makeEnvelope(sha), [{ name: `assets/${sha}.png`, data: png, compress: false }]);
    const { sink, events } = memSink();
    // Ceiling admits the compressed input but not input + largest entry.
    await expect(
      importDrglitch(bytes, { sink, decoder: referenceRasterDecoder, maxWorkingSetBytes: bytes.length + 100 }),
    ).rejects.toMatchObject({ name: "ArchiveValidationError", code: "archive-working-set" });
    expect(events).toEqual([]);
  });
});


describe.each(["buffered", "streamed"] as const)("%s archive export full decode", (delivery) => {
  const run = async (options: ExportDrglitchOptions & { plan?: Awaited<ReturnType<typeof planDrglitchExport>> }) => {
    if (delivery === "buffered") return exportDrglitch(options);
    const chunks: Uint8Array[] = [];
    await exportDrglitchToSink({ ...options, sink: { write: (chunk) => { chunks.push(chunk.slice()); } } });
    return new Uint8Array(Buffer.concat(chunks));
  };

  it.each([
    ["png", makeDecodablePng(8, 8, { truncateIdat: true })],
    ["png", makeDecodablePng(8, 8, { corruptIdat: true })],
    ["jpg", makeJpeg(8, 8, { scan: "sof-only" })],
    ["jpg", makeJpeg(8, 8, { scan: "truncated" })],
    ["webp", makeWebp(8, 8, { incomplete: true })],
  ] as const)("refuses correct-hash but undecodable %s payloads", async (ext, bytes) => {
    const sha = await sha256Hex(bytes);
    await expect(run({
      envelope: makeEnvelope(sha), appVersion: "0", decoder: referenceRasterDecoder,
      getAsset: () => ({ bytes, ext }), getThumbnail: () => null,
    })).rejects.toMatchObject({ name: "DrglitchError", code: "asset-invalid" });
  });

  it("validates snapshot thumbnails with the same full decoder", async () => {
    const assetSha = await sha256Hex(PNG);
    const bytes = makeDecodablePng(8, 8, { truncateIdat: true });
    const sha = await sha256Hex(bytes);
    const envelope = makeEnvelope(assetSha);
    envelope.snapshots = [{ id: "s", name: "Snapshot", createdAt: 3, core: makeCore(assetSha), thumbnailId: sha }];
    await expect(run({ envelope, appVersion: "0", decoder: referenceRasterDecoder,
      getAsset: () => ({ bytes: PNG, ext: "png" }), getThumbnail: () => bytes,
    })).rejects.toMatchObject({ code: "thumbnail-invalid" });
  });

  it("rejects native decode residency before invoking the decoder", async () => {
    const bytes = makeDecodablePng(256, 256);
    const sha = await sha256Hex(bytes);
    const decode = vi.fn(referenceRasterDecoder.decode);
    await expect(run({ envelope: makeEnvelope(sha), appVersion: "0", decoder: { decode },
      getAsset: () => ({ bytes, ext: "png" }), getThumbnail: () => null,
      policy: { ...RESOURCE_POLICY, maxRenderPeakBytes: 256 * 256 * 4 },
    })).rejects.toMatchObject({ code: "archive-working-set" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a frozen row whose dimensions disagree before decode", async () => {
    const sha = await sha256Hex(PNG);
    const envelope = makeEnvelope(sha);
    const plan = await planDrglitchExport({ envelope, appVersion: "0", getRecord: async () => ({
      sha256: sha, kind: "raster", mime: "image/png", byteLength: PNG.length, width: 2, height: 1,
    }) });
    const decode = vi.fn(referenceRasterDecoder.decode);
    await expect(run({ envelope, plan, appVersion: "0", decoder: { decode },
      getAsset: () => ({ bytes: PNG, ext: "png" }), getThumbnail: () => null,
    })).rejects.toMatchObject({ code: "plan-mismatch" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("round-trips a decodable raster under the exact importer memory cap", async () => {
    const bytes = makeDecodablePng(64, 64);
    const sha = await sha256Hex(bytes);
    const options = { envelope: makeEnvelope(sha), appVersion: "0", decoder: referenceRasterDecoder,
      getAsset: () => ({ bytes, ext: "png" as const }), getThumbnail: () => null };
    const archive = await run(options);
    const cap = archive.length + bytes.length * 3 + 64 * 64 * 4;
    const atCap = await run({ ...options, maxWorkingSetBytes: cap });
    const ledger = new WorkingSetLedger(cap);
    const installed = await importDrglitch(atCap, { sink: memSink().sink, ledger, decoder: referenceRasterDecoder });
    expect(installed.core.layers[0].assetId).toBe(sha);
    expect(ledger.retained).toBe(0);
    await expect(run({ ...options, maxWorkingSetBytes: cap - 1 })).rejects.toMatchObject({ code: "archive-working-set" });
  });
});


it("cancel during native archive decode settles promptly but retains its real cleanup charge", async () => {
  const bytes = makeDecodablePng(8, 8);
  const sha = await sha256Hex(bytes);
  const archive = await buildArchive(makeEnvelope(sha), [{ name: `assets/${sha}.png`, data: bytes }]);
  let finishNative!: (bitmap: { width: number; height: number; close: () => void }) => void;
  const decode = vi.fn(() => new Promise((resolve) => { finishNative = resolve; }));
  vi.stubGlobal("createImageBitmap", decode);
  try {
    const { sink, events, committed } = memSink();
    const signal = new AbortController();
    const ledger = new WorkingSetLedger(1024 * 1024);
    const pending = importDrglitch(archive, { sink, signal: signal.signal, ledger, decoder: createBrowserRasterDecoder() });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
    const start = performance.now();
    signal.abort();
    await expect(pending).rejects.toMatchObject({ code: "archive-aborted" });
    expect(performance.now() - start).toBeLessThan(250);
    expect(events).toEqual(["allocate", "abort"]);
    expect(committed()).toBeNull();
    expect(ledger.retained).toBe(2 * bytes.byteLength + 8 * 8 * 4);
    const close = vi.fn();
    finishNative({ width: 8, height: 8, close });
    await vi.waitFor(() => expect(ledger.retained).toBe(0));
    expect(close).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
