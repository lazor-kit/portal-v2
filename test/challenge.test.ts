// The portal signs only the recognised challenge formats. Vectors are the
// SDK's own (lazor-kit packages/react/test/sign-message.test.mjs and
// challenge-domains.test.mjs); request URLs are built the way
// @lazorkit/wallet 3.3.1-3.4.0 (DialogManager) and
// @lazorkit/wallet-mobile-adapter 2.3.1-2.4.0 build them.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { classifyChallenge, messageChallengeFor, type ChallengeRequest } from '../src/security/challenge.ts';
import { decodeBase64Strict } from '../src/security/encoding.ts';

const PORTAL = 'https://portal.example';
const MESSAGE_TAG = Buffer.from('LazorKit signed message v1', 'utf8');
const PROOF_TAG = Buffer.from('LazorKit ownership proof v1', 'utf8');
const sha256 = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const expectedMessageChallenge = (message: Uint8Array) => Buffer.concat([MESSAGE_TAG, sha256(MESSAGE_TAG, message)]);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const ownershipChallenge = () => Buffer.concat([PROOF_TAG, randomBytes(32)]);
/** The SDK's display text: the string, or bytes that decode as UTF-8 (TextDecoder defaults). */
const sdkDisplayText = (message: string | Uint8Array): string | undefined => {
  if (typeof message === 'string') return message;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(message);
  } catch {
    return undefined;
  }
};
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

/** The parameters the portal reads, from a request URL. */
function read(url: string): ChallengeRequest {
  const params = new URL(url).searchParams;
  const action = params.get('action');
  assert.ok(action === 'connect' || action === 'sign');
  return {
    action,
    challenge: action === 'connect' ? params.get('challenge') : params.get('message'),
    displayMessage: params.get('displayMessage'),
    transaction: params.get('transaction'),
  };
}

// DialogManager 3.4.0 openSignMessage
function webSignMessageUrl(message: string | Uint8Array) {
  const bytes = typeof message === 'string' ? utf8(message) : message;
  let url = `${PORTAL}?action=sign&message=${encodeURIComponent(b64url(expectedMessageChallenge(bytes)))}&credentialId=${encodeURIComponent('Y3JlZA==')}`;
  const display = sdkDisplayText(message);
  if (display !== undefined) url += `&displayMessage=${encodeURIComponent(display)}`;
  return url;
}
// DialogManager 3.4.0 openSign
function webSignUrl(challenge: Uint8Array, transaction: string, cluster?: string) {
  let url = `${PORTAL}?action=sign&message=${encodeURIComponent(b64url(challenge))}&transaction=${encodeURIComponent(transaction)}&credentialId=${encodeURIComponent('Y3JlZA==')}`;
  if (cluster) url += `&clusterSimulation=${cluster}`;
  return url;
}
// DialogManager 3.4.0 openConnect / mobile 2.4.0 connect
const webConnectUrl = (challenge?: Uint8Array) =>
  `${PORTAL}?action=connect${challenge ? `&challenge=${encodeURIComponent(b64url(challenge))}` : ''}`;
const mobileConnectUrl = (challenge: Uint8Array) =>
  `${PORTAL}/?action=connect&redirect_url=${encodeURIComponent('myapp://callback')}&challenge=${encodeURIComponent(b64url(challenge))}`;
// mobile 2.4.0 signMessage (string messages)
const mobileSignMessageUrl = (message: string) =>
  `${PORTAL}/?action=sign&message=${encodeURIComponent(b64url(expectedMessageChallenge(utf8(message))))}&displayMessage=${encodeURIComponent(message)}&credentialId=${encodeURIComponent('Y3JlZA==')}&redirect_url=${encodeURIComponent('myapp://callback')}`;

// ─── Fixed vectors ──────────────────────────────────────────────────────────

