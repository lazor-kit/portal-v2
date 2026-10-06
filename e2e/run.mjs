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
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { inlineScriptHashes } from '../scripts/gen-headers.mjs';
import { buildAll, DAPP, DAPP_FEE_PAYER, OUT, PORTAL_E, PORTAL_T } from './build.mjs';
import { startDapp, startPortal, startRpc } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

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
  await startDapp({ port: 5174, host: 'localhost', dist: built.dapp, portals: [PORTAL_T, PORTAL_E] }),
  await startDapp({ port: 5175, host: '127.0.0.1', dist: built.dapp, portals: [PORTAL_T, PORTAL_E] }),
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

/** Console lines about the Content-Security-Policy, from any page or frame. */
const cspConsole = [];
function watchConsole(page) {
  page.on('console', (m) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) cspConsole.push(m.text().slice(0, 300));
    if (process.env.DEBUG) say(`[console ${m.type()}] ${m.text().slice(0, 300)}`);
  });
}

async function newPage({ url, userAgent, portalInit, viewport = { width: 1100, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, ...(userAgent ? { userAgent } : {}) });
  if (portalInit) await context.addInitScript(portalInit);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  watchConsole(page);
  context.on('page', watchConsole);
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

/**
 * A person's click on a guarded button (Approve, Sign, sign-in, create): the
 * pointer comes to rest on it, the button arms, then the click.
 */
async function press(target, selector) {
  // Forced: a button not yet armed is disabled, and takes no pointer events.
  await target.hover(selector, { force: true });
  await target.waitForSelector(`${selector}[data-guard=ready]`, { timeout: 10_000 });
  await target.click(selector);
}

/** A box of the page covered by the dApp's own content, which lets clicks through. */
async function cover(page, box, label = '') {
  await page.evaluate(([b, text]) => {
    const el = document.createElement('div');
    el.className = 'e2e-cover';
    el.textContent = text;
    el.style.cssText = `position:fixed;z-index:2147483647;margin:0;padding:8px;border:0;box-sizing:border-box;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;background:#111;color:#fff;font:12px monospace;pointer-events:none`;
    document.body.appendChild(el);
  }, [box, label]);
}
const uncover = (page) => page.evaluate(() => document.querySelectorAll('.e2e-cover').forEach((el) => el.remove()));

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

/** A preview sending 0.001 SOL to `to` (random unless given), paid for by `payer` (random unless given). */
function previewTransaction({ to = Keypair.generate().publicKey, payer = Keypair.generate().publicKey } = {}) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: to, lamports: 1_000_000 })],
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
  check((await frame.getAttribute('[data-testid=requester]', 'data-origin')) === DAPP, 'the full origin on the header');
  check((await frame.textContent('[data-testid=requester-name]')) === 'E2E dApp', 'registered name');
  check((await frame.textContent('[data-testid=requester-badge]')).includes('Verified site'), 'verified badge');
  check((await frame.textContent('[data-testid=hero]')) === 'Sign in to E2E dApp', 'sign-in hero');
  check((await frame.textContent('[data-testid=caption]')).includes('Passkey for localhost:4173'), 'the passkey caption names the portal');
  await shot(A.page, 'connect');
  await frame.click('[data-testid=to-create]');
  check((await frame.textContent('[data-testid=hero]')) === 'Create your passkey', 'create view');
  check((await frame.inputValue('[data-testid=account-name]')).startsWith('LazorKit · '), 'a default passkey name');
  await frame.click('[data-testid=details-toggle]');
  await frame.fill('[data-testid=account-name]', 'E2E Alice');
  await shot(A.page, 'connect-create');
  await press(frame, '[data-testid=create]');
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
  await press(frame, '[data-testid=sign-in]');
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

