import { describe, expect, it } from "vitest";
import {
  clampFloatRect,
  createDefaultLayout,
  createDefaultWorkspaceState,
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  FLOAT_REACH_X,
  getPlacement,
  openFloats,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  workspaceReducer,
  type Viewport,
  type WorkspaceAction,
  type WorkspaceState,
} from "../../src/workspace/layout-state";

const VIEWPORT: Viewport = { width: 1600, height: 900 };

function run(state: WorkspaceState, ...actions: WorkspaceAction[]) {
  return actions.reduce(workspaceReducer, state);
}

function activate(toolId: Parameters<typeof getPlacement>[1]): WorkspaceAction {
  return { type: "activate-tool", toolId, viewport: VIEWPORT };
}

describe("fresh session defaults", () => {
  it("starts with Select active, Layers docked, Document expanded, no floats", () => {
    const state = createDefaultWorkspaceState();
    expect(state.activeToolId).toBe("select");
    expect(state.layout.dockPanelId).toBe("layers");
    expect(getPlacement(state.layout, "layers").open).toBe(true);
    expect(state.layout.expandedDrawer).toBe("document");
    expect(state.layout.dockWidth).toBe(DOCK_DEFAULT_WIDTH);
    expect(openFloats(state.layout)).toHaveLength(0);
    expect(state.focusMode).toBe(false);
    expect(state.layout.locked).toBe(false);
  });
});

describe("tool activation and the dock", () => {
  it("activating a docked tool shows its panel and hides the displaced one", () => {
    const state = run(createDefaultWorkspaceState(), activate("halftone"));
    expect(state.activeToolId).toBe("halftone");
    expect(state.layout.dockPanelId).toBe("halftone");
    expect(getPlacement(state.layout, "halftone").open).toBe(true);
    expect(getPlacement(state.layout, "layers").open).toBe(false);
  });

  it("reactivating the displaced tool restores it into the dock", () => {
    const state = run(
      createDefaultWorkspaceState(),
      activate("halftone"),
      activate("layers"),
    );
    expect(state.layout.dockPanelId).toBe("layers");
    expect(getPlacement(state.layout, "layers").open).toBe(true);
    expect(getPlacement(state.layout, "halftone").open).toBe(false);
  });

  it("activating a floated tool raises the float; the dock keeps its panel", () => {
    let state = run(
      createDefaultWorkspaceState(),
      { type: "float-panel", toolId: "glitch", viewport: VIEWPORT },
      activate("layers"),
    );
    expect(state.layout.dockPanelId).toBe("layers");
    state = run(state, activate("glitch"));
    expect(state.activeToolId).toBe("glitch");
    expect(getPlacement(state.layout, "glitch").mode).toBe("floating");
    expect(getPlacement(state.layout, "glitch").open).toBe(true);
    // Dock panel remains visible alongside the float.
    expect(state.layout.dockPanelId).toBe("layers");
    expect(getPlacement(state.layout, "layers").open).toBe(true);
  });

  it("interacting with a panel activates its tool", () => {
    const state = run(createDefaultWorkspaceState(), {
      type: "focus-panel",
      toolId: "layers",
    });
    expect(state.activeToolId).toBe("layers");
    expect(state.focusedPanelId).toBe("layers");
  });
});

