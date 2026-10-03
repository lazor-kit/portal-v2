#!/usr/bin/env node
/**
 * End-to-end: the real @lazorkit/wallet DialogManager against a local build
 * of this portal, in Chromium with a virtual authenticator. No chain access:
 * the portal's RPC route talks to a fake RPC.
 *
 *   SDK_DIST=<lazor-kit>/packages/react pnpm e2e
 *
 * Needs a built SDK (SDK_DIST, or @lazorkit/wallet installed here), the
 * `playwright` package (resolvable from here, or PLAYWRIGHT_MODULE=<path>) and
 * its Chromium. Writes e2e/.out/results.json and screenshots.
 *
 * Origins: dApp A http://localhost:5174 (registered), dApp B
 * http://127.0.0.1:5175 (not registered), portal http://localhost:4173 (the
 * committed policy) and http://localhost:4174 (enforce settings).
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { buildAll, DAPP, OUT } from './build.mjs';
import { startDapp, startPortal, startRpc } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const PORTAL_T = 'http://localhost:4173';
const PORTAL_E = 'http://localhost:4174';
const DAPP_B = 'http://127.0.0.1:5175';
const FAKE_KEY = 'E2E-FAKE-KEY-0000';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SHOTS = join(OUT, 'screens');
mkdirSync(SHOTS, { recursive: true });

const t0 = Date.now();
// A scenario that fails early leaves its SDK call pending; closing its page then rejects it.
process.on('unhandledRejection', (error) => console.log('(pending call ended)', String(error?.message ?? error).split('\n')[0]));
const say = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64url = (b) => Buffer.from(b).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Servers ────────────────────────────────────────────────────────────────

const logs = [];
const rpcCalls = [];
let delayAssets = 0;
const built = await buildAll();
say(`built portal (transition, enforce) and dApp against @lazorkit/wallet ${built.sdkVersion}`);
const env = (origin) => ({
  PORTAL_ORIGIN: origin,
  RPC_DEVNET_URL: 'http://127.0.0.1:8899/devnet',
  RPC_MAINNET_URL: `http://127.0.0.1:8899/mainnet?api-key=${FAKE_KEY}`,
});
const servers = [
  await startRpc({ port: 8899, calls: rpcCalls }),
  await startPortal({ port: 4173, ...built.transition, apiDir: join(OUT, '../../api'), env: env(PORTAL_T), log: (l) => logs.push(l), delayAssetsMs: () => delayAssets }),
  await startPortal({ port: 4174, ...built.enforced, apiDir: join(OUT, '../../api'), env: env(PORTAL_E), log: (l) => logs.push(l) }),
  await startDapp({ port: 5174, host: 'localhost', dist: built.dapp }),
  await startDapp({ port: 5175, host: '127.0.0.1', dist: built.dapp }),
];

// ─── Browser ────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: process.env.HEADED ? false : true });
const pageErrors = [];
const rpcBodies = [];

async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

async function newPage({ url, userAgent, portalInit } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, ...(userAgent ? { userAgent } : {}) });
  if (portalInit) await context.addInitScript(portalInit);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  if (process.env.DEBUG) page.on('console', (m) => say(`[console ${m.type()}] ${m.text().slice(0, 300)}`));
  context.on('response', async (response) => {
    if (response.url().includes('/api/rpc')) rpcBodies.push(await response.text().catch(() => ''));
  });
  const auth = await authenticator(page);
  if (url) {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  }
  return { context, page, ...auth };
}

/** The portal frame the SDK dialog (or a raw frame) shows: the newest one. */
async function portalFrame(page, origin = PORTAL_T) {
  await page.waitForSelector(`iframe[src^="${origin}"], iframe#raw`, { timeout: 15_000 });
  const handles = await page.$$('dialog iframe, iframe#raw');
  const frame = await handles[handles.length - 1].contentFrame();
  await frame.waitForSelector('[data-testid=requester]', { timeout: 15_000 });
  // Chromium discards clicks on a cross-origin frame that has just moved
  // (the SDK dialog animates in); a person never clicks this fast anyway.
  await sleep(900);
  return frame;
}

