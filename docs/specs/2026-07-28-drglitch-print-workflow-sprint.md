# DR.GLITCH — Print Workflow Mayhem Sprint

**Date:** 2026-07-28
**Decision owner:** Michael
**Methods:** SCAMPER → Reverse Brainstorming
**Decision:** Ship control fluency plus an honest preflight/handoff layer. Test
mesh-to-LPI guidance before treating it as production advice.

## 1. Frame

- **Decision:** Which controls and workflow features should ship next to reduce
  repetitive prepress work without changing the pinned halftone engine?
- **Audience:** [P] Screen-print prepress and press operators using the browser
  studio to inspect and export CMYK plates.
- **Current state:** [P] The product renders locally, solos four plates, edits
  angles, and exports a composite or four-plate ZIP. Stage controls looked
  clickable but only scrolled; numeric scrubbing lived on labels rather than
  values; only Zoom exposed a slider.
- **Desired motion:** [P] Repair basic control fluency, then add necessities
  that shorten setup, checking, and handoff.
- **Success:** [A] Fewer corrections after export; less repeated entry; a new
  operator can tell what is ready, questionable, or omitted before making film.
- **Novelty:** New to this product, not necessarily new to prepress software.
- **Constraints:** [P] No changes to `src/studio/halftone.ts`; exact DR.GLITCH
  process inks; zero radius; no gradients or blurred shadow; desktop-first;
  local processing; no fabricated press certainty.

### Evidence

- [S] Adobe documents type entry, sliders, arrow nudging, and scrubby labels;
  Shift accelerates a scrub by 10×.
  <https://helpx.adobe.com/ie/photoshop/using/panels-menus.html>
- [S] Chromaline defines LPI, mesh count, registration, trap, film density,
  and moiré as distinct prepress concerns; it notes that mesh, thread diameter,
  opening, stencil thickness, and exposure all affect printable detail.
  <https://chromaline.com/terms-acronyms-for-screen-making-cheat-sheet/>
- [S] Chromaline offers `mesh ≈ LPI × 4.5` as a useful starting rule while
  explicitly warning that thread diameter, mesh opening, and stencil thickness
  alter the result.
  <https://chromaline.com/harmonizing-mesh-count-to-line-count/>
- [S] ScreenPrinting.com similarly describes mesh/LPI relationships and the
  risk of moiré, while its CMYK example is a specific 305-mesh/55-LPI shop
  recipe—not a universal default.
  <https://www.screenprinting.com/blogs/news/a-crash-course-in-halftones-for-screen-printing>
  <https://www.screenprinting.com/blogs/news/how-to-print-cmyk-step-by-step-guide>
- [S] Epson’s screen-positive setup includes explicit output resolution,
  density, media, and feed-adjustment settings, reinforcing that film output
  assumptions belong in a handoff rather than remaining invisible.
  <https://files.support.epson.com/docid/cpd5/cpd50903.pdf>

## 2. Diverge

### Baseline round — expose the obvious field

1. Real stage tabs instead of near-invisible scroll jumps.
2. Type, scrub, and slide every numeric.
3. Reset each stage to product defaults.
4. Built-in recipe presets.
5. Undo and redo recipe edits.
6. Human-readable job ticket.
7. Copy settings to clipboard.
8. Preflight warnings before export.
9. Mesh/LPI calculator.
10. Repeat the last export in one click.

### Transformation round — change interaction, timing, or operating context

11. Mesh count input with a clearly qualified LPI starting band.
12. Target-LPI input that derives cell size from a declared output DPI.
13. Detect duplicate or near-colliding plate angles.
14. Warn when one or more plates are hidden at export.
15. Show source dimensions and output raster dimensions together.
16. Film-positive inspection mode.
17. Mirror-output option with an explicit press-side label.
18. Registration-mark style and placement options.
19. Film sheet size, orientation, and tiling.
20. Shop notes for mesh, ink system, substrate, and exposure.
21. Operator-saved recipes stored locally.
22. Source/halftone split comparison.
23. Searchable keyboard command palette.
24. Batch export queue for multiple artworks.
25. Output filename template with job and revision tokens.

### Contradiction round — remove a default assumption

26. No wizard: one consolidated press recipe strip.
27. No silent export: require explicit confirmation of hazards.
28. No re-entry: import `job-settings.json` from an earlier plate package.
29. No slider dependency: compact type-only control mode.
30. No account dependency: portable recipe files before cloud projects.
31. No hidden defaults: expose every output assumption in the job ticket.
32. No vague “complete” state: operator-reviewed checks per stage.
33. No export-menu repetition: make the previous export repeatable.
34. No manual angle entry: selectable angle sets, always editable afterward.
35. No blind final render: create a confidence report before generating plates.

## 3. Territory map

| Territory | Underlying move | Ideas |
|---|---|---|
| Control fluency | Make frequent adjustment reversible and muscle-memory friendly | 1, 2, 3, 5, 23, 29 |
| Recipe memory | Stop re-entering known setups | 4, 21, 28, 30, 34 |
| Preflight intelligence | Detect omissions and questionable combinations before film | 8, 11–15, 27, 31, 35 |
| Output automation | Remove repetitive packaging and naming work | 6, 7, 10, 16–20, 24, 25, 33 |
| Proof inspection | Make comparison and review explicit | 22, 26, 32 |

