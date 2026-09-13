import { expect, test } from "@playwright/test";

test("custom registration bands match the full canvas across polarity, mirror and layout", async ({ page }) => {
  await page.goto("/");
  const receipt = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const { prepareRegistrationRows } = await load("/src/app/registration-rows.ts");
    const { prepareCustomShape, customShapeStamp } = await load("/src/studio/custom-shape.ts");
    const { registrationPoints, invertPlateInkRows, mirrorRgbaRowsHorizontal } = await load("/src/export/output-transforms.ts");
    const { MemoryLedger, setAllocationObserver } = await load("/src/render/instrumentation.ts");
    const shape = { filename: "asymmetric.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V3H4V10H0Z" fill="#000000"/></svg>' };
    await prepareCustomShape(shape);
    const width = 101, height = 97;
    const mismatches: string[] = [];
    let peak = 0;
    for (const mode of ["corners", "centered"]) for (const negative of [false, true]) for (const mirror of [false, true]) {
      const registration = { size: 33.5, offset: 23.25, weight: 2, mode, customShapeAssetId: "a".repeat(64) };
      const source = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < source.length; i += 4) {
        source.set([17, 18, 20, (i * 29) % 256], i);
      }
      if (negative) invertPlateInkRows(source);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.putImageData(new ImageData(source.slice(), width, height), 0, 0);
      ctx.globalAlpha = 0.7;
      const { points, size } = registrationPoints(registration, width, height);
      const stamp = customShapeStamp(shape, "#121416", size * 2);
      for (const [x, y] of points) ctx.drawImage(stamp, x - size / 2, y - size / 2, size, size);
      const expected = ctx.getImageData(0, 0, width, height).data;
      if (mirror) mirrorRgbaRowsHorizontal(expected, width);
      canvas.width = canvas.height = 0;
      const ledger = new MemoryLedger();
      setAllocationObserver(ledger);
      const painter = await prepareRegistrationRows(shape, registration, width, height);
      const actual = source.slice();
      let row = 0;
      for (const count of [1, 13, 32, 51]) {
        const band = actual.subarray(row * width * 4, (row + count) * width * 4);
        await painter.paintRows(band, row, count);
        if (mirror) mirrorRgbaRowsHorizontal(band, width);
        row += count;
      }
      painter.dispose(); painter.dispose();
      peak = Math.max(peak, ledger.peakBytes);
      if (ledger.currentBytes !== 0) mismatches.push("retained allocation");
      const diff = actual.reduce((n, value, i) => n + (value !== expected[i] ? 1 : 0), 0);
      if (diff) mismatches.push(`${mode}/${negative}/${mirror}: ${diff} bytes`);
      setAllocationObserver(null);
    }
    return { mismatches, peak };
  });
  expect(receipt.mismatches).toEqual([]);
  expect(receipt.peak).toBeLessThan(150_000);
});

test("custom registration cancellation releases its stamp and bounded canvas", async ({ page }) => {
  await page.goto("/");
  const receipt = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const { prepareRegistrationRows } = await load("/src/app/registration-rows.ts");
    const { MemoryLedger, setAllocationObserver } = await load("/src/render/instrumentation.ts");
    const ledger = new MemoryLedger();
    setAllocationObserver(ledger);
    const controller = new AbortController();
    const painter = await prepareRegistrationRows({ filename: "mark.svg", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' },
      { size: 90, offset: 40, weight: 1, mode: "corners", customShapeAssetId: "a".repeat(64) }, 3600, 5280, controller.signal);
    // Abort while a multi-chunk band is yielding, after its first canvas.
    const pending = painter.paintRows(new Uint8ClampedArray(3600 * 128 * 4), 0, 128);
    controller.abort();
    let errorName = "";
    try { await pending; } catch (error) { errorName = (error as Error).name; }
    painter.dispose();
    setAllocationObserver(null);
    return { errorName, current: ledger.currentBytes, peak: ledger.peakBytes };
  });
  expect(receipt.errorName).toBe("AbortError");
  expect(receipt.current).toBe(0);
  expect(receipt.peak).toBeLessThan(2 * 1024 * 1024);
});
