import { expect, test } from "@playwright/test";
import { captureDownload } from "./helpers/downloads";
import {
  activateTool,
  artboardCanvas,
  boxOf,
  drawer,
  drawerToggle,
  expectRedoState,
  expectUndoState,
  freshSampleProject,
  gotoHome,
  layerRows,
  openSampleProject,
  panel,
  projectCard,
  projectTitle,
  dirtyIndicator,
  readCyanAngle,
  recoveryBanner,
  recoveryStatus,
  reloadIntoProject,
  saveProjectAs,
  setCyanAngle,
  snapshotRows,
  topbarButton,
} from "./helpers/workstation";

test.describe("history — undo and redo", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("layer duplicate and reorder are undoable and redoable", async ({
    page,
  }) => {
    await activateTool(page, "layers");
    await expect(layerRows(page)).toHaveCount(1);
    await expectUndoState(page, false);

    await panel(page, "layers")
      .getByRole("button", { name: "Duplicate Layer", exact: true })
      .click();
    await expect(layerRows(page)).toHaveCount(2);
    await expectUndoState(page, true);

    const orderBefore = await layerRows(page).allTextContents();
    await layerRows(page).last().click();
    await panel(page, "layers")
      .getByRole("button", { name: "Move Layer Up", exact: true })
      .click();
    const orderAfter = await layerRows(page).allTextContents();
    expect(orderAfter).not.toEqual(orderBefore);

    await topbarButton(page, "Undo").click();
    expect(await layerRows(page).allTextContents()).toEqual(orderBefore);
    await topbarButton(page, "Undo").click();
    await expect(layerRows(page)).toHaveCount(1);
    await expectUndoState(page, false);
    await expectRedoState(page, true);

    await topbarButton(page, "Redo").click();
    await expect(layerRows(page)).toHaveCount(2);
  });

  test("transform edits, recipe edits, and document-global edits are undoable", async ({
    page,
  }) => {
    // Transform via the Select/Transform panel numerics.
    await activateTool(page, "select");
    const transformX = panel(page, "select").getByTestId("numeric-transformX");
    const originalX = await transformX.inputValue();
    await transformX.fill(String(Number(originalX) + 100));
    await transformX.press("Enter");
    await expectUndoState(page, true);
    await topbarButton(page, "Undo").click();
    await expect(transformX).toHaveValue(originalX);

    // Recipe via the Halftone panel.
    await activateTool(page, "halftone");
    const cellSize = panel(page, "halftone").getByTestId("numeric-cellSize");
    const originalCell = await cellSize.inputValue();
    await cellSize.fill("24");
    await cellSize.press("Enter");
    await topbarButton(page, "Undo").click();
    await expect(cellSize).toHaveValue(originalCell);

    // Document-global via the Plates panel.
    const originalAngle = await readCyanAngle(page);
    await setCyanAngle(page, "37");
    await topbarButton(page, "Undo").click();
    expect(await readCyanAngle(page)).toBe(originalAngle);
  });

  test("switching layer mode is one undoable action that keeps inactive settings", async ({
    page,
  }) => {
    await activateTool(page, "halftone");
    const cellSize = panel(page, "halftone").getByTestId("numeric-cellSize");
    await cellSize.fill("24");
    await cellSize.press("Enter");

    await activateTool(page, "layers");
    const mode = panel(page, "layers").getByRole("radiogroup", {
      name: "Layer mode",
    });
    await expect(mode.getByRole("radio", { name: "Halftone" })).toBeChecked();
    await mode.getByRole("radio", { name: "Diffusion" }).check();
    await expect(mode.getByRole("radio", { name: "Diffusion" })).toBeChecked();

    // One Undo returns the mode; the halftone settings survived the trip.
    await topbarButton(page, "Undo").click();
    await expect(mode.getByRole("radio", { name: "Halftone" })).toBeChecked();
    await activateTool(page, "halftone");
    await expect(cellSize).toHaveValue("24");
  });

  test("selection, proof plate, and zoom never enter the undo stack", async ({
    page,
  }) => {
    await expectUndoState(page, false);

    await drawerToggle(page, "proof").click();
    const proof = drawer(page, "proof");
    await proof.getByRole("combobox", { name: "Proof plate" }).selectOption("cyan");
    const zoom = proof.getByTestId("numeric-zoom");
    await zoom.fill("90");
    await zoom.press("Enter");
    await proof.getByRole("button", { name: "Fit", exact: true }).click();

    await activateTool(page, "layers");
    await layerRows(page).first().click();

    await expectUndoState(page, false);
  });
});

