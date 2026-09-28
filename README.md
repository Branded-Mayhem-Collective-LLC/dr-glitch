# DR.GLITCH

Browser-native CMYK halftone separations for screen-print production. DR.GLITCH turns RGB artwork into a live composite proof and four press-ready monochrome process plates without uploading the artwork to a server.

**Current version:** `0.1.0`

**Source restoration candidate:** the default route restores the continuous
four-step, single-artwork browser workflow. Work is held in memory and is lost
on reload; export the output before leaving. Existing saved workstation data
is left untouched. See the [commit map and evidence](docs/reviews/2026-09-28-workflow-restoration.md).
This candidate is not a release or clearance for external use.

## Feature list

### Artwork and document setup

- Opens PNG, JPEG, and WebP artwork through the file picker or drag and drop.
- Includes generated sample artwork so the studio is usable immediately.
- Processes source artwork in the browser; the current studio does not upload artwork.
- Reports source dimensions and RGB color mode.
- Supports Letter, A4, 8×10, 9×12, 11×15, 11×17, 13×19, and 15×22-inch sheets.
- Supports portrait and landscape orientation, with automatic orientation selection for clearly horizontal or vertical source files.
- Scales artwork from 10% to 400%.
- Centers artwork on the sheet and provides a Fit action.
- Mirrors artwork horizontally or vertically for film-output workflows.

### Halftone engine

- Converts RGB samples to cyan, magenta, yellow, and black coverage in the browser.
- Renders a live four-color composite proof or an individual monochrome plate.
- Offers round, square, diamond, line, triangle, cross, circle-outline, and imported custom SVG dots.
- Adjusts cell size from 3 to 64 pixels, with a 240-DPI LPI reference.
- Supports diffusion algorithms and source-field glitch controls.
- Supports standard-positive and inverted-dot output.
- Uses independently editable, normalized 0–359° screen angles for C, M, Y, and K; defaults are 15°, 75°, 0°, and 45°.
- Lets each process plate be shown or hidden independently.
- Draws optional registration targets on proofs and exported plates.
- Uses multiply compositing for the process-color proof and production-black rendering for individual plates.
- Preserves document scale, placement, mirroring, visibility, angles, and output settings between preview and export.

### Separation workflow

- Keeps Artwork, Screen, Plate angles and Output controls in one scrolling inspector beside the live proof.
- Opens the sample immediately; the file picker and canvas drop replace the single artwork while retaining its recipe, scale and mirror settings.
- Provides explicit Composite/C/M/Y/K preview buttons, visibility checkboxes and angle fields.
- Labels hidden plates in individual and composite proofs.
- Uses ordinary numeric fields and sliders; Enter commits a typed value and Escape restores it.
- Keeps diffusion and glitch controls in expandable Screen sections.
- Supports proof zoom from 35% to 110%, zoom buttons, a slider and double-click reset.

### Preflight and job handoff

- Reports hidden plates before export.
- Detects exact shared screen angles and marks them for review without claiming guaranteed moiré prediction.
- Exposes registration and dot-polarity choices directly. Quick exports enforce hard safety limits; they retain the existing quick-export behavior without an additional warning-confirmation dialog.
- Estimates screen marks per enabled plate and identifies the worst plate/angle.
- Blocks exports above the 2,000,000-marks-per-plate safety limit instead of silently overloading the browser.
- Builds a human-readable job ticket containing source, sheet, resolution, placement, mirroring, dot, tonal, angle, visibility, registration, polarity, density, and load details.
- Copies the job ticket to the clipboard, with a text-file download fallback.

### Export

- Exports composite PNG, JPEG and TIFF proofs with 240-DPI metadata, plus vector SVG plate ZIPs.
- Exports enabled C/M/Y/K PNG plates (or K only in grayscale), each with embedded 240-DPI metadata, in a ZIP.
- Includes `job-settings.json` in every plate ZIP with the source name, document geometry, separation settings, registration state, output dimensions, DPI, and screen-load estimate.
- Uses deterministic, source-based filenames for proof and plate packages.
- Performs all rendering and package generation client-side.

### Accounts and platform foundation

- Supports guest use of the complete local-session studio.
- Provides email/password signup, login, session display, and sign-out surfaces.
- Runs authentication through a Hono Cloudflare Worker and Better Auth.
- Stores authentication records in Cloudflare D1 through Drizzle.
- Creates the authentication instance per request to avoid D1 lock contention.
- Exposes a Worker health endpoint at `/api/health`.
- Uses D1 and static-asset bindings with a separately configured authentication secret and canonical origin.

