# DR.GLITCH UI System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the studio's black/grey/orange theme with the DR.GLITCH process-ink design system, and rework the control layer around plate solo, channel tinting, typed numerics, and a persistent stage spine.

**Architecture:** All theming lives in one hand-written `src/styles/globals.css` (1,145 lines, semantic class names; Tailwind is imported but zero utility classes are used in TSX). The work is therefore mostly a token and rule rewrite in that file, plus targeted component additions in `src/studio/`. No backend change, no routing change, no new runtime dependencies beyond self-hosted font files.

**Tech Stack:** Vite 8, React 19, hand-written CSS with custom properties, self-hosted Archivo + Martian Mono (both OFL 1.1, verified upstream), Playwright for design-system regression tests.

**Spec:** `docs/specs/2026-07-27-drglitch-ui-system-design.md`. Read it before Task 1. It is the active brand spec: anything it declares is owned and legitimate; anything it does not declare is an unguided default.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec.

**Color law (§3) — binding**
- Only real process inks appear anywhere. **No orange. No decorative accent. No tinted greys.** Hue carries meaning or it does not appear.
- Plate inks, semantic and reserved: `--ink-c: #0093D0`, `--ink-m: #E6007E`, `--ink-y: #FFE800`, `--ink-k: #101010`. **No element may use these hues except to signify that channel.**
- `#00FFFF` and screen-primary equivalents are **banned** — they read as RGB and undermine credibility with press people.
- Chrome, achromatic: `--paper: #F4F1E9`, `--paper-2: #E9E5DA`, `--paper-3: #DDD8CB`, `--rule: #101010`, `--rule-soft: #B8B2A4`.
- Stage, neutral and proof-safe: `--stage: #1C1D1F`, `--stage-2: #232426`, `--stage-rule: #34363A`. **Zero blue cast by design** — a blue-tinted surround shifts perceived ink density.
- Hazard is the single declared exception: over-ink-limit, out-of-gamut, and destructive actions render `--ink-k` on `--ink-y`. Success states carry **no color at all** — a filled black mark only.

**Geometry (§5)**
- **Radius: `0`. Everywhere. No exceptions, including toggles and chips.**
- Borders `1px solid var(--rule)`; active/primary blocks `2px`.
- **No blur shadow, ever.** The only permitted shadow is a hard 2px/2px offset in the active plate ink: `box-shadow: 2px 2px 0 var(--ink-active)`.
- **No gradients.**
- 8px base grid. Section rules run **full-bleed** to the container edge.

**Typography (§4)**
- Wordmark and stage numbers: Archivo Expanded 700. UI/labels/body: Archivo 400/600. All numerics: Martian Mono with `font-variant-numeric: tabular-nums`.
- Self-hosted `.woff2`, subset. **No CDN** (Workers CSP, offline-capable studio).
- Banned as unbacked defaults: Inter, Space Grotesk, Poppins, Montserrat, `system-ui` as a design choice.
- **Declared and owned by the spec** (do not "fix" these): tabular mono numerics, and uppercase letterspaced micro-labels at `10px / 0.08em`.

**Brand voice (§8) — quarantined**
- Misregistration is permitted ONLY on: wordmark, auth screens, empty states, export sheet header, toasts, splash.
- **Forbidden on: the stage, any live control, any surface within sight of the proof, any numeric readout.** Glitch near a proof is a bug, not a brand.

**Accessibility floor (§9)**
- Plate identity is **never** carried by hue alone — every plate chip pairs its ink with its letter (C/M/Y/K) and its angle value.
- Focus always visible: 2px offset in the active ink plus a 1px black inner rule, so focus survives on yellow.
- `#FFE800` never carries text at any weight except as a **background** behind `--ink-k`.
- Hit targets ≥32px on chrome, ≥24px on dense numeric rows.
- `prefers-reduced-motion` disables the register-snap animation entirely.

**Out of scope (§11)**
- `src/studio/halftone.ts` — the separation engine is an outside collaborator's GPL-licensed work, byte-identical to the original apart from two `export` keywords, with a Playwright hash gate pinning its output. **Do not modify it in any task.**
- Auth backend, workspaces, persistence.
- Mobile layout. Desktop production tool; mobile gets a graceful "open on desktop" state, not a responsive port.

**Naming (§2) — RESOLVED 2026-07-27**
- Michael approved `DR.GLITCH` for use everywhere. "DRC Halftone" was a placeholder from the Codex generation, not established branding.
- The name still lives in exactly ONE constant (`src/brand.ts`) so it is never hardcoded in two places. Import it; do not retype the string.

**Process**
- Node `>=22.13.0`. Do not remove `LICENSE` (GPL-3.0).
- Do not modify `vitest.config.ts` (intentionally empty; it shadows `vite.config.ts`, whose cloudflare plugin crashes node-environment test projects) or `vitest.workspace.ts`.
- Existing green state that must not regress: `npx vitest run --project unit` → 17 passed; `npx playwright test` → passing; `npm run build` → passes.
- Deploy is `npm run deploy`, which uses `wrangler deploy -c dist/halftone_web/wrangler.json`. Plain `wrangler deploy` from the repo root serves 404s for every asset.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `public/fonts/*.woff2` | Self-hosted Archivo + Martian Mono subsets |
| `src/brand.ts` | `WORDMARK`, `WORDMARK_APPROVED` — the single naming gate |
| `src/studio/InkRail.tsx` | Four C/M/Y/K chips + composite; solo and visibility |
| `src/studio/NumericField.tsx` | Type-or-drag numeric input with rendered units |
| `src/studio/StageSpine.tsx` | Persistent 4-stage spine with completion and jump-to |
| `src/studio/useStudioKeys.ts` | Keyboard map hook |
| `tests/e2e/design-system.spec.ts` | Design-system regression gate |
| `tests/e2e/studio-ux.spec.ts` | Ink rail, typed numerics, keyboard behavior |

**Modified** — `src/styles/globals.css` (the bulk), `src/studio/HalftoneStudio.tsx`, `src/routes/Signup.tsx`, `src/routes/Login.tsx`, `src/auth/SessionBadge.tsx`, `index.html`.

**Never touched** — `src/studio/halftone.ts`, `worker/**`, `db/**`, `tests/e2e/harness.html`, `tests/e2e/baseline-hashes.json`.

---

### Task 1: Design-system regression gate (write the test first)

Deliverable: a Playwright spec that fails against the CURRENT theme and will pass once the token rewrite lands. This is written first so the rewrite has an objective finish line rather than a subjective one.

**Files:**
- Create: `tests/e2e/design-system.spec.ts`

**Interfaces:**
- Consumes: the running dev server from the existing `playwright.config.ts` (`webServer` on `http://127.0.0.1:5173`).
- Produces: no runtime exports. A gate later tasks must keep green.

- [ ] **Step 1: Write the failing test**

```ts
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
      return {
        archivo: document.fonts.check("400 16px Archivo"),
        mono: document.fonts.check("400 16px 'Martian Mono'"),
        undefinedVars: getComputedStyle(document.documentElement)
          .getPropertyValue("--font-ui")
          .includes("geist"),
      };
    });

    expect(loaded.archivo).toBe(true);
    expect(loaded.mono).toBe(true);
    // --font-geist-* was injected by Next.js next/font, which Task 1 of the
    // hosting port removed. Referencing it silently falls back to Arial.
    expect(loaded.undefinedVars).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test design-system`
Expected: FAIL. The current theme has `--orange: #ff6b2c`, 31 `border-radius` declarations, 6 gradients, blurred shadows such as `0 18px 45px rgb(0 0 0 / 0.38)`, and no loaded webfonts.

