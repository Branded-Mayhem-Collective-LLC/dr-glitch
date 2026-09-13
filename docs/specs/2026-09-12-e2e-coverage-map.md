# DR.GLITCH Workstation — E2E Coverage Map and Selector Contract

Date: 2026-09-12
Status: **Binding contract.** The Playwright suites under `tests/e2e/workspace-*.spec.ts`,
`tests/e2e/projects-*.spec.ts`, and `tests/e2e/export-*.spec.ts` (plus
`tests/e2e/helpers/**`) were authored against the workstation plan while the
implementation was being built in parallel. Every selector, accessible name,
storage key, and file-name pattern below is asserted by at least one test.
The implementation must be reconciled to this map; where the map is wrong or
impractical, change the map and the tests together, deliberately — not by
drifting.

Authored files:

- `tests/e2e/helpers/storage.ts` — clean-storage reset, storage-key contract
- `tests/e2e/helpers/workstation.ts` — locator + flow contract
- `tests/e2e/helpers/downloads.ts` — download capture, PNG/JPEG/TIFF/ZIP oracles, in-page alpha probe
- `tests/e2e/helpers/a11y.ts` — focus/target/contrast/reduced-motion assertions
- `tests/e2e/helpers/two-tab.ts` — same-context second tab (Web Locks/BroadcastChannel scope)
- `tests/e2e/workspace-shell.spec.ts`
- `tests/e2e/workspace-a11y.spec.ts`
- `tests/e2e/projects-lifecycle.spec.ts`
- `tests/e2e/projects-history.spec.ts`
- `tests/e2e/export-preflight.spec.ts`

---

## 1. Selector contract

Convention: prefer `getByRole`/accessible names. Where a stable structural
hook is needed, use `data-testid` in kebab-case with the `ws-` prefix.
Testids carried over from the current studio are called out explicitly.

### 1.1 Top command bar

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-topbar` | testid | The 48px top command bar container. Present on home and editor; survives the size gate and Focus Mode. |
| `button "Home"` (in topbar) | role+name | Returns to the home surface (dirty guard applies). |
| `button "New"` | role+name | New project (dirty guard applies). |
| `button "Open"` | role+name | Open flow (dirty guard applies). |
| `button "Save"` | role+name | Explicit save. First save of a project opens the **"Save Project"** dialog; later saves are silent. |
| `button "Undo"` / `button "Redo"` | role+name | **Must use `aria-disabled` (not the `disabled` attribute)** so they stay in the tab order; `aria-disabled="true"` when the stack is empty. Tests read undo-stack state exclusively through this attribute. |
| `button "Export"` | role+name | Activates the Preflight/Export tool (same workflow as the rail entry). |
| `button "Help"` | role+name | Help entry. |
| `button "Workspace"` | role+name | Opens the workspace menu (see §1.8). |
| `ws-project-title` | testid | Project identity text; contains `/untitled/i` for new projects, the project title otherwise, and contains the snapshot name for a snapshot-duplicated project. |
| `ws-dirty-indicator` | testid | Visible iff the working revision differs from the saved revision. Carries text or `aria-label` matching `/unsaved|edited|dirty/i` — never color-only. Hidden when clean. |
| `ws-recovery-status` | testid | Shows text matching `/recovery/i` once the recovery journal has flushed a dirty edit (deterministic signal replacing 750ms sleeps in tests). |

Topbar tab order (asserted): Home → New → Open → Save → Undo → Redo → Export → Help.
(Account and Workspace may follow; they are not position-asserted.)

### 1.2 Tool rail

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-rail` | testid | Permanent 52px left rail. Hidden only in Focus Mode. |
| `button aria-label="<tool label>"` | role+name | Icon-only buttons named **exactly** by the registry labels (`src/core/tool-registry.ts`): `Select / Transform`, `Layers`, `Halftone`, `Diffusion`, `Glitch`, `Plates`, `History / Snapshots`, `Preflight / Export`. The name lives on `aria-label` (asserted as an attribute). |
| `ws-rail-separator` | testid + `role="separator"` | Sits between `Plates` and `History / Snapshots` in DOM order. |

Behavioral contract asserted:

- DOM order of rail buttons equals registry order (tools group, separator, system group).
- Every rail button ≥ 40×40 CSS px.
- Roving tabindex: exactly one rail button has `tabindex="0"`; ArrowUp/ArrowDown move focus, Home/End jump to first/last, focus never leaves the rail on arrows; Tab exits the rail entirely.
- Enter and Space activate the focused tool.
- Active tool exposed via `aria-pressed="true"` (all others `"false"`).

