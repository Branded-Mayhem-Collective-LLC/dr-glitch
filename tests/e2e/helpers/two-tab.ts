import { expect, type Page } from "@playwright/test";
import { artboardCanvas, homeSurface, projectCard } from "./workstation";

/**
 * Opens a second tab in the SAME browser context. Cross-tab ownership uses
 * Web Locks + BroadcastChannel + shared IndexedDB, all of which are scoped
 * to a browser context/profile — two isolated Playwright contexts would not
 * see each other, so "second tab" must mean a second page here.
 */
export async function openSecondTab(page: Page): Promise<Page> {
  const second = await page.context().newPage();
  await second.goto("/");
  await expect(homeSurface(second)).toBeVisible();
  return second;
}

/** Opens a saved project by card title from the home surface of `tab`. */
export async function openProjectInTab(
  tab: Page,
  title: string,
): Promise<void> {
  await projectCard(tab, title).getByRole("button", { name: "Open" }).click();
  await expect(artboardCanvas(tab)).toBeVisible();
}
