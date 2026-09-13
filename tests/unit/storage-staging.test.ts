import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-backend";
import { ImportStaging, STAGING_ABANDONED_AFTER_MS } from "../../src/storage/staging";
import { ProjectRepository } from "../../src/storage/project-repository";
import { AssetRepository } from "../../src/storage/asset-repository";
import { NotFoundError } from "../../src/storage/errors";
import { sha256Hex } from "../../src/storage/sha256";
import type { AssetRecordV1 } from "../../src/core/types";
import type { StoredAssetRow } from "../../src/storage/schema";
import { FakeScheduler, makeEnvelope, makeLayer } from "./storage-fixtures.test";
import { makeDecodablePng } from "./helpers/raster-fixtures";
import { sanitizeSvg } from "../../src/io/svg-sanitizer";

const encoder = new TextEncoder();

/**
 * Staged fixtures carry REAL content: commit() now re-validates every staged
 * row's bytes (hash + kind-aware content) at the trust boundary, so raster
 * fixtures are genuine 8x8 PNGs (seed varies the pixels/hash) and SVG
 * fixtures are canonical sanitizer output.
 */
async function makeAsset(
  seed: string,
  kind: AssetRecordV1["kind"] = "raster",
): Promise<{ record: AssetRecordV1; blob: Blob }> {
  const bytes =
    kind === "svg"
      ? encoder.encode(
          sanitizeSvg(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="${(seed.length % 7) + 1}" height="8"/></svg>`,
            "artwork",
          ).svg,
        )
      : makeDecodablePng(8, 8, { seed });
  return {
    record: {
      sha256: await sha256Hex(bytes),
      kind,
      mime: kind === "svg" ? "image/svg+xml" : "image/png",
      byteLength: bytes.byteLength,
      width: 8,
      height: 8,
      createdAt: 0,
    },
    blob: new Blob([bytes]),
  };
}

function setup() {
  const backend = new MemoryBackend();
  const scheduler = new FakeScheduler();
  scheduler.nowMs = 1_000;
  const staging = new ImportStaging(backend, { now: scheduler.clock });
  return { backend, scheduler, staging };
}

describe("ImportStaging", () => {
  it("commit installs the candidate atomically under a NEW local project id", async () => {
    const { backend, scheduler, staging } = setup();
    const asset = await makeAsset("artwork");
    const thumb = await makeAsset("thumbnail", "thumbnail");
    const candidate = makeEnvelope({
      id: "imported-original-id",
      title: "Imported piece",
      // The io importer rebuilds envelopes with savedRevision 0 before
      // staging; staging preserves whatever the validated candidate carries.
      savedRevision: 0,
      core: { ...makeEnvelope().core, layers: [makeLayer({ assetId: asset.record.sha256 })] },
    });

    const handle = await staging.begin();
    await handle.stageAsset(asset.record, asset.blob);
    await handle.stageAsset(thumb.record, thumb.blob);
    await handle.stageProject(candidate);

    // Nothing is live before commit.
    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);

    scheduler.nowMs = 5_000;
    let validated = false;
    const installed = await handle.commit({
      validate: (staged) => {
        validated = true;
        expect(staged.envelope.id).toBe("imported-original-id");
        expect(staged.assets).toHaveLength(2);
      },
    });

    expect(validated).toBe(true);
    expect(installed.id).not.toBe("imported-original-id");
    expect(installed).toMatchObject({
      title: "Imported piece",
      // Preserved from the staged candidate: imports open unsaved.
      savedRevision: 0,
      createdAt: 5_000,
      updatedAt: 5_000,
    });
    // Layers keep their content-addressed references.
    expect(installed.core.layers[0].assetId).toBe(asset.record.sha256);

    const repo = new ProjectRepository(backend);
    expect((await repo.load(installed.id)).title).toBe("Imported piece");
    const assets = new AssetRepository(backend);
    expect(await assets.has(asset.record.sha256)).toBe(true);
    expect(await assets.has(thumb.record.sha256, "thumbnail")).toBe(true);
    // Staging area fully cleaned up.
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("dedupes staged assets that already exist live (verified bytes install; original createdAt survives)", async () => {
    const { backend, staging } = setup();
    const assets = new AssetRepository(backend, { now: () => 7 });
    const staged = await makeAsset("shared");
    const bytes = new Uint8Array(await staged.blob.arrayBuffer());
    const existing = await assets.putBlob(bytes, "raster", "image/png", { width: 8, height: 8 });
    expect(existing.sha256).toBe(staged.record.sha256);

    const handle = await staging.begin();
    await handle.stageAsset(staged.record, staged.blob);
    await handle.stageProject(makeEnvelope());
    await handle.commit();

    // Commit NEVER reuses pre-existing bytes (reuse is unverifiable inside
    // the install transaction); it installs the verified staged copy, but a
    // structurally valid existing row donates its createdAt so dedupe
    // identity survives.
    const row = await backend.get<StoredAssetRow>("assets", existing.sha256);
    expect(row?.record.createdAt).toBe(7);
    expect(Array.from(new Uint8Array(await row!.blob.arrayBuffer()))).toEqual(Array.from(bytes));
    expect((await backend.getAllKeys("assets")).length).toBe(1);
  });

  it("a failed validation leaves live stores untouched and staging intact for abort", async () => {
    const { backend, staging } = setup();
    const asset = await makeAsset("bad-import");
    const handle = await staging.begin();
    await handle.stageAsset(asset.record, asset.blob);
    await handle.stageProject(makeEnvelope());

    await expect(
      handle.commit({
        validate: () => {
          throw new Error("unsafe SVG");
        },
      }),
    ).rejects.toThrow("unsafe SVG");

    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
    // Import flow decides: abort cleans everything.
    await handle.abort();
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("abort discards the staging area and all staged rows", async () => {
    const { backend, staging } = setup();
    const asset = await makeAsset("discard-me");
    const handle = await staging.begin();
    await handle.stageAsset(asset.record, asset.blob);
    await handle.stageProject(makeEnvelope());
    expect((await backend.getAllKeys("staging")).length).toBe(2);
    await handle.abort();
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("commit without a staged project rejects", async () => {
    const { staging } = setup();
    const handle = await staging.begin();
    await expect(handle.commit()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("commit after abort rejects (no double install)", async () => {
    const { staging } = setup();
    const handle = await staging.begin();
    await handle.stageProject(makeEnvelope());
    await handle.abort();
    await expect(handle.commit()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sweepAbandonedStaging removes only crash-aged areas", async () => {
    const { backend, scheduler, staging } = setup();
    const oldAsset = await makeAsset("old");
    const oldHandle = await staging.begin();
    await oldHandle.stageAsset(oldAsset.record, oldAsset.blob);
    await oldHandle.stageProject(makeEnvelope());

    scheduler.nowMs += STAGING_ABANDONED_AFTER_MS + 1;
    const freshAsset = await makeAsset("fresh");
    const freshHandle = await staging.begin();
    await freshHandle.stageAsset(freshAsset.record, freshAsset.blob);

    const swept = await staging.sweepAbandonedStaging();
    expect(swept).toBe(1);
    const remaining = await backend.getAllKeys("staging");
    // Fresh area (meta + one asset row) survives untouched.
    expect(remaining).toHaveLength(2);
    expect(remaining.every((key) => key.startsWith(freshHandle.stagingId))).toBe(true);
    // The fresh import can still commit.
    await freshHandle.stageProject(makeEnvelope());
    const installed = await freshHandle.commit();
    expect(await backend.get("projects", installed.id)).toBeDefined();
  });
});

describe("ImportStaging on-commit trust boundary (TOCTOU)", () => {
  it("same-length poison swapped into a STAGED row before commit fails closed; nothing installs", async () => {
    const { backend, staging } = setup();
    const asset = await makeAsset("victim");
    const handle = await staging.begin();
    await handle.stageAsset(asset.record, asset.blob);
    await handle.stageProject(makeEnvelope());

    // Attacker window: replace the staged row with SAME-LENGTH wrong bytes
    // under the same key/record after staging but before commit.
    const poison = new Uint8Array(await asset.blob.arrayBuffer());
    poison[poison.length - 1] ^= 0xff;
    await backend.put("staging", `${handle.stagingId}:asset:assets:${asset.record.sha256}`, {
      type: "asset",
      stagingId: handle.stagingId,
      destination: "assets",
      asset: { record: asset.record, blob: new Blob([poison]) },
    });

    await expect(handle.commit()).rejects.toMatchObject({ name: "CorruptRecordError" });
    // Zero live rows; abort still cleans the staging area.
    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
    await handle.abort();
    expect(await backend.getAllKeys("staging")).toEqual([]);
  });

  it("same-length poison in the LIVE store is never reused: commit installs the verified staged bytes over it", async () => {
    const { backend, staging } = setup();
    const asset = await makeAsset("reuse-target");
    const good = new Uint8Array(await asset.blob.arrayBuffer());
    const poison = good.slice();
    poison[0] ^= 0xff;
    // Poisoned live row: structurally perfect, same length, wrong bytes.
    await backend.put<StoredAssetRow>("assets", asset.record.sha256, {
      record: asset.record,
      blob: new Blob([poison]),
    });

    const handle = await staging.begin();
    await handle.stageAsset(asset.record, asset.blob);
    await handle.stageProject(makeEnvelope());
    await handle.commit();

    const row = (await backend.get<StoredAssetRow>("assets", asset.record.sha256))!;
    const stored = new Uint8Array(await row.blob.arrayBuffer());
    expect(Array.from(stored)).toEqual(Array.from(good));
    expect(await sha256Hex(stored)).toBe(asset.record.sha256);
  });

  it("a raster staged with lying metadata (dims disagree with bytes) fails closed on commit", async () => {
    const { backend, staging } = setup();
    const asset = await makeAsset("liar");
    const handle = await staging.begin();
    // Same bytes, same hash key, but the record claims different dimensions.
    await handle.stageAsset({ ...asset.record, width: 9, height: 9 }, asset.blob);
    await handle.stageProject(makeEnvelope());
    await expect(handle.commit()).rejects.toMatchObject({ name: "CorruptRecordError" });
    expect(await backend.getAllKeys("assets")).toEqual([]);
  });

  it("non-canonical staged SVG fails closed on commit", async () => {
    const { backend, staging } = setup();
    const loose = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">  <rect width="1" height="8" id="x"/></svg>');
    const record: AssetRecordV1 = {
      sha256: await sha256Hex(loose),
      kind: "svg",
      mime: "image/svg+xml",
      byteLength: loose.byteLength,
      width: 8,
      height: 8,
      createdAt: 0,
    };
    const handle = await staging.begin();
    await handle.stageAsset(record, new Blob([loose]));
    await handle.stageProject(makeEnvelope());
    await expect(handle.commit()).rejects.toMatchObject({ name: "CorruptRecordError" });
    expect(await backend.getAllKeys("assets")).toEqual([]);
  });

  it("a tampered staged ENVELOPE fails closed on commit", async () => {
    const { backend, staging } = setup();
    const asset = await makeAsset("env");
    const handle = await staging.begin();
    await handle.stageAsset(asset.record, asset.blob);
    await handle.stageProject(makeEnvelope());
    // Attacker window: swap the staged envelope for structurally invalid data.
    const meta = (await backend.get<Record<string, unknown>>("staging", handle.stagingId))!;
    await backend.put("staging", handle.stagingId, { ...meta, envelope: { schema: 1, nonsense: true } });
    await expect(handle.commit()).rejects.toMatchObject({ name: "CorruptRecordError" });
    expect(await backend.getAllKeys("projects")).toEqual([]);
    expect(await backend.getAllKeys("assets")).toEqual([]);
  });
});
