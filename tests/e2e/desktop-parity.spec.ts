import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";

test.use({ viewport: { width: 1440, height: 1000 } });

test("diffusion replaces the halftone dot render with source-sampled pixels", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();
  const before = await page.getByTestId("artwork-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.getByTestId("stage-diffusion").click();
  await page.getByRole("checkbox", { name: /Enable diffusion/ }).check();
  await page.waitForTimeout(100);
  const after = await page.getByTestId("artwork-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(after).not.toBe(before);
});

test("grayscale invert and Artboard background controls update the preview", async ({ page }) => {
  await page.goto("/");
  const canvas = page.getByTestId("artwork-canvas");
  await canvas.waitFor();

  await page.getByTestId("stage-halftone-cmyk").click();
  await expect(page.getByTestId("grayscale-invert")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Color mode", exact: true }).selectOption("grayscale");
  await expect(page.getByTestId("grayscale-invert")).toBeVisible();
  const grayscaleBefore = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.getByTestId("grayscale-invert").check();
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(grayscaleBefore);

  await page.getByTestId("stage-artwork").click();
  const backgroundBefore = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.getByTestId("artwork-background-black").click();
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(backgroundBefore);
  await expect(page.getByTestId("artwork-background-black")).toHaveAttribute("aria-pressed", "true");
  const colors = await canvas.evaluate((element) => {
    const image = element as HTMLCanvasElement;
    const context = image.getContext("2d")!;
    return {
      outside: Array.from(context.getImageData(20, 20, 1, 1).data),
      imageArea: Array.from(context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data),
    };
  });
  expect(colors.outside[0]).toBeLessThan(40);
  expect(colors.outside[1]).toBeLessThan(40);
  expect(colors.outside[2]).toBeLessThan(40);
  expect(colors.imageArea[0] + colors.imageArea[1] + colors.imageArea[2]).toBeGreaterThan(40);
});

test("exports vector SVG plates, JPG, and TIFF files", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();

  const exports = [
    {
      label: "Vector SVG plate package",
      extension: ".zip",
      check: async (bytes: Uint8Array) => {
        const zip = await JSZip.loadAsync(bytes);
        const svgFiles = Object.keys(zip.files).filter((name) => name.endsWith(".svg"));
        expect(svgFiles).toEqual(expect.arrayContaining([expect.stringMatching(/\/C\.svg$/), expect.stringMatching(/\/M\.svg$/), expect.stringMatching(/\/Y\.svg$/), expect.stringMatching(/\/K\.svg$/)]));
        const svg = await zip.file(svgFiles[0])!.async("string");
        expect(svg).toContain('fill="#000000"');
        expect(svg).toMatch(/<circle|<rect|<path/);
        return true;
      },
    },
    {
      label: "Composite JPG",
      extension: ".jpg",
      check: async (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8,
    },
    {
      label: "Composite TIFF",
      extension: ".tiff",
      check: async (bytes: Uint8Array) => bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00,
    },
  ] as const;

  for (const item of exports) {
    await page.getByRole("button", { name: "Export" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: new RegExp(item.label) }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(new RegExp(`${item.extension.replace(".", "\\.")}$`));
    const bytes = new Uint8Array(await readFile((await download.path())!));
    expect(await item.check(bytes)).toBe(true);
  }
});

test("frayed X and Y edges cut the halftone field independently", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();
  await page.getByTestId("stage-halftone-cmyk").click();
  const canvas = page.getByTestId("artwork-canvas");
  const before = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());

  await page.getByTestId("numeric-frayedXEdge").fill("100");
  await page.getByTestId("numeric-frayedXEdge").press("Enter");
  const afterX = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  expect(afterX).not.toBe(before);

  await page.getByTestId("numeric-frayedXEdge").fill("0");
  await page.getByTestId("numeric-frayedXEdge").press("Enter");
  await page.getByTestId("numeric-frayedYEdge").fill("100");
  await page.getByTestId("numeric-frayedYEdge").press("Enter");
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(before);
});

test("glitch controls change the source-sampled artboard preview", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();
  await page.getByTestId("stage-glitch").click();
  const before = await page.getByTestId("artwork-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.getByTestId("numeric-sliceShift").fill("80");
  await page.getByTestId("numeric-sliceShift").press("Enter");
  await page.getByTestId("numeric-gridWarp").fill("40");
  await page.getByTestId("numeric-gridWarp").press("Enter");
  await page.waitForTimeout(100);
  const after = await page.getByTestId("artwork-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(after).not.toBe(before);
});

test("every Glitch control changes the halftone-dot preview with diffusion off", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();
  await page.getByTestId("stage-glitch").click();
  const canvas = page.getByTestId("artwork-canvas");
  const controls = [
    ["sliceShift", "80", []],
    ["sliceSize", "60", [["sliceShift", "80"]]],
    ["verticalSliceShift", "80", []],
    ["verticalSliceSize", "60", [["verticalSliceShift", "80"]]],
    ["gridWarp", "80", []],
    ["warpScale", "240", [["gridWarp", "80"]]],
    ["smearDrag", "100", []],
    ["smearLength", "80", [["smearDrag", "100"]]],
    ["macroblockCorrupt", "100", []],
    ["macroblockDropout", "100", [["macroblockCorrupt", "100"]]],
    ["blockShift", "100", []],
    ["blockShiftSize", "40", [["blockShift", "100"]]],
    ["channelDesync", "100", []],
    ["bitmapSort", "100", []],
  ] as const;

  for (const [id, value, prerequisites] of controls) {
    await page.getByRole("button", { name: "Reset Glitch controls" }).click();
    for (const [prerequisiteId, prerequisiteValue] of prerequisites) {
      await page.getByTestId(`numeric-${prerequisiteId}`).fill(prerequisiteValue);
      await page.getByTestId(`numeric-${prerequisiteId}`).press("Enter");
    }
    const before = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    await page.getByTestId(`numeric-${id}`).fill(value);
    await page.getByTestId(`numeric-${id}`).press("Enter");
    await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(before);
  }

  for (const name of ["Vertical smear", "Vertical bitmap sort"]) {
    await page.getByRole("button", { name: "Reset Glitch controls" }).click();
    if (name === "Vertical smear") {
      await page.getByTestId("numeric-smearDrag").fill("100");
      await page.getByTestId("numeric-smearDrag").press("Enter");
    } else {
      await page.getByTestId("numeric-bitmapSort").fill("100");
      await page.getByTestId("numeric-bitmapSort").press("Enter");
    }
    const before = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    await page.getByRole("checkbox", { name }).check();
    await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(before);
  }
});

test("custom registration SVG imports and changes the proof marks", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();
  await page.getByTestId("stage-output").click();
  await page.getByRole("checkbox", { name: /Registration marks/ }).uncheck();
  const before = await page.getByTestId("artwork-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  const input = page.locator('input[type="file"][accept=".svg,image/svg+xml"]');
  await input.setInputFiles({
    name: "custom-registration.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#000" d="M0 0H10V10H0Z"/></svg>'),
  });
  await expect(page.getByTestId("stage-panel-output").getByText("custom-registration.svg")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Registration marks/ })).toBeChecked();
  await page.waitForTimeout(100);
  const after = await page.getByTestId("artwork-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(after).not.toBe(before);
});

