// The RPC route forwards only the read-only calls the preview makes, from the
// portal's own origin, and never shows the upstream URL. Requests are built
// by @solana/web3.js itself, so the allowlist matches what the client sends.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { handleRpc, MAX_REQUEST_BYTES, type RpcEnv } from '../api/rpc.ts';

const PORTAL = 'https://portal.example';
const SECRET_UPSTREAM = 'https://mainnet.upstream.example/?api-key=TEST-SECRET-0000';
const DEVNET_UPSTREAM = 'https://devnet.upstream.example/';
const env: RpcEnv = { RPC_MAINNET_URL: SECRET_UPSTREAM, RPC_DEVNET_URL: DEVNET_UPSTREAM, PORTAL_ORIGIN: PORTAL };

interface Call {
  url: string;
  body: { method: string; params: unknown[]; id: unknown; jsonrpc: string };
}

/** A fake upstream that answers each allowed method with a canned result. */
function upstream(calls: Call[], override?: (call: Call) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    if (override) return override(call);
    const context = { slot: 1 };
    const results: Record<string, unknown> = {
      getMultipleAccounts: { context, value: call.body.params[0] instanceof Array ? (call.body.params[0] as unknown[]).map(() => null) : [] },
      getLatestBlockhash: { context, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 } },
      isBlockhashValid: { context, value: true },
      simulateTransaction: { context, value: { err: null, logs: [], accounts: null, unitsConsumed: 150 } },
    };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.body.id, result: results[call.body.method] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const logs: Record<string, unknown>[] = [];
const deps = (fetchImpl: typeof fetch, extra: Partial<RpcEnv> = {}) => ({
  env: { ...env, ...extra },
  fetch: fetchImpl,
  log: (line: Record<string, unknown>) => logs.push(line),
  now: () => 0,
});

