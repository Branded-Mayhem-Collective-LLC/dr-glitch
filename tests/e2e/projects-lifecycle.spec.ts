import { expect, test } from "@playwright/test";
import { captureDownload } from "./helpers/downloads";
import { QUOTA_SIMULATION_STORAGE_KEY } from "./helpers/storage";
import { openSecondTab, openProjectInTab } from "./helpers/two-tab";
import {
  artboardCanvas,
  dirtyIndicator,
  freshSampleProject,
  goHome,
  gotoHome,
  homeSurface,
  newProjectFromHome,
  openProjectCardMenu,
  openSampleProject,
  projectCard,
  projectCards,
  projectTitle,
  readCyanAngle,
  readonlyBadge,
  recoveryBanner,
  recoveryStatus,
  reloadIntoProject,
  saveProjectAs,
  setCyanAngle,
  topbarButton,
  trashView,
} from "./helpers/workstation";

test.describe("projects — creation, save, persistence", () => {
  test("create, save, and reopen a project with its document state intact", async ({
    page,
  }) => {
    await gotoHome(page);
    await newProjectFromHome(page);
    await expect(projectTitle(page)).toContainText(/untitled/i);

    await setCyanAngle(page, "33");
    await expect(dirtyIndicator(page)).toBeVisible();

    await saveProjectAs(page, "Motor City");
    await expect(projectTitle(page)).toContainText("Motor City");
    await expect(dirtyIndicator(page)).toBeHidden();

    await reloadIntoProject(page, "Motor City");
    expect(await readCyanAngle(page)).toBe("33");
    await expect(dirtyIndicator(page)).toBeHidden();
  });

  test("dirty indicator appears on edit and clears on explicit Save only", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await saveProjectAs(page, "Dirty Tracker");

    await setCyanAngle(page, "21");
    await expect(dirtyIndicator(page)).toBeVisible();

    // The recovery journal flushing does NOT clear the dirty state — only
    // explicit Save updates the canonical project.
    await expect(recoveryStatus(page)).toContainText(/recovery/i);
    await expect(dirtyIndicator(page)).toBeVisible();

    await topbarButton(page, "Save").click();
    await expect(dirtyIndicator(page)).toBeHidden();
  });
});

test.describe("projects — crash recovery", () => {
  test("reload without saving restores the recovery journal as recovered/dirty with Save and Revert offered", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "33");
    await saveProjectAs(page, "Recovery Rig");

    await setCyanAngle(page, "77");
    await expect(dirtyIndicator(page)).toBeVisible();
    // Deterministic journal signal instead of sleeping past the ~750ms debounce.
    await expect(recoveryStatus(page)).toContainText(/recovery/i);

    // Simulated crash: reload without saving.
    await reloadIntoProject(page, "Recovery Rig");

    expect(await readCyanAngle(page)).toBe("77");
    await expect(recoveryBanner(page)).toBeVisible();
    await expect(recoveryBanner(page)).toContainText(/recovered/i);
    await expect(dirtyIndicator(page)).toBeVisible();
    await expect(
      recoveryBanner(page).getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();

    // Revert to Last Save restores the canonical revision.
    await recoveryBanner(page)
      .getByRole("button", { name: "Revert to Last Save", exact: true })
      .click();
    expect(await readCyanAngle(page)).toBe("33");
    await expect(dirtyIndicator(page)).toBeHidden();
    await expect(recoveryBanner(page)).toBeHidden();
  });

  test("saving from the recovery banner promotes the recovered work", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "33");
    await saveProjectAs(page, "Recovery Save");

    await setCyanAngle(page, "55");
    await expect(recoveryStatus(page)).toContainText(/recovery/i);
    await reloadIntoProject(page, "Recovery Save");

    await recoveryBanner(page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(dirtyIndicator(page)).toBeHidden();
    await expect(recoveryBanner(page)).toBeHidden();

    await reloadIntoProject(page, "Recovery Save");
    expect(await readCyanAngle(page)).toBe("55");
  });
});

