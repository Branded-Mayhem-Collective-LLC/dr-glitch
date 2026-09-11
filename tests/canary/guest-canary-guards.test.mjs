import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { allowRehearsalSocket, createRequestGuard, DATABASE_ID, isRedirect, LIVE_ORIGIN, MIGRATION_NAME, parseInvocation, REHEARSAL_ORIGIN, relayWithoutRedirects, validateCheckout, validateDeployment } from '../../scripts/guest-canary-guards.mjs';

const releaseSha = 'a'.repeat(40);
const validReceipt = () => ({
  releaseSha, targetUrl: `${LIVE_ORIGIN}/`, workerName: 'halftone-web',
  workerVersionId: '12345678-1234-1234-1234-123456789abc', databaseId: DATABASE_ID,
  migrationName: MIGRATION_NAME, rateLimitMigrationStatus: 'applied', liveCanaryAuthorized: true,
});

test('there is no default network target, URL override, or implicit live approval', () => {
  for (const args of [[], ['--live'], ['--other'], ['--rehearsal', 'receipt.json'], ['--live', ''], ['--live', 'receipt.json', LIVE_ORIGIN]]) {
    assert.throws(() => parseInvocation(args));
  }
  assert.deepEqual(parseInvocation(['--rehearsal']), { live: false, origin: REHEARSAL_ORIGIN, receiptPath: undefined });
  assert.deepEqual(parseInvocation(['--live', 'receipt.json']), { live: true, origin: LIVE_ORIGIN, receiptPath: 'receipt.json' });
});

test('live receipt validates all required gates and drops unknown/private provenance', () => {
  const receipt = validReceipt();
  assert.deepEqual(validateDeployment({ ...receipt, privateProvenance: 'never retain', secret: 'never retain' }), receipt);
  assert.equal(validateDeployment({ ...receipt, rateLimitMigrationStatus: 'already-applied' }).rateLimitMigrationStatus, 'already-applied');
  for (const key of Object.keys(receipt)) {
    const missing = { ...receipt }; delete missing[key];
    assert.throws(() => validateDeployment(missing), key);
  }
  for (const [key, value] of [
    ['releaseSha', 'main'], ['releaseSha', releaseSha.slice(0, 7)],
    ['targetUrl', `${LIVE_ORIGIN}/login`], ['targetUrl', `${LIVE_ORIGIN}?override=1`],
    ['targetUrl', `${LIVE_ORIGIN}#fragment`], ['targetUrl', LIVE_ORIGIN.replace('https:', 'http:')],
    ['targetUrl', LIVE_ORIGIN.replace('https://', 'https://user:password@')],
    ['targetUrl', 'https://replacement.example'], ['workerName', 'replacement'],
    ['workerVersionId', 'latest'], ['databaseId', 'other-database'],
    ['migrationName', '0000_initial.sql'], ['rateLimitMigrationStatus', 'pending'],
    ['liveCanaryAuthorized', false], ['liveCanaryAuthorized', 'true'],
  ]) assert.throws(() => validateDeployment({ ...receipt, [key]: value }), key);
  for (const value of [null, [], 'receipt']) assert.throws(() => validateDeployment(value));
});

test('clean reviewed checkout may be newer than deployed ancestor; unrelated or dirty checkouts fail', () => {
  validateCheckout({ sourceCheckoutSha: 'b'.repeat(40), status: '', releaseIsAncestor: true });
  assert.throws(() => validateCheckout({ sourceCheckoutSha: releaseSha, status: ' M scripts/guest-canary.mjs', releaseIsAncestor: true }));
  assert.throws(() => validateCheckout({ sourceCheckoutSha: releaseSha, status: '?? unexpected.mjs', releaseIsAncestor: true }));
  assert.throws(() => validateCheckout({ sourceCheckoutSha: releaseSha, status: '', releaseIsAncestor: false }));
  assert.throws(() => validateCheckout({ sourceCheckoutSha: 'main', status: '', releaseIsAncestor: true }));
});

