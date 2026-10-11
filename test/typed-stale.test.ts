// Typed requests against an RPC behind a load balancer, where some nodes lag:
// an answer that is behind (it refuses the floor slot, or its Clock is old
// under a current context slot) is read again and never refuses a request as
// invalid; only two fresh answers in a row can. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlEncode, type ApprovalRequest } from '../src/approval/index.ts';
import { portalTransport, RpcReadError } from '../src/chain/transport.ts';
import { MAX_CLOCK_SKEW_SLOTS, READ_RETRY_DELAYS_MS, readDeploySlot, readFloor, readSnapshot, readTypedChain, type ReadOptions } from '../src/typed/reads.ts';
import { needsHoldings } from '../src/typed/screen.ts';
import { addr, CONFIG, NOW, passkeyAuthority, PROGRAM, sample, SLOT, world, type World } from './typed-fixtures.ts';

const createArgs = () => ({ sessionKey: addr(), expiresAt: (NOW + 3n * 3600n).toString(), actions: base64urlEncode(sample.solLimit(20_000_000n)) });

/** Reads with the default pauses, recorded instead of slept. */
function reader(w: World, extra: Partial<ReadOptions> = {}) {
  const slept: number[] = [];
  const run = () => readTypedChain(w.chain.transport, w.req, { config: CONFIG, needsHoldings, sleep: async (ms) => void slept.push(ms), ...extra });
  return { run, slept };
}

/** The `getMultipleAccounts` calls for the request's own state (the deploy read excluded), with the floor each asked for. */
const stateReads = (w: World) =>
  w.chain.calls
    .filter((c) => c.method === 'getMultipleAccounts' && (c.params[0] as string[])[0] === w.wallet)
    .map((c) => (c.params[1] as { minContextSlot?: number }).minContextSlot);

/** What the lagging node returned on devnet: the Clock ~48k slots back, the new wallet absent, under a current context slot. */
const lagging = (w: World) => ({ clockSlot: SLOT - 48_000n, missing: [w.wallet, w.authority] });

test('every read is asked of a node at or past the request: preparedSlot, minContextSlot, the newest slot seen', async () => {
  const w = world('createSession', createArgs());
  assert.equal(readFloor(w.req), Number(SLOT - 5n), 'preparedSlot');
  assert.equal(readFloor({ ...w.req, minContextSlot: Number(SLOT - 2n) }), Number(SLOT - 2n));
  assert.equal(readFloor(w.req, Number(SLOT)), Number(SLOT), 'the newest slot seen');
  assert.equal(readFloor({ ...w.req, preparedSlot: 1n << 60n }), 0, 'a slot past 2^53 is no floor');
  const r = await reader(w).run();
  assert.ok(r.ok);
  const reads = w.chain.calls.filter((c) => c.method === 'getMultipleAccounts');
  assert.equal(reads.length, 2, 'the binary, then the state');
  for (const c of reads) assert.equal((c.params[1] as { minContextSlot?: number }).minContextSlot, Number(SLOT - 5n));
  for (const c of reads) assert.ok((c.params[0] as string[]).includes('SysvarC1ock11111111111111111111111111111111'), 'the Clock is in every read');
  // A page that has seen a newer slot asks for at least that one.
  const later = world('createSession', createArgs());
  later.chain.setClock(SLOT + 50n, NOW);
  assert.ok((await reader(later, { observedSlot: Number(SLOT + 40n) }).run()).ok);
  assert.deepEqual(stateReads(later), [Number(SLOT + 40n)]);
});

