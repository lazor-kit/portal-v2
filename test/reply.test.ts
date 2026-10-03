// Replies go only to the requesting origin, or to a checked destination,
// in the shapes the SDKs read. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, redirectUrlFor, routeFor, sendReply, type AssertionFields, type PortalResult, type ReplyWindow } from '../src/security/reply.ts';
import { checkRedirect } from '../src/security/redirect.ts';
import type { Registry } from '../src/security/registry.ts';
import { resolveRequester, type RequesterInput } from '../src/security/requester.ts';

const SELF = 'https://portal.example';
const base: RequesterInput = { framed: false, hasOpener: false, ancestorOrigins: null, referrer: '', messageOrigins: [], redirectUrl: null, webview: false, selfOrigin: SELF };
const registry: Registry = { version: 1, apps: [{ id: 'acme', name: 'Acme', origins: ['https://app.acme.example'], redirects: ['acme://'] }] };
const redirectPolicy = { unregisteredSchemes: 'deny', unregisteredWeb: 'deny', deniedSchemes: [] } as const;

const assertion: AssertionFields = { normalized: 'c2ln', msg: 'bXNn', clientDataJSONReturn: 'Y2Rq', authenticatorDataReturn: 'YWQ=' };
const signed: PortalResult = { type: 'signed', credentialId: 'Y3JlZA==', assertion, timestamp: 1 };
const connected: PortalResult = { type: 'connected', credentialId: 'Y3JlZA==', kind: 'asserted', assertion, timestamp: 2 };
const created: PortalResult = { type: 'connected', credentialId: 'Y3JlZA==', kind: 'created', publicKey: 'AkEy', accountName: 'Alice', timestamp: 3 };
const refused: PortalResult = { type: 'error', code: 'display-text-mismatch', message: 'Message does not match' };