Record the actual failure output in your report — it is the baseline the rewrite is measured against.

- [ ] **Step 3: Confirm the engine gate is unaffected**

Run: `npx playwright test render-regression`
Expected: PASS. The render harness drives the engine directly and never mounts the studio UI, so no CSS change can move those hashes. If this fails now, stop and report — something other than CSS is wrong.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/design-system.spec.ts
git commit -m "test: add failing design-system gate for the DR.GLITCH spec"
```

---

### Task 2: Self-hosted fonts

Deliverable: Archivo and Martian Mono served from `public/fonts/`, wired into CSS variables, with the dead `--font-geist-*` references gone.

**Files:**
- Create: `public/fonts/` (woff2 files), `public/fonts/LICENSE-Archivo.txt`, `public/fonts/LICENSE-MartianMono.txt`
- Modify: `src/styles/globals.css` (add `@font-face`, redefine `--font-ui` / add `--font-mono` / `--font-display`)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--font-display`, `--font-ui`, `--font-mono` on `:root`, consumed by every later task.

- [ ] **Step 1: Fetch the fonts**

Both families are SIL Open Font License 1.1, verified upstream at `github.com/Omnibus-Type/Archivo` and `github.com/evilmartians/mono`. Fetch the variable woff2 builds from Google Fonts' served CSS, which yields already-subset woff2 files:

```bash
cd /Volumes/DriveB/Projects/halftone-web
mkdir -p public/fonts

# Archivo variable (weight + width axes; the spec needs Expanded 700 and 400/600)
curl -sL -A "Mozilla/5.0" \
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..700&display=swap" \
  -o /tmp/archivo.css
grep -o "https://[^)]*\.woff2" /tmp/archivo.css | sort -u | head -1 \
  | xargs -I{} curl -sL {} -o public/fonts/archivo-variable.woff2

# Martian Mono variable
curl -sL -A "Mozilla/5.0" \
  "https://fonts.googleapis.com/css2?family=Martian+Mono:wdth,wght@75..112.5,300..800&display=swap" \
  -o /tmp/martian.css
grep -o "https://[^)]*\.woff2" /tmp/martian.css | sort -u | head -1 \
  | xargs -I{} curl -sL {} -o public/fonts/martian-mono-variable.woff2

ls -la public/fonts/
```

Both files must be non-empty and at least 10 KB. If either is missing or tiny, the fetch failed — do NOT proceed with a broken font file, and do NOT substitute a different family. Report the failure instead.

- [ ] **Step 2: Vendor the licenses**

OFL 1.1 requires the license to travel with the font files.

```bash
curl -sL "https://raw.githubusercontent.com/Omnibus-Type/Archivo/master/OFL.txt" \
  -o public/fonts/LICENSE-Archivo.txt
curl -sL "https://raw.githubusercontent.com/evilmartians/mono/main/OFL.txt" \
  -o public/fonts/LICENSE-MartianMono.txt
head -3 public/fonts/LICENSE-Archivo.txt public/fonts/LICENSE-MartianMono.txt
```

Both must contain "SIL Open Font License". If a URL 404s, find the correct path in that repo and report which you used.

- [ ] **Step 3: Declare the faces and replace the dead variables**

At the very top of `src/styles/globals.css`, before the existing `@import "tailwindcss"` line if present, add:

```css
@font-face {
  font-family: "Archivo";
  src: url("/fonts/archivo-variable.woff2") format("woff2-variations");
  font-weight: 400 700;
  font-stretch: 62% 125%;
  font-display: swap;
}

@font-face {
  font-family: "Martian Mono";
  src: url("/fonts/martian-mono-variable.woff2") format("woff2-variations");
  font-weight: 300 800;
  font-stretch: 75% 112.5%;
  font-display: swap;
}
```

Then in `:root`, replace the font variable definitions. The old `--font-ui` referenced `var(--font-geist-sans)`, which is never defined anywhere — Next.js's `next/font` used to inject it and the hosting port removed Next, so it silently fell back to Arial.

```css
  --font-display: "Archivo", sans-serif;
  --font-ui: "Archivo", sans-serif;
  --font-mono: "Martian Mono", ui-monospace, monospace;
```

- [ ] **Step 4: Sweep the remaining dead references**

```bash
cd /Volumes/DriveB/Projects/halftone-web
grep -n "font-geist" src/styles/globals.css
```

Replace every `var(--font-geist-mono), monospace` with `var(--font-mono)`. After the sweep, `grep -c "font-geist" src/styles/globals.css` must print `0`.

- [ ] **Step 5: Verify the fonts actually load**

Run: `npx playwright test design-system -g "declared fonts"`
Expected: PASS. The other design-system tests still fail — that is correct, Task 3 fixes them.

- [ ] **Step 6: Commit**

```bash
git add public/fonts src/styles/globals.css
git commit -m "feat: self-host Archivo and Martian Mono, drop dead geist font vars

The --font-geist-* custom properties were injected by Next.js next/font,
which the Cloudflare port removed. Every font declaration had been silently
falling back to Arial. Both families are OFL 1.1; licenses vendored."
```

---

### Task 3: Color and geometry token rewrite

Deliverable: the whole design-system gate from Task 1 goes green. Largest diff in the plan, no behavior change.

**Files:**
- Modify: `src/styles/globals.css`, `tests/e2e/design-system.spec.ts`

**Interfaces:**
- Consumes: `--font-display` / `--font-ui` / `--font-mono` from Task 2.
- Produces: the full token set on `:root` — `--ink-c`, `--ink-m`, `--ink-y`, `--ink-k`, `--ink-active`, `--paper`, `--paper-2`, `--paper-3`, `--rule`, `--rule-soft`, `--stage`, `--stage-2`, `--stage-rule`. Every later task styles against these names.

- [ ] **Step 1: Replace the `:root` token block**

The current block defines `--orange`, `--orange-soft`, `--shell`, `--panel`, `--panel-2`, `--line`, `--ink`, `--muted`, `--faint`, `--paper`. Replace it with the spec's §3 tokens, keeping the old semantic names as aliases so the 1,145-line file does not need a full rewrite in one step:

```css
:root {
  /* Plate inks (§3) — semantic, reserved. Never decorative. */
  --ink-c: #0093D0;
  --ink-m: #E6007E;
  --ink-y: #FFE800;
  --ink-k: #101010;

  /* The active plate's ink. Set by HalftoneStudio; drives channel tinting. */
  --ink-active: var(--ink-k);

  /* Chrome — achromatic (§3) */
  --paper: #F4F1E9;
  --paper-2: #E9E5DA;
  --paper-3: #DDD8CB;
  --rule: #101010;
  --rule-soft: #B8B2A4;

  /* Stage — neutral, proof-safe. Zero blue cast by design (§3). */
  --stage: #1C1D1F;
  --stage-2: #232426;
  --stage-rule: #34363A;

  /* Legacy aliases, retained so existing rules resolve. Migrate opportunistically. */
  --shell: var(--stage);
  --panel: var(--stage-2);
  --panel-2: var(--stage-2);
  --line: var(--stage-rule);
  --ink: var(--paper);
  --muted: #9d9b95;
  --faint: #6f716f;

  --font-display: "Archivo", sans-serif;
  --font-ui: "Archivo", sans-serif;
  --font-mono: "Martian Mono", ui-monospace, monospace;
}
```

**`--orange` and `--orange-soft` are deleted, not aliased.** Any rule still referencing them must be reassigned deliberately in Step 2.

