import { expect, test } from "@playwright/test";
import {
  activateTool,
  boxOf,
  dock,
  drawer,
  ensureDrawerExpanded,
  floatPanel,
  freshSampleProject,
  goHome,
  gotoHome,
  homeSurface,
  openProjectCardMenu,
  openSampleProject,
  openWorkspaceMenu,
  panel,
  panelTitlebar,
  projectTitle,
  railButton,
  readCyanAngle,
  saveProjectAs,
  setCyanAngle,
  topbarButton,
  reloadIntoProject,
} from "./helpers/workstation";

/**
 * Release-requirement coverage added 2026-09-12: WCAG 2.1.4 character-key
 * shortcut switch, modal shortcut suppression, true dialog modality with
 * deterministic focus restoration, wired Help content, shortcut focus
 * recovery, Photoshop-grade drag docking, narrow-topbar survival, and the
 * home surface landmark/menu/disclosure patterns. Additions only — nothing
 * here weakens an existing contract assertion.
 */

const disableShortcutsItem = (menu: import("@playwright/test").Locator) =>
  menu.getByRole("menuitemcheckbox", { name: /Disable single-key shortcuts/ });

test.describe("shortcut modality — WCAG 2.1.4 switch", () => {
  test("single-key shortcuts can be turned off, persist across reload, and modifier combos survive", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await saveProjectAs(page, "Shortcut Prefs");

    // Baseline: the character key works while enabled.
    await page.locator("body").press("h");
    await expect(railButton(page, "halftone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Turn the switch on (menuitemcheckbox in the Workspace menu).
    let menu = await openWorkspaceMenu(page);
    await expect(disableShortcutsItem(menu)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await disableShortcutsItem(menu).click();

    // Character keys are now inert…
    await page.locator("body").press("d");
    await expect(railButton(page, "diffusion")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(railButton(page, "halftone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // …but modifier combos still work: an undoable edit reverts on Ctrl+Z.
    const before = await readCyanAngle(page);
    await setCyanAngle(page, "33");
    await page.locator("body").press("Control+z");
    expect(await readCyanAngle(page)).toBe(before);

    // The preference persists across reload.
    await reloadIntoProject(page, "Shortcut Prefs");
    await page.locator("body").press("g");
    await expect(railButton(page, "glitch")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    menu = await openWorkspaceMenu(page);
    await expect(disableShortcutsItem(menu)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
  });
});

test.describe("shortcut modality — modal suppression", () => {
  test("workstation shortcuts are inert while a modal dialog is open", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "31");
    await topbarButton(page, "New").click();
    const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
    await expect(dialog).toBeVisible();

    // A tool key must not switch tools behind the scrim.
    await page.keyboard.press("h");
    await expect(dialog).toBeVisible();
    await expect(railButton(page, "halftone")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // After close + focus restore the same key works again.
    await page.locator("body").press("h");
    await expect(railButton(page, "halftone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("true modality", () => {
  test("dialogs inert the background, trap Tab, block pointers, and restore focus on every path", async ({
    page,
  }) => {
    await freshSampleProject(page);
    const saveButton = topbarButton(page, "Save");
    await saveButton.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Save Project" });
    await expect(dialog).toBeVisible();

    // Background is inert while the modal is up.
    await expect(page.locator("#root")).toHaveAttribute("inert", "");

    // Tab cycles inside the dialog only.
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    }

    // The scrim intercepts pointer events aimed at the background.
    const railBox = await boxOf(railButton(page, "select"));
    const intercepted = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && hit.closest(".ws-dialog-scrim"));
      },
      {
        x: railBox.x + railBox.width / 2,
        y: railBox.y + railBox.height / 2,
      },
    );
    expect(intercepted).toBe(true);

    // Escape restores focus to the exact opener.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
    await expect(saveButton).toBeFocused();
  });

  test("rename via the project title returns focus to the title on cancel AND on submit", async ({
    page,
  }) => {
    await freshSampleProject(page);
    const title = projectTitle(page);

    // Keyboard activation (Enter) — cancel path.
    await title.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Rename Project" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(title).toBeFocused();

    // Submit path.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Project name" }).fill("Renamed Proj");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(title).toHaveText("Renamed Proj");
    await expect(title).toBeFocused();
  });
});

test.describe("help", () => {
  test("? opens searchable Help with substantive topics; Escape lands on the Help button, never body", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await page.locator("body").press("?");
    const help = page.getByTestId("help-dialog");
    await expect(help).toBeVisible();

    for (const [query, excerpt] of [
      ["Floyd-Steinberg", /Floyd-Steinberg is the classic/],
      ["macroblock", /macroblock/i],
    ] as const) {
      await help.locator('input[type="search"]').fill(query);
      const topics = help.getByTestId("help-topic");
      await expect(topics.first()).toBeVisible();
      // The best match opens so the answer is immediately readable.
      await expect(topics.first()).toHaveAttribute("open", "");
      await expect(topics.first()).toContainText(excerpt);
    }

    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    // Shortcut-opened Help has no focused invoker: focus must land on the
    // topbar Help button, never <body>.
    await expect(topbarButton(page, "Help")).toBeFocused();
  });

  test("button-opened Help restores focus to the Help button on Escape", async ({
    page,
  }) => {
    await freshSampleProject(page);
    const helpButton = topbarButton(page, "Help");
    await helpButton.click();
    await expect(page.getByTestId("help-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-dialog")).toBeHidden();
    await expect(helpButton).toBeFocused();
  });
});

test.describe("shortcut focus recovery", () => {
  test("a tool shortcut that unmounts the focused control moves focus to the activated rail tool", async ({
    page,
  }) => {
    await freshSampleProject(page);
    // Focus a Layers-ONLY control, then switch tools by shortcut — the
    // control unmounts with the panel. (The generic "Panel menu" button DOM
    // is meaningfully reused across docked tool swaps, so focusing it would
    // not exercise the unmount path.)
    await panel(page, "layers")
      .getByRole("button", { name: "Duplicate Layer" })
      .focus();
    await page.keyboard.press("h");
    await expect(panel(page, "halftone")).toBeVisible();
    await expect(railButton(page, "halftone")).toBeFocused();
  });

  test("Focus Mode via shortcut never strands focus on body", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await railButton(page, "select").focus();
    await page.keyboard.press("f");
    await expect(railButton(page, "select")).toBeHidden();
    const strandedOnBody = await page.evaluate(
      () => document.activeElement === document.body,
    );
    expect(strandedOnBody).toBe(false);
    await page.keyboard.press("f");
    await expect(railButton(page, "select")).toBeVisible();
  });
});

test.describe("drag docking", () => {
  test("dragging a docked titlebar undocks the panel at the pointer; dropping a float on the dock re-docks it", async ({
    page,
  }) => {
    await freshSampleProject(page);
    const titlebar = await boxOf(panelTitlebar(page, "layers"));

    // Drag out of the dock.
    await page.mouse.move(
      titlebar.x + titlebar.width / 2,
      titlebar.y + titlebar.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(500, 400, { steps: 8 });
    await expect(floatPanel(page, "layers")).toBeVisible();
    await expect(page.getByTestId("dock-empty")).toBeVisible();
    await page.mouse.move(480, 380, { steps: 2 });
    await page.mouse.up();
    await expect(floatPanel(page, "layers")).toBeVisible();

    // Drag the float over the dock: the drop target lights up, release docks.
    const dockBox = await boxOf(dock(page));
    const floatBar = await boxOf(panelTitlebar(page, "layers"));
    await page.mouse.move(
      floatBar.x + floatBar.width / 2,
      floatBar.y + floatBar.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dockBox.x + dockBox.width / 2,
      dockBox.y + dockBox.height / 2,
      { steps: 10 },
    );
    await expect(dock(page)).toHaveAttribute("data-drop-active", "true");
    await page.mouse.up();
    await expect(dock(page).getByTestId("ws-panel-layers")).toBeVisible();
    await expect(floatPanel(page, "layers")).toHaveCount(0);
  });

  test("Escape cancels a drag-out mid-flight and re-docks the panel", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await activateTool(page, "halftone");
    const titlebar = await boxOf(panelTitlebar(page, "halftone"));

    await page.mouse.move(
      titlebar.x + titlebar.width / 2,
      titlebar.y + titlebar.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(420, 420, { steps: 6 });
    await expect(floatPanel(page, "halftone")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(floatPanel(page, "halftone")).toBeHidden();
    await expect(dock(page).getByTestId("ws-panel-halftone")).toBeVisible();
    await page.mouse.up();
  });
});

test.describe("narrow topbar", () => {
  test("every topbar command stays in bounds and clickable at the 1280x800 floor", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    const names = [
      "Home",
      "New",
      "Open",
      "Save",
      "Undo",
      "Redo",
      "Export",
      "Help",
      "Workspace",
    ];
    for (const name of names) {
      const button = topbarButton(page, name);
      await expect(button).toBeVisible();
      const box = await boxOf(button);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1280);
    }
    // The rename affordance survives too (may truncate, never clip away).
    await expect(projectTitle(page)).toBeVisible();
  });
});

test.describe("home surface", () => {
  test("home is a scrollable main landmark; Trash is a disclosure", async ({
    page,
  }) => {
    await gotoHome(page);
    await expect(page.getByRole("main")).toBeVisible();

    const overflowY = await homeSurface(page).evaluate(
      (element) => getComputedStyle(element).overflowY,
    );
    expect(overflowY).toBe("auto");

    const trashButton = homeSurface(page).getByRole("button", {
      name: "Trash",
      exact: true,
    });
    await expect(trashButton).toHaveAttribute("aria-expanded", "false");
    await trashButton.click();
    await expect(trashButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("ws-trash")).toBeVisible();
  });

  test("project-card menu follows the full menu pattern", async ({ page }) => {
    await gotoHome(page);
    await openSampleProject(page);
    await saveProjectAs(page, "Menu Pattern");
    await goHome(page);

    const menu = await openProjectCardMenu(page, "Menu Pattern");
    // Opening moves focus to the first item.
    await expect(
      menu.getByRole("menuitem", { name: "Rename", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      menu.getByRole("menuitem", { name: "Duplicate", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      menu.getByRole("menuitem", { name: "Move to Trash", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Home");
    await expect(
      menu.getByRole("menuitem", { name: "Rename", exact: true }),
    ).toBeFocused();
    // Escape closes and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Project actions" }),
    ).toBeFocused();
  });
});

test.describe("inline field errors", () => {
  test("custom-size errors associate with their fields via aria-invalid + aria-describedby", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await ensureDrawerExpanded(page, "document");
    await expect(drawer(page, "document")).toBeVisible();

    const width = page.getByTestId("artboard-custom-width");
    await width.fill("abc");
    await page.getByTestId("artboard-custom-apply").click();

    await expect(page.getByTestId("artboard-custom-error")).toBeVisible();
    await expect(width).toHaveAttribute("aria-invalid", "true");
    await expect(width).toHaveAttribute(
      "aria-describedby",
      "artboard-custom-error",
    );
  });
});