/** A window whose parent and opener record what they are sent. */
function fakeWindow() {
  const posts: { to: 'parent' | 'opener'; message: unknown; targetOrigin: string }[] = [];
  const events: string[] = [];
  const win: ReplyWindow = {
    parent: { postMessage: (message, targetOrigin) => posts.push({ to: 'parent', message, targetOrigin }) },
    opener: { postMessage: (message, targetOrigin) => posts.push({ to: 'opener', message, targetOrigin }) },
    close: () => events.push('close'),
    navigate: (url) => events.push(`navigate ${url}`),
  };
  return { win, posts, events };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

test('iframe: posted to the parent, addressed to the requesting origin only', () => {
  const requester = resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://app.acme.example'] });
  const route = routeFor(requester);
  assert.deepEqual(route, { channel: 'iframe', origin: 'https://app.acme.example' });
  const { win, posts, events } = fakeWindow();
  assert.equal(sendReply(route, signed, win), 'posted');
  assert.deepEqual(posts.map((p) => [p.to, p.targetOrigin]), [['parent', 'https://app.acme.example']]);
  assert.deepEqual(events, []);
});

test('popup: posted to the opener, addressed to the requesting origin, then closed', () => {
  const route = routeFor(resolveRequester({ ...base, hasOpener: true, referrer: 'https://shop.example/checkout' }));
  const { win, posts, events } = fakeWindow();
  assert.equal(sendReply(route, connected, win), 'posted');
  assert.deepEqual(posts.map((p) => [p.to, p.targetOrigin]), [['opener', 'https://shop.example']]);
  assert.deepEqual(events, ['close']);
});

test('no origin, a conflict, or an unsupported channel: nothing is sent, never to "*"', () => {
  const cases = [
    resolveRequester({ ...base, hasOpener: true }),
    resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://a.example'], referrer: 'https://b.example/' }),
    resolveRequester({ ...base, framed: true, ancestorOrigins: ['https://a.example'], messageOrigins: ['null'] }),
    resolveRequester({ ...base, framed: true, redirectUrl: 'acme://cb' }),
    resolveRequester({ ...base, webview: true }),
    resolveRequester(base),
  ];
  for (const requester of cases) {
    const route = routeFor(requester);
    assert.deepEqual(route, { channel: 'none' });
    const { win, posts, events } = fakeWindow();
    assert.equal(sendReply(route, signed, win), 'dropped');
    assert.equal(posts.length + events.length, 0);
  }
  // A forged route is refused at send time too.
  const { win, posts } = fakeWindow();
  for (const origin of ['*', '/', 'https://a.example/path', 'http://a.example', 'null']) {
    assert.equal(sendReply({ channel: 'iframe', origin }, signed, win), 'dropped', origin);
  }
  assert.equal(posts.length, 0);
});

test('redirect: only to a destination the check allowed', () => {
  const ok = checkRedirect('acme://callback?state=1', { registry, policy: redirectPolicy, requesterOrigin: null });
  const requester = resolveRequester({ ...base, redirectUrl: 'acme://callback?state=1' });
  const route = routeFor(requester, ok);
  assert.equal(route.channel, 'redirect');
  const { win, events } = fakeWindow();
  assert.equal(sendReply(route, signed, win), 'redirected');
  assert.match(events[0], /^navigate acme:\/\/callback\?state=1&/);

  const refusedDestination = checkRedirect('evil://x', { registry, policy: redirectPolicy, requesterOrigin: null });
  assert.deepEqual(routeFor(resolveRequester({ ...base, redirectUrl: 'evil://x' }), refusedDestination), { channel: 'none' });
});

// ─── Shapes the web SDK reads (DialogManager 3.x) ───────────────────────────

test('postMessage payloads: WALLET_CONNECTED, SIGNATURE_CREATED and error', () => {
  assert.deepEqual(messageFor(signed), {
    type: 'SIGNATURE_CREATED',
    data: { credentialId: 'Y3JlZA==', timestamp: 1, normalized: 'c2ln', msg: 'bXNn', clientDataJSONReturn: 'Y2Rq', authenticatorDataReturn: 'YWQ=' },
  });
  const asserted = messageFor(connected) as { type: string; data: Record<string, unknown> };
  assert.equal(asserted.type, 'WALLET_CONNECTED');
  assert.equal(asserted.data.kind, 'asserted');
  assert.equal(asserted.data.connectionType, 'get');
  assert.equal(asserted.data.normalized, 'c2ln');
  assert.equal('publickey' in asserted.data, false, 'no key unless stored for this credential');
  const fresh = messageFor(created) as { data: Record<string, unknown> };
  assert.deepEqual(
    { kind: fresh.data.kind, connectionType: fresh.data.connectionType, publickey: fresh.data.publickey, publicKey: fresh.data.publicKey, accountName: fresh.data.accountName },
    { kind: 'created', connectionType: 'create', publickey: 'AkEy', publicKey: 'AkEy', accountName: 'Alice' },
  );
  assert.deepEqual(messageFor(refused), { type: 'error', error: { message: 'Message does not match', code: 'display-text-mismatch' } });
});

// ─── Query fields the mobile adapter reads (parseResult.ts, handleRedirect.ts) ─

test('redirect query: success, credentialId, signature, msg, clientDataJSONReturn, authenticatorDataReturn', () => {
  const sign = new URL(redirectUrlFor(new URL('myapp://callback?state=abc'), signed)).searchParams;
  assert.equal(sign.get('state'), 'abc');
  assert.equal(sign.get('success'), 'true');
  assert.equal(sign.get('credentialId'), 'Y3JlZA==');
  assert.equal(sign.get('signature'), 'c2ln');
  assert.equal(sign.get('msg'), 'bXNn');
  assert.equal(sign.get('clientDataJSONReturn'), 'Y2Rq');
  assert.equal(sign.get('authenticatorDataReturn'), 'YWQ=');

  const connect = new URL(redirectUrlFor(new URL('myapp://callback'), connected)).searchParams;
  assert.equal(connect.get('kind'), 'asserted');
  assert.equal(connect.get('signature'), 'c2ln');
  assert.equal(connect.get('publicKey'), null);
  const create = new URL(redirectUrlFor(new URL('myapp://callback'), created)).searchParams;
  assert.equal(create.get('publicKey'), 'AkEy');
  assert.equal(create.get('signature'), null);

  const error = new URL(redirectUrlFor(new URL('myapp://callback'), refused)).searchParams;
  assert.equal(error.get('success'), null);
  assert.equal(error.get('error'), 'Message does not match');
  assert.equal(error.get('code'), 'display-text-mismatch');
});