- [ ] **Step 2: Reassign every orange usage**

```bash
cd /Volumes/DriveB/Projects/halftone-web
grep -n "orange" src/styles/globals.css
```

For each hit, decide by intent, not by mechanical substitution:
- Focus rings and active affordances → `var(--ink-active)`.
- Primary action fills → `var(--ink-k)` with `var(--paper)` text.
- Destructive or over-limit states → `var(--ink-k)` on `var(--ink-y)` (§3 hazard).
- Purely decorative accents → **remove the color entirely.** §3: hue carries meaning or it does not appear.

After this step `grep -c "orange" src/styles/globals.css` must print `0`.

- [ ] **Step 3: Zero every radius**

```bash
grep -c "border-radius" src/styles/globals.css   # expect 31 before
```

Set every one to `0`. Do not delete the declarations wholesale — several sit inside rules whose other properties matter. Change the value. Include toggles, chips, and pills; §5 says no exceptions.

Then add a belt-and-braces rule immediately after `:root`:

```css
/* §5: radius 0 everywhere, no exceptions. */
*,
*::before,
*::after {
  border-radius: 0;
}
```

- [ ] **Step 4: Remove gradients and blur shadows**

```bash
grep -n "gradient" src/styles/globals.css      # 6 hits
grep -n "box-shadow" src/styles/globals.css
```

- Every `linear-gradient` / `radial-gradient` becomes a flat `background-color` using a declared token. §5 permits no gradients.
- Every blurred `box-shadow` (any third length value greater than `0`) becomes either nothing, or the one permitted form: `box-shadow: 2px 2px 0 var(--ink-active);`. Use it only on active or primary blocks, not everywhere.
- The `<select>` arrow gradients called out in §5 are removed; give the control a drawn glyph instead (a CSS triangle via `clip-path` on a pseudo-element, or an inline SVG background — both are fine, neither is a gradient).

- [ ] **Step 5: Borders, grid, and full-bleed rules**

- Every border becomes `1px solid var(--rule)` on paper surfaces, or `1px solid var(--stage-rule)` on stage surfaces. Active and primary blocks take `2px`.
- Section separators run **full-bleed to the container edge** — remove inset margins on `hr`, `.divider`, and any `border-top` used as a section rule. §5 calls this the brutalist signature.
- Spacing steps snap to the 8px grid.

- [ ] **Step 5b: Bind tabular figures to the mono face (§4)**

§4 states all numerics use Martian Mono **with `font-variant-numeric: tabular-nums`**. The two travel together: a production tool needs figures that do not reflow as values change. Task 2 repointed the numeric rules onto `var(--font-mono)` but did not add the figure setting, and these three rules currently lack it:

- `.range-label output`
- `.angle-field input`
- `.zoom-controls output`

Add `font-variant-numeric: tabular-nums;` to each. Then verify no rule uses the mono face without it:

```bash
cd /Volumes/DriveB/Projects/halftone-web
python3 - <<'CHECK'
import re
css = open("src/styles/globals.css").read()
missing = [
    sel.strip().splitlines()[-1].strip()
    for sel, body in re.findall(r'([^{}]+)\{([^}]*)\}', css)
    if "--font-mono" in body and "tabular-nums" not in body and not sel.strip().endswith(":root")
]
print("mono rules missing tabular-nums:", missing)
assert not missing, missing
CHECK
```

`:root` is excluded because it only defines the custom property; it does not apply the face.

- [ ] **Step 5c: Add the tabular-figures assertion to the gate**

So this cannot silently regress, append a test to `tests/e2e/design-system.spec.ts`:

```ts
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
```

- [ ] **Step 6: Run the gate**

Run: `npx playwright test design-system`
Expected: all five tests PASS.

If "no element uses a banned hue" still fails, read the reported selector — an inline style or a remaining literal hex is the usual cause. Fix the source; do not weaken the assertion.

- [ ] **Step 7: Confirm nothing else regressed**

```bash
npx playwright test render-regression   # engine hashes unmoved
npx vitest run --project unit           # 17 passed
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/styles/globals.css tests/e2e/design-system.spec.ts
git commit -m "feat: rewrite theme to the DR.GLITCH process-ink token system

Removes orange entirely, zeroes all 31 radii, drops 6 gradients and every
blurred shadow. Stage greys carry zero blue cast so the surround cannot
shift perceived ink density."
```

---

### Task 4: Wordmark constant and brand quarantine

Deliverable: the product name lives in exactly one place; the misregistration effect exists but is structurally barred from the stage.

**Files:**
- Create: `src/brand.ts`
- Modify: `src/styles/globals.css`, `index.html`

**Interfaces:**
- Consumes: tokens from Task 3.
- Produces: `WORDMARK: string`, `WORDMARK_APPROVED: boolean`, `PRODUCT_NAME: string` from `src/brand.ts`. Tasks 8 and 9 import `PRODUCT_NAME`. CSS class `.glitch` is available but permitted only on the surfaces §8 lists.

- [ ] **Step 1: Create the naming gate**

`src/brand.ts`:

```ts
/**
 * Single source of truth for the product name (spec §2, resolved 2026-07-27).
 *
 * "DRC Halftone" was a placeholder emitted by the Codex generation, not
 * established branding. DR.GLITCH is approved for use everywhere.
 *
 * Import PRODUCT_NAME. Never retype the string — a name in two places is a
 * name that will disagree with itself.
 */
export const PRODUCT_NAME = "DR.GLITCH";

/** Shown in the <title> and on auth screens. */
export const PRODUCT_TAGLINE = "CMYK Separation Studio";
```

- [ ] **Step 2: Add the quarantined misregistration effect**

In `src/styles/globals.css`:

```css
/*
 * §8: misregistration is the identity, and it never touches a working surface.
 * PERMITTED: wordmark, auth screens, empty states, export sheet header,
 * toasts, splash. FORBIDDEN: the stage, any live control, any surface within
 * sight of the proof, any numeric readout. Glitch near a proof is a bug.
 */
.glitch {
  position: relative;
  display: inline-block;
}

.glitch::before,
.glitch::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.glitch::before {
  color: var(--ink-c);
  transform: translate(-2px, -1px);
}

.glitch::after {
  color: var(--ink-m);
  transform: translate(2px, 1px);
}

.glitch:hover::before,
.glitch:focus-visible::before,
.glitch:hover::after,
.glitch:focus-visible::after {
  transform: translate(0, 0);
  transition: transform 120ms steps(3, end);
}

/* §9: reduced motion disables the register-snap entirely. */
@media (prefers-reduced-motion: reduce) {
  .glitch::before,
  .glitch::after {
    display: none;
  }
  .glitch:hover::before,
  .glitch:focus-visible::before,
  .glitch:hover::after,
  .glitch:focus-visible::after {
    transition: none;
  }
}

/* Structural guard: the effect cannot render inside the stage. */
.stage .glitch::before,
.stage .glitch::after,
.inspector .glitch::before,
.inspector .glitch::after {
  display: none;
}
```

Read `globals.css` first to confirm the real class names for the stage and inspector containers, and use those actual names in the guard rather than the illustrative `.stage` / `.inspector` above. Report which selectors you used.

- [ ] **Step 3: Update the hardcoded title**

`index.html` hardcodes `<title>DRC Halftone — CMYK Studio</title>`. Change it to `<title>DR.GLITCH — CMYK Separation Studio</title>`, and add an HTML comment above it noting that the canonical name lives in `src/brand.ts` and both must move together. Static HTML cannot import the constant, so this is the one permitted duplicate — flag it rather than let it drift silently.

