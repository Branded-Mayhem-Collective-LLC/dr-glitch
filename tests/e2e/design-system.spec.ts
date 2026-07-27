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
      // Full paint surface: text/background/all four border edges/outline,
      // SVG fill+stroke (icons), and boxShadow's own color component — a
      // hardcoded orange fill or a zero-blur orange box-shadow is just as
      // much a banned-hue violation as a text color, and neither would be
      // caught by the original 4-property list.
      const props = [
        "color",
        "backgroundColor",
        "borderTopColor",
        "borderRightColor",
        "borderBottomColor",
        "borderLeftColor",
        "outlineColor",
        "fill",
        "stroke",
        "boxShadow",
      ];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const s = getComputedStyle(el);
        for (const prop of props) {
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
    // querySelectorAll("*") cannot see ::before/::after — the spec's
    // "hairline crop/registration ticks at panel corners" (§5) are likely
    // implemented as pseudo-elements, so a rounded corner there would be
    // invisible without an explicit pseudo-element sweep.
    const rounded = await page.evaluate(() => {
      const found: string[] = [];
      const check = (el: Element, pseudo?: "::before" | "::after") => {
        const s = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
        if (pseudo && s.content === "none") return; // pseudo-element doesn't render
        const r = s.borderRadius;
        if (r !== "" && r !== "0px" && !r.startsWith("0px 0px 0px 0px")) {
          found.push(`${el.tagName}.${el.className}${pseudo ?? ""}: ${r}`);
        }
      };
      for (const el of Array.from(document.querySelectorAll("*"))) {
        check(el);
        check(el, "::before");
        check(el, "::after");
      }
      return found;
    });

    expect(rounded).toEqual([]);
  });

  test("no gradient backgrounds", async ({ page }) => {
    // Same pseudo-element blind spot as the radius test — a decorative
    // gradient on a ::before is just as much a violation as one on the
    // element itself, and is cheap to add here.
    const gradients = await page.evaluate(() => {
      const found: string[] = [];
      const check = (el: Element, pseudo?: "::before" | "::after") => {
        const s = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
        if (pseudo && s.content === "none") return;
        if (s.backgroundImage.includes("gradient")) {
          found.push(`${el.tagName}.${el.className}${pseudo ?? ""}`);
        }
      };
      for (const el of Array.from(document.querySelectorAll("*"))) {
        check(el);
        check(el, "::before");
        check(el, "::after");
      }
      return found;
    });

    expect(gradients).toEqual([]);
  });

  test("no blurred shadows; offsets only", async ({ page }) => {
    const blurred = await page.evaluate(() => {
      // Chromium's computed boxShadow is a comma-separated list of shadows,
      // e.g. "rgba(0, 0, 0, .35) 0px 2px 4px 0px, rgba(0, 0, 0, .44) 0px 25px 60px 0px".
      // Flattening every px number across the WHOLE string and reading
      // index [2] only works for a single shadow — with two shadows it
      // silently reads the first shadow's blur and can miss blur hiding in
      // the second (or later) one. Split on top-level commas first (commas
      // inside rgb()/rgba() parens must NOT split), then check each
      // shadow's own blur independently.
      const splitShadows = (shadow: string): string[] => {
        const parts: string[] = [];
        let depth = 0;
        let current = "";
        for (const ch of shadow) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        if (current.trim()) parts.push(current.trim());
        return parts;
      };

      const hasBlur = (shadow: string): boolean => {
        if (!shadow || shadow === "none") return false;
        return splitShadows(shadow).some((single) => {
          // Per-shadow computed form: "rgb(r, g, b) Xpx Ypx BLURpx SPREADpx"
          // (optionally with a trailing "inset" token, which is not a px
          // value and doesn't shift the numeric positions).
          const nums = single.match(/-?\d+(\.\d+)?px/g) ?? [];
          const blur = nums[2] ? parseFloat(nums[2]) : 0;
          return blur > 0;
        });
      };

      const found: string[] = [];
      const check = (el: Element, pseudo?: "::before" | "::after") => {
        const s = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
        if (pseudo && s.content === "none") return;
        const shadow = s.boxShadow;
        if (hasBlur(shadow)) {
          found.push(`${el.tagName}.${el.className}${pseudo ?? ""}: ${shadow}`);
        }
      };
      for (const el of Array.from(document.querySelectorAll("*"))) {
        check(el);
        check(el, "::before");
        check(el, "::after");
      }
      return found;
    });

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

  test("numeric readouts use tabular figures", async ({ page }) => {
    // §4: Martian Mono and tabular-nums travel together. Figures that reflow
    // as values change make a production readout hard to scan.
    const offenders = await page.evaluate(() =>
      Array.from(document.querySelectorAll("output, input[inputmode='decimal']"))
        .filter((el) => {
          const s = getComputedStyle(el);
          return (
            s.fontFamily.includes("Martian") &&
            !s.fontVariantNumeric.includes("tabular-nums")
          );
        })
        .map((el) => `${el.tagName}.${el.className}`),
    );
    expect(offenders).toEqual([]);
  });
});