test.describe("history — recovered work truth", () => {
  test("recovered work is a real, labeled, undoable history entry", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "33");
    await saveProjectAs(page, "Recovered History");
    await setCyanAngle(page, "77");
    await expect(recoveryStatus(page)).toContainText(/recovery/i);

    // Simulated crash: reload without saving → recovery adoption.
    await reloadIntoProject(page, "Recovered History");
    await expect(recoveryBanner(page)).toBeVisible();
    expect(await readCyanAngle(page)).toBe("77");

    // The History panel tells the truth: depth 1, label "Recovered work",
    // and the topbar Undo agrees (no more canUndo-true/"Nothing to undo").
    await expectUndoState(page, true);
    await activateTool(page, "history");
    await expect(page.getByTestId("ws-history-depth")).toContainText(
      "1 undoable edit",
    );
    await expect(page.getByTestId("ws-history-list")).toContainText(
      "Recovered work",
    );

    // Undo returns to the last explicit save; panel and store stay in sync.
    // (readCyanAngle activates the Plates tool, so the History panel is
    // re-activated before each depth assertion.)
    await topbarButton(page, "Undo").click();
    expect(await readCyanAngle(page)).toBe("33");
    await expectUndoState(page, false);
    await expectRedoState(page, true);
    await activateTool(page, "history");
    await expect(page.getByTestId("ws-history-depth")).toContainText(
      /nothing to undo/i,
    );

    // Redo restores the recovered work and the truthful label.
    await topbarButton(page, "Redo").click();
    await expect(page.getByTestId("ws-history-depth")).toContainText(
      "1 undoable edit",
    );
    await expect(page.getByTestId("ws-history-list")).toContainText(
      "Recovered work",
    );
    expect(await readCyanAngle(page)).toBe("77");
  });
});

test.describe("history — transaction coalescing and cancel", () => {
  test.beforeEach(async ({ page }) => {
    await freshSampleProject(page);
  });

  test("a full slider scrub coalesces into exactly one undo transaction", async ({
    page,
  }) => {
    await activateTool(page, "halftone");
    const cellSize = panel(page, "halftone").getByTestId("numeric-cellSize");
    const slider = panel(page, "halftone").getByTestId("numeric-cellSize-slider");
    const original = await cellSize.inputValue();
    await expectUndoState(page, false);

    const box = await boxOf(slider);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    // Many intermediate positions — the scrub must still be ONE transaction.
    for (const fraction of [0.4, 0.5, 0.6, 0.7, 0.8]) {
      await page.mouse.move(box.x + box.width * fraction, y);
    }
    await page.mouse.up();
    const scrubbed = await cellSize.inputValue();
    expect(scrubbed).not.toBe(original);

    await topbarButton(page, "Undo").click();
    await expect(cellSize).toHaveValue(original);
    // Exactly one transaction: the stack is empty again.
    await expectUndoState(page, false);
  });

  test("Escape cancels an in-flight scrub without recording a transaction", async ({
    page,
  }) => {
    await activateTool(page, "halftone");
    const cellSize = panel(page, "halftone").getByTestId("numeric-cellSize");
    const slider = panel(page, "halftone").getByTestId("numeric-cellSize-slider");
    const original = await cellSize.inputValue();
    await expectUndoState(page, false);

    const box = await boxOf(slider);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, y);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    await expect(cellSize).toHaveValue(original);
    await expectUndoState(page, false);
  });

  test("Escape cancels an in-flight layer drag on the artboard", async ({
    page,
  }) => {
    await activateTool(page, "select");
    const transformX = panel(page, "select").getByTestId("numeric-transformX");
    const originalX = await transformX.inputValue();
    await expectUndoState(page, false);

    const canvasBox = await boxOf(artboardCanvas(page));
    const centerX = canvasBox.x + canvasBox.width / 2;
    const centerY = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 60, centerY + 40);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    await expect(transformX).toHaveValue(originalX);
    await expectUndoState(page, false);
  });
});