Also update the `<meta name="description">` if it names the old product.

- [ ] **Step 4: Verify the name is single-sourced**

```bash
cd /Volumes/DriveB/Projects/halftone-web
npm run build
grep -rn "DRC Halftone" src/ index.html
```

That grep must return NOTHING. Any remaining hit is a hardcoded old name. The only permitted literal `DR.GLITCH` occurrences in source are the one in `src/brand.ts` and the one in `index.html`'s `<title>`; everywhere else must import `PRODUCT_NAME`.

```bash
grep -rn "DR.GLITCH" src/ | grep -v "src/brand.ts"
```

That must also return nothing. Then run `npx playwright test design-system` — still all passing.

- [ ] **Step 5: Commit**

```bash
git add src/brand.ts src/styles/globals.css index.html
git commit -m "feat: adopt DR.GLITCH as the product name, single-sourced

Michael approved the name 2026-07-27; DRC Halftone was a Codex placeholder.
PRODUCT_NAME lives in src/brand.ts and is imported everywhere. Adds the
quarantined misregistration effect, structurally barred from the stage and
inspector per spec section 8."
```

---

### Task 5: Ink rail with plate solo

Deliverable: a persistent C/M/Y/K rail that solos a plate on click and toggles visibility on modifier-click. §6.1 calls solo the single largest speed win in the redesign.

**Files:**
- Create: `src/studio/inks.ts`, `src/studio/InkRail.tsx`
- Modify: `src/studio/HalftoneStudio.tsx`, `src/styles/globals.css`
- Test: `tests/e2e/studio-ux.spec.ts`

**Interfaces:**
- Consumes: `Plate`, `PLATES`, `PLATE_META`, `HalftoneSettings` from `src/studio/halftone`; tokens from Task 3.
- Produces: `<InkRail activePlate onSolo onToggleVisible settings />` where `onSolo: (plate: Plate) => void` and `onToggleVisible: (plate: Exclude<Plate,"composite">) => void`. Also produces `CHROME_INK` from `src/studio/inks.ts` — Tasks 6 and 7 both import it.

**Read this before writing code.** The engine's `PLATE_META` colors (`cyan #00a9c8`, `magenta #e53578`, `yellow #f0d422`, `black #202226`) are its own RENDER values. They are NOT the spec's process inks, and `halftone.ts` is out of scope — do not change them. The chrome needs its own map, created in Step 3 below.

- [ ] **Step 1: Write the failing test**

`tests/e2e/studio-ux.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test.describe("ink rail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("renders four plate chips plus composite", async ({ page }) => {
    await expect(page.getByTestId("ink-chip-cyan")).toBeVisible();
    await expect(page.getByTestId("ink-chip-magenta")).toBeVisible();
    await expect(page.getByTestId("ink-chip-yellow")).toBeVisible();
    await expect(page.getByTestId("ink-chip-black")).toBeVisible();
    await expect(page.getByTestId("ink-chip-composite")).toBeVisible();
  });

  test("plate identity is never carried by hue alone", async ({ page }) => {
    // §9: every chip pairs its ink with its letter AND its angle value.
    for (const [plate, letter, angle] of [
      ["cyan", "C", "15"],
      ["magenta", "M", "75"],
      ["yellow", "Y", "0"],
      ["black", "K", "45"],
    ]) {
      const chip = page.getByTestId(`ink-chip-${plate}`);
      await expect(chip).toContainText(letter);
      await expect(chip).toContainText(angle);
    }
  });

  test("clicking a chip solos that plate", async ({ page }) => {
    await page.getByTestId("ink-chip-magenta").click();
    await expect(page.getByTestId("ink-chip-magenta")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("active-plate-label")).toContainText(/magenta/i);
  });

  test("modifier-click toggles visibility without soloing", async ({ page }) => {
    await page.getByTestId("ink-chip-composite").click();
    const cyan = page.getByTestId("ink-chip-cyan");
    await cyan.click({ modifiers: ["Alt"] });
    await expect(cyan).toHaveAttribute("data-visible", "false");
    // Solo did not change: composite is still the active view.
    await expect(page.getByTestId("active-plate-label")).toContainText(/composite/i);
  });

  test("chips meet the 32px hit-target floor", async ({ page }) => {
    const box = await page.getByTestId("ink-chip-cyan").boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(32);
    expect(box!.height).toBeGreaterThanOrEqual(32);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test studio-ux`
Expected: FAIL — no `ink-chip-*` test IDs exist yet.

- [ ] **Step 3: Create the chrome ink map, then build the component**

`src/studio/inks.ts`:

```ts
import type { Plate } from "./halftone";

/**
 * Spec §3 process inks, for CHROME ONLY.
 *
 * These are deliberately NOT the engine's PLATE_META colors. halftone.ts is an
 * outside collaborator's GPL work, out of scope, and pinned by a render hash
 * gate — its colors are render values and must never be changed to match these.
 * Screen primaries such as #00FFFF are banned by §3: they read as RGB and
 * undermine the product's credibility with press people.
 */
export const CHROME_INK: Record<Exclude<Plate, "composite">, string> = {
  cyan: "#0093D0",
  magenta: "#E6007E",
  yellow: "#FFE800",
  black: "#101010",
};

/** Composite presents all four inks, so it carries no single plate hue (§6.2). */
export const COMPOSITE_INK = "#101010";
```

`src/studio/InkRail.tsx`:

```tsx
import { CHROME_INK } from "./inks";
import {
  PLATES,
  PLATE_META,
  type HalftoneSettings,
  type Plate,
} from "./halftone";

type Props = {
  activePlate: Plate;
  settings: HalftoneSettings;
  onSolo: (plate: Plate) => void;
  onToggleVisible: (plate: Exclude<Plate, "composite">) => void;
};

/**
 * §6.1 Ink rail. Click solos a plate; modifier-click toggles its visibility.
 * §9: identity is never hue alone — each chip shows its letter and angle.
 */
export default function InkRail({
  activePlate,
  settings,
  onSolo,
  onToggleVisible,
}: Props) {
  return (
    <div className="ink-rail" role="group" aria-label="Plates">
      <button
        type="button"
        data-testid="ink-chip-composite"
        className={`ink-chip ink-chip-composite ${activePlate === "composite" ? "is-active" : ""}`}
        aria-pressed={activePlate === "composite"}
        onClick={() => onSolo("composite")}
      >
        <span className="ink-chip-swatch" aria-hidden="true" />
        <span className="ink-chip-letter">ALL</span>
      </button>

      {PLATES.map((plate) => (
        <button
          key={plate}
          type="button"
          data-testid={`ink-chip-${plate}`}
          className={`ink-chip ${activePlate === plate ? "is-active" : ""}`}
          aria-pressed={activePlate === plate}
          data-visible={settings.visible[plate] ? "true" : "false"}
          title={`${PLATE_META[plate].label} — click to solo, Alt-click to hide`}
          onClick={(event) => {
            if (event.altKey || event.metaKey) {
              onToggleVisible(plate);
              return;
            }
            onSolo(plate);
          }}
        >
          <span
            className="ink-chip-swatch"
            style={{ background: CHROME_INK[plate] }}
            aria-hidden="true"
          />
          <span className="ink-chip-letter">{PLATE_META[plate].short}</span>
          <span className="ink-chip-angle">{settings.angles[plate]}°</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the studio**

In `src/studio/HalftoneStudio.tsx`, import `InkRail` and render it alongside the stage. Add the handlers next to the existing state (`activePlate`, `setActivePlate`, `settings`, `updateSetting` all already exist):

```tsx
  const handleSolo = useCallback((plate: Plate) => {
    setActivePlate(plate);
  }, []);

  const handleToggleVisible = useCallback(
    (plate: Exclude<Plate, "composite">) => {
      setSettings((current) => ({
        ...current,
        visible: { ...current.visible, [plate]: !current.visible[plate] },
      }));
    },
    [],
  );