/** No portal dialog or frame left on `page` (each action starts from a clean page). */
async function idle(page) {
  try {
    await page.waitForFunction(() => !document.querySelector('dialog, iframe#raw'), null, { timeout: 5000 });
  } catch {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  }
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
}

const results = [];
async function scenario(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY) && !name.startsWith('connect: create')) return;
  const started = Date.now();
  for (const tab of [A, B].filter(Boolean)) await idle(tab.page);
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    say(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    say(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

/** Verifies an assertion over `challenge` with the authenticator's key for `credentialId`. */
async function verifyAssertion(auth, { credentialId, signature, clientDataJson, authenticatorData }, challenge, portal = PORTAL_T) {
  const { credentials } = await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId });
  const credential = credentials.find((c) => Buffer.from(c.credentialId, 'base64').equals(Buffer.from(credentialId, 'base64')));
  check(credential, 'the reply names a credential the authenticator holds');
  const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(credential.privateKey, 'base64'), format: 'der', type: 'pkcs8' }));
  const client = JSON.parse(Buffer.from(clientDataJson, 'base64').toString('utf8'));
  check(client.type === 'webauthn.get', `clientData type ${client.type}`);
  check(client.challenge === b64url(challenge), 'clientData challenge is the expected challenge');
  check(client.origin === portal, `clientData origin ${client.origin}`);
  const data = Buffer.concat([Buffer.from(authenticatorData, 'base64'), sha256(Buffer.from(clientDataJson, 'base64'))]);
  check(verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64')), 'signature verifies with the passkey key');
  const jwk = publicKey.export({ format: 'jwk' });
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([Buffer.from([y[y.length - 1] & 1 ? 3 : 2]), Buffer.from(jwk.x, 'base64url')]).toString('base64');
}

const ownershipChallenge = () => Buffer.concat([Buffer.from('LazorKit ownership proof v1'), randomBytes(32)]);
const messageChallenge = (bytes) => {
  const tag = Buffer.from('LazorKit signed message v1');
  return Buffer.concat([tag, sha256(Buffer.concat([tag, bytes]))]);
};

function previewTransaction() {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

let B = null;
const A = await newPage({ url: `${DAPP}/` });
let credentialId = null;
let publicKey = null;

await scenario('connect: create a passkey (proof requested), reply kind created with its key', async () => {
  const proof = ownershipChallenge();
  const pending = A.page.evaluate((c) => window.lk.connect(c), b64url(proof));
  const frame = await portalFrame(A.page);
  check((await frame.textContent('[data-testid=requester-origin]')) === DAPP, 'requester shown is the dApp origin');
  check((await frame.textContent('[data-testid=requester-badge]')).includes('Registered: E2E dApp'), 'registered badge');
  await frame.fill('[data-testid=account-name]', 'E2E Alice');
  await shot(A.page, 'connect');
  await frame.click('[data-testid=create]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  check(result.value.kind === 'created' && result.value.isCreated && result.value.connectionType === 'create', 'kind created');
  check(Buffer.from(result.value.publicKey, 'base64').length === 33, 'a 33-byte compressed key');
  check(result.value.accountName === 'E2E Alice', 'the name given');
  credentialId = result.value.credentialId;
  publicKey = result.value.publicKey;
  const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authenticatorId });
  check(credentials.length === 1 && credentials[0].rpId === 'localhost', 'one resident passkey for rpId localhost');
  return { kind: result.value.kind };
});

