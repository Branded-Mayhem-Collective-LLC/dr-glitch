import { expect, test } from "@playwright/test";

test.describe("ink rail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("renders four plate chips plus composite", async ({ page }) => {
    await expect(page.getByTestId("ink-chip-cyan")).toBeVisible();
    await expect(page.getByTestId("ink-chip-magenta")).toBeVisible();
    await expect(page.getByTestId("ink-chip-yellow")).toBeVisible();
    await expect(page.getByTestId("ink-chip-black")).toBeVisible();
    await expect(page.getByTestId("ink-chip-composite")).toBeVisible();
  });

  test("plate identity is never carried by hue alone", async ({ page }) => {
    // §9: every chip pairs its ink with its letter AND its angle value.
    for (const [plate, letter, angle] of [
      ["cyan", "C", "15"],
      ["magenta", "M", "75"],
      ["yellow", "Y", "0"],
      ["black", "K", "45"],
    ]) {
      const chip = page.getByTestId(`ink-chip-${plate}`);
      await expect(chip).toContainText(letter);
      await expect(chip).toContainText(angle);
    }
  });

  test("clicking a chip solos that plate", async ({ page }) => {
    await page.getByTestId("ink-chip-magenta").click();
    await expect(page.getByTestId("ink-chip-magenta")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("active-plate-label")).toContainText(/magenta/i);
  });

  test("modifier-click toggles visibility without soloing", async ({ page }) => {
    await page.getByTestId("ink-chip-composite").click();
    const cyan = page.getByTestId("ink-chip-cyan");
    await cyan.click({ modifiers: ["Alt"] });
    await expect(cyan).toHaveAttribute("data-visible", "false");
    // Solo did not change: composite is still the active view.
    await expect(page.getByTestId("active-plate-label")).toContainText(/composite/i);
  });

  test("chips meet the 32px hit-target floor", async ({ page }) => {
    const box = await page.getByTestId("ink-chip-cyan").boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(32);
    expect(box!.height).toBeGreaterThanOrEqual(32);
  });
});

test.describe("ink rail — keyboard and screen-reader parity", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  // The rail is now the ONLY way to change plates (.plate-tabs removed) —
  // it must be fully operable without a mouse, with a visible focus
  // indicator on every chip including composite.
  test("every chip is keyboard-reachable via Tab with a visible focus indicator", async ({
    page,
  }) => {
    const order = ["composite", "cyan", "magenta", "yellow", "black"];
    await page.getByTestId(`ink-chip-${order[0]}`).focus();

    for (const [index, plate] of order.entries()) {
      const chip = page.getByTestId(`ink-chip-${plate}`);
      await expect(chip).toBeFocused();

      const outline = await chip.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      expect(outline.style).not.toBe("none");
      expect(outline.width).toBeGreaterThan(0);

      if (index < order.length - 1) await page.keyboard.press("Tab");
    }
  });

  // Empirically verified (not assumed): Chromium fires a click with
  // altKey=true for a keyboard-activated button on Alt+Space, but NOT on
  // Alt+Enter — holding Alt suppresses the browser's default
  // Enter-activates-button behavior outright (confirmed via a live click
  // listener: no click event fires at all for Alt+Enter). So Alt+Space is
  // the real, documented keyboard path, and this test exercises that path,
  // not the one that silently doesn't work.
  test("keyboard Enter solos a chip; Alt+Space toggles its visibility without soloing", async ({
    page,
  }) => {
    const magenta = page.getByTestId("ink-chip-magenta");
    await magenta.focus();
    await page.keyboard.press("Enter");
    await expect(magenta).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("active-plate-label")).toContainText(/magenta/i);

    await page.keyboard.down("Alt");
    await page.keyboard.press(" ");
    await page.keyboard.up("Alt");
    await expect(magenta).toHaveAttribute("data-visible", "false");
    // Alt+Space toggled visibility only — the solo did not change.
    await expect(magenta).toHaveAttribute("aria-pressed", "true");
  });

  test("accessible name states plate identity and hidden/visible state, not just a hover title", async ({
    page,
  }) => {
    const cyan = page.getByTestId("ink-chip-cyan");
    await expect(cyan).toHaveAttribute("aria-label", /cyan/i);
    await expect(cyan).toHaveAttribute("aria-label", /visible/i);

    await cyan.click({ modifiers: ["Alt"] });
    await expect(cyan).toHaveAttribute("data-visible", "false");
    await expect(cyan).toHaveAttribute("aria-label", /hidden/i);
  });
});

test.describe("composite proof label — hidden-plate coherence", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  // §1: "a print tool that misleads the eye about ink is broken." A blank
  // composite proof must say why, not just "Composite proof".
  test("names which plates are hidden while viewing composite, and says so plainly when all are hidden", async ({
    page,
  }) => {
    await page.getByTestId("ink-chip-composite").click();
    const label = page.getByTestId("artboard-label");
    await expect(label).toContainText(/composite proof/i);
    await expect(label).not.toContainText(/hidden/i);

    await page.getByTestId("ink-chip-cyan").click({ modifiers: ["Alt"] });
    await expect(label).toContainText("C hidden");

    await page.getByTestId("ink-chip-magenta").click({ modifiers: ["Alt"] });
    await page.getByTestId("ink-chip-yellow").click({ modifiers: ["Alt"] });
    await page.getByTestId("ink-chip-black").click({ modifiers: ["Alt"] });
    await expect(label).toContainText(/all plates hidden/i);
  });
});
