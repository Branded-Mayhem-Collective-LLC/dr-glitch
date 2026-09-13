# Core contract adversarial review — src/core vs plan requirements

Scope: `src/core/types.ts`, `src/core/resource-policy.ts`,
`src/core/tool-registry.ts`, `src/core/id.ts` (the stable shared contract),
reviewed against `/tmp/dr-glitch-workstation-plan-20260912.md`. In-progress
subsystem files (src/project, src/storage, src/render, src/editor, src/io,
src/workspace, src/export) were NOT reviewed; this document instead defines
what the lead must check at each seam.

Line references are into the current worktree state.

---

## 1. Findings: missing fields and types

| # | Severity | Finding |
|---|----------|---------|
| M1 | High | **No working-revision type.** `ProjectEnvelopeV1.savedRevision` (`types.ts:290`) is "revision of the last explicit Save", and `RecoveryRecordV1.revision` (`types.ts:331`) plus `PreflightIssue.revision` (`types.ts:406`) reference a *working* revision — but nothing defines where the working revision lives, who increments it (per undo transaction? per reducer action?), or its relationship to history. Three agents (project, storage, export) will each invent one. Define `workingRevision` semantics in core now: monotonically increasing per committed transaction, session-scoped or persisted with recovery, and the value export freezes. |
| M2 | High | **No .drglitch manifest / archive types.** Plan (`plan:100`) requires `manifest.json`, versioned schema, forward migration. Nothing in core describes `ManifestV1`, the asset-entry naming (`assets/<sha256>.<ext>`), or which envelope fields are stripped on export (savedRevision? timestamps?). io and storage will diverge on staging-record shape. |
| M3 | High | **No render/worker protocol types.** Plan (`plan:120-124`) mandates monotonic job revisions, progress, cancellation, transferable results. render, editor, workspace, and export all touch this boundary and core defines nothing (no `RenderJobRequest`, `RenderProgress`, `RenderResult`, `JobId`). This is the single most-shared runtime seam in the release. |
| M4 | Med | **`ResourcePolicy` misses half the limits** (`resource-policy.ts:28-40`): no `maxSvgBytes` (1 MB, `custom-shape-data.ts:4`), no max SVG node count/depth (2000/32, `custom-shape-data.ts:135`), no `MAX_EXPORT_GRID_POINTS` / `MAX_DIFFUSION_RASTER_PIXELS` / `MAX_DIFFUSION_SVG_RUNS` (`halftone.ts:78-84`), no max image dimension (16,384, `image-file.ts:2`), no per-archive-entry uncompressed cap (only the total), no recovery-journal debounce/retention, no max guides/snapshot-thumbnail size. The stated purpose ("every limit ... lives here", `resource-policy.ts:2-4`) is currently false; preflight and export will read limits from two places. |
| M5 | Med | **Rulers have no home.** Plan (`plan:48`, `plan:70`) puts rulers under Document and requires unit-aware rulers; `ProjectCoreV1` has guides/grid/snapping (`types.ts:266-268`) but no `rulersVisible`. Decide: project-persisted (like grid) or workspace-local — and write it down; two agents (workspace, project) can both claim it. |
| M6 | Med | **`RegistrationV1` has no enabled flag and no overlay flag** (`types.ts:237-243`). Plan: Proof drawer owns a "live registration overlay" (`plan:49`), Output owns registration-output defaults (`plan:50`), per-export override exists (`plan:113`). `OutputDefaultsV1.registrationOnPlates/OnComposite` (`types.ts:250-251`) covers export defaults, but Selected-Layer export default ("off for composite/selected", `plan:113`) has no field — does it share `registrationOnComposite`? And the proof-overlay toggle is neither in session state nor core. |
| M7 | Med | **`SnapshotV1.thumbnailId` lifecycle undefined** (`types.ts:277-278`). Thumbnails are Sha256-addressed (`AssetKind "thumbnail"`, `types.ts:316`) — content addressing means two snapshots can share a thumbnail hash; deleting a snapshot must not delete a shared thumbnail; GC roots (plan: "Trash remains an asset-GC root", `plan:87`) must include snapshot thumbnails of live, trashed, AND recovery records. No contract states this. Also: does .drglitch include thumbnails (plan says yes, `plan:100`) keyed by the same sha? |
| M8 | Low | **`StudioSessionState` lacks tool-history for focus restoration** — Focus Mode must restore "the exact prior arrangement" (`plan:56`); the prior arrangement is a WorkspaceLayoutStateV1 delta, but session state (`types.ts:378-388`) has only `focusMode: boolean`. Where does the pre-focus snapshot live? |
| M9 | Low | **No stable-error-code registry.** Sentry rules allow only "stable error code" (`plan:130`); `PreflightIssue.code` (`types.ts:400`) is free-form string. A shared enum/prefix convention prevents drift between export errors and telemetry codes. |
| M10 | Low | **`createId` fallback is non-unique-ish** (`id.ts:7`): Date+Math.random fallback fine for browsers, but Workers/test envs always have randomUUID; consider throwing instead to catch misuse. |

