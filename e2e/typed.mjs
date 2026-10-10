#!/usr/bin/env node
/**
 * End to end for typed requests (CreateSession, RevokeSession,
 * RemoveAuthority) on a local validator: a wallet whose passkey lives in
 * Chromium's virtual authenticator, requests prepared with @lazorkit/sdk-legacy
 * and opened the way the SDK opens them (`?action=sign&message=…#/?lk1=…`),
 * the portal's screen read, Approve pressed, and the transaction finalized
 * with the slot and counter the portal signed and sent: it must land.
 *
 *   LAZORKIT_SO=<lazorkit-protocol build of #57, --features devnet>/lazorkit_program.so \
 *   LAZORKIT_INIT_AUTHORITY=<lazorkit-protocol>/keys/devnet-init-authority.json \
 *   TYPED_LEDGER=<an empty directory> PLAYWRIGHT_MODULE=<path to playwright> \
 *   pnpm e2e:typed
 *
 * The validator runs on non-default ports (RPC 38899, faucet 39900, gossip
 * 38001, dynamic 38002-38040; TYPED_PORT_BASE=N moves them to N+8899 and so
 * on) with its ledger in TYPED_LEDGER, is stopped by its PID and the ledger
 * deleted at the end. It never stops any other validator. The init authority is the
 * protocol repo's committed devnet test key (the devnet build accepts it to
 * initialize the protocol); nothing here holds value.
 *
 * Origins: portal http://localhost:4175 (devnet RPC = the validator), dApp
 * http://localhost:5176 (registered).
 */
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as ecSign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import sdk from '@lazorkit/sdk-legacy';
import { buildPortal, OUT, ROOT } from './build.mjs';
import { startPortal } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const { Actions, LazorKitClient, PROGRAM_ID_DEVNET, serializeActions, ROLE_SPENDER } = sdk;

const PROGRAM = PROGRAM_ID_DEVNET.toBase58();
const PORTAL = 'http://localhost:4175';
const DAPP = 'http://localhost:5176';
const BASE = Number(process.env.TYPED_PORT_BASE ?? 30000);
const RPC = `http://127.0.0.1:${BASE + 8899}`;
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SHOTS = join(OUT, 'screens-typed');
mkdirSync(SHOTS, { recursive: true });

for (const name of ['LAZORKIT_SO', 'LAZORKIT_INIT_AUTHORITY', 'TYPED_LEDGER']) {
  if (!process.env[name]) throw new Error(`${name} is required (see the header of e2e/typed.mjs)`);
}
const LEDGER = process.env.TYPED_LEDGER;
if (existsSync(LEDGER) && readdirSync(LEDGER).length) throw new Error(`${LEDGER} is not empty`);

