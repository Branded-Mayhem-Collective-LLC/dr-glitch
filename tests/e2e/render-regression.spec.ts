import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, "baseline-hashes.json");

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

  if (!existsSync(BASELINE)) {
    writeFileSync(BASELINE, `${JSON.stringify(hashes, null, 2)}\n`);
    test.info().annotations.push({ type: "baseline", description: "written" });
    return;
  }

  expect(hashes).toEqual(JSON.parse(readFileSync(BASELINE, "utf8")));
});
