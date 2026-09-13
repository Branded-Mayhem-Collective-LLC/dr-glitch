import { describe, expect, it } from "vitest";

import type { GuidesV1, SnappingV1 } from "../../src/core/types";
import {
  computePointSnap,
  computeSnap,
  hitTestGuides,
} from "../../src/editor/snapping";

const snapAll = (over: Partial<SnappingV1> = {}): SnappingV1 => ({
  enabled: true,
  toGuides: true,
  toGrid: true,
  toLayers: true,
  toArtboard: true,
  ...over,
});

const bounds = (x: number, y: number, width = 10, height = 10) => ({
  x,
  y,
  width,
  height,
});

describe("computeSnap", () => {
  it("snaps the nearest edge to a guide within tolerance", () => {
    const r = computeSnap(
      bounds(98, 300),
      { guidesX: [100] },
      snapAll({ toGrid: false, toLayers: false, toArtboard: false }),
      4,
      1,
    );
    expect(r.snappedX).toBe(true);
    expect(r.delta).toEqual({ x: 2, y: 0 });
    expect(r.linesX).toEqual([100]);
    expect(r.snappedY).toBe(false);
    expect(r.linesY).toEqual([]);
  });

  it("does not snap outside tolerance", () => {
    const r = computeSnap(
      bounds(93, 300, 0, 0),
      { guidesX: [100] },
      snapAll({ toGrid: false, toLayers: false, toArtboard: false }),
      4,
      1,
    );
    expect(r.snappedX).toBe(false);
    expect(r.delta).toEqual({ x: 0, y: 0 });
  });

  it("tolerance is screen px: zooming in shrinks the doc-px capture range", () => {
    const candidates = { guidesX: [100] };
    const config = snapAll({ toGrid: false, toLayers: false, toArtboard: false });
    // Zero-size bounds 3 doc px away; 4 screen px tolerance.
    expect(
      computeSnap(bounds(97, 0, 0, 0), candidates, config, 4, 1).snappedX,
    ).toBe(true);
    expect(
      computeSnap(bounds(97, 0, 0, 0), candidates, config, 4, 2).snappedX,
    ).toBe(false);
  });

  it("picks the nearest among multiple candidates", () => {
    const r = computeSnap(
      bounds(98, 0),
      { guidesX: [95, 100, 104] },
      snapAll({ toGrid: false, toLayers: false, toArtboard: false }),
      10,
      1,
    );
    // Center 103 -> 104 (dist 1) beats left 98 -> 100 (2) and 95 (3).
    expect(r.delta.x).toBe(1);
    expect(r.linesX).toEqual([104]);
  });

  it("snaps centers and edges to other layer bounds", () => {
    const r = computeSnap(
      bounds(52, 0, 20, 20), // center x = 62
      { layerBounds: [bounds(40, 100, 40, 10)] }, // center x = 60
      snapAll({ toGrid: false, toGuides: false, toArtboard: false }),
      5,
      1,
    );
    expect(r.delta.x).toBe(-2); // center 62 -> 60
    expect(r.linesX).toEqual([60]);
  });

  it("snaps to artboard edges and center", () => {
    const r = computeSnap(
      bounds(232, -3, 20, 20), // center x = 242; top = -3
      { artboard: { width: 480, height: 600 } },
      snapAll({ toGrid: false, toGuides: false, toLayers: false }),
      6,
      1,
    );
    expect(r.delta).toEqual({ x: -2, y: 3 }); // center -> 240, top -> 0
    expect(r.linesX).toEqual([240]);
    expect(r.linesY).toEqual([0]);
  });

  it("snaps to the nearest grid multiple", () => {
    const r = computeSnap(
      bounds(25, 47),
      { gridSize: 24 },
      snapAll({ toGuides: false, toLayers: false, toArtboard: false }),
      4,
      1,
    );
    expect(r.delta).toEqual({ x: -1, y: 1 }); // 25 -> 24, 47 -> 48
  });

  it("master switch off yields zero delta and no lines", () => {
    const r = computeSnap(
      bounds(98, 0),
      { guidesX: [100] },
      snapAll({ enabled: false }),
      10,
      1,
    );
    expect(r).toEqual({
      delta: { x: 0, y: 0 },
      snappedX: false,
      snappedY: false,
      linesX: [],
      linesY: [],
    });
  });

  it("per-source toggles exclude their candidates", () => {
    const r = computeSnap(
      bounds(98, 0),
      { guidesX: [100], gridSize: 24 },
      snapAll({ toGuides: false, toGrid: false, toLayers: false, toArtboard: false }),
      10,
      1,
    );
    expect(r.snappedX).toBe(false);
  });
});

describe("computePointSnap", () => {
  it("snaps a bare point to guides on both axes", () => {
    const r = computePointSnap(
      { x: 101, y: 199 },
      { guidesX: [100], guidesY: [200] },
      snapAll({ toGrid: false, toLayers: false, toArtboard: false }),
      4,
      1,
    );
    expect(r.delta).toEqual({ x: -1, y: 1 });
    expect(r.snappedX).toBe(true);
    expect(r.snappedY).toBe(true);
  });
});

describe("hitTestGuides", () => {
  const guides = (over: Partial<GuidesV1> = {}): GuidesV1 => ({
    horizontal: [100, 300],
    vertical: [50, 250],
    locked: false,
    visible: true,
    ...over,
  });

  it("hits the nearest guide within tolerance", () => {
    expect(hitTestGuides({ x: 52, y: 999 }, guides(), 4, 1)).toEqual({
      axis: "vertical",
      index: 0,
    });
    expect(hitTestGuides({ x: 999, y: 301 }, guides(), 4, 1)).toEqual({
      axis: "horizontal",
      index: 1,
    });
  });

  it("prefers the closer guide when several are in range", () => {
    expect(hitTestGuides({ x: 51, y: 101 }, guides(), 10, 1)).toEqual({
      axis: "vertical",
      index: 0,
    });
  });

  it("scales tolerance by zoom", () => {
    expect(hitTestGuides({ x: 53, y: 0 }, guides(), 4, 2)).toBeNull();
    expect(hitTestGuides({ x: 53, y: 0 }, guides(), 4, 1)).not.toBeNull();
  });

  it("locked or hidden guides never hit", () => {
    expect(hitTestGuides({ x: 50, y: 0 }, guides({ locked: true }), 4, 1)).toBeNull();
    expect(hitTestGuides({ x: 50, y: 0 }, guides({ visible: false }), 4, 1)).toBeNull();
  });

  it("misses when nothing is in range", () => {
    expect(hitTestGuides({ x: 10, y: 10 }, guides(), 4, 1)).toBeNull();
  });
});