## 2. Findings: ambiguities that WILL cause agent divergence

| # | Ambiguity | Why it diverges | Required resolution |
|---|-----------|-----------------|---------------------|
| A1 | **Transform composition order** (`TransformV1`, `types.ts:161-172`). "Decomposed position, scale, rotation, flip, skew" gives no application order, no flip placement (pre/post rotation changes the result), no skew convention (x-shear by tan(deg)? both axes?), and no statement of whether `position` is the translation of the *cropped* content center or the full asset center. | editor (matrix building), render (inverse mapping), export (bounds), and io (fixture generation) each build the matrix. Any disagreement = invisible 1-px or mirror bugs. | Document canonical order in core, e.g. `M = T(position) · R(rotation) · K(skew) · S(scale·flipSign)` about the crop-rect center mapped to document px, with a worked numeric example. |
| A2 | **Perspective vs decomposed transform** (`PerspectiveQuadV1`, `types.ts:152-158`). Quad is "in document pixel space" — absolute. If absolute, position/scale/rotation are redundant while a quad exists; if the quad is *post-composed*, it isn't in document space of the source. Also: is the quad the image of the *cropped* rect corners? | editor writes quads from handles; render inverse-maps; both must agree on what the homography maps FROM (source-crop corners) and TO (quad). | State: homography maps the four corners of the cropped source rect directly to the quad; when `perspective != null` the decomposed fields are ignored for geometry but preserved for UI (or define post-compose — either, but pick one). |
| A3 | **Opacity-once location** (`LayerV1.opacity`, `types.ts:184-186`). "Multiplies source alpha exactly once" doesn't say *where*: before the mode kernel (changes halftone coverage) or at plate-stack composition (matches today's flatten-then-alpha, `halftone.ts:894-926`). These give different output for any coverage-dependent mode. | render vs export vs the compat adapter. | Specify: opacity is applied at plate-stack composition to the layer's flattened plate contribution (matching current semantics), never to sampled coverage. |
| A4 | **Legacy `invert` vs three polarity fields.** `HalftoneRecipeV1.invert` (`types.ts:70`), `DiffusionRecipeV1.invert` (`types.ts:109`), and `OutputDefaultsV1.polarity` (`types.ts:247-248`) coexist. Current engine has ONE `invert` operating in coverage space before gamma (`halftone.ts:551-563`). Which one does the adapter map it to, and does output polarity invert *ink coverage* or *rendered pixels* (registration marks included?)? | project (migration), render (kernels), export (polarity), preflight (invert warning, `HalftoneStudio.tsx:1371-1376`). | Define: recipe.invert = coverage-space polarity (legacy-compatible, per mode); output.polarity = whole-plate output inversion applied after composition, excluding registration; migrating legacy settings sets recipe invert on both halftone and diffusion groups and leaves polarity "positive". |
| A5 | **Guides undoable but arrays are unkeyed** (`GuidesV1`, `types.ts:208-215`). Undo of "move guide 3" via whole-array replacement works, but coalescing a guide drag into one transaction needs identity across frames; index identity breaks if a concurrent add occurs mid-drag. Also "guides persist and are undoable but never export" (`plan:70`): "never export" means never *rendered* into output; guides DO travel inside .drglitch (they're in ProjectCoreV1). Two agents already read this differently — io must NOT strip guides from archives. | editor, project, io. | Note in core: array index is guide identity within a transaction; guides ship in archives and snapshots; they are excluded only from rendered output. |
| A6 | **Snapshot restore vs snapshots list.** `SnapshotV1.core` is nonrecursive (`types.ts:280`) — good — but Restore ("one undoable action", `plan:82`) replaces `envelope.core` while `envelope.snapshots` stays. Does undo of a restore also restore... the snapshot list? (It must not change.) And Duplicate Snapshot → "new unsaved project": does the new project inherit the source's other snapshots? (Plan implies no: "from that checkpoint".) | project vs storage vs workspace (home surface). | State: restore mutates only `core`; duplicate produces an envelope with empty `snapshots` and fresh id/title, savedRevision 0, unsaved. |
| A7 | **`savedRevision` across export/import.** Does `.drglitch` carry `savedRevision`? If yes, importing then Saving must not CAS-conflict with an unrelated local project; plan already requires a new local project ID (`plan:100`) — but a fresh id with a stale nonzero savedRevision breaks "dirty" detection. Also: does portable export bump anything? Plan says export "captures current working state without implicitly saving" (`plan:86`). | io, storage, project. | State: archives store core+snapshots+title only; on import savedRevision initializes to 0 and the project opens unsaved/dirty. |
| A8 | **Preset custom-dot duality** (`RecipePresetV1`, `types.ts:299-310`): `halftone.customShapeAssetId: Sha256 | null` AND `customDotSvg: string | null`. In a *portable* preset the assetId is meaningless on another device; if both are set and disagree, which wins? On preset save, is assetId nulled? On apply, io must ingest `customDotSvg` into the asset store, compute its sha, and rewrite `customShapeAssetId` — but sha of *which bytes* (raw string vs canonical re-sanitized serialization — resanitization must be byte-stable or the sha changes every import). | io, project, render. | State: portable preset sets `customShapeAssetId: null`; on apply, sanitize→serialize canonically→sha256→ingest→rewrite id. Add a test that sanitizeSvg is idempotent byte-for-byte (`custom-shape-data.ts:114-175` — currently unverified). |
| A9 | **`RegistrationV1.size/offset: null`** (`types.ts:238-239`) presumably means "auto from sheet size" (the renderer formula, `halftone.ts:619-620`) but this is undocumented; the current UI never uses auto (always 120/120/2, `HalftoneStudio.tsx:146-148`). Migration of existing behavior should write concrete values, not null. |
| A10 | **`ArtboardV1.presetId: string`** free-form (`types.ts:199`): what's the value for legacy sheet ids (`"11x15"` etc., `document-model.ts:19`)? Is `"custom"` reserved? Must width/height be revalidated against the preset on load (they can disagree after hand-editing an archive)? State: dimensions are authoritative; presetId is display-only and recomputed on load. |
| A11 | **`SeparationV1.visible` vs per-layer visibility vs export omission.** Global plate visibility (`types.ts:44`) currently means "blank the plate in proof AND drop it from PNG packages but emit empty SVG" (see characterization §11.20). New per-format rules must be written once, in export, referencing this field — not re-derived in render. |
| A12 | **`DiffusionRecipeV1` drops `diffusionEnabled`/`LayerMode` linkage.** Mode lives on `LayerRecipeV1.mode` (`types.ts:137`) — good — but the legacy `diffusionAlgorithm: "none"` (kept in `DiffusionAlgorithm`, `types.ts:76`) now overlaps with mode "halftone"/"clean". A diffusion-mode layer with algorithm "none" is pure quantization (approved behavior, `render-regression.spec.ts:71-73`) — do not "simplify" it away. |
| A13 | **`GridV1.size` in document px** (`types.ts:217-221`) but Document panel displays px/in/mm; snapping to a 0.25 in grid at 240 DPI = 60 px is fine, but non-integer mm grids need a documented rounding rule for snap targets. |
| A14 | **`ToolDefinition` has no activation-behavior field** (`types.ts:424-436`). Plan (`plan:96`) lists "activation behavior" in the registry; the float-vs-dock activation rules (`plan:52`) are currently implied global behavior. Fine — but then delete the claim from the plan mapping or add the field; don't let workspace hardcode per-tool exceptions. |
| A15 | **`isEnabled` inconsistency** (`tool-registry.ts:31,40,49`): halftone/diffusion/glitch require `hasProject` but select/layers/plates/history/export are always enabled. With no project open (home surface), is the rail visible at all? If yes, layers-without-project is a broken state; if no, the three `isEnabled` checks are dead code. Decide and document. |
| A16 | **`WorkspaceLayoutStateV1` missing float-restore memory for Close** (`types.ts:353-372`): "Close remembers prior placement" (`plan:53`) is representable (`open: false` + retained `rect`/`mode`) — good — but "Docking into an occupied dock hides the displaced panel": is the displaced panel `open:false` or open-but-not-docked? Define: displaced panel keeps `mode:"docked"`, `open:false`; reopening docks it again (displacing in turn). |
| A17 | **DOCUMENT_DPI duplicated**: `core/types.ts:24` and `studio/document-model.ts:1` both define 240. Harmless now, a trap when someone makes one configurable. Mark studio's as legacy-only. |
| A18 | **`AssetRecordV1.width/height` for kind "svg"** (`types.ts:318-325`): intrinsic px? viewBox units? For sanitized custom dots the root is forced 1024×1024 (`custom-shape-data.ts:125-126`). State the convention (viewBox width/height after sanitization; raster = pixel dims; thumbnail = pixel dims). |
| A19 | **`CropV1` for SVG-source layers** (`types.ts:150`): "source-asset pixel space" is undefined for vector sources. State: crop applies in the asset's rasterization space (viewBox units) or is null for svg assets in v1. |
| A20 | **`TrashRecordV1` lacks the envelope** (`types.ts:339-345`): title-only metadata implies the project record itself stays in the projects store flagged elsewhere, or moves to a trash store — the plan (`plan:87`, `plan:98` "separate stores ... Trash metadata") suggests metadata-only with the envelope staying put. storage and workspace must agree on which store `Restore` reads. |

## 3. Boundary-risk register

For each seam: what crosses, likely mismatches, and the acceptance checks the
lead should run at integration.

### 3.1 project ⇄ storage

Crosses: `ProjectEnvelopeV1`, `RecoveryRecordV1`, savedRevision CAS,
snapshot writes, asset references from `LayerV1.assetId`.

Likely mismatches:
- Working-revision bookkeeping (M1): reducer increments vs repository
  increments; recovery journal capturing mid-transaction state.
- Save semantics: does Save write `core` + `snapshots` atomically and bump
  savedRevision by 1 or to workingRevision?
- Recovery flush "without changing the saved revision" (`plan:85`): storage
  must not touch the envelope on journal writes.
- Asset retention: project agent deletes a layer → who schedules GC? (Undo
  can resurrect the layer for 100 transactions; GC must not run against
  history-reachable assets.)

Acceptance checks:
1. Save → reload → envelope deep-equals; savedRevision monotonic; updatedAt
   changed; recovery record cleared or marked clean.
2. Edit → wait >750ms → kill tab (simulated) → reopen: recovered/dirty,
   savedRevision unchanged, Revert-to-Last-Save restores the pre-edit core.
3. Delete layer → undo → layer asset still resolvable (GC did not collect).
4. CAS: two writers, second Save with stale savedRevision must fail loudly,
   not overwrite (`plan:88`).
5. Quota error during Save: in-memory state intact, last explicit save
   intact (`plan:86`).

### 3.2 io ⇄ storage (import staging)

Crosses: staged asset blobs, sha256 identity, atomic install, manifest
validation results, TrashRecord for replaced items.

Likely mismatches:
- Sha computed over compressed vs uncompressed bytes; sha of canonical SVG
  before vs after re-sanitization (A8).
- Staging-store cleanup on failure: io assumes storage rolls back; storage
  assumes io deletes. Partial-cleanup attack tests (`plan:148`) will catch
  this only if someone owns it.
- Extension↔mime mapping for `assets/<sha>.<ext>`: io writes ext from mime,
  storage validates mime from bytes — must both use one table.

Acceptance checks:
1. Import a valid .drglitch: new project id, savedRevision 0 (A7), every
   `assetId` in layers/snapshots resolves, dedup confirmed (same sha stored
   once).
2. Import failure at the last entry: zero residue in projects/assets/
   thumbnails stores AND zero residue in staging.
3. Re-import the same archive: no duplicate assets; second project created.
4. Archive with entry count/size just over `ResourcePolicy` limits
   (`resource-policy.ts:35-37`): rejected before any blob write.
5. Future-schema archive: rejected with the safe message, no staging residue
   (`plan:100`).

### 3.3 render ⇄ export

Crosses: frozen project revision, render-job protocol (M3), plate bitmaps /
SVG documents, progress/cancel, resource estimates vs
`maxRenderPeakBytes`.

Likely mismatches:
- Export freezing "a project revision" while M1 is unresolved — export may
  freeze a *copy of core* while render keys caches by revision number.
- Preview clamp: export must never pass a preview-clamped sample field
  (characterization §1.10, §4); a shared "quality" enum beats boolean
  `preview`.
- Registration drawn by render vs by export post-pass; current engine draws
  it inside the renderer (`halftone.ts:929`) — moving it to export changes
  the SVG structure and raster alpha stacking (0.7 marks overlap-darken,
  `svg-export.spec.ts:109`).
- Vector eligibility: export decides "genuine SVG only when all contributing
  layers qualify" (`plan:111,114`) — render must expose per-layer
  vectorizability (clean continuous-tone layer ⇒ raster only), not export
  guessing from recipe.

Acceptance checks:
1. Single-layer parity oracle (characterization §10-§11) passes byte-exact
   through the worker path against `renderer-3084f80` fixtures.
2. Tile/band equivalence: tiled render == untiled render for glitch-heavy
   settings (seeds are coordinate-based — this is the test that catches
   seam bugs).
3. Cancel mid-export: no partial file download, no orphaned object URL,
   worker replaced cleanly.
4. Edit during export: exported output matches the frozen revision, not the
   live document.
5. Estimated peak for 8×3600×5280 layers stays under 768 MiB
   (`resource-policy.ts:39`) and the planner refuses when it wouldn't.

### 3.4 workspace ⇄ project

Crosses: `StudioSessionState`, dirty state for topbar, New/Open/Home dirty
prompts, undo/redo wiring, tool capability context
(`ToolCapabilityContext`, `types.ts:438-442`).

Likely mismatches:
- Undo-scope boundary (`plan:81`): selection/active tool/proof plate/zoom/
  pan/panels are excluded — workspace must not route them through the
  project reducer, and project must not clear selection on unrelated undo
  (except when the selected layer disappears).
- `selectedLayerIds`/`primaryLayerId` (`types.ts:383-384`) reference layers
  that undo/redo can delete — who reconciles stale ids after
  restore/undo?
- Dirty definition: workingRevision > savedRevision vs "reducer ran since
  save" — must be one predicate exported by project.
- Layout auto-save (`WorkspaceLayoutStateV1`) must never enter recovery or
  archives (`plan:94`) — check the storage schema physically separates them.

Acceptance checks:
1. Undo after panel float/dock/zoom changes: document unchanged AND panel
   state unchanged (excluded both directions).
2. Snapshot restore with a selected layer that vanishes: selection cleared,
   primary null, no crash; restore is one undo step.
3. Dirty → New: Save/Discard/Cancel each leave storage in the documented
   state; Cancel changes nothing.
4. Second tab: read-only session gets live `hasProject` context; takeover
   transfers writer without losing unsaved work in the owner (`plan:88`).

### 3.5 editor ⇄ render

Crosses: `TransformV1`/`PerspectiveQuadV1` interpretation (A1/A2), crop
rects, draft-vs-commit render requests, snapping-geometry queries (layer
bounds for smart guides).

Likely mismatches:
- Matrix convention (row vs column vector, y-down) between
  `src/editor/matrix.ts` and the render kernels — the classic silent bug.
- Quad validation ownership: editor rejects invalid quads "without
  destroying the prior valid transform" (`plan:76`) — render must still
  defensively reject (import path can inject bad quads bypassing the
  editor).
- Draft render resolution: editor requests low-res during drag (`plan:77`);
  glitch seeds are resolution-dependent (characterization §4) so drafts will
  legitimately differ — the commit render must be pixel-final and the UI
  must not diff-flash.
- Layer bounds for snapping with perspective: axis-aligned bbox of the quad
  vs transformed rect corners — pick one and share the function.

Acceptance checks:
1. A golden set of transforms (identity, rotate 30, flipH+rotate, skew,
   perspective) rendered by editor-preview math and render-kernel math land
   corners within 0.01 px of each other.
2. Feeding each invalid-quad class (nonfinite, concave, self-intersecting,
   near-zero-area, singular H) to BOTH editor validator and render kernel:
   editor keeps prior value; render refuses without crashing.
3. Escape mid-drag: transform equals pre-drag value exactly; exactly zero
   history entries added.
4. Commit render after drag equals a cold render of the same core
   byte-for-byte.

### 3.6 Cross-cutting: core file ownership

`src/core/*` is declared the single source of truth (`types.ts:1-11`).
Enforce at integration: no subsystem re-declares `DotShape`, `PlateId`,
DPI, or limits (grep for local copies; `studio/halftone.ts:10-12` and
`studio/document-model.ts:1` are the sanctioned legacy exceptions until the
adapter lands). Every `*V1` change during the sprint must be reviewed by
the lead — additive-optional only (`types.ts:7-10`).

## 4. Registry/tool-contract notes

- Rail order in `TOOL_DEFINITIONS` (`tool-registry.ts:7-75`) matches the
  plan exactly (Select, Layers, Halftone, Diffusion, Glitch, Plates ‖
  History, Export) with `group` providing the separator. Good.
- Shortcuts v/l/h/d/g/p/y/e do NOT collide with the legacy studio keys
  (backtick composite, 1–4 plate solo, `[`/`]` cell size —
  `src/studio/useStudioKeys.ts:30-60`), but the two keydown listeners will
  coexist during migration; the centralized shortcut layer (`plan:61`) must
  own both maps or the legacy hook must be removed with the old shell.
  Note the legacy hook's typing guard is `isTypingTarget`
  (`useStudioKeys.ts:9-18`); reuse it (or the stricter
  `isInteractiveTarget`) so "suppress unmodified shortcuts while typing"
  is one implementation, not three.
- `getToolDefinition` throws on unknown id (`tool-registry.ts:81-85`);
  workspace layout loaded from storage may contain ids from future versions
  — corrupt-layout handling (`plan:149`) must catch this throw or sanitize
  ids first.
