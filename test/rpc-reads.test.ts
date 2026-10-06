// The display reads /api/rpc forwards: each method's parameters are checked
// (program listings are pinned to the LazorKit program of the cluster and to
// one wallet), each client has a budget, finalized transactions are kept,
// and nothing is ever stored by a cache. Requests are built by
// @solana/web3.js, so the allowlist matches what a Connection sends.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  clientKey,
  handleRpc,
  LAZORKIT_PROGRAM,
  MemoryCache,
  METHOD_COST,
  RateLimiter,
  validateRpcRequest,
  type RpcDeps,
  type RpcEnv,
} from '../api/rpc.ts';

const PORTAL = 'https://portal.example';
const env: RpcEnv = { RPC_MAINNET_URL: 'https://mainnet.upstream.example/?api-key=TEST-SECRET-0000', RPC_DEVNET_URL: 'https://devnet.upstream.example/', PORTAL_ORIGIN: PORTAL };
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const key = () => Keypair.generate().publicKey.toBase58();
const signature = () => bs58.encode(Keypair.generate().secretKey);

interface Call {
  method: string;
  params: unknown[];
}

/** An upstream that answers each display read with an empty result of the right shape. */
function upstream(calls: Call[]): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ method: body.method, params: body.params });
    const context = { slot: 7 };
    const results: Record<string, unknown> = {
      getBalance: { context, value: 5 },
      getAccountInfo: { context, value: null },
      getTokenAccountsByOwner: { context, value: [] },
      getProgramAccounts: body.params[1]?.withContext ? { context, value: [] } : [],
      getSignaturesForAddress: [],
      getTransaction: body.params[0] === FINALIZED_SIG ? { slot: 3, blockTime: 1, meta: { err: null }, transaction: {}, version: 0 } : null,
    };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] ?? null }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const FINALIZED_SIG = signature();

const deps = (calls: Call[], extra: Partial<RpcDeps> = {}): RpcDeps => ({ env, fetch: upstream(calls), log: () => {}, now: () => 0, ...extra });

