import { expect, test } from "@playwright/test";

function contrastRatio(foreground: string, background: string) {
  function luminance(color: string) {
    const channels = color
      .match(/\d+(?:\.\d+)?/g)!
      .slice(0, 3)
      .map((channel) => Number(channel) / 255)
      .map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return (
      channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    );
  }

  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

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

      if (plate !== "composite") {
        await page.keyboard.press("Tab");
        const angle = page.getByTestId(`ink-angle-${plate}`);
        await expect(angle).toBeFocused();
        const angleOutline = await angle.evaluate((el) => {
          const s = getComputedStyle(el);
          return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
        });
        expect(angleOutline.style).not.toBe("none");
        expect(angleOutline.width).toBeGreaterThan(0);
      }

      if (index < order.length - 1) await page.keyboard.press("Tab");
    }
  });

  // Empirically verified (not assumed): Chromium never fires a click for
  // Alt+Enter on a focused <button> — holding Alt suppresses the browser's
  // default Enter-activates-button behavior outright (confirmed via a live
  // click listener: keydown/keyup fire, focus is retained, but no click
  // event follows). That only rules out relying on native click synthesis;
  // it doesn't rule out Alt+Enter itself. The component's onKeyDown
  // intercepts it directly and calls onToggleVisible without going through
  // synthesis, which is what this test exercises. Alt+Enter is the
  // PRIMARY documented gesture (symmetric with Alt-click, dodges the
  // Windows Alt+Space/system-menu collision).
  test("keyboard Enter solos a chip; Alt+Enter toggles its visibility without soloing", async ({
    page,
  }) => {
    const magenta = page.getByTestId("ink-chip-magenta");
    await magenta.focus();
    await page.keyboard.press("Enter");
    await expect(magenta).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("active-plate-label")).toContainText(/magenta/i);

    await page.keyboard.down("Alt");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Alt");
    await expect(magenta).toHaveAttribute("data-visible", "false");
    // Alt+Enter toggled visibility only — the solo did not change.
    await expect(magenta).toHaveAttribute("aria-pressed", "true");
  });

  // Alt+Space is kept as an unadvertised secondary path — it already works
  // through the browser's native click synthesis (Chromium carries the
  // held modifier into the keyup-triggered click, no extra code needed),
  // so retaining it costs nothing. Not documented in aria-label, title, or
  // the on-screen hint — Alt+Enter is the one users are told about.
  test("Alt+Space also toggles visibility, as an unadvertised secondary path", async ({
    page,
  }) => {
    const yellow = page.getByTestId("ink-chip-yellow");
    await yellow.focus();
    await page.keyboard.down("Alt");
    await page.keyboard.press(" ");
    await page.keyboard.up("Alt");
    await expect(yellow).toHaveAttribute("data-visible", "false");
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

test.describe("channel tinting", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  async function activeInk(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const root = document.querySelector("[data-studio-root]") as HTMLElement;
      return getComputedStyle(root).getPropertyValue("--ink-active").trim();
    });
  }

  test("active ink follows the soloed plate", async ({ page }) => {
    await page.getByTestId("ink-chip-cyan").click();
    expect((await activeInk(page)).toLowerCase()).toBe("#0093d0");

    await page.getByTestId("ink-chip-magenta").click();
    expect((await activeInk(page)).toLowerCase()).toBe("#e6007e");

    await page.getByTestId("ink-chip-yellow").click();
    expect((await activeInk(page)).toLowerCase()).toBe("#ffe800");
  });

  test("composite carries no single plate hue", async ({ page }) => {
    await page.getByTestId("ink-chip-composite").click();
    // §6.2: composite presents all four as a hairline stripe, not one hue.
    expect((await activeInk(page)).toLowerCase()).toBe("#101010");
  });
});

