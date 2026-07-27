import { expect, test } from "@playwright/test";

test.describe("process motion system", () => {
  test("Blitz landing seed renders four exact process plates", async ({ page }) => {
    await page.goto("/landing");

    await expect(
      page.getByRole("heading", {
        name: "Separate what the screen cannot see.",
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the studio" })).toBeVisible();

    const colors = await page.locator(".blitz-plate").evaluateAll((plates) =>
      plates.map((plate) => getComputedStyle(plate).backgroundColor),
    );
    expect(colors).toEqual([
      "rgb(0, 147, 208)",
      "rgb(230, 0, 126)",
      "rgb(255, 232, 0)",
      "rgb(16, 16, 16)",
    ]);
  });

  test("process action separates plates on hover and keyboard focus", async ({
    page,
  }) => {
    await page.goto("/landing");
    const action = page.getByRole("link", { name: "Open the studio" });
    const cyan = action.locator(".process-action-plate.is-cyan");

    const atRest = await cyan.evaluate((element) => getComputedStyle(element).transform);
    await action.hover();
    await expect
      .poll(() => cyan.evaluate((element) => getComputedStyle(element).transform))
      .not.toBe(atRest);

    await action.focus();
    const focus = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outline: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focus.outline).not.toBe("none");
    expect(focus.width).toBeGreaterThanOrEqual(2);
  });

  test("shared action is used by the product auth surfaces", async ({ page }) => {
    for (const route of ["/login", "/signup"]) {
      await page.goto(route);
      const submit = page.locator("button[type='submit'].process-action");
      await expect(submit).toHaveCount(1);
      await expect(submit.locator(".process-action-plate")).toHaveCount(4);
    }
  });

  test("shared loader is exposed as a labelled four-plate status", async ({
    page,
  }) => {
    await page.goto("/landing");
    const loader = page.getByRole("status", {
      name: "Browser processing active",
    });
    await expect(loader).toBeVisible();
    await expect(loader.locator(".process-loader-plate")).toHaveCount(4);
  });

  test("landing preserves the authored hero lines and primary action on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/landing");

    await expect(page.locator("#landing-title > span")).toHaveCount(3);
    await expect(page.getByRole("link", { name: "Open the studio" })).toBeVisible();

    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(width.document).toBe(width.viewport);
  });

  test("reduced motion registers every supplied motion primitive", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/landing");

    const state = await page.evaluate(() => {
      const selectors = [
        ".blitz-plate",
        ".process-action-plate",
        ".process-loader-plate",
      ];
      return selectors.map((selector) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return {
          selector,
          animation: style.animationName,
          transition: style.transitionDuration,
          transform: style.transform,
        };
      });
    });

    for (const item of state) {
      expect(item.animation, item.selector).toBe("none");
      expect(item.transform, item.selector).toBe("none");
    }
  });

  test("landing motion keeps square geometry and blur-free shadows", async ({
    page,
  }) => {
    await page.goto("/landing");
    const violations = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          ".blitz-plate, .process-action, .process-action-plate, .process-action-label, .process-loader-plate",
        ),
      )
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            element: `${element.tagName}.${element.className}`,
            radius: style.borderRadius,
            shadow: style.boxShadow,
            background: style.backgroundImage,
          };
        })
        .filter(
          ({ radius, shadow, background }) =>
            radius !== "0px" ||
            shadow !== "none" ||
            background.includes("gradient"),
        ),
    );

    expect(violations).toEqual([]);
  });
});
