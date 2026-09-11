# DR.GLITCH

Browser-native CMYK halftone separations for screen-print production. DR.GLITCH turns RGB artwork into a live composite proof and four press-ready monochrome process plates without uploading the artwork to a server.

**Current version:** `0.1.0`

## Feature list

### Artwork and document setup

- Opens PNG, JPEG, and WebP artwork through the file picker or drag and drop.
- Includes generated sample artwork so the studio is usable immediately.
- Processes source artwork in the browser; the current studio does not upload artwork.
- Reports source dimensions and RGB color mode.
- Supports Letter, A4, 8×10, 9×12, 11×15, 11×17, 13×19, and 15×22-inch sheets.
- Supports portrait and landscape orientation, with automatic orientation selection for clearly horizontal or vertical source files.
- Scales artwork from 10% to 400%.
- Positions artwork by direct canvas dragging or exact X/Y offsets in 240-DPI document pixels.
- Provides one-click Center and Fit actions.
- Mirrors artwork horizontally or vertically for film-output workflows.
- Resets artwork controls independently from the rest of the job.

### Halftone engine

- Converts RGB samples to cyan, magenta, yellow, and black coverage in the browser.
- Renders a live four-color composite proof or an individual monochrome plate.
- Offers round, square, diamond, and line dot shapes.
- Adjusts cell size from 3 to 64 pixels, with a 240-DPI LPI reference.
- Adjusts contrast from 0.5× to 2× and exposure from -30% to +30%.
- Adjusts composite ink density from 35% to 100%.
- Supports standard-positive and inverted-dot output.
- Uses independently editable, normalized 0–359° screen angles for C, M, Y, and K; defaults are 15°, 75°, 0°, and 45°.
- Lets each process plate be shown or hidden independently.
- Draws optional registration targets on proofs and exported plates.
- Uses multiply compositing for the process-color proof and production-black rendering for individual plates.
- Preserves document scale, placement, mirroring, visibility, angles, and output settings between preview and export.

### Separation workflow

- Organizes the job into Artwork, Screen, Separation, and Output stages.
- Keeps the live proof visible while stage-specific controls remain in a collapsible inspector.
- Provides a single ink rail for composite/C/M/Y/K selection, angle editing, and visibility.
- Solos plates by click, keyboard, or numbered shortcut.
- Labels hidden plates in both individual and composite proof states.
- Tints active controls with the selected process ink without relying on color alone for identity.
- Supports type-to-edit, horizontal value scrubbing, sliders, arrow-key nudging, and per-control reset.
- Uses Shift for 10× numeric movement and Alt/Option for 0.1× precision where supported.
- Supports proof zoom from 35% to 110%, zoom buttons, a slider, and double-click reset.
- Supports Space-drag canvas panning without changing export geometry.

### Preflight and job handoff

- Reports hidden plates before export.
- Detects exact shared screen angles and marks them for review without claiming guaranteed moiré prediction.
- Reports whether registration marks are disabled.
- Flags inverted dot polarity for confirmation.
- Estimates screen marks per enabled plate and identifies the worst plate/angle.
- Blocks exports above the 2,000,000-marks-per-plate safety limit instead of silently overloading the browser.
- Builds a human-readable job ticket containing source, sheet, resolution, placement, mirroring, dot, tonal, angle, visibility, registration, polarity, density, and load details.
- Copies the job ticket to the clipboard, with a text-file download fallback.

### Export

- Exports a composite proof as a PNG with embedded 240-DPI metadata.
- Exports a ZIP containing four monochrome C/M/Y/K PNG plates, each with embedded 240-DPI metadata.
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
- Declares D1, R2, static-asset, and authentication-secret bindings for hosted deployment.

Saved cloud projects and cross-device project persistence are **not implemented in `0.1.0`**. The studio currently identifies work as a local session; account infrastructure is in place for a later hosted-workspace release.

### Accessibility and responsive behavior

- Provides visible focus treatment and keyboard access for stage, plate, angle, numeric, auth, and session controls.
- Gives each plate an accessible name containing its identity, angle, and visible/hidden state.
- Preserves native Space activation on interactive controls while using Space-drag only on the proof surface.
- Prevents global studio shortcuts from firing while the operator is typing.
- Avoids color-only plate identification by pairing ink with C/M/Y/K labels and angles.
- Honors reduced-motion preferences across process animation and loading states.
- Presents a dedicated desktop-required message on narrow/touch layouts because full-resolution separation work requires a pointer and large canvas.

## Keyboard map

| Key | Action |
| --- | --- |
| `` ` `` | View the composite proof |
| `1` / `2` / `3` / `4` | Solo C / M / Y / K |
| `[` / `]` | Decrease / increase cell size |
| `Space` + drag | Pan the proof |
| `Enter` on a plate | Solo that plate |
| `Alt` + `Enter` on a plate | Toggle plate visibility |
| Arrow keys in numeric fields | Nudge the current value |
| `Shift` + arrow/drag | 10× numeric movement |
| `Alt`/`Option` + arrow/drag | 0.1× numeric precision |
| `Enter` / `Escape` in a numeric field | Commit / revert the draft |

## Stack

- React 19, React Router, TypeScript, and Vite
- Hono on Cloudflare Workers
- Better Auth with `better-auth-cloudflare`
- Cloudflare D1, R2, and static assets
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

Requirements: Node.js `>=22.13.0`.

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Useful checks:

```bash
npm test
npx playwright install chromium
npm run test:e2e
npm run lint
npm run build
```

Open `http://127.0.0.1:5173` in a desktop browser. Use the sample immediately
or upload a PNG/JPEG/WebP; no account is required. Open **Screen** for the new
controls, **Separation** for the K angle, and **Export** for PNG/plate ZIPs.

In VS Code, choose **Terminal → Run Task → DR.GLITCH: Start local studio**.
Keep that terminal running while testing. Stop it with Ctrl+C or Terminate
Task, then run the same task to restart. **DR.GLITCH: All checks** runs unit
tests, browser tests, lint, and build. Install Chromium once using the command
above. If port 5173 is already occupied, use the running studio or stop its
existing development task before starting another.

The hosted authentication paths require the D1 and Better Auth bindings declared in `wrangler.toml`. The separation studio itself remains usable as a guest without those hosted bindings.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
