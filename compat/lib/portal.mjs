/**
 * The portal, as the SDK under test meets it: each URL the SDK opens in its
 * frame goes through the portal's own request handling (src/security: the
 * request, the requester, the policy, the reply), the user approves what is
 * shown, and the reply is posted back from the portal's origin. Only the
 * screens and WebAuthn are stood in for: a P-256 key signs as a passkey does.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parsePolicy, parseRegistry } from '../../src/security/config.ts';
import { readPortalRequest } from '../../src/security/params.ts';
import { refusalText } from '../../src/security/refusal-text.ts';
import { messageFor, signInResult } from '../../src/security/reply.ts';
import { evaluateRequest } from '../../src/security/request.ts';
import { resolveRequester } from '../../src/security/requester.ts';
import { APP, PORTAL, RP_ID, popups, window } from './page.mjs';

const config = (file) => JSON.parse(readFileSync(new URL(`../../config/${file}`, import.meta.url), 'utf8'));
/** The committed policy and registry (the app is not registered). */
export const policy = parsePolicy(config('portal-policy.json'));
export const registry = parseRegistry(config('registry.json'));

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/** A passkey: its key pair and its compressed public key (base64, as the portal stores it). */
export function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const compressed = Buffer.concat([Buffer.from([2 + (y[31] & 1)]), x]);
  return { privateKey, compressed, publicKey: compressed.toString('base64'), credentialId: Buffer.from(`passkey ${x.toString('hex').slice(0, 8)}`).toString('base64') };
}

/** A WebAuthn assertion over `challenge` on the portal, in the fields the portal replies with. */
export function assertion(key, challenge) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challenge).toString('base64url'), origin: PORTAL, crossOrigin: false }));
  const authenticatorData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const signedPayload = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  const signature = sign('sha256', signedPayload, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  let s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
  if (s > P256_N / 2n) s = P256_N - s;
  return {
    normalized: Buffer.concat([signature.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]).toString('base64'),
    msg: signedPayload.toString('base64'),
    clientDataJSONReturn: clientDataJSON.toString('base64'),
    authenticatorDataReturn: authenticatorData.toString('base64'),
  };
}

/**
 * What the portal answers a URL with, the user approving whatever is shown:
 * the decision, then the sign-in (signing the request's ownership proof, if
 * any) or the signature over exactly the bytes the decision allows.
 * `stored` is what the portal kept for the passkey when it was created here;
 * `create` names a new passkey made on the connect screen instead.
 */
export function portalAnswer(src, { key, stored, create, channel = 'iframe' }) {
  const url = new URL(src);
  const request = readPortalRequest(url.search);
  // In a frame the browser reports the parent; in a popup, the opener's page
  // as the referrer (the SDK sets no referrer policy).
  const requester = resolveRequester({
    framed: channel === 'iframe',
    hasOpener: channel === 'popup',
    ancestorOrigins: channel === 'iframe' ? [APP] : null,
    referrer: `${APP}/`,
    messageOrigins: [],
    redirectUrl: request.redirectUrl,
    webview: false,
    selfOrigin: url.origin,
  });
  const evaluation = evaluateRequest({ request, requester, registry, policy });
  const shown = { action: request.action, subject: evaluation.subject?.kind ?? null, decision: evaluation.decision };
  if (evaluation.decision.outcome === 'refuse') {
    const { title, detail } = refusalText(evaluation.decision.reason);
    return { shown, message: messageFor({ type: 'error', code: evaluation.decision.reason, message: `${title}: ${detail}` }) };
  }
  if (request.action === 'connect' && create) {
    return { shown, message: messageFor({ type: 'connected', credentialId: key.credentialId, kind: 'created', publicKey: key.publicKey, accountName: create, timestamp: Date.now() }) };
  }
  if (request.action === 'connect') {
    const proof = evaluation.subject.kind === 'ownership' ? evaluation.subject.challenge : null;
    const result = signInResult({ credentialId: key.credentialId, assertion: proof ? assertion(key, proof) : undefined, stored, timestamp: Date.now() });
    return { shown, message: messageFor(result) };
  }
  return { shown, message: messageFor({ type: 'signed', credentialId: key.credentialId, assertion: assertion(key, evaluation.signBytes), timestamp: Date.now() }) };
}

/** Every portal frame or popup answered so far: one still closing is not answered twice. */
const answered = new WeakSet();

/**
 * Answers every portal frame the SDK opens. `answer(src)` makes the reply
 * (default: `portalAnswer` with `options`). Returns what was shown for each
 * request, in order, and a stop function.
 */
export function servePortal(options, answer = (src, channel) => portalAnswer(src, { ...options, channel })) {
  const shown = [];
  const reply = (target, src, channel, source) => {
    answered.add(target);
    const { shown: what, message } = answer(src, channel);
    shown.push({ ...what, channel, url: new URL(src) });
    window.dispatchEvent(new window.MessageEvent('message', { origin: PORTAL, source, data: message }));
  };
  const timer = setInterval(() => {
    // The newest portal frame: one still closing may share its id.
    const iframe = [...window.document.querySelectorAll('iframe#lazorkit-iframe')].at(-1);
    if (iframe?.src && !answered.has(iframe)) reply(iframe, iframe.src, 'iframe', iframe.contentWindow);
    const opened = popups.at(-1);
    if (opened && !answered.has(opened.popup) && !opened.popup.closed) reply(opened.popup, opened.url, 'popup', opened.popup);
  }, 5);
  return { shown, stop: () => clearInterval(timer) };
}