test.describe("typed numerics", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("cell size accepts a typed value", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    await field.fill("18");
    await field.press("Enter");
    await expect(field).toHaveValue("18");
  });

  test("units are rendered, not implied", async ({ page }) => {
    await expect(page.getByTestId("numeric-cellSize-unit")).toContainText("px");
  });

  test("out-of-range input is clamped, not accepted blindly", async ({
    page,
  }) => {
    const field = page.getByTestId("numeric-cellSize");
    await field.fill("9999");
    await field.press("Enter");
    const value = Number(await field.inputValue());
    expect(value).toBeLessThanOrEqual(64);
  });

  test("a non-numeric entry reverts rather than breaking the render", async ({
    page,
  }) => {
    const field = page.getByTestId("numeric-cellSize");
    const before = await field.inputValue();
    await field.fill("abc");
    await field.press("Enter");
    await expect(field).toHaveValue(before);
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("empty and whitespace-only numeric drafts revert", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const before = await field.inputValue();

    await field.fill("");
    await field.press("Enter");
    await expect(field).toHaveValue(before);

    await field.fill("   ");
    await field.press("Enter");
    await expect(field).toHaveValue(before);
  });

  test("numeric rows meet the 24px hit-target floor", async ({ page }) => {
    const box = await page.getByTestId("numeric-cellSize").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });

  test("the draggable numeric label meets the 24px hit-target floor", async ({
    page,
  }) => {
    const box = await page.getByTestId("numeric-cellSize-grip").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });

  test("numeric labels support coarse drag and Shift fine-adjust", async ({
    page,
  }) => {
    const field = page.getByTestId("numeric-cellSize");
    const grip = page.getByTestId("numeric-cellSize-grip");
    const box = await grip.boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 8, y);
    await page.mouse.up();
    await expect(field).toHaveValue("20");

    await field.fill("12");
    await field.press("Enter");
    await page.keyboard.down("Shift");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 8, y);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(field).toHaveValue("14");
  });

  test("numeric units and consequence hints are announced with the field", async ({
    page,
  }) => {
    const field = page.getByTestId("numeric-cellSize");
    await expect(field).toHaveAttribute(
      "aria-describedby",
      "numeric-cellSize-unit numeric-cellSize-hint",
    );
    await expect(page.locator("#numeric-cellSize-unit")).toContainText("px");
    await expect(page.locator("#numeric-cellSize-hint")).toContainText(/240 DPI/i);
  });

  test("the ink rail is the only plate-angle editor", async ({ page }) => {
    await expect(page.getByTestId("ink-angle-cyan")).toHaveCount(1);
    await expect(page.locator(".inspector .angle-field")).toHaveCount(0);
  });

  test("plate angles are typed or dragged inline without changing the soloed plate", async ({
    page,
  }) => {
    await page.getByTestId("ink-chip-composite").click();
    const angle = page.getByTestId("ink-angle-cyan");
    await angle.fill("-1");
    await angle.press("Enter");
    await expect(angle).toHaveValue("359");

    const grip = page.getByTestId("ink-angle-cyan-grip");
    const box = await grip.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await grip.hover();
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 6, box!.y + box!.height / 2);
    await page.mouse.up();
    await expect(angle).not.toHaveValue("359");

    await expect(page.getByTestId("ink-chip-composite")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("empty and whitespace-only angle drafts revert", async ({ page }) => {
    const angle = page.getByTestId("ink-angle-cyan");
    const before = await angle.inputValue();

    await angle.fill("");
    await angle.press("Enter");
    await expect(angle).toHaveValue(before);

    await angle.fill("   ");
    await angle.press("Enter");
    await expect(angle).toHaveValue(before);
  });

  test("zoom is type-first while retaining a slider for drag adjustment", async ({
    page,
  }) => {
    const zoom = page.getByTestId("numeric-zoom");
    await zoom.fill("90");
    await zoom.press("Enter");
    await expect(zoom).toHaveValue("90");
    const slider = page.getByTestId("zoom-slider");
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute("aria-valuetext", "90 percent");
    await expect(slider).toHaveAttribute(
      "aria-describedby",
      "numeric-zoom-unit numeric-zoom-hint",
    );
  });
});

