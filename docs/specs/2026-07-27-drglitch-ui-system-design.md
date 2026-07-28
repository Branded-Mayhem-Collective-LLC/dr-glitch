# DR.GLITCH — UI System Design

**Date:** 2026-07-27
**Status:** Workshop draft — for Dave Clayton's approval. Not adopted.
**Applies to:** `halftone-web` (currently shipping as "DRC Halftone / CMYK Studio")
**Supersedes:** the black/grey/orange theme in `src/styles/globals.css`

This document is the active brand spec for the product. Under the design-integrity
provenance rule, anything declared here is owned and legitimate; anything not
declared here is an unguided default and gets fixed.

---

## 1. Positioning

A diagnostic instrument for press work, built by a print production specialist for
print production specialists. Not a filter app, not a photo toy.

Brutalism here means **raw structure** — exposed grid, hairline rules, zero radius,
no soft shadow, no gradient. It does not mean shouting. The loudest thing on screen
must always be the artwork.

**The governing constraint:** nothing in the chrome may compete with, tint, or cast
onto the proof. A print tool that misleads the eye about ink is broken.

---

## 2. Naming

Proposed wordmark: **DR.GLITCH**. Reads as both a tool and a person, and sets up the
diagnostic vocabulary (Vitals / Diagnosis / Prescription) without extra scaffolding.

**Open — owner's call.** If this remains Dave's product, renaming `DRC Halftone` is
his decision, not ours. Renders show the proposed lockup so the name can be judged in
situ; nothing ships under it without written confirmation.

---

## 3. Color law (binding)

**Only real process inks appear anywhere in the product.** No orange. No decorative
accent. No tinted greys. Hue carries meaning or it does not appear.

### Plate inks — semantic, reserved

| Token | Value | Meaning |
|---|---|---|
| `--ink-c` | `#0093D0` | Cyan plate |
| `--ink-m` | `#E6007E` | Magenta plate |
| `--ink-y` | `#FFE800` | Yellow plate |
| `--ink-k` | `#101010` | Key plate |

