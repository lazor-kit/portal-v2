// The chain reads the pages use (src/chain), run against answers recorded
// from devnet (test/fixtures/chain, `node scripts/record-chain-fixtures.ts`)
// and passed through the real /api/rpc route, so every request the client
// makes is one the route allows. No RPC key is involved.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { handleRpc, LAZORKIT_PROGRAM as ROUTE_PROGRAM, MemoryCache, RateLimiter, WALLET_OFFSET as ROUTE_WALLET_OFFSET, type RpcDeps } from '../api/rpc.ts';
import {
  addressBytes,
  checkRecipient,
  DISCRIMINATOR,
  LAZORKIT_PROGRAM,
  WALLET_OFFSET,
  compareAddresses,
  decodeAuthority,
  decodeDeferred,
  decodeSession,
  findLookalike,
  lookalikeLevel,
  paymentsTo,
  portalTransport,
  readPaymentHistory,
  readRecipientCheck,
  readVault,
  readWalletAccounts,
  relationTo,
  vaultAddress,
  vaultTransfers,
  type Cluster,
  type PaymentHistory,
  type Read,
} from '../src/chain/index.ts';

const PORTAL = 'https://portal.example';

interface Fixture {
  wallet: string;
  vault: string;
  accounts: Record<'authority' | 'session' | 'deferred', { context: { slot: number }; value: { pubkey: string; account: { data: [string, string]; owner: string } }[] }>;
  balance: unknown;
  tokenAccounts: Record<string, unknown>;
  signatures: { signature: string; err: unknown; confirmationStatus: string; blockTime: number }[];
  transactions: Record<string, { version: 'legacy' | number; meta: { err: unknown } } & Record<string, unknown>>;
}
const load = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), 'utf8'));
const WALLET = load('devnet-wallet');
const PAYMENTS = load('devnet-payments');
const REPEAT = load('devnet-repeat');

interface Seen {
  method: string;
  params: unknown[];
}

const TYPES: Record<number, 'authority' | 'session' | 'deferred'> = { 0x22: 'authority', 0x23: 'session', 0x24: 'deferred' };

/**
 * The devnet RPC as recorded: listings, balances, signatures and
 * transactions of the fixture's wallet, and the RPC's own refusal of a
 * transaction newer than the version asked for. `fail` can replace any answer.
 */
function replay(fixture: Fixture, seen: Seen[], fail?: (call: Seen) => Response | null): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const call = { method: body.method as string, params: body.params as unknown[] };
    seen.push(call);
    const failure = fail?.(call);
    if (failure) return failure;
    const answer = (payload: Record<string, unknown>) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), { headers: { 'content-type': 'application/json' } });
    const [first, second, third] = call.params as [string, Record<string, unknown>, Record<string, unknown>];
    switch (call.method) {
      case 'getProgramAccounts': {
        const filters = second.filters as { memcmp: { offset: number; bytes: string } }[];
        const type = TYPES[bs58.decode(filters.find((f) => f.memcmp.offset === 0)!.memcmp.bytes)[0]];
        const wallet = filters.find((f) => f.memcmp.offset !== 0)!.memcmp.bytes;
        const listing = fixture.accounts[type];
        return answer({ result: wallet === fixture.wallet ? listing : { context: listing.context, value: [] } });
      }
      case 'getBalance':
        return answer(first === fixture.vault ? { result: fixture.balance } : { error: { code: -32602, message: 'unknown' } });
      case 'getTokenAccountsByOwner':
        return answer({ result: fixture.tokenAccounts[(second as { programId: string }).programId] });
      case 'getSignaturesForAddress':
        return answer({ result: first === fixture.vault ? fixture.signatures.slice(0, (second.limit as number) ?? 1000) : [] });
      case 'getTransaction': {
        const tx = fixture.transactions[first] ?? null;
        const max = second.maxSupportedTransactionVersion as number | undefined;
        if (tx && tx.version !== 'legacy' && (max === undefined || tx.version > max)) {
          return answer({ error: { code: -32015, message: `Transaction version (${tx.version}) is not supported by the requesting client.` } });
        }
        return answer({ result: tx });
      }
    }
    void third;
    return answer({ error: { code: -32601, message: 'not recorded' } });
  }) as typeof fetch;
}

/** The client's transport, through the route, to the recorded devnet. */
function through(fixture: Fixture, seen: Seen[] = [], options: { cluster?: Cluster; fail?: (call: Seen) => Response | null; deps?: Partial<RpcDeps> } = {}) {
  const deps: RpcDeps = {
    env: { RPC_DEVNET_URL: 'https://devnet.upstream.example/', PORTAL_ORIGIN: PORTAL },
    fetch: replay(fixture, seen, options.fail),
    log: () => {},
    now: () => 0,
    ...options.deps,
  };
  return portalTransport(options.cluster ?? 'devnet', {
    origin: PORTAL,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handleRpc(new Request(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), origin: PORTAL } }), deps)) as typeof fetch,
  });
}