const t0 = Date.now();
const say = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64url = (b) => Buffer.from(b).toString('base64url');
const b64 = (b) => Buffer.from(b).toString('base64');
function check(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Validator ──────────────────────────────────────────────────────────────

mkdirSync(LEDGER, { recursive: true });
const usdcFile = join(LEDGER, '..', `usdc-mint-${process.pid}.json`);
const mint = Buffer.alloc(82);
mint[44] = 6;
mint[45] = 1;
writeFileSync(usdcFile, JSON.stringify({ pubkey: DEVNET_USDC, account: { lamports: 1_461_600, data: [b64(mint), 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false, rentEpoch: 0, space: 82 } }));
const validator = spawn(
  'solana-test-validator',
  [
    '--ledger', LEDGER, '--reset', '--quiet',
    '--bind-address', '127.0.0.1', '--rpc-port', String(BASE + 8899), '--faucet-port', String(BASE + 9900), '--gossip-port', String(BASE + 8001),
    '--dynamic-port-range', `${BASE + 8002}-${BASE + 8040}`,
    '--upgradeable-program', PROGRAM, process.env.LAZORKIT_SO, Keypair.generate().publicKey.toBase58(),
    '--account', DEVNET_USDC, usdcFile,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
say(`validator pid ${validator.pid}`);
// Whatever happens, this run's validator (and only it) does not outlive the run.
process.on('exit', () => {
  if (validator.exitCode === null) validator.kill('SIGKILL');
});
// A scenario that fails early leaves its frame's promise pending; a reload then rejects it.
process.on('unhandledRejection', (error) => say('(pending call ended)', String(error?.message ?? error).split('\n')[0]));

let servers = [];
let browser = null;
async function shutdown() {
  for (const s of servers) await new Promise((r) => s.close(r));
  await browser?.close().catch(() => {});
  if (validator.exitCode === null) {
    validator.kill('SIGTERM');
    for (let i = 0; i < 50 && validator.exitCode === null; i++) await sleep(200);
    if (validator.exitCode === null) validator.kill('SIGKILL');
  }
  rmSync(LEDGER, { recursive: true, force: true });
  rmSync(usdcFile, { force: true });
  say(`validator stopped (pid ${validator.pid}), ledger deleted`);
}

const connection = new Connection(RPC, 'confirmed');
for (let i = 0; ; i++) {
  try {
    await connection.getSlot();
    break;
  } catch {
    if (i > 120 || validator.exitCode !== null) {
      await shutdown();
      throw new Error('validator did not start');
    }
    await sleep(500);
  }
}
say('validator up');

const results = [];
try {
  await main();
} catch (error) {
  results.push({ name: 'setup', ok: false, error: String(error?.stack ?? error) });
  say(`FAIL setup: ${error?.stack ?? error}`);
} finally {
  await shutdown();
}
writeFileSync(join(OUT, 'results-typed.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
say(`${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

async function main() {
  // ─── Chain setup ──────────────────────────────────────────────────────────
  const client = new LazorKitClient(connection, PROGRAM_ID_DEVNET);
  const payer = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  const send = async (instructions, signers = []) => {
    const tx = new Transaction();
    for (const ix of instructions) tx.add(ix);
    return sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: 'confirmed' });
  };

  const initAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.LAZORKIT_INIT_AUTHORITY, 'utf8'))));
  const admin = Keypair.generate();
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: initAuthority.publicKey, lamports: LAMPORTS_PER_SOL })]);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: admin.publicKey, lamports: LAMPORTS_PER_SOL })]);
  const init = client.initializeProtocol({ payer: initAuthority.publicKey, admin: admin.publicKey, treasury: Keypair.generate().publicKey, creationFee: 5000n, executionFee: 2000n, numShards: 1 });
  await sendAndConfirmTransaction(connection, new Transaction().add(...init.instructions), [initAuthority], { commitment: 'confirmed' });
  await send(client.initializeTreasuryShard({ payer: payer.publicKey, admin: admin.publicKey, shardId: 0 }).instructions, [admin]);
  say('protocol initialized');

  // The passkey: a P-256 key the virtual authenticator holds for rpId localhost.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const y = Buffer.from(jwk.y, 'base64url');
  const compressed = Buffer.concat([Buffer.from([y[y.length - 1] & 1 ? 3 : 2]), Buffer.from(jwk.x, 'base64url')]);
  const credentialId = randomBytes(16);
  const credentialIdHash = sha256(credentialId);
  const created = await client.createWallet({ payer: payer.publicKey, userSeed: randomBytes(32), owner: { type: 'secp256r1', credentialIdHash, compressedPubkey: compressed, rpId: 'localhost' } });
  await send(created.instructions);
  const wallet = created.walletPda;
  const authority = created.authorityPda;
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: created.vaultPda, lamports: 1_250_000_000 })]);
  say(`wallet ${wallet.toBase58()} with a passkey owner`);

  const secp = (slot) => ({ credentialIdHash, publicKeyBytes: compressed, ...(slot === undefined ? {} : { slotOverride: slot }) });
  const counterOf = async () => (await connection.getAccountInfo(authority, 'confirmed')).data.readUInt32LE(8);
  const currentSlot = async () => BigInt(await connection.getSlot('confirmed'));
  const clusterTime = async () => BigInt((await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'confirmed')).data.readBigInt64LE(32));

  /** The passkey signing in Node (for steps the user doesn't approve here: another tab, the app adding a key). */
  function softSign(challenge) {
    const authenticatorData = Buffer.concat([sha256('localhost'), Buffer.from([0x05, 0, 0, 0, 0])]);
    const clientDataJson = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: PORTAL, crossOrigin: false }));
    const clientDataJsonHash = sha256(clientDataJson);
    const der = ecSign('sha256', Buffer.concat([authenticatorData, clientDataJsonHash]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return { signature: lowS(der), authenticatorData, clientDataJsonHash, clientDataJson };
  }

  /** The envelope (DESIGN §2.1), written here from the prepare inputs, not by the portal's module. */
  function typedUrl({ kind, args, counter, preparedSlot, challenge, cluster = 'devnet', programId = PROGRAM }) {
    const json = {
      v: 1,
      kind,
      cluster,
      programId,
      wallet: wallet.toBase58(),
      authority: authority.toBase58(),
      credentialId: b64url(credentialId),
      payer: payer.publicKey.toBase58(),
      counter,
      preparedSlot: preparedSlot.toString(),
      args,
    };
    const query = new URLSearchParams({ action: 'sign', message: b64(challenge), transaction: '', credentialId: b64(credentialId) });
    return `${PORTAL}/?${query}#/?lk1=${b64url(Buffer.from(JSON.stringify(json)))}`;
  }

  async function prepareCreate({ actions, expiresIn = 3n * 3600n, slot }) {
    const sessionKey = Keypair.generate().publicKey;
    const expiresAt = (await clusterTime()) + expiresIn;
    const preparedSlot = slot ?? (await currentSlot());
    const counter = (await counterOf()) + 1;
    const prepared = await client.prepareCreateSession({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(preparedSlot), sessionKey, expiresAt, actions, unrestricted: actions.length === 0 });
    const args = { sessionKey: sessionKey.toBase58(), expiresAt: expiresAt.toString(), actions: b64url(actions.length ? serializeActions(actions) : new Uint8Array(0)) };
    return { prepared, sessionKey, expiresAt, url: typedUrl({ kind: 'createSession', args, counter, preparedSlot, challenge: prepared.challenge }), args, counter, preparedSlot };
  }

  /**
   * The SDK's side of a reply (DESIGN §2.3): the typed block names the kind and
   * the sysvar index; the challenge recomputed from the SDK's own inputs with
   * the portal's slot (and the chain's counter, which must be the portal's)
   * equals clientDataJSON's; then finalize with that slot and counter.
   */
  async function rebindAndSend(kind, reply, again, finalize) {
    check(reply && reply.data?.type === 'SIGNATURE_CREATED', `reply ${JSON.stringify(reply).slice(0, 300)}`);
    const d = reply.data.data;
    const typed = d.typed;
    check(typed && typed.v === 1 && typed.kind === kind, `typed ${JSON.stringify(typed)}`);
    check(typed.sysvarIxIndex === { createSession: 6, revokeSession: 5, removeAuthority: 5 }[kind], 'sysvar index');
    const clientDataJson = Buffer.from(d.clientDataJSONReturn, 'base64');
    const client = JSON.parse(clientDataJson.toString('utf8'));
    check(client.type === 'webauthn.get', 'webauthn.get');
    check((await counterOf()) + 1 === typed.counter, `chain counter ${await counterOf()} + 1 vs typed ${typed.counter}`);
    const prepared = await again(BigInt(typed.slot));
    check(client.challenge === b64url(prepared.challenge), 'the passkey signed the challenge recomputed with the portal slot');
    const authenticatorData = Buffer.from(d.authenticatorDataReturn, 'base64');
    const { instructions } = finalize(prepared, { signature: Buffer.from(d.normalized, 'base64'), authenticatorData, clientDataJsonHash: sha256(clientDataJson), clientDataJson });
    const sig = await send(instructions);
    return { typed, sig };
  }

  // ─── Portal, dApp, browser ────────────────────────────────────────────────

  const policy = JSON.parse(readFileSync(join(ROOT, 'config/portal-policy.json'), 'utf8'));
  const built = await buildPortal('typed', policy, {
    registry: { version: 1, apps: [{ id: 'e2e-typed', name: 'Typed dApp', origins: [DAPP] }] },
    programs: { devnet: { programId: PROGRAM, lastDeploySlot: 0, features: ['wallet-bound-challenge', 'd13', 'nonowner-invariants', 'time-expiry'] } },
  });
  const logs = [];
  servers.push(await startPortal({ port: 4175, ...built, apiDir: join(ROOT, 'api'), env: { PORTAL_ORIGIN: PORTAL, RPC_DEVNET_URL: RPC }, log: (l) => logs.push(l) }));
  const dappHtml = readFileSync(join(ROOT, 'e2e/typed-dapp.html'));
  servers.push(
    await new Promise((resolve) => {
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(dappHtml);
      });
      server.listen(5176, 'localhost', () => resolve(server));
    }),
  );
  say('portal and dApp up');

  browser = await chromium.launch({ headless: process.env.HEADED ? false : true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: { credentialId: b64(credentialId), isResidentCredential: true, rpId: 'localhost', privateKey: b64(privateKey.export({ format: 'der', type: 'pkcs8' })), signCount: 0, userHandle: b64(randomBytes(16)) },
  });
  const signCount = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0].signCount;
  await page.goto(`${DAPP}/?portal=${encodeURIComponent(PORTAL)}`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');

  async function frame() {
    await page.waitForSelector('iframe#typed', { timeout: 15_000 });
    const f = await (await page.$('iframe#typed')).contentFrame();
    await f.waitForSelector('[data-testid=requester]', { timeout: 15_000 });
    await sleep(900);
    return f;
  }
  async function review(f) {
    await f.waitForSelector('[data-testid=typed-review][data-loading=false], [data-testid=refusal]', { timeout: 20_000 });
    return f;
  }
  const text = async (f, id) => ((await f.$(`[data-testid=${id}]`)) ? (await f.textContent(`[data-testid=${id}]`)).trim() : null);
  async function press(f, selector) {
    await f.hover(selector, { force: true });
    await f.waitForSelector(`${selector}[data-guard=ready]`, { timeout: 15_000 });
    await f.click(selector);
  }
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
  const open = (url) => page.evaluate((u) => window.lkt.open(u), url);
  const at = (unix) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Number(unix) * 1000)).replace(/ /g, ' ');

  async function scenario(name, fn) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - started, detail });
      say(`PASS ${name}`);
    } catch (error) {
      results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
      say(`FAIL ${name}: ${error?.message ?? error}`);
      await shot(`fail-${name.slice(0, 40).replace(/\W+/g, '-')}`);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
    }
  }

  const usdc = new PublicKey(DEVNET_USDC);
  let firstSession = null;

  await scenario('createSession: the limits on screen; approved after 70 s, it still lands (the slot is picked at Approve)', async () => {
    const actions = [Actions.solLimit(20_000_000n), Actions.solMaxPerTx(2_000_000n), Actions.tokenLimit({ mint: usdc, remaining: 5_000_000n }), Actions.tokenMaxPerTx({ mint: usdc, max: 1_000_000n })];
    const p = await prepareCreate({ actions });
    const pending = open(p.url);
    const f = await review(await frame());
    check((await f.getAttribute('[data-testid=typed-review]', 'data-screen')) === 'session-create', 'session-create');
    check((await text(f, 'eyebrow')) === 'Spending limit', 'eyebrow');
    check((await text(f, 'hero')) === '0.02 SOL + 5 USDC', `hero ${await text(f, 'hero')}`);
    check((await text(f, 'sentence')) === 'Typed dApp can spend this to anyone, without asking you.', `sentence ${await text(f, 'sentence')}`);
    check((await text(f, 'fact-ends')).includes(`About ${at(p.expiresAt)}`), `ends ${await text(f, 'fact-ends')}`);
    check((await text(f, 'fact-stop')).includes('In Typed dApp'), 'stop sooner');
    check(await f.$('[data-testid=test-chip]'), 'Not real money');
    await f.click('[data-testid=details-toggle]');
    check(await f.$('[data-testid=match-line]'), 'the match line opens Details');
    check((await text(f, 'asset-SOL')).includes('At most 0.002 SOL per payment'), 'per payment in Details');
    await shot('session-create');
    const started = Date.now();
    say('waiting at least 70 s, and more than 150 slots, before Approve…');
    await sleep(70_000);
    while ((await currentSlot()) - p.preparedSlot <= 160n) await sleep(1000);
    const slotAtApprove = await currentSlot();
    check(slotAtApprove - p.preparedSlot > 150n, `${slotAtApprove - p.preparedSlot} slots since the SDK prepared`);
    await press(f, '[data-testid=approve]');
    const reply = await pending;
    const { typed, sig } = await rebindAndSend('createSession', reply, (slot) => client.prepareCreateSession({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(slot), sessionKey: p.sessionKey, expiresAt: p.expiresAt, actions }), (prep, r) => client.finalizeCreateSession(prep, r));
    check(BigInt(typed.slot) >= slotAtApprove - 20n, `signed at slot ${typed.slot}, Approve near ${slotAtApprove}`);
    check(typed.counter === p.counter, 'counter as prepared');
    const session = await connection.getAccountInfo(p.prepared.sessionPda, 'confirmed');
    check(session && session.data.readBigUInt64LE(72) === p.expiresAt, 'the session landed with the expiry shown');
    check(Buffer.from(session.data.subarray(80)).equals(Buffer.from(serializeActions(actions))), 'with the limits shown');
    firstSession = { pda: p.prepared.sessionPda, expiresAt: p.expiresAt };
    return { waitedMs: Date.now() - started, slotsBetween: Number(BigInt(typed.slot) - p.preparedSlot), sig };
  });

  await scenario('createSession: the counter moves forward before Approve (another approval landed); the portal signs the chain counter and it lands', async () => {
    const actions = [Actions.solRecurringLimit({ limit: 10_000_000n, window: 86_400n })];
    const p = await prepareCreate({ actions });
    const pending = open(p.url);
    const f = await review(await frame());
    check((await text(f, 'hero')) === '0.01 SOL a day', `hero ${await text(f, 'hero')}`);
    // Another passkey operation from this passkey lands meanwhile (another tab or device).
    const other = await client.prepareCreateSession({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(), sessionKey: Keypair.generate().publicKey, expiresAt: (await clusterTime()) + 600n, actions: [Actions.solLimit(1n)] });
    await send(client.finalizeCreateSession(other, softSign(other.challenge)).instructions);
    check((await counterOf()) + 1 === p.counter + 1, 'the counter moved');
    await sleep(2500);
    await press(f, '[data-testid=approve]');
    const reply = await pending;
    const { typed } = await rebindAndSend('createSession', reply, (slot) => client.prepareCreateSession({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(slot), sessionKey: p.sessionKey, expiresAt: p.expiresAt, actions }), (prep, r) => client.finalizeCreateSession(prep, r));
    check(typed.counter === p.counter + 1, `typed counter ${typed.counter}, envelope ${p.counter}`);
    check(await connection.getAccountInfo(p.prepared.sessionPda, 'confirmed'), 'landed');
    return { envelopeCounter: p.counter, signedCounter: typed.counter };
  });

  await scenario('session-no-total: the caution says how much could go, from the vault read', async () => {
    const actions = [Actions.solMaxPerTx(2_000_000n), Actions.tokenLimit({ mint: usdc, remaining: 5_000_000n })];
    const p = await prepareCreate({ actions });
    const pending = open(p.url);
    const f = await review(await frame());
    check((await f.getAttribute('[data-testid=typed-review]', 'data-screen')) === 'session-no-total', 'no-total');
    const title = await f.textContent('[data-testid=caution-block] h1');
    check(title.includes('No total limit on SOL'), title);
    const body = await text(f, 'block-body');
    check(/^Typed dApp could spend all [\d.]+ SOL, 0\.002 at a time, plus 5 USDC, to anyone, without asking\.$/.test(body), body);
    await shot('session-no-total');
    await f.click('[data-testid=cancel]');
    const reply = await pending;
    check(reply.data?.type === 'error' && reply.data.error.code === 'user-rejected', JSON.stringify(reply.data));
    return { body };
  });

  await scenario('session-no-limits: danger, Cancel solid, a confirmation before Approve', async () => {
    const p = await prepareCreate({ actions: [] });
    const pending = open(p.url);
    const f = await review(await frame());
    check((await f.getAttribute('[data-testid=typed-review]', 'data-tier')) === 'danger', 'danger');
    check((await f.textContent('[data-testid=danger] h1')).includes('Let Typed dApp spend anything'), 'danger title');
    check(!(await f.$('[data-testid=approve]')), 'no Approve before the confirmation step');
    await f.click('[data-testid=approve-anyway]');
    check((await f.getAttribute('[data-testid=approve]', 'disabled')) !== null, 'Approve off until ticked');
    await shot('session-no-limits');
    await f.click('[data-testid=cancel]');
    const reply = await pending;
    check(reply.data?.error?.code === 'user-rejected', 'rejected');
  });

  await scenario('revokeSession: a neutral hero, what is left, no money moves; it lands', async () => {
    check(firstSession, 'needs the first session');
    const preparedSlot = await currentSlot();
    const counter = (await counterOf()) + 1;
    const again = (slot) => client.prepareRevokeSession({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(slot), sessionPda: firstSession.pda, refundDestination: payer.publicKey });
    const prepared = await again(preparedSlot);
    const url = typedUrl({ kind: 'revokeSession', args: { session: firstSession.pda.toBase58(), refund: payer.publicKey.toBase58() }, counter, preparedSlot, challenge: prepared.challenge });
    const pending = open(url);
    const f = await review(await frame());
    check((await text(f, 'hero')) === 'Stop this spending permission', 'hero');
    check((await text(f, 'hero-line')) === `0.02 SOL + 5 USDC · ends about ${at(firstSession.expiresAt)}`, `line ${await text(f, 'hero-line')}`);
    check((await text(f, 'sentence')) === 'No money moves.', 'sentence');
    check((await text(f, 'approve')).includes('Stop with passkey') && (await text(f, 'cancel')) === 'Keep it', 'buttons');
    await shot('session-stop');
    await press(f, '[data-testid=approve]');
    await rebindAndSend('revokeSession', await pending, again, (prep, r) => client.finalizeRevokeSession(prep, r));
    check(!(await connection.getAccountInfo(firstSession.pda, 'confirmed')), 'the session is closed');
  });

  await scenario('removeAuthority: a Delegate key added with sdk-legacy, then removed through the portal', async () => {
    const delegate = Keypair.generate();
    const add = await client.prepareAddAuthority({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(), newAuthority: { type: 'ed25519', publicKey: delegate.publicKey }, role: ROLE_SPENDER, policy: serializeActions([Actions.tokenRecurringLimit({ mint: usdc, limit: 50_000_000n, window: 86_400n })]) });
    await send(client.finalizeAddAuthority(add, softSign(add.challenge)).instructions);
    const target = add.newAuthorityPda;
    const preparedSlot = await currentSlot();
    const counter = (await counterOf()) + 1;
    const again = (slot) => client.prepareRemoveAuthority({ payer: payer.publicKey, walletPda: wallet, secp256r1: secp(slot), targetAuthorityPda: target, refundDestination: payer.publicKey });
    const prepared = await again(preparedSlot);
    const pending = open(typedUrl({ kind: 'removeAuthority', args: { target: target.toBase58(), refund: payer.publicKey.toBase58() }, counter, preparedSlot, challenge: prepared.challenge }));
    const f = await review(await frame());
    check((await f.getAttribute('[data-testid=typed-review]', 'data-screen')) === 'key-remove', 'key-remove');
    check((await text(f, 'hero')) === 'Remove a key', 'hero');
    check((await text(f, 'hero-line')) === `Key ending ${delegate.publicKey.toBase58().slice(-4)}`, 'key line');
    await f.click('[data-testid=details-toggle]');
    check((await text(f, 'target-role')).includes('Can spend within its limits'), 'role');
    check((await text(f, 'asset-USDC')).includes('Up to 50 USDC a day'), 'policy decoded');
    await shot('key-remove');
    await press(f, '[data-testid=approve]');
    await rebindAndSend('removeAuthority', await pending, again, (prep, r) => client.finalizeRemoveAuthority(prep, r));
    check(!(await connection.getAccountInfo(target, 'confirmed')), 'the key is removed');
  });

  await scenario('tamper: actions that are not what the message signs are refused; the passkey signs nothing', async () => {
    const actions = [Actions.solLimit(20_000_000n)];
    const p = await prepareCreate({ actions });
    const forged = p.url.replace(/#\/\?lk1=.*$/, `#/?lk1=${b64url(Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p.url.split('lk1=')[1], 'base64url').toString()), args: { ...p.args, actions: b64url(serializeActions([Actions.solLimit(20_000_000_000n)])) } })))}`);
    const before = await signCount();
    const pending = open(forged);
    const f = await frame();
    await f.waitForSelector('[data-testid=refusal]');
    check((await f.getAttribute('[data-testid=refusal]', 'data-kind')) === 'mismatch', 'refused-mismatch');
    check((await text(f, 'refusal-sentence')).endsWith('Your passkey signed nothing.'), 'signed nothing');
    await shot('refused-mismatch');
    await f.click('[data-testid=close]');
    const reply = await pending;
    check(reply.data?.error?.code === 'challenge-mismatch', JSON.stringify(reply.data));
    check((await signCount()) === before, 'sign count unchanged');
  });

  await scenario('tamper: a fragment changed after load is refused', async () => {
    const p = await prepareCreate({ actions: [Actions.solLimit(1_000_000n)] });
    const pending = open(p.url);
    const f = await review(await frame());
    check(await f.$('[data-testid=typed-review]'), 'shown first');
    const before = await signCount();
    await page.evaluate(() => window.lkt.retarget('#/?lk1=AAAA'));
    await f.waitForSelector('[data-testid=refusal]', { timeout: 10_000 });
    check((await f.getAttribute('[data-testid=refusal]', 'data-reason')) === 'typed-malformed', 'typed-malformed');
    await f.click('[data-testid=close]');
    const reply = await pending;
    check(reply.data?.error?.code === 'typed-malformed', JSON.stringify(reply.data));
    check((await signCount()) === before, 'sign count unchanged');
  });

  await scenario('wrong-network: a mainnet request on a portal with no mainnet program configured', async () => {
    const p = await prepareCreate({ actions: [Actions.solLimit(1n)] });
    const mainnet = sdk.PROGRAM_ID_MAINNET.toBase58();
    // The SDK's challenge for the same request under the mainnet program id.
    const mainClient = new LazorKitClient(connection, sdk.PROGRAM_ID_MAINNET);
    const prepared = await mainClient.prepareCreateSession({ payer: payer.publicKey, walletPda: wallet, secp256r1: { ...secp(p.preparedSlot), authorityPda: authority }, sessionKey: p.sessionKey, expiresAt: p.expiresAt, actions: [Actions.solLimit(1n)] }).catch(() => null);
    check(prepared, 'prepared');
    // The envelope's authority must be the mainnet PDA for this credential.
    const [mainAuthority] = PublicKey.findProgramAddressSync([Buffer.from('lk2:authority'), wallet.toBuffer(), credentialIdHash], sdk.PROGRAM_ID_MAINNET);
    const url = typedUrl({ kind: 'createSession', args: p.args, counter: p.counter, preparedSlot: p.preparedSlot, challenge: prepared.challenge, cluster: 'mainnet', programId: mainnet }).replace(
      /#\/\?lk1=(.*)$/,
      (_m, v) => `#/?lk1=${b64url(Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(v, 'base64url').toString()), authority: mainAuthority.toBase58() })))}`,
    );
    const pending = open(url);
    const f = await frame();
    await f.waitForSelector('[data-testid=refusal]', { timeout: 20_000 });
    const reason = await f.getAttribute('[data-testid=refusal]', 'data-reason');
    await shot('refused-network');
    await f.click('[data-testid=close]');
    const reply = await pending;
    check(reason === 'wrong-network', `reason ${reason}`);
    check(reply.data?.error?.code === 'wrong-network', JSON.stringify(reply.data));
    return { reason, code: reply.data?.error?.code };
  });

  await scenario('legacy: without a fragment the bare challenge is still the change LazorKit can\'t show', async () => {
    const query = new URLSearchParams({ action: 'sign', message: b64(randomBytes(32)), transaction: '', credentialId: b64(credentialId) });
    const pending = open(`${PORTAL}/?${query}`);
    const f = await frame();
    await f.waitForSelector('[data-testid=approval-review]');
    check((await text(f, 'hero')) === "Approve a change LazorKit can't show" || (await f.textContent('[data-testid=approval-review]')).includes("Approve a change LazorKit can't show"), 'legacy-change');
    await f.click('[data-testid=cancel]');
    await pending;
  });

  results.push({ name: 'no page errors', ok: pageErrors.length === 0, error: pageErrors.join('\n') || undefined });
  const failedReads = logs.filter((l) => l.route === 'rpc' && l.status >= 400);
  // The mainnet request is refused before any mainnet read; every devnet read answered.
  results.push({ name: 'every read through /api/rpc answered', ok: failedReads.length === 0, error: failedReads.length ? JSON.stringify(failedReads.slice(0, 5)) : undefined, detail: { reads: logs.filter((l) => l.route === 'rpc').length } });
}

function lowS(sig) {
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let s = BigInt(`0x${Buffer.from(sig.subarray(32)).toString('hex')}`);
  if (s > N / 2n) s = N - s;
  return Buffer.concat([sig.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
}
