import { expect, test } from "@playwright/test";

/**
 * Design-system gate for docs/specs/2026-07-27-drglitch-ui-system-design.md.
 * These assertions encode the spec's binding color and geometry law (§3, §5).
 */

const BANNED_HUES = [
  "255, 107, 44",  // --orange        #ff6b2c
  "255, 138, 84",  // --orange-soft   #ff8a54
  "0, 255, 255",   // screen cyan     #00FFFF, banned by §3
];

test.describe("DR.GLITCH design system", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("no element uses a banned hue", async ({ page }) => {
    const offenders = await page.evaluate((banned) => {
      const found: string[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const s = getComputedStyle(el);
        for (const prop of ["color", "backgroundColor", "borderTopColor", "outlineColor"]) {
          const v = s[prop as keyof CSSStyleDeclaration] as string;
          if (typeof v !== "string") continue;
          for (const hue of banned) {
            if (v.includes(hue)) found.push(`${el.tagName}.${el.className} ${prop}=${v}`);
          }
        }
      }
      return found;
    }, BANNED_HUES);

    expect(offenders).toEqual([]);
  });

  test("every element has zero border radius", async ({ page }) => {
    const rounded = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const r = getComputedStyle(el).borderRadius;
          return r !== "" && r !== "0px" && !r.startsWith("0px 0px 0px 0px");
        })
        .map((el) => `${el.tagName}.${el.className}: ${getComputedStyle(el).borderRadius}`),
    );

    expect(rounded).toEqual([]);
  });

  test("no gradient backgrounds", async ({ page }) => {
    const gradients = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .filter((el) => getComputedStyle(el).backgroundImage.includes("gradient"))
        .map((el) => `${el.tagName}.${el.className}`),
    );

    expect(gradients).toEqual([]);
  });

  test("no blurred shadows; offsets only", async ({ page }) => {
    const blurred = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .map((el) => ({ el, shadow: getComputedStyle(el).boxShadow }))
        .filter(({ shadow }) => {
          if (!shadow || shadow === "none") return false;
          // computed form: "rgb(r, g, b) Xpx Ypx BLURpx SPREADpx"
          const nums = shadow.match(/-?\d+(\.\d+)?px/g) ?? [];
          const blur = nums[2] ? parseFloat(nums[2]) : 0;
          return blur > 0;
        })
        .map(({ el, shadow }) => `${el.tagName}.${el.className}: ${shadow}`),
    );

    expect(blurred).toEqual([]);
  });

  test("declared fonts are actually loaded, not fallbacks", async ({ page }) => {
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      // NOTE: document.fonts.check("400 16px <family>") is NOT a reliable
      // "is this @font-face loaded" signal in Chromium — it can return true
      // purely because a locally-installed system font matches the family
      // name, even with zero @font-face rules in the page. The only way to
      // confirm a family was actually delivered via @font-face and finished
      // loading is to look for it in the document's own FontFaceSet.
      const hasLoadedFace = (family: string) =>
        Array.from(document.fonts).some(
          (f) => f.family.replace(/^"|"$/g, "") === family && f.status === "loaded",
        );
      const fontUiRaw = getComputedStyle(document.documentElement).getPropertyValue("--font-ui");
      return {
        archivo: hasLoadedFace("Archivo"),
        mono: hasLoadedFace("Martian Mono"),
        fontFaceCount: document.fonts.size,
        // --font-ui currently reads `var(--font-geist-sans), "Helvetica Neue", Arial, sans-serif`.
        // --font-geist-sans was injected by Next.js next/font, which the
        // Cloudflare port removed, so it's undefined. A custom property that
        // references an undefined var() with no fallback is invalid at
        // computed-value time, so --font-ui itself computes to "" (not to
        // literal "geist" text) and body silently falls back to the UA
        // default serif font. Both an empty value and a literal "geist"
        // reference count as broken.
        brokenFontVar: fontUiRaw === "" || fontUiRaw.includes("geist"),
      };
    });

    expect(loaded.archivo).toBe(true);
    expect(loaded.mono).toBe(true);
    expect(loaded.fontFaceCount).toBeGreaterThan(0);
    expect(loaded.brokenFontVar).toBe(false);
  });
});
