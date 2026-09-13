import { describe, expect, it } from "vitest";

import {
  type AlignItem,
  alignBounds,
  alignToSelection,
  distributeBounds,
  selectionBounds,
} from "../../src/editor/alignment";

const item = (
  id: string,
  x: number,
  y: number,
  width = 10,
  height = 10,
): AlignItem => ({ id, bounds: { x, y, width, height } });

describe("selectionBounds", () => {
  it("is the hull of all item bounds", () => {
    expect(selectionBounds([item("a", 0, 0), item("b", 20, 5)])).toEqual({
      x: 0,
      y: 0,
      width: 30,
      height: 15,
    });
  });

  it("is null for an empty selection", () => {
    expect(selectionBounds([])).toBeNull();
  });
});

describe("alignToSelection", () => {
  const items = [item("a", 0, 0), item("b", 20, 5)];

  it("left aligns to the selection's left edge", () => {
    expect(alignToSelection(items, "left")).toEqual([
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: -20, y: 0 } },
    ]);
  });

  it("right aligns to the selection's right edge", () => {
    expect(alignToSelection(items, "right")).toEqual([
      { id: "a", delta: { x: 20, y: 0 } },
      { id: "b", delta: { x: 0, y: 0 } },
    ]);
  });

  it("centerX aligns centers exactly", () => {
    // Selection spans x 0..30, center 15; item centers 5 and 25.
    expect(alignToSelection(items, "centerX")).toEqual([
      { id: "a", delta: { x: 10, y: 0 } },
      { id: "b", delta: { x: -10, y: 0 } },
    ]);
  });

  it("top / centerY / bottom act on the y axis only", () => {
    expect(alignToSelection(items, "top")).toEqual([
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: 0, y: -5 } },
    ]);
    // Selection spans y 0..15, center 7.5; centers 5 and 10.
    expect(alignToSelection(items, "centerY")).toEqual([
      { id: "a", delta: { x: 0, y: 2.5 } },
      { id: "b", delta: { x: 0, y: -2.5 } },
    ]);
    expect(alignToSelection(items, "bottom")).toEqual([
      { id: "a", delta: { x: 0, y: 5 } },
      { id: "b", delta: { x: 0, y: 0 } },
    ]);
  });

  it("empty selection yields no deltas", () => {
    expect(alignToSelection([], "left")).toEqual([]);
  });
});

describe("alignBounds with an artboard reference", () => {
  const artboard = { x: 0, y: 0, width: 480, height: 600 };

  it("centers a single item on the artboard", () => {
    expect(alignBounds([item("a", 10, 10, 100, 50)], "centerX", artboard)).toEqual(
      [{ id: "a", delta: { x: 180, y: 0 } }],
    );
    expect(alignBounds([item("a", 10, 10, 100, 50)], "centerY", artboard)).toEqual(
      [{ id: "a", delta: { x: 0, y: 265 } }],
    );
  });

  it("bottom-right aligns against artboard edges", () => {
    expect(alignBounds([item("a", 0, 0, 100, 50)], "right", artboard)).toEqual([
      { id: "a", delta: { x: 380, y: 0 } },
    ]);
    expect(alignBounds([item("a", 0, 0, 100, 50)], "bottom", artboard)).toEqual([
      { id: "a", delta: { x: 0, y: 550 } },
    ]);
  });
});

describe("distributeBounds", () => {
  it("equalizes gaps horizontally, outermost items fixed", () => {
    const items = [item("a", 0, 0), item("b", 15, 0), item("c", 50, 0)];
    // Span 0..60, sizes 30 total, gaps (60-30)/2 = 15 -> positions 0, 25, 50.
    expect(distributeBounds(items, "horizontal")).toEqual([
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: 10, y: 0 } },
      { id: "c", delta: { x: 0, y: 0 } },
    ]);
  });

  it("equalizes gaps vertically", () => {
    const items = [item("a", 0, 0), item("b", 0, 12), item("c", 0, 40)];
    // Span 0..50, gap (50-30)/2 = 10 -> positions 0, 20, 40.
    expect(distributeBounds(items, "vertical")).toEqual([
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: 0, y: 8 } },
      { id: "c", delta: { x: 0, y: 0 } },
    ]);
  });

  it("handles mixed sizes exactly", () => {
    const items = [
      item("a", 0, 0, 10, 10),
      item("b", 30, 0, 20, 10),
      item("c", 80, 0, 10, 10),
    ];
    // Span 0..90, sizes 40, gap (90-40)/2 = 25 -> a at 0, b at 35, c at 80.
    expect(distributeBounds(items, "horizontal")).toEqual([
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: 5, y: 0 } },
      { id: "c", delta: { x: 0, y: 0 } },
    ]);
  });

  it("fewer than three items with a selection reference is a no-op", () => {
    const items = [item("a", 0, 0), item("b", 40, 0)];
    expect(distributeBounds(items, "horizontal")).toEqual([
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: 0, y: 0 } },
    ]);
  });

  it("distributes across an artboard reference, pinning first and last", () => {
    const artboard = { x: 0, y: 0, width: 100, height: 100 };
    const items = [item("a", 5, 0), item("b", 40, 0), item("c", 70, 0)];
    // Sizes 30 total, gap (100-30)/2 = 35 -> positions 0, 45, 90.
    expect(distributeBounds(items, "horizontal", artboard)).toEqual([
      { id: "a", delta: { x: -5, y: 0 } },
      { id: "b", delta: { x: 5, y: 0 } },
      { id: "c", delta: { x: 20, y: 0 } },
    ]);
  });

  it("preserves input order in the result while sorting internally", () => {
    const items = [item("c", 50, 0), item("a", 0, 0), item("b", 15, 0)];
    expect(distributeBounds(items, "horizontal")).toEqual([
      { id: "c", delta: { x: 0, y: 0 } },
      { id: "a", delta: { x: 0, y: 0 } },
      { id: "b", delta: { x: 10, y: 0 } },
    ]);
  });
});
