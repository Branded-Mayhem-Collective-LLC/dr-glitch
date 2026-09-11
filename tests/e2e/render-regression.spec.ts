import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Canvas fonts/PNG rasterization vary by platform. The Windows baseline was
// verified against the unchanged pre-parity engine; see docs/desktop-parity.md.
const BASELINE = path.join(__dirname, process.platform === "win32"
  ? "baseline-hashes.win32.json" : "baseline-hashes.json");

test("halftone engine renders match committed baseline", async ({ page }) => {
  await page.goto("/tests/e2e/harness.html");
  await page.waitForFunction(
    () => typeof (window as unknown as { renderAll?: unknown }).renderAll === "function",
  );

  const rendered = await page.evaluate(() =>
    (window as never as { renderAll: () => Record<string, string> }).renderAll(),
  );

  const hashes: Record<string, string> = {};
  for (const [plate, dataUrl] of Object.entries(rendered)) {
    hashes[plate] = createHash("sha256").update(dataUrl).digest("hex");
  }

  expect(Object.keys(hashes).sort()).toEqual(
    ["black", "composite", "cyan", "magenta", "yellow"],
  );

  expect(hashes).toEqual(JSON.parse(readFileSync(BASELINE, "utf8")));
});