```

Also add a label element the test reads:

```tsx
        <span className="active-plate-label" data-testid="active-plate-label">
          {activePlate === "composite" ? "Composite" : PLATE_META[activePlate].label}
        </span>
```

- [ ] **Step 5: Style the rail**

Add to `globals.css`, using only declared tokens. Chips are ≥32px per §9, zero radius per §5, and the swatch carries the plate ink while the letter and angle carry the identity:

```css
.ink-rail {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--stage-rule);
  background: var(--stage-2);
}

.ink-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 32px;
  min-height: 32px;
  padding: 8px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--stage-rule);
  color: var(--paper);
  font-family: var(--font-ui);
  cursor: pointer;
}

.ink-chip.is-active {
  background: var(--stage);
  box-shadow: 2px 2px 0 var(--ink-active);
}

.ink-chip[data-visible="false"] {
  opacity: 0.4;
}

.ink-chip-swatch {
  width: 16px;
  height: 16px;
  border: 1px solid var(--stage-rule);
}

.ink-chip-letter {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
}

.ink-chip-angle {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--muted);
  margin-left: auto;
}

.ink-chip:focus-visible {
  outline: 2px solid var(--ink-active);
  outline-offset: 0;
  box-shadow: inset 0 0 0 1px var(--ink-k);
}
```

- [ ] **Step 6: Run the tests**

```bash
npx playwright test studio-ux
npx playwright test design-system
npx playwright test render-regression
```

Expected: all pass. If `design-system` newly fails on radius or shadow, your rail CSS introduced the violation — fix the rail, not the gate.

- [ ] **Step 7: Commit**

```bash
git add src/studio/inks.ts src/studio/InkRail.tsx src/studio/HalftoneStudio.tsx src/styles/globals.css tests/e2e/studio-ux.spec.ts
git commit -m "feat: add ink rail with plate solo and visibility toggle"
```

---

### Task 6: Channel tinting

Deliverable: when a plate is active, every active affordance renders in that plate's ink, so the operator never has to ask which plate they are editing (§6.2).

**Files:**
- Modify: `src/studio/HalftoneStudio.tsx`, `src/styles/globals.css`
- Test: `tests/e2e/studio-ux.spec.ts`

**Interfaces:**
- Consumes: `--ink-active` declared in Task 3; `InkRail` from Task 5.
- Produces: `--ink-active` is set on the studio root element from `activePlate`. Everything already styled against `var(--ink-active)` picks it up automatically.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/studio-ux.spec.ts`:

```ts
test.describe("channel tinting", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  async function activeInk(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const root = document.querySelector("[data-studio-root]") as HTMLElement;
      return getComputedStyle(root).getPropertyValue("--ink-active").trim();
    });
  }

  test("active ink follows the soloed plate", async ({ page }) => {
    await page.getByTestId("ink-chip-cyan").click();
    expect((await activeInk(page)).toLowerCase()).toBe("#0093d0");

    await page.getByTestId("ink-chip-magenta").click();
    expect((await activeInk(page)).toLowerCase()).toBe("#e6007e");

    await page.getByTestId("ink-chip-yellow").click();
    expect((await activeInk(page)).toLowerCase()).toBe("#ffe800");
  });

  test("composite carries no single plate hue", async ({ page }) => {
    await page.getByTestId("ink-chip-composite").click();
    // §6.2: composite presents all four as a hairline stripe, not one hue.
    expect((await activeInk(page)).toLowerCase()).toBe("#101010");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test studio-ux -g "channel tinting"`
Expected: FAIL — no `[data-studio-root]` element and `--ink-active` never changes.

- [ ] **Step 3: Drive the variable from state**

In `src/studio/HalftoneStudio.tsx`, find the outermost container element the component returns. Add the attribute and the inline custom property:

```tsx
    <div
      data-studio-root
      className="studio"
      style={{ "--ink-active": activeInk } as React.CSSProperties}
    >
```

`CHROME_INK` and `COMPOSITE_INK` already exist in `src/studio/inks.ts` from Task 5. Import them; do not redefine them and do not reach for the engine's `PLATE_META.color`, which holds different values on purpose:

```tsx
import { CHROME_INK, COMPOSITE_INK } from "./inks";
```

```tsx
  const activeInk =
    activePlate === "composite" ? COMPOSITE_INK : CHROME_INK[activePlate];
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test studio-ux`
Expected: all pass, including Task 5's rail tests.

- [ ] **Step 5: Confirm the proof is unaffected**

Run: `npx playwright test render-regression`
Expected: PASS. Chrome ink values must never reach the engine. If these hashes moved, `halftone.ts` or the render options were touched — revert and report.

- [ ] **Step 6: Commit**

```bash
git add src/studio/HalftoneStudio.tsx src/studio/InkRail.tsx src/styles/globals.css tests/e2e/studio-ux.spec.ts
git commit -m "feat: tint active affordances with the soloed plate's ink"
```

---

### Task 7: Typed numeric fields

Deliverable: every numeric is type-first with drag secondary, units always rendered. §7 calls slider-only the current build's worst friction.

**Files:**
- Create: `src/studio/NumericField.tsx`
- Modify: `src/studio/HalftoneStudio.tsx`, `src/styles/globals.css`
- Test: `tests/e2e/studio-ux.spec.ts`

