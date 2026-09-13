import { expect, test } from "@playwright/test";
import {
  expectMinTarget,
  expectZeroTransitionDurations,
} from "./helpers/a11y";
import { LAYOUT_STORAGE_KEY } from "./helpers/storage";
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  RAIL_ORDER,
  RAIL_TOOL_GROUP,
  TOOL_LABELS,
  activateTool,
  anyFloat,
  artboardCanvas,
  boxOf,
  choosePanelMenuItem,
  chooseWorkspaceMenuItem,
  dock,
  dockSplitter,
  dragBy,
  drawer,
  drawerToggle,
  floatPanel,
  floatResizeHandle,
  floatTool,
  freshSampleProject,
  goHome,
  gotoHome,
  newProjectFromHome,
  openPanelMenu,
  openProjectCardMenu,
  openSampleProject,
  openWorkspaceMenu,
  panel,
  panelTitlebar,
  projectCard,
  rail,
  reloadIntoProject,
  railButton,
  railSeparator,
  readCyanAngle,
  saveProjectAs,
  setCyanAngle,
  sizeGate,
  topbar,
  workspaceMenuItem,
  type WorkstationToolId,
} from "./helpers/workstation";

test.describe("workspace shell — rail", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("rail lists all eight tools in contract order with a separator before the system group", async ({
    page,
  }) => {
    const sequence = await rail(page)
      .locator('button, [data-testid="ws-rail-separator"]')
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.tagName === "BUTTON"
            ? element.getAttribute("aria-label")
            : "--separator--",
        ),
      );
    expect(sequence).toEqual([
      ...RAIL_TOOL_GROUP.map((tool) => TOOL_LABELS[tool]),
      "--separator--",
      TOOL_LABELS.history,
      TOOL_LABELS.export,
    ]);
    await expect(railSeparator(page)).toHaveAttribute("role", "separator");
  });

  test("every rail button meets the 40px target floor", async ({ page }) => {
    for (const tool of RAIL_ORDER) {
      await expectMinTarget(railButton(page, tool), 40);
    }
  });

  test("rail is one roving tab stop with Arrow/Home/End navigation", async ({
    page,
  }) => {
    // Exactly one rail button is in the tab order.
    const tabbable = rail(page).locator('button[tabindex="0"]');
    await expect(tabbable).toHaveCount(1);

    await tabbable.focus();
    await page.keyboard.press("ArrowDown");
    const focusedAfterArrow = await rail(page)
      .locator("button:focus")
      .getAttribute("aria-label");
    expect(focusedAfterArrow).not.toBeNull();

    await page.keyboard.press("Home");
    await expect(railButton(page, RAIL_ORDER[0])).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      railButton(page, RAIL_ORDER[RAIL_ORDER.length - 1]),
    ).toBeFocused();
    // ArrowUp from the first wraps or stays put but never leaves the rail.
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(rail(page).locator("button:focus")).toHaveCount(1);
    // Tab from inside the rail exits it — roving tabindex, one stop.
    await page.keyboard.press("Tab");
    await expect(rail(page).locator("button:focus")).toHaveCount(0);
  });

  test("Enter and Space activate the focused rail tool", async ({ page }) => {
    await railButton(page, "select").focus();
    await page.keyboard.press("ArrowDown"); // -> Layers
    await page.keyboard.press("ArrowDown"); // -> Halftone
    await expect(railButton(page, "halftone")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(railButton(page, "halftone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(panel(page, "halftone")).toBeVisible();

    await railButton(page, "halftone").focus();
    await page.keyboard.press("ArrowDown"); // -> Diffusion
    await page.keyboard.press("Space");
    await expect(railButton(page, "diffusion")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(panel(page, "diffusion")).toBeVisible();
  });

  test("activating a nonfloating tool shows its sole panel in the dock and hides the previous one", async ({
    page,
  }) => {
    const cycle: WorkstationToolId[] = ["layers", "halftone", "plates", "history"];
    for (const tool of cycle) {
      await activateTool(page, tool);
      await expect(dock(page).getByTestId(`ws-panel-${tool}`)).toBeVisible();
      // One panel instance per tool, and only one panel in the dock.
      await expect(panel(page, tool)).toHaveCount(1);
      for (const other of cycle.filter((candidate) => candidate !== tool)) {
        await expect(panel(page, other)).toBeHidden();
      }
    }
  });
});

test.describe("workspace shell — new project defaults", () => {
  test("Select/Transform active, Layers docked, Document expanded, no floats", async ({
    page,
  }) => {
    await gotoHome(page);
    await newProjectFromHome(page);

    await expect(railButton(page, "select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(dock(page).getByTestId("ws-panel-layers")).toBeVisible();
    await expect(drawerToggle(page, "document")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(anyFloat(page)).toHaveCount(0);
  });
});

test.describe("workspace shell — floats", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("Float via titlebar menu detaches the panel; the float can be dragged by its titlebar", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    const before = await boxOf(floatPanel(page, "halftone"));

    await dragBy(page, panelTitlebar(page, "halftone"), 120, 60);
    const after = await boxOf(floatPanel(page, "halftone"));
    expect(Math.abs(after.x - before.x - 120)).toBeLessThanOrEqual(8);
    expect(Math.abs(after.y - before.y - 60)).toBeLessThanOrEqual(8);
  });

  test("Escape during a titlebar mouse drag cancels the move", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    const before = await boxOf(floatPanel(page, "halftone"));

    const titlebar = await boxOf(panelTitlebar(page, "halftone"));
    const startX = titlebar.x + titlebar.width / 2;
    const startY = titlebar.y + titlebar.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 90, startY + 90);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    const after = await boxOf(floatPanel(page, "halftone"));
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  test("keyboard Move: arrows move the float, Enter commits, Escape cancels", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    const before = await boxOf(floatPanel(page, "halftone"));

    await choosePanelMenuItem(page, "halftone", "Move");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const committed = await boxOf(floatPanel(page, "halftone"));
    expect(committed.x).toBeGreaterThan(before.x);
    expect(committed.y).toBeGreaterThan(before.y);

    await choosePanelMenuItem(page, "halftone", "Move");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    const cancelled = await boxOf(floatPanel(page, "halftone"));
    expect(cancelled.x).toBeCloseTo(committed.x, 0);
    expect(cancelled.y).toBeCloseTo(committed.y, 0);
  });

  test("keyboard Resize: arrows resize, Escape cancels, and the 320x240 minimum holds", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    const before = await boxOf(floatPanel(page, "halftone"));

    await choosePanelMenuItem(page, "halftone", "Resize");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const grown = await boxOf(floatPanel(page, "halftone"));
    expect(grown.width).toBeGreaterThan(before.width);
    expect(grown.height).toBeGreaterThan(before.height);

    await choosePanelMenuItem(page, "halftone", "Resize");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    const cancelled = await boxOf(floatPanel(page, "halftone"));
    expect(cancelled.width).toBeCloseTo(grown.width, 0);

    // Mouse-resize far past the minimum; the float clamps at 320x240.
    await dragBy(page, floatResizeHandle(page, "halftone"), -900, -900);
    const clamped = await boxOf(floatPanel(page, "halftone"));
    expect(clamped.width).toBeGreaterThanOrEqual(FLOAT_MIN_WIDTH - 0.5);
    expect(clamped.height).toBeGreaterThanOrEqual(FLOAT_MIN_HEIGHT - 0.5);
  });

  test("floats raise on focus and interacting with a panel activates its tool", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    await floatTool(page, "diffusion");
    // Overlap them.
    await dragBy(page, panelTitlebar(page, "diffusion"), -40, -40);

    const zIndexOf = (tool: WorkstationToolId) =>
      floatPanel(page, tool).evaluate(
        (element) => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0,
      );

    await panelTitlebar(page, "halftone").click();
    expect(await zIndexOf("halftone")).toBeGreaterThan(await zIndexOf("diffusion"));
    await expect(railButton(page, "halftone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await panelTitlebar(page, "diffusion").click();
    expect(await zIndexOf("diffusion")).toBeGreaterThan(await zIndexOf("halftone"));
    await expect(railButton(page, "diffusion")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("selecting a floated tool raises its float while the dock panel stays visible", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    await activateTool(page, "layers");
    await expect(dock(page).getByTestId("ws-panel-layers")).toBeVisible();
    await expect(floatPanel(page, "halftone")).toBeVisible();

    await activateTool(page, "halftone");
    // Still floating — activation raises, it does not re-dock.
    await expect(floatPanel(page, "halftone")).toBeVisible();
    await expect(dock(page).getByTestId("ws-panel-layers")).toBeVisible();
  });

  test("Dock Right hides the displaced dock panel; rail activation restores it", async ({
    page,
  }) => {
    await activateTool(page, "layers");
    await floatTool(page, "halftone");
    await choosePanelMenuItem(page, "halftone", "Dock Right");

    await expect(dock(page).getByTestId("ws-panel-halftone")).toBeVisible();
    await expect(panel(page, "layers")).toBeHidden();

    await activateTool(page, "layers");
    await expect(dock(page).getByTestId("ws-panel-layers")).toBeVisible();
    await expect(panel(page, "halftone")).toBeHidden();
  });

  test("Close remembers float placement and rail activation restores it", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    await dragBy(page, panelTitlebar(page, "halftone"), 90, 40);
    const before = await boxOf(floatPanel(page, "halftone"));

    await choosePanelMenuItem(page, "halftone", "Close");
    await expect(floatPanel(page, "halftone")).toBeHidden();

    await railButton(page, "halftone").click();
    await expect(floatPanel(page, "halftone")).toBeVisible();
    const restored = await boxOf(floatPanel(page, "halftone"));
    expect(Math.abs(restored.x - before.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.y - before.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.width - before.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.height - before.height)).toBeLessThanOrEqual(2);
  });

  test("floats clamp back on-screen after the viewport shrinks", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    // Push the float toward the bottom-right corner.
    await dragBy(page, panelTitlebar(page, "halftone"), 900, 700);
    await page.setViewportSize({ width: 1296, height: 816 });

    // setViewportSize acknowledges the browser viewport before React's resize
    // handler necessarily commits its clamped layout. Await that visible state.
    await expect(async () => {
      const titlebar = await boxOf(panelTitlebar(page, "halftone"));
      expect(titlebar.y).toBeGreaterThanOrEqual(0);
      expect(titlebar.y + titlebar.height).toBeLessThanOrEqual(816);
      const visibleWidth =
        Math.min(titlebar.x + titlebar.width, 1296) - Math.max(titlebar.x, 0);
      expect(visibleWidth).toBeGreaterThanOrEqual(120);
    }).toPass({ timeout: 2000 });
  });
});

test.describe("workspace shell — lock, reset, persistence", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("Lock Layout blocks move/resize/dock but allows open, close, focus, and tool selection", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    const before = await boxOf(floatPanel(page, "halftone"));
    await chooseWorkspaceMenuItem(page, "Lock Layout");

    // Structural menu commands are disabled but announced.
    const menu = await openPanelMenu(page, "halftone");
    for (const item of ["Float", "Dock Right", "Reset Position", "Move", "Resize"]) {
      await expect(
        menu.getByRole("menuitem", { name: item, exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
    }
    await expect(
      menu.getByRole("menuitem", { name: "Close", exact: true }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // Titlebar drag is inert.
    await dragBy(page, panelTitlebar(page, "halftone"), 80, 80);
    const after = await boxOf(floatPanel(page, "halftone"));
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);

    // Splitter is inert.
    await expect(dockSplitter(page)).toHaveAttribute("aria-disabled", "true");
    const width = await dockSplitter(page).getAttribute("aria-valuenow");
    await dockSplitter(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(dockSplitter(page)).toHaveAttribute("aria-valuenow", width!);

    // Open/close/focus/tool selection still work.
    await activateTool(page, "diffusion");
    await expect(dock(page).getByTestId("ws-panel-diffusion")).toBeVisible();
    await choosePanelMenuItem(page, "halftone", "Close");
    await expect(floatPanel(page, "halftone")).toBeHidden();
    await railButton(page, "halftone").click();
    await expect(floatPanel(page, "halftone")).toBeVisible();

    // Unlock restores dragging.
    await chooseWorkspaceMenuItem(page, "Lock Layout");
    await dragBy(page, panelTitlebar(page, "halftone"), 80, 40);
    const unlocked = await boxOf(floatPanel(page, "halftone"));
    expect(unlocked.x).not.toBeCloseTo(before.x, 0);
  });

  test("Reset Layout restores defaults, unlocks, and never touches canvas state", async ({
    page,
  }) => {
    await setCyanAngle(page, "33");
    await floatTool(page, "halftone");
    await dockSplitter(page).focus();
    await page.keyboard.press("End");
    await expect(dockSplitter(page)).toHaveAttribute(
      "aria-valuenow",
      String(DOCK_MAX_WIDTH),
    );
    await chooseWorkspaceMenuItem(page, "Lock Layout");

    await chooseWorkspaceMenuItem(page, "Reset Layout");

    await expect(anyFloat(page)).toHaveCount(0);
    await expect(dockSplitter(page)).toHaveAttribute(
      "aria-valuenow",
      String(DOCK_DEFAULT_WIDTH),
    );
    // The active tool (halftone, from floating it) is docked.
    await expect(dock(page).getByTestId("ws-panel-halftone")).toBeVisible();
    // Layout is unlocked again.
    const menu = await openWorkspaceMenu(page);
    await expect(workspaceMenuItem(menu, "Lock Layout")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.keyboard.press("Escape");
    // Document state is untouched.
    expect(await readCyanAngle(page)).toBe("33");
  });

  test("layout persists across reload: float placement and dock width survive", async ({
    page,
  }) => {
    await saveProjectAs(page, "Layout Persist");
    await floatTool(page, "halftone");
    await dragBy(page, panelTitlebar(page, "halftone"), 100, 50);
    const before = await boxOf(floatPanel(page, "halftone"));
    await dockSplitter(page).focus();
    await page.keyboard.press("End");

    await reloadIntoProject(page, "Layout Persist");

    await expect(floatPanel(page, "halftone")).toBeVisible();
    const restored = await boxOf(floatPanel(page, "halftone"));
    expect(Math.abs(restored.x - before.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.y - before.y)).toBeLessThanOrEqual(2);
    await expect(dockSplitter(page)).toHaveAttribute(
      "aria-valuenow",
      String(DOCK_MAX_WIDTH),
    );
  });

  test("corrupt persisted layout falls back to the default arrangement without crashing", async ({
    page,
  }) => {
    await saveProjectAs(page, "Corrupt Layout");
    await floatTool(page, "halftone");
    await page.evaluate(
      (key) => localStorage.setItem(key, '{"schema":999,"dockWidth":'),
      LAYOUT_STORAGE_KEY,
    );

    await reloadIntoProject(page, "Corrupt Layout");

    await expect(anyFloat(page)).toHaveCount(0);
    await expect(rail(page)).toBeVisible();
    await expect(dockSplitter(page)).toHaveAttribute(
      "aria-valuenow",
      String(DOCK_DEFAULT_WIDTH),
    );
  });
});

test.describe("workspace shell — focus mode", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("Focus Mode hides rail, dock, and floats, keeps the topbar, and restores the exact arrangement", async ({
    page,
  }) => {
    await floatTool(page, "diffusion");
    const floatBefore = await boxOf(floatPanel(page, "diffusion"));
    await activateTool(page, "layers");
    await drawerToggle(page, "proof").click();
    await expect(drawerToggle(page, "proof")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await chooseWorkspaceMenuItem(page, "Focus Mode");
    await expect(rail(page)).toBeHidden();
    await expect(dock(page)).toBeHidden();
    await expect(floatPanel(page, "diffusion")).toBeHidden();
    await expect(topbar(page)).toBeVisible();
    await expect(artboardCanvas(page)).toBeVisible();

    await chooseWorkspaceMenuItem(page, "Focus Mode");
    await expect(rail(page)).toBeVisible();
    await expect(dock(page).getByTestId("ws-panel-layers")).toBeVisible();
    await expect(floatPanel(page, "diffusion")).toBeVisible();
    const floatAfter = await boxOf(floatPanel(page, "diffusion"));
    expect(Math.abs(floatAfter.x - floatBefore.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(floatAfter.y - floatBefore.y)).toBeLessThanOrEqual(2);
    await expect(drawerToggle(page, "proof")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

test.describe("workspace shell — drawers", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("at most one drawer is expanded at a time", async ({ page }) => {
    // New/sample project default: Document expanded.
    await expect(drawerToggle(page, "document")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await drawerToggle(page, "proof").click();
    await expect(drawerToggle(page, "proof")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(drawerToggle(page, "document")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(drawer(page, "proof")).toBeVisible();
    await expect(drawer(page, "document")).toBeHidden();

    await drawerToggle(page, "output").click();
    await expect(drawerToggle(page, "output")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(drawerToggle(page, "proof")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Collapsing the expanded drawer leaves none expanded.
    await drawerToggle(page, "output").click();
    for (const id of ["document", "proof", "output"] as const) {
      await expect(drawerToggle(page, id)).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
  });
});

test.describe("workspace shell — dock splitter", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("splitter exposes range semantics and keyboard resize clamped to 320-520", async ({
    page,
  }) => {
    const splitter = dockSplitter(page);
    await expect(splitter).toHaveAttribute("role", "separator");
    await expect(splitter).toHaveAttribute("aria-valuemin", String(DOCK_MIN_WIDTH));
    await expect(splitter).toHaveAttribute("aria-valuemax", String(DOCK_MAX_WIDTH));
    await expect(splitter).toHaveAttribute(
      "aria-valuenow",
      String(DOCK_DEFAULT_WIDTH),
    );

    await splitter.focus();
    await page.keyboard.press("ArrowLeft"); // dock sits at the right: left = wider
    const widened = Number(await splitter.getAttribute("aria-valuenow"));
    expect(widened).toBeGreaterThan(DOCK_DEFAULT_WIDTH);
    await page.keyboard.press("ArrowRight");
    await expect(splitter).toHaveAttribute(
      "aria-valuenow",
      String(DOCK_DEFAULT_WIDTH),
    );

    await page.keyboard.press("End");
    await expect(splitter).toHaveAttribute("aria-valuenow", String(DOCK_MAX_WIDTH));
    await page.keyboard.press("Home");
    await expect(splitter).toHaveAttribute("aria-valuenow", String(DOCK_MIN_WIDTH));

    // The rendered dock tracks aria-valuenow.
    const dockBox = await boxOf(dock(page));
    expect(Math.abs(dockBox.width - DOCK_MIN_WIDTH)).toBeLessThanOrEqual(2);
  });

  test("pointer drag resizes the dock and clamps at both ends", async ({
    page,
  }) => {
    const splitter = dockSplitter(page);
    await dragBy(page, splitter, -600, 0);
    await expect(splitter).toHaveAttribute("aria-valuenow", String(DOCK_MAX_WIDTH));

    await dragBy(page, splitter, 600, 0);
    await expect(splitter).toHaveAttribute("aria-valuenow", String(DOCK_MIN_WIDTH));
  });
});

test.describe("workspace shell — size gate", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("below 1280x800 only the editor is replaced; state survives restore", async ({
    page,
  }) => {
    await setCyanAngle(page, "33");
    await activateTool(page, "glitch");

    await page.setViewportSize({ width: 1200, height: 760 });
    await expect(sizeGate(page)).toBeVisible();
    await expect(sizeGate(page)).toContainText("1280");
    await expect(sizeGate(page)).toContainText("800");
    await expect(artboardCanvas(page)).toBeHidden();
    // The topbar (project identity, Save) is preserved — only the editor is replaced.
    await expect(topbar(page)).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(sizeGate(page)).toBeHidden();
    await expect(artboardCanvas(page)).toBeVisible();
    await expect(railButton(page, "glitch")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await readCyanAngle(page)).toBe("33");
  });
});

test.describe("workspace shell — reduced motion", () => {
  test("workspace chrome suppresses transitions and stays fully operable under prefers-reduced-motion", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await page.emulateMedia({ reducedMotion: "reduce" });

    await floatTool(page, "halftone");
    await expectZeroTransitionDurations(floatPanel(page, "halftone"));
    await expectZeroTransitionDurations(dock(page));

    await drawerToggle(page, "proof").click();
    await expect(drawer(page, "proof")).toBeVisible();
    await expectZeroTransitionDurations(drawer(page, "proof"));

    // Dock/undock still function without transition-dependent timing.
    await choosePanelMenuItem(page, "halftone", "Dock Right");
    await expect(dock(page).getByTestId("ws-panel-halftone")).toBeVisible();
  });
});

test.describe("workspace shell — home surface entry", () => {
  test("clean storage lands on home with Recent, New, Open, Sample, and Trash", async ({
    page,
  }) => {
    await gotoHome(page);
    await expect(
      page.getByRole("region", { name: "Recent projects" }),
    ).toBeVisible();
    for (const name of ["New Project", "Open Project File", "Open Sample", "Trash"]) {
      await expect(
        page.getByTestId("ws-home").getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
  });

  test("project cards expose Open plus a Project actions menu", async ({
    page,
  }) => {
    await gotoHome(page);
    await openSampleProject(page);
    await saveProjectAs(page, "Card Contract");
    await goHome(page);

    const card = projectCard(page, "Card Contract");
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
    const menu = await openProjectCardMenu(page, "Card Contract");
    for (const item of ["Rename", "Duplicate", "Export Project", "Move to Trash"]) {
      await expect(
        menu.getByRole("menuitem", { name: item, exact: true }),
      ).toBeVisible();
    }
    await page.keyboard.press("Escape");
  });
});