await scenario('connect: sign in signs the ownership proof; key reported only for this credential', async () => {
  const proof = ownershipChallenge();
  const pending = A.page.evaluate((c) => window.lk.connect(c), b64url(proof));
  const frame = await portalFrame(A.page);
  await frame.click('[data-testid=sign-in]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  const v = result.value;
  check(v.kind === 'asserted' && v.connectionType === 'get', 'kind asserted');
  check(v.credentialId === credentialId, 'same credential');
  check(v.assertion, 'an assertion over the proof');
  const key = await verifyAssertion(A, { credentialId: v.credentialId, signature: v.assertion.signature, clientDataJson: v.assertion.clientDataJsonBase64, authenticatorData: v.assertion.authenticatorDataBase64 }, proof);
  check(key === publicKey && v.publicKey === publicKey, 'the stored key is this passkey key');
  return { kind: v.kind, assertion: 'verified' };
});

await scenario('connect: 32 random bytes (3.2.x/3.3.0 proof) are not signed; sign-in uses its own challenge', async () => {
  const pending = A.page.evaluate((c) => window.lk.connect(c), b64url(randomBytes(32)));
  const frame = await portalFrame(A.page);
  await frame.click('[data-testid=sign-in]');
  const result = await pending;
  check(result.ok && result.value.kind === 'asserted' && !result.value.assertion, JSON.stringify(result));
});

await scenario('signMessage (UTF-8): text shown as sent; the SDK accepts the signature', async () => {
  const text = 'Sign in to E2E · héllo ✓ 🙂\nline 2';
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), [text, credentialId]);
  const frame = await portalFrame(A.page);
  const shown = await frame.textContent('[data-testid=message-text]');
  check(shown === text, `shown text ${JSON.stringify(shown)}`);
  // A script's click is not a user's.
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  await frame.evaluate(() => document.querySelector('[data-testid=approve]').click());
  await sleep(800);
  check(await frame.$('[data-testid=message-review]'), 'still on the review after a synthetic click');
  await shot(A.page, 'sign-message');
  await frame.click('[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, messageChallenge(Buffer.from(text, 'utf8')));
  return { signedPayload: !!result.value.signedPayload };
});

await scenario('signMessage (not UTF-8): fingerprint, explicit confirmation, then signed', async () => {
  const bytes = [0xff, 0xfe, 0x00, 0x80, ...randomBytes(12)];
  const pending = A.page.evaluate(([b, c]) => window.lk.signMessage(b, c), [bytes, credentialId]);
  const frame = await portalFrame(A.page);
  check((await frame.getAttribute('[data-testid=message-review]', 'data-kind')) === 'message-without-text', 'shown without text');
  const fingerprint = (await frame.textContent('[data-testid=fingerprint]')).replace(/\s/g, '');
  check(fingerprint === messageChallenge(Buffer.from(bytes)).subarray(26).toString('hex'), 'fingerprint is the message hash');
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  check(await frame.isDisabled('[data-testid=approve]'), 'Sign disabled until confirmed');
  await frame.check('[data-testid=confirm]');
  await frame.click('[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, messageChallenge(Buffer.from(bytes)));
});

await scenario('signMessage with direction overrides: shown as code points; Cancel rejects', async () => {
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), ['pay ‮evil‬ to bob', credentialId]);
  const frame = await portalFrame(A.page);
  const shown = await frame.textContent('[data-testid=message-text]');
  check(shown.includes('U+202E') && !shown.includes('‮'), 'override shown as a code point');
  await shot(A.page, 'sign-message-bidi');
  await frame.click('[data-testid=cancel]');
  const result = await pending;
  check(!result.ok && /User rejected/.test(result.message), JSON.stringify(result));
});

