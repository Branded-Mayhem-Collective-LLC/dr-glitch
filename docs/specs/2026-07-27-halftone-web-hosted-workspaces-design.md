# DRC Halftone Web: Hosted Studio with Accounts and Saved Projects

- **Date:** 2026-07-27
- **Status:** Approved (design). Implementation plan not yet written.
- **Owners:** Michael Sebastian (product, go-to-market, engineering). Dave Clayton (DRC_ART, original tool and craft).
- **Repo:** `/Volumes/DriveB/Projects/halftone-web`, remote `origin` = Branded-Mayhem-Collective-LLC org.

## 1. Context

`drc_halftone_cmyk` is Dave Clayton's GPL-3.0 desktop separation tool for screen printing and
risograph work: a 196 KB Python/Tkinter application with CMYK angle control, multiple dot
shapes, registration marks, project files, and PNG/TIFF/SVG/PDF export at 240 DPI.

Michael modified and improved that desktop version, then asked Codex to convert it to a web
app. Codex emitted its native OpenAI "Sites" format. That format is not wanted.

### What exists today

The `web/` tree is a single-page browser studio built on the OpenAI Sites starter:

- `lib/halftone.ts` (276 lines): the separation engine. Pure functions over canvas.
  Exports `renderHalftone()`, `createDemoArtwork()`, `PLATES`, `PLATE_META`.
- `app/components/HalftoneStudio.tsx` (628 lines): the studio UI, marked `"use client"`.
- Export path: `canvas.toBlob()` to PNG, or JSZip of the four C/M/Y/K plates.

It has **no network calls, no persistence, and no accounts**. Verified by grep: no `fetch`,
no `localStorage`, no API routes. `db/schema.ts` is literally `export {}`. Both the D1 and R2
bindings in `.openai/hosting.json` are `null`.

### Why the runtime has to change

The starter runs on `vinext@0.0.50`, which is the Sites-native runtime. Dropping Sites means
dropping vinext. Separately, `app/chatgpt-auth.ts` depends on OpenAI's dispatch layer owning
`/signin-with-chatgpt`, `/callback`, the OAuth cookies, and injecting an
`oai-authenticated-user-email` request header. On raw Cloudflare Workers none of that
infrastructure exists and those headers never arrive. That file is deleted, not adapted.

## 2. Goal

Host the studio on Cloudflare, let people sign up with credentials, and give each user a
library of saved projects they can reopen.

## 3. Decisions locked

| Question | Decision |
|---|---|
| Commercial shape | Joint venture. Dave brings the tool and the craft; Michael brings engineering, scale, and go-to-market. |
| Workspace means | Per-user saved projects: source artwork plus settings, reopenable. Not teams, not presets-only. |
| Runtime | Vite React SPA served from Workers static assets, plus a Hono Worker API. Next.js and vinext both removed. |
| Auth and storage | `better-auth-cloudflare` v0.3.1 (MIT) on D1 via Drizzle, with R2 for files. |
| Domain | Deferred. Build and deploy to `workers.dev`; custom domain after the partnership conversation closes. |
| Transactional email | Resend via `michael@brandedmayhem.com` (already a verified sender) until the product domain lands. |
| Source licensing | Publish the whole web app GPL-3.0, crediting upstream. |
| Spec home | This repo, `docs/specs/`. New convention row: Rule #14 has no category for a joint-venture product. |

## 4. Non-goals for v1

Teams and organizations. Billing. Server-side rendering of separations. TIFF, SVG, and PDF
export (the desktop app keeps those; web is PNG plus plate ZIP). Presigned or multipart
uploads. Custom domain and marketing site. An R2 reconciliation cron. An admin panel.

## 5. Architecture

```
halftone-web/
  src/
    studio/         lib/halftone.ts + HalftoneStudio.tsx, substantively unchanged
    auth/client.ts  better-auth client with cloudflareClient() plugin
    routes/         /studio  /login  /signup  /projects
  worker/index.ts   Hono: /api/auth/*, /api/projects/*
  db/schema.ts      generated auth tables + halftone_projects
  wrangler.toml
```

```toml
[assets]
directory = "./dist"
not_found_handling = "single-page-application"
binding = "ASSETS"
run_worker_first = ["/api/*"]
```

### Removed

All Sites scaffolding: `.openai/hosting.json`, `app/chatgpt-auth.ts`,
`build/sites-vite-plugin.ts`, `app/_sites-preview/`, `next.config.ts`, and
`tests/rendered-html.test.mjs` (it asserts only the Sites loading skeleton).

Dropped dependencies: `vinext`, `next`, `eslint-config-next`, `react-server-dom-webpack`,
`react-loading-skeleton`.

Retained: `drizzle-orm`, `jszip`, `lucide-react`, React, Tailwind, `@cloudflare/vite-plugin`,
`wrangler`.

### Retained without modification

`lib/halftone.ts` and `HalftoneStudio.tsx`. Neither makes a network call, so neither needs to
change in order to gain accounts. This is the reason the port is cheap.

