// Who the portal answers, where it redirects, and what it shows or refuses.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { classifyChallenge, messageChallengeFor } from '../src/security/challenge.ts';
import { decide, type PortalPolicy } from '../src/security/policy.ts';
import { ALWAYS_DENIED_SCHEMES, checkRedirect, destinationLabel, isAlwaysDeniedScheme, type RedirectPolicy } from '../src/security/redirect.ts';
import type { Registry } from '../src/security/registry.ts';
import { resolveRequester, type RequesterInput } from '../src/security/requester.ts';

const SELF = 'https://portal.example';
const base: RequesterInput = {
  framed: false,
  hasOpener: false,
  ancestorOrigins: null,
  referrer: '',
  messageOrigins: [],
  redirectUrl: null,
  webview: false,
  selfOrigin: SELF,
};

const registry: Registry = {
  version: 1,
  apps: [
    { id: 'acme', name: 'Acme', origins: ['https://app.acme.example'], redirects: ['acme://', 'https://app.acme.example/callback'] },
    { id: 'beta', name: 'Beta', origins: ['https://beta.example'], programChallenges: false },
  ],
};

const redirectPolicy: RedirectPolicy = { unregisteredSchemes: 'allow', unregisteredWeb: 'same-origin', deniedSchemes: [] };
const transition: PortalPolicy = {
  version: 1,
  stage: 'transition',
  gates: { messageWithoutText: 'allow', transaction: 'allow', approval: 'allow', webview: 'deny' },
  connectNonProofChallenge: 'ignore',
  redirects: redirectPolicy,
  framing: { mode: 'report', allowLoopback: true },
  contentPolicy: 'report',
};
const enforce: PortalPolicy = {
  ...transition,
  stage: 'enforce',
  gates: { messageWithoutText: 'allow', transaction: 'registered', approval: 'registered', webview: 'deny' },
  redirects: { unregisteredSchemes: 'deny', unregisteredWeb: 'deny', deniedSchemes: [] },
  framing: { mode: 'enforce', allowLoopback: true },
  contentPolicy: 'enforce',
};

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const message = classifyChallenge({ action: 'sign', challenge: b64url(messageChallengeFor('hi')), displayMessage: 'hi', transaction: null });
const approval = classifyChallenge({ action: 'sign', challenge: b64url(randomBytes(32)), displayMessage: null, transaction: '' });
const transaction = classifyChallenge({ action: 'sign', challenge: b64url(randomBytes(32)), displayMessage: null, transaction: 'AQID' });

// ─── Requester ──────────────────────────────────────────────────────────────

test('iframe: the parent origin from ancestorOrigins, the SDK message, or the referrer', () => {
  const viaAncestors = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://app.acme.example'] });
  assert.equal(viaAncestors.channel, 'iframe');
  assert.equal(viaAncestors.origin, 'https://app.acme.example');
  assert.equal(viaAncestors.evidence, 'ancestor-origins');

  const redacted = resolveRequester({ ...base, framed: true, ancestorOrigins: ['null'], messageOrigins: ['https://app.acme.example'] });
  assert.equal(redacted.origin, 'https://app.acme.example');
  assert.equal(redacted.evidence, 'message');

  const referrerOnly = resolveRequester({ ...base, framed: true, referrer: 'https://app.acme.example/page?x=1' });
  assert.equal(referrerOnly.origin, 'https://app.acme.example');
  assert.equal(referrerOnly.evidence, 'referrer');

  const nested = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://app.acme.example', 'https://other.example'] });
  assert.deepEqual(nested.embeddedIn, ['https://other.example']);
});

test('iframe: evidence that disagrees is a conflict, and nothing is shown', () => {
  const r = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://elsewhere.example'], referrer: 'https://app.acme.example/' });
  assert.equal(r.conflict, true);
  assert.deepEqual(decide({ challenge: message, requester: r, registry, policy: transition }), { outcome: 'refuse', reason: 'requester-conflict' });
});

test('iframe or popup with no origin evidence: refused, since no reply could be addressed', () => {
  const r = resolveRequester({ ...base, hasOpener: true });
  assert.equal(r.origin, null);
  assert.deepEqual(decide({ challenge: message, requester: r, registry, policy: transition }), { outcome: 'refuse', reason: 'requester-unknown' });
  const own = resolveRequester({ ...base, hasOpener: true, referrer: `${SELF}/#/` });
  assert.equal(own.origin, null);
});

test('origins are https, or http on loopback; nothing else names a requester', () => {
  for (const bad of ['http://app.example', 'null', 'file:///x', 'data:text/html,x', 'acme://x']) {
    assert.equal(resolveRequester({ ...base, framed: true, ancestorOrigins: [bad] }).origin, null, bad);
  }
  assert.equal(resolveRequester({ ...base, framed: true, ancestorOrigins: ['http://localhost:3000'] }).origin, 'http://localhost:3000');
});