### 1.3 Dock, panels, floats

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-dock` | testid | Right dock container. Width tracks the splitter value. |
| `ws-dock-splitter` | testid + `role="separator"` | `aria-valuemin="320"`, `aria-valuemax="520"`, `aria-valuenow=<px width>`, default `360`. Keyboard: ArrowLeft widens, ArrowRight narrows, Home→320, End→520. Pointer drags clamp at both ends. `aria-disabled="true"` while layout is locked (arrows then no-op). |
| `ws-panel-<toolId>` | testid | The tool's **sole** panel instance wherever it lives (`toolId` ∈ select, layers, halftone, diffusion, glitch, plates, history, export). Accessible name of the panel region = the tool label. |
| `ws-panel-titlebar-<toolId>` | testid | Titlebar; mouse-drag target for floats. |
| `button "Panel menu"` (inside `ws-panel-<toolId>`) | role+name | Opens the panel `role="menu"`. |
| menuitems `Float`, `Dock Right`, `Close`, `Reset Position`, `Move`, `Resize` | role+name (exact) | Panel menu commands. Structural commands (`Float`, `Dock Right`, `Reset Position`, `Move`, `Resize`) get `aria-disabled="true"` under Lock Layout; `Close` stays enabled. |
| `ws-float-<toolId>` | testid | Floating window container; absent while docked/closed. Uses a numeric CSS `z-index` so raise-on-focus is testable by comparison. |
| `ws-float-resize-handle` (inside the float) | testid | Bottom-right pointer resize handle. |

Behavioral contract asserted:

- Activating a nonfloating tool shows its panel in the dock and hides the previously docked panel; one panel per tool, one docked panel.
- Activating a floated tool raises its float while the docked panel stays visible; interacting with any panel activates its tool.
- Titlebar mouse drag moves a float (±8px fidelity); **Escape during the drag cancels it** (also for keyboard Move/Resize modes, where arrows adjust and Enter commits).
- Float minimum size 320×240, enforced against both pointer and keyboard resize.
- `Dock Right` hides the displaced dock panel; rail activation of the displaced tool re-docks it.
- `Close` remembers placement (float rect within ±2px on restore via rail activation).
- After a viewport shrink, float titlebars clamp back on-screen (fully inside vertically; ≥120px visible horizontally).

### 1.4 Drawers (fixed upper-right)

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-drawers` | testid | Drawer strip container. |
| `button "Document"`, `button "Proof"`, `button "Output"` (in `ws-drawers`) | role+name | Toggle buttons with `aria-expanded`. **At most one expanded**; expanding one collapses the others; collapsing the expanded one leaves none. |
| `ws-drawer-document` / `ws-drawer-proof` / `ws-drawer-output` | testid | Drawer content regions, visible iff expanded. |

Drawer content asserted by tests:

- **Proof** drawer: `combobox "Proof plate"` (options include `composite`, `cyan`, `magenta`, `yellow`, `black`), `numeric-zoom` testid, `button "Fit"`, `button "100%"`. Changing any of these must NOT create undo transactions.
- **Document** drawer expanded by default on a new/sample project.

### 1.5 Editor surface

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-artboard` | testid | Artboard host region. |
| `ws-canvas` | testid | The visible proof canvas element. Visibility is the tests' "editor is up" signal. |
| `ws-size-gate` | testid | Replaces only the editor below 1280×800; contains the literal strings `1280` and `800`; topbar remains visible; all project/tool state survives restore. |
| `ws-ruler-horizontal`, `ws-ruler-vertical` | testid | Unit-aware rulers. Dragging from `ws-ruler-vertical` onto the canvas creates a vertical guide. |
| `ws-guide-vertical`, `ws-guide-horizontal` | testid | Rendered guide elements (counted by tests; creation is undoable/redoable). |
| `role="status"` | role | Global status live region (existing idiom retained: save confirmations, export cancellation `/cancel/i`, etc.). |

### 1.6 Home surface, projects, trash

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-home` | testid | Home/start surface. Shown on first load with clean storage. |
| `region "Recent projects"` | role+name | Recent list container. |
| `button "New Project"`, `button "Open Project File"`, `button "Open Sample"`, `button "Trash"` (in `ws-home`) | role+name (exact) | The four home actions. `Open Sample` opens the sample **unsaved**. |
| `ws-open-project-input` | testid | File input (accepts `.drglitch`) backing "Open Project File"; tests call `setInputFiles` on it directly. |
| `ws-project-card` | testid | One card per saved project; card text contains the title. Each card has `button "Open"` and `button "Project actions"`. |
| Card menu items: `Rename`, `Duplicate`, `Export Project`, `Move to Trash` | role=menuitem (exact) | `Rename` opens dialog **"Rename Project"** (`textbox "Project name"`, `button "Rename"`). `Duplicate` creates a card whose title contains the source title plus `/copy/i`. `Export Project` downloads `<title>.drglitch`. |
| `ws-trash` | testid | Trash view (from home `button "Trash"`), listing trashed projects with `button "Restore"`, `button "Delete Permanently"`, and a view-level `button "Empty Trash"`. Destructive actions confirm via dialogs named **"Delete Permanently"** / **"Empty Trash"** whose confirm buttons repeat the same name. |
| `ws-recovery-banner` | testid | Shown after reopening a project whose recovery journal is newer than the save; contains `/recovered/i` plus `button "Save"` and `button "Revert to Last Save"`. |
| `ws-readonly-badge` | testid | Shown in a tab that opened a project owned by another tab; contains `/read.?only/i`, `button "Request Ownership"`, `button "Duplicate Project"`. Ownership transfer flips the badge between tabs. |

Dialogs (all `role="dialog"`, names exact):

- **"Save Project"** — `textbox "Project name"`, `button "Save"`.
- **"Unsaved changes"** — `button "Save"`, `button "Discard"`, `button "Cancel"`; Escape = Cancel and focus returns to the invoking control.
- **"Rename Project"**, **"Delete Permanently"**, **"Empty Trash"** — as above.