await scenario('connect: 32 random bytes (3.0.0-3.3.0 proof) are not signed; the reply claims no assertion, and carries the stored key', async () => {
  const pending = A.page.evaluate((c) => window.lk.connect(c), b64url(randomBytes(32)));
  const frame = await portalFrame(A.page);
  await press(frame, '[data-testid=sign-in]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  // No `kind`: SDKs before 3.3.1 then take the stored key for this credential
  // instead of asking for a second signature.
  check(result.value.kind === undefined && !result.value.assertion && result.value.connectionType === 'get', JSON.stringify(result.value));
  check(result.value.publicKey === publicKey, 'the key stored for this credential');
  return { kind: result.value.kind ?? null };
});

await scenario('signMessage (UTF-8): text shown as sent; the SDK accepts the signature', async () => {
  const text = 'Sign in to E2E · héllo ✓ 🙂\nline 2';
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), [text, credentialId]);
  const frame = await portalFrame(A.page);
  const shown = await frame.textContent('[data-testid=message-text]');
  check(shown === text, `shown text ${JSON.stringify(shown)}`);
  check(await frame.$('[data-testid=caption-explainer]'), 'the first approval on this browser explains the "Sign in" prompt');
  check(await frame.$('[data-testid=match-line]'), 'Details opens with the compare line');
  // A script's click is not a user's.
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  await frame.evaluate(() => document.querySelector('[data-testid=approve]').click());
  await sleep(800);
  check(await frame.$('[data-testid=message-review]'), 'still on the review after a synthetic click');
  await shot(A.page, 'sign-message');
  await press(frame, '[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, messageChallenge(Buffer.from(text, 'utf8')));
  return { signedPayload: !!result.value.signedPayload };
});

await scenario('signMessage (not UTF-8): a caution and the fingerprint in Details, then signed', async () => {
  const bytes = [0xff, 0xfe, 0x00, 0x80, ...randomBytes(12)];
  const pending = A.page.evaluate(([b, c]) => window.lk.signMessage(b, c), [bytes, credentialId]);
  const frame = await portalFrame(A.page);
  check((await frame.getAttribute('[data-testid=message-review]', 'data-kind')) === 'message-without-text', 'shown without text');
  const fingerprint = (await frame.textContent('[data-testid=fingerprint]')).replace(/\s/g, '');
  check(fingerprint === messageChallenge(Buffer.from(bytes)).subarray(26).toString('hex'), 'fingerprint is the message hash');
  check((await frame.textContent('[data-testid=caution]')).includes("can't be shown as text"), 'a caution, not a tick box');
  check(!(await frame.$('[data-testid=confirm]')), 'no tick box');
  check(await frame.$('[data-testid=caption]') && !(await frame.$('[data-testid=caption-explainer]')), 'the short passkey caption after the first approval');
  await press(frame, '[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, messageChallenge(Buffer.from(bytes)));
});

await scenario('signMessage with direction overrides: shown as labelled markers, with a caution; Cancel rejects', async () => {
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), ['pay ‮evil‬ to bob', credentialId]);
  const frame = await portalFrame(A.page);
  const shown = await frame.textContent('[data-testid=message-text]');
  check(!shown.includes('‮') && !shown.includes('‬'), 'no direction character is applied');
  const markers = await frame.$$eval('[data-testid=hidden-char]', (els) => els.map((el) => [el.getAttribute('data-code'), el.textContent]));
  check(JSON.stringify(markers.map((m) => m[0])) === JSON.stringify(['U+202E', 'U+202C']) && markers[0][1].includes('reversed text'), JSON.stringify(markers));
  check((await frame.textContent('[data-testid=caution]')).includes('Hidden characters change how this reads.'), 'caution');
  check((await frame.textContent('[data-testid=details]')).includes('U+202E (right-to-left override) at position 5'), 'code points in Details');
  await shot(A.page, 'sign-message-bidi');
  await frame.click('[data-testid=cancel]');
  const result = await pending;
  check(!result.ok && /User rejected/.test(result.message), JSON.stringify(result));
});

