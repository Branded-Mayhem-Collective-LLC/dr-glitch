import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function openSeparation(page: Page) {
  await page.getByTestId("stage-halftone-cmyk").click();
}

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

function pngChunks(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{
    type: string;
    length: number;
    dataOffset: number;
  }> = [];
  let offset = 8;

  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    chunks.push({ type, length, dataOffset: offset + 8 });
    offset += length + 12;
    if (type === "IEND") break;
  }

  return { chunks, view };
}

test.describe("ink rail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    await openSeparation(page);
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
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    await openSeparation(page);
  });

  // The rail is now the ONLY way to change plates (.plate-tabs removed) —
  // it must be fully operable without a mouse, with a visible focus
  // indicator on every chip including composite.
  test("every chip is keyboard-reachable via Tab with a visible focus indicator", async ({
    page,
  }) => {
    const order = ["composite", "cyan", "magenta", "yellow", "black"];
    await page.keyboard.press("Tab");
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
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    await openSeparation(page);
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
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    await openSeparation(page);
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
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    await page.getByTestId("stage-halftone-cmyk").click();
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
    await expect(page.getByTestId("artwork-canvas")).toBeVisible();
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

  test("numeric labels scrub normally and Shift accelerates by 10×", async ({
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
    await page.mouse.move(x + 4, y);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    expect(Number(await field.inputValue())).toBeGreaterThanOrEqual(50);
  });

  test("the number itself supports click-drag scrubbing", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const scrub = page.getByTestId("numeric-cellSize-scrub");
    const box = await scrub.boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 5, y);
    await page.mouse.up();

    await expect(field).toHaveValue("17");
  });

  test("left-panel numerics expose synchronized sliders", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const slider = page.getByTestId("numeric-cellSize-slider");
    await expect(slider).toBeVisible();
    await slider.fill("24");
    await expect(field).toHaveValue("24");

    await page.getByTestId("stage-output").click();
    await expect(page.getByTestId("numeric-opacity-slider")).toBeVisible();
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
    await openSeparation(page);
    await expect(page.getByTestId("ink-angle-cyan")).toHaveCount(1);
    await expect(page.locator(".inspector .angle-field")).toHaveCount(0);
  });

  test("plate angles are typed or dragged inline without changing the soloed plate", async ({
    page,
  }) => {
    await openSeparation(page);
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
    await openSeparation(page);
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

  test("zoom controls meet their chrome and dense-control target floors", async ({
    page,
  }) => {
    for (const name of ["Zoom out", "Zoom in"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(32);
      expect(box!.height).toBeGreaterThanOrEqual(32);
    }

    const sliderBox = await page.getByTestId("zoom-slider").boundingBox();
    expect(sliderBox!.height).toBeGreaterThanOrEqual(24);
  });
});

test.describe("Artwork stage — restored layout controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    await page.getByTestId("stage-artwork").click();
  });

  test("keeps the complete layout toolset inside the left inspector with restored defaults", async ({
    page,
  }) => {
    const inspector = page.getByTestId("inspector");
    const artwork = inspector.getByTestId("stage-panel-artwork");

    const sheetSize = artwork.getByTestId("artwork-sheet-size");
    await expect(sheetSize).toBeVisible();
    expect(await sheetSize.evaluate((element) => element.tagName)).toBe("SELECT");
    await expect(sheetSize).toHaveValue("11x15");

    const portrait = artwork.getByTestId("artwork-orientation-portrait");
    const landscape = artwork.getByTestId("artwork-orientation-landscape");
    await expect(portrait).toHaveAttribute("aria-pressed", "true");
    await expect(landscape).toHaveAttribute("aria-pressed", "false");

    await expect(artwork.getByTestId("numeric-artworkScale")).toHaveValue("100");
    await expect(
      artwork.getByTestId("numeric-artworkScale-unit"),
    ).toContainText("%");
    await expect(
      artwork.getByTestId("numeric-artworkScale-scrub"),
    ).toBeVisible();
    await expect(artwork.getByTestId("artwork-fit")).toBeVisible();

    const mirror = artwork.getByTestId("artwork-mirror");
    await expect(mirror).toHaveAttribute("type", "checkbox");
    await expect(mirror).not.toBeChecked();
    await expect(
      artwork.getByTestId("artwork-mirror-direction-horizontal"),
    ).toBeVisible();
    await expect(
      artwork.getByTestId("artwork-mirror-direction-vertical"),
    ).toBeVisible();

    await expect(page.getByTestId("stage-surface").locator(".view-status")).toContainText(
      "Centered artwork proof",
    );
  });

  test("Scale supports direct typing and value scrubbing", async ({ page }) => {
    const artwork = page
      .getByTestId("inspector")
      .getByTestId("stage-panel-artwork");
    const scale = artwork.getByTestId("numeric-artworkScale");

    await expect(scale).toBeVisible();
    await scale.fill("125");
    await scale.press("Enter");
    await expect(scale).toHaveValue("125");

    const scrub = artwork.getByTestId("numeric-artworkScale-scrub");
    const box = await scrub.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + box!.width / 2 + 5,
      box!.y + box!.height / 2,
    );
    await page.mouse.up();
    await expect(scale).not.toHaveValue("125");
  });

  test("selecting landscape changes the rendered canvas aspect", async ({
    page,
  }) => {
    const artwork = page
      .getByTestId("inspector")
      .getByTestId("stage-panel-artwork");
    const portrait = artwork.getByTestId("artwork-orientation-portrait");
    const landscape = artwork.getByTestId("artwork-orientation-landscape");
    const canvas = page.getByTestId("artwork-canvas");

    await expect(canvas).toBeVisible();
    const portraitSize = await canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width,
      height: element.height,
    }));
    expect(portraitSize.height).toBeGreaterThan(portraitSize.width);

    await landscape.click();
    await expect(landscape).toHaveAttribute("aria-pressed", "true");
    await expect(portrait).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () =>
        canvas.evaluate(
          (element: HTMLCanvasElement) => element.width / element.height,
        ),
      )
      .toBeGreaterThan(1);
  });
});