test('a stale Clock under a current context slot is read again, then shown', async () => {
  const w = world('createSession', createArgs());
  w.chain.lag = [{}, lagging(w), lagging(w)];
  const { run, slept } = reader(w);
  const r = await run();
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.reason}`);
  assert.equal(r.view.clock.slot, SLOT);
  assert.deepEqual(slept, [READ_RETRY_DELAYS_MS[0], READ_RETRY_DELAYS_MS[1]]);
  assert.equal(stateReads(w).length, 3);
});

test('a Clock far from the context slot is behind even without a floor', async () => {
  const w = world('revokeSession', { session: addr(), refund: addr() });
  // A request whose preparedSlot is long past: the floor is no help, the context slot is.
  const req = { ...w.req, preparedSlot: 1n } as ApprovalRequest;
  const old = SLOT - MAX_CLOCK_SKEW_SLOTS - 1n;
  w.chain.lag = [{}, ...Array(READ_RETRY_DELAYS_MS.length + 1).fill({ clockSlot: old, missing: [w.wallet] })];
  const r = await readTypedChain(w.chain.transport, req, { config: CONFIG, sleep: async () => {} });
  assert.equal(!r.ok && r.code, 'chain-unavailable');
  // Within the bound it is an answer like any other.
  const near = world('revokeSession', { session: addr(), refund: addr() });
  near.chain.lag = [{}, { clockSlot: SLOT - MAX_CLOCK_SKEW_SLOTS, missing: [near.wallet] }, { missing: [near.wallet] }];
  const refused = await readTypedChain(near.chain.transport, { ...near.req, preparedSlot: 1n } as ApprovalRequest, { config: CONFIG, sleep: async () => {} });
  assert.equal(!refused.ok && refused.code, 'request-invalid');
});

test('answers that stay behind end in chain-unavailable (Try again), never request-invalid', async () => {
  for (const lag of ['min-context-slot', 'stale'] as const) {
    const w = world('createSession', createArgs());
    w.chain.lag = [{}, ...Array(20).fill(lag === 'stale' ? lagging(w) : 'min-context-slot')];
    const { run, slept } = reader(w);
    const r = await run();
    assert.equal(!r.ok && r.code, 'chain-unavailable', lag);
    assert.deepEqual(slept, [...READ_RETRY_DELAYS_MS], 'a few reads with backoff');
    assert.ok(slept.reduce((a, b) => a + b, 0) <= 10_000, 'within about 10 s');
    assert.equal(stateReads(w).length, READ_RETRY_DELAYS_MS.length + 1);
  }
});

test('"minimum context slot not reached" from the upstream is behind: read again, then shown', async () => {
  const w = world('removeAuthority', { target: addr(), refund: addr() });
  const target = (w.req as Extract<ApprovalRequest, { kind: 'removeAuthority' }>).args.target;
  w.chain.set(target, PROGRAM, passkeyAuthority({ wallet: w.wallet, credentialId: new Uint8Array(24).fill(7), role: 2 }));
  w.chain.lag = [{}, 'min-context-slot', 'min-context-slot', {}];
  const r = await reader(w).run();
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.reason}`);
  // Through the portal's route, the upstream's -32016 (in a 200, or with an HTTP error) reads as behind.
  for (const status of [200, 500]) {
    const transport = portalTransport('devnet', {
      origin: 'https://portal.example',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'Minimum context slot has not been reached', data: { contextSlot: 1 } } }), { status })) as typeof fetch,
    });
    await assert.rejects(transport('getMultipleAccounts', []), (e: unknown) => e instanceof RpcReadError && e.reason === 'behind' && e.code === -32016);
  }
  const byText = portalTransport('devnet', {
    origin: 'https://portal.example',
    fetchImpl: (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Minimum context slot has not been reached' } }))) as typeof fetch,
  });
  await assert.rejects(byText('getMultipleAccounts', []), (e: unknown) => e instanceof RpcReadError && e.reason === 'behind');
});

