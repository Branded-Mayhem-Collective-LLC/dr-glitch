import { expect, test } from "@playwright/test";

test("legacy diffusion exports retain custom-dot settings through raster and vector rendering", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  const receipt = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const { createCurrentEngineRenderService } = await load("/src/export/current-engine.ts");
    const { createEmptyProjectCore, createLayerFromAsset } = await load("/src/project/factory.ts");
    const { importCustomShape } = await load("/src/studio/custom-shape.ts");
    const core = createEmptyProjectCore({ widthPx: 160, heightPx: 200, presetId: "custom" });
    const source = document.createElement("canvas"); source.width = 160; source.height = 200;
    const context = source.getContext("2d")!; context.fillStyle = "#777777"; context.fillRect(0, 0, 160, 200);
    const layer = createLayerFromAsset("a".repeat(64), "Artwork", { width: 160, height: 200 }, core.artboard);
    layer.recipe.mode = "diffusion";
    layer.recipe.halftone.dotShape = "custom";
    layer.recipe.halftone.customShapeAssetId = "b".repeat(64);
    core.layers.push(layer);
    const shape = await importCustomShape(new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'], "dot.svg", { type: "image/svg+xml" }));
    const renderer = createCurrentEngineRenderService({ resolveImage: async () => source, resolveCustomShape: async () => shape,
      assetDimensions: () => ({ width: 160, height: 200, byteLength: 1000 }) });
    const options = { revision: 1, registration: false, matte: null, signal: new AbortController().signal };
    const raster = await renderer.renderPlate(core, "black", options);
    const svg = await renderer.renderPlateSvg(core, "black", options);
    const streamed = new Uint8ClampedArray(raster.data.length);
    let rows = 0;
    await renderer.streamPlates(core, ["black"], options, { beginPlate() {}, endPlate() {},
      writeBand(_plate: string, start: number, count: number, data: Uint8ClampedArray) { streamed.set(data, start * 160 * 4); rows += count; } });
    source.width = source.height = 0;
    return { hasInk: raster.data.some((value: number, index: number) => index % 4 === 3 && value > 0), hasVector: svg.includes("<rect"), rows,
      equal: streamed.every((value, index) => value === raster.data[index]) };
  });
  expect(receipt).toEqual({ hasInk: true, hasVector: true, rows: 200, equal: true });
});
