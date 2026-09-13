/**
 * OUTPUT CANONICAL OWNERSHIP (wave F, P0 prepress).
 *
 * The Output drawer binds directly and UNDOABLY to core.output —
 * polarity / pressMirror / registrationOnPlates / registrationOnComposite:
 * - .drglitch round-trip: exported canonical output re-imports and the UI
 *   shows those states;
 * - Reset Output restores canonical defaults WITHOUT touching layer
 *   recipes or opacity;
 * - toggles flow into real export output: the plate-package manifest
 *   echoes outputDefaults, negative polarity inverts plate pixels, and
 *   press mirror flips composite ink bounds (pixel probes, not UI echo);
 * - the proof registration overlay is a SEPARATE session-only toggle that
 *   never creates undo transactions.
 */

import { expect, test } from "@playwright/test";
import {
  captureDownload,
  pngAlphaStats,
  pngPixelSample,
  zipFileBytes,
  zipFileText,
} from "./helpers/downloads";
import {
  activateTool,
  drawer,
  ensureDrawerExpanded,
  expectUndoState,
  exportPanel,
  freshSampleProject,
  goHome,
  homeSurface,
  openFreshStudio,
  openProjectCardMenu,
  openStudioWithUpload,
  panel,
  saveProjectAs,
  topbarButton,
} from "./helpers/workstation";

const LEFT_BAND_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">' +
    '<rect x="0" y="0" width="240" height="800" fill="#000000"/></svg>',
);

test.describe("output drawer — canonical, undoable ownership", () => {
  test("registration geometry remains editable when only composite registration is enabled", async ({ page }) => {
    await freshSampleProject(page);
    await ensureDrawerExpanded(page, "output");
    await activateTool(page, "export");
    const output = drawer(page, "output");
    await output.getByTestId("output-registration-default").uncheck();
    await exportPanel(page).getByRole("checkbox", { name: /Registration marks/ }).uncheck();
    await output.getByTestId("output-registration-composite").check();
    await expect(output.getByTestId("numeric-registrationSize")).toBeEnabled();
    await output.getByTestId("numeric-registrationSize").fill("144");
    await output.getByTestId("numeric-registrationSize").press("Enter");
    await expect(output.getByTestId("numeric-registrationSize")).toHaveValue("144");
  });
  test("polarity and press mirror bind to core.output and are undoable", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await ensureDrawerExpanded(page, "output");
    const output = drawer(page, "output");
    const polarity = output.getByTestId("output-polarity");
    const mirror = output.getByTestId("output-press-mirror");

    await expect(polarity).toHaveValue("positive");
    await expect(mirror).not.toBeChecked();

    await polarity.selectOption("negative");
    await mirror.check();
    await expect(polarity).toHaveValue("negative");
    await expect(mirror).toBeChecked();

    // Two document commands — two undo steps, restoring each in turn.
    await expectUndoState(page, true);
    await topbarButton(page, "Undo").click();
    await expect(mirror).not.toBeChecked();
    await expect(polarity).toHaveValue("negative");
    await topbarButton(page, "Undo").click();
    await expect(polarity).toHaveValue("positive");
  });

  test("Reset Output restores canonical defaults without touching layer opacity or recipes", async ({
    page,
  }) => {
    await freshSampleProject(page);

    // Give the layer a non-default opacity (layer state, NOT output state).
    await activateTool(page, "layers");
    const opacity = panel(page, "layers").getByTestId("numeric-layerOpacity");
    await opacity.fill("60");
    await opacity.press("Enter");
    await expect(opacity).toHaveValue("60");

    await ensureDrawerExpanded(page, "output");
    const output = drawer(page, "output");
    await output.getByTestId("output-polarity").selectOption("negative");
    await output.getByTestId("output-press-mirror").check();
    await output.getByTestId("output-registration-default").uncheck();
    await output.getByTestId("output-registration-composite").check();

    await activateTool(page, "export");
    await exportPanel(page)
      .getByRole("button", { name: "Reset output controls" })
      .click();

    await expect(output.getByTestId("output-polarity")).toHaveValue("positive");
    await expect(output.getByTestId("output-press-mirror")).not.toBeChecked();
    await expect(output.getByTestId("output-registration-default")).toBeChecked();
    await expect(
      output.getByTestId("output-registration-composite"),
    ).not.toBeChecked();

    // Layer opacity survived the output reset (the old behavior wrongly
    // reset it to 100 and cleared recipe inverts).
    await activateTool(page, "layers");
    await expect(
      panel(page, "layers").getByTestId("numeric-layerOpacity"),
    ).toHaveValue("60");
  });

  test("proof registration overlay is session-only and never enters the undo stack", async ({
    page,
  }) => {
    await openFreshStudio(page);
    await ensureDrawerExpanded(page, "proof");
    const overlay = drawer(page, "proof").getByTestId(
      "proof-registration-overlay",
    );
    await expect(overlay).toBeChecked(); // follows registrationOnPlates default
    await expectUndoState(page, false);
    await overlay.uncheck();
    await expect(overlay).not.toBeChecked();
    // Session-only: no undo transaction was created.
    await expectUndoState(page, false);
    // And the document default is untouched.
    await ensureDrawerExpanded(page, "output");
    await expect(
      drawer(page, "output").getByTestId("output-registration-default"),
    ).toBeChecked();
  });
});

