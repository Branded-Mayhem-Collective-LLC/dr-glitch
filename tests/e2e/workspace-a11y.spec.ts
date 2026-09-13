import { expect, test } from "@playwright/test";
import { expectVisibleFocus } from "./helpers/a11y";
import {
  RAIL_ORDER,
  TOOL_LABELS,
  activateTool,
  boxOf,
  choosePanelMenuItem,
  dirtyIndicator,
  dockSplitter,
  drawerToggle,
  floatPanel,
  floatTool,
  freshSampleProject,
  panel,
  projectTitle,
  rail,
  railButton,
  setCyanAngle,
  topbar,
  topbarButton,
} from "./helpers/workstation";

const TOPBAR_TAB_ORDER = [
  "Home",
  "New",
  "Open",
  "Save",
  "Undo",
  "Redo",
  "Export",
  "Help",
] as const;

test.describe("workspace accessibility — names and targets", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("every topbar command carries its contract accessible name", async ({
    page,
  }) => {
    for (const name of [...TOPBAR_TAB_ORDER, "Workspace"]) {
      await expect(topbarButton(page, name)).toBeVisible();
    }
  });

  test("every rail tool carries the exact registry label as its accessible name", async ({
    page,
  }) => {
    for (const tool of RAIL_ORDER) {
      await expect(railButton(page, tool)).toHaveAttribute(
        "aria-label",
        TOOL_LABELS[tool],
      );
    }
  });

  test("no control in the topbar or rail is unnamed", async ({ page }) => {
    for (const scope of [topbar(page), rail(page)]) {
      const unnamed = await scope
        .locator("button")
        .evaluateAll((buttons) =>
          buttons
            .filter(
              (button) =>
                !(
                  button.getAttribute("aria-label")?.trim() ||
                  button.getAttribute("aria-labelledby") ||
                  button.textContent?.trim()
                ),
            )
            .map((button) => button.outerHTML.slice(0, 120)),
        );
      expect(unnamed).toEqual([]);
    }
  });

  test("panel titlebars are named after their tool and label the panel region", async ({
    page,
  }) => {
    for (const tool of ["layers", "halftone", "history"] as const) {
      await activateTool(page, tool);
      await expect(panel(page, tool)).toHaveAccessibleName(TOOL_LABELS[tool]);
    }
  });
});

test.describe("workspace accessibility — keyboard-only operation", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("topbar commands tab in visual order with a visible focus indicator", async ({
    page,
  }) => {
    // Undo/Redo stay in the tab order via aria-disabled (not disabled),
    // so the walk below is stable on a fresh project. The clickable project
    // name (the keyboard rename affordance, ws-project-title) sits between
    // Home and New in the visual order and is a real tab stop.
    const stops = [
      topbarButton(page, "Home"),
      projectTitle(page),
      ...TOPBAR_TAB_ORDER.slice(1).map((name) => topbarButton(page, name)),
    ];
    await stops[0].focus();
    for (const [index, stop] of stops.entries()) {
      await expectVisibleFocus(stop);
      if (index < stops.length - 1) {
        await page.keyboard.press("Tab");
      }
    }
  });

  test("rail, splitter, and drawer toggles all show a visible focus indicator", async ({
    page,
  }) => {
    await railButton(page, "select").focus();
    await expectVisibleFocus(railButton(page, "select"));

    await dockSplitter(page).focus();
    await expectVisibleFocus(dockSplitter(page));

    await drawerToggle(page, "proof").focus();
    await expectVisibleFocus(drawerToggle(page, "proof"));
  });

  test("panel menu is fully keyboard operable and restores focus on Escape", async ({
    page,
  }) => {
    await activateTool(page, "halftone");
    const menuButton = panel(page, "halftone").getByRole("button", {
      name: "Panel menu",
    });
    await menuButton.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    // Arrow keys traverse menu items; the traversal stays inside the menu.
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator(":focus")).toHaveCount(1);

    // Escape closes the menu only — the panel survives — and returns focus.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(panel(page, "halftone")).toBeVisible();
    await expect(menuButton).toBeFocused();
  });

  test("floating a panel by keyboard and closing it restores focus to the rail tool", async ({
    page,
  }) => {
    await floatTool(page, "halftone");
    await choosePanelMenuItem(page, "halftone", "Close");
    await expect(floatPanel(page, "halftone")).toBeHidden();
    await expect(railButton(page, "halftone")).toBeFocused();
  });

  test("dialog Escape cancels and returns focus to the invoking control", async ({
    page,
  }) => {
    // Make the project dirty so New raises the unsaved-changes dialog.
    await setCyanAngle(page, "31");
    const newButton = topbarButton(page, "New");
    await newButton.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(newButton).toBeFocused();
    // Cancelling kept the editor and the dirty work.
    await expect(dirtyIndicator(page)).toBeVisible();
  });
});

test.describe("workspace accessibility — state is never color-only", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("active tool state is exposed through aria-pressed on the rail", async ({
    page,
  }) => {
    await activateTool(page, "halftone");
    for (const tool of RAIL_ORDER) {
      await expect(railButton(page, tool)).toHaveAttribute(
        "aria-pressed",
        tool === "halftone" ? "true" : "false",
      );
    }
  });

  test("dirty state is announced with text, not color alone", async ({
    page,
  }) => {
    await setCyanAngle(page, "29");
    await expect(dirtyIndicator(page)).toBeVisible();
    const text = (await dirtyIndicator(page).textContent())?.trim() ?? "";
    const label = await dirtyIndicator(page).getAttribute("aria-label");
    expect(text.length > 0 || (label ?? "").length > 0).toBe(true);
    expect(`${text} ${label ?? ""}`).toMatch(/unsaved|edited|dirty/i);
  });

  test("drawer expansion is exposed through aria-expanded", async ({ page }) => {
    await expect(drawerToggle(page, "document")).toHaveAttribute(
      "aria-expanded",
      /true|false/,
    );
    await drawerToggle(page, "output").click();
    await expect(drawerToggle(page, "output")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("rail buttons expose keyboard focus at the 40px floor without relying on hue", async ({
    page,
  }) => {
    // Focus indication must be an outline (geometry), not only a color swap.
    await railButton(page, "plates").focus();
    await expectVisibleFocus(railButton(page, "plates"));
    const box = await boxOf(railButton(page, "plates"));
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
  });
});


test("keyboard Float and Dock Right keep focus in the newly mounted panel", async ({ page }) => {
  await freshSampleProject(page);
  await activateTool(page, "halftone");
  const menuButton = () => panel(page, "halftone").getByRole("button", { name: "Panel menu" });
  await menuButton().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Float", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(floatPanel(page, "halftone")).toBeVisible();
  await expect(menuButton()).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Dock Right", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(floatPanel(page, "halftone")).toBeHidden();
  await expect(menuButton()).toBeFocused();
});

test("layer selection and visibility have independent keyboard controls", async ({ page }) => {
  await freshSampleProject(page);
  await activateTool(page, "layers");
  const layers = panel(page, "layers");
  await layers.getByRole("button", { name: "Duplicate Layer", exact: true }).click();
  const selects = layers.getByRole("button", { name: /^Select / });
  await expect(selects).toHaveCount(2);
  await selects.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(selects.last()).toBeFocused();
  await expect(selects.last()).toHaveAttribute("aria-current", "true");
  const visible = layers.getByRole("checkbox", { name: /visible$/ }).last();
  await visible.focus();
  await page.keyboard.press("Space");
  await expect(visible).not.toBeChecked();
  await expect(selects.last()).toHaveAttribute("aria-current", "true");
  await expect(layers.getByRole("listbox")).toHaveCount(0);
});
