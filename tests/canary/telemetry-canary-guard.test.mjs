import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { isTelemetryRequest, validateTelemetryApproval, validateTelemetryEnvelope } from '../../scripts/telemetry-canary-guard.mjs';
import { parseInvocation } from '../../scripts/guest-canary-guards.mjs';
const policy = await tsImport('../../src/telemetry/sentry.ts', import.meta.url);
const sha = 'a'.repeat(40);
const input = { releaseSha: sha, telemetryValidationAuthorized: true, publicDsn: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@o1.ingest.sentry.io/1', environment: 'production', maxEnvelopes: 16 };
const approved = validateTelemetryApproval(input, sha);
const request = { method: 'POST', url: approved.endpoint + '?sentry_version=7&sentry_key=' + approved.publicKey };

test('live telemetry is a separate explicit mode with exact project and release authority', () => {
  assert.equal(parseInvocation(['--live-telemetry', 'receipt.json']).liveTelemetry, true);
  for (const altered of [{ telemetryValidationAuthorized: false }, { releaseSha: 'b'.repeat(40) }, { publicDsn: 'https://example.com/1' }, { publicDsn: input.publicDsn + '?private=1' }, { maxEnvelopes: 65 }, { environment: 'anything' }]) {
    assert.throws(() => validateTelemetryApproval({ ...input, ...altered }, sha));
  }
  assert(isTelemetryRequest(request, approved));
  for (const altered of [{ method: 'GET' }, { redirected: true }, { url: request.url.replace('/1/', '/2/') }, { url: request.url + '&private=file-name' }, { url: request.url + '&sentry_key=duplicate' }]) assert(!isTelemetryRequest({ ...request, ...altered }, approved));
});

test('only the exact production scrubber output may leave the validation proxy', () => {
  const event = policy.scrubEvent({ event_id: 'b'.repeat(32), release: sha, environment: 'production', tags: { error_code: 'telemetry-validation' }, exception: { values: [{ value: 'private-filename.svg' }] } });
  const body = (payload, type = 'event') => [JSON.stringify({ event_id: event.event_id, trace: { private: 'discarded header' } }), JSON.stringify({ type }), JSON.stringify(payload)].join('\n');
  const result = validateTelemetryEnvelope(body(event), approved, policy);
  assert.equal(result.eventId, event.event_id);
  assert(!result.body.includes('private'));
  for (const altered of [{ user: { email: 'private@example.com' } }, { extra: { svg: '<svg/>' } }, { release: 'b'.repeat(40) }, { environment: 'other' }]) assert.throws(() => validateTelemetryEnvelope(body({ ...event, ...altered }), approved, policy));
  assert.throws(() => validateTelemetryEnvelope(body(event, 'replay_event'), approved, policy));
  assert.throws(() => validateTelemetryEnvelope('x'.repeat(128 * 1024 + 1), approved, policy));
});