test.describe("projects — dirty-work guards", () => {
  test("New with dirty work offers Save, Discard, and Cancel", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "33");
    await saveProjectAs(page, "Guarded");
    await setCyanAngle(page, "44");
    await expect(dirtyIndicator(page)).toBeVisible();

    // Cancel keeps the editor and the dirty work.
    await topbarButton(page, "New").click();
    const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
    await expect(dialog).toBeVisible();
    for (const name of ["Save", "Discard", "Cancel"]) {
      await expect(
        dialog.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await readCyanAngle(page)).toBe("44");
    await expect(dirtyIndicator(page)).toBeVisible();

    // Save writes the dirty work, then proceeds to the new project.
    await topbarButton(page, "New").click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(projectTitle(page)).toContainText(/untitled/i);
    await goHome(page);
    await projectCard(page, "Guarded").getByRole("button", { name: "Open" }).click();
    expect(await readCyanAngle(page)).toBe("44");

    // Discard abandons the dirty work.
    await setCyanAngle(page, "55");
    await topbarButton(page, "New").click();
    await dialog.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(projectTitle(page)).toContainText(/untitled/i);
    await goHome(page);
    await projectCard(page, "Guarded").getByRole("button", { name: "Open" }).click();
    expect(await readCyanAngle(page)).toBe("44");
  });
});

test.describe("projects — rename, duplicate, trash", () => {
  test("rename and duplicate from the project card menu", async ({ page }) => {
    await freshSampleProject(page);
    await saveProjectAs(page, "Original Name");
    await goHome(page);

    let menu = await openProjectCardMenu(page, "Original Name");
    await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename Project" });
    await dialog.getByRole("textbox", { name: "Project name" }).fill("Renamed City");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(projectCard(page, "Renamed City")).toHaveCount(1);
    await expect(projectCard(page, "Original Name")).toHaveCount(0);

    menu = await openProjectCardMenu(page, "Renamed City");
    await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    // The duplicate keeps the source title plus a copy marker.
    await expect(projectCards(page)).toHaveCount(2);
    await expect(projectCard(page, /Renamed City/).filter({ hasText: /copy/i })).toHaveCount(1);
  });

  test("Move to Trash, Restore, Delete Permanently, and Empty Trash", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await saveProjectAs(page, "Trash Me");
    await goHome(page);

    // Move to Trash removes it from Recent.
    let menu = await openProjectCardMenu(page, "Trash Me");
    await menu.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
    await expect(projectCard(page, "Trash Me")).toHaveCount(0);

    // Restore brings it back.
    await homeSurface(page).getByRole("button", { name: "Trash", exact: true }).click();
    await expect(trashView(page)).toContainText("Trash Me");
    await trashView(page).getByRole("button", { name: "Restore", exact: true }).click();
    await expect(trashView(page)).not.toContainText("Trash Me");
    await expect(projectCard(page, "Trash Me")).toHaveCount(1);

    // Delete Permanently requires confirmation and is final.
    menu = await openProjectCardMenu(page, "Trash Me");
    await menu.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
    await homeSurface(page).getByRole("button", { name: "Trash", exact: true }).click();
    await trashView(page)
      .getByRole("button", { name: "Delete Permanently", exact: true })
      .click();
    const confirmDelete = page.getByRole("dialog", { name: "Delete Permanently" });
    await confirmDelete
      .getByRole("button", { name: "Delete Permanently", exact: true })
      .click();
    await expect(trashView(page)).not.toContainText("Trash Me");
    await expect(projectCard(page, "Trash Me")).toHaveCount(0);

    // Empty Trash clears everything at once.
    await openSampleProject(page);
    await saveProjectAs(page, "Trash Me Too");
    await goHome(page);
    menu = await openProjectCardMenu(page, "Trash Me Too");
    await menu.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
    await homeSurface(page).getByRole("button", { name: "Trash", exact: true }).click();
    await trashView(page).getByRole("button", { name: "Empty Trash", exact: true }).click();
    const confirmEmpty = page.getByRole("dialog", { name: "Empty Trash" });
    await confirmEmpty.getByRole("button", { name: "Empty Trash", exact: true }).click();
    await expect(trashView(page)).not.toContainText("Trash Me Too");
  });
});

test.describe("projects — portable .drglitch archives", () => {
  test(".drglitch export/import round-trip opens unsaved with a new identity", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "33");
    await saveProjectAs(page, "Round Trip");
    await goHome(page);

    const { filename, bytes } = await captureDownload(page, async () => {
      const menu = await openProjectCardMenu(page, "Round Trip");
      await menu.getByRole("menuitem", { name: "Export Project", exact: true }).click();
    });
    expect(filename).toMatch(/\.drglitch$/);
    // .drglitch is a versioned ZIP.
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K

    // Re-import through Open Project File.
    await page
      .getByTestId("ws-open-project-input")
      .setInputFiles({ name: filename, mimeType: "application/zip", buffer: bytes });
    await expect(artboardCanvas(page)).toBeVisible();
    // Imported projects open unsaved with the source title.
    await expect(projectTitle(page)).toContainText("Round Trip");
    await expect(dirtyIndicator(page)).toBeVisible();
    expect(await readCyanAngle(page)).toBe("33");

    // Saving materializes a second, distinct project — the original card remains.
    await saveProjectAs(page, "Round Trip");
    await goHome(page);
    await expect(projectCard(page, "Round Trip")).toHaveCount(2);
  });
});

