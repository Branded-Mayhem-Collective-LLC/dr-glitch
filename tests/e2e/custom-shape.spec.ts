import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import {
  activateTool,
  exportPanel,
  openFreshStudio,
  panel,
  topbarButton,
} from "./helpers/workstation";

test.use({ viewport: { width: 1440, height: 1000 } });
const triangle = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path fill="red" d="M60 30L100 90H20Z"/></svg>';
const ring = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path fill-rule="evenodd" d="M20 30H100V90H20Z M40 45V75H80V45Z"/></svg>';

async function screen(page: Page) {
  await activateTool(page, "halftone");
}
async function chooseCustom(page: Page) {
  const select = page.getByRole("combobox", { name: "Dot shape", exact: true });
  await select.focus();
  await select.selectOption("custom");
  await expect(page.getByRole("dialog", { name: "Import custom shape" })).toBeVisible();
}
async function upload(page: Page, name: string, content: string) {
  await page.getByTestId("custom-shape-file").setInputFiles({ name, mimeType: "image/svg+xml", buffer: Buffer.from(content) });
}

test("import popup applies only on confirmation, restores focus, retains shape on reset", async ({ page }) => {
  await openFreshStudio(page);
  await screen(page);
  await chooseCustom(page);
  await expect(page.getByRole("button", { name: "Use shape", exact: true })).toBeDisabled();
  await upload(page, "triangle.svg", triangle);
  await expect(page.getByTestId("custom-shape-filename")).toHaveText("triangle.svg");
  await expect(page.getByRole("button", { name: "Use shape", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use shape", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Choose SVG", exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("custom-svg-import.png") });
  await page.getByRole("button", { name: "Use shape", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const select = page.getByRole("combobox", { name: "Dot shape", exact: true });
  await expect(select).toHaveValue("custom");
  await expect(select).toBeFocused();
  await expect(page.getByTestId("current-custom-shape")).toHaveText("triangle.svg");
  await page.getByRole("button", { name: "Replace SVG", exact: true }).click();
  await upload(page, "bad.svg", '<svg><text>Not outlined</text></svg>');
  await expect(page.getByRole("alert")).toContainText("text to paths");
  await expect(page.getByRole("button", { name: "Use shape", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("current-custom-shape")).toHaveText("triangle.svg");
  await expect(page.getByRole("button", { name: "Replace SVG", exact: true })).toBeFocused();
  await select.selectOption("square");
  await chooseCustom(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(select).toHaveValue("square");
  await panel(page, "halftone").getByRole("button", { name: /Reset halftone/i }).click();
  await expect(select).toHaveValue("round");
  await expect(page.getByTestId("current-custom-shape")).toHaveText("triangle.svg");
  await chooseCustom(page);
  await expect(page.getByTestId("custom-shape-filename")).toHaveText("triangle.svg");
  await page.getByRole("button", { name: "Use shape", exact: true }).click();
  await expect(select).toHaveValue("custom");
});

test("drop import, empty and oversized files, and replacement never alter the current pattern early", async ({ page }) => {
  await openFreshStudio(page);
  await screen(page);
  await chooseCustom(page);
  await upload(page, "empty.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="30" fill="none"/></svg>');
  await expect(page.getByRole("alert")).toContainText("no visible");
  await page.getByTestId("custom-shape-file").setInputFiles({ name: "large.svg", mimeType: "image/svg+xml", buffer: Buffer.alloc(1_000_001, 32) });
  await expect(page.getByRole("alert")).toContainText("1 MB");
  await upload(page, "shape.png", triangle);
  await expect(page.getByRole("alert")).toContainText(".svg file");
  const transfer = await page.evaluateHandle((source) => {
    const data = new DataTransfer();
    data.items.add(new File([source], "ring.svg", { type: "image/svg+xml" }));
    return data;
  }, ring);
  await page.getByTestId("custom-shape-drop").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByTestId("custom-shape-filename")).toHaveText("ring.svg");
  await page.getByRole("button", { name: "Use shape", exact: true }).click();
  await expect(page.getByTestId("current-custom-shape")).toHaveText("ring.svg");
  await page.getByRole("button", { name: "Replace SVG", exact: true }).click();
  await upload(page, "replacement.svg", triangle);
  await expect(page.getByTestId("custom-shape-filename")).toHaveText("replacement.svg");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("current-custom-shape")).toHaveText("ring.svg");
  await page.getByRole("button", { name: "Replace SVG", exact: true }).click();
  await upload(page, "replacement.svg", triangle);
  await expect(page.getByRole("button", { name: "Use shape", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use shape", exact: true }).click();
  await expect(page.getByTestId("current-custom-shape")).toHaveText("replacement.svg");
});

test("visible bounds include transforms and strokes, trim whitespace, stretch to square and preserve holes", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const result = await page.evaluate(async ({ triangle, ring }) => {
    const modulePath = "/src/studio/custom-shape.ts";
    const { importCustomShape, customShapeStamp } = await import(/* @vite-ignore */ modulePath);
    async function inspect(source: string) {
      const asset = await importCustomShape(new File([source], "sample.svg", { type: "image/svg+xml" }));
      const stamp = customShapeStamp(asset, "#101010", 100) as HTMLCanvasElement;
      const context = stamp.getContext("2d")!;
      const alpha = (x: number, y: number) => context.getImageData(Math.round(x * (stamp.width - 1)), Math.round(y * (stamp.height - 1)), 1, 1).data[3];
      const bounds = asset.svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
      return { bounds, center: alpha(.5, .5), upperCenter: alpha(.5, .1), bottomCorner: alpha(.1, .9), topCorner: alpha(.05, .05), edge: alpha(.03, .5) };
    }
    return {
      triangle: await inspect(triangle), ring: await inspect(ring),
      stroke: await inspect('<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(40 50) scale(2 3)"><rect x="0" y="0" width="20" height="10" fill="none" stroke="red" stroke-width="2"/></g></svg>'),
    };
  }, { triangle, ring });
  for (let i = 0; i < 4; i++) expect(result.triangle.bounds[i]).toBeCloseTo([20, 30, 80, 60][i], 0);
  expect(result.triangle.center).toBeGreaterThan(240);
  expect(result.triangle.upperCenter).toBeGreaterThan(240);
  expect(result.triangle.topCorner).toBe(0);
  expect(result.triangle.bottomCorner).toBeGreaterThan(240);
  expect(result.ring.center).toBe(0);
  expect(result.ring.edge).toBeGreaterThan(240);
  for (let i = 0; i < 4; i++) expect(result.stroke.bounds[i]).toBeCloseTo([38, 47, 44, 36][i], 0);
  expect(result.stroke.center).toBe(0);
  expect(result.stroke.edge).toBeGreaterThan(240);
});

test("custom assets round-trip through CMYK and grayscale plate exports and the job ticket", async ({ page }) => {
  test.setTimeout(60_000);
  await openFreshStudio(page);
  await screen(page);
  await chooseCustom(page);
  await upload(page, "ring.svg", ring);
  await expect(page.getByRole("button", { name: "Use shape", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use shape", exact: true }).click();
  await page.getByTestId("numeric-cellSize").fill("40");
  await page.getByTestId("numeric-cellSize").press("Enter");
  await activateTool(page, "plates");
  for (const mode of ["cmyk", "grayscale"]) {
    await activateTool(page, "plates");
    await panel(page, "plates").getByRole("combobox", { name: "Color mode", exact: true }).selectOption(mode);
    await topbarButton(page, "Export").click();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: mode === "cmyk" ? /CMYK plate package/ : /Grayscale K plate package/ }).click();
    const download = await downloadEvent;
    const zip = await JSZip.loadAsync(await readFile((await download.path())!));
    expect(Object.keys(zip.files)).toHaveLength(mode === "cmyk" ? 5 : 2);
    const job = JSON.parse(await zip.file("job-settings.json")!.async("string"));
    expect(job.settings).toMatchObject({ dotShape: "custom", grayscale: mode === "grayscale", customShape: { filename: "ring.svg" } });
    expect(job.settings.customShape.svg).toContain('preserveAspectRatio="none"');
    const exportedK = await zip.file("dr-K-plate.png")!.async("base64");
    const matches = await page.evaluate(async ({ job, exportedK }) => {
      const enginePath = "/src/studio/halftone.ts";
      const schemaPath = "/src/studio/settings-schema.ts";
      const shapePath = "/src/studio/custom-shape.ts";
      const { renderHalftone, createDemoArtwork } = await import(/* @vite-ignore */ enginePath);
      const { parseSettings } = await import(/* @vite-ignore */ schemaPath);
      const { prepareCustomShape } = await import(/* @vite-ignore */ shapePath);
      const parsed = parseSettings(job.settings);
      if (!parsed.ok) return false;
      await prepareCustomShape(parsed.value.customShape);
      const actual = new Image();
      actual.src = `data:image/png;base64,${exportedK}`;
      await actual.decode();
      const canvas = document.createElement("canvas");
      renderHalftone(createDemoArtwork(), canvas, parsed.value, { plate: "black", width: job.output.width, height: job.output.height,
        registration: job.registration, registrationSize: job.registrationSize,
        registrationOffset: job.registrationOffset, registrationWeight: job.registrationWeight,
        registrationShape: job.registrationShape, registrationMode: job.registrationMode,
        paper: job.document.background === "black" ? "#000000" : "#ffffff", monochromePlate: true, document: job.document, transparent: true });
      const context = canvas.getContext("2d")!;
      const expectedPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(actual, 0, 0);
      const actualPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return expectedPixels.every((value, index) => value === actualPixels[index]);
    }, { job, exportedK });
    expect(matches).toBe(true);
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as typeof window & { __customTicket?: string }).__customTicket = text; },
    } });
  });
  await activateTool(page, "export");
  await exportPanel(page).getByRole("button", { name: "Copy job ticket" }).click();
  expect(await page.evaluate(() => (window as typeof window & { __customTicket?: string }).__customTicket)).toContain("Custom SVG: ring.svg (stretched to square)");
});