function post(body: unknown, { cluster = 'devnet', headers = {} as Record<string, string> } = {}): Request {
  return new Request(`${PORTAL}/api/rpc?cluster=${cluster}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PORTAL, ...headers },
    body: JSON.stringify(body),
  });
}

const rpc = (method: string, params: unknown[]) => ({ jsonrpc: '2.0', id: 1, method, params });

/** The filters the portal and the SDKs send: account type at 0, wallet at its offset. */
const walletFilters = (type: number, offset: number, wallet: string, encoding?: 'base58' | 'base64') => [
  { memcmp: { offset: 0, bytes: encoding === 'base64' ? Buffer.from([type]).toString('base64') : bs58.encode([type]), ...(encoding ? { encoding } : {}) } },
  { memcmp: { offset, bytes: encoding === 'base64' ? Buffer.from(bs58.decode(wallet)).toString('base64') : wallet, ...(encoding ? { encoding } : {}) } },
];

// ─── What web3.js sends ─────────────────────────────────────────────────────

test('the display reads web3.js makes all pass and reach the upstream', async () => {
  const calls: Call[] = [];
  const connection = new Connection(`${PORTAL}/api/rpc?cluster=devnet`, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handleRpc(new Request(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), origin: PORTAL } }), deps(calls))) as typeof fetch,
  });
  const vault = Keypair.generate().publicKey;
  const wallet = Keypair.generate().publicKey;
  const program = new PublicKey(LAZORKIT_PROGRAM.devnet);

  assert.equal(await connection.getBalance(vault), 5);
  assert.equal(await connection.getAccountInfo(vault), null);
  await connection.getAccountInfo(vault, { dataSlice: { offset: 0, length: 8 } });
  await connection.getTokenAccountsByOwner(vault, { programId: new PublicKey(TOKEN) });
  await connection.getParsedTokenAccountsByOwner(vault, { programId: new PublicKey(TOKEN_2022) });
  await connection.getParsedTokenAccountsByOwner(vault, { mint: Keypair.generate().publicKey });
  for (const [type, offset] of [[0x22, 16], [0x23, 8], [0x24, 72]]) {
    await connection.getProgramAccounts(program, { filters: walletFilters(type, offset, wallet.toBase58()) });
  }
  await connection.getProgramAccounts(program, { withContext: true, filters: walletFilters(0x23, 8, wallet.toBase58(), 'base64') });
  await connection.getSignaturesForAddress(vault, { limit: 1000 });
  await connection.getSignaturesForAddress(vault, { limit: 10, before: signature(), until: signature() }, 'finalized');
  await connection.getParsedTransaction(signature(), { maxSupportedTransactionVersion: 0 });
  await connection.getTransaction(signature(), { maxSupportedTransactionVersion: 0 });

  assert.deepEqual(calls.map((c) => c.method), [
    'getBalance',
    'getAccountInfo',
    'getAccountInfo',
    'getTokenAccountsByOwner',
    'getTokenAccountsByOwner',
    'getTokenAccountsByOwner',
    'getProgramAccounts',
    'getProgramAccounts',
    'getProgramAccounts',
    'getProgramAccounts',
    'getSignaturesForAddress',
    'getSignaturesForAddress',
    'getTransaction',
    'getTransaction',
  ]);
});

// ─── Parameters ─────────────────────────────────────────────────────────────

test('program listings: only the LazorKit program of the cluster, one account type of one wallet', () => {
  const wallet = key();
  const ok = (cluster: 'mainnet' | 'devnet', params: unknown[]) => validateRpcRequest(rpc('getProgramAccounts', params), cluster).ok;
  const config = (filters: unknown, extra: Record<string, unknown> = {}) => ({ encoding: 'base64', commitment: 'confirmed', filters, ...extra });

  assert.ok(ok('devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 16, wallet))]));
  assert.ok(ok('mainnet', [LAZORKIT_PROGRAM.mainnet, config(walletFilters(0x23, 8, wallet))]));
  assert.ok(ok('devnet', [LAZORKIT_PROGRAM.devnet, config([...walletFilters(0x24, 72, wallet)].reverse(), { withContext: true, dataSlice: { offset: 0, length: 80 } })]));

  const refused: [string, 'mainnet' | 'devnet', unknown[]][] = [
    ['the other cluster’s program', 'devnet', [LAZORKIT_PROGRAM.mainnet, config(walletFilters(0x22, 16, wallet))]],
    ['the token program', 'devnet', [TOKEN, config(walletFilters(0x22, 16, wallet))]],
    ['no filters', 'devnet', [LAZORKIT_PROGRAM.devnet, config(undefined)]],
    ['the type alone', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 16, wallet).slice(0, 1))]],
    ['the wallet alone', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 16, wallet).slice(1))]],
    ['the wallet at another type’s offset', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 8, wallet))]],
    ['wallet accounts (not listable)', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x21, 16, wallet))]],
    ['a v1 account type', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x02, 16, wallet))]],
    ['a third filter', 'devnet', [LAZORKIT_PROGRAM.devnet, config([...walletFilters(0x22, 16, wallet), { dataSize: 80 }])]],
    ['a size filter instead', 'devnet', [LAZORKIT_PROGRAM.devnet, config([walletFilters(0x22, 16, wallet)[0], { dataSize: 80 }])]],
    ['a 31-byte wallet', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 16, bs58.encode(new Uint8Array(31).fill(9))))]],
    ['two type bytes', 'devnet', [LAZORKIT_PROGRAM.devnet, config([{ memcmp: { offset: 0, bytes: bs58.encode([0x22, 1]) } }, walletFilters(0x22, 16, wallet)[1]])]],
    ['jsonParsed', 'devnet', [LAZORKIT_PROGRAM.devnet, { ...config(walletFilters(0x22, 16, wallet)), encoding: 'jsonParsed' }]],
    ['an unknown memcmp encoding', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 16, wallet).map((f) => ({ memcmp: { ...f.memcmp, encoding: 'hex' } })))]],
    ['an unknown config field', 'devnet', [LAZORKIT_PROGRAM.devnet, config(walletFilters(0x22, 16, wallet), { changedSinceSlot: 1 })]],
  ];
  for (const [what, cluster, params] of refused) assert.equal(ok(cluster, params), false, what);
});

test('balance, account, token account, signature and transaction reads are bounded', () => {
  const ok = (method: string, params: unknown[]) => validateRpcRequest(rpc(method, params), 'devnet').ok;
  const vault = key();
  assert.ok(ok('getBalance', [vault]));
  assert.ok(ok('getAccountInfo', [vault, { encoding: 'base64', commitment: 'finalized' }]));
  assert.ok(ok('getTokenAccountsByOwner', [vault, { programId: TOKEN }, { encoding: 'jsonParsed' }]));
  assert.ok(ok('getTokenAccountsByOwner', [vault, { mint: key() }, { encoding: 'base64', dataSlice: { offset: 0, length: 64 } }]));
  assert.ok(ok('getSignaturesForAddress', [vault, { limit: 1000, commitment: 'finalized' }]));
  assert.ok(ok('getTransaction', [signature(), { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]));

  const refused: [string, unknown[]][] = [
    ['getBalance', ['not a key']],
    ['getBalance', [vault, { commitment: 'confirmed', encoding: 'base64' }]],
    ['getAccountInfo', [vault, { encoding: 'jsonParsed' }]],
    ['getAccountInfo', [vault]],
    ['getAccountInfo', [vault, { encoding: 'base64', dataSlice: { offset: -1, length: 8 } }]],
    ['getTokenAccountsByOwner', [vault, { programId: LAZORKIT_PROGRAM.devnet }, { encoding: 'jsonParsed' }]],
    ['getTokenAccountsByOwner', [vault, { programId: TOKEN, mint: key() }, { encoding: 'jsonParsed' }]],
    ['getTokenAccountsByOwner', [vault, { programId: TOKEN }, { encoding: 'jsonParsed', dataSlice: { offset: 0, length: 8 } }]],
    ['getTokenAccountsByOwner', [vault, { programId: TOKEN }]],
    ['getSignaturesForAddress', [vault, { limit: 1001 }]],
    ['getSignaturesForAddress', [vault, { limit: 0 }]],
    ['getSignaturesForAddress', [vault, { commitment: 'processed' }]],
    ['getSignaturesForAddress', [vault, { before: 'not a signature' }]],
    ['getSignaturesForAddress', [vault, { before: vault }]],
    ['getTransaction', [signature()]],
    ['getTransaction', [vault, { encoding: 'jsonParsed' }]],
    ['getTransaction', [signature(), { maxSupportedTransactionVersion: 2 }]],
    ['getTransaction', [signature(), { commitment: 'processed' }]],
    ['getTransaction', [signature(), { encoding: 'base58' }]],
    ['getTransaction', [signature(), { encoding: 'jsonParsed', rewards: true }]],
  ];
  for (const [method, params] of refused) assert.equal(ok(method, params), false, `${method} ${JSON.stringify(params).slice(0, 100)}`);
});

// ─── Budgets ────────────────────────────────────────────────────────────────

test('each client address has a budget; past it, nothing reaches the upstream until it refills', async () => {
  const calls: Call[] = [];
  let now = 0;
  const limiter = new RateLimiter({ capacity: 12, refillPerSecond: 1, maxClients: 100 });
  const d = deps(calls, { limiter, now: () => now });
  const from = (ip: string) => ({ headers: { 'x-real-ip': ip } });
  const listing = rpc('getProgramAccounts', [LAZORKIT_PROGRAM.devnet, { encoding: 'base64', filters: walletFilters(0x22, 16, key()) }]);

  assert.equal((await handleRpc(post(listing, from('203.0.113.7')), d)).status, 200);
  const limited = await handleRpc(post(listing, from('203.0.113.7')), d);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '8');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.match(await limited.text(), /rate limited/);
  // A cheaper read still fits; another address has its own budget.
  assert.equal((await handleRpc(post(rpc('getBalance', [key()]), from('203.0.113.7')), d)).status, 200);
  assert.equal((await handleRpc(post(listing, from('198.51.100.1')), d)).status, 200);
  assert.equal(calls.length, 3);
  now = 9_000;
  assert.equal((await handleRpc(post(listing, from('203.0.113.7')), d)).status, 200);
  assert.equal(METHOD_COST.getProgramAccounts > METHOD_COST.getTransaction, true);
});

test('a client is its reported address, an IPv6 client its /64; invalid requests cost nothing', async () => {
  const at = (headers: Record<string, string>) => clientKey(new Request(PORTAL, { headers }));
  assert.equal(at({ 'x-real-ip': '203.0.113.7' }), '203.0.113.7');
  assert.equal(at({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), '203.0.113.9');
  assert.equal(at({ 'x-real-ip': '::ffff:203.0.113.7' }), '203.0.113.7');
  assert.equal(at({ 'x-real-ip': '2001:db8:aa:1:2:3:4:5' }), '2001:db8:aa:1::/64');
  assert.equal(at({ 'x-real-ip': '2001:db8:aa:1::9' }), '2001:db8:aa:1::/64');
  assert.equal(at({ 'x-real-ip': '2001:0db8:00aa:0001:ffff::1' }), '2001:db8:aa:1::/64');
  assert.equal(at({}), 'unknown');

  const calls: Call[] = [];
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.001, maxClients: 100 });
  for (let i = 0; i < 5; i++) {
    assert.equal((await handleRpc(post(rpc('getBalance', ['not a key'])), deps(calls, { limiter }))).status, 400);
  }
  assert.equal((await handleRpc(post(rpc('getBalance', [key()])), deps(calls, { limiter }))).status, 200);
});

test('the least recently seen client is forgotten first', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0, maxClients: 2 });
  assert.equal(limiter.take('a', 2, 0), 0);
  assert.equal(limiter.take('b', 2, 0), 0);
  assert.ok(limiter.take('a', 1, 0) > 0);
  assert.equal(limiter.take('c', 2, 0), 0); // forgets b, the least recently seen
  assert.equal(limiter.take('b', 2, 0), 0);
  assert.ok(limiter.take('a', 1, 0) === 0, 'a was forgotten when b came back, and starts afresh');
});

// ─── Caching ────────────────────────────────────────────────────────────────

test('a finalized transaction is read from the upstream once; nothing else is kept, and nothing is cacheable downstream', async () => {
  const calls: Call[] = [];
  const cache = new MemoryCache();
  const d = deps(calls, { cache });
  const finalized = (id: number) => ({ ...rpc('getTransaction', [FINALIZED_SIG, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]), id });

  const first = await handleRpc(post(finalized(1)), d);
  const second = await handleRpc(post(finalized(2)), d);
  assert.equal(calls.length, 1);
  assert.deepEqual(await second.json(), { ...(await first.json()), id: 2 });
  for (const r of [first, second]) assert.equal(r.headers.get('cache-control'), 'no-store');

  // Another encoding or version is another answer.
  await handleRpc(post(rpc('getTransaction', [FINALIZED_SIG, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])), d);
  assert.equal(calls.length, 2);
  // Confirmed may still change; a missing transaction may appear.
  const confirmed = rpc('getTransaction', [FINALIZED_SIG, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  await handleRpc(post(confirmed), d);
  await handleRpc(post(confirmed), d);
  const missing = rpc('getTransaction', [signature(), { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  await handleRpc(post(missing), d);
  await handleRpc(post(missing), d);
  const balance = rpc('getBalance', [key()]);
  const balanceAnswer = await handleRpc(post(balance), d);
  await handleRpc(post(balance), d);
  assert.equal(calls.length, 8);
  assert.equal(balanceAnswer.headers.get('cache-control'), 'no-store');
});

test('the memory cache keeps to its size, dropping the least recently used', () => {
  // Each entry is (1 + 100) UTF-16 code units: 202 bytes; nine fit in 2000.
  const cache = new MemoryCache(2000);
  const keys = 'abcdefghi'.split('');
  for (const k of keys) cache.set(k, k.repeat(100));
  assert.equal(cache.get('a'), 'a'.repeat(100));
  cache.set('j', 'j'.repeat(100));
  assert.equal(cache.get('b'), undefined, 'the least recently used goes first');
  assert.equal(cache.get('a'), 'a'.repeat(100));
  assert.equal(cache.get('j'), 'j'.repeat(100));
  // One entry may not take more than an eighth of the cache.
  cache.set('huge', 'h'.repeat(200));
  assert.equal(cache.get('huge'), undefined);
});