test.describe("stage spine and keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("all four stages are visible without scrolling", async ({ page }) => {
    for (const label of ["ARTWORK", "SCREEN", "SEPARATION", "OUTPUT"]) {
      await expect(
        page.getByTestId(`stage-${label.toLowerCase()}`),
      ).toBeInViewport();
    }
  });

  test("stage numbers are zero-padded and completion is explicit", async ({
    page,
  }) => {
    await expect(page.getByTestId("stage-artwork")).toContainText("01");
    await expect(page.getByTestId("stage-output")).toContainText("04");
    await expect(page.getByTestId("stage-artwork")).toHaveAttribute(
      "data-complete",
      "true",
    );
    await expect(
      page.getByTestId("stage-artwork").getByLabel("complete"),
    ).toBeVisible();
  });

  test("every stage name is fully visible without clipping", async ({
    page,
  }) => {
    for (const [id, label] of [
      ["artwork", "ARTWORK"],
      ["screen", "SCREEN"],
      ["separation", "SEPARATION"],
      ["output", "OUTPUT"],
    ]) {
      const measurements = await page.getByTestId(`stage-${id}`).evaluate(
        (button, expectedLabel) => {
          const name = button.querySelector<HTMLElement>(".stage-label")!;
          return {
            text: name.textContent?.trim(),
            buttonFits: button.scrollWidth <= button.clientWidth,
            labelFits: name.scrollWidth <= name.clientWidth,
            expectedLabel,
          };
        },
        label,
      );

      expect(measurements.text?.toUpperCase()).toBe(measurements.expectedLabel);
      expect(measurements.buttonFits).toBe(true);
      expect(measurements.labelFits).toBe(true);
    }
  });

  test("inactive stage labels meet WCAG AA contrast", async ({ page }) => {
    const colors = await page.getByTestId("stage-screen").evaluate((button) => {
      const label = button.querySelector<HTMLElement>(".stage-label")!;
      const spine = button.closest<HTMLElement>(".stage-spine")!;
      return {
        foreground: getComputedStyle(label).color,
        background: getComputedStyle(spine).backgroundColor,
      };
    });

    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test("clicking a stage jumps to its inspector section", async ({ page }) => {
    await page.getByTestId("stage-output").click();
    await expect(page.locator("#output")).toBeInViewport();
  });

  test("Space activates a focused stage control without arming pan", async ({
    page,
  }) => {
    const stage = page.getByTestId("stage-surface");
    const output = page.getByTestId("stage-output");
    await output.focus();
    await page.keyboard.press("Space");

    await expect(output).toHaveAttribute("aria-current", "step");
    await expect(page.locator("#output")).toBeInViewport();
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
  });

  test("number keys solo plates", async ({ page }) => {
    await page.locator("body").press("1");
    await expect(page.getByTestId("active-plate-label")).toContainText(/cyan/i);
    await page.locator("body").press("2");
    await expect(page.getByTestId("active-plate-label")).toContainText(
      /magenta/i,
    );
    await page.locator("body").press("4");
    await expect(page.getByTestId("active-plate-label")).toContainText(/black/i);
  });

  test("backtick returns to composite", async ({ page }) => {
    await page.locator("body").press("1");
    await page.locator("body").press("`");
    await expect(page.getByTestId("active-plate-label")).toContainText(
      /composite/i,
    );
  });

  test("bracket keys step cell size", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const before = Number(await field.inputValue());
    await page.locator("body").press("]");
    await expect(field).toHaveValue(String(before + 1));
    await page.locator("body").press("[");
    await expect(field).toHaveValue(String(before));
  });

  test("shortcuts do not fire while typing in a field", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    await field.click();
    await field.fill("");
    await field.type("12");
    // '1' and '2' must reach the input, not solo plates.
    await expect(field).toHaveValue("12");
    await expect(page.getByTestId("active-plate-label")).toContainText(
      /composite/i,
    );
  });

  test("space arms panning and dragging moves the proof", async ({ page }) => {
    const stage = page.getByTestId("stage-surface");
    const artboard = page.locator(".artboard-wrap");
    const before = await artboard.evaluate((element) => element.style.transform);

    await page.keyboard.down("Space");
    await expect(stage).toHaveAttribute("data-pan-armed", "true");

    const box = await stage.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + box!.width / 2 + 36,
      box!.y + box!.height / 2 + 24,
    );
    await page.mouse.up();

    const after = await artboard.evaluate((element) => element.style.transform);
    expect(after).not.toBe(before);

    await page.keyboard.up("Space");
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
  });

  test("space does not arm panning while typing", async ({ page }) => {
    const stage = page.getByTestId("stage-surface");
    await page.getByTestId("numeric-cellSize").click();
    await page.keyboard.down("Space");
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
    await page.keyboard.up("Space");
  });
});
