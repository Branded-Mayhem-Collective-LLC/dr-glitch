# Browser workflow restoration — source candidate

## Evidence and selected baseline

This change starts at `80ca44138d5b0bae7a6179532ccab31214e617e3` on
`codex/dr-glitch-release-recovery`, preserving its full ancestry. It restores
workflow, not an old renderer or an entire historical tree.

| Commit / evidence | Classification | Disposition |
| --- | --- | --- |
| `317f0fab26f625e488f7b9a4799bdd949f88686e` | Earliest browser studio: four continuously available steps (Artwork, Screen, Plate angles, Output), preview plate tabs, direct Open artwork and Export | Workflow reference, originally authored by Michael; not evidence of Dave's acceptance |
| `1c91856` through `1906158` | Vite/Workers port, settings validation, renderer tests and account routes, before the UI system implementation | `1906158e763db3b8dee98fe089b638a8874eda93` is the browser snapshot immediately before the UI implementation plan; preserve modern platform/security rather than revert the port |
| `f2dda9a`, `923214d`, `998335b`, `b44ce19` | Process-ink visual system and product naming | Restore the earlier simple workspace organization; keep existing product name, attribution and self-hosted fonts |
| `a574f30`, `4a7d277`, `189ec5f`, `4a22d2b` | Ink rail, modifier-key visibility and plate-tinted controls | Replace default rail interaction with visible plate checkboxes, angle fields and preview tabs |
| `b9e3f39`, `0a053e8`, `17baa0a`, `9ca2ee2`, `ce78d8c`, `ee2b322`, `262a397` | Adobe-style scrub fields, stage spine/keyboard map, desktop gate, motion and staged press workflow | Remove from default interaction; retain applicable reset/export preflight behavior and source/tests for review |
| `76cdcb1dff16885c1c38ce79d399f94880226a62` | Print-critical engine recovery: maximum-GCR, eight sheets at 240 DPI, placement/mirror, full-sheet output, dense-screen refusal, PNG metadata, white-paper inversion | Retain through the current engine/document/export modules |
| `3084f80686d3d326fcedc05dded2b35a70bf4c37` (David Clayton) | Supplied desktop reference and expanded browser engine: shape geometry, grayscale, custom SVG, diffusion/glitch, registration, TIFF/SVG | Closest identifiable Dave-authored browser engine baseline; retain its improvements, not its already-redesigned UI |
| `605f8a7fcbfb704429afa683be2f8c5504e20104`, merged as `c079a2160ec11fc25ab4b462fef834f9f8844063` ([PR #1](https://github.com/Branded-Mayhem-Collective-LLC/dr-glitch/pull/1)) | Auth origin/CSRF/body limits, atomic D1 throttling, dependency updates, file validation and stale-load cancellation, SVG/custom-dot/registration/export fidelity | Retain all security, engine and export corrections and their tests |
| `b210f819f87abb8c1f3310700a30b801d4795b22` ([PR #3](https://github.com/Branded-Mayhem-Collective-LLC/dr-glitch/pull/3)) | Mixed commit: persistent multi-layer workstation AND bounded exports, decode/cancellation/asset lifetimes, transparent output/opacity, JPEG/TIFF metadata, privacy-filtered telemetry | Isolate workstation UI/storage entry behind a development-only review flag; retain current shared engine, export, intake and telemetry implementations |
| `80ca44138d5b0bae7a6179532ccab31214e617e3` | Workstation live Sentry canary adjustment | Preserve harness and provenance; no live canary or external traffic authorized here |

## Implementation boundary

The default route opens one sample artwork immediately into an in-memory
session. Artwork import replaces that image while preserving recipe, opacity, scale and mirror settings. Four continuous inspector steps,
ordinary sliders/numeric fields, explicit plate visibility/angles and preview
tabs restore the pre-redesign workflow. Diffusion and glitch controls remain
available as optional screen settings, since removing them would remove
engine capabilities supplied after the original browser shell.

The current state/asset adapter and bounded export pipeline remain shared.
No renderer, encoder, security module, migration, lockfile, attribution or
baseline fixture is reset. Internal one-layer project representation is an
implementation detail; default users do not encounter a project library,
autosave/recovery, multi-layer tools, crop/transform handles, docking, floating
panels, workspace presets or the 1280×800 workstation gate. Existing persisted
workstation data is neither read nor deleted by the default in-memory session.

`VITE_DRG_WORKSTATION_REVIEW=1` enables the preserved workstation only with
Vite's `DEV` guard. It cannot enable the workstation in a production build.
The existing browser suite exercises this isolated mode unchanged; a separate
restoration suite exercises the actual default. This is source preparation,
not a product release or permission for external use.

## Limits of the evidence

- No available commit is proven to be Dave's accepted pre-redesign browser UI.
  The earliest browser shell is Michael-authored. `1906158` is therefore a
  traceable workflow approximation, not a claim of Dave's approval.
- `docs/desktop-parity.md` records partial semantic parity and a Windows
  same-browser comparison, not full desktop/press equivalence.
- The renderer characterization is headed `c079a21` but describes working-tree
  features (transparent exports, opacity and diffusion limits) committed in
  `b210f81`. Commit blobs and executable tests take precedence over its title
  and stale line numbers. The unchanged 82-case renderer oracle permits only
  the four documented diffusion-None differences against `3084f80`.
- Michael still needs to judge whether this four-step workflow matches the
  intended reference. Dave's physical film/press proof and collaboration
  disposition remain outstanding; no external use is cleared.

## Validation

Passed on this restoration candidate:

- Clean locked install with Node 22.22.1 and npm 11.11.0; audit reported zero vulnerabilities. The first install exposed the host default npm 9; installation was repeated with the required npm version before final checks.
- `npm test`: 1,478 tests across 105 files (including a new boot-failure/unmount regression).
- `npm run test:worker`: all 15 real Worker/D1 tests.
- `npm run lint`, strict TypeScript/production build and `git diff --check`.
- `node scripts/verify-dist.mjs`: no public maps, secrets, upload credentials or development chunks.
- `node --test tests/canary/*.test.mjs`: 11 guard tests, no live canary.
- Six restored-workflow browser cases: startup/no persisted-store access, explicit plate/angle controls, recipe-preserving image replacement and invalid intake, smaller viewports/document controls, all five real export formats with dimensions/metadata, and dense-export refusal.
- The same six browser cases passed against the built client, built with `VITE_DRG_WORKSTATION_REVIEW=1`; production still exposes the restored workflow. The static client server intentionally has no auth API; the separate Worker suite verifies auth.
- 135 existing browser cases passed with the development workstation explicitly enabled: `render-regression`, `svg-export`, `desktop-parity`, `custom-shape`, `image-import`, `studio-ux`, `workspace-shell`, `projects-lifecycle`, `output-ownership`, and `export-preflight`. This includes the unchanged 82-scenario raster oracle and the approved four diffusion-None differences.
- Visual inspection of the default browser surface. Screenshots and downloaded outputs remain private, outside tracked source.

The full workstation suite/performance benchmark was not rerun; these are
focused regression receipts for an interface change. No engine, export,
renderer fixture, desktop reference, security, database, license or lockfile
bytes changed from `80ca441`. Build warnings about existing large chunks and
mixed static/dynamic imports remain; they did not fail the build.

The new draft is stacked on the recovery branch to keep its diff reviewable.
Its ancestry also preserves the local `80ca441` canary adjustment, which was
not yet on the remote recovery branch (`b210f81`) when inspected. The original
PR #3 and recovery worktree are left intact.
