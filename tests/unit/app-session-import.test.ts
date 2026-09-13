/**
 * Session-level archive/preset intake: the cancellable import handle
 * (promise/cancel/onProgress — the wave-F UI seam), the ONE operation
 * budget spanning file read through atomic commit, zero-surviving-rows
 * guarantees on cancel/timeout, and the hardened pre-size-gated preset
 * entry point.
 */
import { describe, expect, it, vi } from "vitest";
import { AppSessionController } from "../../src/app/session-controller";
import { LeaseOwnershipLock, MemoryBackend, MemoryBusHub } from "../../src/storage";
import type { RecipePresetV1 } from "../../src/core/types";
import { RESOURCE_POLICY } from "../../src/core/resource-policy";
import {
  ArchiveValidationError,
  MAX_PRESET_TEXT_LENGTH,
  PresetValidationError,
  exportDrglitch,
  serializePreset,
} from "../../src/io";
import { sha256Hex } from "../../src/io/sha256";
import { FakeScheduler, makeEnvelope, makeLayer } from "./storage-fixtures.test";
import { makeDecodablePng, referenceRasterDecoder } from "./helpers/raster-fixtures";

function makeWorld() {
  return { backend: new MemoryBackend(), hub: new MemoryBusHub(), scheduler: new FakeScheduler() };
}

function makeController(world: ReturnType<typeof makeWorld>, ownsBackend = false): AppSessionController {
  return new AppSessionController({
    backend: world.backend,
    ownsBackend,
    backendKind: "memory",
    ownership: {
      lock: new LeaseOwnershipLock(world.backend, {
        timer: world.scheduler.timer,
        now: world.scheduler.clock,
      }),
      bus: world.hub.connect(),
    },
    timer: world.scheduler.timer,
    now: world.scheduler.clock,
    // Unit tests run in node: the controller default fails closed, so the
    // reference decoder stands in for the browser's createImageBitmap.
    rasterDecoder: referenceRasterDecoder,
  });
}

async function makeArchive(): Promise<Uint8Array> {
  const png = makeDecodablePng(8, 8, { seed: "session-import" });
  const sha = await sha256Hex(png);
  const base = makeEnvelope({ title: "Imported piece" });
  const envelope = {
    ...base,
    core: { ...base.core, layers: [makeLayer({ assetId: sha })] },
  };
  return exportDrglitch({ decoder: referenceRasterDecoder,
    envelope,
    appVersion: "test",
    getAsset: (wanted) => (wanted === sha ? { bytes: png, ext: "png" } : null),
    getThumbnail: () => null,
  });
}

async function expectZeroRows(backend: MemoryBackend): Promise<void> {
  expect(await backend.getAllKeys("projects")).toEqual([]);
  expect(await backend.getAllKeys("assets")).toEqual([]);
  expect(await backend.getAllKeys("thumbnails")).toEqual([]);
  expect(await backend.getAllKeys("staging")).toEqual([]);
}

const PRESET: RecipePresetV1 = {
  schema: 1,
  id: "preset-1",
  name: "Session Pass",
  createdAt: 42,
  mode: "halftone",
  halftone: { cellSize: 12, dotShape: "round", customShapeAssetId: null, invert: false, strokeWidth: 1, frayedXEdge: 0, frayedYEdge: 0 },
  diffusion: { algorithm: "none", modulation: "none", modStrength: 0, intensity: 0, levels: 2, sharpenStrength: 0, sharpenRadius: 1, denoise: 0, brokenKernel: 0, directionalBias: 0, directionalBiasAngle: 0, errorOverflow: 0, reset: 0, crossChannelBleed: 0, invert: false },
  glitch: { enabled: false, sliceShift: 0, sliceSize: 0, verticalSliceShift: 0, verticalSliceSize: 0, gridWarp: 0, warpScale: 0, smearDrag: 0, smearLength: 0, smearVertical: false, macroblockCorrupt: 0, macroblockDropout: 0, blockShift: 0, blockShiftSize: 0, channelDesync: 0, bitmapSort: 0, bitmapSortVertical: false },
  customDotSvg: null,
};

