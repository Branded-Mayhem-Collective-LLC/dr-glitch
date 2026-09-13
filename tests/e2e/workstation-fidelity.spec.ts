/**
 * Wave F plan-fidelity coverage:
 * - Layers "Add Layer" (file intake) preserves the whole stack/artboard and
 *   creates the new layer SELECTED in Clean mode; Select-panel intake stays
 *   the Replace flow;
 * - canonical TRANSPARENT artboard background keeps real alpha in the live
 *   proof and in composite exports;
 * - the configurable grid actually renders on the canvas;
 * - Copy Recipe / Apply to Selected is explicit and one undo transaction;
 * - the Layers list is a keyboard-operable listbox with keyboard rename;
 * - Clean mode is labeled truthfully with an undoable "Use Halftone";
 * - the size gate announces activation via a live region.
 */

import { expect, test } from "@playwright/test";
import { captureDownload, pngAlphaStats } from "./helpers/downloads";
import {
  activateTool,
  artworkFileInput,
  ensureDrawerExpanded,
  layerRows,
  openFreshStudio,
  panel,
  proofCanvas,
  sizeGate,
  topbarButton,
  uploadCardName,
} from "./helpers/workstation";

const SMALL_SVG = {
  name: "band.svg",
  mimeType: "image/svg+xml",
  buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">' +
      '<rect x="0" y="0" width="400" height="400" fill="#000000"/></svg>',
  ),
};

async function canvasCornerAlpha(page: import("@playwright/test").Page) {
  return proofCanvas(page).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    return context.getImageData(2, 2, 1, 1).data[3];
  });
}

test.describe("layers — Add Layer vs Select Replace", () => {
  test("Add Layer preserves the stack and artboard; new layer is selected and Clean", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await ensureDrawerExpanded(page, "document");
    const dimensions = await page
      .getByTestId("document-dimensions")
      .textContent();

    await activateTool(page, "layers");
    await expect(layerRows(page)).toHaveCount(1);

    const chooser = page.waitForEvent("filechooser");
    await panel(page, "layers")
      .getByRole("button", { name: "Add Layer", exact: true })
      .click();
    await (await chooser).setFiles(SMALL_SVG);

    await expect(layerRows(page)).toHaveCount(2);
    // The sample layer survived, on top of it sits the new SELECTED layer.
    await expect(layerRows(page).filter({ hasText: "sample artwork" })).toHaveCount(1);
    const newRow = layerRows(page).filter({ hasText: "band.svg" });
    await expect(newRow.getByRole("button", { name: /^Select / })).toHaveAttribute("aria-current", "true");
    // New layers start CLEAN with Glitch off.
    await expect(
      panel(page, "layers").getByRole("radio", { name: "Clean", exact: true }),
    ).toBeChecked();
    // Artboard untouched (Add never auto-fits orientation or resizes).
    await expect(page.getByTestId("document-dimensions")).toHaveText(
      dimensions ?? "",
    );
  });

  test("the Select panel intake still REPLACES the primary layer", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await activateTool(page, "select");
    await artworkFileInput(page).setInputFiles(SMALL_SVG);
    await expect(uploadCardName(page)).toHaveText("band.svg");
    await activateTool(page, "layers");
    await expect(layerRows(page)).toHaveCount(1);
    await expect(layerRows(page).filter({ hasText: "sample artwork" })).toHaveCount(0);
  });
});

test.describe("canonical transparent background", () => {
  test("transparent artboard keeps real alpha in the proof and in composite PNG", async ({
    page,
  }) => {
    await openFreshStudio(page);
    // White background paints opaque paper at the corner.
    expect(await canvasCornerAlpha(page)).toBe(255);

    await ensureDrawerExpanded(page, "document");
    await page.getByTestId("artwork-background-transparent").click();
    await expect(
      page.getByTestId("artwork-background-transparent"),
    ).toHaveAttribute("aria-pressed", "true");

    // The proof re-renders with REAL alpha: the sample's ≥300px margins
    // leave the corners genuinely transparent.
    await expect.poll(() => canvasCornerAlpha(page)).toBe(0);

    // And the exported composite PNG preserves that alpha end to end.
    await topbarButton(page, "Export").click();
    const download = await captureDownload(page, () =>
      page.getByRole("button", { name: /Composite PNG/ }).click(),
    );
    const stats = await pngAlphaStats(page, download.bytes);
    expect(stats.cornerAlphas).toEqual([0, 0, 0, 0]);
    expect(stats.opaquePixelCount).toBeGreaterThan(0);

    // Undoable: white paper returns.
    await topbarButton(page, "Undo").click();
    await expect.poll(() => canvasCornerAlpha(page)).toBe(255);
  });
});