### Boundaries

1. **The engine stays pure.** `renderHalftone()` takes settings and a source image and returns
   canvases. It must never learn about users, sessions, or `fetch`. It stays headless-testable,
   and it is the part that is Dave's.
2. **The Worker owns identity and storage. The client owns pixels.** No image bytes cross the
   API except the small original at save time. Separations are never rendered server-side;
   that would require Workers memory for a 25 MP buffer and buys nothing.
3. **One deployed bundle, one license.** See below.

## 6. Licensing

The engine is a port of Dave's GPL-3.0 work. `better-auth-cloudflare` is MIT, which is
GPL-compatible. The cleanest posture is to license the combined web app GPL-3.0 and publish
the source with upstream credit.

Note the mechanism: GPL-3.0 is not AGPL, so *hosting* alone would not compel disclosure.
But shipping a minified JavaScript bundle to browsers conveys object code, which does trigger
the Corresponding Source obligation for the GPL-derived parts. Publishing deliberately is
simpler and safer than discovering this later.

This costs nothing commercially. The moat is the hosted service, the user base, and
go-to-market, not roughly 900 lines of canvas code. It also honors Dave's open-source posture,
which matters in a collaboration that is not yet papered.

## 7. Data model

### Generated, never hand-edited

`user`, `session`, `account`, `verification` via `npx @better-auth/cli generate`, plus the
plugin's file-tracking table. The plugin's `additionalFields` carries `width` and `height` as
numbers so the projects grid can show dimensions without opening anything.

`additionalFields` supports only `string | boolean | number | string[]`. There is no JSON type,
so nested `HalftoneSettings` cannot live there.

The `user` model gains one nullable additional field, `signupSource`, holding the UTM or
referrer captured at account creation. It belongs on the user because it describes how that
person arrived once, not how any individual project was made.

### Ours

```ts
halftone_projects
  id         text primary key
  userId     text not null  -> user.id     (on delete cascade)
  sourceId   text not null  -> file.id     source artwork in R2
  thumbId    text           -> file.id     320px preview, nullable
  name       text not null                 e.g. "Poster v3, tight cyan"
  settings   text not null                 JSON HalftoneSettings
  createdAt  integer
  updatedAt  integer
  index (userId, updatedAt desc)           projects list
  index (sourceId)                         cascade and "variants of this artwork"
```

`settings` is the existing `HalftoneSettings` type verbatim: `cellSize`, `contrast`,
`exposure`, `opacity`, `dotShape`, `invert`, `angles{cyan,magenta,yellow,black}`,
`visible{cyan,magenta,yellow,black}`. No new type is invented; the client already produces
exactly this shape.

### Why projects are a separate table

Collapsing project into the plugin's file record would force one project per artwork. That is
wrong for the actual workflow: one piece of art, many separation experiments (tighter cell,
rotated cyan, different dot shape). A separate table means saving a variant costs one D1 row
and zero R2 bytes.

### What is never stored

Renders and plates. `renderHalftone()` is deterministic, so source plus settings reproduces any
plate exactly. Opening a project fetches the source from R2 and the settings row from D1, then
renders client-side.

This matters for cost and for feasibility. Uploads proxy through the Worker; the library
supports neither presigned URLs nor multipart, and its own documented example caps at 2 MB.
Print-resolution output is far larger:

| Size at 240 DPI | Pixels | Typical PNG |
|---|---|---|
| 11x17 | 2640 x 4080 | ~10 MP |
| 18x24 | 4320 x 5760 | ~25 MP, 20 to 40 MB |

Storing only user-supplied originals keeps uploads at a few MB and means the Worker never
proxies a 40 MB body.

### Thumbnails

A projects grid without previews is unusable at 30 projects. Generate a 320px JPEG client-side
at save time via `canvas.toBlob()` (roughly 20 KB) and store it as a second file.

## 8. Auth, API surface, and the conversion path

### Methods

Email and password, with verification and reset by Resend. Google OAuth is optional and
additive; it works on `workers.dev` provided the redirect URI is registered. Magic-link-only is
rejected: a printmaker reopening a project six weeks later wants a password, not an email hunt.

### The highest-risk implementation rule

```ts
// worker/index.ts. Per request. NEVER module scope.
app.use("*", async (c, next) => {
  c.set("auth", createAuth(c.env));
  await next();
});
```

A module-level singleton holds a D1 write lock while the next instance blocks on it. This is
the documented cause of 33-second hangs and phantom 503s in this library. Treat it as binding.

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `/api/auth/*` | none | better-auth handler: sign-up, sign-in, verify, reset, OAuth |
| `/api/auth/files/*` | session | plugin-owned upload, list, download, delete, get |
| `GET /api/projects` | session | list, cursor-paginated, newest first |
| `POST /api/projects` | session | create; validates and clamps settings |
| `GET/PATCH/DELETE /api/projects/:id` | session | must assert `userId` match |