test.describe("projects — cross-tab single writer", () => {
  test("a second tab opens read-only and can take ownership", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await saveProjectAs(page, "Shared Sheet");

    const second = await openSecondTab(page);
    await openProjectInTab(second, "Shared Sheet");
    await expect(readonlyBadge(second)).toBeVisible();
    await expect(readonlyBadge(second)).toContainText(/read.?only/i);
    await expect(
      readonlyBadge(second).getByRole("button", { name: "Request Ownership" }),
    ).toBeVisible();
    // The first tab still owns the project.
    await expect(readonlyBadge(page)).toBeHidden();

    // Ownership transfer: second tab becomes the writer, first goes read-only.
    await readonlyBadge(second)
      .getByRole("button", { name: "Request Ownership" })
      .click();
    await expect(readonlyBadge(second)).toBeHidden();
    await expect(readonlyBadge(page)).toBeVisible();

    // The new owner can edit.
    await setCyanAngle(second, "66");
    await expect(dirtyIndicator(second)).toBeVisible();
    await second.close();
  });

  test("a second tab can duplicate instead of taking ownership", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await saveProjectAs(page, "Fork Base");

    const second = await openSecondTab(page);
    await openProjectInTab(second, "Fork Base");
    await expect(readonlyBadge(second)).toBeVisible();

    await readonlyBadge(second)
      .getByRole("button", { name: "Duplicate Project" })
      .click();
    // The duplicate opens as a new unsaved project owned by the second tab.
    await expect(readonlyBadge(second)).toBeHidden();
    await expect(dirtyIndicator(second)).toBeVisible();
    await expect(projectTitle(second)).toContainText(/Fork Base/);
    // The original tab keeps sole ownership of the original.
    await expect(readonlyBadge(page)).toBeHidden();
    await second.close();
  });
});

test.describe("projects — storage pressure", () => {
  // Quota exhaustion cannot be simulated natively from Playwright (mocking
  // navigator.storage.estimate() does not make IndexedDB writes throw, and
  // Chromium has no runtime switch to shrink the origin quota), so dev
  // builds ship a storage-quota injection seam mirroring the export-delay
  // seam idiom: while localStorage["drglitch.debug.simulate-quota"] === "1"
  // every backend WRITE throws a real DOMException QuotaExceededError at
  // exactly the layer IndexedDB would (src/app/storage-quota-seam.ts; the
  // flag is read per write, so it arms and disarms mid-session).
  const QUOTA_FLAG = QUOTA_SIMULATION_STORAGE_KEY;

  test("quota errors preserve in-memory work and the last explicit save", async ({
    page,
  }) => {
    await freshSampleProject(page);
    await setCyanAngle(page, "33");
    await saveProjectAs(page, "Quota Victim");

    // Arm the seam, then edit: the journal write hits the quota failure.
    await page.evaluate((flag) => localStorage.setItem(flag, "1"), QUOTA_FLAG);
    await setCyanAngle(page, "77");

    // The failure surfaces loudly and recovery-safely...
    const alert = page.getByRole("alert").filter({ hasText: /storage is full/i });
    await expect(alert).toBeVisible();
    // ...while the in-memory work is preserved and still marked unsaved.
    expect(await readCyanAngle(page)).toBe("77");
    await expect(dirtyIndicator(page)).toBeVisible();

    // An explicit Save under quota also fails loudly and keeps the work.
    await topbarButton(page, "Save").click();
    await expect(dirtyIndicator(page)).toBeVisible();
    expect(await readCyanAngle(page)).toBe("77");

    // Reload with quota STILL exhausted: nothing could ever be journaled or
    // saved, so the canonical last explicit save must come back clean —
    // recovery-safe, no torn state. (Disarming before the reload instead
    // lets the pending in-memory journal flush on pagehide and recover the
    // "77" as recovered/dirty — also correct, but nondeterministic to
    // assert, so the test pins the always-failing path.)
    await reloadIntoProject(page, "Quota Victim");
    expect(await readCyanAngle(page)).toBe("33");
    await expect(dirtyIndicator(page)).toBeHidden();

    // Disarm: the session is fully usable again.
    await page.evaluate((flag) => localStorage.removeItem(flag), QUOTA_FLAG);
    await setCyanAngle(page, "55");
    await topbarButton(page, "Save").click();
    await expect(dirtyIndicator(page)).toBeHidden();
  });
});