test("registration settings change the live artboard preview", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("artwork-canvas").waitFor();
  await page.getByTestId("stage-output").click();
  const canvas = page.getByTestId("artwork-canvas");
  const snapshot = () => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const before = await snapshot();

  await page.getByTestId("numeric-registrationSize").fill("240");
  await page.getByTestId("numeric-registrationSize").press("Enter");
  await expect.poll(snapshot).not.toBe(before);
  const afterSize = await snapshot();

  await page.getByTestId("numeric-registrationOffset").fill("240");
  await page.getByTestId("numeric-registrationOffset").press("Enter");
  await expect.poll(snapshot).not.toBe(afterSize);
  const afterOffset = await snapshot();

  await page.getByTestId("numeric-registrationWeight").fill("8");
  await page.getByTestId("numeric-registrationWeight").press("Enter");
  await expect.poll(snapshot).not.toBe(afterOffset);

  await page.getByRole("combobox", { name: "Registration layout" }).selectOption("centered");
  await expect.poll(snapshot).not.toBe(afterOffset);
});

test("new controls, CMYK restoration, grayscale package and reset", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.waitForSelector('[data-testid="artwork-canvas"]');
  await page.getByTestId("stage-halftone-cmyk").click();
  await page.getByTestId("ink-angle-cyan").fill("33");
  await page.getByTestId("ink-angle-cyan").press("Enter");
  await page.getByTestId("ink-chip-cyan").click();
  await page.getByTestId("ink-chip-magenta").click({ modifiers: ["Alt"] });
  await page.getByTestId("stage-halftone-cmyk").click();
  for (const shape of ["triangle", "cross", "circle-outline"]) {
    await page.getByRole("combobox", { name: "Dot shape", exact: true }).selectOption(shape);
    await expect(page.getByRole("combobox", { name: "Dot shape", exact: true })).toHaveValue(shape);
  }
  const stroke = page.getByTestId("numeric-strokeWidth");
  await stroke.fill("2.5");
  await stroke.press("Enter");
  await page.getByRole("combobox", { name: "Color mode", exact: true }).selectOption("grayscale");
  await page.screenshot({ path: test.info().outputPath("grayscale-screen.png") });
  await expect(page.getByTestId("artboard-label")).toHaveText("Black plate");
  await page.getByTestId("stage-halftone-cmyk").click();
  for (const plate of ["cyan", "magenta", "yellow"]) {
    await expect(page.getByTestId(`ink-chip-${plate}`)).toBeDisabled();
    await expect(page.getByTestId(`ink-angle-${plate}`)).toBeDisabled();
  }
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("1");
  await expect(page.getByTestId("artboard-label")).toHaveText("Black plate");
  await page.getByTestId("stage-halftone-cmyk").click();
  await page.getByRole("combobox", { name: "Color mode", exact: true }).selectOption("cmyk");
  await expect(page.getByTestId("artboard-label")).toHaveText("Cyan plate");
  await page.getByTestId("stage-halftone-cmyk").click();
  await expect(page.getByTestId("ink-angle-cyan")).toHaveValue("33");
  await expect(page.getByTestId("ink-chip-magenta")).toHaveAttribute("data-visible", "false");
  await page.getByTestId("stage-halftone-cmyk").click();
  await page.getByRole("combobox", { name: "Color mode", exact: true }).selectOption("grayscale");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: /Grayscale K plate package/ }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/-K-plates.zip$/);
  const zip = await JSZip.loadAsync(await readFile((await download.path())!));
  expect(Object.keys(zip.files).sort()).toEqual([
    "dr-K-plate.png", "job-settings.json",
  ]);
  const job = JSON.parse(await zip.file("job-settings.json")!.async("string"));
  expect(job.settings).toMatchObject({ dotShape: "circle-outline", strokeWidth: 2.5, grayscale: true });
  expect(job.output).toMatchObject({ dpi: 240, worstPlate: "black", worstAngle: 45 });
  const png = await zip.file("dr-K-plate.png")!.async("uint8array");
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let foundDpi = false;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...png.slice(offset + 4, offset + 8)) === "pHYs") {
      expect(view.getUint32(offset + 8)).toBe(9449);
      foundDpi = true;
    }
    offset += length + 12;
  }
  expect(foundDpi).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        (window as typeof window & { __parityTicket?: string }).__parityTicket = text;
      },
    } });
  });
  await page.getByTestId("stage-output").click();
  await page.getByRole("button", { name: "Copy job ticket" }).click();
  const ticket = await page.evaluate(() => (window as typeof window & { __parityTicket?: string }).__parityTicket);
  expect(ticket).toContain("Color mode: Grayscale (K)");
  expect(ticket).toContain("Outline stroke: 2.5px");
  expect(ticket).toContain("Angles: K 45°");
  expect(ticket).toContain("Enabled plates: K");
  await page.getByTestId("stage-halftone-cmyk").click();
  await page.getByRole("button", { name: "Reset Halftone / CMYK controls" }).click();
  await expect(page.getByRole("combobox", { name: "Color mode", exact: true })).toHaveValue("cmyk");
  await expect(page.getByRole("combobox", { name: "Dot shape", exact: true })).toHaveValue("round");
  await page.getByRole("combobox", { name: "Dot shape", exact: true }).selectOption("circle-outline");
  await expect(stroke).toHaveValue("1");
});

