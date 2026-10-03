// From a request URL (built the way the SDKs build it) and its requester to
// the decision and the exact bytes signed; plus the handshake, the display of
// message text, the config checks and telemetry. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { messageChallengeFor } from '../src/security/challenge.ts';
import { ConfigError, parsePolicy, parseRegistry } from '../src/security/config.ts';
import { revealHidden } from '../src/security/display.ts';
import { fromParentOrOpener, HELLO, HELLO_ACK, helloAck } from '../src/security/handshake.ts';
import { readPortalRequest } from '../src/security/params.ts';
import type { PortalPolicy } from '../src/security/policy.ts';
import { evaluateRequest } from '../src/security/request.ts';
import { resolveRequester, type RequesterInput } from '../src/security/requester.ts';
import { buildEvent } from '../src/security/telemetry.ts';

const SELF = 'https://portal.example';
const base: RequesterInput = { framed: false, hasOpener: false, ancestorOrigins: null, referrer: '', messageOrigins: [], redirectUrl: null, webview: false, selfOrigin: SELF };
const frame = (origin: string) => resolveRequester({ ...base, framed: true, ancestorOrigins: [origin] });
const policy = parsePolicy(JSON.parse(readFileSync(new URL('../config/portal-policy.json', import.meta.url), 'utf8')));
const enforce: PortalPolicy = { ...policy, stage: 'enforce', gates: { ...policy.gates, transaction: 'registered', approval: 'registered' } };
const registry = parseRegistry({ version: 1, apps: [{ id: 'acme', name: 'Acme', origins: ['https://app.acme.example'], redirects: ['acme://'] }] });

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const CRED = Buffer.from(randomBytes(16)).toString('base64');
const PROOF_TAG = Buffer.from('LazorKit ownership proof v1');
const proof = () => Buffer.concat([PROOF_TAG, randomBytes(32)]);

const signMessageUrl = (text: string, display = text) =>
  `?action=sign&message=${encodeURIComponent(b64url(messageChallengeFor(text)))}&credentialId=${encodeURIComponent(CRED)}&displayMessage=${encodeURIComponent(display)}`;
const signUrl = (challenge: Uint8Array, transaction = '') =>
  `?action=sign&message=${encodeURIComponent(b64url(challenge))}&transaction=${encodeURIComponent(transaction)}&credentialId=${encodeURIComponent(CRED)}`;