### 1.7 Tool panel internals used by tests

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-layer-row` (in Layers panel) | testid | One row per layer, top-to-bottom; clicking selects (primary). Row contains a `checkbox` named `/visible/i`. |
| Layers toolbar: `button "Duplicate Layer"`, `button "Delete Layer"`, `button "Move Layer Up"`, `button "Move Layer Down"` | role+name (exact) | Act on the selection; all undoable. |
| `radiogroup "Layer mode"` with radios `Clean`, `Halftone`, `Diffusion` (in Layers panel) | role+name | Primary-layer mode; switching is **one** undoable action that preserves inactive settings. |
| `numeric-transformX` (in Select/Transform panel) | testid | Primary-layer X position in document px, existing NumericField idiom (fill + Enter commits). Companion fields (`numeric-transformY`, `numeric-transformRotation`, …) follow the same naming but only `numeric-transformX` is currently asserted. |
| `numeric-cellSize`, `numeric-cellSize-slider` (in Halftone panel) | testid | Carried over from the current studio NumericField contract. A slider mouse scrub = one undo transaction; Escape mid-scrub cancels without a transaction. |
| Plates panel: `combobox "Color mode"`, `ink-chip-<plate>`, `ink-angle-<plate>` | name/testid | **Carried over unchanged** from the current studio (`InkRail`). `ink-angle-cyan` is the tests' canonical no-layer undoable document edit. |
| Presets (in Halftone/Diffusion/Glitch panels): `button "Save Preset"`, `button "Apply Preset"`, `button "Export Preset"`, `ws-preset-select`, `ws-preset-import-input` | role+name / testid | Save opens dialog **"Save Preset"** (`textbox "Preset name"`, `button "Save"`). Apply is explicit and undoable. Export downloads `<name>.drpreset` (JSON: `schema:1`, `name`, `mode`, `halftone`, `diffusion`, `glitch`, `customDotSvg`; **no** transform/opacity/separation/output keys). Import file input accepts `.drpreset`. Presets are device-global (IndexedDB) — wiped by a storage reset, restored by import. |
| History panel: `button "Create Snapshot"`, `ws-snapshot-row`, row buttons `"Restore Snapshot"`, `"Duplicate to New Project"` | role+name / testid | Create opens dialog **"Create Snapshot"** (`textbox "Snapshot name"`, `button "Create"`). Restore is one undoable action. Duplicate opens a new **unsaved** project whose title contains the snapshot name; the source project is untouched. |

### 1.8 Workspace menu, layout, storage keys

| Item | Contract |
| --- | --- |
| Workspace menu (topbar `button "Workspace"`) | `role="menu"` containing `menuitemcheckbox "Focus Mode"`, `menuitemcheckbox "Lock Layout"` (with `aria-checked`), `menuitem "Reset Layout"`. `Reset Layout` remains operable while locked (reset unlocks). |
| Focus Mode | Hides `ws-rail`, `ws-dock`, every `ws-float-*`; keeps `ws-topbar` and `ws-canvas`; toggling off restores float rects (±2px), docked panel, and drawer expansion exactly. Session-only. |
| Reset Layout | Hides floats, dock width → 360, docks the active tool, unlocks; **never** changes document state (asserted via a plate angle). |
| localStorage `drglitch.workspace-layout.v1` | Persisted `WorkspaceLayoutStateV1` JSON. Float placement and dock width survive reload. Unparseable/garbage content falls back to the default arrangement without crashing. |
| localStorage `drglitch.debug.export-tile-delay-ms` | **Dev-build-only test seam**: positive integer adds that many ms of artificial delay per export tile/plate so progress and cancellation are deterministically observable. Production builds must ignore it. |
| IndexedDB database `drglitch` | All stores (projects, assets, thumbnails, recovery, presets, trash, staging) live in this one database so the clean-storage helper can delete it by name where `indexedDB.databases()` is unavailable. |
| New-project defaults | Select/Transform active, Layers docked, Document drawer expanded, no floats. |
| Reduced motion | Under `prefers-reduced-motion: reduce`, workspace chrome (`ws-dock`, floats, drawers) computes `transition-duration: 0s` and all dock/float/drawer operations still function. |
| Reload behavior | Preferred: session restore straight into the last open project (applying newer recovery). Tests tolerate a home landing by reopening the Recent card (`reloadIntoProject` helper) — but recovery restoration must be automatic once the project is open. |

### 1.9 Export workflow (Preflight/Export panel)

| Selector | Kind | Contract |
| --- | --- | --- |
| `ws-panel-export` | testid | The single export/preflight workflow, reached identically from topbar `Export` and the rail tool. |
| `ws-preflight-list` | testid | Issue list; each issue element carries `data-severity="block"` or `"warn"`. |
| `radiogroup "Export target"` → radios `Composite`, `Plates`, `Selected Layer` | role+name | Target selection. |
| `radiogroup "Format"` → radios `PNG`, `JPEG`, `TIFF` | role+name | Composite formats. |
| `radiogroup "Plate format"` → radios `Raster PNG (ZIP)`, `Vector SVG (ZIP)` | role+name | Plate formats. Vector radio is `disabled` when any contributing layer is ineligible. |
| `ws-vector-ineligible-reason` | testid | Visible explanation (`/continuous|clean|raster/i`) when vector plates are unavailable. |
| `checkbox "Registration marks"` | role+name | Default checked for `Plates`, unchecked for `Composite` and `Selected Layer`; user override honored. |
| `button "Export Now"` | role+name | Primary action. `disabled` while any `block` issue exists. |
| `ws-export-blocked-reason` | testid | Visible text explaining the hard block. |
| dialog **"Review warnings"** | role+name | Raised when only `warn` issues exist; lists them (angle warnings mention `/angle/i`); `button "Export Anyway"` proceeds, `button "Cancel"` aborts with no download. |
| `ws-export-progress` | testid (`role="progressbar"` recommended) | Visible during export; hidden after completion/cancel. |
| `button "Cancel Export"` | role+name | Cancels; `role="status"` announces `/cancel/i`; **no download event fires** after cancel. |

File-name and byte contracts (asserted):

**Filename canon (2026-09-12 reconciliation).** The base name `<base>` is
`exportBaseName(title)` in `src/export/targets.ts`, which reproduces the
shipped studio's `cleanName` exactly: strip one trailing `.extension`, keep
only `[a-z0-9-_]`, lowercase (plus collapse/trim of `-` runs and an
`untitled` fallback). "DR.GLITCH sample artwork" → `dr` — the historical
oracle the migrated legacy specs pin. Decision rule applied: artifacts the
shipped app produced keep its exact names (legacy wins); artifacts new to
the workstation take the workstation contract.

| Target | Filename | ZIP entry names | Decided by |
| --- | --- | --- | --- |
| Composite PNG/JPEG/TIFF | `<base>-halftone.png` / `.jpg` / `.tiff` | — | Legacy (shipped `exportArtwork`) |
| Raster plate package (CMYK) | `<base>-CMYK-plates.zip` | `<base>-C-plate.png`, `-M-`, `-Y-`, `-K-` + root `job-settings.json` | Legacy |
| Raster plate package (grayscale) | `<base>-K-plates.zip` | `<base>-K-plate.png` + root `job-settings.json` | Legacy |
| Vector plate package | `<base>_SVG_Plates.zip` | `<base>_SVG_Plates/C.svg` (… `M`/`Y`/`K`) + `<base>_SVG_Plates/job-settings.json` | Legacy |
| Selected layer PNG/TIFF | `<base>-layer.png` / `.tiff` | — | New (workstation contract; no legacy equivalent) |
| Project archive | `*.drglitch` | — | New (workstation contract) |
| Recipe preset | `*.drpreset` | — | New (workstation contract) |

| Artifact | Filename | Bytes |
| --- | --- | --- |
| Composite PNG | `*-halftone.png` | PNG signature; **exactly one** `pHYs` chunk, 9449 ppm both axes, unit 1 (= 240 DPI). |
| Composite JPEG | `*-halftone.jpg` | `FF D8 FF`. |
| Composite TIFF | `*-halftone.tiff` | `II*\0` or `MM\0*`. |
| Raster plate package | `*-CMYK-plates.zip` / `*-K-plates.zip` | Plate entries named so they match `/(^|[-/])C-plate\.png$/` (likewise M/Y/K). CMYK+all-visible → exactly 4 PNG entries; grayscale → exactly 1 (K). Each plate PNG carries the single 240-DPI `pHYs`. |
| Vector plate package | `*_SVG_Plates.zip` | 4 `.svg` entries matching `/(^|[-/])K\.svg$/` etc. (entries live inside the `<base>_SVG_Plates/` folder); SVG contains real geometry (`<circle|<rect|<path`) and **never** `<image`. |
| Selected layer | `*-layer.png` | Full-artboard dimensions; corner pixels alpha 0; contains both transparent and inked pixels; moving the layer +200 doc px shifts the ink bounding box by 200±32 px. |
| Project archive | `*.drglitch` | ZIP (`PK`). Import opens unsaved with a new local identity (saving yields a second card; the original is untouched). |
| Recipe preset | `*.drpreset` | JSON per §1.7. |

> Changelog 2026-09-12 (filename contract): reconciled a three-way filename
> divergence. `src/export/targets.ts` originally produced `-composite.*`,
> `-png-plates.zip` / `-svg-plates.zip`, and `<base>-C-plate.svg` entries,
> while `export-preflight.spec.ts` expected `*-plates.zip` /
> `*-vector-plates.zip` with `C.png` / `C.svg` entries, and the migrated
> legacy specs (`desktop-parity`, `custom-shape`) pinned the shipped names
> (`dr-K-plate.png`, `-K-plates.zip`, `dr_SVG_Plates/C.svg`). Resolution:
> legacy names win for every artifact the shipped app produced;
> `targets.ts` (+ `orchestrator.ts` entry naming), the export unit tests,
> and `export-preflight.spec.ts`'s filename regexes were updated to the
> canon above. Migrated legacy specs unchanged.

---

## 2. Spec-to-plan traceability

Plan references are to `/tmp/dr-glitch-workstation-plan-20260912.md` sections
("Workspace contract" = WC, "History, snapshots, presets, and projects" = HP,
"Secure import and export" = SIE, "Required verification" = RV).

| Plan requirement | Spec file · test |
| --- | --- |
| WC: rail order + separator, no placeholders | workspace-shell · "rail lists all eight tools…" |
| WC/RV: 40px rail targets | workspace-shell · "every rail button meets the 40px target floor"; workspace-a11y · "rail buttons expose keyboard focus at the 40px floor…" |
| WC: roving tabindex Arrow/Home/End/Enter/Space | workspace-shell · "rail is one roving tab stop…", "Enter and Space activate…" |
| WC: nonfloating tool → sole panel in dock | workspace-shell · "activating a nonfloating tool shows its sole panel…" |
| WC: floated tool activation raises float, dock panel may remain | workspace-shell · "selecting a floated tool raises its float…" |
| WC: interacting with a panel activates its tool | workspace-shell · "floats raise on focus and interacting with a panel activates its tool" |
| WC: float via titlebar menu; titlebar drag | workspace-shell · "Float via titlebar menu detaches…" |
| WC: keyboard menu commands Float/Dock Right/Close/Reset Position/Move/Resize | workspace-shell · keyboard Move/Resize tests; workspace-a11y · "panel menu is fully keyboard operable…" |
| WC: Escape cancels move/resize | workspace-shell · "Escape during a titlebar mouse drag…", keyboard Move/Resize tests |
| WC: minimum float 320×240 | workspace-shell · "keyboard Resize… 320x240 minimum holds" |
| WC: docking into occupied dock hides displaced panel | workspace-shell · "Dock Right hides the displaced dock panel…" |
| WC: close remembers placement; rail restores | workspace-shell · "Close remembers float placement…" |
| WC: clamp recovered floats (titlebar reachable) | workspace-shell · "floats clamp back on-screen after the viewport shrinks" |
| WC: auto-saved single workspace layout | workspace-shell · "layout persists across reload…" |
| WC: corrupt layout falls back safely | workspace-shell · "corrupt persisted layout falls back…" |
| WC: Lock Layout semantics | workspace-shell · "Lock Layout blocks move/resize/dock…" |
| WC: Reset semantics incl. never touching document | workspace-shell · "Reset Layout restores defaults, unlocks, and never touches canvas state" |
| WC: Focus Mode explicit, exact restore, topbar kept | workspace-shell · "Focus Mode hides rail, dock, and floats…" |
| WC: new-project default arrangement | workspace-shell · "Select/Transform active, Layers docked, Document expanded, no floats" |
| WC: drawers — at most one expanded | workspace-shell · "at most one drawer is expanded at a time" |
| WC: dock 360 default, resizable 320–520 (pointer + keyboard) | workspace-shell · dock splitter tests |
| WC: size gate below 1280×800 replaces only editor, preserves state | workspace-shell · size gate test |
| WC/RV: reduced motion | workspace-shell · reduced-motion test |
| WC: WCAG — visible focus, no color-only state, names, focus restoration | workspace-a11y · all tests |
| RV: keyboard-only pass / screen-reader names | workspace-a11y · "topbar commands tab in visual order…", name tests, panel-menu test |
| HP: home surface Recent/New/Open/Sample/Trash | workspace-shell · home-surface tests; projects-lifecycle · all |
| HP: explicit Save vs recovery journal (~750ms) | projects-lifecycle · "dirty indicator appears on edit…" (uses `ws-recovery-status` instead of sleeping) |
| HP/RV: crash reload → recovered/dirty + Save/Revert | projects-lifecycle · both recovery tests |
| HP: New/Open/Home dirty guard Save/Discard/Cancel | projects-lifecycle · "New with dirty work offers…"; projects-history · snapshot test (Home guard); workspace-a11y · dialog Escape test |
| HP: rename/duplicate/portable export/Move to Trash cards | projects-lifecycle · rename/duplicate + trash tests |
| HP: Trash Restore / Delete Permanently / Empty Trash | projects-lifecycle · trash test |
| HP: .drglitch export captures working state; import opens unsaved, new identity | projects-lifecycle · round-trip test |
| HP/RV: second tab read-only, request ownership, duplicate | projects-lifecycle · cross-tab tests (same-context tabs) |
| HP: quota errors preserve work | projects-lifecycle · `test.fixme` with rationale (needs unit-level failure injection) |
| HP/RV: undo across layers/transforms/recipes/document-globals | projects-history · first two undo tests |
| HP: mode switch = one undoable action, keeps inactive settings | projects-history · "switching layer mode…" |
| HP: undo excludes selection/proof/zoom/panels | projects-history · "selection, proof plate, and zoom never enter the undo stack" |
| HP/RV: transaction coalescing for scrub; Escape cancels | projects-history · coalescing + both Escape tests |
| HP: guides undoable | projects-history · guides test |
| HP/RV: snapshot restore undoable; duplicate-to-new-project | projects-history · snapshot test |
| HP/RV: presets save/apply/export/import (.drpreset scope) | projects-history · presets test |
| SIE: topbar Export and rail reach the same workflow | export-preflight · "one workflow, two entries" |
| SIE/RV: composite PNG/JPEG/TIFF with 240-DPI metadata | export-preflight · composite format tests |
| SIE/RV: plate PNG ZIP (CMYK 4 / grayscale K-only) | export-preflight · plate package tests |
| SIE: vector SVG ZIP eligibility + explanation, no hidden raster | export-preflight · vector test |
| SIE/RV: selected-layer transparent PNG preserving placement | export-preflight · selected-layer test |
| SIE: registration defaults per target + override | export-preflight · registration test |
| SIE/RV: hard-block issues stop export | export-preflight · "hard preflight issues block export entirely" |
| SIE: warn issues require revision-bound confirmation | export-preflight · warnings test |
| SIE/RV: progress + cancel, no partial output | export-preflight · progress/cancel test (uses the dev delay seam) |

Not covered here (delegated elsewhere, per plan): renderer parity/knockout/
perspective math (vitest + harness oracles), archive attack-testing
(traversal/bombs/CRC — unit + integration), Sentry redaction, performance
gate, File System Access streaming for oversized exports (Chromium-only API;
no E2E authored — see open questions).

Browser posture: all suites are written Chromium-first against the project's
single default Playwright project. Nothing in them requires File System
Access (downloads use the Blob path), and the clean-storage helper has a
fallback for engines without `indexedDB.databases()`. When Firefox/WebKit
projects are added to `playwright.config.ts`, the intended smoke subset is:
workspace-shell "rail" + "new project defaults", projects-lifecycle
"create, save, and reopen", export-preflight "composite PNG". No
per-test skips were needed beyond the quota `fixme`.

---

## 3. Legacy E2E specs — MIGRATED to the workstation entry contract (2026-09-12, second pass)

All five breaking specs listed in the first pass have been migrated in place.
No `test.fixme` was required; nothing was deleted silently. Shared entry
helpers were added to `tests/e2e/helpers/workstation.ts`:

- `openFreshStudio(page)` — clean storage → `ws-home` → `Open Sample` →
  first proof frame rendered (the preview canvas keeps its 300px default
  width until the renderer sizes it, so `width > 300` is the deterministic
  render signal the pixel-snapshot specs need).
- `openStudioWithUpload(page, file)` — `openFreshStudio` then the real
  Select-panel upload path (hidden
  `input[accept="image/png,image/jpeg,image/webp"]`), resolving when the
  upload card names the new source.
- `proofCanvas`, `artworkFileInput`, `registrationFileInput`,
  `uploadCardName`, `ensureDrawerExpanded` — content-level locators the
  migrated specs share.

Filename/byte oracles hold under the sample entry because the sample layer
is `createDemoArtwork()` PNG-encoded (lossless; the demo artwork is fully
opaque, so decode is pixel-identical) and its layer name
"DR.GLITCH sample artwork" cleans to the historical `dr` base name
(`dr-K-plate.png`, `dr-…-plates.zip`, `dr_SVG_Plates/…`).

| Spec | Migration performed |
| --- | --- |
| `studio-ux.spec.ts` | Entry → `openFreshStudio`; `stage-plates` → Plates tool, `stage-halftone` → Halftone tool, `stage-output` → Export panel, `.top-actions` export dropdown → topbar `Export` menu (`role=menuitem`), `stage-surface` pan-arming → `ws-canvas[data-pan-armed]`, sheet/orientation → Document drawer, scale/fit/mirror → Select panel, `"Reset Halftone controls"` → panel-scoped `/Reset halftone/i` (visible name is now "Reset halftone / CMYK controls"). Ink-rail, NumericField, artboard-label, preflight, shortcut (1–4/`/[/]`), and job-ticket assertions carried over verbatim. **Rewritten to the workspace-contract equivalent** (old surface contractually gone): "all six stages visible" → all eight rail tools in viewport; "inspector collapse" → panel-menu Close empties the dock (`dock-empty`) and rail activation restores a panel; "Space activates a focused stage control" → Space on a focused rail tool activates without arming pan; "inactive stage labels meet AA contrast" → drawer-toggle labels meet AA contrast (the rail is icon-only; its names are aria-labels asserted in workspace-a11y); "the ink rail is the only plate-angle editor" now asserts a single `ink-angle-cyan` scoped inside `ws-panel-plates` (the `.inspector .angle-field` zero-count is meaningless in the new DOM). **Dropped** (concept removed by the contract, coverage exists elsewhere or nowhere to re-home): stage completion badges (`data-complete`), stage-label clip test, and the `.view-status` "Centered artwork proof" copy (the status line is now the live-preview hint). |
| `desktop-parity.spec.ts` | Entry → `openFreshStudio`; tool navigation via rail; export via topbar `Export` menu (menuitem names unchanged: Composite PNG/JPG/TIFF, Vector SVG plate package, CMYK/Grayscale K plate package); registration controls + import + Copy job ticket → Export panel; background control → Document drawer (`ensureDrawerExpanded`); `Registration marks` checkbox scoped to `ws-panel-export` (the Proof/Output drawers now carry sibling registration toggles). Every byte/zip/job-settings oracle unchanged (`dr-K-plate.png`, `-K-plates.zip`, pHYs 9449, `omittedPlates`). Harness engine tests untouched. |
| `design-system.spec.ts` | Entry → `openFreshStudio`; `stage-plates` → Plates tool for the dial-geometry check; `desktop-only` → `ws-size-gate` with the new semantics (editor-only gate at 1280×800; topbar stays operable — the mobile test now asserts hidden `.ws-main` controls and that focus never lands in the gated regions instead of "nothing focusable at all"). Palette/geometry/font/focus audits unchanged and now sweep the full workstation chrome. **Flag for the lead:** the audits cover the studio plus `/landing`, `/login`, `/signup`; the home surface (`ws-home`) is NOT audited — `home.css` uses `#fff`, `#5c574b`, `#b8b2a4`, which are outside the declared palette, so bringing Home under the 2026-07-27 law is a product decision, not a test edit. |
| `auth-ui.spec.ts` | Entry-only: the two studio tests use `openFreshStudio` (+ Plates tool for focus-follows-plate). Auth-route tests untouched. |
| `custom-shape.spec.ts` | Entry → `openFreshStudio`; `stage-halftone` → Halftone tool; export + job ticket via topbar menu / Export panel; reset via panel-scoped `/Reset halftone/i`. Dialog assertions (testids, "Use shape"/"Choose SVG"/Cancel, focus restore, error copy) carried over verbatim. The module-only bounds test now enters via `/tests/e2e/harness.html` (established idiom for engine-module tests). The CMYK/grayscale plate-export pixel oracle still renders its expectation from `createDemoArtwork()` — valid because the sample layer is that artwork, losslessly round-tripped (see above). |
| `image-import.spec.ts` | Entry → `openFreshStudio`; artwork input selected by the same accept attribute (still the real input behind the Select-panel upload card / canvas drop); `.upload-card strong` → `uploadCardName` (Select panel); registration import moved from `stage-output` to the Export panel (`registrationFileInput`, filename `<span>` and `/Reset/` → "Reset output controls" scoped to `ws-panel-export`). Stale/invalid-source semantics asserted unchanged. Note: "Reset output controls" no longer clears the loaded mark itself, but the test's intent (an in-flight valid import survives a reset and lands afterwards) is asserted exactly as before. |
| `process-motion.spec.ts` | Verified `/landing` route unchanged in `src/routes/index.ts`; spec untouched. |
| `render-regression.spec.ts` | Untouched by design: it enters via `/tests/e2e/harness.html`, never `/`, and its oracle imports `/src/studio/halftone.ts` (still present) against the SHA-pinned fixture. Pixel/byte oracles preserved exactly. |
| `svg-export.spec.ts` | Untouched — same harness dependency, module paths unchanged. |