const ok = <T>(read: Read<T>): T => {
  if (read.status !== 'ok') assert.fail(`unavailable: ${read.reason}`);
  return read.value;
};
const bytesOf = (row: { account: { data: [string, string] } }) => Uint8Array.from(Buffer.from(row.account.data[0], 'base64'));

// ─── Layouts ────────────────────────────────────────────────────────────────

test('the route and the client agree on the program and on where each account names its wallet', () => {
  assert.deepEqual(ROUTE_PROGRAM, LAZORKIT_PROGRAM);
  assert.deepEqual(ROUTE_WALLET_OFFSET, {
    [DISCRIMINATOR.authority]: WALLET_OFFSET.authority,
    [DISCRIMINATOR.session]: WALLET_OFFSET.session,
    [DISCRIMINATOR.deferred]: WALLET_OFFSET.deferred,
  });
});

test('the vault is derived from the wallet the way the program derives it', () => {
  for (const fixture of [WALLET, PAYMENTS, REPEAT]) {
    assert.equal(vaultAddress('devnet', fixture.wallet), fixture.vault);
    // The recorded history is that vault's: the program signs for it.
    assert.ok(fixture.signatures.length > 0);
  }
});

test('recorded v2 accounts decode: an Admin key, a passkey Owner, sessions with and without limits', () => {
  const [admin, owner] = WALLET.accounts.authority.value.map((row) => decodeAuthority(row.pubkey, bytesOf(row)));
  assert.equal(admin?.role, 'admin');
  assert.equal(admin?.key.type, 'ed25519');
  assert.equal(owner?.role, 'owner');
  assert.equal(owner?.key.type, 'passkey');
  assert.ok(owner?.key.type === 'passkey' && owner.key.credentialIdHash.length === 64 && owner.key.publicKey.length === 66 && owner.key.rpIdHash.length === 64);
  for (const authority of [admin, owner]) {
    assert.equal(authority?.wallet, WALLET.wallet);
    assert.equal(authority?.policy, null);
  }
  const sessions = WALLET.accounts.session.value.map((row) => decodeSession(row.pubkey, bytesOf(row)));
  assert.deepEqual(sessions.map((s) => s?.actions.length).sort(), [0, 51]);
  for (const session of sessions) {
    assert.equal(session?.wallet, WALLET.wallet);
    assert.ok((session?.expiresAtSlot ?? 0n) > 0n);
    assert.ok(addressBytes(session!.sessionKey));
  }
});

test('decoders accept only a v2 account of the current layout, policy and all', () => {
  const wallet = bs58.decode(WALLET.wallet);
  const spender = new Uint8Array(48 + 32 + 19);
  spender.set([0x22, 0, 2, 255, 1]);
  new DataView(spender.buffer).setUint16(12, 19, true);
  spender.set(wallet, 16);
  spender.set(new Uint8Array(32).fill(7), 48);
  spender.set([1, ...new Array(18).fill(3)], 80);
  const decoded = decodeAuthority('x', spender);
  assert.equal(decoded?.role, 'spender');
  assert.deepEqual(decoded?.policy, spender.slice(80));

  const variant = (patch: (data: Uint8Array) => Uint8Array) => decodeAuthority('x', patch(spender.slice()));
  assert.equal(variant((d) => ((d[4] = 2), d)), null, 'a newer layout version');
  assert.equal(variant((d) => ((d[0] = 0x02), d)), null, 'a v1 discriminator');
  assert.equal(variant((d) => ((d[2] = 3), d)), null, 'an unknown role');
  assert.equal(variant((d) => ((d[1] = 1), d)), null, 'a passkey too short for its key');
  assert.equal(variant((d) => d.slice(0, 90)), null, 'a policy longer than the account');

  const deferred = new Uint8Array(176);
  deferred.set([0x24, 1, 254]);
  deferred.set(wallet, 72);
  new DataView(deferred.buffer).setBigUint64(168, 123_456n, true);
  assert.equal(decodeDeferred('d', deferred)?.wallet, WALLET.wallet);
  assert.equal(decodeDeferred('d', deferred)?.expiresAtSlot, 123_456n);
  assert.equal(decodeDeferred('d', deferred.slice(0, 175)), null);
  assert.equal(decodeSession('s', deferred), null);
});

// ─── Wallet and vault reads ─────────────────────────────────────────────────