describe("cancellable project import (wave-F UI seam)", () => {
  it("disposal cancels a permanently stalled file read before closing storage", async () => {
    const world = makeWorld();
    const controller = makeController(world, true);
    const order: string[] = [];
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const cancel = vi.fn(() => { order.push("cancel"); });
    const close = vi.spyOn(world.backend, "close").mockImplementation(() => { order.push("close"); });
    const stream = new ReadableStream<Uint8Array>({
      pull() { started(); return new Promise<void>(() => {}); },
      cancel,
    });
    const handle = controller.importProjectFileCancellable({ size: 1, stream: () => stream,
      arrayBuffer: () => Promise.reject(new Error("must use stream")) });
    const rejected = expect(handle.promise).rejects.toMatchObject({ code: "archive-aborted" });
    await reading;
    await controller.dispose();
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["cancel", "close"]);
    await expectZeroRows(world.backend);
  });

  it("cancel from commit progress prevents installation", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const bytes = await makeArchive();
    const handle = controller.importProjectFileCancellable(new File([bytes as BlobPart], "piece.drglitch"));
    handle.onProgress((progress) => { if (progress.phase === "commit") handle.cancel(); });
    await expect(handle.promise).rejects.toMatchObject({ code: "archive-aborted" });
    await expectZeroRows(world.backend);
    await controller.dispose();
  });

  it("exposes {promise, cancel, onProgress}; a successful import installs and reports progress", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const bytes = await makeArchive();
    const handle = controller.importProjectFileCancellable(new File([bytes as BlobPart], "piece.drglitch"));
    const phases: string[] = [];
    const unsubscribe = handle.onProgress((progress) => phases.push(progress.phase));
    const id = await handle.promise;
    unsubscribe();
    expect(phases[0]).toBe("extract");
    expect(phases[phases.length - 1]).toBe("commit");
    // Installed atomically: project row present, staging clean.
    expect((await controller.projects.load(id)).title).toBe("Imported piece");
    expect(await world.backend.getAllKeys("staging")).toEqual([]);
    await controller.dispose();
  });

  it("cancel() mid-import rejects typed and leaves ZERO rows anywhere", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const bytes = await makeArchive();
    const handle = controller.importProjectFileCancellable(new File([bytes as BlobPart], "piece.drglitch"));
    handle.onProgress((progress) => {
      // The user hits Cancel while staging is underway.
      if (progress.phase === "stage") handle.cancel();
    });
    try {
      await handle.promise;
      throw new Error("expected archive-aborted");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).code).toBe("archive-aborted");
    }
    await expectZeroRows(world.backend);
    await controller.dispose();
  });

  it("cancel() is idempotent and effective even before the file read starts", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const bytes = await makeArchive();
    const handle = controller.importProjectFileCancellable(new File([bytes as BlobPart], "piece.drglitch"));
    handle.cancel();
    handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ code: "archive-aborted" });
    await expectZeroRows(world.backend);
    await controller.dispose();
  });

  it("pre-size gate fires BEFORE any byte of the file is read", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const stream = vi.fn();
    const arrayBuffer = vi.fn();
    const handle = controller.importProjectFileCancellable({
      size: RESOURCE_POLICY.maxArchiveCompressedBytes + 1,
      stream,
      arrayBuffer,
    } as never);
    await expect(handle.promise).rejects.toMatchObject({ code: "archive-too-large" });
    expect(stream).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it("the operation deadline covers the whole pipeline: timeout leaves ZERO rows", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const bytes = await makeArchive();
    await expect(controller.importProjectFile(bytes, { timeoutMs: -1 })).rejects.toMatchObject({
      name: "ArchiveValidationError",
      code: "archive-timeout",
    });
    await expectZeroRows(world.backend);
    await controller.dispose();
  });
});

describe("session preset intake (pre-size gate before file.text())", () => {
  it("rejects an oversized preset file WITHOUT ever calling text()", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const text = vi.fn();
    await expect(
      controller.importPresetFile({ size: MAX_PRESET_TEXT_LENGTH + 1, text } as never),
    ).rejects.toMatchObject({ name: "PresetValidationError", code: "preset-too-large" });
    expect(text).not.toHaveBeenCalled();
    expect(await world.backend.getAllKeys("presets")).toEqual([]);
    await controller.dispose();
  });

  it("parses a valid preset through the hardened parser and saves it with a fresh id", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    const text = serializePreset(PRESET);
    const saved = await controller.importPresetFile({ size: text.length, text: async () => text });
    expect(saved.name).toBe("Session Pass");
    expect(saved.id).not.toBe(PRESET.id);
    const listed = await controller.presets.list();
    expect(listed.map((preset) => preset.name)).toContain("Session Pass");
    await controller.dispose();
  });

  it("fails closed on invalid preset text: typed error, nothing saved", async () => {
    const world = makeWorld();
    const controller = makeController(world);
    await expect(
      controller.importPresetFile({ size: 16, text: async () => "definitely-not-json" }),
    ).rejects.toBeInstanceOf(PresetValidationError);
    expect(await world.backend.getAllKeys("presets")).toEqual([]);
    await controller.dispose();
  });
});