test.describe("grid renders on canvas", () => {
  test("the Document drawer Grid toggle draws (and removes) the grid overlay", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await expect(page.getByTestId("ws-grid")).toHaveCount(0);
    await ensureDrawerExpanded(page, "document");
    await page.getByTestId("document-grid-toggle").check();
    await expect(page.getByTestId("ws-grid")).toBeVisible();
    await page.getByTestId("document-grid-toggle").uncheck();
    await expect(page.getByTestId("ws-grid")).toHaveCount(0);
  });
});

test.describe("copy recipe / apply to selected", () => {
  test("applies the primary recipe to selected unlocked layers as ONE undo step", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await activateTool(page, "layers");
    await panel(page, "layers")
      .getByRole("button", { name: "Duplicate Layer", exact: true })
      .click();
    await expect(layerRows(page)).toHaveCount(2);

    // Tweak the PRIMARY (the duplicate) halftone cell size.
    await activateTool(page, "halftone");
    const cellSize = page.getByTestId("numeric-cellSize");
    await cellSize.fill("24");
    await cellSize.press("Enter");

    // Select original then shift-add the duplicate: primary = duplicate.
    await activateTool(page, "layers");
    const applyButton = panel(page, "layers").getByRole("button", {
      name: "Apply Recipe to Selected",
      exact: true,
    });
    await expect(applyButton).toBeDisabled();
    await layerRows(page).nth(1).click();
    await layerRows(page).nth(0).click({ modifiers: ["Shift"] });
    await expect(applyButton).toBeEnabled();
    await applyButton.click();

    // The original now carries the copied recipe.
    await layerRows(page).nth(1).click();
    await activateTool(page, "halftone");
    await expect(page.getByTestId("numeric-cellSize")).toHaveValue("24");

    // ONE undo step reverts the whole application.
    await topbarButton(page, "Undo").click();
    await expect(page.getByTestId("numeric-cellSize")).toHaveValue("12");
    // …and the duplicate keeps its own tweak (undo did not touch it).
    await activateTool(page, "layers");
    await layerRows(page).nth(0).click();
    await activateTool(page, "halftone");
    await expect(page.getByTestId("numeric-cellSize")).toHaveValue("24");
  });
});

test.describe("layers keyboard semantics", () => {
  test("arrow keys move selection; F2 renames from the keyboard", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await activateTool(page, "layers");
    await panel(page, "layers")
      .getByRole("button", { name: "Duplicate Layer", exact: true })
      .click();

    const list = panel(page, "layers").getByRole("list", { name: "Layers" });
    await expect(list).toBeVisible();
    const select = (index: number) => layerRows(page).nth(index).getByRole("button", { name: /^Select / });
    await expect(select(0)).toHaveAttribute("aria-current", "true");

    await select(0).focus();
    await page.keyboard.press("ArrowDown");
    await expect(select(1)).toHaveAttribute("aria-current", "true");
    await expect(select(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(select(0)).toHaveAttribute("aria-current", "true");

    // Keyboard rename on the primary row.
    await page.keyboard.press("F2");
    const renameInput = panel(page, "layers").getByRole("textbox", {
      name: /Rename /,
    });
    await expect(renameInput).toBeVisible();
    await renameInput.fill("Keyboard Renamed");
    await renameInput.press("Enter");
    await expect(
      layerRows(page).filter({ hasText: "Keyboard Renamed" }),
    ).toHaveCount(1);
  });
});

test.describe("clean-mode truth", () => {
  test("Clean is labeled truthfully; Halftone controls explain inactivity; Use Halftone is undoable", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await activateTool(page, "layers");
    await panel(page, "layers")
      .getByRole("radio", { name: "Clean", exact: true })
      .check();
    await expect(page.getByTestId("proof-mode-label")).toHaveText("Clean");

    await activateTool(page, "halftone");
    await expect(page.getByTestId("halftone-clean-note")).toBeVisible();
    await expect(page.getByTestId("numeric-cellSize")).toBeDisabled();

    await page.getByTestId("halftone-use-halftone").click();
    await expect(page.getByTestId("halftone-clean-note")).toHaveCount(0);
    await expect(page.getByTestId("numeric-cellSize")).toBeEnabled();
    await expect(page.getByTestId("proof-mode-label")).toHaveText("Halftone");

    await topbarButton(page, "Undo").click();
    await expect(page.getByTestId("proof-mode-label")).toHaveText("Clean");
  });
});

test.describe("size gate announcement", () => {
  test("activating the gate announces via a live region and keeps state", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await expect(sizeGate(page)).toBeHidden();
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(sizeGate(page)).toBeVisible();
    await expect(page.getByTestId("ws-size-gate-status")).toContainText(
      /below 1280 by 800/,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(sizeGate(page)).toBeHidden();
    await expect(proofCanvas(page)).toBeVisible();
  });
});