**Every project query filters on `userId`, never on `id` alone.** Session-present is not the
same as owns-this-row. User A requesting user B's project id gets a 404.

### Rate limiting

D1 only for v1. KV secondary storage is skipped deliberately: Cloudflare KV enforces a 60
second minimum TTL, and rate-limit windows shorter than that crash. Windows stay at or above
60 seconds regardless.

### Conversion path

The studio stays fully usable anonymous: upload, tune, export PNG and the plate ZIP, all
without an account. Auth gates exactly one thing, **saving**. The tool is therefore its own
top-of-funnel, and the signup prompt arrives at the moment of demonstrated value rather than
in front of it.

This creates one requirement that is easy to miss and expensive to retrofit: **pressing Save
while anonymous must not lose the work.** Hold the source image and settings in memory, run
signup in a modal or a return-to route, then complete the save on the far side. Someone who
tunes a separation for fifteen minutes, signs up, and lands in an empty studio does not
come back.

`signupSource` is populated from the landing cookie so signups are attributable from day one
rather than reconstructed later. This exists because of the standing attribution gate: no paid
amplification until attribution ships.

## 9. Error handling

| Case | Behavior |
|---|---|
| File over 15 MB, wrong type, or over quota | Named, specific message stating which limit and what it is. Never a bare "upload failed". |
| R2 object gone, D1 row present | Visible "source artwork unavailable" state with a re-upload action. Not a crash, not a blank card. |
| Artwork exceeds browser canvas area cap | Refuse before attempting, name the ceiling, point at the desktop app. |
| Session expired mid-save | Re-authenticate and retry the save with the work still in hand. |
| Settings fail validation | HTTP 400 naming the offending field. |
| D1 write fails | Surface it. Never a silent success toast. |

Refusing oversized jobs mirrors a decision Dave already made. The Python README states that
dense jobs are "stopped with a warning instead of being silently resampled." The same posture
holds on the web. A printmaker who is silently resampled finds out at the screen, and that
costs money.

### Settings validation

Validate and clamp server-side on write, and again in the client. There is no RCE risk because
rendering is client-side, but `cellSize: 0` or a negative value divides by zero and hangs the
tab on reopen. An explicit guard of roughly 30 lines covers the eight fields. No new dependency.

### D1 and R2 have no shared transaction

A delete can half-succeed and leave a D1 row pointing at a missing object. For v1: delete R2
first, then D1, and make "source missing" a handled, visible UI state. A sweeper can come
later. Pretending the case cannot occur is what produced the `file-sweeper` `source_missing`
ghosts previously.

## 10. Limits and quotas

Enforced in the plugin's upload lifecycle hook, server-side, not only in the client. Without a
server-side cap one user can fill the bucket.

- `maxFileSize`: 15 MB
- `allowedTypes`: `.png`, `.jpg`, `.jpeg`, `.webp`
- Per user: 25 artworks, 100 projects

## 11. Testing

1. **Pure-math unit tests** (Vitest, Node) for `clamp`, `coverageFor`, and the angle and
   geometry helpers. No canvas required.
2. **Render regression** via Playwright. `lib/halftone.ts` already exports
   `createDemoArtwork()`, a fixed deterministic source. Render the composite and all four
   plates at pinned settings, hash the canvases, fail on drift. This is the safety net over
   Dave's engine and it is nearly free because the fixture already exists.
3. **API integration tests** on `@cloudflare/vitest-pool-workers` against local D1 and R2.
   The mandatory case is cross-user access denial.
4. **Concurrency smoke test** asserting the per-request auth instance holds: parallel writes
   must not serialize into multi-second hangs. This is the regression test for section 8's
   highest-risk rule.

## 12. Risks

| Risk | Mitigation |
|---|---|
| `better-auth-cloudflare` is 0.x (v0.3.1) on a user-facing product | MIT licensed and actively maintained (released 2026-07-23). Vendor or fork if upstream stalls. |
| Singleton auth instance causes D1 lock contention | Per-request instantiation, plus the concurrency smoke test in section 11. |
| Browser canvas area caps, Safari strictest | Refuse oversized jobs explicitly. The desktop app remains the tool for the largest large-format work. This is a feature boundary, not a defect. |
| Partnership is unpapered while the service stores third-party artwork | Launch gates below. Engineering can complete without them; a public launch cannot. |

## 13. Launch gates (Michael-owned)

1. The conversation with Dave closes: naming, revenue split, IP, and who is the data
   controller of record.
2. A written collaboration agreement exists.
3. Privacy policy and terms of service published.
4. Product domain live, with the Resend sender moved onto it.
5. GPL source published with upstream credit.
6. Quotas verified server-side under load.

On compliance language: storing customers' artwork creates a processor relationship. Copy says
"designed to", never "compliant".

## 14. Open questions

None blocking implementation. The domain choice is deferred by decision, not by oversight, and
`workers.dev` unblocks the entire build.