await scenario('transaction: preview simulated through /api/rpc on the network its blockhash names', async () => {
  const challenge = randomBytes(32);
  rpcCalls.length = 0;
  const pending = A.page.evaluate(([ch, tx, c]) => window.lk.sign(ch, tx, c, 'mainnet'), [b64url(challenge), previewTransaction(), credentialId]);
  const frame = await portalFrame(A.page);
  check((await frame.textContent('[data-testid=preview-source]')).includes(DAPP), 'preview attributed to the dApp');
  await frame.waitForSelector('[data-testid=network][data-cluster]');
  const cluster = await frame.getAttribute('[data-testid=network]', 'data-cluster');
  check(cluster === 'devnet', `simulated on ${cluster}: the blockhash is valid on devnet only`);
  check((await frame.textContent('[data-testid=transaction-review]')).includes('The app asked for mainnet'), 'mismatch noted');
  await shot(A.page, 'transaction');
  await frame.click('[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, challenge);
  const methods = rpcCalls.map((c) => `${c.cluster}:${c.method}`);
  check(methods.includes('devnet:simulateTransaction') && methods.includes('mainnet:isBlockhashValid'), methods.join(', '));
  return { rpc: methods };
});

await scenario('approval (32 bytes, no preview): fingerprint and confirmation; registered app in transition', async () => {
  const challenge = randomBytes(32);
  const pending = A.page.evaluate(([ch, c]) => window.lk.sign(ch, '', c), [b64url(challenge), credentialId]);
  const frame = await portalFrame(A.page);
  check((await frame.getAttribute('[data-testid=approval-review]', 'data-kind')) === 'approval', 'approval screen');
  check((await frame.textContent('[data-testid=fingerprint]')).replace(/\s/g, '') === challenge.toString('hex'), 'fingerprint');
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  check(await frame.isDisabled('[data-testid=approve]'), 'Approve off until confirmed');
  await frame.check('[data-testid=confirm]');
  await frame.click('[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
});

await scenario('gesture: an overlay on top of the dialog disables Approve until it is gone', async () => {
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), ['overlay test', credentialId]);
  const frame = await portalFrame(A.page);
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  await A.page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.setAttribute('popover', 'manual');
    cover.style.cssText = 'inset:0;width:100vw;height:100vh;margin:0;border:0;background:rgba(255,0,0,0.05);pointer-events:none';
    document.body.appendChild(cover);
    cover.showPopover();
  });
  await frame.waitForSelector('[data-testid=approve][data-guard=not-visible]', { timeout: 5000 });
  await shot(A.page, 'gesture-covered');
  await A.page.evaluate(() => document.getElementById('cover').remove());
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]', { timeout: 5000 });
  await frame.click('[data-testid=cancel]');
  const result = await pending;
  check(!result.ok, 'cancelled');
});

/** A raw request from dApp A: the refusal screen, then the error message after Close. */
async function refused(query, reason, { portal = PORTAL_T, page = A.page, expectReply = true } = {}) {
  const pending = page.evaluate(([q, wait]) => window.lk.raw(q, wait), [query, expectReply ? 20_000 : 6000]);
  const frame = await portalFrame(page, portal);
  await frame.waitForSelector('[data-testid=refusal]', { timeout: 10_000 });
  const shownReason = await frame.getAttribute('[data-testid=refusal]', 'data-reason');
  check(shownReason === reason, `refused for ${shownReason}, expected ${reason}`);
  await shot(page, `refused-${reason}`);
  await frame.click('[data-testid=close]');
  const reply = await pending;
  if (expectReply) {
    check(reply.data?.type === 'error' && reply.data.error?.code === reason, JSON.stringify(reply));
    check(reply.origin === portal, 'from the portal');
  } else {
    check(reply.timeout, `no reply expected, got ${JSON.stringify(reply)}`);
  }
  return reply;
}

const cred = () => encodeURIComponent(credentialId);

await scenario('refused: 32 raw bytes presented as a message (displayMessage)', async () => {
  await refused(`action=sign&message=${b64url(randomBytes(32))}&displayMessage=Hello&credentialId=${cred()}`, 'payload-not-allowed');
});

await scenario('refused: displayMessage that is not the signed text', async () => {
  await refused(`action=sign&message=${b64url(messageChallenge(Buffer.from('hello')))}&displayMessage=hellO&credentialId=${cred()}`, 'display-text-mismatch');
});

await scenario('refused: raw message bytes (3.2.x signMessage)', async () => {
  await refused(`action=sign&message=${Buffer.from('hello').toString('base64')}&credentialId=${cred()}`, 'unrecognised-format');
});

await scenario('refused: a frame whose referrer names another site than its parent (no reply)', async () => {
  const query = `action=sign&message=${b64url(messageChallenge(Buffer.from('hi')))}&displayMessage=hi&credentialId=${cred()}`;
  const pending = A.page.evaluate(([b, q]) => window.lk.bounced(b, q, 6000), [`${DAPP_B}/bounce`, query]);
  const frame = await portalFrame(A.page);
  await frame.waitForSelector('[data-testid=refusal][data-reason=requester-conflict]', { timeout: 10_000 });
  await frame.click('[data-testid=close]');
  const reply = await pending;
  check(reply.timeout, `nothing posted: ${JSON.stringify(reply)}`);
});

