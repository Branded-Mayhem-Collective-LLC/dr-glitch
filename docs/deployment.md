# DR.GLITCH verification and deployment

Target: `halftone-web` on
[the existing workers.dev domain](https://halftone-web.morning-snow-4820.workers.dev/).
Do not create a replacement Worker, public preview, or new domain to bypass an
authentication problem. Version-specific preview URLs are disabled.

## Local development

On managed development hosts, resolve the approved project registry entry and
use the assigned isolated worktree, never a shared clean clone. Node >=22.14 and
npm >=11.11 are required.

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4343 --strictPort
```

Check port ownership before starting. For a human browser preview, explicitly
open a loopback-only SSH tunnel from the control machine:

```bash
ssh -N -L 127.0.0.1:4343:127.0.0.1:4343 <user>@<approved-development-host>
```

Stop this task's preview and tunnel at handoff unless asked to keep them running.
Browser tests start and stop their own loopback server on 4343 and refuse to
reuse an existing listener.

Guest rendering needs no credentials. For local signup/login, create an ignored
`.dev.vars` using `.dev.vars.example`, with the local URL and a unique random
secret (at least 32 characters). A secret can be generated with
`openssl rand -base64 32`; put it directly in the ignored file, not in chat,
logs, shell history, or a tracked file. Then:

```bash
npx wrangler d1 migrations apply halftone-web-db --local
```

Without the local URL override, production's canonical-origin pin correctly
rejects local auth. Missing/invalid configuration returns 503; guest use and
`/api/health` remain available. Unit/Worker tests use isolated test-only
bindings and do not read production secrets or contact D1 remotely.

## Release checks

```bash
npm ci
npm run lint
npm test
npm run test:worker
npm run test:e2e
npm run build
npm run db:generate
npm audit
node --test tests/canary/guest-canary-guards.test.mjs
git diff --check
npx wrangler deploy --dry-run -c dist/halftone_web/wrangler.json
```

Install Playwright Chromium if absent. `db:generate` should report no changes.
The runtime tests apply both migrations to local D1 and exercise real password
hashing, secure sessions, CSRF/origin/callback rejection, body bounds, and atomic
rate limiting. Raster parity uses immutable starting-commit fixtures in the
same browser, not refreshed platform PNG hashes. SVG tests additionally cover
the previously missing vector behaviors.

Regenerate binding types after configuration changes:

```bash
npx wrangler types --include-runtime false --strict-vars false
```

## Managed production ordering

Production releases are owned by CTO/platform through the existing Cloudflare
Workers Builds integration. Interactive source sessions own code, checks and
the approved browser canary; they must not independently authenticate/deploy,
apply remote migrations, or create replacement resources. Workstation OAuth
retries and copying credentials to development hosts are not the release route.
Commit, push, PR creation, merge, migration, deployment and live canary each need
their applicable explicit authority. A code push or PR merge is not permission
to release. A PR commit can be released before its separately authorized merge.

Cloudflare exposes separate build, production-deploy and non-production-deploy
settings; retries use the settings in effect at retry time. Platform must inspect
the actual integration configuration for every release, not assume repository
files alone describe it. See the official
[Workers Builds configuration documentation](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

1. Source owner supplies a clean, reviewed exact commit SHA, PR and passing
   release checks. Platform confirms that same commit is readable through the
   existing GitHub integration and pins the bounded managed build to it. A branch
   name alone is insufficient evidence of which source will deploy.
2. Platform verifies the existing account, Worker `halftone-web`, `DATABASE`
   binding to `halftone-web-db` / `58107fbc-9930-41f7-ad25-3ab4c7500e49`, and the
   existing `BETTER_AUTH_SECRET` name without reading or rotating its value.
   Runtime `BETTER_AUTH_URL` must remain the existing HTTPS root URL. Build-time
   settings must not introduce a local `.dev.vars` override.
3. Before mutation, platform records the active deployment/version and D1 Time
   Travel bookmark, then inspects pending migrations. For this release,
   `0001_crazy_night_thrasher.sql` adds only `rate_limits` and its two indexes.
   Platform applies it, if pending, **before** deploying the database-backed
   limiter and independently reads back the table, indexes and migration ledger.
   Existing user/account/session data and the database binding remain unchanged.
4. Platform executes one explicitly authorized managed build for the exact SHA,
   using the approved pinned build/install commands and the repository lockfile.
   After Vite builds, deployment must use
   `dist/halftone_web/wrangler.json`, which identifies the built Worker and client
   assets. The root config alone is not an equivalent deployment artifact.
   The repository's `npm run deploy` remains a build-and-deploy implementation
   script, **not authorization to run it from a workstation**. The platform's
   approved managed commands, not invented local substitutes, control execution.
5. Platform captures the managed build ID/status/time/source SHA, deployment ID,
   active Worker version and traffic allocation, migration evidence and rollback
   bookmark. It checks the existing domain, root/client assets, `/api/health`
   (`{"ok":true}`), and anonymous `/api/auth/get-session` (`null`, `no-store`).
   The source owner must receive this version receipt and explicit canary
   approval before contacting the live domain with the browser harness.
6. After the one authorized build, platform disables further release execution
   and records the effective trigger settings. The accepted release left its
   production `deploy_command` set to the shell command `false`; that alone is
   **not** a universal preview-build lock. Platform must also verify that
   non-production branch release paths are disabled or fail closed. Leave
   version-specific preview URLs disabled. Do not retry a build, enable a hook,
   publish a preview, or re-enable either deployment path without a new explicit
   exact-release disposition.
7. Source owner runs the bounded guest canary below; platform independently
   accepts the receipt and artifacts against the deployed version. Record any
   failure and stop integration pending disposition. Only then perform any
   separately authorized main integration. A dry run, local HEAD, passing CI,
   or a healthy old deployment is not proof of a new live release.

Keep infrastructure credentials, private approval provenance and operational
receipts out of this public repository. Record them in the approved private
release handoff. If rollback is necessary, platform restores the recorded prior
Worker version under the applicable release authority. Leave the additive
rate-limit table in place; older code does not use it. Do not drop tables or
restore the entire database as a routine code rollback.

## Guest browser canary

`scripts/guest-canary.mjs` preserves the accepted guest/export canary. It has
no live default, URL override, saved browser profile, remote mutation commands,
or account credentials. Run it from a clean, reviewed checkout. It records both
the actual `sourceCheckoutSha` of the harness checkout and the deployed
`releaseSha` from the platform receipt; the deployed commit must exist locally
and be that checkout or its ancestor. A later harness/documentation commit does
not change or attest the running release. Receipt validation checks the supplied
claims, not their authenticity: obtain and verify the receipt through the
authorized platform owner before use.

Node-only preflight/request-guard tests need no package installation or server:

```bash
node --test tests/canary/guest-canary-guards.test.mjs
```

For browser execution, install repository dependencies and Playwright Chromium
using the local-development instructions. For a local rehearsal, first check
port ownership and explicitly start the loopback server shown above in its own
terminal. The harness does not start/stop servers or tunnels:

```bash
node scripts/guest-canary.mjs --rehearsal
```

Rehearsal is fixed to `http://127.0.0.1:4343`; it mocks only the anonymous-session
GET so it needs no local auth secret. HTTP redirects are blocked in both modes;
same-port Vite HMR is allowed only in rehearsal. Rehearsal is not live-auth evidence.
For intercepted local pages, the harness grants Chromium's `local-network-access`
permission only to that rehearsal origin, never to the live domain. HTTP/socket
guards still enforce the fixed server. See Playwright's
[origin-scoped permission API](https://playwright.dev/docs/api/class-browsercontext#browser-context-grant-permissions).
Stop the task-owned server and tunnel afterward.

Live mode requires a private JSON receipt with these fields. The placeholders
below are deliberately invalid; replace them only from a received, approved
platform deployment/version receipt, never from an assumed branch or local HEAD.
Keep the file in ignored `work/` or another approved private artifact location:

```json
{
  "releaseSha": "<approved full 40-character source commit>",
  "targetUrl": "https://halftone-web.morning-snow-4820.workers.dev/",
  "workerName": "halftone-web",
  "workerVersionId": "<independently verified deployed version UUID>",
  "databaseId": "58107fbc-9930-41f7-ad25-3ab4c7500e49",
  "migrationName": "0001_crazy_night_thrasher.sql",
  "rateLimitMigrationStatus": "applied",
  "liveCanaryAuthorized": true
}
```

`rateLimitMigrationStatus` may also be `already-applied`. The approval must
explicitly cover this exact deployed release and guest canary; setting the JSON
boolean yourself does not obtain permission. After all gates are satisfied:

```bash
node scripts/guest-canary.mjs --live work/deployment-receipt.json
```

The harness opens a fresh Chromium context with service workers blocked. Live
requests are target-origin GET/HEAD only, with just health and anonymous session
allowed under `/api/`; redirects, external origins, WebSockets and more than
eight anonymous-session requests fail closed. It does not sign up, sign in,
sign out or submit forms. Anonymous session GETs still perform the application's
ordinary D1 limiter bucket updates and bounded expired-row cleanup; guest-only
does not mean literally zero incidental database writes.

The 17 checks cover health/session/boot, stage navigation, synthetic PNG/JPEG/WebP
imports and invalid-file rejection, CMYK precision/visibility, custom SVG and
registration, composite PNG/JPG/TIFF, CMYK and grayscale PNG ZIPs, custom-dot and
diffusion SVG ZIPs, visible glitch/diffusion effects, clipboard-denied job-ticket
fallback, public auth surfaces without submission, and network/runtime errors.
This is a targeted live canary, not exhaustive proof that every engine control
is wired or a substitute for the release regression suites. It needs no
synthetic account. Testing signup/login/session persistence would need a separate
explicit test-account plan covering credentials, data, cleanup and ownership.

Each run creates a unique ignored `work/canary-artifacts/` directory, captures
screenshots, trace, console/network/error receipts and downloaded outputs, then
seals final files owner-read-only (`0400`) in an owner-only directory (`0500`),
with sizes and SHA-256 hashes. Downloads use exclusive
creation rather than overwriting previous artifacts. The receipt separately
hashes the harness, guard module and supplied deployment receipt, retaining only
allowlisted deployment fields. Failed checks exit nonzero and preserve failure
evidence. Keep these artifacts private; do not commit screenshots, traces,
operational paths, account data or private coordination identifiers. Platform
acceptance must verify the final receipt, manifest bytes/hashes, deployed-version
match and absence of unexpected requests/errors, not just a success message.

## Boundaries and known limitations

- Auth supports the configured static email/password routes. Unknown paths are
  rejected before allocating limiter keys. Enabling password-reset delivery or
  OAuth requires explicit support/tests for their parameterized callback paths.
- Rate counters persist across isolates, use only Cloudflare's trusted client-IP
  header, and expire old rows in indexed batches of at most 100 per request.
  This is application throttling, not a replacement for platform abuse controls.
- Artwork format signatures and 50 MB file limits are checked before decoding;
  16,384 px/side and 100 MP limits are checked after decoding. The latter are
  acceptance limits, **not a guaranteed bound on browser decode memory**.
  Replaced pending loads are cancelled; source images never upload to the Worker.
- License and third-party notices are unchanged; no relicensing or commercial
  clearance is asserted by this deployment.
