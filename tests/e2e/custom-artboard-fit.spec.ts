import { expect, test } from "@playwright/test";
import { activateTool, ensureDrawerExpanded, freshSampleProject, topbarButton } from "./helpers/workstation";

test("Fit uses the custom artboard and restores the previous placement in one undo", async ({ page }) => {
  await freshSampleProject(page);
  await activateTool(page, "select");
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 320;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#805040"; context.fillRect(0, 0, 256, 320);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp,image/svg+xml"]').setInputFiles({
    name: "fit-fixture.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.getByRole("status")).toContainText("Artwork loaded");
  await ensureDrawerExpanded(page, "document");
  await page.getByTestId("ws-drawer-document").getByRole("button", { name: "px", exact: true }).click();
  await page.getByTestId("artboard-custom-width").fill("640");
  await page.getByTestId("artboard-custom-height").fill("800");
  await page.getByTestId("artboard-custom-apply").click();
  const fields = ["transformX", "transformY", "transformScaleX", "transformScaleY"];
  const previous = await Promise.all(fields.map((id) => page.getByTestId(`numeric-${id}`).inputValue()));
  await page.getByTestId("artwork-fit").click();
  for (const [index, value] of ["320", "400", "250", "250"].entries()) {
    await expect(page.getByTestId(`numeric-${fields[index]}`)).toHaveValue(value);
  }
  await expect(page.getByTestId("document-dimensions")).toContainText("640");
  await topbarButton(page, "Undo").click();
  for (const [index, value] of previous.entries()) {
    await expect(page.getByTestId(`numeric-${fields[index]}`)).toHaveValue(value);
  }
  await expect(page.getByTestId("document-dimensions")).toContainText("640");
});