await scenario('transaction: preview simulated through /api/rpc on the network its blockhash names; shown as the app\'s claim', async () => {
  const challenge = randomBytes(32);
  const to = Keypair.generate().publicKey.toBase58();
  rpcCalls.length = 0;
  const pending = A.page.evaluate(([ch, tx, c]) => window.lk.sign(ch, tx, c, 'mainnet'), [b64url(challenge), previewTransaction({ to: new PublicKey(to), payer: new PublicKey(DAPP_FEE_PAYER) }), credentialId]);
  const frame = await portalFrame(A.page);
  check((await frame.textContent('[data-testid=preview-source]')).includes('E2E dApp says'), 'preview attributed to the dApp');
  await frame.waitForSelector('[data-testid=transaction-review][data-loading=false]');
  const cluster = await frame.getAttribute('[data-testid=network]', 'data-cluster');
  check(cluster === 'devnet', `simulated on ${cluster}: the blockhash is valid on devnet only`);
  check((await frame.textContent('[data-testid=transaction-review]')).includes('The app asked for mainnet'), 'mismatch noted');
  check((await frame.textContent('[data-testid=hero]')) === 'Send 0.001 SOL', 'hero from the preview');
  check((await frame.getAttribute('[data-testid=recipient]', 'data-address')) === to, 'recipient chip holds the whole address');
  check(await frame.$('[data-testid=test-chip]'), 'a devnet blockhash: not real money');
  check(!(await frame.$('[data-testid=match-line]')), 'no compare line on an app preview');
  check((await frame.textContent('[data-testid=preview-notice]')).includes("Preview from E2E dApp. LazorKit can't yet confirm it matches what you sign."), 'Details says whose preview it is');
  check((await frame.textContent('[data-testid=fee]')) .includes('Paid by E2E dApp'), 'a fee payer registered to the app');
  // The whole address, with Copy; Escape closes the sheet, not the request.
  await frame.click('[data-testid=recipient]');
  const full = (await frame.textContent('[data-testid=full-address] [aria-hidden=true]')).replace(/\s/g, '');
  check(full === to, `full address ${full}`);
  await frame.click('[data-testid=copy-address]');
  await frame.waitForSelector('[data-testid=copy-status]:has-text("Address copied")', { timeout: 3000 });
  await shot(A.page, 'address-sheet');
  await frame.press('[data-testid=address-done]', 'Escape');
  await frame.waitForSelector('[data-testid=address-sheet]', { state: 'detached' });
  check(await frame.$('[data-testid=transaction-review]'), 'still on the request');
  await shot(A.page, 'transaction');
  await press(frame, '[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
  await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, challenge);
  const methods = rpcCalls.map((c) => `${c.cluster}:${c.method}`);
  check(methods.includes('devnet:simulateTransaction') && methods.includes('mainnet:isBlockhashValid'), methods.join(', '));
  return { rpc: methods };
});

await scenario('approval (32 bytes, no preview) from a verified site: a caution, Cancel recommended, no tick box', async () => {
  const challenge = randomBytes(32);
  const pending = A.page.evaluate(([ch, c]) => window.lk.sign(ch, '', c), [b64url(challenge), credentialId]);
  const frame = await portalFrame(A.page);
  check((await frame.getAttribute('[data-testid=approval-review]', 'data-kind')) === 'approval', 'approval screen');
  check((await frame.getAttribute('[data-testid=approval-review]', 'data-tier')) === 'caution', 'caution');
  check((await frame.textContent('[data-testid=fingerprint]')).replace(/\s/g, '') === challenge.toString('hex'), 'fingerprint');
  check(!(await frame.$('[data-testid=confirm]')), 'no tick box');
  check((await frame.textContent('[data-testid=approve]')).includes('Approve anyway'), 'approve is the plain button');
  const [approveX, cancelX] = await Promise.all(['approve', 'cancel'].map((id) => frame.$eval(`[data-testid=${id}]`, (el) => el.getBoundingClientRect().x)));
  check(cancelX > approveX, 'Cancel, the recommended button, on the right');
  await shot(A.page, 'legacy-change');
  await press(frame, '[data-testid=approve]');
  const result = await pending;
  check(result.ok, JSON.stringify(result));
});