test.describe("output round-trip — .drglitch import shows canonical states", () => {
  test("export with polarity=negative/pressMirror=true, reimport, UI shows both", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await ensureDrawerExpanded(page, "output");
    const output = drawer(page, "output");
    await output.getByTestId("output-polarity").selectOption("negative");
    await output.getByTestId("output-press-mirror").check();

    await saveProjectAs(page, "Output Truth");
    await goHome(page);

    const menu = await openProjectCardMenu(page, "Output Truth");
    const archive = await captureDownload(page, () =>
      menu.getByRole("menuitem", { name: "Export Project" }).click(),
    );
    expect(archive.filename).toMatch(/\.drglitch$/);

    // Import the archive back: opens UNSAVED with a new local identity —
    // and the Output drawer must show the canonical states from the file.
    await expect(homeSurface(page)).toBeVisible();
    await page
      .getByTestId("ws-open-project-input")
      .setInputFiles({
        name: "output-truth.drglitch",
        mimeType: "application/zip",
        buffer: archive.bytes,
      });
    await expect(page.getByTestId("ws-canvas")).toBeVisible();
    await ensureDrawerExpanded(page, "output");
    await expect(
      drawer(page, "output").getByTestId("output-polarity"),
    ).toHaveValue("negative");
    await expect(
      drawer(page, "output").getByTestId("output-press-mirror"),
    ).toBeChecked();
  });
});

test.describe("output flows into export bytes", () => {
  test("negative polarity inverts plate pixels and is echoed by the manifest", async ({
    page,
  }) => {
    await openFreshStudio(page);

    // Positive baseline: plate margins are open (light) film.
    await topbarButton(page, "Export").click();
    const positive = await captureDownload(page, () =>
      page.getByRole("button", { name: /CMYK plate package/ }).click(),
    );
    const positivePlate = await zipFileBytes(
      positive.bytes,
      /(^|[-/])K-plate\.png$/,
    );
    const positiveCorner = await pngPixelSample(page, positivePlate, 5, 5);

    await ensureDrawerExpanded(page, "output");
    await drawer(page, "output")
      .getByTestId("output-polarity")
      .selectOption("negative");

    await topbarButton(page, "Export").click();
    const negative = await captureDownload(page, () =>
      page.getByRole("button", { name: /CMYK plate package/ }).click(),
    );
    const manifest = JSON.parse(
      await zipFileText(negative.bytes, "job-settings.json"),
    ) as { outputDefaults?: { polarity?: string; pressMirror?: boolean } };
    expect(manifest.outputDefaults?.polarity).toBe("negative");
    expect(manifest.outputDefaults?.pressMirror).toBe(false);

    const negativePlate = await zipFileBytes(
      negative.bytes,
      /(^|[-/])K-plate\.png$/,
    );
    const negativeCorner = await pngPixelSample(page, negativePlate, 5, 5);

    // Pixel truth: plate PNGs are transparent-backed ink. On a POSITIVE
    // the margin pixel carries no ink (alpha 0); on a NEGATIVE the same
    // pixel becomes solid dark ink.
    expect(positiveCorner[3]).toBeLessThan(32);
    expect(negativeCorner[3]).toBeGreaterThan(224);
    expect(
      negativeCorner[0] + negativeCorner[1] + negativeCorner[2],
    ).toBeLessThan(300);
  });

  test("press mirror flips exported composite ink horizontally (pixel probe)", async ({
    page,
  }) => {
    await openStudioWithUpload(page, {
      name: "left-band.svg",
      mimeType: "image/svg+xml",
      buffer: LEFT_BAND_SVG,
    });
    // Transparent background exposes ink bounds through the alpha channel.
    await ensureDrawerExpanded(page, "document");
    await page.getByTestId("artwork-background-transparent").click();

    await topbarButton(page, "Export").click();
    const before = await captureDownload(page, () =>
      page.getByRole("button", { name: /Composite PNG/ }).click(),
    );
    const statsBefore = await pngAlphaStats(page, before.bytes);
    expect(statsBefore.opaqueBounds).not.toBeNull();
    const centerBefore =
      (statsBefore.opaqueBounds!.minX + statsBefore.opaqueBounds!.maxX) / 2;
    expect(centerBefore).toBeLessThan(statsBefore.width / 2);

    await ensureDrawerExpanded(page, "output");
    await drawer(page, "output").getByTestId("output-press-mirror").check();

    await topbarButton(page, "Export").click();
    const after = await captureDownload(page, () =>
      page.getByRole("button", { name: /Composite PNG/ }).click(),
    );
    const statsAfter = await pngAlphaStats(page, after.bytes);
    expect(statsAfter.opaqueBounds).not.toBeNull();
    const centerAfter =
      (statsAfter.opaqueBounds!.minX + statsAfter.opaqueBounds!.maxX) / 2;
    expect(centerAfter).toBeGreaterThan(statsAfter.width / 2);

    // Mirror relation within halftone-cell quantization: the mirrored left
    // edge lands where the original right edge reflected.
    const reflectedMin = statsAfter.width - 1 - statsAfter.opaqueBounds!.maxX;
    expect(Math.abs(reflectedMin - statsBefore.opaqueBounds!.minX)).toBeLessThanOrEqual(
      48,
    );
  });
});