test("grayscale rendering uses K angle, and outline scales with output resolution", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/studio/halftone.ts";
    const { renderHalftone, drawDot } = await import(/* @vite-ignore */ modulePath);
    const source = document.createElement("canvas");
    source.width = source.height = 200;
    const ctx = source.getContext("2d")!;
    ctx.fillStyle = "#888";
    ctx.fillRect(0, 0, 200, 200);
    const settings = {
      cellSize: 24, frayedXEdge: 0, frayedYEdge: 0, opacity: 1, dotShape: "circle-outline", strokeWidth: 2,
      grayscale: true, invert: false,
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
    };
    const target = document.createElement("canvas");
    function render(angles = settings.angles, plate = "composite", width = 200) {
      renderHalftone(source, target, { ...settings, angles }, { plate, width, height: width, paper: "#fff" });
      return target.toDataURL();
    }
    const composite = render();
    const black = render(settings.angles, "black");
    const otherCmy = render({ ...settings.angles, cyan: 99, magenta: 22, yellow: 81 });
    const otherK = render({ ...settings.angles, black: 10 });
    // Capture the actual arc radii used by the renderer at two resolutions.
    const radii: number[] = [];
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(...args) {
      radii.push(args[2]);
      return originalArc.apply(this, args);
    };
    let fullThickness = 0, halfThickness = 0;
    try {
      render();
      fullThickness = radii[0] - radii[1];
      radii.length = 0;
      render(settings.angles, "composite", 100);
      halfThickness = radii[0] - radii[1];
    } finally { CanvasRenderingContext2D.prototype.arc = originalArc; }
    const ringCanvas = document.createElement("canvas");
    ringCanvas.width = ringCanvas.height = 60;
    const pixels = ringCanvas.getContext("2d")!;
    pixels.fillStyle = "black";
    drawDot(pixels, 30, 30, 40, "circle-outline", 3);
    const centerAlpha = pixels.getImageData(30, 30, 1, 1).data[3];
    const ringAlpha = pixels.getImageData(30, 11, 1, 1).data[3];
    return { sameK: composite === black, sameCmy: composite === otherCmy, changedK: composite !== otherK,
      fullThickness, halfThickness, centerAlpha, ringAlpha };
  });
  expect(result).toEqual({ sameK: true, sameCmy: true, changedK: true,
    fullThickness: 2, halfThickness: 1, centerAlpha: 0, ringAlpha: 255 });
});