Verification note: `npx tsc --noEmit` is clean; `npx eslint tests/e2e` reports
one pre-existing error inside the SHA-pinned fixture
(`fixtures/renderer-3084f80/halftone.ts` — unused `index`), which must not be
edited without a deliberate hash update.

`playwright.config.ts` note (not modified): the new suites assume the same
`baseURL`/viewport (1440×1000). Adding Firefox/WebKit smoke projects and a
larger default `timeout` for the export suite is the lead's call.

---

## 4. Open questions for the lead

1. **Reload semantics.** Tests tolerate both session-restore-into-editor and
   land-on-home (helper `reloadIntoProject`), but recovery must apply
   automatically once the project opens. Pick one and consider tightening the
   helper afterward.
2. **First-save dialog.** Contracted as: first Save opens "Save Project" with
   a name field; later saves silent. If the design saves immediately with a
   default title instead, `saveProjectAs` and several lifecycle tests change.
3. **Ownership handoff.** Contracted as: "Request Ownership" transfers
   immediately (idle owner drops to read-only via BroadcastChannel). If the
   design requires the owner to grant, the cross-tab test needs a grant step.
4. **Hard-block trigger.** Tests induce a block by hiding all layers
   ("nothing printable"). If that is modeled as a warn instead, another
   UI-inducible block condition must be nominated (missing asset isn't
   reachable from the UI).