B = await newPage({ url: `${DAPP_B}/?portal=${encodeURIComponent(PORTAL_E)}` });

await scenario('enforce: an approval from an unregistered origin is refused, and the SDK gets the reason', async () => {
  const pending = B.page.evaluate(([ch, c]) => window.lk.sign(ch, '', c), [b64url(randomBytes(32)), credentialId]);
  const frame = await portalFrame(B.page, PORTAL_E);
  await frame.waitForSelector('[data-testid=refusal][data-reason=requires-registered-app]');
  check((await frame.textContent('[data-testid=requester-origin]')) === DAPP_B, 'requester shown');
  check((await frame.textContent('[data-testid=requester-badge]')).includes('Not registered'), 'not registered badge');
  await shot(B.page, 'enforce-unregistered');
  await frame.click('[data-testid=close]');
  const result = await pending;
  check(!result.ok && /App not registered/.test(result.message), JSON.stringify(result));
});

await scenario('enforce: the same approval from the registered origin is shown', async () => {
  await A.page.goto(`${DAPP}/?portal=${encodeURIComponent(PORTAL_E)}`);
  await A.page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  const pending = A.page.evaluate(([ch, c]) => window.lk.sign(ch, '', c), [b64url(randomBytes(32)), credentialId]);
  const frame = await portalFrame(A.page, PORTAL_E);
  await frame.waitForSelector('[data-testid=approval-review]');
  await frame.click('[data-testid=cancel]');
  check(!(await pending).ok, 'cancelled');
  await A.page.goto(`${DAPP}/`);
  await A.page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
});

await scenario('enforce: signMessage from an unregistered origin is still shown (messages are not gated)', async () => {
  const pending = B.page.evaluate(([t, c]) => window.lk.signMessage(t, c), ['hello from B', credentialId]);
  const frame = await portalFrame(B.page, PORTAL_E);
  await frame.waitForSelector('[data-testid=message-review]');
  await frame.click('[data-testid=cancel]');
  check(!(await pending).ok, 'cancelled');
});

await scenario('slow bundle, frame with no referrer: the parent message is recorded before the app loads, and agrees', async () => {
  const S = await newPage({
    url: `${DAPP}/`,
    // A frame with referrerpolicy=no-referrer has no referrer; Chromium still
    // reports ancestorOrigins, so the message is checked against it.
    portalInit: () => {
      if (location.port !== '5174') return;
      const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        get() { return src.get.call(this); },
        set(value) { this.referrerPolicy = 'no-referrer'; src.set.call(this, value); },
      });
    },
  });
  // The SDK reads its stored credentials from the dApp's storage for SYNC_CREDENTIALS.
  await S.page.evaluate(() => {
    localStorage.setItem('CREDENTIAL_ID', 'e2e');
    localStorage.setItem('PUBLIC_KEY', 'e2e');
  });
  delayAssets = 2500;
  try {
    const pending = S.page.evaluate((c) => window.lk.signMessage('slow load', c), credentialId);
    const frame = await portalFrame(S.page);
    const early = await frame.evaluate(() => window.__lkEarlyMessages);
    check(early.some((m) => m.type === 'SYNC_CREDENTIALS' && m.from === 'parent' && m.origin === 'http://localhost:5174'), JSON.stringify(early));
    check(early.every((m) => Object.keys(m).sort().join() === 'from,origin,rid,type'), 'only origin, type, rid kept');
    const [ancestors, referrer] = await frame.evaluate(() => [Array.from(location.ancestorOrigins ?? []), document.referrer]);
    check(referrer === '', 'no referrer');
    const evidence = await frame.getAttribute('[data-testid=requester]', 'data-evidence');
    check(evidence === (ancestors.length ? 'ancestor-origins' : 'message'), `evidence ${evidence}`);
    check((await frame.textContent('[data-testid=requester-origin]')) === DAPP, 'requester shown, no conflict');
    await frame.click('[data-testid=cancel]');
    await pending;
    return { early: early.map((m) => m.type), evidence, ancestorOriginsRedacted: ancestors[0] === 'null' };
  } finally {
    delayAssets = 0;
    await S.context.close();
  }
});

