# DR.GLITCH — Workstation Shell Architecture

**Date:** 2026-09-12
**Status:** Implemented on `claude/dr-glitch-workstation-20260912`
**Applies to:** `src/workspace/**`, `src/components/icons.tsx`, `src/dev/ComponentLab.tsx`, `src/studio/HalftoneStudio.tsx`
**Companion specs:** `2026-07-27-drglitch-ui-system-design.md` (visual identity, binding), the workstation implementation brief (workspace contract)

The collapsible stage inspector is replaced by a permanent creative-workstation
shell: 48px top command bar, 52px permanent left tool rail, central artboard,
fixed global drawers above a resizable right tool dock (320–520px, default
360px), and in-app floating panels. All studio capability (import, halftone /
diffusion / glitch controls, plate proofing, export) is preserved and reachable.

---

## 1. Atomic design hierarchy

Everything below preserves the binding visual law: Archivo/Martian Mono,
cream/neutral chrome, square geometry, no gradients, semantic-only CMYK, and
misregistration decoration never near live controls or proofs.

### Atoms

| Atom | File | Notes |
|---|---|---|
| `Icon` / icon map | `src/components/icons.tsx` | The single seam between the product and lucide-react. Every shell icon resolves through `ICON_MAP` by `iconKey` string (tool registry keys + chrome keys). Swapping icon sets touches one file. Icons are `aria-hidden` — meaning always travels as text. |
| Rail button | `.ws-rail-button` | 40px target in a 52px rail. Active state is full paper/ink inversion — never hue-only. |
| Topbar / titlebar buttons | `.ws-topbar-button`, `.ws-titlebar-button` | 32px / 28px achromatic icon buttons; global focus ring (2px active-ink + 1px key inner rule) applies. |
| Splitter | `DockSplitter.tsx` | `role="separator"`, `aria-valuenow`, pointer drag + Arrow/Home/End. |
| Drawer header | `.ws-drawer-toggle` | `aria-expanded`, 40px target, mono uppercase label. |
| Existing field atoms | `NumericField`, `.select-field`, `.toggle-row`, `.segmented-control` | Reused unchanged inside panels; unchanged CSS. |

### Molecules

| Molecule | File | Notes |
|---|---|---|
| `ToolRail` | `src/workspace/ToolRail.tsx` | Roving tabindex (Arrow/Home/End; Enter/Space native), `aria-pressed` + `aria-current`, `aria-keyshortcuts`. Order comes only from `TOOL_DEFINITIONS`; separator between `tools` and `system` groups; system group bottom-anchored. No future-tool placeholders. |
| `PanelFrame` | `src/workspace/PanelFrame.tsx` | Chrome for every panel, docked or floating: titlebar (drag surface), titlebar menu (Float / Dock Right / Close / Reset Position / Move / Resize), quick float/dock/close buttons, 8-direction resize handles, keyboard move/resize mode. |
| `Drawers` | `src/workspace/Drawers.tsx` | The three fixed drawers (Document / Proof / Output-Preflight); at most one expanded (structural: one state field); bodies scroll independently of the dock panel below. |
| `TopBar` | `src/workspace/TopBar.tsx` | Brand lockup, project identity + local-only status copy, New/Open/Save/Undo/Redo stubs (disabled, truthful tooltips), Focus Mode, Lock Layout, Reset Layout, Help, Export menu, account (`SessionBadge` re-hosted). |
| `HelpDialog` | `src/workspace/HelpDialog.tsx` | Searchable shortcut/gesture/consequence reference generated from the live shortcut registry. |

### Organisms

| Organism | File | Notes |
|---|---|---|
| `WorkspaceShell` | `src/workspace/WorkspaceShell.tsx` | Owns the reducer instance, persistence, viewport clamping, shortcut wiring, and composition of rail / canvas / splitter / dock / drawers / floats / size gate. |
| Tool panels | `src/workspace/panels/*.tsx` | One panel per tool, resolved via the UNIFIED `WORKSTATION_TOOL_REGISTRY` (`workstation-tool-registry.tsx`) — the single declaration binding each core `ToolDefinition` (pure data half in `src/core/tool-registry.ts`) to its panel component, chrome copy, and activation behavior. The former `panel-registry.tsx` compatibility view is deleted. Content relocated from the former stage inspector; state flows exclusively through `StudioApi` / `ProjectUi`. |
| Canvas stage | `src/studio/HalftoneStudio.tsx` | The proof surface (canvas, zoom, space-pan, drop target) stays owned by the studio and is passed to the shell as `canvas`. |