**Gaps:** [J] The field is strongest in UI and export automation, but weak in
real shop calibration evidence. Mesh/LPI advice becomes unsafe if the app does
not know thread diameter, mesh opening, stencil system, output DPI, and the
operator’s proven process.

**Bridge ideas:**

- Preflight + job ticket: the same facts used to warn the operator become the
  handoff record.
- Saved recipe + qualified mesh band: store the operator’s proven setup rather
  than pretending one global recommendation is correct.
- Stage review + repeat export: a reviewed recipe can repeat without reopening
  the full export menu.

## 4. Disrupt — reverse brainstorming

| Cause a downstream failure | Reverse into prevention or detection |
|---|---|
| Export a hidden plate accidentally | Show enabled plate count and name hidden plates before export |
| Forget registration marks | Expose registration state in preflight and ticket |
| Use duplicate plate angles | Detect exact shared angles; describe it as “review,” not guaranteed moiré |
| Lose the recipe after film output | Copy/download a human-readable setup ticket alongside JSON |
| Assume an arbitrary mesh/LPI rule is universal | Keep it experimental until shop variables and output DPI are explicit |
| Make a drag too sensitive and lose a known value | Typed value, visible slider, Shift 10×, Alt/Option 0.1×, stage reset |
| Hide output assumptions in UI state | Put dot, angle, visibility, invert, density, and registration in one summary |
| Crash the browser with an oversized export | Preserve the existing bounded export path; test sizing separately |

## 5. Converge

Criteria order: relevance (25), differentiation (20), feasibility (15),
evidence (15), learning value (10), accessibility/trust (15). Scores are 1–5;
weighted totals are out of 100.

| Candidate | Score sequence | Total | Confidence | Rationale |
|---|---:|---:|---|---|
| Control fluency layer | 5 / 3 / 5 / 5 / 4 / 5 | 90 | High | Directly fixes observed failure with a documented interaction model |
| Preflight + job ticket | 5 / 4 / 5 / 4 / 5 / 5 | 93 | High | Reuses factual state to prevent omissions and speed handoff |
| Local saved recipes | 4 / 4 / 4 / 3 / 4 / 5 | 80 | Medium | Strong repetition win, but project persistence is already a separate roadmap concern |
| Qualified mesh/LPI guide | 5 / 4 / 3 / 4 / 5 / 4 | 84 | Medium | Valuable, but credibility depends on inputs the product does not yet collect |
| Batch output queue | 4 / 3 / 2 / 3 / 3 / 4 | 65 | Low | Useful later; adds state and failure recovery before single-job workflow is proven |
| Split proof comparison | 4 / 3 / 4 / 3 / 4 / 5 | 76 | Medium | Helpful inspection tool, but lower downstream-error leverage than preflight |

### Portfolio

- **Dependable — ship:** Control fluency layer: real stage panels, synchronized
  sliders, value scrubbing, keyboard nudging, modifier speeds, collapse, reset.
- **Differentiated — ship:** Honest preflight + copyable job ticket. It reports
  source, screen, plate visibility, angles, registration, inversion, and density
  without making unsupported printability claims.
- **Frontier — test:** Qualified mesh/LPI guide. It should learn the operator’s
  actual mesh/thread/stencil/output configuration before recommending anything.

## 6. Prove

### Control fluency

- **Target outcome:** Operators change a value with their preferred modality and
  immediately see which stage is active.
- **Riskiest assumption:** [A] Three modalities add speed without adding clutter.
- **Cheapest test:** Instrumented task: reach specified cell size, contrast, and
  output density by typing, value-drag, and slider.
- **Success threshold:** 5/5 tasks complete without instruction; no accidental
  stage or plate changes.
- **Failure threshold:** Any modality is undiscoverable or produces an
  unrecoverable value jump.
- **Decision:** Ship now behind automated interaction tests.

### Preflight + job ticket

- **Target outcome:** Catch hidden plates or missing registration before export
  and remove manual transcription at handoff.
- **Riskiest assumption:** [A] Operators value a concise factual summary more
  than another settings panel.
- **Cheapest test:** Give three seeded recipes (clean, hidden plate, shared
  angle) and ask operators what they would export.
- **Success threshold:** Every seeded omission is noticed before export; copied
  ticket contains every required setup fact.
- **Failure threshold:** Warning language is mistaken for a print guarantee.
- **Decision:** Ship factual checks only; no blocking or universal “safe” claim.

### Qualified mesh/LPI guide

- **Target outcome:** Reduce test screens while preserving shop-specific truth.
- **Riskiest assumption:** [A] A compact set of inputs can represent enough of
  the shop process to make the guide trustworthy.
- **Cheapest test:** Compare the proposed band against 10 proven shop recipes,
  recording mesh count, thread diameter, stencil/EOM, output DPI, LPI, and
  printable tonal range.
- **Success threshold:** At least 8/10 proven recipes fall inside the qualified
  band or generate a useful explicit exception.
- **Failure threshold:** Operators treat the rule-of-thumb as certification.
- **Decision:** Do not ship recommendations yet; test and calibrate first.