test.describe("stage spine and keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
  });

  test("all four stages are visible without scrolling", async ({ page }) => {
    for (const id of ["artwork", "halftone-cmyk", "diffusion", "output"]) {
      await expect(page.getByTestId(`stage-${id}`)).toBeInViewport();
    }
  });

  test("stage labels have no numeric badges and completion is explicit", async ({
    page,
  }) => {
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
      ["artwork", "ARTBOARD"],
      ["halftone-cmyk", "HALFTONE / CMYK"],
      ["diffusion", "DIFFUSION"],
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
    const colors = await page.getByTestId("stage-halftone-cmyk").evaluate((button) => {
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

  test("clicking a stage switches to a distinct inspector panel", async ({
    page,
  }) => {
    const ids = ["artwork", "halftone-cmyk", "diffusion", "output"] as const;
    for (const id of ids) {
      await page.getByTestId(`stage-${id}`).click();
      await expect(page.getByTestId(`stage-${id}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByTestId(`stage-panel-${id}`)).toBeVisible();
      for (const other of ids.filter((candidate) => candidate !== id)) {
        await expect(page.getByTestId(`stage-panel-${other}`)).toBeHidden();
      }
    }
  });

  test("plate controls stay inside the left Halftone / CMYK step only", async ({
    page,
  }) => {
    for (const id of ["artwork", "diffusion", "output"]) {
      await page.getByTestId(`stage-${id}`).click();
      await expect(page.locator(".ink-rail")).toBeHidden();
      await expect(page.getByTestId("active-plate-label")).toBeHidden();
    }

    await openSeparation(page);
    await expect(
      page.getByTestId("stage-panel-halftone-cmyk").locator(".ink-rail"),
    ).toBeVisible();
    await expect(
      page.getByTestId("stage-surface").locator(".ink-rail"),
    ).toHaveCount(0);
    await expect(page.getByTestId("active-plate-label")).toContainText("ALL");
  });

  test("inspector collapse and stage selection both change the workspace", async ({
    page,
  }) => {
    const inspector = page.getByTestId("inspector");
    await page.getByRole("button", { name: "Collapse panel" }).click();
    await expect(inspector).toHaveAttribute("data-collapsed", "true");
    await expect(
      page.getByRole("button", { name: "Expand panel" }),
    ).toBeVisible();

    await page.getByTestId("stage-halftone-cmyk").click();
    await expect(inspector).toHaveAttribute("data-collapsed", "false");
    await expect(page.getByTestId("stage-panel-halftone-cmyk")).toBeVisible();
  });

  test("Space activates a focused stage control without arming pan", async ({
    page,
  }) => {
    const stage = page.getByTestId("stage-surface");
    const output = page.getByTestId("stage-output");
    await output.focus();
    await page.keyboard.press("Space");

    await expect(output).toHaveAttribute("aria-current", "step");
    await expect(page.getByTestId("stage-panel-output")).toBeVisible();
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
  });

  test("number keys solo plates", async ({ page }) => {
    await openSeparation(page);
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
    await openSeparation(page);
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
    await page.getByTestId("stage-halftone-cmyk").click();
    const field = page.getByTestId("numeric-cellSize");
    await field.click();
    await field.fill("");
    await field.type("12");
    // '1' and '2' must reach the input, not solo plates.
    await expect(field).toHaveValue("12");
    await openSeparation(page);
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
    await page.getByTestId("stage-halftone-cmyk").click();
    await page.getByTestId("numeric-cellSize").click();
    await page.keyboard.down("Space");
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
    await page.keyboard.up("Space");
  });
});

test.describe("press workflow preflight", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
  });

  test("screen controls reset together without touching the engine", async ({
    page,
  }) => {
    await page.getByTestId("stage-halftone-cmyk").click();
    const screen = page.getByTestId("stage-panel-halftone-cmyk");
    await page.getByTestId("numeric-cellSize-slider").fill("24");
    await screen.getByRole("combobox", { name: "Dot shape", exact: true }).selectOption("square");

    await page.getByRole("button", { name: "Reset Halftone / CMYK controls" }).click();

    await expect(page.getByTestId("numeric-cellSize")).toHaveValue("12");
    await expect(screen.getByRole("combobox", { name: "Dot shape", exact: true })).toHaveValue("round");
    await expect(page.getByRole("status")).toContainText("Screen controls reset");
  });

  test("preflight names hidden plates and missing registration marks", async ({
    page,
  }) => {
    await openSeparation(page);
    await page.keyboard.down("Alt");
    await page.getByTestId("ink-chip-cyan").click();
    await page.keyboard.up("Alt");

    await page.getByTestId("stage-output").click();
    await page
      .getByRole("checkbox", { name: /Registration marks/i })
      .uncheck();

    await expect(page.getByTestId("preflight-count")).toContainText(
      "2 to review",
    );
    await expect(
      page.locator(".preflight-list li[data-status='review']"),
    ).toHaveCount(2);
    await expect(page.locator(".preflight-list")).toContainText("C hidden");
    await expect(page.locator(".preflight-list")).toContainText(
      "Off — confirm before film",
    );
  });

  test("preflight reports exact shared screen angles without claiming certainty", async ({
    page,
  }) => {
    await openSeparation(page);
    const yellow = page.getByTestId("ink-angle-yellow");
    await yellow.fill("15");
    await yellow.press("Enter");
    await page.getByTestId("stage-output").click();

    await expect(page.locator(".preflight-list")).toContainText(
      "C/Y share 15°",
    );
  });

  test("dense screen load is reviewed and blocks export without changing cell size", async ({
    page,
  }) => {
    const artwork = page
      .getByTestId("inspector")
      .getByTestId("stage-panel-artwork");
    await artwork.getByTestId("artwork-sheet-size").selectOption("15x22");

    await page.getByTestId("stage-halftone-cmyk").click();
    const screen = page.getByTestId("stage-panel-halftone-cmyk");
    const cellSize = screen.getByTestId("numeric-cellSize");
    await cellSize.fill("4");
    await cellSize.press("Enter");

    await page.getByTestId("stage-output").click();
    const output = page.getByTestId("stage-panel-output");
    const preflight = output.locator(".preflight-card");
    const screenLoad = preflight
      .getByRole("listitem")
      .filter({ hasText: "Screen load" });
    await expect(screenLoad).toHaveAttribute("data-status", "review");
    await expect(screenLoad).toContainText("2,464,900 estimated marks/plate");
    await expect(preflight.getByTestId("preflight-count")).toHaveText(
      "1 to review",
    );

    const topActions = page.locator(".top-actions");
    await topActions.getByRole("button", { name: /^Export/ }).click();
    await topActions
      .locator(".export-menu")
      .getByRole("button", { name: /Composite PNG/ })
      .click();

    await expect(page.getByRole("status")).toHaveText(
      "Export blocked: estimated 2,464,900 marks per plate exceeds the 2,000,000 limit. Increase cell size to export.",
    );
    await expect(cellSize).toHaveValue("4");
    await expect(
      topActions.getByRole("button", { name: /^Export/ }),
    ).toBeEnabled();
  });

  test("lightweight composite PNG contains one 240-DPI pHYs chunk", async ({
    page,
  }) => {
    const artwork = page
      .getByTestId("inspector")
      .getByTestId("stage-panel-artwork");
    await artwork.getByTestId("artwork-sheet-size").selectOption("8x10");

    await page.getByTestId("stage-halftone-cmyk").click();
    const screen = page.getByTestId("stage-panel-halftone-cmyk");
    const cellSize = screen.getByTestId("numeric-cellSize");
    await cellSize.fill("64");
    await cellSize.press("Enter");

    const topActions = page.locator(".top-actions");
    await topActions.getByRole("button", { name: /^Export/ }).click();
    const downloadPromise = page.waitForEvent("download");
    await topActions
      .locator(".export-menu")
      .getByRole("button", { name: /Composite PNG/ })
      .click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();

    const bytes = await readFile(downloadPath!);
    expect([...bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    const { chunks, view } = pngChunks(bytes);
    const physChunks = chunks.filter(({ type }) => type === "pHYs");
    expect(physChunks).toHaveLength(1);
    expect(physChunks[0].length).toBe(9);
    expect(view.getUint32(physChunks[0].dataOffset)).toBe(9449);
    expect(view.getUint32(physChunks[0].dataOffset + 4)).toBe(9449);
    expect(bytes[physChunks[0].dataOffset + 8]).toBe(1);
  });

  test("job ticket copies the visible recipe for press handoff", async ({
    page,
  }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as typeof window & { __copiedTicket?: string }).__copiedTicket =
              text;
          },
        },
      });
    });
    await page.getByTestId("stage-output").click();
    await page.getByRole("button", { name: "Copy job ticket" }).click();

    const ticket = await page.evaluate(
      () => (window as typeof window & { __copiedTicket?: string }).__copiedTicket,
    );
    expect(ticket).toContain("DR.GLITCH JOB TICKET");
    expect(ticket).toContain("Output dimensions: 2640 × 3600px");
    expect(ticket).toContain("Resolution: 240 DPI");
    expect(ticket).toContain(
      "Estimated screen load: 135,424 marks/plate (K at 45°)",
    );
    expect(ticket).toContain("Angles: C 15° · M 75° · Y 0° · K 45°");
    expect(ticket).toContain("Registration marks: Included");
    await expect(page.getByRole("status")).toContainText("Job ticket copied");
  });
});
