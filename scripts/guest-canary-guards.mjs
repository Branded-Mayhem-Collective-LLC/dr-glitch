import assert from 'node:assert/strict';

export const LIVE_ORIGIN = 'https://halftone-web.morning-snow-4820.workers.dev';
export const REHEARSAL_ORIGIN = 'http://127.0.0.1:4343';
export const DATABASE_ID = '58107fbc-9930-41f7-ad25-3ab4c7500e49';
export const MIGRATION_NAME = '0001_crazy_night_thrasher.sql';
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pure guards: importing this file never launches a browser or contacts a service.
export function parseInvocation(args) {
  const [mode, receiptPath] = args;
  assert(mode === '--rehearsal' || mode === '--live', 'Choose --rehearsal or --live <receipt.json>; there is no default network target.');
  assert.equal(args.length, mode === '--live' ? 2 : 1, 'Live mode requires exactly one deployment receipt; rehearsal takes no receipt or URL.');
  if (mode === '--live') assert(typeof receiptPath === 'string' && receiptPath.trim(), 'Deployment receipt path is required.');
  return { live: mode === '--live', origin: mode === '--live' ? LIVE_ORIGIN : REHEARSAL_ORIGIN, receiptPath };
}

export function validateDeployment(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'A platform deployment receipt is required.');
  assert.match(input.releaseSha, SHA, 'Receipt must identify a full exact release commit.');
  assert([LIVE_ORIGIN, `${LIVE_ORIGIN}/`].includes(input.targetUrl), 'Receipt must name the exact existing HTTPS root URL.');
  assert.equal(input.workerName, 'halftone-web');
  assert.match(input.workerVersionId, UUID, 'A deployed Worker version ID is required.');
  assert.equal(input.databaseId, DATABASE_ID);
  assert.equal(input.migrationName, MIGRATION_NAME);
  assert(['applied', 'already-applied'].includes(input.rateLimitMigrationStatus), 'The rate-limit migration must already be applied.');
  assert.equal(input.liveCanaryAuthorized, true, 'Explicit live guest-canary approval is required.');
  // Do not copy private provenance, credentials or unrelated receipt fields into artifacts.
  return Object.fromEntries(['releaseSha', 'targetUrl', 'workerName', 'workerVersionId', 'databaseId', 'migrationName', 'rateLimitMigrationStatus', 'liveCanaryAuthorized'].map(key => [key, input[key]]));
}

export function validateCheckout({ sourceCheckoutSha, status, releaseIsAncestor }) {
  assert.match(sourceCheckoutSha, SHA);
  assert.equal(status, '', 'Use a clean, reviewed source checkout (ignored work artifacts are allowed).');
  assert.equal(releaseIsAncestor, true, 'Approved deployed commit must be the source checkout or its ancestor.');
}

export function createRequestGuard({ live }) {
  const origin = live ? LIVE_ORIGIN : REHEARSAL_ORIGIN;
  let sessionGets = 0;
  return {
    get sessionGets() { return sessionGets; },
    inspect({ url: value, method, redirected = false }) {
      const url = new URL(value);
      const session = url.pathname === '/api/auth/get-session';
      // Reject encoded path aliases so server decoding cannot bypass the API list/budget.
      const canonicalPath = !url.pathname.includes('%');
      const allowedApi = url.pathname !== '/api' && (!url.pathname.startsWith('/api/') || ['/api/health', '/api/auth/get-session'].includes(url.pathname));
      const apiQuery = url.pathname.startsWith('/api/') && url.search !== '';
      if (session) sessionGets++;
      const allowed = ['http:', 'https:'].includes(url.protocol) && url.origin === origin
        && !url.username && !url.password && ['GET', 'HEAD'].includes(method)
        && canonicalPath && allowedApi && !apiQuery && !redirected && sessionGets <= 8;
      return { allowed, session, method, origin: url.origin, path: url.pathname };
    },
  };
}

export function isRedirect(status) { return status >= 300 && status < 400; }

// Injected route/callbacks keep transport behavior testable without network access.
export async function relayWithoutRedirects(route, { onRedirect, onFailure }) {
  let response;
  try {
    response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
    if (isRedirect(response.status())) {
      onRedirect(response.status());
      await route.abort('blockedbyclient');
    } else {
      await route.fulfill({ response });
    }
  } catch (error) {
    onFailure(error);
    await route.abort('failed').catch(() => {});
  } finally {
    if (response) await response.dispose().catch(onFailure);
  }
}

// Only an explicitly selected loopback rehearsal may use same-port Vite HMR.
export function allowRehearsalSocket(live, value) {
  const url = new URL(value);
  return !live && url.protocol === 'ws:' && url.hostname === '127.0.0.1'
    && url.port === '4343' && url.pathname === '/' && !url.username && !url.password;
}