These are process-ink approximations, **not** screen primaries (`#00FFFF` is banned —
it reads as RGB and undermines the product's credibility with press people).

No element may use these hues except to signify that channel.

### Chrome — achromatic

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F4F1E9` | Chrome ground |
| `--paper-2` | `#E9E5DA` | Recessed field, input wells |
| `--paper-3` | `#DDD8CB` | Disabled, dividers on paper |
| `--rule` | `#101010` | Every border and separator |
| `--rule-soft` | `#B8B2A4` | Secondary hairline only |

### Stage — neutral, proof-safe

| Token | Value | Role |
|---|---|---|
| `--stage` | `#1D1D1D` | Proof surround |
| `--stage-2` | `#242424` | Toolbar / footer bands |
| `--stage-rule` | `#363636` | Hairlines on stage |

Zero blue cast by design — these are true neutrals (R=G=B). A blue-tinted surround shifts
perceived ink density and makes the operator misjudge coverage.

*Revised 2026-07-27: the original values (`#1C1D1F`, `#232426`, `#34363A`) each leaned
+2 to +6/255 blue over red, contradicting the rule stated in this very paragraph. Michael
approved neutralising them.*

### Hazard — the one declared exception

Over-ink-limit, out-of-gamut, and destructive-action states render **K on Y**
(`--ink-k` on `--ink-y`). Still process inks; hazard yellow is native to shop-floor
language. Success states carry **no color at all** — a filled black mark only.

This is the sole place hue means something other than plate identity, and it is
scoped to output/alert contexts. If rejected, fall back to a pure achromatic alert
(black field, inverted paper text, hairline hazard stripe).

---

## 4. Typography

| Role | Family | Notes |
|---|---|---|
| Wordmark, stage numbers | **Archivo Expanded**, 700 | Press-poster weight |
| UI, labels, body | **Archivo**, 400/600 | Grotesque with real character |
| All numerics | **Martian Mono**, `font-variant-numeric: tabular-nums` | Angles, densities, LPI, zoom, dimensions |

Self-hosted `.woff2`, subset. No CDN (Workers CSP, and offline-capable studio).

**Banned as unbacked defaults:** Inter, Space Grotesk, Poppins, Montserrat, system-ui
as a design choice.

**Declared and owned:** tabular mono numerics, and uppercase letterspaced micro-labels
at `10px / 0.08em`. Both are documented AI tells in the general case. Here they are
domain requirements — a production tool needs figures that do not reflow as values
change, and needs field labels that survive at 10px. Owned by this spec, not slop.

---

## 5. Geometry

- **Radius: `0`.** Everywhere. No exceptions, including toggles and chips.
- **Borders:** `1px solid var(--rule)`. Active/primary blocks `2px`.
- **Shadow:** no blur, ever. The only shadow permitted is a **hard 2px/2px offset in
  the active plate ink** — a literal misregistration. `box-shadow: 2px 2px 0 var(--ink-active)`.
- **No gradients.** The current `<select>` arrow gradients are removed and replaced
  with a drawn glyph.
- **Grid:** 8px base. Section rules run **full-bleed** to the container edge — no inset
  margins on separators. That edge-to-edge rule is the brutalist signature.
- **Furniture:** hairline crop/registration ticks at panel corners. Real, quiet, 1px.

---

## 6. Color-separated UX — the core mechanic

The separation becomes the navigation.

### 6.1 Ink rail (new)
A vertical rail of four solid C/M/Y/K chips, visible only while the
**Separation** stage is active and fixed while the proof scrolls. Click a chip =
**solo that plate**. Modifier-click = toggle visibility. Solo is the single
largest speed win in the redesign and does not exist today.

### 6.2 Channel tinting (the law that makes it legible)
When a plate is active, **every active affordance in the inspector renders in that
plate's ink**: slider fill, focus ring, selected-row marker, the 2px offset shadow,
the active stage-number badge. Inactive affordances stay achromatic.

The operator never has to ask which plate they are editing.

Composite view: all four inks present as a hairline stripe rather than any single hue.

### 6.3 Plate rows
Angle and density live inline on each plate row, editable in place, tabular mono.
Not buried behind a disclosure.

---

## 7. Control-layer rework

- **Persistent 4-stage spine:** `01 ARTWORK · 02 SCREEN · 03 SEPARATION · 04 OUTPUT`.
  Always visible with completion state and jump-to. Today these scroll out of view.
- **Type, scrub, or slide every numeric.** Click the value to type; drag the label or
  value horizontally to scrub; use the visible range control for coarse visual
  adjustment. Shift accelerates scrubbing 10× and Alt/Option gives 0.1× precision,
  matching Adobe's established scrubby-slider convention.
- **Units always rendered**, never implied, never shifting layout.
- **Keyboard:** `1`–`4` solo plate · `` ` `` composite · `[` `]` cell size ·
  `Shift`+drag 10× · `Alt/Option`+drag 0.1× · `Space` pan.
- **Every control states its consequence** in one line of plain language. No LLM jargon,
  no "seamlessly", no "powerful".

---

## 8. Dr.Glitch brand voice — quarantined

Misregistration is the identity. It never touches a working surface.

**Permitted:** wordmark, auth screens, empty states, export sheet header, toasts,
splash. Out of register at rest; snaps into register on hover/focus.

**Forbidden:** the stage, any live control, any surface within sight of the proof, any
numeric readout. Glitch near a proof is a bug, not a brand.

---

## 9. Accessibility floor

- Plate identity is **never** carried by hue alone — every plate chip pairs its ink with
  its letter (C/M/Y/K) and its angle value. This matters more here than in most products,
  because the audience includes color-vision-deficient press operators.
- Focus is always visible: 2px offset in the active ink, plus a 1px black inner rule so
  focus survives on yellow.
- Yellow (`#FFE800`) never carries text at any weight except as a **background** behind
  `--ink-k`. Contrast on that pair is ~15:1.
- Hit targets ≥ 32px on chrome, ≥ 24px on dense numeric rows.
- `prefers-reduced-motion` disables the register-snap animation entirely.

---

## 10. Build shape

All theming currently lives in one hand-written `src/styles/globals.css` (1,145 lines,
semantic class names; Tailwind is imported but barely used). Consequently:

1. **CSS token rewrite** — palette, type, radius→0, hairline sweep, shadow replacement.
   Largest diff, lowest risk, no behavior change.
2. **Targeted TSX** — ink rail component, typed-numeric control, solo state in
   `HalftoneStudio.tsx`, keyboard map.
3. **Fonts** — two self-hosted families in `public/fonts/`, `@font-face` in globals.

No backend change. No routing change. No new dependencies beyond font files.

---

## 11. Out of scope

- Halftone/separation math (`src/studio/halftone.ts`) — untouched.
- Auth, workspaces, persistence — the hosted-workspaces plan
  (`docs/plans/2026-07-27-halftone-web-hosted-workspaces.md`) is unaffected.
- Mobile layout. This is a desktop production tool; mobile gets a graceful "open on
  desktop" state, not a responsive port.

---

## 12. Open items

| Item | Owner | Blocking? |
|---|---|---|
| Product name (`DR.GLITCH` vs keep `DRC Halftone`) | Dave | No — renders show proposed lockup |
| Commercial ownership (DRC vs 8gnc product) | Michael | No |
| Hazard-yellow exception vs pure achromatic alerts | Michael | No — fallback specified in §3 |
| Font licensing confirmation (Archivo, Martian Mono — both OFL) | Michael | No |