test('message challenge: the SDK vectors, recomputed from the display text', () => {
  const vectors: [string | Uint8Array, string][] = [
    ['hello', '4c617a6f724b6974207369676e6564206d657373616765207631f0a0cabfe4698ae1261c9e56c6fd10a3800e99ac443a2b499ecead9d79897a21'],
    [new Uint8Array(0), '4c617a6f724b6974207369676e6564206d65737361676520763100e05b0accc59e75916a1f60ee3e1d8686e4f317e55a300f385a752b04f9a695'],
    [new Uint8Array(32), '4c617a6f724b6974207369676e6564206d657373616765207631ad1549f2a749d2e4124c97601838c5bbe5badfcf958e40d7bfdcaddb167cc0d2'],
  ];
  for (const [message, hex] of vectors) {
    const text = sdkDisplayText(message);
    assert.notEqual(text, undefined);
    assert.equal(Buffer.from(messageChallengeFor(text as string)).toString('hex'), hex);
    const classified = classifyChallenge(read(webSignMessageUrl(message)));
    assert.equal(classified.kind, 'message');
    assert.equal(classified.kind === 'message' && classified.text, text);
    assert.equal(classified.kind === 'message' && Buffer.from(classified.challenge).toString('hex'), hex);
  }
});

test('message challenge: any text, through the URL, is shown as sent', () => {
  for (const text of ['héllo ✓', 'Sign in to app.test, nonce 42', 'a+b=c&d=e?#/%', 'line 1\nline 2', '日本語', '🙂']) {
    assert.deepEqual(Buffer.from(messageChallengeFor(text)), expectedMessageChallenge(utf8(text)));
    for (const url of [webSignMessageUrl(text), mobileSignMessageUrl(text)]) {
      const classified = classifyChallenge(read(url));
      assert.equal(classified.kind, 'message', url);
      assert.equal(classified.kind === 'message' && classified.text, text);
    }
  }
});

test('message challenge: text that does not produce the challenge is refused', () => {
  const request = read(webSignMessageUrl('hello'));
  assert.deepEqual(classifyChallenge({ ...request, displayMessage: 'hellO' }), { kind: 'refused', reason: 'display-text-mismatch' });
  assert.deepEqual(classifyChallenge({ ...request, displayMessage: 'hello ' }), { kind: 'refused', reason: 'display-text-mismatch' });
  assert.deepEqual(classifyChallenge({ ...request, displayMessage: '' }), { kind: 'refused', reason: 'display-text-mismatch' });
});

test('message challenge: bytes that are not UTF-8 arrive without text, and are shown as a fingerprint', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, ...randomBytes(28)]);
  const url = webSignMessageUrl(bytes);
  assert.equal(new URL(url).searchParams.has('displayMessage'), false);
  const classified = classifyChallenge(read(url));
  assert.equal(classified.kind, 'message-without-text');
  assert.equal(classified.kind === 'message-without-text' && classified.fingerprint, sha256(MESSAGE_TAG, bytes).toString('hex'));
});

test('message challenge: bytes with a UTF-8 byte-order mark are refused (the SDK sends the text without it)', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hi')]);
  assert.equal(sdkDisplayText(bytes), 'hi');
  assert.deepEqual(classifyChallenge(read(webSignMessageUrl(bytes))), { kind: 'refused', reason: 'display-text-mismatch' });
});

test('message challenge: never with a transaction preview', () => {
  const request = read(webSignMessageUrl('hello'));
  assert.deepEqual(classifyChallenge({ ...request, transaction: 'AQID' }), { kind: 'refused', reason: 'payload-not-allowed' });
});

// ─── Ownership proofs ───────────────────────────────────────────────────────

test('ownership proof: tag || 32 random bytes, on connect and on sign with no preview', () => {
  const challenge = ownershipChallenge();
  assert.equal(challenge.length, 59);
  for (const url of [webConnectUrl(challenge), mobileConnectUrl(challenge), webSignUrl(challenge, '')]) {
    const classified = classifyChallenge(read(url));
    assert.equal(classified.kind, 'ownership', url);
    assert.deepEqual(classified.kind === 'ownership' && Buffer.from(classified.challenge), challenge);
  }
});

test('ownership proof: never with a preview or text', () => {
  const challenge = ownershipChallenge();
  assert.deepEqual(classifyChallenge(read(webSignUrl(challenge, 'AQID'))), { kind: 'refused', reason: 'payload-not-allowed' });
  assert.deepEqual(classifyChallenge({ ...read(webSignUrl(challenge, '')), displayMessage: 'x' }), { kind: 'refused', reason: 'payload-not-allowed' });
});