### State/data layers (React-free)

| Layer | File | Notes |
|---|---|---|
| Layout state manager | `src/workspace/layout-state.ts` | Pure reducer + persistence + clamping. Zero React imports; fully unit-tested in Node (`tests/unit/workspace-layout-state.test.ts`). |
| Shortcut registry | `src/workspace/shortcuts.ts` | Declarative bindings; pure matcher (`resolveShortcut`) with the typing-suppression rule; thin `useWorkspaceShortcuts` listener. Tool keys derive from `TOOL_DEFINITIONS`. |
| Studio API | `src/workspace/studio-api.ts` | The contract between studio state (HalftoneStudio) and panels/drawers. The multi-layer project store will re-implement this surface; panels do not change. |
| Workspace controller | `src/workspace/workspace-controller.ts` | Imperative context for panels/drawers: activate/focus/close/float/dock/gesture, viewport-aware. |

---

## 2. Panel/window state machine

Modeled with **three independent fields**: `activeToolId` (session),
`dockPanelId` (persisted layout), `focusedPanelId` (session). One
`PanelPlacementV1` per tool — one panel instance ever.

```
placement = { toolId, mode: docked|floating, rect, z, open }

activate-tool(T):
  T floating          → open, raise to top-z (dock keeps its panel)
  T docked (or hidden)→ open, dockPanelId = T, displaced panel.open = false
focus-panel(T):        active/focused = T, raise if floating; never re-places
close-panel(T):        open = false (mode + rect REMEMBERED); dock emptied if T held it
float-panel(T):        mode = floating, rect = remembered ?? cascaded default, raise
dock-panel(T):         mode = docked, dockPanelId = T, displaced hidden
reset-panel-position:  rect = cascaded default for T
```

Gestures are transactional: `begin-gesture` snapshots the start rect,
`update-gesture` applies viewport-clamped live rects, `commit-gesture` ends,
`cancel-gesture` (Escape, pointer or keyboard) restores the start rect exactly.
`pointercancel` is a CANCEL everywhere (PanelFrame float move/resize, dock
drag-out, DockSplitter, canvas gesture bracketing) — the system revoking a
pointer never commits a half-finished drag and never dock-drops. A cancelled
DOCK DRAG-OUT additionally re-docks the panel and dispatches
`restore-float-rect` with the geometry remembered BEFORE the drag, so the
transient spawn-at-pointer rect never survives as the panel's placement.
Floats clamp so ≥120px of width and the titlebar row stay inside the workspace
(`clampFloatRect`); minimum float size 320×240; recovered/offscreen rects are
re-clamped on mount and window resize (`clamp-floats`).

**Lock Layout** blocks move/resize/dock/undock/dock-width/reset-position;
open/close/focus/tool-selection/drawers stay live. **Reset Layout** hides all
floats, re-docks every placement, docks the active tool, resets dock width and
z-order, expands Document, unlocks — and never touches document/canvas state
(none lives in this store). **Focus Mode** is session-only: entry snapshots the
layout, the shell unmounts rail/dock/floats (React state for panel content
lives above the shell, so nothing is lost), exit restores the snapshot exactly.

Fresh-session defaults: Select/Transform active, Layers docked, Document drawer
expanded, no floats.

## 3. Layout persistence

`WorkspaceLayoutStateV1` (schema 1: dockWidth, dockPanelId, placements with
rect/z/open, expandedDrawer, locked) autosaves ~250ms debounced to
`localStorage["drglitch.workspace-layout.v1"]`. Session state (active tool,
focus, Focus Mode, gestures) is never persisted.

`parseWorkspaceLayout` is defensive: corrupt JSON, non-objects, or foreign/
future schemas ⇒ `null` ⇒ defaults; field-level damage (bad width, unknown
tool ids, undersized rects, invalid drawer, non-boolean lock, dockPanelId
pointing at a closed/floating panel) is normalized against the defaults rather
than discarding the whole layout. Storage failures (quota, privacy mode) are
swallowed — editing never depends on persistence.

## 4. Size gate