**Interfaces:**
- Consumes: tokens from Task 3, `--ink-active` from Task 6.
- Produces: `<NumericField label value min max step unit onChange />` with `onChange: (value: number) => void`. Replaces the 5 existing `RangeControl` usages.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/studio-ux.spec.ts`:

```ts
test.describe("typed numerics", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("cell size accepts a typed value", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    await field.fill("18");
    await field.press("Enter");
    await expect(field).toHaveValue("18");
  });

  test("units are rendered, not implied", async ({ page }) => {
    await expect(page.getByTestId("numeric-cellSize-unit")).toContainText("px");
  });

  test("out-of-range input is clamped, not accepted blindly", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    await field.fill("9999");
    await field.press("Enter");
    const value = Number(await field.inputValue());
    expect(value).toBeLessThanOrEqual(64);
  });

  test("a non-numeric entry reverts rather than breaking the render", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const before = await field.inputValue();
    await field.fill("abc");
    await field.press("Enter");
    await expect(field).toHaveValue(before);
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("numeric rows meet the 24px hit-target floor", async ({ page }) => {
    const box = await page.getByTestId("numeric-cellSize").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test studio-ux -g "typed numerics"`
Expected: FAIL — no `numeric-*` test IDs.

- [ ] **Step 3: Build the component**

`src/studio/NumericField.tsx`:

```tsx
import { useEffect, useRef, useState, type PointerEvent } from "react";

type Props = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  onChange: (value: number) => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * §7: type-or-drag. A typed input is the PRIMARY affordance; drag is secondary.
 * Production people type 15° — they do not drag to it.
 */
export default function NumericField({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const dragState = useRef<{ startX: number; startValue: number } | null>(null);

  // Keep the field in sync when the value changes from elsewhere (keyboard,
  // reset, opening a saved project).
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value)); // revert; never feed NaN to the renderer
      return;
    }
    const next = clamp(parsed, min, max);
    setDraft(String(next));
    onChange(next);
  }

  function onPointerDown(event: PointerEvent<HTMLSpanElement>) {
    dragState.current = { startX: event.clientX, startValue: value };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLSpanElement>) {
    const state = dragState.current;
    if (!state) return;
    const delta = event.clientX - state.startX;
    const scale = event.shiftKey ? 0.25 : 1; // §7: Shift = fine adjust
    onChange(clamp(state.startValue + delta * step * scale, min, max));
  }

  function onPointerUp(event: PointerEvent<HTMLSpanElement>) {
    dragState.current = null;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  }

  return (
    <div className="numeric-field">
      <label className="numeric-label" htmlFor={`numeric-${id}`}>
        <span
          className="numeric-grip"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="presentation"
        >
          {label}
        </span>
      </label>
      <span className="numeric-entry">
        <input
          id={`numeric-${id}`}
          data-testid={`numeric-${id}`}
          className="numeric-input"
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(String(value));
          }}
        />
        {unit ? (
          <span className="numeric-unit" data-testid={`numeric-${id}-unit`}>
            {unit}
          </span>
        ) : null}
      </span>
      {hint ? <p className="numeric-hint">{hint}</p> : null}
    </div>
  );
}
```

- [ ] **Step 3b: Make plate angles editable in place (§6.3)**

§6.3 requires angle to live inline on each plate row, editable in place, tabular mono, "not buried behind a disclosure". The ink rail from Task 5 currently renders the angle read-only.

Add an `onAngleChange` prop to `InkRail` and swap the read-only `.ink-chip-angle` span for a compact numeric input. Keep the chip's click-to-solo behavior working — the input must stop propagation so typing an angle does not also solo the plate:

```tsx
        <input
          className="ink-chip-angle-input"
          data-testid={`ink-angle-${plate}`}
          type="text"
          inputMode="decimal"
          value={String(settings.angles[plate])}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onAngleChange(plate, ((parsed % 360) + 360) % 360);
          }}
          aria-label={`${PLATE_META[plate].label} screen angle in degrees`}
        />
```

The chip is a `<button>`, so an `<input>` cannot be nested inside it — restructure the chip as a `<div className="ink-chip">` containing a `<button>` for the solo target plus the angle input as a sibling. Update the Task 5 tests' selectors if the test IDs move, but do NOT weaken any assertion; `ink-chip-*` must still expose `aria-pressed` and `data-visible`.

Wire it in `HalftoneStudio.tsx`:

```tsx
  const handleAngleChange = useCallback(
    (plate: Exclude<Plate, "composite">, angle: number) => {
      setSettings((current) => ({
        ...current,
        angles: { ...current.angles, [plate]: angle },
      }));
    },
    [],
  );
```

**Per-plate density is NOT implementable and is deliberately skipped.** §6.3 also asks for density on each plate row, but `HalftoneSettings` has no per-plate density field — the existing "Ink density" control at `HalftoneStudio.tsx:495` is the GLOBAL `opacity`. Adding per-plate density would require changing the engine's settings type, and `halftone.ts` is out of scope per §11. Leave the global control where it is and report this gap; it is a spec item for a later engine change, not something to improvise here.

- [ ] **Step 4: Replace the RangeControl usages**

`src/studio/HalftoneStudio.tsx` has 5 `RangeControl` instances. Replace each with `NumericField`, supplying a real `unit` and a one-line `hint` stating the control's consequence in plain language (§7: every control states its consequence; no LLM jargon, no "seamlessly", no "powerful").

For cell size, use `id="cellSize"`, `unit="px"`, `min={3}`, `max={64}`, `step={1}`, and a hint naming the print consequence — the document is 240 DPI, so screen frequency is approximately `240 / cell size`: at 16px that is 15 LPI, at 4px it is 60 LPI. Write the hint from that fact.

Keep `RangeControl` in the file only if some control genuinely still needs a bare slider; otherwise delete the now-unused component so it does not rot.

- [ ] **Step 5: Style it**

```css
.numeric-field {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.numeric-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.numeric-grip {
  cursor: ew-resize;
  user-select: none;
}

.numeric-entry {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-height: 24px;
}

.numeric-input {
  width: 72px;
  padding: 4px 6px;
  background: var(--paper-2);
  border: 1px solid var(--rule);
  color: var(--ink-k);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  text-align: right;
}

.numeric-input:focus-visible {
  outline: 2px solid var(--ink-active);
  outline-offset: 0;
  box-shadow: inset 0 0 0 1px var(--ink-k);
}

.numeric-unit {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}

.numeric-hint {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 11px;
  color: var(--faint);
}
```

- [ ] **Step 6: Run the tests**

```bash
npx playwright test studio-ux
npx playwright test design-system
npx playwright test render-regression
npx vitest run --project unit
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/studio/NumericField.tsx src/studio/HalftoneStudio.tsx src/styles/globals.css tests/e2e/studio-ux.spec.ts
git commit -m "feat: replace sliders with type-or-drag numeric fields"
```

---

### Task 8: Persistent stage spine and keyboard map

Deliverable: the four stages stay visible with completion state and jump-to, and the keyboard shortcuts in §7 work.

**Files:**
- Create: `src/studio/StageSpine.tsx`, `src/studio/useStudioKeys.ts`
- Modify: `src/studio/HalftoneStudio.tsx`, `src/styles/globals.css`
- Test: `tests/e2e/studio-ux.spec.ts`

**Interfaces:**
- Consumes: `PRODUCT_NAME` from `src/brand.ts` (Task 4); `Plate` from `src/studio/halftone`.
- Produces: `<StageSpine stages active onJump />` and `useStudioKeys({ onSolo, onComposite, onCellSizeDelta })`.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/studio-ux.spec.ts`:

```ts
test.describe("stage spine and keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
  });

  test("all four stages are visible without scrolling", async ({ page }) => {
    for (const label of ["ARTWORK", "SCREEN", "SEPARATION", "OUTPUT"]) {
      await expect(page.getByTestId(`stage-${label.toLowerCase()}`)).toBeInViewport();
    }
  });

  test("stage numbers are zero-padded", async ({ page }) => {
    await expect(page.getByTestId("stage-artwork")).toContainText("01");
    await expect(page.getByTestId("stage-output")).toContainText("04");
  });

  test("number keys solo plates", async ({ page }) => {
    await page.locator("body").press("1");
    await expect(page.getByTestId("active-plate-label")).toContainText(/cyan/i);
    await page.locator("body").press("2");
    await expect(page.getByTestId("active-plate-label")).toContainText(/magenta/i);
    await page.locator("body").press("4");
    await expect(page.getByTestId("active-plate-label")).toContainText(/black/i);
  });

  test("backtick returns to composite", async ({ page }) => {
    await page.locator("body").press("1");
    await page.locator("body").press("`");
    await expect(page.getByTestId("active-plate-label")).toContainText(/composite/i);
  });

  test("bracket keys step cell size", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    const before = Number(await field.inputValue());
    await page.locator("body").press("]");
    expect(Number(await field.inputValue())).toBeGreaterThan(before);
    await page.locator("body").press("[");
    expect(Number(await field.inputValue())).toBe(before);
  });

  test("shortcuts do not fire while typing in a field", async ({ page }) => {
    const field = page.getByTestId("numeric-cellSize");
    await field.click();
    await field.fill("");
    await field.type("12");
    // '1' and '2' must reach the input, not solo plates.
    await expect(field).toHaveValue("12");
    await expect(page.getByTestId("active-plate-label")).toContainText(/composite/i);
  });
});
```

That last test is the one that matters most — a global key handler that hijacks digits while someone is typing a value makes the tool unusable.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test studio-ux -g "stage spine"`
Expected: FAIL — no stage test IDs, no key handling.