function evaluate(search: string, requester = frame('https://app.acme.example'), p: PortalPolicy = policy) {
  return evaluateRequest({ request: readPortalRequest(search), requester, registry, policy: p });
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

test('signMessage: shown with its text, and the passkey signs the 58-byte challenge, nothing else', () => {
  const e = evaluate(signMessageUrl('Sign in to Acme'));
  assert.equal(e.decision.outcome, 'show');
  assert.equal(e.subject?.kind, 'message');
  assert.deepEqual(Buffer.from(e.signBytes!), Buffer.from(messageChallengeFor('Sign in to Acme')));
  assert.deepEqual(Buffer.from(e.credential!), Buffer.from(CRED, 'base64'));
});

test('signMessage with text that is not the signed text is refused, and nothing is signed', () => {
  const e = evaluate(signMessageUrl('Sign in to Acme', 'Sign in to Acme '));
  assert.deepEqual(e.decision, { outcome: 'refuse', reason: 'display-text-mismatch' });
  assert.equal(e.signBytes, null);
});

test('32 raw bytes with message text are refused; without text they are an approval, gated by policy', () => {
  const raw = randomBytes(32);
  const withText = evaluate(`${signUrl(raw)}&displayMessage=${encodeURIComponent('Hello')}`);
  assert.deepEqual(withText.decision, { outcome: 'refuse', reason: 'payload-not-allowed' });
  const approval = evaluate(signUrl(raw), frame('https://stranger.example'));
  assert.equal(approval.subject?.kind, 'approval');
  assert.equal(approval.decision.outcome, 'show');
  assert.deepEqual(evaluate(signUrl(raw), frame('https://stranger.example'), enforce).decision, { outcome: 'refuse', reason: 'requires-registered-app' });
  assert.equal(evaluate(signUrl(raw), frame('https://app.acme.example'), enforce).decision.outcome, 'show');
});

test('a sign request that names no passkey is refused', () => {
  const e = evaluate(signMessageUrl('hi').replace(/&credentialId=[^&]*/, ''));
  assert.deepEqual(e.decision, { outcome: 'refuse', reason: 'credential-missing' });
  assert.equal(evaluate(signMessageUrl('hi').replace(/credentialId=[^&]*/, 'credentialId=%25%25')).decision.outcome, 'refuse');
});

test('connect: a proof is signed in the sign-in; no challenge, or 32 random bytes (older SDKs), sign in without one', () => {
  const p = proof();
  const withProof = evaluate(`?action=connect&challenge=${b64url(p)}`);
  assert.equal(withProof.subject?.kind, 'ownership');
  assert.deepEqual(Buffer.from(withProof.signBytes!), p);
  for (const search of ['?action=connect', `?action=connect&challenge=${b64url(randomBytes(32))}`, '?action=connect&challenge=%25%25']) {
    const e = evaluate(search);
    assert.equal(e.subject?.kind, 'sign-in', search);
    assert.equal(e.decision.outcome, 'show');
    assert.equal(e.signBytes, null, 'a random challenge is used, never the request bytes');
  }
  const strict: PortalPolicy = { ...policy, connectNonProofChallenge: 'refuse' };
  assert.deepEqual(evaluate(`?action=connect&challenge=${b64url(randomBytes(32))}`, undefined, strict).decision, { outcome: 'refuse', reason: 'connect-challenge-not-proof' });
  // A program challenge hash on connect is never signed.
  assert.equal(evaluate(`?action=connect&challenge=${b64url(randomBytes(32))}`).signBytes, null);
});

test('no known action: refused', () => {
  assert.deepEqual(evaluate('').decision, { outcome: 'refuse', reason: 'unknown-action' });
  assert.deepEqual(evaluate('?action=pay&message=AA').decision, { outcome: 'refuse', reason: 'unknown-action' });
});

test('the redirect parameter: redirect_url, then redirectUrl, then expo; rid only in its own format', () => {
  assert.equal(readPortalRequest('?redirect_url=a%3A%2F%2Fx&expo=b%3A%2F%2Fy').redirectUrl, 'a://x');
  assert.equal(readPortalRequest('?expo=b%3A%2F%2Fy').redirectParam, 'expo');
  assert.equal(readPortalRequest('?rid=abcdefgh12').rid, 'abcdefgh12');
  assert.equal(readPortalRequest('?rid=short').rid, null);
  assert.equal(readPortalRequest('?rid=a%20b%20c%20d%20e').rid, null);
});

// ─── Handshake ──────────────────────────────────────────────────────────────

test('messages count only from the parent (in a frame) or the opener (in a popup)', () => {
  const self = {};
  const parent = {};
  const opener = {};
  const other = {};
  const framed = { self, parent, opener: null };
  const popup = { self, parent: self, opener };
  assert.equal(fromParentOrOpener({ source: parent, origin: 'https://a.example', data: { type: 'SYNC_CREDENTIALS', credentials: ['secret'] } }, framed)?.from, 'parent');
  assert.deepEqual(fromParentOrOpener({ source: parent, origin: 'https://a.example', data: { type: 'SYNC_CREDENTIALS', credentials: ['secret'] } }, framed), {
    origin: 'https://a.example', from: 'parent', type: 'SYNC_CREDENTIALS', rid: null,
  });
  assert.equal(fromParentOrOpener({ source: other, origin: 'https://a.example', data: {} }, framed), null);
  assert.equal(fromParentOrOpener({ source: null, origin: 'https://a.example', data: {} }, framed), null);
  assert.equal(fromParentOrOpener({ source: opener, origin: 'https://a.example', data: 'x' }, popup)?.from, 'opener');
  assert.equal(fromParentOrOpener({ source: opener, origin: 'https://a.example', data: {} }, framed), null, 'in a frame only the parent counts');
});

test('hello: acknowledged to its sender, only for this request id', () => {
  const refs = { self: {}, parent: {}, opener: null };
  const hello = (rid: string, v = 1) => fromParentOrOpener({ source: refs.parent, origin: 'https://app.acme.example', data: { type: HELLO, v, rid } }, refs)!;
  assert.deepEqual(helloAck(hello('rid-12345678'), 'rid-12345678'), { message: { type: HELLO_ACK, rid: 'rid-12345678' }, targetOrigin: 'https://app.acme.example' });
  assert.equal(helloAck(hello('rid-12345678'), 'rid-other-000'), null);
  assert.equal(helloAck(hello('rid-12345678'), null), null);
  assert.equal(helloAck(hello('rid-12345678', 2), 'rid-12345678'), null);
});

// ─── Display ────────────────────────────────────────────────────────────────

test('invisible and direction-changing characters are shown as code points', () => {
  const { segments, hidden } = revealHidden('pay \u202Eevil\u202C to\u200Bbob\r\nok 🙂 👨‍👩‍👧 ❤️');
  assert.equal(hidden, 4);
  assert.deepEqual(segments.filter((s) => s.kind === 'hidden').map((s) => (s as { code: string }).code), ['U+202E', 'U+202C', 'U+200B', 'U+000D']);
  assert.ok(segments.some((s) => s.kind === 'text' && s.text.includes('👨‍👩‍👧 ❤️')), 'emoji sequences stay whole');
  assert.deepEqual(revealHidden('line 1\nline\t2'), { segments: [{ kind: 'text', text: 'line 1\nline\t2' }], hidden: 0 });
});

// ─── Config ─────────────────────────────────────────────────────────────────

test('the committed policy and registry pass their checks', () => {
  const registryJson = JSON.parse(readFileSync(new URL('../config/registry.json', import.meta.url), 'utf8'));
  assert.equal(parseRegistry(registryJson).version, 1);
  assert.equal(policy.stage, 'transition');
});

test('a registry with a loose origin, a dangerous redirect or a duplicate is refused', () => {
  const app = (fields: Record<string, unknown>) => ({ version: 1, apps: [{ id: 'acme', name: 'Acme', ...fields }] });
  for (const bad of [
    app({ origins: ['https://app.acme.example/'] }),
    app({ origins: ['http://app.acme.example'] }),
    app({ origins: ['https://*.acme.example'] }),
    app({ redirects: ['javascript:alert(1)'] }),
    app({ redirects: ['https://'] }),
    app({ redirects: ['https://app.acme.example/cb?x=1'] }),
    app({ redirects: ['http://app.acme.example/cb'] }),
    app({ programChallenges: 'yes' }),
    { version: 1, apps: [{ id: 'a', name: 'A', origins: ['https://x.example'] }, { id: 'b', name: 'B', origins: ['https://x.example'] }] },
    { version: 1, apps: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }] },
    { version: 1, apps: [{ id: 'Not A Slug', name: 'A' }] },
  ]) {
    assert.throws(() => parseRegistry(bad), ConfigError, JSON.stringify(bad));
  }
  assert.equal(parseRegistry(app({ origins: ['https://app.acme.example', 'http://localhost:5173'], redirects: ['acme://', 'https://app.acme.example/callback'], contact: 'x' })).apps[0].redirects?.length, 2);
});