Saved cloud projects and cross-device project persistence are **not implemented in `0.1.0`**. The studio currently identifies work as a local session; account infrastructure is in place for a later hosted-workspace release.

### Accessibility and responsive behavior

- Provides labelled native controls, visible keyboard focus and explicit plate names.
- Keeps the proof and inspector available below 1280×800; narrow layouts stack them.
- Preserves keyboard access to artwork, custom-shape dialogs, export and account controls.
- Does not install workstation tool shortcuts, scrub gestures or Space-drag panning in the default workflow.

## Isolated workstation review

The superseded project library, multi-layer editor, docking, floating panels,
layout persistence and scrub controls remain in source with their tests. To
review them locally, explicitly start:

```bash
VITE_DRG_WORKSTATION_REVIEW=1 npm run dev -- --host 127.0.0.1 --port 4343 --strictPort
```

The flag is also guarded by Vite's `DEV` constant and cannot enable the
workstation in a production build. No default route opens its saved library.
`npm run test:e2e` runs the retained workstation suite, then the default workflow
suite. `npm run test:restoration` runs only the restored workflow; after a build,
`DRG_E2E_BUILT_CLIENT=1 npm run test:restoration` checks the built client on the
same temporary loopback port. The original guest canary remains a workstation
harness; its Node guard tests remain valid, but it does not attest this new
workflow. All live execution still requires separate authority.

## Stack

- React 19, React Router, TypeScript, and Vite
- Hono on Cloudflare Workers
- Better Auth with `better-auth-cloudflare`
- Cloudflare D1 and static assets
- Drizzle ORM
- Canvas 2D rendering and JSZip
- Vitest and Playwright

## Local development

The editable desktop source is in `desktop/halftone_glitch_2.py`. See
[desktop parity notes](docs/desktop-parity.md) for implemented features and
remaining differences. The source copy does not automatically sync with
`C:\HalftoneGlitch\halftone_glitch_2.py`.

The Screen stage now includes Triangle, Cross, Circle outline, outline stroke
(0.25–10 document pixels), and Grayscale (K). Grayscale uses the K angle and
exports one K plate plus settings. CMY controls become available again when
returning to CMYK. Reset Screen restores CMYK, Round, and a 1 px outline.

Requirements: Node.js `>=22.14.0` and npm `>=11.11.0` (lockfile generated with npm 11.11.0).

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4343 --strictPort
```

Useful checks:

```bash
npm test
npm run test:worker
npx playwright install chromium
npm run test:e2e
npm run lint
npm run build
node --test tests/canary/guest-canary-guards.test.mjs
```

Open `http://127.0.0.1:4343` in a desktop browser. Use the sample immediately
or upload a PNG/JPEG/WebP; no account is required. Use **Screen** and **Plate angles**
for separation controls, and **Export** for proof and plate packages.

In VS Code, choose **Terminal → Run Task → DR.GLITCH: Start local studio**.
Keep that terminal running while testing. Stop it with Ctrl+C or Terminate
Task, then run the same task to restart. **DR.GLITCH: All checks** runs unit
tests, Worker auth tests, browser tests, lint, and build. Install Chromium once using the command
above. If port 4343 is occupied, identify its owner before starting; never stop an
unrelated listener or silently switch the registered preview port.

The hosted authentication paths require the D1 and Better Auth configuration in
`wrangler.toml`. For local accounts, create an ignored `.dev.vars` from
`.dev.vars.example`, supply a random local secret, and apply local migrations.
See [deployment and verification](docs/deployment.md) for exact commands, the
managed-host preview/tunnel route, and the platform-owned Workers Builds release
route. Workstation OAuth and a source push are not deployment authorization. The studio
remains usable as a guest when auth is not configured.

The [guest browser canary](scripts/guest-canary.mjs) has no default network target.
Its [Node-only guard tests](tests/canary/guest-canary-guards.test.mjs) need no npm
installation. Browser rehearsal requires installed dependencies, Chromium, and
an explicitly started loopback server; live mode additionally requires a
platform deployment receipt and explicit guest-canary approval. See the
[canary runbook](docs/deployment.md#guest-browser-canary) before running it.

## License

See [LICENSE](LICENSE) for the repository license and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices.
This release does not change either file or grant new licensing rights.