await scenario('popup (Safari): connect creates a passkey and replies to the opener only', async () => {
  const P = await newPage({ url: `${DAPP}/`, userAgent: SAFARI_UA });
  try {
    const popupPromise = P.context.waitForEvent('page');
    const pending = P.page.evaluate(() => window.lk.connect());
    const popup = await popupPromise;
    await authenticator(popup);
    await popup.waitForSelector('[data-testid=requester]');
    check((await popup.getAttribute('[data-testid=requester]', 'data-channel')) === 'popup', 'popup channel');
    check((await popup.textContent('[data-testid=requester-origin]')) === DAPP, 'requester from the referrer');
    await popup.fill('[data-testid=account-name]', 'Popup');
    await popup.click('[data-testid=create]');
    const result = await pending;
    check(result.ok && result.value.kind === 'created', JSON.stringify(result));
  } finally {
    await P.context.close();
  }
});

await scenario('popup from a no-referrer page: requester unknown, refused, nothing sent; telemetry says why', async () => {
  const P = await newPage({ url: `${DAPP}/?referrer=no-referrer`, userAgent: SAFARI_UA });
  try {
    const before = logs.length;
    const popupPromise = P.context.waitForEvent('page');
    const pending = P.page.evaluate((c) => window.lk.connect(c), b64url(ownershipChallenge()));
    const popup = await popupPromise;
    await popup.waitForSelector('[data-testid=waiting]');
    await popup.waitForSelector('[data-testid=refusal][data-reason=requester-unknown]', { timeout: 10_000 });
    await shot(popup, 'popup-no-referrer');
    await popup.click('[data-testid=close]');
    const result = await pending;
    check(!result.ok && result.name === 'PortalCancelledError', JSON.stringify(result));
    const events = logs.slice(before).filter((l) => l.route === 'telemetry');
    check(events.some((e) => e.channel === 'popup' && e.outcome === 'refused' && e.reason === 'requester-unknown'), JSON.stringify(events));
    return { telemetry: events.map((e) => `${e.event}:${e.outcome}:${e.reason}`) };
  } finally {
    await P.context.close();
  }
});

/** A top-level portal page (as the mobile adapter opens it), holding the same passkey. */
async function topLevel(query, portal = PORTAL_T) {
  const T = await newPage();
  const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authenticatorId });
  await T.cdp.send('WebAuthn.addCredential', { authenticatorId: T.authenticatorId, credential: credentials[0] });
  await T.page.goto(`${portal}/?${query}`);
  await T.page.waitForSelector('[data-testid=requester]');
  return T;
}

await scenario('redirect: signs and returns to the registered https callback with the assertion in the query', async () => {
  const text = 'mobile sign';
  const T = await topLevel(`action=sign&message=${b64url(messageChallenge(Buffer.from(text)))}&displayMessage=${encodeURIComponent(text)}&credentialId=${cred()}&redirect_url=${encodeURIComponent(`${DAPP}/callback?state=xyz`)}`);
  try {
    check((await T.page.textContent('[data-testid=requester-badge]')).includes('Registered'), 'registered destination');
    await T.page.click('[data-testid=approve]');
    await T.page.waitForURL(/\/callback\?/);
    const q = new URL(T.page.url()).searchParams;
    check(q.get('state') === 'xyz' && q.get('success') === 'true', 'callback query');
    await verifyAssertion(T, { credentialId: q.get('credentialId'), signature: q.get('signature'), clientDataJson: q.get('clientDataJSONReturn'), authenticatorData: q.get('authenticatorDataReturn') }, messageChallenge(Buffer.from(text)));
    check(q.get('msg'), 'msg present');
    return { fields: [...q.keys()] };
  } finally {
    await T.context.close();
  }
});

