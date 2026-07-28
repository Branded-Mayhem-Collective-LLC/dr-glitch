import { expect, test, type Page } from "@playwright/test";

const AUTH_ROUTES = [
  { path: "/login", heading: "Sign in", action: "Sign in" },
  { path: "/signup", heading: "Create an account", action: "Create account" },
] as const;

async function appendAlert(page: Page) {
  await page.locator(".auth-form").evaluate((form) => {
    const alert = document.createElement("p");
    alert.setAttribute("role", "alert");
    alert.textContent = "A test error";
    form.appendChild(alert);
  });
}

test.describe("DR.GLITCH auth surfaces", () => {
  for (const { path, heading, action } of AUTH_ROUTES) {
    test(`${path} uses the approved wordmark and print-system geometry`, async ({ page }) => {
      await page.goto(path);

      const wordmark = page.locator("h1.auth-wordmark.glitch");
      await expect(wordmark).toHaveText("DR.GLITCH");
      await expect(wordmark).toHaveAttribute("data-text", "DR.GLITCH");
      await expect(page.getByRole("heading", { name: heading, level: 2 })).toBeVisible();

      const atRest = await wordmark.evaluate((element) => ({
        before: getComputedStyle(element, "::before").transform,
        after: getComputedStyle(element, "::after").transform,
        beforeDisplay: getComputedStyle(element, "::before").display,
        afterDisplay: getComputedStyle(element, "::after").display,
      }));
      expect(atRest.beforeDisplay).toBe("block");
      expect(atRest.afterDisplay).toBe("block");
      expect(atRest.before).not.toBe(atRest.after);

      await wordmark.hover();
      await expect
        .poll(() =>
          wordmark.evaluate((element) => ({
            before: getComputedStyle(element, "::before").transform,
            after: getComputedStyle(element, "::after").transform,
          })),
        )
        .toEqual({
          before: "matrix(1, 0, 0, 1, 0, 0)",
          after: "matrix(1, 0, 0, 1, 0, 0)",
        });

      const rounded = await page.locator(".auth-card *").evaluateAll((elements) =>
        elements
          .filter((element) => getComputedStyle(element).borderRadius !== "0px")
          .map((element) => `${element.tagName}.${element.className}`),
      );
      expect(rounded).toEqual([]);

      const cardShadow = await page.locator(".auth-card").evaluate((element) => {
        const shadow = getComputedStyle(element).boxShadow;
        const lengths = shadow.match(/-?\d+(?:\.\d+)?px/g)?.map(Number.parseFloat) ?? [];
        return { shadow, lengths };
      });
      expect(cardShadow.shadow).toContain("rgb(16, 16, 16)");
      expect(cardShadow.lengths).toEqual([2, 2, 0, 0]);
    });

    test(`${path} exposes visible focus and 40px form controls`, async ({ page }) => {
      await page.goto(path);

      const email = page.getByRole("textbox", { name: "Email" });
      await email.focus();
      const focus = await email.evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          style: styles.outlineStyle,
          width: Number.parseFloat(styles.outlineWidth),
        };
      });
      expect(focus.style).not.toBe("none");
      expect(focus.width).toBeGreaterThanOrEqual(2);

      const button = page.getByRole("button", { name: action });
      const [inputBox, buttonBox] = await Promise.all([email.boundingBox(), button.boundingBox()]);
      expect(inputBox!.height).toBeGreaterThanOrEqual(40);
      expect(buttonBox!.height).toBeGreaterThanOrEqual(40);
    });

    test(`${path} renders hazards as black on yellow`, async ({ page }) => {
      await page.goto(path);
      await appendAlert(page);

      const colors = await page.getByRole("alert").evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.backgroundColor,
          foreground: styles.color,
        };
      });
      expect(colors).toEqual({
        background: "rgb(255, 232, 0)",
        foreground: "rgb(16, 16, 16)",
      });
    });
  }
});

test("session badge remains registered, unshadowed, and inside the studio token scope", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector("canvas");

  const badge = page.getByTestId("session-badge");
  await expect(badge).toBeVisible();
  await expect(badge.locator(".glitch")).toHaveCount(0);
  await expect(badge).toHaveCSS("box-shadow", "none");
  expect(
    await badge.evaluate((element) => Boolean(element.closest("[data-studio-root]"))),
  ).toBe(true);

  const action = page.getByTestId("session-badge-action");
  const box = await action.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(64);
  expect(box!.height).toBeGreaterThanOrEqual(32);
});

test("session badge focus follows the selected plate ink with a black inner rule", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector("canvas");
  await page.getByTestId("stage-separation").click();

  const action = page.getByTestId("session-badge-action");
  for (const [plate, color] of [
    ["cyan", "rgb(0, 147, 208)"],
    ["magenta", "rgb(230, 0, 126)"],
  ] as const) {
    await page.getByTestId(`ink-chip-${plate}`).click();
    await action.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();

    const focus = await action.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        outlineColor: styles.outlineColor,
        outlineWidth: styles.outlineWidth,
        boxShadow: styles.boxShadow,
      };
    });
    expect(focus.outlineColor).toBe(color);
    expect(focus.outlineWidth).toBe("2px");
    expect(focus.boxShadow).toContain("rgb(16, 16, 16) 0px 0px 0px 1px inset");
  }
});
