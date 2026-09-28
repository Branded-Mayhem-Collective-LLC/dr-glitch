import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { captureDownload, expectSinglePhys240Dpi, pngDimensions, expectJfif240Dpi, expectTiffSignature, zipEntryNames, zipFileBytes, zipFileText } from "./helpers/downloads";

async function openStudio(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build your separation" })).toBeVisible();
  await expect.poll(() => page.getByTestId("artwork-canvas").evaluate((node) => (node as HTMLCanvasElement).width)).toBeGreaterThan(300);
}
async function setNumber(page: Page, name: string, value: string) {
  const input = page.getByRole("spinbutton", { name, exact: false });
  await input.fill(value); await input.press("Enter"); await expect(input).toHaveValue(value);
}
const proof = (page: Page) => page.getByTestId("artwork-canvas").evaluate((node) => (node as HTMLCanvasElement).toDataURL());

// Default app tests; the original suite separately covers the isolated workstation.
test("opens the four-step workflow without touching saved workstation data", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("drglitch.workspace-layout.v1", "preserve-existing-layout");
    sessionStorage.setItem("drglitch.last-project.v1", "preserve-existing-project");
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => { document.documentElement.dataset.idbOpened = "true"; return open(...args); };
  });
  await openStudio(page);
  for (const title of ["Artwork", "Screen", "Plate angles", "Output"]) await expect(page.getByRole("heading", { name: new RegExp(title + "$"), level: 2 })).toBeAttached();
  await expect(page.getByTestId("ws-shell")).toHaveCount(0);
  await expect(page.getByTestId("home-surface")).toHaveCount(0);
  await expect(page.locator('[data-testid^="ws-rail-"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => ({
    opened: document.documentElement.dataset.idbOpened ?? null,
    layout: localStorage.getItem("drglitch.workspace-layout.v1"),
    project: sessionStorage.getItem("drglitch.last-project.v1"),
  }))).toEqual({ opened: null, layout: "preserve-existing-layout", project: "preserve-existing-project" });
  expect(errors).toEqual([]);
  await mkdir("work/restoration-artifacts", { recursive: true });
  await page.screenshot({ path: "work/restoration-artifacts/browser-workflow.png" });
});

test("plate selection, native values and grayscale alter the proof without a tool switch", async ({ page }) => {
  await openStudio(page);
  const initial = await proof(page);
  await setNumber(page, "Cell size", "20");
  await expect.poll(() => proof(page)).not.toBe(initial);
  await setNumber(page, "Cyan angle", "22.5");
  await page.getByRole("group", { name: "Preview plate" }).getByRole("button", { name: "C", exact: true }).click();
  await expect(page.getByTestId("artboard-label")).toContainText("Cyan plate");
  await page.getByRole("checkbox", { name: "Cyan visible" }).uncheck();
  await expect(page.getByTestId("artboard-label")).toContainText("hidden");
  await page.getByRole("checkbox", { name: "Grayscale (K only)" }).check();
  await expect(page.getByRole("spinbutton", { name: "Cyan angle" })).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "Black angle" })).toBeEnabled();
  await page.getByRole("checkbox", { name: "Grayscale (K only)" }).uncheck();
  await expect(page.getByRole("spinbutton", { name: "Cyan angle" })).toHaveValue("22.5");
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "Cyan angle" })).toHaveValue("15");
});