test('redirect: top-level only; a referrer on it is reported', () => {
  assert.equal(resolveRequester({ ...base, framed: true, redirectUrl: 'acme://cb' }).unsupported, true);
  const fromWeb = resolveRequester({ ...base, redirectUrl: 'acme://cb', referrer: 'https://elsewhere.example/' });
  assert.equal(fromWeb.channel, 'redirect');
  assert.equal(fromWeb.openedFrom, 'https://elsewhere.example');
});

// ─── Redirects ──────────────────────────────────────────────────────────────

test('redirect: registered destinations, with path boundaries', () => {
  const ctx = { registry, policy: enforce.redirects, requesterOrigin: null };
  assert.equal(checkRedirect('acme://callback?x=1', ctx).ok, true);
  assert.equal(checkRedirect('https://app.acme.example/callback', ctx).ok, true);
  assert.equal(checkRedirect('https://app.acme.example/callback/done?x', ctx).ok, true);
  assert.deepEqual(checkRedirect('https://app.acme.example/callbackx', ctx), { ok: false, reason: 'unregistered-destination', destination: 'https://app.acme.example' });
  assert.deepEqual(checkRedirect('https://app.acme.example.elsewhere.example/callback', ctx), { ok: false, reason: 'unregistered-destination', destination: 'https://app.acme.example.elsewhere.example' });
  assert.deepEqual(checkRedirect('other://cb', ctx), { ok: false, reason: 'unregistered-destination', destination: 'other://' });
});

test('redirect: dangerous schemes, plain http and embedded credentials are always refused', () => {
  const ctx = { registry, policy: redirectPolicy, requesterOrigin: 'https://app.acme.example' };
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'blob:https://x/y', 'file:///etc/passwd', 'intent://x#Intent;end', 'JavaScript:alert(1)']) {
    const d = checkRedirect(url, ctx);
    assert.equal(!d.ok && d.reason, 'denied-scheme', url);
  }
  assert.deepEqual(checkRedirect('http://elsewhere.example/cb', ctx), { ok: false, reason: 'insecure-http', destination: 'http://elsewhere.example' });
  assert.deepEqual(checkRedirect('https://user:pw@app.acme.example/callback', ctx), { ok: false, reason: 'invalid-url', destination: 'https://app.acme.example' });
  assert.deepEqual(checkRedirect('not a url', ctx), { ok: false, reason: 'invalid-url', destination: null });
});

test('redirect: schemes that hand a URL to a browser are refused, registered or not, under every policy', () => {
  const handOff = [
    'x-safari-https://evil.example/cb',
    'x-safari-http://evil.example/cb',
    'googlechromes://evil.example/cb',
    'googlechrome://navigate?url=https://evil.example/cb',
    'firefox://open-url?url=https%3A%2F%2Fevil.example%2Fcb',
    'firefox-focus://open-url?url=https%3A%2F%2Fevil.example%2Fcb',
    'microsoft-edge-https://evil.example/cb',
    'opera-https://evil.example/cb',
    'brave://open-url?url=https://evil.example/cb',
    'duckduckgo://evil.example/cb',
    'android-app://com.android.chrome/https/evil.example/cb',
    'X-Safari-HTTPS://evil.example/cb',
    // Any scheme named like a browser's http(s) hand-off.
    'newbrowser-https://evil.example/cb',
    'mailto:someone@evil.example',
  ];
  const lenient: RedirectPolicy = { unregisteredSchemes: 'allow', unregisteredWeb: 'same-origin', deniedSchemes: [] };
  const withHandOff: Registry = { version: 1, apps: [{ id: 'x', name: 'X', redirects: ['x-safari-https://', 'googlechromes://'] }] };
  for (const url of handOff) {
    for (const reg of [registry, withHandOff]) {
      const d = checkRedirect(url, { registry: reg, policy: lenient, requesterOrigin: 'https://evil.example' });
      assert.equal(!d.ok && d.reason, 'denied-scheme', url);
      assert.ok(!d.ok && d.destination?.endsWith('://') && !d.destination.includes('evil'), 'named by scheme only');
    }
  }
  for (const scheme of ALWAYS_DENIED_SCHEMES) assert.ok(isAlwaysDeniedScheme(scheme), scheme);
  for (const ok of ['acme', 'newapp', 'com.example.app', 'exp', 'exp+myapp', 'https', 'http']) assert.ok(!isAlwaysDeniedScheme(ok), ok);
});