await scenario('approval (32 bytes, no preview) from a site that is not verified: danger, then a confirmation step with a box; Cancel stays recommended', async () => {
  const X = await newPage({ url: `${DAPP_B}/` });
  try {
    const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authenticatorId });
    await X.cdp.send('WebAuthn.addCredential', { authenticatorId: X.authenticatorId, credential: credentials[0] });
    const challenge = randomBytes(32);
    const pending = X.page.evaluate(([ch, c]) => window.lk.sign(ch, '', c), [b64url(challenge), credentialId]);
    const frame = await portalFrame(X.page);
    check((await frame.getAttribute('[data-testid=approval-review]', 'data-tier')) === 'danger', 'danger');
    check((await frame.textContent('[data-testid=danger]')).includes('up to full control of your account'), 'danger block');
    check(!(await frame.$('[data-testid=approve]')), 'nothing to approve before the confirmation step');
    await shot(X.page, 'legacy-change-danger');
    await frame.click('[data-testid=approve-anyway]');
    await frame.waitForSelector('[data-testid=ack-step]');
    await sleep(800);
    check(await frame.isDisabled('[data-testid=approve]'), 'Approve off until the box is ticked');
    await frame.check('[data-testid=confirm]');
    await frame.hover('[data-testid=approve]', { force: true });
    await sleep(900);
    check((await frame.getAttribute('[data-testid=approve]', 'data-guard')) === 'arming', 'still arming 0.9 s after the tick (1.5 s here)');
    const [approveX, cancelX] = await Promise.all(['approve', 'cancel'].map((id) => frame.$eval(`[data-testid=${id}]`, (el) => el.getBoundingClientRect().x)));
    check(cancelX > approveX, 'Cancel stays the recommended button');
    await shot(X.page, 'legacy-change-ack');
    await press(frame, '[data-testid=approve]');
    const result = await pending;
    check(result.ok, JSON.stringify(result));
    await verifyAssertion(X, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, challenge);
  } finally {
    await X.context.close();
  }
});

await scenario('Escape is Cancel: the app gets a rejection', async () => {
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), ['escape test', credentialId]);
  const frame = await portalFrame(A.page);
  await frame.click('[data-testid=hero]');
  await A.page.keyboard.press('Escape');
  const result = await pending;
  check(!result.ok && /User rejected/.test(result.message), JSON.stringify(result));
});

await scenario('a passkey step that does not finish: nothing was approved; Try again shows the longer note, then signs', async () => {
  await A.cdp.send('WebAuthn.setUserVerified', { authenticatorId: A.authenticatorId, isUserVerified: false });
  try {
    const text = 'retry test';
    const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), [text, credentialId]);
    const frame = await portalFrame(A.page);
    check(await frame.$('[data-testid=caption]'), 'the short caption before');
    await press(frame, '[data-testid=approve]');
    await frame.waitForSelector('[data-testid=cancelled]', { timeout: 15_000 });
    check((await frame.textContent('[data-testid=cancelled]')).includes("The passkey step didn't finish, so nothing was signed."), 'nothing was signed');
    await shot(A.page, 'cancelled');
    await A.cdp.send('WebAuthn.setUserVerified', { authenticatorId: A.authenticatorId, isUserVerified: true });
    await frame.click('[data-testid=try-again]');
    await frame.waitForSelector('[data-testid=caption-explainer]');
    await press(frame, '[data-testid=approve]');
    const result = await pending;
    check(result.ok, JSON.stringify(result));
    await verifyAssertion(A, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, messageChallenge(Buffer.from(text)));
  } finally {
    await A.cdp.send('WebAuthn.setUserVerified', { authenticatorId: A.authenticatorId, isUserVerified: true });
  }
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