- [ ] **Step 3: Build the keyboard hook**

`src/studio/useStudioKeys.ts`:

```ts
import { useEffect } from "react";
import { PLATES, type Plate } from "./halftone";

type Handlers = {
  onSolo: (plate: Plate) => void;
  onCellSizeDelta: (delta: number) => void;
};

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** §7 keyboard map: 1-4 solo, ` composite, [ ] cell size. */
export function useStudioKeys({ onSolo, onCellSizeDelta }: Handlers) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never hijack keys while the operator is typing a value.
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "`") {
        event.preventDefault();
        onSolo("composite");
        return;
      }
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= PLATES.length) {
        event.preventDefault();
        onSolo(PLATES[index - 1]);
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        onCellSizeDelta(1);
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        onCellSizeDelta(-1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSolo, onCellSizeDelta]);
}
```

`PLATES` is `["cyan", "magenta", "yellow", "black"]`, so `1`→cyan, `2`→magenta, `3`→yellow, `4`→black, matching the test.

- [ ] **Step 4: Build the spine**

`src/studio/StageSpine.tsx`:

```tsx
export type Stage = {
  id: string;
  number: string;
  label: string;
  complete: boolean;
};

type Props = {
  stages: Stage[];
  onJump: (id: string) => void;
};

/** §7: the four stages stay visible with completion state and jump-to. */
export default function StageSpine({ stages, onJump }: Props) {
  return (
    <nav className="stage-spine" aria-label="Stages">
      {stages.map((stage) => (
        <button
          key={stage.id}
          type="button"
          data-testid={`stage-${stage.id}`}
          className={`stage-step ${stage.complete ? "is-complete" : ""}`}
          onClick={() => onJump(stage.id)}
        >
          <span className="stage-number">{stage.number}</span>
          <span className="stage-label">{stage.label}</span>
          {stage.complete ? (
            <span className="stage-mark" aria-label="complete">
              ■
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
```

The completion mark is a filled black square — §3 requires success states to carry no color at all.

- [ ] **Step 5: Wire both into the studio**

In `HalftoneStudio.tsx`, replace the four scattered `StepHeader` calls (currently at roughly lines 359, 373, 422, 471) with a single `StageSpine` rendered once, above the inspector. Stage ids must be `artwork`, `screen`, `separation`, `output`, numbers `01`-`04`, labels uppercase. `artwork.complete` is `Boolean(source)`.

`onJump` scrolls the matching section into view via a ref map or `document.getElementById(...)?.scrollIntoView({ block: "start" })`.

Then call the hook:

```tsx
  useStudioKeys({
    onSolo: handleSolo,
    onCellSizeDelta: (delta) =>
      updateSetting("cellSize", Math.min(64, Math.max(3, settings.cellSize + delta))),
  });
```

- [ ] **Step 5b: Space-to-pan (§7)**

**This is the one genuinely NEW interaction in the plan, not a restyle.** There is no pan state in the studio today — only `zoom` (`HalftoneStudio.tsx:124`). §7's keyboard map lists `Space` pan, so it is in scope, but treat it as a feature and keep it self-contained.

Add pan state beside `zoom`:

```tsx
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
```

Track the spacebar, ignoring it while typing so a value entry containing a space does not arm panning:

```tsx
  useEffect(() => {
    function down(event: KeyboardEvent) {
      if (event.code !== "Space") return;
      const target = event.target;
      if (target instanceof HTMLElement &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      event.preventDefault(); // stop the page scrolling
      setSpaceHeld(true);
    }
    function up(event: KeyboardEvent) {
      if (event.code === "Space") setSpaceHeld(false);
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
```

Apply pan to the stage's existing transform alongside zoom, and set `cursor: grab` on the stage when `spaceHeld` is true (`grabbing` while dragging). Pointer handlers on the stage read `spaceHeld` and update `pan` from `panStart`.

Add this test to `tests/e2e/studio-ux.spec.ts`:

```ts
  test("space arms panning but not while typing", async ({ page }) => {
    const stage = page.getByTestId("stage-surface");
    await page.locator("body").press("Space");
    await expect(stage).toHaveAttribute("data-pan-armed", "true");

    await page.getByTestId("numeric-cellSize").click();
    await page.keyboard.press("Space");
    // Typing a space must not arm panning.
    await expect(stage).toHaveAttribute("data-pan-armed", "false");
  });
```

Add `data-testid="stage-surface"` and `data-pan-armed={spaceHeld ? "true" : "false"}` to the stage element so the test can observe it.

- [ ] **Step 6: Style the spine**

```css
.stage-spine {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  background: var(--paper);
  border-bottom: 1px solid var(--rule);
}

.stage-step {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-height: 32px;
  padding: 8px;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--rule);
  cursor: pointer;
  text-align: left;
}

.stage-step:last-child {
  border-right: 0;
}

.stage-number {
  font-family: var(--font-display);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--ink-k);
}

.stage-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.stage-step.is-complete .stage-label {
  color: var(--ink-k);
}

.stage-mark {
  margin-left: auto;
  color: var(--ink-k);
  font-size: 10px;
}

.stage-step:focus-visible {
  outline: 2px solid var(--ink-active);
  outline-offset: -2px;
  box-shadow: inset 0 0 0 1px var(--ink-k);
}
```

- [ ] **Step 7: Run everything**

```bash
npx playwright test
npx vitest run --project unit
npm run build
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/studio/StageSpine.tsx src/studio/useStudioKeys.ts src/studio/HalftoneStudio.tsx src/styles/globals.css tests/e2e/studio-ux.spec.ts
git commit -m "feat: add persistent stage spine and studio keyboard map"
```

---

### Task 9: Restyle auth screens and session badge

Deliverable: `/signup`, `/login`, and the session badge read as the same product as the studio. These were built against the previous theme and are now visually orphaned.

**Files:**
- Modify: `src/routes/Signup.tsx`, `src/routes/Login.tsx`, `src/auth/SessionBadge.tsx`, `src/styles/globals.css`

**Interfaces:**
- Consumes: `PRODUCT_NAME` from `src/brand.ts` (Task 4), tokens from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Restyle the auth surfaces**

Auth screens are one of the six surfaces §8 permits the misregistration effect. Render the wordmark there using `PRODUCT_NAME`:

```tsx
import { PRODUCT_NAME } from "../brand";
```

```tsx
      <h1 className="auth-wordmark glitch" data-text={PRODUCT_NAME}>
        {PRODUCT_NAME}
      </h1>
```

The `data-text` attribute is required — the `.glitch` pseudo-elements read it via `content: attr(data-text)`.

- [ ] **Step 2: Style the auth layout**

```css
.auth-form {
  max-width: 360px;
  margin: 64px auto;
  padding: 24px;
  background: var(--paper);
  border: 1px solid var(--rule);
}

.auth-wordmark {
  margin: 0 0 24px;
  font-family: var(--font-display);
  font-weight: 700;
  font-stretch: 125%;
  font-size: 28px;
  letter-spacing: -0.01em;
  color: var(--ink-k);
}

.auth-form label {
  display: block;
  margin-bottom: 16px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.auth-form input {
  display: block;
  width: 100%;
  min-height: 32px;
  margin-top: 4px;
  padding: 8px;
  background: var(--paper-2);
  border: 1px solid var(--rule);
  color: var(--ink-k);
  font-family: var(--font-ui);
  font-size: 14px;
}

.auth-form input:focus-visible {
  outline: 2px solid var(--ink-k);
  outline-offset: 0;
}

.auth-form button {
  width: 100%;
  min-height: 32px;
  padding: 8px;
  background: var(--ink-k);
  border: 1px solid var(--rule);
  color: var(--paper);
  font-family: var(--font-ui);
  font-weight: 600;
  cursor: pointer;
}

.auth-form button:disabled {
  background: var(--paper-3);
  color: var(--faint);
  cursor: not-allowed;
}

/* §3 hazard: errors are K on Y. */
.auth-form [role="alert"] {
  margin: 0 0 16px;
  padding: 8px;
  background: var(--ink-y);
  border: 1px solid var(--rule);
  color: var(--ink-k);
  font-size: 13px;
}
```

- [ ] **Step 2b: Style the session badge**

Read `src/auth/SessionBadge.tsx` for its actual class names, then style it with declared tokens only — zero radius, hairline border, no shadow other than the permitted offset. It sits over the studio, so it is within sight of the proof: **no glitch effect on it** (§8).

- [ ] **Step 3: Verify**

```bash
npx playwright test design-system
npx playwright test studio-ux
npm run build
```

Then with `npm run dev`, visit `/signup` and `/login` and confirm: the wordmark shows the misregistration at rest and snaps to register on hover; error states render black-on-yellow; nothing is rounded.

- [ ] **Step 4: Commit**

```bash
git add src/routes/Signup.tsx src/routes/Login.tsx src/auth/SessionBadge.tsx src/styles/globals.css
git commit -m "feat: restyle auth surfaces into the DR.GLITCH system"
```

---

### Task 10: Desktop-only guard, accessibility pass, and integrity scan

Deliverable: mobile gets a graceful state rather than a broken port, the §9 floor is verified, and the design-integrity scanner reports CLEAN.

**Files:**
- Modify: `src/studio/HalftoneStudio.tsx`, `src/styles/globals.css`
- Test: `tests/e2e/design-system.spec.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e/design-system.spec.ts`:

```ts
test.describe("accessibility floor and mobile", () => {
  test("mobile gets an open-on-desktop state, not a broken layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("desktop-only")).toBeVisible();
  });

  test("yellow never carries text", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
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

  test("focus is visible on every interactive control", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas");
    await page.keyboard.press("Tab");
    const hasIndicator = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      const s = getComputedStyle(el);
      return (
        (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
        s.boxShadow !== "none"
      );
    });
    expect(hasIndicator).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test design-system -g "accessibility floor"`
Expected: FAIL — no `desktop-only` element.

- [ ] **Step 3: Add the desktop-only state**

§11: this is a desktop production tool; mobile gets a graceful state, not a responsive port. In `HalftoneStudio.tsx`, render a sibling element that CSS reveals under a breakpoint. Do not conditionally unmount the studio on width — that would break resizing and require a reload.

```tsx
      <div className="desktop-only" data-testid="desktop-only">
        <p className="desktop-only-title">Open on a desktop</p>
        <p className="desktop-only-body">
          {PRODUCT_NAME} drives press separations at full resolution and needs a
          pointer and a large canvas. Open this on a desktop browser.
        </p>
      </div>
```

```css
.desktop-only {
  display: none;
}

@media (max-width: 900px) {
  .desktop-only {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    background: var(--paper);
    color: var(--ink-k);
  }

  .desktop-only-title {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 20px;
  }

  .desktop-only-body {
    margin: 0;
    font-size: 14px;
    max-width: 40ch;
  }
}
```

- [ ] **Step 3b: 8px grid spacing pass (carried from Task 3)**

Task 3 deliberately deferred this with explicit sign-off: it is ungated, unverifiable without a screenshot-diff harness, and has a high blast radius. It lands here instead, where the visual system is otherwise settled.

§5: 8px base grid. Sweep `src/styles/globals.css` for `padding` and `margin` values that are not multiples of 8 (or 4 where a half-step is genuinely needed on dense numeric rows), and snap them. Work section by section, checking the rendered result as you go — do NOT run a blind find/replace on every length in the file.

Leave alone: border widths, font sizes, line heights, `letter-spacing`, and any length inside a `@font-face` or `clip-path`. Those are not spacing.

After the sweep, re-run the full gate and confirm nothing moved:

```bash
npx playwright test design-system
npx playwright test render-regression
```

Report which sections you snapped and any value you deliberately left off-grid, with the reason.

- [ ] **Step 4: Fix any accessibility failures the tests surface**

Run: `npx playwright test design-system`

For each failure, fix the source. If a focus indicator is missing, add `:focus-visible { outline: 2px solid var(--ink-active); box-shadow: inset 0 0 0 1px var(--ink-k); }` — §9 requires the inner black rule so focus survives on yellow. Do not weaken the tests.

- [ ] **Step 5: Run the design-integrity scanner**

```bash
/opt/homebrew/bin/python3 ~/.claude/skills/design-integrity/scripts/scan.py \
  /Volumes/DriveB/Projects/halftone-web/src \
  --spec /Volumes/DriveB/Projects/halftone-web/docs/specs/2026-07-27-drglitch-ui-system-design.md
```

Resolve every finding. Expect these to come back `[CLEARED by spec]` — the spec declares them, so no action:
- tabular mono numerics (§4)
- uppercase letterspaced 10px/0.08em micro-labels (§4)
- ivory/paper canvas `#F4F1E9` (§3)

Anything NOT cleared is an unguided default and must be fixed. Target: SLOP SCORE `CLEAN`, zero uncleared hard violations. Paste the full scanner output into your report.

- [ ] **Step 6: Full suite**

```bash
npx playwright test
npx vitest run --project unit
npm run build
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/studio/HalftoneStudio.tsx src/styles/globals.css tests/e2e/design-system.spec.ts
git commit -m "feat: add desktop-only state and satisfy the accessibility floor"
```

---

## Deliberately not built here

**The name is adopted.** Michael approved `DR.GLITCH` on 2026-07-27; "DRC Halftone" was a Codex-generated placeholder. It is single-sourced in `src/brand.ts`. Dave Clayton should still see the lockup before any outbound announcement — that is a courtesy and a §2 formality, not a code gate.

**The hazard-yellow exception is implemented as specified**, with §3's pure-achromatic fallback documented but not built. If Michael rejects hazard yellow, the change is confined to the `[role="alert"]` rule in Task 9 and any over-limit state.

**Mobile is not ported.** §11 is explicit that this is a desktop production tool.

**Per-plate ink density is not built — it is not in the data model.** §6.3 asks for density alongside angle on each plate row. `HalftoneSettings` (`cellSize`, `contrast`, `exposure`, `opacity`, `dotShape`, `invert`, `angles{}`, `visible{}`) has no per-plate density; the existing "Ink density" control is the global `opacity`. Delivering this means adding a per-plate field to the engine's settings type and honoring it in `renderPlateDots` — which is an engine change, out of scope under §11, and would move the pinned render hashes. Angle IS delivered inline and editable (Task 7, Step 3b). Density needs a decision from Michael and Dave before any engine work is scoped.

**The engine is untouched.** `src/studio/halftone.ts` keeps its own `PLATE_META` render colors; the chrome uses the spec's process inks via a separate `CHROME_INK` map. The Playwright hash gate must stay green through every task — if it moves, the engine was modified and the change must be reverted.