test('an account missing from the first fresh answer and present in the next is shown', async () => {
  const w = world('createSession', createArgs());
  w.chain.lag = [{}, { missing: [w.wallet] }];
  const { run, slept } = reader(w);
  const r = await run();
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.reason}`);
  assert.equal(slept.length, 1);
  const floors = stateReads(w);
  assert.equal(floors.length, 2);
  assert.equal(floors[1], Number(SLOT), 'the second read is asked at or past the first answer');
});

test('an account absent from two fresh answers in a row is request-invalid', async () => {
  const w = world('createSession', createArgs());
  w.chain.accounts.delete(w.wallet);
  const { run, slept } = reader(w);
  const r = await run();
  assert.equal(!r.ok && r.code, 'request-invalid');
  assert.equal(!r.ok && r.reason, "The account it names isn't a LazorKit account on this network.");
  assert.deepEqual(slept, [READ_RETRY_DELAYS_MS[0]]);
  assert.deepEqual(stateReads(w), [Number(SLOT - 5n), Number(SLOT)]);
  // A stale answer between the two fresh ones changes nothing: the refusal waits for a fresh one.
  const v = world('revokeSession', { session: addr(), refund: addr() });
  v.chain.lag = [{}, {}, lagging(v), {}];
  const gone = await reader(v).run();
  assert.equal(!gone.ok && gone.code, 'request-invalid');
  assert.equal(!gone.ok && gone.reason, "The permission to stop doesn't exist.");
  assert.equal(stateReads(v).length, 3);
  // One fresh refusal, then only stale answers: unavailable, not invalid.
  const u = world('createSession', createArgs());
  u.chain.accounts.delete(u.wallet);
  u.chain.lag = [{}, {}, ...Array(10).fill(lagging(u))];
  const unsure = await reader(u).run();
  assert.equal(!unsure.ok && unsure.code, 'chain-unavailable');
});

test('the binary is read fresh: a stale answer is read again; one that stays behind is chain-unavailable, not another binary', async () => {
  const w = world('createSession', createArgs());
  w.chain.lag = [{ clockSlot: SLOT - 48_000n }, {}];
  assert.equal(await readDeploySlot(w.chain.transport, PROGRAM, { minContextSlot: readFloor(w.req), sleep: async () => {} }), CONFIG.lastDeploySlot);
  w.chain.lag = Array(10).fill({ clockSlot: SLOT - 48_000n });
  await assert.rejects(readDeploySlot(w.chain.transport, PROGRAM, { minContextSlot: readFloor(w.req), sleep: async () => {} }), (e: unknown) => e instanceof RpcReadError && e.reason === 'behind');
  // The page's cached deploy read failing: unavailable (Try again), not wrong-network.
  const failed = await readTypedChain(w.chain.transport, w.req, { config: CONFIG, deploySlot: () => Promise.reject(new RpcReadError('behind', 'behind')) });
  assert.equal(!failed.ok && failed.code, 'chain-unavailable');
  w.chain.lag = [...Array(10).fill({ clockSlot: SLOT - 48_000n })];
  const r = await reader(w).run();
  assert.equal(!r.ok && r.code, 'chain-unavailable');
});

test('snapshots: a stale answer throws (it ages out), never "the passkey is gone"', async () => {
  const w = world('createSession', createArgs());
  w.chain.lag = [{ clockSlot: SLOT - 48_000n, missing: [w.authority] }];
  await assert.rejects(readSnapshot(w.chain.transport, w.req, () => 0), (e: unknown) => e instanceof RpcReadError && e.reason === 'behind');
  w.chain.lag = ['min-context-slot'];
  await assert.rejects(readSnapshot(w.chain.transport, w.req, () => 0), (e: unknown) => e instanceof RpcReadError && e.reason === 'behind');
  // Asked at or past the newest slot seen: a node behind it is refused by the RPC itself.
  await assert.rejects(readSnapshot(w.chain.transport, w.req, () => 0, Number(SLOT + 1n)));
  const snap = await readSnapshot(w.chain.transport, w.req, () => 0, Number(SLOT));
  assert.equal(snap?.slot, SLOT);
  assert.equal((w.chain.calls.at(-1)?.params[1] as { minContextSlot?: number }).minContextSlot, Number(SLOT));
  // A fresh answer without the authority: gone.
  w.chain.accounts.delete(w.authority);
  assert.equal(await readSnapshot(w.chain.transport, w.req, () => 0), null);
});
