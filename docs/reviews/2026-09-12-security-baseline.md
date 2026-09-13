# Security baseline review — existing code relevant to this release

Scope: the stable baseline in the worktree (c079a21 + P0 transfer + new
src/core). In-progress subsystem directories are excluded. Line references
into `/home/michael/worktrees/halftone-web/task-20260912-workstation/`.

---

## 1. Custom-shape SVG sanitization — strengths and gaps vs the plan allowlist

Implementation: `src/studio/custom-shape-data.ts` (`sanitizeSvg` :114-175,
`attribute` :66-111, `pathData` :45-64, `numbers` :28-34, `length` :36-43,
`parseCustomShape` :177-186) plus the import flow in
`src/studio/custom-shape.ts:66-95`.

### Strengths (keep these properties in the new canonical validators)

- **Reconstruction, not filtering**: output is a freshly built XML document;
  only allowlisted tags (`geometry` map, `custom-shape-data.ts:7-11`:
  path/rect/circle/ellipse/polygon/polyline/line/g) and allowlisted
  presentation attributes (`:12-16`) are copied. Unknown tags/attributes
  are hard rejects, not drops (`:139-141`, `:151`).
- **Pre-parse rejects**: `<!DOCTYPE`, `<!ENTITY`, `<?xml-stylesheet`
  (`:116`) — kills XXE/entity expansion and external styling before the
  parser runs; xmldom `onError` throws on malformed XML (`:118-120`).
- **Grammar-validated values**: numeric token grammar with residue check
  (`numbers`, `:28-34`, magnitude cap 1e9), full path-command grammar with
  arity and arc-flag validation (`pathData`, `:45-64`), transform function
  allowlist with arity table (`:69-77`), enum validation for
  fill-rule/linecap/linejoin/display/visibility (`:91-99`), opacity and
  miterlimit ranges (`:100-109`), absolute-unit-only lengths with
  non-negative enforcement for width/height/r/rx/ry/stroke-width
  (`:36-43`, `:18`).
- **Paint neutralization**: any valid solid paint becomes `#000000`; `none`/
  `transparent` normalized; everything else (url(), gradients, context-fill)
  rejected (`:79-84` plus the global `url(|[<>]|!important` reject `:67`).
- **Style attribute**: split into declarations, only `presentation`
  properties allowed, values re-validated through the same `attribute`
  pipeline (`:154-160`).
- **Structural bounds**: 2000 nodes, depth 32 (`:135`), 1 MB both as UTF-16
  length and encoded bytes (`:115`), viewBox validated (`:128-131`), root
  forced to `1024x1024` + `preserveAspectRatio="none"` (`:125-127`), text/
  CDATA content and processing instructions rejected (`:168-169`),
  title/desc/metadata dropped, `defs` dropped (`:137-138`).
- **Untrusted-at-rest**: `parseCustomShape` re-sanitizes anything coming
  from serialized settings (`:177-186`), and `prepareCustomShape`
  re-sanitizes before any DOM contact (`custom-shape.ts:102-105`). The DOM
  measurement step (`geometryBounds`) only ever receives sanitizer output,
  inside a closed shadow root with a fixed off-screen host
  (`custom-shape.ts:29-58`).
- **Rendering isolation**: preview/stamp loads go through a Blob object URL
  `<img>` with a 10 s timeout and revocation in `finally`
  (`custom-shape.ts:14-26`); `<img>` SVG rendering is already
  script/external-fetch inert in browsers, so sanitization is
  defense-in-depth on top of that.

Verdict vs plan (`plan:108-109`): the existing sanitizer already meets the
plan's reject list (text, scripts, CSS/external references, embedded
images/fonts, filters, masks, patterns, animation, foreignObject,
declarations, entities) for **custom dots and registration marks**.

### Gaps / decisions for the new validators

1. **It cannot be reused as-is for SVG *artwork*** (`plan:108-109` allows
   "solid fills/strokes" on artwork): `attribute()` rewrites every paint to
   `#000000` (`custom-shape-data.ts:83`) — correct for dots, destructive
   for artwork color separation. The artwork validator must preserve
   validated solid colors (normalize to `#rrggbb`), and its own limits
   (2000 nodes is far too small for artwork; pick artwork-scale bounds and
   put them in `ResourcePolicy`).