5. **Export delay seam.** `drglitch.debug.export-tile-delay-ms` is the only
   way to make progress/cancel deterministic from Playwright (worker code
   can't be monkey-patched via init scripts). Needs a guarded dev-build hook.
6. **Preset surface placement.** Presets are contracted inside each recipe
   panel (Save/Apply/Export/Import + `ws-preset-select`). If they live in a
   single shared surface instead, only locator scoping changes.
7. **Layer-mode control.** Contracted as a "Layer mode" radiogroup in the
   Layers panel. If mode switching instead happens by engaging the
   Halftone/Diffusion panels, the mode-switch and vector-eligibility tests
   need rewording (the undo semantics asserted stay identical).
8. **Sample project shape.** Tests assume: exactly one visible, unlocked,
   halftone-mode, vector-eligible layer, roughly centered with ≥300px margin,
   CMYK separation. Please keep the bundled sample within that envelope or
   flag deviations.
9. **Duplicate-angle warning.** The warn-flow test sets C to Y's default 0°.
   If Y's default changes, the test's angle value must follow.
10. **File System Access streaming.** No E2E covers the oversized-export
    streaming path (Chromium-only, requires a real file picker — not
    automatable headlessly). Recommend a unit/manual checklist item instead.

## 5. Palette-law triage notes (2026-09-12, triage A)

No declared-color allowlist changes were needed; every offender mapped onto
existing declared tokens (design spec §3):

- `ws-dirty-indicator` is now a **K-on-Y chip** (`--ink-k` text on `--ink-y`
  background) per §3 hazard / §9 "yellow never carries text". Its text
  contract (row in §1 above) is unchanged.
- Ruler chrome (`ws-ruler*`) retokenized: `#232426`→`--stage-2`,
  `#3a3b3d`/`#55565a`→`--stage-rule`, `#85868a`/`#9b9ca0`→`--rule-soft`.
- Guide/snap indicators retokenized to exact process inks:
  `#00a9c8`→`--ink-c`, `#e53578`→`--ink-m` (guides are plate-identity cues).
- `src/home/home.css` literals replaced with declared tokens (`#fff`→`--paper`,
  `#5c574b`→`--ink-k`; the system has no muted ink on paper — matches the
  auth surfaces). No law extension for the home surface.
- Scrims may not use rgba(): use a solid declared token dimmed with the
  `opacity` property (see `.ws-help-backdrop::before`, `.ws-dialog-scrim::before`,
  `.custom-shape-dialog::backdrop`).
- Reduced motion zeroes durations to exactly `0s` (not `0.01ms`): the
  workspace-chrome contract asserts computed `transition-duration === 0`.
- OPEN (routed): `src/workspace/panels/PlatesPanel.tsx:33` hardcodes plate
  swatches `["#00a9c8", "#e53578", "#f0d422", "#202226"]` — must become the
  exact declared process inks (`#0093D0`, `#E6007E`, `#FFE800`, `#101010`,
  i.e. PLATE_META). File owned by the panels agent.

## 6. Wave-F additions (2026-09-12, plan-fidelity wave)

New/changed selectors, all asserted by `tests/e2e/output-ownership.spec.ts`,
`tests/e2e/workstation-fidelity.spec.ts`, or the extended
`tests/e2e/export-preflight.spec.ts`:

| Selector | Kind | Contract |
| --- | --- | --- |
| `output-polarity` | testid (Output drawer) | `<select>` bound to `core.output.polarity`; option VALUES are `positive` / `negative`. Undoable. |
| `output-press-mirror` | testid | Checkbox bound to `core.output.pressMirror`. Undoable; flows into export pixels (mirrored composite bounds) and the plate-package manifest `outputDefaults`. |
| `output-registration-default` | testid | Checkbox bound to `core.output.registrationOnPlates` (plate-package default). |
| `output-registration-composite` | testid | Checkbox bound to `core.output.registrationOnComposite` (composite default). |
| `output-readiness` | testid | Text derived from the ACTIVE export target's preflight `evaluate()`: `Press-ready…`, `N preflight item(s) to review…`, or `Blocked: …`. |
| `proof-registration-overlay` | testid (Proof drawer) | SESSION-ONLY overlay toggle: follows `registrationOnPlates` until explicitly toggled; NEVER creates undo transactions, never persisted/exported. |
| `artwork-background-transparent` | testid (Document drawer) | Third canonical background; proof canvas and composite PNG/TIFF keep REAL alpha (corner alpha 0). `artwork-background-*` pressed state now reads `core.artboard.background`. |
| `document-grid-toggle` | testid | Grid visibility; `ws-grid` (SVG pattern overlay) renders on canvas iff checked. |
| `document-add-guide-vertical` / `document-add-guide-horizontal` | testid | Keyboard guide creation at the artboard center (undoable); guides are then arrow-key nudged on the focusable guide elements. |
| `button "Add Layer"` (Layers toolbar) | role+name | File intake that PRESERVES all layers/artboard; new layer selected, Clean, Glitch off; 32-layer cap errors clearly. The Select-panel upload card remains the REPLACE flow. |
| `button "Apply Recipe to Selected"` (Layers toolbar) | role+name | Applies the primary recipe to selected unlocked layers as ONE undo step; disabled without eligible targets. |
| `listbox "Layers"` / option rows | role | `ws-layer-list` is a multiselectable listbox; rows are options with `aria-selected`; Arrow/Home/End move selection, Enter/F2 keyboard-rename. |
| `radiogroup "Layer format"` → `PNG` / `TIFF` (Export panel, Selected Layer) | role+name | Selected-layer format; persists in the export session; TIFF downloads `*-layer.tiff`. |
| `select-flip-h` / `select-flip-v`, `numeric-transformSkewX` / `-SkewY` | testid (Select panel) | Independent flips and skew numerics, undoable; on warped layers they COMPOSE with the perspective quad. |
| `proof-mode-label` | testid (stage toolbar) | Truthful mode label: `Clean` / `Halftone` / `Diffusion`. |
| `halftone-clean-note` / `halftone-use-halftone` | testid (Halftone panel) | Clean-mode explanation + undoable Use Halftone action. |
| `ws-grid` | testid | The grid overlay SVG; absent while grid is hidden. |
| `ws-size-gate-status` | testid + role=status | Live announcement rendered only while the size gate is active. |
| `ws-perspective-handle-*` / `ws-crop-handle-*` | testid | Now focusable (`tabIndex=0`) with arrow-key nudging (Shift = 10px). |

Byte oracles added to `helpers/downloads.ts`: `parseJfifDensity` /
`expectJfif240Dpi` (real JFIF APP0 density — composite JPEG must carry unit
1, 240×240) and `pngPixelSample` (single-pixel RGBA probe, used to prove
negative polarity inverts plate pixels). The plate-package
`job-settings.json` manifest echoes `outputDefaults` (polarity/pressMirror
et al.) and is asserted by output-ownership.

Wave-F addendum (import cancel UI): `ws-import-progress` (role=status —
phase + asset counters during a cancellable .drglitch import) and
`ws-import-cancel` (`button "Cancel Import"`) render in the home header
while an import is live; a cancelled import announces "Import cancelled —
nothing was installed." and leaves no project card. Deterministic cancel
coverage lives at the seam level (`tests/unit/app-session-import.test.ts`,
`tests/unit/app-library-import.test.ts`) — browser-timing cancellation is
not deterministically automatable without an injectable delay seam.

## 7. Wave-H additions (2026-09-12): quota seam, recovered history, browser matrix

### 7.1 Storage quota seam (dev builds only)

`localStorage["drglitch.debug.simulate-quota"] = "1"` (exported as
`QUOTA_SIMULATION_STORAGE_KEY` from `helpers/storage.ts`) makes every
storage-backend WRITE throw a real DOMException `QuotaExceededError`
(src/app/storage-quota-seam.ts). The flag is read per write, so tests arm
and disarm it mid-session. The formerly `fixme`'d quota test in
`projects-lifecycle.spec.ts` ("storage pressure") is now live: it asserts
the loud `role=alert` quota toast, in-memory work preserved + dirty, an
explicit Save failing safely, the canonical last save surviving a reload
under exhausted quota, and full usability after disarming. Production
builds contain no trace of the seam (verified by
`scripts/verify-dist.mjs`).

### 7.2 Recovered history truth

`projects-history.spec.ts` › "history — recovered work truth": after a
recovery reload, `ws-history-depth` shows "1 undoable edit",
`ws-history-list` shows "Recovered work", topbar Undo/Redo agree, Undo
returns to the last explicit save, Redo restores the recovered state.

### 7.3 Browser matrix honesty (gate note for the lead)

Installed on this host: **system Chrome 152** (`google-chrome-stable`) and
the **Playwright Chromium** bundle only. Edge, Firefox, and WebKit are NOT
installed and MUST NOT be downloaded here (≈1.7 GiB free disk; each bundle
is hundreds of MB). Honest coverage claim: Chromium-engine coverage only.

Gate commands (run after all writers stop, tsc green):

```sh
# Full reliable Playwright run (bundled Chromium), exit code preserved:
set -o pipefail
DRG_E2E_PORT=4350 npx playwright test --workers=1 2>&1 | tee /tmp/drg-e2e-gate.log

# Release integrity (after npm run build):
node scripts/verify-dist.mjs dist
```

Chrome-channel smoke: `playwright.config.ts` currently defines NO projects
and the CLI exposes no `--channel` flag, so a Chrome-channel run needs a
one-line config addition the lead must apply deliberately (config edits
were out of wave-H scope):

```ts
// playwright.config.ts — add inside defineConfig({...}):
projects: [
  { name: "chromium" },
  { name: "chrome", use: { channel: "chrome" } },
],
```

then run the smoke set on the system Chrome 152:

```sh
DRG_E2E_PORT=4350 npx playwright test --project=chrome --workers=1 \
  tests/e2e/workspace-shell.spec.ts tests/e2e/projects-lifecycle.spec.ts \
  tests/e2e/projects-history.spec.ts tests/e2e/export-preflight.spec.ts
```

Without the config addition, the equivalent statement for the report is:
"Playwright Chromium full suite + no Chrome-channel automation possible
without a config edit; Edge/Firefox/WebKit unavailable on this host."
