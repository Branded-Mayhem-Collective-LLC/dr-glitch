import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export function validateTelemetryApproval(input, releaseSha) {
  assert.equal(input?.telemetryValidationAuthorized, true, 'Separate live Sentry validation approval is required.');
  assert.equal(input.releaseSha, releaseSha, 'Telemetry approval must name the deployed release.');
  const dsn = new URL(input.publicDsn);
  assert(dsn.protocol === 'https:' && /^o\d+\.ingest(?:\.[a-z]{2})?\.sentry\.io$/.test(dsn.hostname)
    && /^[a-f0-9]{32}$/.test(dsn.username) && !dsn.password && !dsn.port && !dsn.search && !dsn.hash
    && /^\/\d+$/.test(dsn.pathname), 'Only the dedicated public Sentry DSN is accepted.');
  assert(['production', 'private-validation'].includes(input.environment));
  assert(Number.isInteger(input.maxEnvelopes) && input.maxEnvelopes >= 2 && input.maxEnvelopes <= 64);
  return { releaseSha, environment: input.environment, publicDsn: dsn.href,
    endpoint: `${dsn.origin}/api${dsn.pathname}/envelope/`, publicKey: dsn.username, maxEnvelopes: input.maxEnvelopes };
}

/** Only this exact project endpoint and its public protocol parameters. */
export function isTelemetryRequest({ url: value, method, redirected = false }, approval) {
  const url = new URL(value);
  return method === 'POST' && !redirected && !url.username && !url.password && !url.hash
    && `${url.origin}${url.pathname}` === approval.endpoint
    && url.searchParams.get('sentry_key') === approval.publicKey
    && url.searchParams.get('sentry_version') === '7'
    && [...url.searchParams.keys()].every(key => ['sentry_key', 'sentry_version', 'sentry_client'].includes(key))
    && [...new Set(url.searchParams.keys())].length === [...url.searchParams.keys()].length
    && (!url.searchParams.has('sentry_client') || /^sentry\.javascript\.[a-z]+\/\d+\.\d+\.\d+$/.test(url.searchParams.get('sentry_client')));
}

/** Reuse the production scrubbers, and reject payload fields they would drop. */
export function validateTelemetryEnvelope(body, approval, policy) {
  assert(typeof body === 'string' && Buffer.byteLength(body) <= 128 * 1024, 'Telemetry envelope exceeds its bound.');
  const lines = body.trimEnd().split('\n');
  assert.equal(lines.length, 3, 'Only one JSON error or transaction per envelope is permitted.');
  const header = JSON.parse(lines[0]);
  const item = JSON.parse(lines[1]);
  const payload = JSON.parse(lines[2]);
  assert(['event', 'transaction'].includes(item.type), 'Unexpected telemetry item type.');
  assert.equal(payload.release, approval.releaseSha, 'Telemetry release mismatch.');
  assert.equal(payload.environment, approval.environment, 'Telemetry environment mismatch.');
  assert(/^[a-f0-9]{32}$/.test(payload.event_id), 'Telemetry event ID is required.');
  assert(header.event_id === payload.event_id, 'Envelope event ID mismatch.');
  const safe = item.type === 'transaction' ? policy.scrubTransactionEvent(payload) : policy.scrubEvent(payload);
  const comparable = { ...payload };
  // SDK package metadata is added after beforeSend. It is not forwarded.
  delete comparable.sdk;
  assert(isDeepStrictEqual(comparable, safe), 'Telemetry envelope violates the application payload allowlist.');
  if (item.type === 'transaction') assert(policy.APP_OPERATIONS.has(safe.transaction));
  else assert(safe.exception?.values?.length > 0 && safe.tags?.error_code, 'An application error with a stable code is required.');
  return { body: `${JSON.stringify({ event_id: safe.event_id })}\n${JSON.stringify({ type: item.type })}\n${JSON.stringify(safe)}`,
    eventId: safe.event_id, type: item.type, operation: safe.transaction ?? safe.tags.error_code };
}
