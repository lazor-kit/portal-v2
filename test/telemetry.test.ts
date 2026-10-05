// The telemetry route keeps the listed fields only, from the portal origin
// only. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelemetry } from '../api/telemetry.ts';

test('telemetry keeps the listed fields only, from the portal origin only', async () => {
  const lines: Record<string, unknown>[] = [];
  const deps = { env: { PORTAL_ORIGIN: 'https://portal.example' }, log: (l: Record<string, unknown>) => lines.push(l) };
  const event = {
    v: 1, stage: 'transition', event: 'result', action: 'sign', channel: 'iframe', evidence: 'ancestor-origins',
    requester: 'https://app.example', registered: false, app: null, kind: 'message', outcome: 'approved', reason: null,
    warnings: ['unregistered-requester'], cluster: null, clusterSource: null, browser: 'chrome', embedded: false, visibility: 'untracked',
    // Fields a page must never send; dropped if one does.
    challenge: 'SECRET', credentialId: 'SECRET', displayMessage: 'SECRET',
  };
  const post = (body: unknown, origin = 'https://portal.example') =>
    handleTelemetry(new Request('https://portal.example/api/telemetry', { method: 'POST', headers: { origin }, body: JSON.stringify(body) }), deps);
  assert.equal((await post(event)).status, 204);
  assert.equal((await post(event, 'https://elsewhere.example')).status, 403);
  assert.equal((await post({ ...event, requester: 'https://app.example/path?q=SECRET' })).status, 204);
  assert.equal((await post({ v: 2 })).status, 400);
  assert.equal(lines.length, 2);
  assert.ok(!JSON.stringify(lines).includes('SECRET'));
  assert.equal(lines[1].requester, null, 'a requester with a path is dropped');
  assert.equal(lines[0].requester, 'https://app.example');
  assert.equal(lines[0].visibility, 'untracked');
  assert.equal((await post({ ...event, visibility: 'SECRET' })).status, 204);
  assert.equal(lines[2].visibility, null);
});

test('telemetry from a page of the domain serving the route is accepted (a staging domain)', async () => {
  const lines: Record<string, unknown>[] = [];
  const staging = 'https://portal-staging.lazor.example';
  const post = (origin: string) =>
    handleTelemetry(new Request(`${staging}/api/telemetry`, { method: 'POST', headers: { origin }, body: JSON.stringify({ v: 1, event: 'request', outcome: 'shown' }) }), { env: {}, log: (l) => lines.push(l) });
  assert.equal((await post(staging)).status, 204);
  assert.equal((await post('https://elsewhere.example')).status, 403);
  assert.equal(lines.length, 1);
});