test('connect: only an ownership proof is a challenge', () => {
  assert.deepEqual(classifyChallenge(read(webConnectUrl())), { kind: 'refused', reason: 'missing-challenge' });
  // 3.2.x and 3.3.0 send 32 random bytes; the connect screen signs in without them.
  assert.deepEqual(classifyChallenge(read(webConnectUrl(randomBytes(32)))), { kind: 'refused', reason: 'connect-challenge-not-proof' });
  assert.deepEqual(classifyChallenge(read(webConnectUrl(expectedMessageChallenge(utf8('x'))))), { kind: 'refused', reason: 'connect-challenge-not-proof' });
  const wrongTag = Buffer.concat([Buffer.from('LazorKit ownership proof v2', 'utf8'), randomBytes(32)]);
  assert.deepEqual(classifyChallenge(read(webConnectUrl(wrongTag))), { kind: 'refused', reason: 'connect-challenge-not-proof' });
});

// ─── 32-byte program challenges ─────────────────────────────────────────────

test('32-byte challenge: a transaction with its preview, an approval without one', () => {
  const challenge = randomBytes(32);
  const tx = read(webSignUrl(challenge, 'AQIDBA==', 'mainnet'));
  assert.equal(classifyChallenge(tx).kind, 'transaction');
  assert.equal(classifyChallenge(read(webSignUrl(challenge, ''))).kind, 'approval');
  assert.equal(classifyChallenge({ ...tx, transaction: null }).kind, 'approval');
  assert.deepEqual(classifyChallenge({ ...tx, displayMessage: 'Pay 1 SOL' }), { kind: 'refused', reason: 'payload-not-allowed' });
});

// ─── Everything else ────────────────────────────────────────────────────────

test('every other length, and the tagged lengths with another prefix, are refused', () => {
  for (let length = 0; length <= 100; length++) {
    const bytes = randomBytes(length);
    const classified = classifyChallenge({ action: 'sign', challenge: b64url(bytes), displayMessage: null, transaction: null });
    if (length === 32) assert.equal(classified.kind, 'approval');
    else if (length === 0) assert.deepEqual(classified, { kind: 'refused', reason: 'missing-challenge' });
    else assert.deepEqual(classified, { kind: 'refused', reason: 'unrecognised-format' }, `length ${length}`);
  }
});

test('3.2.x raw message signing is refused: the app bytes are not a recognised challenge', () => {
  // 3.2.x openSignMessage put the message itself in `message`.
  for (const raw of ['hello', 'Sign in to app.test', 'x'.repeat(58)]) {
    const url = `${PORTAL}?action=sign&message=${encodeURIComponent(b64(utf8(raw)))}&credentialId=Y3JlZA%3D%3D`;
    assert.equal(classifyChallenge(read(url)).kind, 'refused', raw);
  }
  // A 32-byte payload is a program challenge whoever sends it; the policy
  // gates it (see policy.test.ts).
  assert.equal(classifyChallenge(read(webSignUrl(randomBytes(32), ''))).kind, 'approval');
});

test('the challenge must be canonical base64 or base64url', () => {
  const challenge = ownershipChallenge();
  for (const ok of [b64url(challenge), b64(challenge), b64(challenge).replace(/=+$/, ''), b64url(challenge) + '=']) {
    assert.ok(decodeBase64Strict(ok), ok);
  }
  assert.deepEqual(decodeBase64Strict('aGVsbG8='), utf8('hello'));
  assert.deepEqual(decodeBase64Strict(''), new Uint8Array(0));
  for (const bad of ['aGVsbG9=', 'aGVs bG8=', 'aGVs+bG8_', 'a', 'aGVsbG8===', '%%%', 'aGVsbG8=aGVs']) {
    assert.equal(decodeBase64Strict(bad), null, bad);
  }
  assert.deepEqual(classifyChallenge({ action: 'sign', challenge: 'aGVsbG9=', displayMessage: null, transaction: null }), { kind: 'refused', reason: 'malformed-challenge' });
});