test.describe("history — guides", () => {
  test("dragging a guide out of the ruler is undoable and redoable", async ({
    page,
  }) => {
    await freshSampleProject(page);
    const ruler = page.getByTestId("ws-ruler-vertical");
    const canvasBox = await boxOf(artboardCanvas(page));
    const rulerBox = await boxOf(ruler);

    await page.mouse.move(
      rulerBox.x + rulerBox.width / 2,
      canvasBox.y + canvasBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.up();

    await expect(page.getByTestId("ws-guide-vertical")).toHaveCount(1);
    await topbarButton(page, "Undo").click();
    await expect(page.getByTestId("ws-guide-vertical")).toHaveCount(0);
    await topbarButton(page, "Redo").click();
    await expect(page.getByTestId("ws-guide-vertical")).toHaveCount(1);
  });
});

test.describe("history — snapshots", () => {
  test("snapshot create, undoable restore, and duplicate-to-new-project", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "44");
    await saveProjectAs(page, "Snapshot Rig");

    // Create.
    await activateTool(page, "history");
    await panel(page, "history")
      .getByRole("button", { name: "Create Snapshot", exact: true })
      .click();
    const createDialog = page.getByRole("dialog", { name: "Create Snapshot" });
    await createDialog
      .getByRole("textbox", { name: "Snapshot name" })
      .fill("Checkpoint A");
    await createDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(snapshotRows(page)).toHaveCount(1);
    await expect(snapshotRows(page).first()).toContainText("Checkpoint A");

    // Restore is one undoable action.
    await setCyanAngle(page, "88");
    await activateTool(page, "history");
    await snapshotRows(page)
      .first()
      .getByRole("button", { name: "Restore Snapshot" })
      .click();
    expect(await readCyanAngle(page)).toBe("44");
    await topbarButton(page, "Undo").click();
    expect(await readCyanAngle(page)).toBe("88");

    // Duplicate to a new unsaved project; current work stays untouched.
    await topbarButton(page, "Save").click();
    await activateTool(page, "history");
    await snapshotRows(page)
      .first()
      .getByRole("button", { name: "Duplicate to New Project" })
      .click();
    await expect(projectTitle(page)).toContainText("Checkpoint A");
    await expect(dirtyIndicator(page)).toBeVisible();
    expect(await readCyanAngle(page)).toBe("44");

    // Leaving the duplicate raises the dirty guard; discard it and confirm
    // the original project still holds its post-snapshot state.
    await topbarButton(page, "Home").click();
    const guard = page.getByRole("dialog", { name: "Unsaved changes" });
    await guard.getByRole("button", { name: "Discard", exact: true }).click();
    await projectCard(page, "Snapshot Rig")
      .getByRole("button", { name: "Open" })
      .click();
    expect(await readCyanAngle(page)).toBe("88");
  });
});

test.describe("history — recipe presets", () => {
  test("preset save, undoable apply, export, and import across a storage wipe", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await activateTool(page, "halftone");
    const halftone = panel(page, "halftone");
    const cellSize = halftone.getByTestId("numeric-cellSize");
    await cellSize.fill("24");
    await cellSize.press("Enter");

    // Save.
    await halftone.getByRole("button", { name: "Save Preset", exact: true }).click();
    const saveDialog = page.getByRole("dialog", { name: "Save Preset" });
    await saveDialog.getByRole("textbox", { name: "Preset name" }).fill("Bold Dots");
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(halftone.getByTestId("ws-preset-select")).toContainText(
      "Bold Dots",
    );

    // Apply is explicit and undoable.
    await cellSize.fill("8");
    await cellSize.press("Enter");
    await halftone.getByTestId("ws-preset-select").selectOption({ label: "Bold Dots" });
    await halftone.getByRole("button", { name: "Apply Preset", exact: true }).click();
    await expect(cellSize).toHaveValue("24");
    await topbarButton(page, "Undo").click();
    await expect(cellSize).toHaveValue("8");

    // Export produces a versioned .drpreset JSON with only recipe fields.
    const { filename, bytes } = await captureDownload(page, async () => {
      await halftone
        .getByRole("button", { name: "Export Preset", exact: true })
        .click();
    });
    expect(filename).toMatch(/\.drpreset$/);
    const preset = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    expect(preset.schema).toBe(1);
    expect(preset.name).toBe("Bold Dots");
    expect(preset.halftone.cellSize).toBe(24);
    expect(preset.mode).toBeTruthy();
    // Presets never carry transform, opacity, plates, or output settings.
    expect(preset.transform).toBeUndefined();
    expect(preset.opacity).toBeUndefined();
    expect(preset.separation).toBeUndefined();
    expect(preset.output).toBeUndefined();

    // Import restores the preset on a wiped device.
    await gotoHome(page);
    await openSampleProject(page);
    await activateTool(page, "halftone");
    await panel(page, "halftone")
      .getByTestId("ws-preset-import-input")
      .setInputFiles({
        name: "bold-dots.drpreset",
        mimeType: "application/json",
        buffer: bytes,
      });
    await expect(panel(page, "halftone").getByTestId("ws-preset-select")).toContainText(
      "Bold Dots",
    );
    await panel(page, "halftone")
      .getByTestId("ws-preset-select")
      .selectOption({ label: "Bold Dots" });
    await panel(page, "halftone")
      .getByRole("button", { name: "Apply Preset", exact: true })
      .click();
    await expect(panel(page, "halftone").getByTestId("numeric-cellSize")).toHaveValue(
      "24",
    );
  });
});