await scenario('redirect: an unregistered https destination is refused and not navigated to', async () => {
  const T = await topLevel(`action=sign&message=${b64url(messageChallenge(Buffer.from('x')))}&displayMessage=x&credentialId=${cred()}&redirect_url=${encodeURIComponent(`${DAPP_B}/callback`)}`);
  try {
    await T.page.waitForSelector('[data-testid=refusal][data-reason=redirect-refused]');
    await T.page.click('[data-testid=close]');
    await sleep(500);
    check(T.page.url().startsWith(PORTAL_T), 'stayed on the portal');
  } finally {
    await T.context.close();
  }
});

await scenario('redirect: an unregistered app scheme is shown as not registered in transition, refused in enforce', async () => {
  const query = `action=sign&message=${b64url(messageChallenge(Buffer.from('x')))}&displayMessage=x&credentialId=${cred()}&redirect_url=${encodeURIComponent('newapp://cb')}`;
  const T = await topLevel(query);
  try {
    check((await T.page.textContent('[data-testid=requester-origin]')) === 'newapp://', 'scheme shown');
    check((await T.page.textContent('[data-testid=requester-badge]')).includes('Not registered'), 'badge');
    await T.page.waitForSelector('[data-testid=message-review]');
  } finally {
    await T.context.close();
  }
  const E = await topLevel(query, PORTAL_E);
  try {
    await E.page.waitForSelector('[data-testid=refusal][data-reason=redirect-refused]');
  } finally {
    await E.context.close();
  }
});

await scenario('headers: frame-ancestors from the registry; report-only in transition, enforced in enforce', async () => {
  const t = await fetch(`${PORTAL_T}/`);
  const e = await fetch(`${PORTAL_E}/`);
  check(t.headers.get('content-security-policy')?.startsWith('frame-ancestors https:'), 'transition enforces https ancestors');
  check(t.headers.get('content-security-policy-report-only')?.includes(`frame-ancestors ${DAPP}`), 'transition reports others');
  check(e.headers.get('content-security-policy')?.startsWith(`frame-ancestors ${DAPP} `), 'enforce lists registered origins');
  check(!t.headers.has('x-frame-options') && !t.headers.has('cross-origin-opener-policy'), 'no XFO, no COOP');
  return { transition: t.headers.get('content-security-policy'), enforce: e.headers.get('content-security-policy') };
});

await scenario('no RPC key in the bundle or in any /api/rpc response; telemetry carries no signed data', async () => {
  for (const dir of [built.transition.dist, built.enforced.dist]) {
    for (const file of readdirSync(join(dir, 'assets'))) {
      const text = readFileSync(join(dir, 'assets', file), 'utf8');
      check(!text.includes(FAKE_KEY) && !/api-key=/.test(text) && !/helius/i.test(text), `${file} is clean`);
    }
  }
  check(rpcBodies.length > 0 && rpcBodies.every((b) => !b.includes(FAKE_KEY) && !b.includes('8899')), 'rpc responses are clean');
  const telemetry = logs.filter((l) => l.route === 'telemetry');
  const json = JSON.stringify(telemetry);
  check(telemetry.length > 0 && !json.includes(credentialId) && !json.includes('hello from B') && !json.includes('Sign in to E2E'), 'telemetry is clean');
  return { telemetryEvents: telemetry.length, rpcResponses: rpcBodies.length };
});

// ─── Report ─────────────────────────────────────────────────────────────────

await browser.close();
for (const server of servers) server.close();
const summary = {
  sdk: `@lazorkit/wallet ${built.sdkVersion}`,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
  pageErrors,
  telemetry: logs.filter((l) => l.route === 'telemetry').map(({ event, channel, evidence, kind, outcome, reason, registered }) => ({ event, channel, evidence, kind, outcome, reason, registered })),
};
writeFileSync(join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
say(`${summary.passed} passed, ${summary.failed} failed; ${join(OUT, 'results.json')}`);
process.exit(summary.failed ? 1 : 0);
