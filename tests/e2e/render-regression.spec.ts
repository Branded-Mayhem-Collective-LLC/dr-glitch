import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HalftoneSettings, RenderOptions } from "../../src/studio/halftone";

const hashes = {
  "custom-shape-data.ts": "0c0da8504fc17722b904d1207b854e9f60c1e972f3de8eab28ef42fa005d33ff",
  "custom-shape.ts": "ee93ec246da9179810719930585c73ba901094fa149dd131995039b42850b46d",
  "document-model.ts": "81ade793d57510569b3a77cd91eb810a398cbe6e5c5bf1cbb56c911d478da07d",
  "halftone.ts": "4dbddefeca1e2b2f22154784277ef653189efb5500d9fad7e160fe705c717d6e",
};

test("immutable renderer changes only for the approved diffusion None correction", async ({ page }) => {
  for (const [file, hash] of Object.entries(hashes)) {
    expect(createHash("sha256").update(readFileSync("tests/e2e/fixtures/renderer-3084f80/" + file)).digest("hex")).toBe(hash);
  }
  await page.goto("/tests/e2e/harness.html");
  const result = await page.evaluate(async () => {
    const currentPath = "/src/studio/halftone.ts";
    const referencePath = "/tests/e2e/fixtures/renderer-3084f80/halftone.ts";
    const currentShapesPath = "/src/studio/custom-shape.ts";
    const referenceShapesPath = "/tests/e2e/fixtures/renderer-3084f80/custom-shape.ts";
    const [current, reference, currentShapes, referenceShapes] = await Promise.all([
      import(/* @vite-ignore */ currentPath), import(/* @vite-ignore */ referencePath),
      import(/* @vite-ignore */ currentShapesPath), import(/* @vite-ignore */ referenceShapesPath),
    ]);
    const source = reference.createDemoArtwork(); // SAME canvas, fonts and browser.
    const customShape = { filename: "ring.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M0 0H100V100H0Z M25 25V75H75V25Z"/></svg>' };
    await Promise.all([currentShapes.prepareCustomShape(customShape), referenceShapes.prepareCustomShape(customShape)]);
    const settings: HalftoneSettings = {
      cellSize: 12, frayedXEdge: 0, frayedYEdge: 0, opacity: 1, dotShape: "round", invert: false,
      angles: { cyan: 15, magenta: 75, yellow: 0, black: 45 },
      visible: { cyan: true, magenta: true, yellow: true, black: true },
    };
    const cases: { name: string; settings: HalftoneSettings; options: RenderOptions }[] = [];
    const add = (name: string, changes: Partial<HalftoneSettings>, options: RenderOptions = {}) =>
      cases.push({ name, settings: { ...settings, ...changes }, options: { width: 120, height: 90, ...options } });
    for (const dotShape of ["round", "square", "diamond", "line", "triangle", "cross", "circle-outline", "custom"] as const) {
      for (const plate of ["composite", "cyan", "magenta", "yellow", "black"] as const) add(dotShape + plate, { dotShape, customShape }, { plate });
    }
    for (const diffusionAlgorithm of ["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"] as const) {
      for (const plate of ["composite", "cyan", "magenta", "yellow", "black"] as const) add(diffusionAlgorithm + plate, { diffusionEnabled: true, diffusionAlgorithm }, { plate });
    }
    for (const registrationMode of ["corners", "centered"] as const) {
      for (const custom of [false, true]) add("registration " + registrationMode + custom, {}, {
        registration: true, registrationMode, registrationSize: 10, registrationOffset: 16, registrationWeight: 2,
        registrationShape: custom ? customShape : undefined,
      });
    }
    for (const grayscale of [false, true]) for (const invert of [false, true]) add("glitch " + grayscale + invert, {
      grayscale, invert, frayedXEdge: 14, frayedYEdge: 20, sliceShift: 7, gridWarp: 8, smearDrag: 0.5, bitmapSort: 0.5,
      visible: { cyan: false, magenta: true, yellow: false, black: true },
    }, { paper: invert ? "#000000" : "#ffffff" });
    for (const mirrorDirection of ["horizontal", "vertical"] as const) for (const preview of [false, true]) add("document " + mirrorDirection + preview, {}, {
      width: 180, height: 140, preview,
      document: { sheetSize: "11x15", orientation: "portrait", background: "white", scalePercent: 85, mirrorImage: true, mirrorDirection },
    });
    const a = document.createElement("canvas"), b = document.createElement("canvas");
    const failures: string[] = [];
    for (const entry of cases) {
      reference.renderHalftone(source, a, entry.settings, entry.options);
      current.renderHalftone(source, b, entry.settings, entry.options);
      if (a.width !== b.width || a.height !== b.height) { failures.push(entry.name + ": dimensions"); continue; }
      const expected = a.getContext("2d")!.getImageData(0, 0, a.width, a.height).data;
      const actual = b.getContext("2d")!.getImageData(0, 0, b.width, b.height).data;
      if (!expected.every((value, index) => value === actual[index])) failures.push(entry.name);
    }
    return { count: cases.length, failures };
  });
  expect(result).toEqual({
    count: 82,
    failures: ["nonecomposite", "nonecyan", "nonemagenta", "noneyellow"],
  });
});