test('a wallet’s authorities, sessions and deferred executions, through the route', async () => {
  const seen: Seen[] = [];
  const accounts = ok(await readWalletAccounts(through(WALLET, seen), 'devnet', WALLET.wallet));
  assert.deepEqual(accounts.authorities.map((a) => a.role).sort(), ['admin', 'owner']);
  assert.equal(accounts.sessions.length, 2);
  assert.ok(accounts.sessions[0].expiresAtSlot <= accounts.sessions[1].expiresAtSlot);
  assert.equal(accounts.deferred.length, 0);
  assert.equal(accounts.unreadable, 0);
  assert.equal(accounts.slot, Math.min(...Object.values(WALLET.accounts).map((l) => l.context.slot)));
  assert.deepEqual(seen.map((s) => s.method), ['getProgramAccounts', 'getProgramAccounts', 'getProgramAccounts']);
});

test('an account of a newer layout is counted as unreadable, never guessed at', async () => {
  const newer = structuredClone(WALLET);
  const row = newer.accounts.session.value[0];
  const data = bytesOf(row);
  data[2] = 2;
  row.account.data[0] = Buffer.from(data).toString('base64');
  const accounts = ok(await readWalletAccounts(through(newer), 'devnet', WALLET.wallet));
  assert.equal(accounts.sessions.length, 1);
  assert.equal(accounts.unreadable, 1);
});

test('a vault’s SOL and token accounts, through the route', async () => {
  const holdings = ok(await readVault(through(PAYMENTS), PAYMENTS.vault));
  assert.equal(holdings.lamports, 0n);
  assert.deepEqual(
    holdings.tokens.map((t) => [t.mint, t.amount, t.decimals, t.program, t.delegate]).sort(),
    [
      ['2DnNu4i7o8Bns66chAkpjyx7iJGFQTwyJm1yUwKHuhfG', 999_600n, 0, 'token', null],
      ['HAKGtb5JLZqeFzrhGbtXZBgFBuwMXa3NNC1t9Pb3hFJ1', 999_999n, 0, 'token', null],
    ],
  );
  const funded = ok(await readVault(through(WALLET), WALLET.vault));
  assert.equal(funded.lamports, 1_000_000n);
  assert.equal(funded.tokens.length, 0);
});

test('a token delegate is reported with how much it may move', async () => {
  const delegated = structuredClone(PAYMENTS) as Fixture & { tokenAccounts: Record<string, { value: { account: { data: { parsed: { info: Record<string, unknown> } } } }[] }> };
  const info = delegated.tokenAccounts.TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.value[0].account.data.parsed.info;
  info.delegate = REPEAT.vault;
  info.delegatedAmount = { amount: '5000', decimals: 0, uiAmount: 5000, uiAmountString: '5000' };
  const holdings = ok(await readVault(through(delegated), PAYMENTS.vault));
  assert.deepEqual(holdings.tokens.find((t) => t.delegate)?.delegate, { address: REPEAT.vault, amount: 5000n });
});

test('reads say why they are unavailable, and never fill anything in', async () => {
  const notConfigured = through(PAYMENTS, [], { cluster: 'mainnet' });
  assert.deepEqual(await readVault(notConfigured, PAYMENTS.vault), { status: 'unavailable', reason: 'not-configured' });
  assert.deepEqual(await readWalletAccounts(notConfigured, 'mainnet', PAYMENTS.wallet), { status: 'unavailable', reason: 'not-configured' });
  assert.deepEqual(await readPaymentHistory(notConfigured, PAYMENTS.vault), { status: 'unavailable', reason: 'not-configured' });

  const busy = through(PAYMENTS, [], { fail: (call) => (call.method === 'getTokenAccountsByOwner' ? new Response('slow down', { status: 429 }) : null) });
  assert.deepEqual(await readVault(busy, PAYMENTS.vault), { status: 'unavailable', reason: 'rate-limited' });
  const down = through(PAYMENTS, [], { fail: () => new Response('bad gateway', { status: 502 }) });
  assert.deepEqual(await readWalletAccounts(down, 'devnet', PAYMENTS.wallet), { status: 'unavailable', reason: 'upstream' });
});

// ─── Payment history ────────────────────────────────────────────────────────

