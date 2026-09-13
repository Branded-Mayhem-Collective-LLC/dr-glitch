/**
 * StrictMode-safe disposable ownership (src/app/lifecycle.ts).
 *
 * Regression for the dev/E2E-breaking bug where React StrictMode's
 * setup → cleanup → setup effect cycle (refs preserved, no re-render in
 * between) left HalftoneStudio holding a permanently disposed AssetCache
 * and PreviewService: a disposed service silently ignores requests, so the
 * preview never produced a frame. `ensureLive` is the sanctioned accessor:
 * after a cleanup disposes the held instance, the next read constructs a
 * fresh live one.
 */
import { describe, expect, it } from "vitest";
import { ensureLive, type DisposableSlot } from "../../src/app/lifecycle";
import { PreviewService } from "../../src/app/preview-service";
import { applyCommand, createEmptyProjectCore, createLayerFromAsset } from "../../src/project";
import type { ProjectCoreV1 } from "../../src/core/types";
import type {
  RenderJobRequest,
  RenderPort,
  RenderWorkerEvent,
} from "../../src/render";
import type { RasterData } from "../../src/export/orchestrator";

class FakePort implements RenderPort {
  jobs: RenderJobRequest[] = [];
  disposed = false;
  private listeners = new Set<(event: RenderWorkerEvent) => void>();

  submit(job: RenderJobRequest): void {
    this.jobs.push(job);
  }
  cancel(): void {}
  dispose(): void {
    this.disposed = true;
  }
  onEvent(listener: (event: RenderWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

function coreWithLayer(): ProjectCoreV1 {
  const core = createEmptyProjectCore();
  const layer = createLayerFromAsset(
    "a".repeat(64),
    "art.png",
    { width: 320, height: 240 },
    core.artboard,
  );
  return applyCommand(core, { type: "layer/add", layer });
}

function smallRaster(width = 4, height = 4): RasterData {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeService(ports: FakePort[]): PreviewService {
  return new PreviewService({
    createPort: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    sources: { resolveRaster: async () => smallRaster() },
    prepareLayer: (_layer, source) => source,
  });
}

describe("ensureLive", () => {
  it("returns the held instance while it is live", () => {
    const ports: FakePort[] = [];
    const slot: DisposableSlot<PreviewService> = { current: null };
    const first = ensureLive(slot, () => makeService(ports));
    expect(ensureLive(slot, () => makeService(ports))).toBe(first);
  });

  it("replaces a disposed instance instead of returning it", () => {
    const ports: FakePort[] = [];
    const slot: DisposableSlot<PreviewService> = { current: null };
    const first = ensureLive(slot, () => makeService(ports));
    first.dispose();
    const second = ensureLive(slot, () => makeService(ports));
    expect(second).not.toBe(first);
    expect(second.isDisposed).toBe(false);
    expect(slot.current).toBe(second);
  });

  it("still produces a draft submission after setup → cleanup → setup", async () => {
    // The StrictMode double-invoke shape: setup acquires the service and
    // submits; cleanup disposes it; the second setup runs on the SAME slot
    // (refs are preserved) and must end up with a working service.
    const ports: FakePort[] = [];
    const slot: DisposableSlot<PreviewService> = { current: null };
    const core = coreWithLayer();
    const input = { core, view: "composite" as const, viewportScale: 0.5 };

    // setup #1
    const service1 = ensureLive(slot, () => makeService(ports));
    service1.requestDraft(input);
    await tick();
    expect(ports).toHaveLength(1);
    expect(ports[0].jobs).toHaveLength(1);

    // cleanup #1 (unmount simulation — the ref keeps pointing at service1)
    service1.dispose();

    // A disposed service must ignore requests — this is why reuse hangs.
    service1.requestDraft(input);
    await tick();
    expect(ports[0].jobs).toHaveLength(1);

    // setup #2: the guarded accessor hands back a FRESH service whose draft
    // reaches a port — the preview renders again after the remount.
    const service2 = ensureLive(slot, () => makeService(ports));
    expect(service2).not.toBe(service1);
    service2.requestDraft(input);
    await tick();
    expect(ports).toHaveLength(2);
    expect(ports[1].jobs).toHaveLength(1);
    expect(ports[1].jobs[0].kind).toBe("preview-draft");
  });
});
