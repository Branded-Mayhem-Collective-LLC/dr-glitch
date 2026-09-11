import { expect, test } from "@playwright/test";

test("invalid and stale artwork selections preserve the latest valid source", async ({ page }) => {
  await page.addInitScript(() => {
    const original = File.prototype.slice;
    File.prototype.slice = function (...args) {
      const blob = original.apply(this, args);
      if (this.name === "slow.png") {
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => {
          await new Promise<void>((resolve) => { (window as unknown as { releaseImage: () => void }).releaseImage = resolve; });
          const bytes = await read();
          document.documentElement.dataset.slowImageFinished = "true";
          return bytes;
        };
      }
      return blob;
    };
  });
  await page.goto("/");
  const input = page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]');
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
    return canvas.toDataURL().split(",")[1];
  });
  await input.setInputFiles({ name: "slow.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => typeof (window as unknown as { releaseImage?: unknown }).releaseImage === "function");
  await input.setInputFiles({ name: "latest.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator(".upload-card strong")).toHaveText("latest.png");
  await page.evaluate(() => (window as unknown as { releaseImage: () => void }).releaseImage());
  await page.waitForFunction(() => document.documentElement.dataset.slowImageFinished === "true");
  await expect(page.locator(".upload-card strong")).toHaveText("latest.png");
  await input.setInputFiles({ name: "disguised.jpg", mimeType: "image/jpeg", buffer: Buffer.from("GIF89a") });
  await expect(page.getByRole("status")).toContainText("does not contain");
  await expect(page.locator(".upload-card strong")).toHaveText("latest.png");
  await input.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await expect(page.getByRole("status")).toContainText("could not be opened");
  await expect(page.locator(".upload-card strong")).toHaveText("latest.png");
});

test("late registration imports cannot replace a newer selection or undo reset", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeImage = window.Image;
    window.Image = class extends NativeImage {
      constructor(...args: ConstructorParameters<typeof Image>) {
        super(...args);
        this.addEventListener("load", () => {
          document.documentElement.dataset.loadedImages = String(Number(document.documentElement.dataset.loadedImages ?? 0) + 1);
        });
      }
    };
    const original = File.prototype.text;
    File.prototype.text = async function () {
      if (this.name === "slow.svg") {
        await new Promise<void>((resolve) => { (window as unknown as { releaseMark: () => void }).releaseMark = resolve; });
      }
      return original.call(this);
    };
  });
  await page.goto("/");
  await page.getByTestId("stage-output").click();
  const input = page.locator('input[type="file"][accept=".svg,image/svg+xml"]');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
  await input.setInputFiles({ name: "slow.svg", mimeType: "image/svg+xml", buffer: svg });
  await page.waitForFunction(() => typeof (window as unknown as { releaseMark?: unknown }).releaseMark === "function");
  await input.setInputFiles({ name: "latest.svg", mimeType: "image/svg+xml", buffer: svg });
  await expect(page.getByRole("status")).toContainText("Registration mark loaded: latest.svg");
  await page.evaluate(() => (window as unknown as { releaseMark: () => void }).releaseMark());
  await page.waitForFunction(() => Number(document.documentElement.dataset.loadedImages) >= 4);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByTestId("stage-panel-output").getByText("latest.svg", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Registration mark loaded: latest.svg");
  await input.setInputFiles({ name: "slow.svg", mimeType: "image/svg+xml", buffer: svg });
  await page.getByTestId("stage-panel-output").getByRole("button", { name: /Reset/ }).click();
  await page.evaluate(() => (window as unknown as { releaseMark: () => void }).releaseMark());
  await page.waitForFunction(() => Number(document.documentElement.dataset.loadedImages) >= 6);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole("status")).toContainText("Output controls reset");
  await expect(page.getByRole("button", { name: "Import registration SVG" })).toBeVisible();
});