test('a policy with an unknown value is refused', () => {
  const good = JSON.parse(readFileSync(new URL('../config/portal-policy.json', import.meta.url), 'utf8'));
  assert.throws(() => parsePolicy({ ...good, gates: { ...good.gates, approval: 'maybe' } }), ConfigError);
  assert.throws(() => parsePolicy({ ...good, framing: { mode: 'off', allowLoopback: true } }), ConfigError);
  assert.throws(() => parsePolicy({ ...good, version: 2 }), ConfigError);
});

// ─── Telemetry ──────────────────────────────────────────────────────────────

test('a telemetry event names the requester by origin and carries nothing that was signed', () => {
  const text = 'Sign in to Acme, nonce 9f2c';
  const search = `${signMessageUrl(text)}&redirect_url=${encodeURIComponent('acme://cb/path?token=SECRET')}`;
  const request = readPortalRequest(search);
  const requester = resolveRequester({ ...base, redirectUrl: request.redirectUrl });
  const redirect = { ok: true as const, url: new URL(request.redirectUrl!), registered: true, app: registry.apps[0] };
  const e = evaluateRequest({ request, requester, redirect, registry, policy });
  const event = buildEvent({ policy, event: 'result', action: 'sign', requester, redirect, subject: e.subject, decision: e.decision, outcome: 'approved', browser: 'chrome' });
  assert.equal(event.requester, 'acme://');
  assert.equal(event.app, 'acme');
  const json = JSON.stringify(event);
  const challenge = b64url(messageChallengeFor(text));
  for (const secret of [text, 'nonce', challenge, Buffer.from(messageChallengeFor(text)).toString('base64'), CRED, 'SECRET', '/path', 'cb']) {
    assert.ok(!json.includes(secret), secret);
  }
  assert.deepEqual(Object.keys(event).sort(), [
    'action', 'app', 'browser', 'channel', 'cluster', 'clusterSource', 'embedded', 'event', 'evidence', 'kind', 'outcome', 'reason', 'registered', 'requester', 'stage', 'v', 'warnings',
  ]);
});