Below 1280×800 a CSS media query hides every `ws-main` child except
`.ws-size-gate` (the notice) — `display:none`, not unmount — so project and
workspace layout state are fully preserved and nothing auto-collapses. The
topbar stays. The shell additionally mirrors the SAME media query in JS for
the accessibility contract: activation renders a `role="status"` live
announcement inside the gate (`ws-size-gate-status`) and moves keyboard
focus stranded inside a hidden region onto the gate (tabIndex −1);
deactivation recovers focus to the active tool's rail button.

## 5. Wiring status (this branch)

Everything is wired to the canonical project store (ProjectCoreV1 via
DocumentApi): layers/transforms/recipes, document globals, history,
snapshots, presets, projects/recovery, and the real preflight/export
pipeline. No `TODO(project-store)` stubs remain.

### 5.1 Output canonical ownership (P0 prepress)

The Output drawer binds directly and UNDOABLY to `core.output`
(`OutputDefaultsV1`) through `output/update`: dot polarity
(positive/negative), press mirror, registration-on-plates, and
registration-on-composite. It never edits layer recipes or transforms.
Readiness in the drawer is the ACTIVE export target's `preflight
evaluate()` result — the target is constructed by the same pure builder the
Export panel uses (`src/workspace/export-target.ts` over the
`ExportSessionStore` state), so the two surfaces can never disagree.

The PROOF registration overlay (Proof drawer) is SESSION-ONLY view state:
never persisted to core, never exported, never in undo history. Until
toggled explicitly it follows `core.output.registrationOnPlates` so the
proof previews the plate default; an explicit toggle overrides for the
session only ("follow-until-overridden").

`Reset output controls` resets ONLY canonical output + registration mark
geometry (`resetOutputCommands()` in `src/app/legacy-bridge.ts`); it no
longer touches layer opacity or the per-layer recipe inverts.

### 5.2 Layer intake: Add vs Replace

Two flows split BEFORE anything async, each carrying an IMMUTABLE intent
captured when the picker opens (`src/app/artwork-intake.ts`): the Select
panel upload card and canvas drop REPLACE the layer that was primary at
request time (departed targets degrade to add); the Layers panel `Add
Layer` preserves the whole stack and artboard, creates the new layer
SELECTED in Clean mode with Glitch off, and enforces the 32-layer cap with
a clear error. The global latest-request-wins guard is unchanged, so racing
intakes never tear state.

### 5.3 Background, transforms, recipes

- Artboard background is canonical White/Black/TRANSPARENT
  (`artboard/set-background`). Transparent keeps REAL alpha end to end: the
  preview job carries no paper (`previewPaper` → null), the presenter
  composes an alpha-preserving proof (`proofCompositeTransparent`), and
  composite PNG/TIFF exports keep alpha (`resolveMatte` null).
- Select panel exposes Skew X/Y numerics and INDEPENDENT Flip H / Flip V,
  all undoable. On a perspective-carrying layer every affine patch maps the
  quad through the delta affine
  (`src/workspace/canvas/transform-compose.ts`), so move/scale/rotate/
  skew/flip/align stay VISIBLY effective after a warp — composition, not
  replacement — and crop changes remap the quad to the crop's sub-quad
  under the drag-start homography (content removal, never stretch).
- `Apply Recipe to Selected` (Layers panel) applies the primary layer's
  full recipe to every other selected unlocked layer as ONE undo
  transaction (`ProjectUi.applyRecipeToSelected`).
- Clean mode is labeled truthfully (`proof-mode-label` shows Clean), the
  Halftone panel explains inactive settings and offers an undoable
  `Use Halftone` action.

### 5.4 Layers panel keyboard semantics

The layer list is a `role="listbox"` (aria-multiselectable) of
`role="option"` rows: Arrow/Home/End move the selection (Shift extends),
Enter/F2 rename from the keyboard, Space toggles. Crop and perspective
handles are focusable with arrow-key nudging (1px, Shift = 10px) driving
the SAME pure drag machines as pointer edits; guides are created from
keyboard-operable Document-drawer buttons and nudged/deleted on the
focusable guide elements. The canvas modifier-deselect click no longer
starts a drag with stale ids.

### 5.5 Modality

The native Custom Shape `<dialog>` carries an explicit `aria-modal="true"`
so the centralized shortcut suppression (`isModalOpen`) silences EVERY
global shortcut while it is open (space-pan arming included). Home
project-card menus refocus their trigger before opening dialogs so focus
returns there afterwards; home dialogs pass a portal scrim class
(`home-dialog-scrim`) so the paper theme applies outside the
`.home-screen` subtree that `ModalDialog` portals escape.

### 5.6 Export metadata

Composite JPEGs carry a REAL JFIF density (unit 1, 240×240 DPI) via
`src/studio/jpeg-dpi.ts` (`withJpegDpi`, stamped in
`BROWSER_EXPORT_ENCODERS.encodeJpeg`); PNGs keep the single 240-DPI pHYs
chunk. Selected-layer exports offer PNG and TIFF; the format persists in
the export session state (`ExportSessionStore.layerFormat`).

### 5.7 Import cancel UI and verified cache reads

- .drglitch intake from the home surface routes through the session's
  cancellable handle (`AppSessionController.importProjectFileCancellable`),
  attached to the `ProjectLibraryApi` by `src/app/library-import.ts`
  (`libraryWithCancellableImport` — bound in app-context and StudioGate
  without touching session-controller). The home surface shows a live
  progress readout (`ws-import-progress`, role=status: phase + asset
  counters via `src/home/import-flow.ts`) with a `Cancel Import` button
  (`ws-import-cancel`); cancel aborts the whole operation at its next
  checkpoint, rejects with the typed `archive-aborted`, installs nothing,
  and is announced calmly ("Import cancelled — nothing was installed."),
  never as a failure. Bindings without the seam fall back to the plain
  awaited import.
- `AssetCache.loadImage` reads raster LAYER sources through
  `getVerifiedBlob` (hash + decode-strength verification when the browser
  decoder is wired) — a same-key at-rest swap fails CLOSED before any
  decoder or canvas sees the bytes and surfaces as a preview/render
  refusal. Custom shapes already used verified reads plus the canonical
  sanitizer fixed-point gate.

### 5.8 Grid

`core.grid` now has a real consumer: `ArtboardOverlays` renders an SVG
pattern grid (`ws-grid`, non-scaling 1px strokes, `--rule-soft`) when
`grid.visible` — overlay only, never in a render payload or an export.

## 6. Dev component lab

`src/dev/ComponentLab.tsx` at `/dev/lab`, mounted only when
`import.meta.env.DEV` (statically false in production builds — chunk is
dead-code-eliminated). Static showcases of shell primitives using production
classes; no studio state and no fake document data.

## 7. Telemetry, history truth, snapshot atomicity, release integrity (wave H, 2026-09-12)

### 7.1 Telemetry (src/telemetry/sentry.ts + call sites)

DSN-gated Sentry integration is wired in source and verified with intercepted
real-SDK browser envelopes. A live DR.GLITCH project, ingestion and symbolication
receipt remain release gates; local tests do not prove them.

- Inert without `VITE_SENTRY_DSN`: `@sentry/react` is never loaded, no
  event, no network state. `initTelemetry()` runs once in `src/main.tsx`.
- Error events are REBUILT from scratch (`scrubEvent`): only release/
  environment, stable `error_code`, coarse buckets (`timing_bucket`,
  `layer_count_bucket`, `pixel_count_bucket`, `cap_*` booleans), pathless
  compiled asset paths, matching source-map debug IDs, and category-only app breadcrumbs survive. Transaction
  names, tags, contexts, breadcrumb messages/data, request URLs, and stack
  metadata can never carry project/layer/file/asset/SVG/artwork-derived
  values — they are dropped by construction, not by pattern-matching.
- Preview, import, save and export create real manual root spans named
  `app.preview`, `app.import`, `app.save` and `app.export`. Production samples
  10%; explicit private validation samples 100%. Transaction and child-span
  fields are rebuilt from fixed operation names, valid trace IDs, timestamps
  and coarse buckets. Automatic DOM, navigation, HTTP, resource, Replay and
  user-context collection is disabled. Initialization/capture failures cannot
  stop the application. Unknown error strings cannot become telemetry tags.
- Exactly ONE event per REAL handled failure, deduped on the error object
  (`captureHandledError` marks it; `beforeSend` drops global-handler events
  whose `originalException` is marked). Capture points and codes:
  - preview worker crash replacement exhaustion → `preview-worker-crash`
    (PreviewService port handler);
  - export failure boundary → typed `ExportError.code` or `export-failed`
    (`startStudioExport`; cancellation never reports);
  - storage failures → `storage-quota` / `storage-write-failed`
    (`reportStorageError`), `save-conflict` (CAS collision on Save);
  - project open failures → `storage-corrupt-record` / `project-open-failed`
    (StudioGate; stale-id NotFoundError is routine and never reported);
  - archive trust boundary → stable `archive-*` codes
    (`importProjectFileCancellable`; `archive-aborted` never reports);
  - asset-GC blocked by a corrupt root → `gc-root-scan-failed`
    (`scheduleAssetGc`; other GC failures stay log-only by design);
  - React render crash → `react-render-error` via the top-level
    `AppErrorBoundary` (src/app/ErrorBoundary.tsx, mounted inside
    AppSessionProvider; minimal reload UI, no data in the report).

### 7.2 Recovered history truth

`buildRecoveredStore` commits the journaled core as ONE transaction labeled
`RECOVERED_WORK_LABEL` ("Recovered work", exported by
src/app/document-api.ts — single source of truth). DocumentApi's label
mirror now SYNCHRONIZES with the authoritative store history at
construction: a store that can already undo (only the recovery path
produces one) seeds the mirror with that label, and
`DocumentApiOptions.initialUndoLabels` overrides the heuristic explicitly.
Result: after recovery the History panel shows depth 1 + "Recovered work",
topbar Undo/Redo and the panel stay in lockstep, and Undo returns to the
last explicit save. (Unit: app-document-api; E2E: projects-history
"recovered work truth".)

### 7.3 Snapshot atomicity

Create Snapshot freezes BOTH representations synchronously at click time —
the core reference and the proof-canvas pixels (`captureThumbnailCanvas`,
a synchronous drawImage copy) — then persists the thumbnail asynchronously
and stores the snapshot FROM the frozen core
(`doc.addSnapshot(name, thumbnailId, frozenCore)`;
`ProjectStore.addSnapshot`/`createSnapshot` accept an optional frozen-core
argument, additive-only). A mid-await edit can no longer split the pair
(thumbnail at N, core at N+1). A failed thumbnail persist degrades to a
null-thumbnail snapshot of the frozen core — never a mismatched pair.

### 7.4 Storage quota injection seam (dev builds only)

`src/app/storage-quota-seam.ts`: while
`localStorage["drglitch.debug.simulate-quota"] === "1"`, every backend
WRITE (put/delete/transaction) throws a real DOMException
`QuotaExceededError`; reads pass through; the flag is read per write.
Dev sessions boot through `createDevSessionController` (same
IdbBackend-with-fallback semantics as `AppSessionController.create`); the
production bundle contains no trace of the seam (statically-false DEV
branch, verified by the dist assertions). Exercised by the
projects-lifecycle "storage pressure" E2E.

### 7.5 Release integrity assertions

`scripts/verify-dist.mjs` (also run by tests/unit/dist-assertions.test.ts,
which SKIPS when dist/ is absent — build first): after `npm run build`,
dist must contain no `.map` files or external sourceMappingURL references,
no private upload tokens or assigned secret values, and no dev-only chunks
(`/dev/lab`, ComponentLab, debug seam keys). Public DSNs, exact release SHAs
and debug-ID injection are required production metadata. A configured build
uploads hidden source maps privately and removes them after upload; upload
failure fails the build. `DRG_RELEASE_BUILD=1` refuses an unconfigured build.

### 7.6 Compatibility export and memory

The legacy single-layer routing predicate now also governs streamed delivery:
crossing the package-size threshold cannot change the renderer's pixels. This
compatibility service retains one canvas and delivers 32 rows at a time to the
PNG/ZIP writer. It is admitted against `legacyCanvasPeakBytes`, including native
canvases, legacy numeric intermediates, source decoding, stamps and packaging.
An over-budget compatibility job is refused before decoding; it is never
silently switched to another renderer. Rendering one legacy plate is synchronous,
so cancellation is observed between that render and bounded delivery steps.
Multi-layer exports retain the cooperative worker band renderer and its separate
memory model. Positive compatibility registration remains the engine's native
final pass; negative output applies polarity before the registration painter and
mirrors the completed rows last.