describe("float / dock / close placement memory", () => {
  it("floating a docked panel empties the dock", () => {
    const state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "layers",
      viewport: VIEWPORT,
    });
    expect(state.layout.dockPanelId).toBeNull();
    const placement = getPlacement(state.layout, "layers");
    expect(placement.mode).toBe("floating");
    expect(placement.rect).not.toBeNull();
  });

  it("docking into an occupied dock hides the displaced panel", () => {
    const state = run(
      createDefaultWorkspaceState(),
      { type: "float-panel", toolId: "glitch", viewport: VIEWPORT },
      { type: "dock-panel", toolId: "glitch" },
    );
    expect(state.layout.dockPanelId).toBe("glitch");
    expect(getPlacement(state.layout, "glitch").mode).toBe("docked");
    expect(getPlacement(state.layout, "layers").open).toBe(false);
  });

  it("close remembers the float placement and rail activation restores it", () => {
    let state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "plates",
      viewport: VIEWPORT,
    });
    const rect = getPlacement(state.layout, "plates").rect;
    state = run(state, { type: "close-panel", toolId: "plates" });
    expect(getPlacement(state.layout, "plates").open).toBe(false);
    expect(getPlacement(state.layout, "plates").mode).toBe("floating");
    state = run(state, activate("plates"));
    const restored = getPlacement(state.layout, "plates");
    expect(restored.open).toBe(true);
    expect(restored.mode).toBe("floating");
    expect(restored.rect).toEqual(rect);
  });

  it("closing the docked panel empties the dock without forgetting the mode", () => {
    const state = run(createDefaultWorkspaceState(), {
      type: "close-panel",
      toolId: "layers",
    });
    expect(state.layout.dockPanelId).toBeNull();
    expect(getPlacement(state.layout, "layers").mode).toBe("docked");
    const restored = run(state, activate("layers"));
    expect(restored.layout.dockPanelId).toBe("layers");
  });
});

describe("z-order", () => {
  it("raises panels above every other float", () => {
    let state = run(
      createDefaultWorkspaceState(),
      { type: "float-panel", toolId: "glitch", viewport: VIEWPORT },
      { type: "float-panel", toolId: "plates", viewport: VIEWPORT },
    );
    expect(openFloats(state.layout).map((p) => p.toolId)).toEqual([
      "glitch",
      "plates",
    ]);
    state = run(state, { type: "raise-panel", toolId: "glitch" });
    expect(openFloats(state.layout).map((p) => p.toolId)).toEqual([
      "plates",
      "glitch",
    ]);
  });
});

describe("gestures", () => {
  function withFloat() {
    return run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "glitch",
      viewport: VIEWPORT,
    });
  }

  it("cancel restores the exact pre-gesture rect", () => {
    let state = withFloat();
    const before = getPlacement(state.layout, "glitch").rect;
    state = run(
      state,
      { type: "begin-gesture", toolId: "glitch", kind: "move" },
      {
        type: "update-gesture",
        rect: { x: 500, y: 300, width: 400, height: 400 },
        viewport: VIEWPORT,
      },
    );
    expect(getPlacement(state.layout, "glitch").rect).not.toEqual(before);
    state = run(state, { type: "cancel-gesture" });
    expect(getPlacement(state.layout, "glitch").rect).toEqual(before);
    expect(state.gesture).toBeNull();
  });

  it("commit keeps the updated rect", () => {
    let state = withFloat();
    state = run(
      state,
      { type: "begin-gesture", toolId: "glitch", kind: "resize" },
      {
        type: "update-gesture",
        rect: { x: 200, y: 100, width: 420, height: 500 },
        viewport: VIEWPORT,
      },
      { type: "commit-gesture" },
    );
    expect(getPlacement(state.layout, "glitch").rect).toEqual({
      x: 200,
      y: 100,
      width: 420,
      height: 500,
    });
  });

  it("enforces the 320x240 minimum during resize", () => {
    let state = withFloat();
    state = run(
      state,
      { type: "begin-gesture", toolId: "glitch", kind: "resize" },
      {
        type: "update-gesture",
        rect: { x: 200, y: 100, width: 10, height: 10 },
        viewport: VIEWPORT,
      },
    );
    const rect = getPlacement(state.layout, "glitch").rect;
    expect(rect?.width).toBe(FLOAT_MIN_WIDTH);
    expect(rect?.height).toBe(FLOAT_MIN_HEIGHT);
  });
});