await scenario('gesture: covering only the requester and the message, buttons left clear, disables Approve (cross-site frame)', async () => {
  // A page of another site (127.0.0.1) than the portal (localhost) frames
  // it, so the portal runs in a process of its own as in production, and
  // draws its own fake requester and summary over the real ones.
  const X = await newPage({ url: `${DAPP_B}/` });
  try {
    const text = 'partial overlay test';
    const query = `action=sign&message=${b64url(messageChallenge(Buffer.from(text)))}&displayMessage=${encodeURIComponent(text)}&credentialId=${encodeURIComponent(credentialId)}`;
    const pending = X.page.evaluate(([q]) => window.lk.raw(q, 20_000), [query]);
    const frame = await portalFrame(X.page);
    await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
    const iframe = await (await X.page.$('iframe#raw')).boundingBox();
    const buttonsTop = await frame.$eval('[data-testid=approve]', (b) => b.getBoundingClientRect().top);
    await cover(X.page, { x: iframe.x, y: iframe.y, width: iframe.width, height: Math.floor(buttonsTop - 8) }, 'Request from https://honest.example (Registered)');
    await frame.waitForSelector('[data-testid=approve][data-guard=not-visible]', { timeout: 5000 });
    check(await frame.isDisabled('[data-testid=approve]'), 'Approve off while the surface is covered');
    await shot(X.page, 'gesture-partial-cover');
    // A real click on the uncovered button does nothing.
    const box = await (await frame.$('[data-testid=approve]')).boundingBox();
    await X.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
    check(await frame.$('[data-testid=message-review]'), 'still on the review');
    await uncover(X.page);
    await frame.waitForSelector('[data-testid=approve][data-guard=ready]', { timeout: 5000 });
    await frame.click('[data-testid=cancel]');
    const reply = await pending;
    check(reply.data?.type === 'error' && reply.data.error?.code === 'user-rejected', JSON.stringify(reply));
  } finally {
    await X.context.close();
  }
});

await scenario('gesture: the mouse entering the frame starts the delay again; a click right after is ignored', async () => {
  const pending = A.page.evaluate(([t, c]) => window.lk.signMessage(t, c), ['entry test', credentialId]);
  const frame = await portalFrame(A.page);
  await A.page.mouse.move(5, 5);
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  const box = await (await frame.$('[data-testid=approve]')).boundingBox();
  // In from outside and straight onto Approve, as a frame moved under a resting pointer would be.
  await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 1 });
  await A.page.mouse.down();
  await A.page.mouse.up();
  await sleep(300);
  check(await frame.$('[data-testid=message-review]'), 'the click right after entering is ignored');
  // After resting on it, the same click signs.
  await frame.waitForSelector('[data-testid=approve][data-guard=ready]');
  await A.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const result = await pending;
  check(result.ok, JSON.stringify(result));
});

await scenario('layout: in a short window the request scrolls inside the frame; requester and buttons stay on screen, Approve works', async () => {
  const S = await newPage({ url: `${DAPP}/`, viewport: { width: 1100, height: 400 } });
  try {
    const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authenticatorId });
    await S.cdp.send('WebAuthn.addCredential', { authenticatorId: S.authenticatorId, credential: credentials[0] });
    const challenge = randomBytes(32);
    const pending = S.page.evaluate(([ch, tx, c]) => window.lk.sign(ch, tx, c, 'devnet'), [b64url(challenge), previewTransaction(), credentialId]);
    const frame = await portalFrame(S.page);
    await frame.waitForSelector('[data-testid=transaction-review][data-loading=false]');
    await frame.click('[data-testid=details-toggle]');
    const [scrollable, frameHeight] = await frame.$eval('[data-testid=review-content]', (el) => [el.scrollHeight > el.clientHeight + 4, window.innerHeight]);
    check(scrollable, `the request scrolls inside a ${frameHeight}px frame`);
    const inView = (selector) => frame.$eval(selector, (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
    check(await inView('[data-testid=requester]') && await inView('[data-testid=approve]'), 'requester bar and Approve on screen');
    await frame.$eval('[data-testid=review-content]', (el) => { el.scrollTop = el.scrollHeight; });
    check(await inView('[data-testid=requester]'), 'the requester bar stays while the request scrolls');
    await shot(S.page, 'short-window');
    await press(frame, '[data-testid=approve]');
    const result = await pending;
    check(result.ok, JSON.stringify(result));
    await verifyAssertion(S, { credentialId, signature: result.value.signature, clientDataJson: result.value.clientDataJsonBase64, authenticatorData: result.value.authenticatorDataBase64 }, challenge);
    return { frameHeight };
  } finally {
    await S.context.close();
  }
});