function post(body: unknown, { cluster = 'devnet', origin = PORTAL as string | null } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return new Request(`${PORTAL}/api/rpc?cluster=${cluster}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A Connection whose requests go through the route, the way the portal's client does. */
function connectionThrough(calls: Call[], cluster: 'mainnet' | 'devnet' = 'devnet'): Connection {
  const route = upstream(calls);
  return new Connection(`${PORTAL}/api/rpc?cluster=${cluster}`, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), origin: PORTAL } });
      return handleRpc(request, deps(route));
    }) as typeof fetch,
  });
}

// ─── What web3.js sends ─────────────────────────────────────────────────────

test('web3.js calls the preview makes all pass, and reach the upstream for the cluster', async () => {
  const calls: Call[] = [];
  const connection = connectionThrough(calls);
  const payer = Keypair.generate().publicKey;
  const keys = Array.from({ length: 5 }, () => Keypair.generate().publicKey);

  assert.equal((await connection.getMultipleAccountsInfo(keys)).length, 5);

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: keys[0], lamports: 1 })],
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);
  const simulated = await connection.simulateTransaction(versioned, {
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [payer.toBase58(), keys[0].toBase58()] },
  });
  assert.equal(simulated.value.err, null);

  const legacy = new Transaction({ feePayer: payer }).add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: keys[1], lamports: 1 }));
  await connection.simulateTransaction(legacy, undefined, [payer, keys[1]]);

  assert.equal((await connection.isBlockhashValid(Keypair.generate().publicKey.toBase58())).value, true);

  assert.deepEqual(
    calls.map((c) => c.body.method),
    ['getMultipleAccounts', 'simulateTransaction', 'getLatestBlockhash', 'simulateTransaction', 'isBlockhashValid'],
  );
  assert.ok(calls.every((c) => c.url === DEVNET_UPSTREAM));
});

test('mainnet goes to RPC_MAINNET_URL; devnet defaults to the public devnet RPC; mainnet unset is unavailable', async () => {
  const calls: Call[] = [];
  const body = { jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] };
  assert.equal((await handleRpc(post(body, { cluster: 'mainnet' }), deps(upstream(calls)))).status, 200);
  assert.equal(calls[0].url, SECRET_UPSTREAM);
  await handleRpc(post(body), deps(upstream(calls), { RPC_DEVNET_URL: undefined }));
  assert.equal(calls[1].url, 'https://api.devnet.solana.com');
  const unset = await handleRpc(post(body, { cluster: 'mainnet' }), deps(upstream(calls), { RPC_MAINNET_URL: undefined }));
  assert.equal(unset.status, 503);
  assert.equal(calls.length, 2);
  const unknown = await handleRpc(post(body, { cluster: 'testnet' }), deps(upstream(calls)));
  assert.equal(unknown.status, 400);
});

// ─── Allowlist ──────────────────────────────────────────────────────────────

test('only the four read-only methods pass, one request at a time', async () => {
  const calls: Call[] = [];
  const key = Keypair.generate().publicKey.toBase58();
  for (const method of ['sendTransaction', 'getProgramAccounts', 'requestAirdrop', 'getBalance', 'getAccountInfo']) {
    const r = await handleRpc(post({ jsonrpc: '2.0', id: 1, method, params: [key] }), deps(upstream(calls)));
    assert.equal(r.status, 400, method);
    assert.match(await r.text(), /method not allowed/);
  }
  const batch = await handleRpc(post([{ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }]), deps(upstream(calls)));
  assert.equal(batch.status, 400);
  const extra = await handleRpc(post({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [], extra: 1 }), deps(upstream(calls)));
  assert.equal(extra.status, 400);
  assert.equal((await handleRpc(post('{not json'), deps(upstream(calls)))).status, 400);
  assert.equal(calls.length, 0);
});

test('parameters are bounded: keys, addresses, transaction size, encoding, sigVerify', async () => {
  const calls: Call[] = [];
  const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
  const tx = Buffer.alloc(600).toString('base64');
  const refused = [
    { method: 'getMultipleAccounts', params: [keys(101), { encoding: 'base64' }] },
    { method: 'getMultipleAccounts', params: [keys(2), { encoding: 'jsonParsed' }] },
    { method: 'getMultipleAccounts', params: [['not a key'], { encoding: 'base64' }] },
    { method: 'simulateTransaction', params: ['A'.repeat(2052), { encoding: 'base64' }] },
    { method: 'simulateTransaction', params: [tx, { encoding: 'base64', sigVerify: true }] },
    { method: 'simulateTransaction', params: [tx, { encoding: 'base58' }] },
    { method: 'simulateTransaction', params: [tx, { encoding: 'base64', accounts: { encoding: 'base64', addresses: keys(129) } }] },
    { method: 'simulateTransaction', params: [tx, { encoding: 'base64', accounts: { encoding: 'jsonParsed', addresses: keys(1) } }] },
    { method: 'simulateTransaction', params: [tx, { encoding: 'base64', other: 1 }] },
    { method: 'isBlockhashValid', params: [] },
    { method: 'getLatestBlockhash', params: [{ commitment: 'max' }] },
  ];
  for (const body of refused) {
    const r = await handleRpc(post({ jsonrpc: '2.0', id: 7, ...body }), deps(upstream(calls)));
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
  }
  assert.equal(calls.length, 0);
  const ok = await handleRpc(
    post({ jsonrpc: '2.0', id: 7, method: 'simulateTransaction', params: [tx, { encoding: 'base64', sigVerify: false, accounts: { encoding: 'base64', addresses: keys(128) } }] }),
    deps(upstream(calls)),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['id', 'jsonrpc', 'method', 'params']);
});

test('requests over 64 KiB and responses over 4 MiB are refused', async () => {
  const calls: Call[] = [];
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [], pad: 'x'.repeat(MAX_REQUEST_BYTES) });
  assert.equal((await handleRpc(post(big), deps(upstream(calls)))).status, 413);
  const huge = upstream(calls, () => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  const r = await handleRpc(post({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }), deps(huge));
  assert.equal(r.status, 502);
  assert.equal(calls.length, 1);
});

// ─── Who may call it ────────────────────────────────────────────────────────

test('only the portal origin, or this deployment, may call it', async () => {
  const calls: Call[] = [];
  const body = { jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] };
  for (const origin of [null, 'https://elsewhere.example', 'null', 'http://portal.example']) {
    assert.equal((await handleRpc(post(body, { origin }), deps(upstream(calls)))).status, 403, String(origin));
  }
  const preview = await handleRpc(post(body, { origin: 'https://portal-git-x.vercel.app' }), deps(upstream(calls), { VERCEL_BRANCH_URL: 'portal-git-x.vercel.app' }));
  assert.equal(preview.status, 200);
  const get = await handleRpc(new Request(`${PORTAL}/api/rpc?cluster=devnet`, { headers: { origin: PORTAL } }), deps(upstream(calls)));
  assert.equal(get.status, 405);
  assert.equal(calls.length, 1);
});

test('a page of the domain serving the route may call it (a staging domain, with PORTAL_ORIGIN set for production only)', async () => {
  const calls: Call[] = [];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] });
  const at = (url: string, origin: string) => new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
  const staging = 'https://portal-staging.lazor.example';
  const ok = await handleRpc(at(`${staging}/api/rpc?cluster=devnet`, staging), deps(upstream(calls), { PORTAL_ORIGIN: undefined }));
  assert.equal(ok.status, 200);
  for (const origin of ['https://elsewhere.example', 'http://portal-staging.lazor.example', 'https://portal-staging.lazor.example:8443', 'null']) {
    assert.equal((await handleRpc(at(`${staging}/api/rpc?cluster=devnet`, origin), deps(upstream(calls), { PORTAL_ORIGIN: undefined }))).status, 403, origin);
  }
  assert.equal(calls.length, 1);
});

test('deployed on Vercel (production or preview), devnet needs RPC_DEVNET_URL; the public devnet RPC is for local use only', async () => {
  const calls: Call[] = [];
  const body = { jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] };
  for (const VERCEL_ENV of ['production', 'preview']) {
    const unset = await handleRpc(post(body), deps(upstream(calls), { RPC_DEVNET_URL: undefined, VERCEL_ENV }));
    assert.equal(unset.status, 503, VERCEL_ENV);
    assert.match(await unset.text(), /devnet RPC is not configured/);
    assert.equal((await handleRpc(post(body), deps(upstream(calls), { VERCEL_ENV }))).status, 200);
  }
  assert.equal((await handleRpc(post(body), deps(upstream(calls), { RPC_DEVNET_URL: undefined, VERCEL_ENV: 'development' }))).status, 200);
  assert.deepEqual(calls.map((c) => c.url), [DEVNET_UPSTREAM, DEVNET_UPSTREAM, 'https://api.devnet.solana.com']);
});

// ─── Never the upstream URL ─────────────────────────────────────────────────

test('the upstream URL appears in no response and no log line, whatever fails', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] };
  const failures: (() => Response | Promise<Response>)[] = [
    () => { throw new TypeError(`fetch failed: ${SECRET_UPSTREAM}`); },
    () => new Response(`bad gateway at ${SECRET_UPSTREAM}`, { status: 502 }),
    () => new Response(`unauthorized ${SECRET_UPSTREAM}`, { status: 401 }),
    () => new Response('slow down', { status: 429 }),
  ];
  logs.length = 0;
  for (const failure of failures) {
    const r = await handleRpc(post(body, { cluster: 'mainnet' }), deps(upstream([], failure)));
    assert.ok(r.status >= 400);
    const text = await r.text();
    assert.ok(!text.includes('TEST-SECRET') && !text.includes('upstream.example'), text);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.ok(logs.length >= failures.length);
  assert.ok(logs.every((l) => !JSON.stringify(l).includes('TEST-SECRET')));
  assert.deepEqual(Object.keys(logs[0]).sort(), ['cluster', 'method', 'ms', 'route', 'status']);
});

test('an upstream that does not answer in time is reported as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = upstream([], () => new Promise<Response>(() => {}));
  const slow: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pending = hanging(input, init);
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      pending.then(resolve, reject);
    });
  }) as typeof fetch;
  const result = handleRpc(post({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }), deps(slow));
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(8_000);
  assert.equal((await result).status, 504);
});

test('a valid key list is forwarded unchanged', async () => {
  const calls: Call[] = [];
  const key = new PublicKey(Keypair.generate().publicKey.toBytes()).toBase58();
  await handleRpc(post({ jsonrpc: '2.0', id: 'a', method: 'getMultipleAccounts', params: [[key], { encoding: 'base64', commitment: 'confirmed' }] }), deps(upstream(calls)));
  assert.deepEqual(calls[0].body, { jsonrpc: '2.0', id: 'a', method: 'getMultipleAccounts', params: [[key], { encoding: 'base64', commitment: 'confirmed' }] });
});