describe("clamping offscreen floats", () => {
  it("keeps the titlebar reachable", () => {
    const clamped = clampFloatRect(
      { x: 5000, y: 5000, width: 360, height: 400 },
      VIEWPORT,
    );
    expect(clamped.x).toBeLessThanOrEqual(VIEWPORT.width - FLOAT_REACH_X);
    expect(clamped.y).toBeLessThanOrEqual(VIEWPORT.height - 36);
    const clampedLeft = clampFloatRect(
      { x: -5000, y: -50, width: 360, height: 400 },
      VIEWPORT,
    );
    expect(clampedLeft.x).toBeGreaterThanOrEqual(FLOAT_REACH_X - 360);
    expect(clampedLeft.y).toBe(0);
  });

  it("clamp-floats repairs every recovered offscreen float", () => {
    let state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "glitch",
      viewport: VIEWPORT,
    });
    state = {
      ...state,
      layout: {
        ...state.layout,
        placements: state.layout.placements.map((p) =>
          p.toolId === "glitch"
            ? { ...p, rect: { x: 99999, y: 99999, width: 360, height: 400 } }
            : p,
        ),
      },
    };
    state = run(state, { type: "clamp-floats", viewport: VIEWPORT });
    const rect = getPlacement(state.layout, "glitch").rect;
    expect(rect && rect.x <= VIEWPORT.width - FLOAT_REACH_X).toBe(true);
    expect(rect && rect.y <= VIEWPORT.height - 36).toBe(true);
  });
});

describe("lock layout semantics", () => {
  function locked() {
    return run(
      run(createDefaultWorkspaceState(), {
        type: "float-panel",
        toolId: "glitch",
        viewport: VIEWPORT,
      }),
      { type: "set-locked", locked: true },
    );
  }

  it("blocks move/resize/dock/undock and dock width changes", () => {
    const state = locked();
    const before = state.layout;
    expect(
      run(state, { type: "begin-gesture", toolId: "glitch", kind: "move" })
        .gesture,
    ).toBeNull();
    expect(
      run(state, { type: "float-panel", toolId: "layers", viewport: VIEWPORT })
        .layout,
    ).toBe(before);
    expect(run(state, { type: "dock-panel", toolId: "glitch" }).layout).toBe(
      before,
    );
    expect(run(state, { type: "set-dock-width", width: 500 }).layout).toBe(
      before,
    );
    expect(
      run(state, {
        type: "reset-panel-position",
        toolId: "glitch",
        viewport: VIEWPORT,
      }).layout,
    ).toBe(before);
  });

  it("still allows open/close, focus, tool selection, and drawers", () => {
    let state = locked();
    state = run(state, activate("halftone"));
    expect(state.layout.dockPanelId).toBe("halftone");
    state = run(state, { type: "close-panel", toolId: "halftone" });
    expect(getPlacement(state.layout, "halftone").open).toBe(false);
    state = run(state, { type: "focus-panel", toolId: "glitch" });
    expect(state.activeToolId).toBe("glitch");
    state = run(state, { type: "set-expanded-drawer", drawer: "proof" });
    expect(state.layout.expandedDrawer).toBe("proof");
  });
});

describe("reset layout", () => {
  it("hides floats, docks the active tool, resets dock and z, unlocks", () => {
    let state = run(
      createDefaultWorkspaceState(),
      { type: "float-panel", toolId: "glitch", viewport: VIEWPORT },
      { type: "set-dock-width", width: 500 },
      { type: "set-locked", locked: true },
    );
    state = run(state, { type: "reset-layout" });
    expect(openFloats(state.layout)).toHaveLength(0);
    expect(state.layout.locked).toBe(false);
    expect(state.layout.dockWidth).toBe(DOCK_DEFAULT_WIDTH);
    // The active tool (glitch, activated by floating it) is docked and open.
    expect(state.layout.dockPanelId).toBe(state.activeToolId);
    expect(getPlacement(state.layout, state.activeToolId).open).toBe(true);
    expect(
      state.layout.placements.every(
        (p) => p.z === 0 && p.mode === "docked",
      ),
    ).toBe(true);
  });
});