test('only successful, non-zero transfers out of the vault count: SOL and tokens, by the owner paid', async () => {
  const seen: Seen[] = [];
  const history = ok(await readPaymentHistory(through(PAYMENTS, seen), PAYMENTS.vault));
  assert.equal(history.coverage, 'complete');
  assert.equal(history.scanned, PAYMENTS.signatures.length);
  assert.equal(history.unattributed, 0);
  assert.deepEqual(
    history.transfers.map((t) => [t.to, t.asset.kind, t.amount]),
    [
      ['BJRfvkLaLEgnB8dWg6QJAekgdXM4MyRbdgrdwwqap3Wq', 'sol', 8_000_000n],
      ['4ueGfdwxqjVwKFBXBFP6cb1yJ61vaisJqCwgwkJ74x2k', 'token', 1n],
      ['GENXGu2z9TLBgtFhRquAYe5pY1q1uyNAvnZyi7B4niBW', 'sol', 1_000_000n],
      ['H3GisWPeMzv9iG9BZ7C2fvqA1qGtGYKpLtJDZXWk4Wck', 'sol', 1_000_000n],
      ['4ueGfdwxqjVwKFBXBFP6cb1yJ61vaisJqCwgwkJ74x2k', 'token', 400n],
    ],
  );
  // Failed transactions are not even read.
  const failed = new Set(PAYMENTS.signatures.filter((s) => s.err !== null).map((s) => s.signature));
  assert.ok(seen.filter((s) => s.method === 'getTransaction').every((s) => !failed.has(s.params[0] as string)));

  assert.deepEqual(relationTo('4ueGfdwxqjVwKFBXBFP6cb1yJ61vaisJqCwgwkJ74x2k', { status: 'ok', value: history }), {
    kind: 'paid',
    times: 2,
    lastBlockTime: PAYMENTS.signatures.find((s) => s.signature.startsWith('6547w29B'))!.blockTime,
    coverage: 'complete',
  });
  assert.deepEqual(
    paymentsTo(history, '4ueGfdwxqjVwKFBXBFP6cb1yJ61vaisJqCwgwkJ74x2k').map((t) => t.asset.kind === 'token' && t.asset.mint),
    ['HAKGtb5JLZqeFzrhGbtXZBgFBuwMXa3NNC1t9Pb3hFJ1', '2DnNu4i7o8Bns66chAkpjyx7iJGFQTwyJm1yUwKHuhfG'],
  );
  // Paid only in transactions that failed: the transfers in them never happened.
  for (const address of ['HXuwhdH2apaZmfhucRUL3DneGV2bTKhu6A7nvsra9J4L', '22e6J29XcCqUohDVpAE7uuJT1xfEEoeXdeZgp7cgg7KU']) {
    assert.deepEqual(relationTo(address, { status: 'ok', value: history }), { kind: 'first-time' }, address);
  }
});

test('a failed transaction’s transfers are ignored even when its record shows them', () => {
  let recordedTransfers = 0;
  for (const { signature, err } of [...PAYMENTS.signatures, ...REPEAT.signatures]) {
    if (err === null) continue;
    const fixture = signature in PAYMENTS.transactions ? PAYMENTS : REPEAT;
    const tx = fixture.transactions[signature];
    assert.notEqual(tx.meta.err, null);
    assert.deepEqual(vaultTransfers(fixture.vault, signature, tx), { transfers: [], unattributed: 0, counterparties: [] }, signature);
    // A failed transaction keeps the inner transfers it ran before failing;
    // marked successful, the same record would show a payment.
    const asIfSucceeded = vaultTransfers(fixture.vault, signature, { ...tx, meta: { ...tx.meta, err: null } });
    if (asIfSucceeded.transfers.length > 0) recordedTransfers++;
  }
  assert.ok(recordedTransfers >= 5, `${recordedTransfers} failed transactions with transfers in their record`);
});

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';

interface TokenMove {
  authority: string;
  source: string;
  sourceOwner?: string;
  destination: string;
  destinationOwner?: string;
  amount: string;
}

/** A successful jsonParsed transaction of `transferChecked`s, with the token balances an RPC would record. */
function tokenTx(mint: string, moves: TokenMove[], solMoves: { source: string; destination: string; lamports: number }[] = []) {
  const keys: string[] = [];
  const indexOf = (address: string) => (keys.includes(address) ? keys.indexOf(address) : keys.push(address) - 1);
  const balances = moves.flatMap((move) => [
    ...(move.sourceOwner ? [{ accountIndex: indexOf(move.source), mint, owner: move.sourceOwner, uiTokenAmount: { amount: '0' } }] : []),
    ...(move.destinationOwner ? [{ accountIndex: indexOf(move.destination), mint, owner: move.destinationOwner, uiTokenAmount: { amount: move.amount } }] : []),
  ]);
  const instructions = [
    ...moves.map((move) => ({
      programId: TOKEN_2022,
      parsed: { type: 'transferChecked', info: { source: move.source, destination: move.destination, authority: move.authority, mint, tokenAmount: { amount: move.amount, decimals: 0 } } },
    })),
    ...solMoves.map((move) => ({ programId: SYSTEM, parsed: { type: 'transfer', info: move } })),
  ];
  for (const move of moves) [move.authority, move.source, move.destination].forEach(indexOf);
  return {
    slot: 10,
    blockTime: 1_700_000_000,
    meta: { err: null, preTokenBalances: [], postTokenBalances: balances, innerInstructions: [] },
    transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions } },
  };
}

/** A fixed 32-byte address for synthetic transactions. */
const addr = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