await scenario('layout: a frame too small for the request keeps Approve off when scrolled to it', async () => {
  const text = 'tiny frame';
  const query = `action=sign&message=${b64url(messageChallenge(Buffer.from(text)))}&displayMessage=${encodeURIComponent(text)}&credentialId=${encodeURIComponent(credentialId)}`;
  const pending = A.page.evaluate(([q]) => window.lk.raw(q, 15_000, 170), [query]);
  const frame = await portalFrame(A.page);
  await sleep(800);
  const approveBelow = await frame.$eval('[data-testid=approve]', (el) => el.getBoundingClientRect().top >= window.innerHeight);
  check(approveBelow, 'Approve starts below the frame');
  await frame.$eval('[data-testid=page]', (page) => { page.scrollTop = page.scrollHeight; });
  await frame.waitForSelector('[data-testid=approve][data-guard=not-visible]', { timeout: 5000 });
  await shot(A.page, 'tiny-frame');
  await frame.click('[data-testid=cancel]');
  const reply = await pending;
  check(reply.data?.type === 'error', JSON.stringify(reply));
});

await scenario('gesture: without visibility tracking (Safari, Firefox) a transaction needs an explicit confirmation; telemetry says so', async () => {
  const U = await newPage({
    url: `${DAPP}/`,
    // The portal frame on a browser without IntersectionObserver v2.
    portalInit: () => {
      if (location.port === '4173' && typeof IntersectionObserverEntry !== 'undefined') delete IntersectionObserverEntry.prototype.isVisible;
    },
  });
  try {
    const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authenticatorId });
    await U.cdp.send('WebAuthn.addCredential', { authenticatorId: U.authenticatorId, credential: credentials[0] });
    const before = logs.length;
    const challenge = randomBytes(32);
    const pending = U.page.evaluate(([ch, tx, c]) => window.lk.sign(ch, tx, c, 'devnet'), [b64url(challenge), previewTransaction(), credentialId]);
    const frame = await portalFrame(U.page);
    await frame.waitForSelector('[data-testid=confirm]');
    await sleep(800);
    check(await frame.isDisabled('[data-testid=approve]'), 'Approve off until confirmed');
    await frame.check('[data-testid=confirm]');
    await press(frame, '[data-testid=approve]');
    const result = await pending;
    check(result.ok, JSON.stringify(result));
    await sleep(500);
    const events = logs.slice(before).filter((l) => l.route === 'telemetry');
    check(events.length > 0 && events.every((e) => e.visibility === 'untracked'), JSON.stringify(events.map((e) => e.visibility)));
    return { visibility: 'untracked' };
  } finally {
    await U.context.close();
  }
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
  check((await frame.textContent('[data-testid=requester-badge]')).includes('Not verified'), 'not verified badge');
  check((await frame.textContent('[data-testid=refusal-sentence]')).includes('Your passkey signed nothing.'), 'says nothing was signed');
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
    await popup.click('[data-testid=to-create]');
    await popup.click('[data-testid=details-toggle]');
    await popup.fill('[data-testid=account-name]', 'Popup');
    await press(popup, '[data-testid=create]');
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
    check((await T.page.textContent('[data-testid=requester-badge]')).includes('Verified site'), 'registered destination');
    await press(T.page, '[data-testid=approve]');
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