describe("focus mode", () => {
  it("restores the exact prior arrangement on exit", () => {
    let state = run(
      createDefaultWorkspaceState(),
      { type: "float-panel", toolId: "plates", viewport: VIEWPORT },
      activate("halftone"),
    );
    const before = state.layout;
    state = run(state, { type: "set-focus-mode", enabled: true });
    expect(state.focusMode).toBe(true);
    // Layout mutations during focus mode are discarded on exit.
    state = run(state, { type: "close-panel", toolId: "plates" });
    state = run(state, { type: "set-focus-mode", enabled: false });
    expect(state.focusMode).toBe(false);
    expect(state.layout).toEqual(before);
  });
});

describe("dock width", () => {
  it("clamps to the 320-520 range", () => {
    const state = createDefaultWorkspaceState();
    expect(
      run(state, { type: "set-dock-width", width: 100 }).layout.dockWidth,
    ).toBe(DOCK_MIN_WIDTH);
    expect(
      run(state, { type: "set-dock-width", width: 9000 }).layout.dockWidth,
    ).toBe(DOCK_MAX_WIDTH);
    expect(
      run(state, { type: "set-dock-width", width: 400 }).layout.dockWidth,
    ).toBe(400);
  });
});

describe("drawer exclusivity", () => {
  it("expanding one drawer replaces the other; null collapses all", () => {
    let state = createDefaultWorkspaceState();
    expect(state.layout.expandedDrawer).toBe("document");
    state = run(state, { type: "set-expanded-drawer", drawer: "output" });
    expect(state.layout.expandedDrawer).toBe("output");
    state = run(state, { type: "set-expanded-drawer", drawer: "proof" });
    expect(state.layout.expandedDrawer).toBe("proof");
    state = run(state, { type: "set-expanded-drawer", drawer: null });
    expect(state.layout.expandedDrawer).toBeNull();
  });
});