2. **`fill="inherit"` passes through** (`:81`) — harmless but not
   canonical; the reconstructed SVG should resolve or reject `inherit`.
3. **Canonical-serialization stability is untested**: preset/asset
   dedup will hash sanitizer output (see contract review A8). Add a test
   that `sanitizeSvg(sanitizeSvg(x)) === sanitizeSvg(x)` byte-for-byte.
4. **`geometryBounds` runs on the live page DOM** (shadow root appended to
   `document.body`, `custom-shape.ts:33-36`). Fine now; the worker-renderer
   split must keep this main-thread-only, and the import pipeline must not
   be callable from a context where `document` is a worker shim.
5. **`checkSvgFile` trusts the extension/mime only for the file gate**
   (`custom-shape-data.ts:22-26`) — acceptable because content is fully
   re-parsed; keep that property for the archive import path (never trust
   `.ext` inside a ZIP).
6. **Registration-shape import bypasses the dialog but not the pipeline**
   (`HalftoneStudio.tsx:607-622` → `importCustomShape`) — parity to
   preserve in the new Output panel.

## 2. JSZip usage sites that must be removed

Complete inventory (repo-wide grep, excluding node_modules and the frozen
`tests/e2e/fixtures/renderer-3084f80/` copies):

| Site | What |
|------|------|
| `package.json:33` | `"jszip": "3.10.1"` dependency — remove once the two usage sites are ported. |
| `src/studio/HalftoneStudio.tsx:25` | `import JSZip from "jszip"` (eagerly bundled — the plan requires the replacement to be lazy-loaded, `plan:102`). |
| `src/studio/HalftoneStudio.tsx:655` | SVG plate package ZIP (`new JSZip()` → `generateAsync` at :679). |
| `src/studio/HalftoneStudio.tsx:717` | PNG plate package ZIP (`new JSZip()` → `generateAsync` at :780). |

No other imports exist (worker/, db/, src/auth, src/routes are clean).
`@zip.js/zip.js` is already in `package.json:28` but has **zero usage** yet.
When io lands: dynamic `import("@zip.js/zip.js")` at the archive boundary
only, with strict entry validation (name charset/length, path traversal,
duplicate/overlapping entries, CRC verification, per-entry and total
uncompressed quotas from `ResourcePolicy`, entry-count cap 512) on the
**read** path; the write path (plate packages, .drglitch export) should
disable JSZip-era permissive defaults (no directory entries, fixed
timestamps optional for determinism).

Note: the current export ZIPs embed `job-settings.json` containing full
user settings **including custom-shape and registration SVG source and
filenames** (`HalftoneStudio.tsx:667-678`, `:745-779`). That is a local
download initiated by the user (acceptable), but the same serializer must
never feed telemetry (§5) and the .drglitch manifest should reference
assets by sha instead of inlining.

## 3. Worker / auth surface touchpoints

Baseline (`worker/index.ts`, `worker/auth.ts`) is small and healthy:

- Health endpoint only + auth mount; auth middleware enforces configured
  secret ≥32 chars (`worker/index.ts:13-15`), strict origin equality
  (`:19`), `Cache-Control: no-store` + `nosniff` set both before and after
  handler (`:11-12`, `:22-23`), 16 KB body limit (`:25`), endpoint-path
  allowlist against Better Auth's own route table before the handler runs
  (`:32-35`), bounded rate-limit-bucket cleanup (`:37-39`).
- `authOrigin` requires HTTPS (loopback HTTP allowed), no
  userinfo/path/query/hash (`worker/auth.ts:10-18`); per-request auth
  instance (documented D1 lock hazard, `worker/auth.ts:20-26`); CSRF/origin
  checks left enabled, IP from `cf-connecting-ip` only, DB-backed rate
  limit 100/60 s (`worker/auth.ts:47-62`).

Touchpoints for this release:

1. **Nothing in the new workstation may add API surface.** Projects,
   assets, recovery, presets are local-only (`plan:45`: "projects/artwork
   stay on this device"). At integration, grep the new code for `fetch(`
   to `/api/` — the only legitimate callers remain
   `src/auth/client.ts` (better-auth, relative `/api/auth`) and the
   health check.
2. `wrangler.toml:15` (`run_worker_first = ["/api/*"]`) means everything
   else is static assets — new routes (home surface, dev lab) must stay
   client-side; **the dev component lab must be excluded from production
   routing** (`plan:59`) — verify it is not reachable via the SPA
   `not_found_handling` fallback (`wrangler.toml:13-14`) in production
   builds (build-time exclusion, not a runtime flag).
3. Top-bar account UI reuses `SessionBadge`/auth client — no new
   credentials handling; keep the "accounts do not sync files" copy
   requirement (`plan:45`) as product truth, since the worker indeed has no
   file endpoints.
4. `[observability] enabled = true` (`wrangler.toml:17-18`) is Cloudflare
   worker logs, not Sentry; no action, but do not add request-body logging.

## 4. innerHTML / eval-adjacent patterns and URL lifecycle

- **Zero hits** for `innerHTML`, `dangerouslySetInnerHTML`, `eval(`,
  `new Function`, `document.write`, `insertAdjacentHTML` across src/ and
  worker/. Keep it that way; the SVG preview path (canvas stamp) is the
  approved pattern for showing untrusted vector content
  (`CustomShapeDialog.tsx:34-48`).
- The only markup-string construction is `renderPlateSvg`
  (`halftone.ts:1031`) whose interpolated values are numbers, enum shapes,
  and sanitizer-output symbols (`svgSymbol`, `:1034-1039` — ids are
  internal constants, never filenames). Safe today; when export moves to
  workers, keep filenames and titles out of generated SVG.

Object-URL lifecycle audit (all sites):

| Site | Create | Revoke | Verdict |
|------|--------|--------|---------|
| `custom-shape.ts:15` (loadSvg) | per prepare | `finally` `:25` | Sound (also on timeout/error). |
| `HalftoneStudio.tsx:563` (artwork load) | per file | onload `:569`, onerror `:594`, unmount `:159`, superseded-load `:553` | Sound; load-generation guard prevents stale-set. |
| `HalftoneStudio.tsx:1744` (`downloadBlob`) | per export | `setTimeout` 1 s `:1749` | Acceptable for click-initiated downloads; the new export module should prefer revoking on the anchor's next task and must adopt the File System Access streaming path above `maxBlobDownloadBytes` (256 MiB, `resource-policy.ts:38`) instead of object URLs entirely. |
| `tests/e2e/svg-export.spec.ts:24,69` | test-only | `finally` | n/a |

Watch item for new code: preview `ImageBitmap`s and OffscreenCanvas results
have an analogous lifecycle (`close()` on stale results, `plan:120-122`) —
add a review checklist entry, since leaks there are the new equivalent of
unrevoked URLs.

Other baseline notes:

- `image-file.ts` signature checks (`:8-19`) validate PNG/JPEG/WebP magic
  but **do not detect animated WebP** (no `ANIM` chunk scan) — plan
  requires "Reject animation" (`plan:107`). The new decode path must check
  the VP8X flag byte / ANIM chunk before accepting WebP, and reject APNG
  (acTL chunk) if PNG animation matters to the contract.
- `withPngDpi` (`png-dpi.ts:75-153`) does bounded chunk parsing with
  truncation checks — fine to keep; it preserves unknown trailing bytes
  after IEND (`:147-150`), which is lenient but not dangerous for
  self-produced canvases. Do not reuse it on *imported* PNGs without
  reconsidering that leniency.
- `createId` (`src/core/id.ts:2-8`) falls back to `Math.random` ids —
  non-secure; ids are not secrets, acceptable, but never use it for
  anything capability-like (lease tokens for tab ownership should use
  `crypto.randomUUID`/`getRandomValues` only).

## 5. Sentry-redaction requirements checklist (for the telemetry implementer)

State today: `@sentry/react` (`package.json:25`) and `@sentry/vite-plugin`
(`package.json:45`) are installed but **there are zero imports/initializations
in source** — Sentry is inert, which satisfies "remains disabled without
explicit configuration" (`plan:31`, `plan:131`) by absence. The implementation
must satisfy every line below, and the review agent will assert each with a
test (`plan:152`):

1. **Init gate**: `Sentry.init` runs only when a DSN is provided via build
   config; no DSN in the repo, no secret mutation, no Sentry project
   creation from this environment (`plan:131`).
2. **Rates**: `sampleRate: 1.0` (errors 100%); `tracesSampleRate: 0.1` in
   production, `1.0` only in private validation builds (`plan:128`).
3. **PII**: `sendDefaultPii: false` (`plan:128`); no `Sentry.setUser`
   anywhere; assert `event.user` is stripped in `beforeSend`.
4. **No Replay**: replay integration never imported/registered; bundle
   check that `@sentry-internal/replay` code is absent from output
   (`plan:129`).
5. **Allowlist, not blocklist, in `beforeSend`** (`plan:130`): rebuild the
   outgoing event keeping ONLY release/version, stable error code
   (contract review M9), sanitized stack frames (app-relative filenames
   only, no query strings), timing bucket, browser capability flags,
   coarse layer-count and pixel-size buckets. Drop everything else,
   including `request.url` query/hash, breadcrumbs not explicitly created
   by our code, and all `extra`/`contexts` not on the allowlist.
6. **Forbidden content** — assert none of these can appear in any event
   field: user asset filenames (`sourceName`, `CustomShapeAsset.filename`),
   project/layer ids or titles, manifests, SVG text, artwork-derived pixel
   data, DOM/canvas captures, IndexedDB keys (`plan:129`). Error messages
   are the leak vector: current error strings already embed filenames in
   *notices* (e.g. `HalftoneStudio.tsx:617`, `:1641`) — UI notices may,
   Sentry events may not; use coded errors at the throw site or scrub
   message fields to the stable code.
7. **Breadcrumbs**: `defaultIntegrations` breadcrumb sources (console,
   fetch, DOM click with target text) must be disabled or scrubbed —
   DOM-click breadcrumbs contain layer/project names from the UI
   (`plan:129` "no uncontrolled breadcrumbs").
8. **Tunnels/transport**: no `tunnel` through our worker (would create an
   API surface, §3.1); events go directly to the DSN host or nowhere.
9. **Source maps**: `@sentry/vite-plugin` upload enabled only in approved
   CI with CI-held auth token; maps deleted from deployed assets
   (`filesToDeleteAfterUpload`), and `npm run build` locally must neither
   upload nor emit public `.map` files into `dist/client` (`plan:131`,
   `plan:152`).
10. **Worker (Cloudflare) side**: no Sentry there at all this release —
    the plan scopes Sentry to the app; keep `worker/` dependency-free.
11. **Tests**: unit-level `beforeSend` fixture test feeding a synthetic
    event stuffed with forbidden fields (filename, layer name, SVG text,
    data URL) and asserting the emitted event contains none of them; plus
    a build assertion that no `sentry` chunk loads when DSN is absent.

## 6. Misc hardening notes carried to the new subsystems

- IndexedDB records are untrusted at rest (any page script under the same
  origin, or a bug, can write them): every load path (projects, layouts,
  presets, recovery) must run schema validation equivalent to
  `parseSettings`/`parseCustomShape` rigor before use — especially
  `WorkspaceLayoutStateV1` (corrupt-layout test, `plan:149`) and preset
  `customDotSvg` (must re-sanitize on apply, as `parseCustomShape` does
  today).
- Web Locks + BroadcastChannel messages (`plan:88`) are same-origin but
  cross-tab: treat messages as data, validate shape, never eval-route on
  message-provided strings.
- The .drglitch import threat model in `plan:148` (traversal, overlap,
  CRC, bombs, disguised media, future schemas, partial cleanup) should be
  encoded as a fixture corpus under tests/; the existing SVG fixtures and
  `tests/unit/custom-shape.test.ts` are the pattern to follow.