test('redirect: an app destination is shown in full (scheme, host and path), never as the bare scheme', () => {
  assert.equal(destinationLabel(new URL('newapp://evil.example/cb?signature=x#y')), 'newapp://evil.example/cb');
  assert.equal(destinationLabel(new URL('acme://')), 'acme://');
  assert.equal(destinationLabel(new URL('myapp:///callback')), 'myapp:///callback');
  assert.equal(destinationLabel(new URL('com.example.app:/oauth')), 'com.example.app:/oauth');
  assert.equal(destinationLabel(new URL('https://app.acme.example/callback?x=1')), 'https://app.acme.example');
  const requester = resolveRequester({ ...base, redirectUrl: 'newapp://evil.example/cb?x=1' });
  const redirect = checkRedirect('newapp://evil.example/cb?x=1', { registry, policy: redirectPolicy, requesterOrigin: null });
  const d = decide({ challenge: message, requester, redirect, registry, policy: transition });
  assert.equal(d.outcome === 'show' && d.requesterLabel, 'newapp://evil.example/cb');
});

test('redirect: interim rule allows https only to the requesting origin, and unregistered schemes as unregistered', () => {
  const ctx = { registry, policy: redirectPolicy, requesterOrigin: 'https://shop.example' };
  assert.equal(checkRedirect('https://shop.example/done', ctx).ok, true);
  assert.deepEqual(checkRedirect('https://elsewhere.example/collect', ctx), { ok: false, reason: 'unregistered-destination', destination: 'https://elsewhere.example' });
  const custom = checkRedirect('newapp://cb', ctx);
  assert.equal(custom.ok && custom.registered, false);
});

// ─── Decisions ──────────────────────────────────────────────────────────────

const acmeFrame = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://app.acme.example'] });
const strangerFrame = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://stranger.example'] });

test('messages and proofs are shown for any origin, unregistered ones with a warning', () => {
  const d = decide({ challenge: message, requester: strangerFrame, registry, policy: enforce });
  assert.equal(d.outcome, 'show');
  assert.ok(d.outcome === 'show' && d.warnings.includes('unregistered-requester'));
  assert.equal(d.outcome === 'show' && d.requesterLabel, 'https://stranger.example');
});

test('32-byte challenges: anyone in transition, registered apps only when enforced', () => {
  for (const challenge of [approval, transaction]) {
    assert.equal(decide({ challenge, requester: strangerFrame, registry, policy: transition }).outcome, 'show');
    assert.deepEqual(decide({ challenge, requester: strangerFrame, registry, policy: enforce }), { outcome: 'refuse', reason: 'requires-registered-app' });
    const ok = decide({ challenge, requester: acmeFrame, registry, policy: enforce });
    assert.equal(ok.outcome, 'show');
    assert.equal(ok.outcome === 'show' && ok.app?.id, 'acme');
  }
  const d = decide({ challenge: approval, requester: acmeFrame, registry, policy: enforce });
  assert.ok(d.outcome === 'show' && d.warnings.includes('content-not-shown'));
  const betaFrame = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://beta.example'] });
  assert.deepEqual(decide({ challenge: approval, requester: betaFrame, registry, policy: enforce }), { outcome: 'refuse', reason: 'kind-denied' });
});

test('redirect channel: the destination decides, and a refused one refuses the request', () => {
  const requester = resolveRequester({ ...base, redirectUrl: 'acme://cb' });
  const redirect = checkRedirect('acme://cb', { registry, policy: enforce.redirects, requesterOrigin: null });
  const d = decide({ challenge: approval, requester, redirect, registry, policy: enforce });
  assert.equal(d.outcome === 'show' && d.requesterLabel, 'acme://cb');
  const unknown = resolveRequester({ ...base, redirectUrl: 'https://elsewhere.example/c' });
  const refused = checkRedirect('https://elsewhere.example/c', { registry, policy: enforce.redirects, requesterOrigin: null });
  assert.deepEqual(decide({ challenge: message, requester: unknown, redirect: refused, registry, policy: enforce }), { outcome: 'refuse', reason: 'redirect-refused' });
});

test('webview channel is refused unless the policy opens it', () => {
  const r = resolveRequester({ ...base, webview: true });
  assert.deepEqual(decide({ challenge: message, requester: r, registry, policy: transition }), { outcome: 'refuse', reason: 'channel-unsupported' });
});

test('a refused challenge is refused whatever the requester', () => {
  const refused = classifyChallenge({ action: 'sign', challenge: b64url(randomBytes(40)), displayMessage: null, transaction: null });
  assert.deepEqual(decide({ challenge: refused, requester: acmeFrame, registry, policy: transition }), { outcome: 'refuse', reason: 'unrecognised-format' });
});