describe("layout persistence", () => {
  it("round-trips a serialized layout", () => {
    const state = run(
      createDefaultWorkspaceState(),
      { type: "float-panel", toolId: "glitch", viewport: VIEWPORT },
      { type: "set-dock-width", width: 480 },
      { type: "set-expanded-drawer", drawer: "proof" },
    );
    const parsed = parseWorkspaceLayout(
      serializeWorkspaceLayout(state.layout),
    );
    expect(parsed).toEqual(state.layout);
  });

  it("falls back to null on corrupt JSON, wrong schema, or foreign shapes", () => {
    expect(parseWorkspaceLayout("{ not json")).toBeNull();
    expect(parseWorkspaceLayout("")).toBeNull();
    expect(parseWorkspaceLayout(null)).toBeNull();
    expect(parseWorkspaceLayout("42")).toBeNull();
    expect(parseWorkspaceLayout("[1,2,3]")).toBeNull();
    expect(parseWorkspaceLayout(JSON.stringify({ schema: 2 }))).toBeNull();
  });

  it("normalizes field-level damage instead of discarding everything", () => {
    const parsed = parseWorkspaceLayout(
      JSON.stringify({
        schema: 1,
        dockWidth: "wide",
        dockPanelId: "not-a-tool",
        expandedDrawer: "attic",
        locked: "yes",
        placements: [
          { toolId: "glitch", mode: "floating", open: true, z: 3.7, rect: { x: 1, y: 2, width: 5, height: 5 } },
          { toolId: "bogus", mode: "floating", open: true, z: 1, rect: null },
          "garbage",
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.dockWidth).toBe(DOCK_DEFAULT_WIDTH);
    expect(parsed?.dockPanelId).toBeNull();
    expect(parsed?.expandedDrawer).toBe("document");
    expect(parsed?.locked).toBe(false);
    const glitch = parsed?.placements.find((p) => p.toolId === "glitch");
    expect(glitch?.mode).toBe("floating");
    expect(glitch?.z).toBe(4);
    // Undersized stored rects are pulled up to the float minimum.
    expect(glitch?.rect?.width).toBe(FLOAT_MIN_WIDTH);
    expect(glitch?.rect?.height).toBe(FLOAT_MIN_HEIGHT);
    // Unknown tools are dropped; every registry tool keeps a placement.
    expect(parsed?.placements.some((p) => (p.toolId as string) === "bogus")).toBe(false);
    expect(parsed?.placements).toHaveLength(createDefaultLayout().placements.length);
  });

  it("clears dockPanelId when the stored dock panel is floating or closed", () => {
    const layout = createDefaultLayout();
    const tampered = {
      ...layout,
      dockPanelId: "glitch",
    };
    const parsed = parseWorkspaceLayout(JSON.stringify(tampered));
    expect(parsed?.dockPanelId).toBeNull();
  });
});

describe("drag-to-undock / drag-to-redock support", () => {
  it("float-panel honors an explicit rect (undock at the pointer)", () => {
    const state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "layers",
      viewport: VIEWPORT,
      rect: { x: 400, y: 200, width: 360, height: 460 },
    });
    expect(getPlacement(state.layout, "layers").rect).toEqual({
      x: 400,
      y: 200,
      width: 360,
      height: 460,
    });
    expect(state.layout.dockPanelId).toBeNull();
  });

  it("explicit undock rects still clamp to the workspace", () => {
    const state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "layers",
      viewport: VIEWPORT,
      rect: { x: 5000, y: 5000, width: 360, height: 460 },
    });
    const rect = getPlacement(state.layout, "layers").rect!;
    expect(rect.x).toBeLessThanOrEqual(VIEWPORT.width - FLOAT_REACH_X);
    expect(rect.y).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("tracks the dock drop-target flag and clears it on commit/cancel", () => {
    let state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "layers",
      viewport: VIEWPORT,
    });
    state = run(state, { type: "set-dock-drop-target", active: true });
    expect(state.dockDropActive).toBe(true);
    state = run(
      state,
      { type: "begin-gesture", toolId: "layers", kind: "move" },
      { type: "commit-gesture" },
    );
    expect(state.dockDropActive).toBe(false);

    state = run(
      state,
      { type: "set-dock-drop-target", active: true },
      { type: "begin-gesture", toolId: "layers", kind: "move" },
      { type: "cancel-gesture" },
    );
    expect(state.dockDropActive).toBe(false);
  });

  it("drop-target flag is session state and never persisted", () => {
    const layout = createDefaultLayout();
    expect(serializeWorkspaceLayout(layout)).not.toContain("dockDropActive");
  });
});

describe("restore-float-rect (cancelled dock drag-out)", () => {
  it("restores a remembered rect without changing mode or open state", () => {
    let state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "layers",
      viewport: VIEWPORT,
      rect: { x: 100, y: 80, width: 400, height: 300 },
    });
    const remembered = getPlacement(state.layout, "layers").rect;
    // Re-dock, then simulate the transient spawn rect a drag-out wrote.
    state = run(
      state,
      { type: "dock-panel", toolId: "layers" },
      { type: "restore-float-rect", toolId: "layers", rect: remembered },
    );
    const placement = getPlacement(state.layout, "layers");
    expect(placement.mode).toBe("docked");
    expect(placement.open).toBe(true);
    expect(placement.rect).toEqual(remembered);
    expect(placement.rect).not.toBe(remembered); // defensive copy
  });

  it("null clears the remembered rect (panel had never floated)", () => {
    let state = run(createDefaultWorkspaceState(), {
      type: "float-panel",
      toolId: "layers",
      viewport: VIEWPORT,
      rect: { x: 200, y: 90, width: 360, height: 280 },
    });
    state = run(
      state,
      { type: "dock-panel", toolId: "layers" },
      { type: "restore-float-rect", toolId: "layers", rect: null },
    );
    expect(getPlacement(state.layout, "layers").rect).toBeNull();
  });
});
