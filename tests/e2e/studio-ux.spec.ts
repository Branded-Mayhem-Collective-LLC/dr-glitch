import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  RAIL_ORDER,
  activateTool,
  artboardCanvas,
  choosePanelMenuItem,
  drawerToggle,
  ensureDrawerExpanded,
  exportPanel,
  openFreshStudio,
  panel,
  proofCanvas,
  railButton,
  topbarButton,
  type WorkstationToolId,
} from "./helpers/workstation";

/**
 * Migrated from the stage-spine shell (2026-09-12): the spine, inspector,
 * and `.top-actions` export dropdown were replaced by the workstation rail /
 * dock / drawers / topbar Export menu. Every surviving assertion keeps its
 * original intent; assertions whose surface no longer exists contractually
 * are rewritten against the workspace-contract equivalent (see
 * docs/specs/2026-09-12-e2e-coverage-map.md §3).
 */

async function openSeparation(page: Page) {
  await activateTool(page, "plates");
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
    await openFreshStudio(page);
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
    await openFreshStudio(page);
    await openSeparation(page);
  });

  // The rail is still the ONLY way to change plate angles — it must be fully
  // operable without a mouse, with a visible focus indicator on every chip
  // including composite.
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

      if (index < order.length - 1) {
        await page.keyboard.press("Tab");
        const dial = page.locator(".ink-chip-dial-" + order[index + 1]);
        await expect(dial).toBeFocused();
        const dialOutline = await dial.evaluate((el) => getComputedStyle(el).outlineWidth);
        expect(parseFloat(dialOutline)).toBeGreaterThan(0);
        await page.keyboard.press("Tab");
      }
    }
  });

  test("angle dials expose valid ranges and all slider keyboard controls", async ({ page }) => {
    const dial = page.locator(".ink-chip-dial-cyan");
    const field = page.getByTestId("ink-angle-cyan");
    await dial.focus();
    for (const [key, value] of [["Home", "0"], ["ArrowUp", "1"], ["ArrowRight", "2"], ["ArrowDown", "1"], ["ArrowLeft", "0"], ["End", "359"]]) {
      await dial.press(key);
      await expect(dial).toHaveAttribute("aria-valuenow", value);
      await expect(field).toHaveValue(value);
    }
    await field.fill("359.5"); await field.press("Enter");
    expect(Number(await dial.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(await dial.getAttribute("aria-valuemax")));
    await expect(field).toHaveValue("359.5");
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
    await openFreshStudio(page);
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
    await openFreshStudio(page);
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
    await openFreshStudio(page);
    await activateTool(page, "halftone");
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
    await expect(proofCanvas(page)).toBeVisible();
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

  test("valid drafts commit on tool navigation and Escape reverts without stale blur commits", async ({ page }) => {
    const cell = page.getByTestId("numeric-cellSize");
    await cell.fill("31");
    await activateTool(page, "plates");
    await activateTool(page, "halftone");
    await expect(cell).toHaveValue("31");

    await cell.fill("47");
    await cell.press("Escape");
    await expect(cell).toHaveValue("31");
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

  test("panel numerics expose synchronized sliders", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const slider = page.getByTestId("numeric-cellSize-slider");
    await expect(slider).toBeVisible();
    await slider.fill("24");
    await expect(field).toHaveValue("24");

    await activateTool(page, "export");
    await ensureDrawerExpanded(page, "output");
    const registrationSlider = page.getByTestId("numeric-registrationSize-slider");
    await expect(registrationSlider).toBeVisible();
    await registrationSlider.fill("240");
    await expect(page.getByTestId("numeric-registrationSize")).toHaveValue("240");
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
    // The single editor lives inside the Plates panel; no other panel or
    // drawer duplicates it (the old inspector angle fields stay gone).
    await expect(
      panel(page, "plates").getByTestId("ink-angle-cyan"),
    ).toHaveCount(1);
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
    // Contract correction: the coverage map places `numeric-zoom` in the
    // Proof drawer (§ Proof drawer), which is collapsed by default (Document
    // is the default-expanded drawer), so the drawer must be expanded before
    // the field is reachable. Assertions unchanged.
    await ensureDrawerExpanded(page, "proof");
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

test.describe("Select panel and Document drawer — restored layout controls", () => {
  test.beforeEach(async ({ page }) => {
    await openFreshStudio(page);
    await activateTool(page, "select");
    await ensureDrawerExpanded(page, "document");
  });

  // The old Artwork stage split in two: sheet size / orientation moved into
  // the Document drawer, placement (scale, fit, mirror) into the
  // Select/Transform panel. The complete toolset must survive with the same
  // defaults.
  test("keeps the complete layout toolset with restored defaults", async ({
    page,
  }) => {
    const select = panel(page, "select");

    const sheetSize = page.getByTestId("artwork-sheet-size");
    await expect(sheetSize).toBeVisible();
    expect(await sheetSize.evaluate((element) => element.tagName)).toBe("SELECT");
    await expect(sheetSize).toHaveValue("11x15");

    const portrait = page.getByTestId("artwork-orientation-portrait");
    const landscape = page.getByTestId("artwork-orientation-landscape");
    await expect(portrait).toHaveAttribute("aria-pressed", "true");
    await expect(landscape).toHaveAttribute("aria-pressed", "false");

    await expect(select.getByTestId("numeric-artworkScale")).toHaveValue("100");
    await expect(
      select.getByTestId("numeric-artworkScale-unit"),
    ).toContainText("%");
    await expect(
      select.getByTestId("numeric-artworkScale-scrub"),
    ).toBeVisible();
    await expect(select.getByTestId("artwork-fit")).toBeVisible();

    const mirror = select.getByTestId("artwork-mirror");
    await expect(mirror).toHaveAttribute("type", "checkbox");
    await expect(mirror).not.toBeChecked();
    await expect(
      select.getByTestId("artwork-mirror-direction-horizontal"),
    ).toBeVisible();
    await expect(
      select.getByTestId("artwork-mirror-direction-vertical"),
    ).toBeVisible();
  });

  test("Scale supports direct typing and value scrubbing", async ({ page }) => {
    const select = panel(page, "select");
    const scale = select.getByTestId("numeric-artworkScale");

    await expect(scale).toBeVisible();
    await scale.fill("125");
    await scale.press("Enter");
    await expect(scale).toHaveValue("125");

    const scrub = select.getByTestId("numeric-artworkScale-scrub");
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
    const portrait = page.getByTestId("artwork-orientation-portrait");
    const landscape = page.getByTestId("artwork-orientation-landscape");
    const canvas = proofCanvas(page);

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

test.describe("tool rail and keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await openFreshStudio(page);
  });

  test("all eight tools are visible without scrolling", async ({ page }) => {
    for (const tool of RAIL_ORDER) {
      await expect(railButton(page, tool)).toBeInViewport();
    }
  });

  // Rewritten from "inactive stage labels meet WCAG AA contrast": the rail
  // is icon-only (names live on aria-label, asserted in workspace-a11y), so
  // the drawer toggles are now the visible always-on chrome text this law
  // applies to.
  test("drawer toggle labels meet WCAG AA contrast", async ({ page }) => {
    const colors = await drawerToggle(page, "proof").evaluate((button) => {
      const effectiveBackground = (start: Element | null): string => {
        let element: Element | null = start;
        while (element) {
          const paint = getComputedStyle(element).backgroundColor;
          if (
            paint &&
            paint !== "transparent" &&
            !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(paint)
          ) {
            return paint;
          }
          element = element.parentElement;
        }
        return "rgb(255, 255, 255)";
      };
      return {
        foreground: getComputedStyle(button).color,
        background: effectiveBackground(button),
      };
    });

    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test("activating a rail tool swaps in that tool's sole docked panel", async ({
    page,
  }) => {
    for (const tool of RAIL_ORDER) {
      await activateTool(page, tool);
      await expect(panel(page, tool)).toBeVisible();
      for (const other of RAIL_ORDER.filter((candidate) => candidate !== tool)) {
        await expect(panel(page, other)).toBeHidden();
      }
    }
  });

  test("plate controls stay inside the Plates tool only", async ({
    page,
  }) => {
    const others: WorkstationToolId[] = [
      "select",
      "layers",
      "halftone",
      "diffusion",
      "glitch",
      "history",
      "export",
    ];
    for (const tool of others) {
      await activateTool(page, tool);
      await expect(page.locator(".ink-rail")).toBeHidden();
      await expect(page.getByTestId("active-plate-label")).toBeHidden();
    }

    await openSeparation(page);
    await expect(
      panel(page, "plates").locator(".ink-rail"),
    ).toBeVisible();
    await expect(
      artboardCanvas(page).locator(".ink-rail"),
    ).toHaveCount(0);
    await expect(page.getByTestId("active-plate-label")).toContainText("Viewing: Composite");
  });

  // Rewritten from "inspector collapse and stage selection both change the
  // workspace": the collapsible inspector is contractually replaced by the
  // dock — closing the docked panel empties the dock, and rail activation
  // brings a panel back.
  test("closing the docked panel empties the dock and rail activation restores one", async ({
    page,
  }) => {
    // Contract correction: on a fresh project the DOCKED panel is Layers
    // (coverage map "New-project defaults: Select/Transform active, Layers
    // docked"), so closing the docked panel means closing ws-panel-layers.
    await choosePanelMenuItem(page, "layers", "Close");
    await expect(page.getByTestId("dock-empty")).toBeVisible();

    await activateTool(page, "halftone");
    await expect(panel(page, "halftone")).toBeVisible();
    await expect(page.getByTestId("dock-empty")).toBeHidden();
  });

  test("Space activates a focused rail tool without arming pan", async ({
    page,
  }) => {
    const stage = artboardCanvas(page);
    const exportTool = railButton(page, "export");
    await exportTool.focus();
    await page.keyboard.press("Space");

    await expect(exportTool).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page, "export")).toBeVisible();
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
    await activateTool(page, "halftone");
    const field = page.getByTestId("numeric-cellSize");
    const before = Number(await field.inputValue());
    await page.locator("body").press("]");
    await expect(field).toHaveValue(String(before + 1));
    await page.locator("body").press("[");
    await expect(field).toHaveValue(String(before));
  });

  test("shortcuts do not fire while typing in a field", async ({ page }) => {
    await activateTool(page, "halftone");
    const field = page.getByTestId("numeric-cellSize");
    await field.click();
    await field.fill("");
    await field.pressSequentially("12");
    // '1' and '2' must reach the input, not solo plates.
    await expect(field).toHaveValue("12");
    await openSeparation(page);
    await expect(page.getByTestId("active-plate-label")).toContainText(
      /composite/i,
    );
  });

  test("space arms panning and dragging moves the proof", async ({ page }) => {
    const stage = artboardCanvas(page);
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
    const stage = artboardCanvas(page);
    await activateTool(page, "halftone");
    await page.getByTestId("numeric-cellSize").click();
    await page.keyboard.down("Space");
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
    await page.keyboard.up("Space");
  });
});

test.describe("press workflow preflight", () => {
  test.beforeEach(async ({ page }) => {
    await openFreshStudio(page);
  });

  test("screen controls reset together without touching the engine", async ({
    page,
  }) => {
    await activateTool(page, "halftone");
    const screen = panel(page, "halftone");
    await page.getByTestId("numeric-cellSize-slider").fill("24");
    await screen.getByRole("combobox", { name: "Dot shape", exact: true }).selectOption("square");

    await screen.getByRole("button", { name: /Reset halftone/i }).click();

    await expect(page.getByTestId("numeric-cellSize")).toHaveValue("12");
    await expect(screen.getByRole("combobox", { name: "Dot shape", exact: true })).toHaveValue("round");
    await expect(page.getByRole("status")).toContainText("Halftone / CMYK controls reset");
  });

  test("preflight names hidden plates and missing registration marks", async ({
    page,
  }) => {
    await openSeparation(page);
    await page.keyboard.down("Alt");
    await page.getByTestId("ink-chip-cyan").click();
    await page.keyboard.up("Alt");

    await activateTool(page, "export");
    await exportPanel(page)
      .getByRole("checkbox", { name: /Registration marks/i })
      .uncheck();

    await expect(page.getByTestId("preflight-count")).toContainText(
      "2 to review",
    );
    await expect(
      exportPanel(page).locator(".preflight-list li[data-status='review']"),
    ).toHaveCount(2);
    await expect(exportPanel(page).locator(".preflight-list")).toContainText("C hidden");
    await expect(exportPanel(page).locator(".preflight-list")).toContainText(
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
    await activateTool(page, "export");

    await expect(exportPanel(page).locator(".preflight-list")).toContainText(
      "C/Y share 15°",
    );
  });

  test("dense screen load is reviewed and blocks export without changing cell size", async ({
    page,
  }) => {
    await ensureDrawerExpanded(page, "document");
    await page.getByTestId("artwork-sheet-size").selectOption("15x22");

    await activateTool(page, "halftone");
    const cellSize = panel(page, "halftone").getByTestId("numeric-cellSize");
    await cellSize.fill("4");
    await cellSize.press("Enter");

    await activateTool(page, "export");
    const preflight = exportPanel(page).locator(".preflight-card");
    const screenLoad = preflight
      .getByRole("listitem")
      .filter({ hasText: "Screen load" });
    await expect(screenLoad).toHaveAttribute("data-status", "review");
    await expect(screenLoad).toContainText("2,464,900 estimated marks/plate");
    await expect(preflight.getByTestId("preflight-count")).toHaveText(
      "1 to review",
    );

    await topbarButton(page, "Export").click();
    await page.getByRole("button", { name: /Composite PNG/ }).click();

    await expect(page.getByRole("status")).toHaveText(
      "Export blocked: estimated 2,464,900 marks per plate exceeds the 2,000,000 limit. Increase cell size to export.",
    );
    await activateTool(page, "halftone");
    await expect(cellSize).toHaveValue("4");
    await expect(topbarButton(page, "Export")).toBeEnabled();
  });

  test("lightweight composite PNG contains one 240-DPI pHYs chunk", async ({
    page,
  }) => {
    await ensureDrawerExpanded(page, "document");
    await page.getByTestId("artwork-sheet-size").selectOption("8x10");

    await activateTool(page, "halftone");
    const cellSize = panel(page, "halftone").getByTestId("numeric-cellSize");
    await cellSize.fill("64");
    await cellSize.press("Enter");

    await topbarButton(page, "Export").click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Composite PNG/ }).click();
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
    await activateTool(page, "export");
    await exportPanel(page).getByRole("button", { name: "Copy job ticket" }).click();

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