test('a token transfer the vault did not sign is not a payment by it, even out of its own token account', () => {
  const vault = REPEAT.vault;
  const [vaultTokens, otherTokens, mint, delegate] = [addr(11), addr(12), addr(13), addr(14)];
  const recipient = '3krsWk9RKYSYfw5uTBtgcSFvyyGPHhvan1dndYMwWNDw';
  const moved = { source: vaultTokens, sourceOwner: vault, destination: otherTokens, destinationOwner: recipient, amount: '1' };

  // Moved by a delegate (a mint's permanent delegate, say): not a payment;
  // the address it went to is a counterparty.
  const byDelegate = vaultTransfers(vault, 'sig', tokenTx(mint, [{ ...moved, authority: delegate }]));
  assert.deepEqual(byDelegate, { transfers: [], unattributed: 0, counterparties: [recipient] });
  const history: Read<PaymentHistory> = { status: 'ok', value: { vault, coverage: 'complete', scanned: 1, ...byDelegate } };
  assert.deepEqual(checkRecipient(recipient, history).relation, { kind: 'first-time' });

  // Signed by the vault: a payment.
  const byVault = vaultTransfers(vault, 'sig', tokenTx(mint, [{ ...moved, authority: vault }]));
  assert.deepEqual(byVault.transfers.map((t) => [t.to, t.amount]), [[recipient, 1n]]);
});

test('zero-value transfers out and transfers in never count', async () => {
  const history = ok(await readPaymentHistory(through(WALLET), WALLET.vault));
  assert.equal(history.coverage, 'complete');
  assert.equal(history.transfers.length, 0);
  // This vault sent BJRfv… zero lamports many times, and received 0.001 SOL from it.
  const check = checkRecipient('BJRfvkLaLEgnB8dWg6QJAekgdXM4MyRbdgrdwwqap3Wq', { status: 'ok', value: history });
  assert.deepEqual(check.relation, { kind: 'first-time' });
});

test('counterparties: senders into the vault and recipients of zero-value transfers, never counted as paid', async () => {
  const wallet = ok(await readPaymentHistory(through(WALLET), WALLET.vault));
  // BJRfv… sent this vault 0.001 SOL and was sent zero lamports by it.
  assert.deepEqual(wallet.counterparties, ['BJRfvkLaLEgnB8dWg6QJAekgdXM4MyRbdgrdwwqap3Wq']);
  // In these two it also sent money in, and was paid.
  for (const fixture of [PAYMENTS, REPEAT]) {
    const history = ok(await readPaymentHistory(through(fixture), fixture.vault));
    assert.deepEqual(history.counterparties, ['BJRfvkLaLEgnB8dWg6QJAekgdXM4MyRbdgrdwwqap3Wq']);
  }

  const vault = REPEAT.vault;
  const [sender, theirTokens, vaultTokens, mint] = [addr(21), addr(22), addr(23), addr(24)];
  const dust = vaultTransfers(
    vault,
    'sig',
    tokenTx(mint, [{ authority: sender, source: theirTokens, sourceOwner: sender, destination: vaultTokens, destinationOwner: vault, amount: '1' }], [
      { source: addr(25), destination: vault, lamports: 1 },
      { source: vault, destination: addr(26), lamports: 0 },
    ]),
  );
  assert.deepEqual(dust, { transfers: [], unattributed: 0, counterparties: [sender, addr(25), addr(26)] });
});

test('the lookalike check compares counterparties too, without casting doubt on an address already paid', () => {
  const vault = REPEAT.vault;
  const paid = '7NDjLNCJ8F2ptQkVFdheXHbiYwuQM5TfLXwWzG6E8J92';
  const sentIn = 'BJRfvkLaLEgnB8dWg6QJAekgdXM4MyRbdgrdwwqap3Wq';
  const twinOfPaid = alter(paid, 3, -4);
  const history: Read<PaymentHistory> = {
    status: 'ok',
    value: {
      vault,
      coverage: 'complete',
      scanned: 3,
      transfers: [{ signature: 's', slot: 1, blockTime: 1, to: paid, asset: { kind: 'sol' }, amount: 1n }],
      unattributed: 0,
      // A look-alike of the address paid sent something in; so did sentIn.
      counterparties: [twinOfPaid, sentIn],
    },
  };

  // Like an address that only ever sent money in: a counterparty, never "paid".
  const likeSender = checkRecipient(alter(sentIn, 3, -4), history);
  assert.deepEqual(likeSender.relation, { kind: 'first-time' });
  assert.deepEqual(likeSender.lookalike, { status: 'found', level: 'danger', like: { address: sentIn, kind: 'counterparty' }, prefix: 3, suffix: 3 });

  // Paying the twin: it looks like the address paid.
  assert.deepEqual(checkRecipient(twinOfPaid, history).lookalike, { status: 'found', level: 'danger', like: { address: paid, kind: 'paid' }, prefix: 3, suffix: 3 });
  // Paying the address paid: the twin that sent something in is not held against it.
  assert.deepEqual(checkRecipient(paid, history).lookalike, { status: 'none' });
  // Nor against a saved address.
  const saved = alter(sentIn, 10);
  assert.deepEqual(checkRecipient(saved, history, { saved: [saved] }).lookalike, { status: 'none' });
});