test('live requests allow only target-origin GET/HEAD and the two guest APIs', () => {
  const guard = createRequestGuard({ live: true });
  for (const path of ['/', '/assets/index.js', '/fonts/archivo.woff2', '/login', '/signup', '/api/health']) {
    for (const method of ['GET', 'HEAD']) assert.equal(guard.inspect({ url: LIVE_ORIGIN + path, method }).allowed, true);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(guard.inspect({ url: LIVE_ORIGIN + '/', method }).allowed, false);
  for (const url of ['https://external.example/', REHEARSAL_ORIGIN, LIVE_ORIGIN.replace('https:', 'http:'), 'ws://127.0.0.1:4343/', 'data:text/html,test', LIVE_ORIGIN.replace('https://', 'https://user@')]) {
    assert.equal(guard.inspect({ url, method: 'GET' }).allowed, false);
  }
  for (const path of ['/api', '/api/auth/sign-out', '/api/auth/sign-in/email', '/api/unknown', '/api/auth/get-session?disableCookieCache=true', '/api%2fauth%2fget-session', '/%61pi/auth/sign-out']) {
    assert.equal(guard.inspect({ url: LIVE_ORIGIN + path, method: 'GET' }).allowed, false);
  }
  assert.equal(guard.inspect({ url: LIVE_ORIGIN + '/', method: 'GET', redirected: true }).allowed, false);
});

test('anonymous session budget fails closed after eight requests, including HEAD', () => {
  const guard = createRequestGuard({ live: true });
  for (let i = 0; i < 8; i++) assert.equal(guard.inspect({ url: LIVE_ORIGIN + '/api/auth/get-session', method: i % 2 ? 'HEAD' : 'GET' }).allowed, true);
  assert.equal(guard.inspect({ url: LIVE_ORIGIN + '/api/auth/get-session', method: 'GET' }).allowed, false);
  assert.equal(guard.sessionGets, 9);
  assert.equal(guard.inspect({ url: LIVE_ORIGIN + '/assets/late.js', method: 'GET' }).allowed, false);
});

test('rehearsal HTTP and HMR are loopback-only; live WebSockets always fail', () => {
  const guard = createRequestGuard({ live: false });
  assert.equal(guard.inspect({ url: REHEARSAL_ORIGIN + '/@vite/client', method: 'GET' }).allowed, true);
  assert.equal(guard.inspect({ url: LIVE_ORIGIN, method: 'GET' }).allowed, false);
  assert.equal(guard.inspect({ url: REHEARSAL_ORIGIN, method: 'GET', redirected: true }).allowed, false);
  assert.equal(allowRehearsalSocket(false, 'ws://127.0.0.1:4343/?token=local'), true);
  for (const url of ['ws://127.0.0.1:4343/', 'wss://external.example/']) assert.equal(allowRehearsalSocket(true, url), false);
  for (const url of ['ws://localhost:4343/', 'ws://127.0.0.1:4344/', 'ws://127.0.0.1:4343/other', 'ws://user@127.0.0.1:4343/', 'wss://127.0.0.1:4343/']) assert.equal(allowRehearsalSocket(false, url), false);
});

test('every redirect status is rejected rather than retried/followed', () => {
  for (let status = 300; status < 400; status++) assert.equal(isRedirect(status), true);
  for (const status of [200, 204, 299, 400, 403, 500]) assert.equal(isRedirect(status), false);
});

test('HTTP relay never retries/follows redirects and disposes bodies after awaited use', async () => {
  for (const scenario of ['success', 'redirect', 'fetch-error', 'fulfill-error', 'dispose-error']) {
    const events = [];
    const response = {
      status: () => scenario === 'redirect' ? 302 : 200,
      async dispose() {
        events.push('dispose');
        if (scenario === 'dispose-error') throw new Error('dispose failed');
      },
    };
    const route = {
      async fetch(options) {
        assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        events.push('fetch');
        if (scenario === 'fetch-error') throw new Error('fetch failed');
        return response;
      },
      async fulfill(options) {
        assert.equal(options.response, response);
        await new Promise(resolve => setImmediate(resolve));
        events.push('fulfill');
        if (scenario === 'fulfill-error') throw new Error('fulfill failed');
      },
      async abort(reason) { events.push(`abort:${reason}`); },
    };
    await relayWithoutRedirects(route, {
      onRedirect: status => events.push(`redirect:${status}`),
      onFailure: error => events.push(`error:${error.message}`),
    });
    const expected = {
      success: ['fetch', 'fulfill', 'dispose'],
      redirect: ['fetch', 'redirect:302', 'abort:blockedbyclient', 'dispose'],
      'fetch-error': ['fetch', 'error:fetch failed', 'abort:failed'],
      'fulfill-error': ['fetch', 'fulfill', 'error:fulfill failed', 'abort:failed', 'dispose'],
      'dispose-error': ['fetch', 'fulfill', 'dispose', 'error:dispose failed'],
    };
    assert.deepEqual(events, expected[scenario], scenario);
  }
});

test('CLI fails on missing approval before attempting to load browser dependencies', () => {
  const script = fileURLToPath(new URL('../../scripts/guest-canary.mjs', import.meta.url));
  for (const args of [[], ['--live'], ['--rehearsal', LIVE_ORIGIN]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|browserType\.launch/);
  }
});
