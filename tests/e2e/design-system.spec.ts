import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Design-system gate for docs/specs/2026-07-27-drglitch-ui-system-design.md.
 * These assertions encode the spec's binding color and geometry law (§3, §5).
 */

const BANNED_HUES = [
  "255, 107, 44",  // --orange        #ff6b2c
  "255, 138, 84",  // --orange-soft   #ff8a54
  "0, 255, 255",   // screen cyan     #00FFFF, banned by §3
];

const DECLARED_COLORS = new Set([
  "0,147,208",   // process cyan
  "230,0,126",   // process magenta
  "255,232,0",   // process yellow
  "16,16,16",    // process black / rule
  "244,241,233", // paper
  "233,229,218", // paper-2
  "221,216,203", // paper-3
  "184,178,164", // rule-soft
  "29,29,29",    // stage
  "36,36,36",    // stage-2
  "54,54,54",    // stage-rule
]);


// Authored artboard treatment from GitHub main 3084f80. These are exact
// selector/property/value exceptions, not additions to the global palette.
const ARTBOARD_SOURCE: Record<string, Record<string, string>> = {
  ".canvas-stage": { background: "#3d3e40", "box-shadow": "inset 0 0 0 1px #222324" },
  ".stage-toolbar, .stage-footer": { background: "#363739" },
  ".stage-body": { background: "#2e2f31" },
  ".canvas-scroll": { "background-color": "#707174", border: "6px solid #2e2f31", "box-shadow": "inset 0 0 0 1px #85868a, inset 0 0 0 3px #555659" },
  ".artboard-wrap": { border: "2px solid #c82828", background: "#f8f7f2", "box-shadow": "0 0 0 5px #252628, 0 8px 18px rgba(0, 0, 0, 0.28)" },
  ".artboard-label": { color: "#e1e1e1" },
};
const borderPaint = (color: string) => ({
  borderTopColor: color, borderRightColor: color, borderBottomColor: color, borderLeftColor: color,
});
const ARTBOARD_COMPUTED: Record<string, Record<string, string>> = {
  ".canvas-stage": { backgroundColor: "rgb(61, 62, 64)", boxShadow: "rgb(34, 35, 36) 0px 0px 0px 1px inset" },
  ".stage-toolbar, .stage-footer": { backgroundColor: "rgb(54, 55, 57)" },
  ".stage-body": { backgroundColor: "rgb(46, 47, 49)" },
  ".canvas-scroll": { backgroundColor: "rgb(112, 113, 116)", ...borderPaint("rgb(46, 47, 49)"), boxShadow: "rgb(133, 134, 138) 0px 0px 0px 1px inset, rgb(85, 86, 89) 0px 0px 0px 3px inset" },
  ".artboard-wrap": { backgroundColor: "rgb(248, 247, 242)", ...borderPaint("rgb(200, 40, 40)"), boxShadow: "rgb(37, 38, 40) 0px 0px 0px 5px, rgba(0, 0, 0, 0.28) 0px 8px 18px 0px" },
  ".artboard-label": { color: "rgb(225, 225, 225)", outlineColor: "rgb(225, 225, 225)", ...borderPaint("rgb(225, 225, 225)") },
};