await scenario('redirect: an unregistered app scheme is shown as an app on this phone in transition, refused in enforce', async () => {
  const query = `action=sign&message=${b64url(messageChallenge(Buffer.from('x')))}&displayMessage=x&credentialId=${cred()}&redirect_url=${encodeURIComponent('newapp://cb')}`;
  const T = await topLevel(query);
  try {
    check((await T.page.textContent('[data-testid=requester-origin]')) === 'newapp://cb', 'the destination shown in full');
    check((await T.page.textContent('[data-testid=requester-name]')) === 'An app on this phone', 'an app, never a verified one');
    check(!(await T.page.$('[data-testid=requester-badge]')), 'no badge for an app scheme');
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

await scenario('redirect: a browser hand-off scheme is refused in transition too, and Close goes nowhere', async () => {
  const destination = 'x-safari-https://evil.example/cb';
  const before = logs.length;
  const T = await topLevel(`action=sign&message=${b64url(randomBytes(32))}&credentialId=${cred()}&redirect_url=${encodeURIComponent(destination)}`);
  try {
    await T.page.waitForSelector('[data-testid=refusal][data-reason=redirect-refused]');
    await T.page.click('[data-testid=close]');
    await T.page.waitForSelector('[data-testid=closed]');
    check(T.page.url().startsWith(PORTAL_T), 'stayed on the portal');
    await sleep(500);
    const events = logs.slice(before).filter((l) => l.route === 'telemetry' && l.reason === 'redirect-refused');
    check(events.length > 0 && events.every((e) => e.requester === 'x-safari-https://'), JSON.stringify(events.map((e) => e.requester)));
    return { telemetry: events.map((e) => e.requester) };
  } finally {
    await T.context.close();
  }
});

await scenario('redirect: a refusal is not sent to an unregistered app destination', async () => {
  // Raw message bytes (refused) with an unregistered app scheme the transition policy would show.
  const T = await topLevel(`action=sign&message=${Buffer.from('hello').toString('base64')}&credentialId=${cred()}&redirect_url=${encodeURIComponent('newapp://cb')}`);
  try {
    await T.page.waitForSelector('[data-testid=refusal][data-reason=unrecognised-format]');
    const navigations = [];
    T.page.on('framenavigated', (f) => navigations.push(f.url()));
    await T.page.click('[data-testid=close]');
    await T.page.waitForSelector('[data-testid=closed]');
    await sleep(300);
    check(T.page.url().startsWith(PORTAL_T) && navigations.every((u) => u.startsWith(PORTAL_T)), JSON.stringify(navigations));
  } finally {
    await T.context.close();
  }
});

await scenario('headers: frame-ancestors from the registry and the content policy; report-only in transition, enforced in enforce', async () => {
  const t = await fetch(`${PORTAL_T}/`);
  const e = await fetch(`${PORTAL_E}/`);
  const tEnforced = t.headers.get('content-security-policy');
  const tReport = t.headers.get('content-security-policy-report-only');
  const eEnforced = e.headers.get('content-security-policy');
  check(tEnforced?.startsWith('frame-ancestors https:') && !tEnforced.includes('default-src'), 'transition enforces https ancestors only');
  check(tReport?.includes(`frame-ancestors ${DAPP}`) && tReport.includes("default-src 'self'") && tReport.includes("object-src 'none'"), 'transition reports other embedders and content');
  check(eEnforced?.startsWith(`frame-ancestors ${DAPP} `) && eEnforced.includes("default-src 'self'") && !e.headers.has('content-security-policy-report-only'), 'enforce lists registered origins and enforces content');
  // The served page's inline scripts, as Chromium's own parser reads them, are the ones the policy allows by hash.
  const html = await e.text();
  const parser = await browser.newContext();
  try {
    const page = await parser.newPage();
    const inline = await page.evaluate(
      (source) => [...new DOMParser().parseFromString(source, 'text/html').scripts].filter((s) => !s.hasAttribute('src')).map((s) => s.text),
      html,
    );
    const allowed = inline.map((text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`);
    check(inline.length === 1 && allowed.every((source) => eEnforced.includes(source)), 'inline recorder hash');
    check(JSON.stringify(inlineScriptHashes(html)) === JSON.stringify(allowed), 'gen-headers reads the inline scripts as Chromium does');
  } finally {
    await parser.close();
  }
  check(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'no third-party stylesheet');
  check(!t.headers.has('x-frame-options') && !t.headers.has('cross-origin-opener-policy'), 'no XFO, no COOP');
  return { transition: tEnforced, enforce: eEnforced.slice(0, 120) };
});

await scenario('content policy: nothing the pages loaded or ran was outside it (report-only and enforced builds)', async () => {
  const content = cspConsole.filter((line) => !/frame-ancestors/.test(line));
  check(content.length === 0, JSON.stringify(content.slice(0, 5)));
  const reports = logs.filter((l) => l.route === 'csp-report' && l.directive !== 'frame-ancestors');
  check(reports.length === 0, JSON.stringify(reports.slice(0, 5)));
  return { consoleLines: cspConsole.length };
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
