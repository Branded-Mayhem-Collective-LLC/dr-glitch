import { expect, test } from "@playwright/test";

test("diffusion SVG matches raster ink masks and preserves white margins", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const failures = await page.evaluate(async () => {
    const enginePath = "/src/studio/halftone.ts";
    const defaultsPath = "/src/studio/settings-defaults.ts";
    const { renderPlateSvg, renderHalftone } = await import(/* @vite-ignore */ enginePath);
    const { DEFAULT_SETTINGS } = await import(/* @vite-ignore */ defaultsPath);
    const source = document.createElement("canvas"); source.width = 100; source.height = 80;
    const ctx = source.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 100, 80);
    for (let x = 10; x < 90; x++) {
      const value = Math.round((x - 10) / 80 * 255);
      ctx.fillStyle = "rgb(" + value + "," + value + "," + value + ")";
      ctx.fillRect(x, 10, 1, 60);
    }
    const failed: string[] = [];
    for (const diffusionAlgorithm of ["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"]) {
      const settings = { ...DEFAULT_SETTINGS, diffusionEnabled: true, diffusionAlgorithm, grayscale: true };
      const raster = document.createElement("canvas");
      renderHalftone(source, raster, settings, { paper: "#ffffff", plate: "black", monochromePlate: true });
      const expected = raster.getContext("2d")!.getImageData(0, 0, 100, 80).data;
      const svg = renderPlateSvg(source, settings, "black");
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const target = document.createElement("canvas"); target.width = 100; target.height = 80;
        const context = target.getContext("2d")!; context.fillStyle = "#fff"; context.fillRect(0, 0, 100, 80);
        context.drawImage(image, 0, 0, 100, 80);
        const actual = context.getImageData(0, 0, 100, 80).data;
        for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
          const i = (y * 100 + x) * 4;
          const rasterInk = (255 - expected[i]) / 238 >= 0.5;
          const svgInk = (255 - actual[i]) / 255 >= 0.5;
          if (rasterInk !== svgInk || ((x < 10 || x >= 90 || y < 10 || y >= 70) && svgInk)) {
            failed.push(diffusionAlgorithm + ":" + x + "," + y);
          }
        }
      } finally { URL.revokeObjectURL(url); }
    }
    // This valid job passed UI preflight but the old diagonal-loop cap rejected it.
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 100, 80);
    const validDense = renderPlateSvg(source, { ...DEFAULT_SETTINGS, cellSize: 3, grayscale: true, angles: { ...DEFAULT_SETTINGS.angles, black: 0 } }, "black", {
      document: { sheetSize: "11x15", orientation: "portrait", background: "white", scalePercent: 100, mirrorImage: false, mirrorDirection: "horizontal" },
    });
    if (!validDense.includes('viewBox="0 0 2640 3600"')) failed.push("dense dimensions");
    return failed;
  });
  expect(failures).toEqual([]);
});

test("SVG preserves custom holes, diffusion, registration, dimensions, and thick outlines", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const result = await page.evaluate(async () => {
    const enginePath = "/src/studio/halftone.ts";
    const shapesPath = "/src/studio/custom-shape.ts";
    const defaultsPath = "/src/studio/settings-defaults.ts";
    const { renderPlateSvg, renderHalftone } = await import(/* @vite-ignore */ enginePath);
    const { prepareCustomShape, customShapeStamp } = await import(/* @vite-ignore */ shapesPath);
    const { DEFAULT_SETTINGS } = await import(/* @vite-ignore */ defaultsPath);
    const source = document.createElement("canvas");
    source.width = source.height = 100;
    const context = source.getContext("2d")!;
    context.fillStyle = "#000"; context.fillRect(0, 0, 100, 100);
    const ring = { filename: "ring.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M0 0H100V100H0Z M25 25V75H75V25Z"/></svg>' };
    await prepareCustomShape(ring);
    const settings = { ...DEFAULT_SETTINGS, cellSize: 20, angles: { ...DEFAULT_SETTINGS.angles, black: 0 } };
    async function pixels(svg: string) {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const c = document.createElement("canvas"); c.width = c.height = 100;
        const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 100, 100); ctx.drawImage(image, 0, 0, 100, 100);
        const data = ctx.getImageData(0, 0, 100, 100).data;
        return (x: number, y: number) => data[(y * 100 + x) * 4];
      } finally { URL.revokeObjectURL(url); }
    }
    const custom = await pixels(renderPlateSvg(source, { ...settings, dotShape: "custom", customShape: ring }, "black"));
    const diffusion = await pixels(renderPlateSvg(source, { ...settings, diffusionEnabled: true }, "black"));
    const hidden = { ...settings, visible: { ...settings.visible, black: false } };
    const marksSvg = renderPlateSvg(source, hidden, "black", { registration: true, registrationShape: ring, registrationSize: 20, registrationOffset: 15 });
    const marks = await pixels(marksSvg);
    const overlapping = await pixels(renderPlateSvg(source, hidden, "black", { registration: true, registrationShape: ring, registrationSize: 20, registrationOffset: 50 }));
    const centered = await pixels(renderPlateSvg(source, hidden, "black", { registration: true, registrationShape: ring, registrationSize: 20, registrationOffset: 15, registrationMode: "centered" }));
    const outline = await pixels(renderPlateSvg(source, { ...settings, dotShape: "circle-outline", strokeWidth: 20 }, "black"));
    const options = { width: 110, height: 100, document: { sheetSize: "11x15", orientation: "portrait", background: "white", scalePercent: 100, mirrorImage: false, mirrorDirection: "horizontal" } };
    const target = document.createElement("canvas");
    renderHalftone(source, target, settings, options);
    const documentSvg = renderPlateSvg(source, settings, "black", options);
    // Active dot and registration assets survive many discarded candidates.
    await prepareCustomShape(ring);
    const mark = { ...ring, filename: "mark.svg" }; await prepareCustomShape(mark);
    for (let i = 0; i < 12; i++) await prepareCustomShape({ ...ring, filename: "candidate-" + i + ".svg" });
    const cached = [ring, mark].every((asset) => customShapeStamp(asset, "#000", 20).width > 0);
    return {
      customHole: custom(39, 39), customInk: custom(47, 39), diffusionGap: diffusion(29, 29),
      markHole: marks(15, 15), markInk: marks(23, 15), hiddenDot: marks(39, 39),
      overlappingInk: overlapping(58, 50),
      centeredInk: centered(58, 15), removedCorner: centered(23, 15), outlineCenter: outline(39, 39),
      fullHidden: marksSvg.includes('viewBox="0 0 100 100"'),
      dimensions: documentSvg.includes('viewBox="0 0 ' + target.width + " " + target.height + '"'), cached,
    };
  });
  expect(result.customHole).toBeGreaterThan(245);
  expect(result.customInk).toBeLessThan(10);
  expect(result.diffusionGap).toBeLessThan(10);
  expect(result.markHole).toBeGreaterThan(245);
  expect(result.markInk).toBeLessThan(100); // registration alpha is deliberately 0.7
  expect(result.overlappingInk).toBeLessThan(10); // four independent 0.7-alpha marks
  expect(result.hiddenDot).toBeGreaterThan(245);
  expect(result.centeredInk).toBeLessThan(100);
  expect(result.removedCorner).toBeGreaterThan(245);
  expect(result.outlineCenter).toBeLessThan(10);
  expect(result.fullHidden && result.dimensions && result.cached).toBe(true);
});