test("imports replace the sole artwork and invalid input preserves it", async ({ page }) => {
  await openStudio(page);
  await setNumber(page, "Cell size", "24");
  await setNumber(page, "Scale", "75");
  const fileInput = page.locator('input[type="file"][accept^="image/png"]');
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 40; canvas.height = 30;
    canvas.getContext("2d")!.fillRect(0, 0, 40, 30); return canvas.toDataURL().split(",")[1];
  });
  for (const name of ["first.png", "second.png"]) {
    await fileInput.setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect(page.locator(".browser-upload strong")).toHaveText(name);
    await expect(page.getByRole("spinbutton", { name: "Cell size" })).toHaveValue("24");
    await expect(page.getByRole("spinbutton", { name: "Scale" })).toHaveValue("75");
  }
  await fileInput.setInputFiles({ name: "disguised.png", mimeType: "image/png", buffer: Buffer.from("GIF89a") });
  await expect(page.getByRole("status")).toContainText(/does not contain|signature|invalid/i);
  await expect(page.locator(".browser-upload strong")).toHaveText("second.png");
  await page.getByRole("button", { name: "Fit artwork to sheet" }).click();
  await expect(page.getByRole("spinbutton", { name: "Scale" })).toHaveValue("400");
});

test("document settings remain usable below the workstation size gate", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 740 });
  await openStudio(page);
  await page.getByRole("combobox", { name: "Sheet size", exact: true }).selectOption("8x10");
  await page.getByRole("combobox", { name: "Orientation", exact: true }).selectOption("landscape");
  await expect(page.getByText("2400 × 1920 px · 240 DPI", { exact: true })).toBeVisible();
  const before = await proof(page);
  await page.getByRole("checkbox", { name: "Mirror artwork", exact: true }).check();
  await page.getByRole("combobox", { name: "Mirror direction", exact: true }).selectOption("vertical");
  await expect.poll(() => proof(page)).not.toBe(before);
  await expect(page.getByTestId("ws-size-gate")).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.getByTestId("artwork-canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open artwork", exact: true })).toBeVisible();
});

test("all retained quick exports deliver real files with full sheet size and metadata", async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  await page.getByRole("combobox", { name: "Sheet size", exact: true }).selectOption("8x10");
  await page.getByRole("combobox", { name: "Orientation", exact: true }).selectOption("portrait");
  await setNumber(page, "Cell size", "32");
  for (const format of ["Composite PNG", "Composite JPG", "Composite TIFF", "CMYK plate package", "Vector SVG plate package"]) {
    const result = await captureDownload(page, async () => {
      await page.locator(".browser-export-menu summary").click();
      await page.locator(".browser-export-menu").getByRole("button", { name: format, exact: true }).click();
    });
    if (format === "Composite PNG") { expectSinglePhys240Dpi(result.bytes); expect(pngDimensions(result.bytes)).toEqual({ width: 1920, height: 2400 }); }
    if (format === "Composite JPG") expectJfif240Dpi(result.bytes);
    if (format === "Composite TIFF") expectTiffSignature(result.bytes);
    if (format === "CMYK plate package") {
      const names = await zipEntryNames(result.bytes); const plates = names.filter((name) => name.endsWith(".png"));
      expect(plates).toHaveLength(4);
      for (const plate of plates) { const bytes = await zipFileBytes(result.bytes, plate); expectSinglePhys240Dpi(bytes); expect(pngDimensions(bytes)).toEqual({ width: 1920, height: 2400 }); }
      expect(names.some((name) => name.endsWith("job-settings.json"))).toBe(true);
    }
    if (format === "Vector SVG plate package") {
      const names = await zipEntryNames(result.bytes); const plates = names.filter((name) => name.endsWith(".svg"));
      expect(plates).toHaveLength(4);
      expect(await zipFileText(result.bytes, plates[0])).toContain('viewBox="0 0 1920 2400"');
    }
  }
});

test("dense export refuses before delivery and keeps the chosen cell size", async ({ page }) => {
  await openStudio(page);
  await page.getByRole("combobox", { name: "Sheet size", exact: true }).selectOption("15x22");
  await setNumber(page, "Cell size", "3");
  let downloaded = false; page.on("download", () => { downloaded = true; });
  await page.locator(".browser-export-menu summary").click();
  await page.locator(".browser-export-menu").getByRole("button", { name: "Vector SVG plate package", exact: true }).click();
  await expect(page.locator(".browser-export-error")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Cell size" })).toHaveValue("3");
  expect(downloaded).toBe(false);
});
