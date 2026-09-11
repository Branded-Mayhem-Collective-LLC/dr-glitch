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

## Production ordering

Commit, push, PR creation, and deployment each require explicit authority.
Merge is a separate action. A PR branch can be deployed without merging it.

1. Confirm clean release Git state, the exact source commit, and successful
   checks. Authenticate Wrangler in the approved execution session, without exposing
   tokens. If OAuth refresh fails, stop deployment and renew login or securely
   configure a scoped `CLOUDFLARE_API_TOKEN`; do not use another account.
2. Use `npx wrangler whoami`, `npx wrangler deployments list`,
   `npx wrangler secret list`, and `npx wrangler d1 info halftone-web-db` to
   confirm the existing account/Worker. A narrowly scoped token may not support
   user-profile diagnostics: use an explicit, verified `CLOUDFLARE_ACCOUNT_ID`
   and successful target-resource checks rather than widening token permissions.
   Verify the D1 ID is
   `58107fbc-9930-41f7-ad25-3ab4c7500e49`, and preserve the existing
   `BETTER_AUTH_SECRET`. Rotating that secret invalidates sessions and is not
   part of this release.
3. Record the currently active Worker version and D1 Time Travel bookmark.
   Inspect pending migrations with
   `npx wrangler d1 migrations list halftone-web-db --remote`.
   This release adds only `rate_limits` and its indexes; it does not rewrite or
   remove users, accounts, or sessions.
4. Apply the additive migration **before** deploying the database-backed
   limiter: `npx wrangler d1 migrations apply halftone-web-db --remote`.
   Never deploy the new auth handler without that table.
5. Run the repository's approved `npm run deploy`. It builds and deploys
   `dist/halftone_web/wrangler.json`. Deploying the root config directly is
   not equivalent: the Vite-generated config contains the built Worker and
   client asset paths. Production origin must remain the existing HTTPS URL,
   not a local `.dev.vars` override.
6. Verify the returned URL and active version; check `/`, client asset URLs,
   `/api/health`, and anonymous `/api/auth/get-session` on the existing
   domain. Auth responses must be `Cache-Control: no-store`. Smoke-test guest
   imports/exports in a browser. Creating production test accounts requires an
   explicit test-account plan; local D1 tests already exercise writes.
7. Add source commit, PR, migration receipt, Worker version, and live-check
   results to the release handoff. A dry run or a healthy old deployment is
   not evidence that this release deployed.

If rollback is needed, use the recorded prior Worker version with Wrangler's
rollback command. Leave the additive rate-limit table in place; it is unused
by older code. Do not drop tables or restore the entire database as a routine
code rollback.

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