async function auditComputedPaint(page: Page): Promise<string[]> {
  return page.evaluate(({ declared, artboard }) => {
    const permitted = new Set(declared);
    const properties = [
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
    ] as const;
    const colorFunctions = new Set([
      "rgb",
      "rgba",
      "hsl",
      "hsla",
      "hwb",
      "lab",
      "lch",
      "oklab",
      "oklch",
      "color",
      "color-mix",
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const out: string[] = [];

    const normalize = (candidate: string, currentColor: string) => {
      const value =
        candidate.trim().toLowerCase() === "currentcolor"
          ? currentColor
          : candidate.trim();
      if (!CSS.supports("color", value)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };

    const auditColor = (
      candidate: string,
      label: string,
      currentColor: string,
    ) => {
      const rgba = normalize(candidate, currentColor);
      if (!rgba) {
        out.push(`${label}=UNNORMALIZABLE(${candidate})`);
        return;
      }
      const [red, green, blue, alpha] = rgba;
      if (alpha === 0) return;
      if (alpha !== 255 || !permitted.has(`${red},${green},${blue}`)) {
        out.push(`${label}=${candidate} -> rgba(${rgba.join(",")})`);
      }
    };

    const splitTopLevel = (value: string) => {
      const parts: string[] = [];
      let depth = 0;
      let current = "";
      for (const character of value) {
        if (character === "(") depth++;
        if (character === ")") depth--;
        if (character === "," && depth === 0) {
          parts.push(current.trim());
          current = "";
        } else {
          current += character;
        }
      }
      if (current.trim()) parts.push(current.trim());
      return parts;
    };

    const extractFunctions = (value: string) => {
      const colors: string[] = [];
      let residue = "";
      for (let index = 0; index < value.length; ) {
        const match = value.slice(index).match(/^([a-z-]+)\(/i);
        if (!match || !colorFunctions.has(match[1].toLowerCase())) {
          residue += value[index];
          index++;
          continue;
        }
        let depth = 0;
        let end = index;
        for (; end < value.length; end++) {
          if (value[end] === "(") depth++;
          if (value[end] === ")") {
            depth--;
            if (depth === 0) {
              end++;
              break;
            }
          }
        }
        colors.push(value.slice(index, end));
        residue += " ";
        index = end;
      }
      return { colors, residue };
    };

    const auditShadow = (
      value: string,
      label: string,
      currentColor: string,
    ) => {
      for (const shadow of splitTopLevel(value)) {
        const extracted = extractFunctions(shadow);
        let residue = extracted.residue;
        const candidates = [...extracted.colors];
        for (const match of residue.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
          candidates.push(match[0]);
        }
        residue = residue.replace(/#[0-9a-f]{3,8}\b/gi, " ");
        residue = residue
          .replace(/-?\d*\.?\d+(?:px|em|rem|%)?/gi, " ")
          .replace(/\binset\b/gi, " ")
          .replace(/,/g, " ")
          .trim();
        if (residue) candidates.push(residue);
        if (candidates.length === 0) {
          out.push(`${label}=UNNORMALIZABLE(${shadow})`);
          continue;
        }
        for (const candidate of candidates) {
          auditColor(candidate, label, currentColor);
        }
      }
    };

    const check = (
      element: Element,
      pseudo?: "::before" | "::after",
    ) => {
      const styles = getComputedStyle(element, pseudo);
      if (pseudo && styles.content === "none") return;
      for (const property of properties) {
        if (
          (property === "fill" || property === "stroke") &&
          !(element instanceof SVGElement)
        ) {
          continue;
        }
        const value = styles[property];
        if (!pseudo && Object.entries(artboard).some(([selector, allowed]) => element.matches(selector) && allowed[property] === value)) continue;
        if (!value || value === "none" || value === "transparent") continue;
        const label = `${element.tagName}.${element.className}${pseudo ?? ""} ${property}`;
        if (property === "boxShadow") {
          auditShadow(value, label, styles.color);
        } else {
          auditColor(value, label, styles.color);
        }
      }
    };

    for (const element of Array.from(document.querySelectorAll("*"))) {
      check(element);
      check(element, "::before");
      check(element, "::after");
    }
    return out;
  }, { declared: [...DECLARED_COLORS], artboard: ARTBOARD_COMPUTED });
}

async function auditStylesheetSource(
  page: Page,
  css: string,
): Promise<string[]> {
  return page.evaluate(
    ({ source, declared, artboard }) => {
      const permitted = new Set(declared);
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^{}]+)\{([^{}]*)\}/g, (rule, selector: string, body: string) => {
        const allowed = artboard[selector.trim().replace(/\s+/g, " ")];
        if (!allowed) return rule;
        return selector + "{" + body.split(";").map((declaration) => {
          const colon = declaration.indexOf(":");
          const property = declaration.slice(0, colon).trim();
          const value = declaration.slice(colon + 1).trim();
          return allowed[property] === value ? "" : declaration;
        }).join(";") + "}";
      });
      const decoded = withoutComments.replace(/%[0-9a-f]{2}/gi, (escape) =>
        String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
      );
      const out: string[] = [];
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const allowedKeywords = new Set(["transparent", "currentcolor", "none"]);

      const auditColor = (candidate: string, label: string) => {
        const value = candidate.trim();
        if (allowedKeywords.has(value.toLowerCase())) return;
        if (!CSS.supports("color", value)) return;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = Array.from(
          context.getImageData(0, 0, 1, 1).data,
        );
        if (alpha === 0) return;
        if (alpha !== 255 || !permitted.has(`${red},${green},${blue}`)) {
          out.push(`${label}=${value}`);
        }
      };

      for (const match of decoded.matchAll(
        /\b(?:oklch|oklab|lab|lch|hsl|hsla|hwb|color|color-mix)\s*\([^;}]*/gi,
      )) {
        out.push(`modern-color=${match[0].trim()}`);
      }

      for (const match of decoded.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        auditColor(match[0], "literal");
      }
      for (const match of decoded.matchAll(
        /rgba?\(\s*[^)]*\)/gi,
      )) {
        auditColor(match[0], "literal");
      }

      for (const match of decoded.matchAll(
        /\b(?:fill|stroke)\s*=\s*(['"]?)([^'"\s>]+)/gi,
      )) {
        auditColor(match[2], "data-svg");
      }

      const paintDeclaration =
        /(?:^|[;{])\s*((?:background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|color|fill|stroke))\s*:\s*([^;}]+)/gim;
      for (const match of decoded.matchAll(paintDeclaration)) {
        const property = match[1];
        const value = match[2]
          .replace(/var\([^)]*\)/gi, " ")
          .replace(/url\([^)]*\)/gi, " ")
          .replace(/#[0-9a-f]{3,8}\b/gi, " ")
          .replace(/[a-z-]+\([^)]*\)/gi, " ");
        for (const token of value.matchAll(/\b[a-z][a-z-]*\b/gi)) {
          auditColor(token[0], property);
        }
      }

      return [...new Set(out)];
    },
    { source: css, declared: [...DECLARED_COLORS], artboard: ARTBOARD_SOURCE },
  );
}

test.describe("DR.GLITCH design system", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
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

  test("chrome uses only exact declared process, paper, and stage colors", async ({
    page,
  }) => {
    const offenders: string[] = [];
    for (const route of ["/", "/landing", "/login", "/signup"]) {
      await page.goto(route);
      if (route === "/") await page.waitForSelector('[data-testid="artwork-canvas"]');
      const routeOffenders = await auditComputedPaint(page);
      offenders.push(...routeOffenders.map((entry) => `${route} ${entry}`));
    }

    expect(offenders).toEqual([]);
  });

  test("globals.css contains no undeclared color literal, including encoded data SVGs", async ({
    page,
  }) => {
    const css = await readFile(
      resolve(process.cwd(), "src/styles/globals.css"),
      "utf8",
    );
    const offenders = await auditStylesheetSource(page, css);

    expect(offenders).toEqual([]);
  });

  test("palette auditors reject modern runtime colors and named encoded SVG colors", async ({
    page,
  }) => {
    const supportsOklch = await page.evaluate(() =>
      CSS.supports("box-shadow", "0 0 0 1px oklch(70% 0.2 30)"),
    );
    expect(supportsOklch).toBe(true);
    await page.evaluate(() => {
      const mutation = document.createElement("div");
      mutation.className = "mutation-modern-color";
      mutation.style.boxShadow = "0 0 0 1px oklch(70% 0.2 30)";
      document.body.appendChild(mutation);
    });
    const runtimeOffenders = await auditComputedPaint(page);
    expect(
      runtimeOffenders.some(
        (entry) =>
          entry.includes("mutation-modern-color") &&
          entry.includes("boxShadow"),
      ),
    ).toBe(true);

    const encodedNamedColor =
      `.modern{box-shadow:0 0 0 1px oklch(70% 0.2 30);}` +
      `.fixture{background-image:url("data:image/svg+xml,` +
      `%3Csvg xmlns='http://www.w3.org/2000/svg'%3E` +
      `%3Cpath fill='red' d='M0 0h1v1z'/%3E%3C/svg%3E");}`;
    const sourceOffenders = await auditStylesheetSource(
      page,
      encodedNamedColor,
    );
    expect(sourceOffenders.some((entry) => entry.includes("data-svg=red"))).toBe(
      true,
    );
    expect(
      sourceOffenders.some((entry) => entry.includes("modern-color=oklch")),
    ).toBe(true);
  });

  test("artboard exceptions stay exact and cannot leak into other chrome", async ({ page }) => {
    for (const [selector, properties] of Object.entries(ARTBOARD_COMPUTED)) {
      const elements = page.locator(selector);
      expect(await elements.count()).toBeGreaterThan(0);
      for (const element of await elements.all()) {
        for (const [property, value] of Object.entries(properties)) {
          expect(await element.evaluate((el, property) => getComputedStyle(el)[property as keyof CSSStyleDeclaration], property)).toBe(value);
        }
      }
    }
    await page.getByTestId("stage-halftone-cmyk").click();
    const dials = page.locator(".ink-chip-dial");
    await expect(dials).toHaveCount(4);
    for (const dial of await dials.all()) {
      await expect(dial).toHaveCSS("border-radius", "50%");
      const box = await dial.boundingBox();
      expect(box!.width).toBe(box!.height);
    }
    const leaked = await auditStylesheetSource(page, ".wrong-selector { background: #3d3e40; }");
    expect(leaked).not.toEqual([]);
    const changed = await auditStylesheetSource(page, ".artboard-wrap { box-shadow: 0 0 0 5px #252628, 0 8px 19px rgba(0, 0, 0, 0.28); }");
    expect(changed).not.toEqual([]);
    await page.locator(".artboard-wrap").evaluate((element) => {
      (element as HTMLElement).style.boxShadow = "0 0 0 5px #252628, 0 8px 19px rgba(0, 0, 0, 0.28)";
    });
    expect((await auditComputedPaint(page)).some((entry) => entry.includes("artboard-wrap") && entry.includes("boxShadow"))).toBe(true);
  });

  test("chrome is square except the four circular angle dials", async ({ page }) => {
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
        if (!pseudo && el.matches(".ink-chip-dial") && r === "50%") return;
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

  test("no blurred chrome shadows outside the exact authored artboard shadow", async ({ page }) => {
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
        if (!pseudo && el.matches(".artboard-wrap") && shadow === "rgb(37, 38, 40) 0px 0px 0px 5px, rgba(0, 0, 0, 0.28) 0px 8px 18px 0px") return;
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

test.describe("accessibility floor and mobile", () => {
  test("mobile guard removes the studio from visual, keyboard, and accessibility navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const guard = page.getByTestId("desktop-only");
    await expect(guard).toBeVisible();

    const underlying = page.locator(
      ".studio-shell > :not(.desktop-only) button, " +
        ".studio-shell > :not(.desktop-only) input, " +
        ".studio-shell > :not(.desktop-only) select, " +
        ".studio-shell > :not(.desktop-only) a[href], " +
        ".studio-shell > :not(.desktop-only) [tabindex]",
    );
    expect(await underlying.count()).toBeGreaterThan(0);
    for (const control of await underlying.all()) {
      await expect(control).toBeHidden();
    }

    await page.keyboard.press("Tab");
    const focusEscaped = await page.evaluate(() => {
      const active = document.activeElement;
      const guardElement = document.querySelector("[data-testid='desktop-only']");
      return Boolean(
        active &&
          active !== document.body &&
          active !== document.documentElement &&
          !guardElement?.contains(active),
      );
    });
    expect(focusEscaped).toBe(false);
  });

  test("yellow never carries text", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    const violations = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const s = getComputedStyle(el);
        const isYellowText =
          s.color.replace(/\s/g, "") === "rgb(255,232,0)" &&
          (el.textContent ?? "").trim().length > 0;
        if (isYellowText) out.push(`${el.tagName}.${el.className}`);
      }
      return out;
    });
    expect(violations).toEqual([]);
  });

  test("reduced motion suppresses the glitch even on permitted surfaces", async ({
    page,
  }) => {
    // §9: prefers-reduced-motion disables the register-snap ENTIRELY.
    // The allowlist's `display: block` on permitted surfaces has higher
    // specificity than the reduced-motion rule, so the latter carries
    // !important. Without it, the wordmark would keep glitching for users
    // who asked it not to. This test pins that cascade.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForSelector('[data-testid="artwork-canvas"]');
    const state = await page.evaluate(() => {
      const el = document.querySelector(
        ".brand-lockup strong",
      ) as HTMLElement | null;
      if (!el) return null;
      el.classList.add("glitch");
      el.setAttribute("data-text", "X");
      const result = {
        before: getComputedStyle(el, "::before").display,
        after: getComputedStyle(el, "::after").display,
      };
      el.classList.remove("glitch");
      el.removeAttribute("data-text");
      return result;
    });
    expect(state).not.toBeNull();
    expect(state!.before).toBe("none");
    expect(state!.after).toBe("none");
  });

  for (const route of ["/", "/landing", "/login", "/signup"]) {
    test(`${route} gives every visible enabled interactive control a visible focus indicator`, async ({
      page,
    }) => {
      await page.goto(route);
      if (route === "/") await page.waitForSelector('[data-testid="artwork-canvas"]');

      const controls = page.locator(
        "button, input:not([type='hidden']), select, textarea, a[href], " +
          "[tabindex]:not([tabindex='-1'])",
      );
      const offenders: string[] = [];

      for (const control of await controls.all()) {
        if (!(await control.isVisible()) || !(await control.isEnabled())) continue;
        // Enter keyboard modality before focusing a specific control so
        // Chromium applies :focus-visible rather than the pointer heuristic.
        await page.keyboard.press("Tab");
        await control.focus();
        const state = await control.evaluate((element) => {
          const styles = getComputedStyle(element);
          const studio = Boolean(element.closest("[data-studio-root]"));
          return {
            identity:
              element.getAttribute("aria-label") ||
              element.getAttribute("name") ||
              element.textContent?.trim() ||
              `${element.tagName}.${element.className}`,
            studio,
            outlineColor: styles.outlineColor,
            outlineStyle: styles.outlineStyle,
            outlineWidth: Number.parseFloat(styles.outlineWidth),
            boxShadow: styles.boxShadow,
            activeInk: (() => {
              if (!studio) return "";
              const root = element.closest("[data-studio-root]") as HTMLElement;
              const probe = document.createElement("span");
              probe.style.color = getComputedStyle(root)
                .getPropertyValue("--ink-active")
                .trim();
              root.appendChild(probe);
              const resolved = getComputedStyle(probe).color;
              probe.remove();
              return resolved;
            })(),
          };
        });
        const visible =
          (state.outlineStyle !== "none" && state.outlineWidth >= 2) ||
          state.boxShadow !== "none";
        const studioLaw =
          !state.studio ||
          (state.outlineColor === state.activeInk &&
            state.boxShadow.includes(
              "rgb(16, 16, 16) 0px 0px 0px 1px inset",
            ));
        if (!visible || !studioLaw) {
          offenders.push(
            `${state.identity}: outline=${state.outlineStyle} ${state.outlineWidth}px ${state.outlineColor}; shadow=${state.boxShadow}`,
          );
        }
      }

      expect(offenders).toEqual([]);
    });
  }
});