test('v1 transactions are read: the client asks for version 1 once the RPC says it is needed', async () => {
  const seen: Seen[] = [];
  const history = ok(await readPaymentHistory(through(REPEAT, seen), REPEAT.vault, { concurrency: 1 }));
  assert.equal(history.coverage, 'complete');
  const versions = seen.filter((s) => s.method === 'getTransaction').map((s) => (s.params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion);
  assert.deepEqual(versions.slice(0, 2), [0, 1]);
  assert.ok(versions.slice(1).every((v) => v === 1));
  assert.equal(versions.length, REPEAT.signatures.filter((s) => s.err === null).length + 1);

  const parallel = ok(await readPaymentHistory(through(REPEAT), REPEAT.vault, { concurrency: 4 }));
  assert.deepEqual(parallel, history);
  // Paid twice in one transaction is paid once.
  assert.deepEqual(relationTo('5DqcveMrt8ww4j1Nmy3fK6kYCNoofDx61mC4bhXBRYMV', { status: 'ok', value: history }), {
    kind: 'paid',
    times: 1,
    lastBlockTime: REPEAT.signatures.find((s) => s.signature.startsWith('2D2BBkUn'))!.blockTime,
    coverage: 'complete',
  });
});

test('a short read says how far it went: "Not in your last N transactions"', async () => {
  const older = 'Fk7hcZhXVhbK8rG1JjNGHGPDvVJTKsUTvJUwAXjs7rGx'; // paid in the 19th newest transaction
  const recent = ok(await readPaymentHistory(through(REPEAT), REPEAT.vault, { maxSignatures: 5 }));
  assert.equal(recent.coverage, 'recent');
  assert.equal(recent.scanned, 5);
  assert.deepEqual(relationTo(older, { status: 'ok', value: recent }), { kind: 'not-in-recent', scanned: 5 });
  assert.equal(relationTo('4rFFHppGgw2yxxUnyJhuQffgtcB5rcu8TCY6m3etVhxm', { status: 'ok', value: recent }).kind, 'paid');

  // Three transactions read; the two failed ones after them need no read; the sixth was not read.
  const capped = ok(await readPaymentHistory(through(REPEAT), REPEAT.vault, { maxTransactions: 3 }));
  assert.deepEqual([capped.coverage, capped.scanned], ['recent', 5]);
  assert.deepEqual(relationTo('7NDjLNCJ8F2ptQkVFdheXHbiYwuQM5TfLXwWzG6E8J92', { status: 'ok', value: capped }), { kind: 'not-in-recent', scanned: 5 });
});

test('a short read never rules a lookalike out: the address it resembles may be just past the window', async () => {
  const older = 'Fk7hcZhXVhbK8rG1JjNGHGPDvVJTKsUTvJUwAXjs7rGx'; // paid in the 19th newest transaction
  const twin = alter(older, 3, -4);
  const whole = await readPaymentHistory(through(REPEAT), REPEAT.vault);
  assert.deepEqual(checkRecipient(twin, whole).lookalike, { status: 'found', level: 'danger', like: { address: older, kind: 'paid' }, prefix: 3, suffix: 3 });

  const recent = checkRecipient(twin, await readPaymentHistory(through(REPEAT), REPEAT.vault, { maxSignatures: 5 }));
  assert.deepEqual(recent.relation, { kind: 'not-in-recent', scanned: 5 });
  assert.deepEqual(recent.lookalike, { status: 'none-in-recent', scanned: 5 });
  assert.deepEqual(recent.scope, { coverage: 'recent', scanned: 5 });
});

test('"First time paying" only when every payment out names its recipient', () => {
  const vault = REPEAT.vault;
  const [vaultTokens, closedAccount, mint] = [addr(31), addr(32), addr(33)];
  // Paid out of the vault's token account into an account the transaction does not describe.
  const unnamed = vaultTransfers(vault, 'sig', tokenTx(mint, [{ authority: vault, source: vaultTokens, sourceOwner: vault, destination: closedAccount, amount: '5' }]));
  assert.deepEqual(unnamed, { transfers: [], unattributed: 1, counterparties: [] });

  const recipient = addr(34);
  const complete: PaymentHistory = { vault, coverage: 'complete', scanned: 1, ...unnamed };
  assert.deepEqual(relationTo(recipient, { status: 'ok', value: complete }), { kind: 'unknown', reason: 'unnamed-recipient' });
  assert.deepEqual(relationTo(recipient, { status: 'ok', value: { ...complete, coverage: 'recent' } }), { kind: 'not-in-recent', scanned: 1 });
  assert.deepEqual(relationTo(recipient, { status: 'ok', value: { ...complete, unattributed: 0 } }), { kind: 'first-time' });
});

test('a transaction that cannot be read ends the window there; payments found past it still count', async () => {
  const third = REPEAT.signatures[2].signature;
  const gap = through(REPEAT, [], { fail: (call) => (call.method === 'getTransaction' && call.params[0] === third ? new Response('bad gateway', { status: 502 }) : null) });
  const history = ok(await readPaymentHistory(gap, REPEAT.vault));
  assert.deepEqual([history.coverage, history.scanned], ['recent', 2]);
  assert.deepEqual(relationTo('4rFFHppGgw2yxxUnyJhuQffgtcB5rcu8TCY6m3etVhxm', { status: 'ok', value: history }), { kind: 'not-in-recent', scanned: 2 });
  assert.equal(relationTo('7NDjLNCJ8F2ptQkVFdheXHbiYwuQM5TfLXwWzG6E8J92', { status: 'ok', value: history }).kind, 'paid');

  const first = REPEAT.signatures[0].signature;
  const none = through(REPEAT, [], { fail: (call) => (call.method === 'getTransaction' && call.params[0] === first ? new Response('bad gateway', { status: 502 }) : null) });
  assert.deepEqual(await readPaymentHistory(none, REPEAT.vault), { status: 'unavailable', reason: 'upstream' });
});

test('over the route’s budget, the scan stops and says so; finalized transactions are not read twice', async () => {
  const tight = through(REPEAT, [], { deps: { limiter: new RateLimiter({ capacity: 5, refillPerSecond: 0, maxClients: 10 }) } });
  assert.deepEqual(await readPaymentHistory(tight, REPEAT.vault), { status: 'unavailable', reason: 'rate-limited' });

  const seen: Seen[] = [];
  const cached = through(REPEAT, seen, { deps: { cache: new MemoryCache() } });
  const once = ok(await readPaymentHistory(cached, REPEAT.vault, { concurrency: 1 }));
  const reads = seen.filter((s) => s.method === 'getTransaction').length;
  const again = ok(await readPaymentHistory(cached, REPEAT.vault, { concurrency: 1 }));
  assert.deepEqual(again, once);
  // The second scan re-lists signatures, starts at version 0 again (one refusal), and reads nothing else.
  assert.equal(seen.filter((s) => s.method === 'getTransaction').length, reads + 1);
});

// ─── Lookalikes ─────────────────────────────────────────────────────────────

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** `address` with the characters at `positions` moved one step down the alphabet (still a 32-byte address). */
function alter(address: string, ...positions: number[]): string {
  const chars = address.split('');
  for (const p of positions) {
    const at = p < 0 ? chars.length + p : p;
    const index = ALPHABET.indexOf(chars[at]);
    chars[at] = ALPHABET[index > 1 ? index - 1 : index + 1];
  }
  const altered = chars.join('');
  assert.ok(addressBytes(altered), `${altered} is not a 32-byte address`);
  return altered;
}

test('shared ends: 3 first and 3 last is danger, only the first 4 or the last 4 is caution, the same bytes is not a lookalike', () => {
  const paid = '7NDjLNCJ8F2ptQkVFdheXHbiYwuQM5TfLXwWzG6E8J92';
  const level = (other: string) => lookalikeLevel(compareAddresses(other, paid));
  assert.equal(level(alter(paid, 3, -4)), 'danger');
  assert.equal(level(alter(paid, 20)), 'danger', 'the same short form 7NDj…8J92');
  assert.equal(level(alter(paid, 4, -1)), 'caution');
  assert.equal(level(alter(paid, 0, -5)), 'caution');
  assert.equal(level(alter(paid, 3, -1)), null, '3 first only');
  assert.equal(level(alter(paid, 2, -3)), null, '2 first and 2 last');
  assert.equal(level(paid), null);
  assert.deepEqual(compareAddresses(alter(paid, 3, -4), paid), { same: false, prefix: 3, suffix: 3 });
  // Base58 is case-sensitive: one letter in another case is another address.
  const otherCase = paid.replace('ptQ', 'PtQ');
  assert.equal(compareAddresses(otherCase, paid).same, false);
});

test('the recipient check: relation and lookalike, against what this vault paid, its own addresses and saved ones', async () => {
  const history = await readPaymentHistory(through(REPEAT), REPEAT.vault);
  const paid = '7NDjLNCJ8F2ptQkVFdheXHbiYwuQM5TfLXwWzG6E8J92';

  const poisoned = checkRecipient(alter(paid, 3, -4), history);
  assert.deepEqual(poisoned.relation, { kind: 'first-time' });
  assert.deepEqual(poisoned.lookalike, { status: 'found', level: 'danger', like: { address: paid, kind: 'paid' }, prefix: 3, suffix: 3 });
  assert.deepEqual(poisoned.scope, { coverage: 'complete', scanned: REPEAT.signatures.length });

  assert.deepEqual(checkRecipient(paid, history).lookalike, { status: 'none' });
  assert.equal(checkRecipient(paid, history).relation.kind, 'paid');

  const likeOwn = checkRecipient(alter(REPEAT.vault, 10), history);
  assert.deepEqual(likeOwn.lookalike.status === 'found' && likeOwn.lookalike.like, { address: REPEAT.vault, kind: 'own' });
  assert.deepEqual(checkRecipient(REPEAT.vault, history).relation, { kind: 'own-account' });

  const saved = 'HrVut6CLmfWHX54okzrCHa5cbC5EPWA4FRqmYdPuE7ZH';
  const likeSaved = checkRecipient(alter(saved, 4, -1), { status: 'unavailable', reason: 'timeout' }, { saved: [saved] });
  assert.deepEqual(likeSaved.relation, { kind: 'unknown', reason: 'timeout' });
  assert.equal(likeSaved.lookalike.status === 'found' && likeSaved.lookalike.level, 'caution');
  assert.equal(likeSaved.scope, null);

  // With no history, no lookalike is ruled out.
  assert.deepEqual(checkRecipient(paid, { status: 'unavailable', reason: 'rate-limited' }).lookalike, { status: 'unknown', reason: 'rate-limited' });
  assert.deepEqual(checkRecipient('not an address', history).relation, { kind: 'unknown', reason: 'invalid-address' });

  // The whole read, as the pay screens call it.
  assert.deepEqual(await readRecipientCheck(through(REPEAT), REPEAT.vault, alter(paid, 3, -4)), poisoned);
});

test('the strongest lookalike wins: danger over caution, then the longer shared ends', () => {
  const a = '4rFFHppGgw2yxxUnyJhuQffgtcB5rcu8TCY6m3etVhxm';
  const b = '3krsWk9RKYSYfw5uTBtgcSFvyyGPHhvan1dndYMwWNDw';
  const recipient = alter(a, 3, -4);
  const caution = { address: alter(recipient, 4, -1), kind: 'saved' as const };
  const known = [caution, { address: a, kind: 'paid' as const }, { address: b, kind: 'paid' as const }];
  assert.equal(lookalikeLevel(compareAddresses(recipient, caution.address)), 'caution');
  assert.deepEqual(findLookalike(recipient, known), { status: 'found', level: 'danger', like: known[1], prefix: 3, suffix: 3 });
  const closer = { address: alter(recipient, 20), kind: 'own' as const };
  assert.equal(findLookalike(recipient, [...known, closer])?.like, closer);
  assert.equal(findLookalike(b, known), null);
});

// ─── The transport ──────────────────────────────────────────────────────────

test('every failure of the route becomes a reason', async () => {
  const answering = (response: () => Response | Promise<Response>) => portalTransport('devnet', { origin: PORTAL, fetchImpl: (async () => response()) as typeof fetch });
  const rpcError = (status: number, code = -32603) => () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: 'x' } }), { status });
  const cases: [string, () => Response | Promise<Response>][] = [
    ['not-configured', rpcError(503)],
    ['rate-limited', rpcError(429, -32005)],
    ['timeout', rpcError(504)],
    ['upstream', rpcError(502)],
    ['refused', rpcError(400, -32600)],
    ['refused', rpcError(403, -32600)],
    ['upstream', rpcError(200, -32015)],
    ['malformed', () => new Response('{"jsonrpc":"2.0","id":1}')],
    ['malformed', () => new Response('<html>')],
    ['network', () => Promise.reject(new TypeError('fetch failed'))],
  ];
  for (const [reason, response] of cases) {
    await assert.rejects(answering(response)('getBalance', []), (error: { reason: string }) => error.reason === reason, reason);
  }
  const versionError = await answering(rpcError(200, -32015))('getTransaction', []).catch((e: { code: number }) => e.code);
  assert.equal(versionError, -32015);
});

test('nothing here holds an RPC URL: the page only ever calls its own route', async () => {
  const urls: string[] = [];
  const transport = portalTransport('mainnet', { origin: PORTAL, fetchImpl: (async (input: RequestInfo | URL) => (urls.push(String(input)), new Response('{"jsonrpc":"2.0","id":1,"result":1}'))) as typeof fetch });
  await transport('getBalance', [REPEAT.vault]);
  assert.deepEqual(urls, [`${PORTAL}/api/rpc?cluster=mainnet`]);
  const sources = ['transport', 'layout', 'reads', 'history', 'recipient', 'index'].map((f) => readFileSync(new URL(`../src/chain/${f}.ts`, import.meta.url), 'utf8'));
  assert.ok(sources.every((s) => !/https?:\/\/(?!localhost)[^\s'"`]*(rpc|solana|helius)/i.test(s)));
});

// Types the history exposes are stable for the screens.
const _shape: (h: PaymentHistory) => number = (h) => h.scanned;
void _shape;
