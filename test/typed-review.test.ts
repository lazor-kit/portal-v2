// One typed review's reads: the page evaluates the request again on every
// message from the app (the SDK syncs credentials at 500, 700, 900, 1300,
// 2000 and 3500 ms), and each evaluation is a new but identical request.
// Showing it again must read nothing: one full read, then a snapshot a
// second. Run with `pnpm test`.
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalChallenge } from '../src/approval/challenge.ts';
import { base64urlEncode, decodeApprovalRequest, encodeApprovalRequest, type ApprovalRequest } from '../src/approval/index.ts';
import { SNAPSHOT_INTERVAL_MS } from '../src/typed/approve.ts';
import { RpcReadError } from '../src/chain/transport.ts';
import { CLOCK_SYSVAR } from '../src/typed/reads.ts';
import { newPageReads, requestKey, TypedReview } from '../src/typed/review.ts';
import { addr, CONFIG, NOW, sample, SLOT, world, type World } from './typed-fixtures.ts';

/** When @lazorkit/wallet posts SYNC_CREDENTIALS, in ms after the dialog opens. */
const SDK_SYNCS_MS = [500, 700, 900, 1300, 2000, 3500];
const STEP_MS = 50;

/** The request as a re-render produces it: decoded again from the same fragment. */
const reparsed = (req: ApprovalRequest): ApprovalRequest => {
  const decoded = decodeApprovalRequest(encodeApprovalRequest(req));
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.request;
};

/** A createSession with a per-payment SOL limit and no total: the screen needs the vault's holdings too. */
const noTotal = () => world('createSession', { sessionKey: addr(), expiresAt: (NOW + 900n).toString(), actions: base64urlEncode(sample.solMax(2_000_000n)) });

/** The reads, sorted: the full read (it starts with the wallet), the snapshot (the authority and the Clock), the vault's holdings. */
function readsOf(w: World) {
  const multiple = w.chain.calls.filter((c) => c.method === 'getMultipleAccounts').map((c) => c.params[0] as string[]);
  return {
    total: w.chain.calls.length,
    full: multiple.filter((keys) => keys[0] === w.wallet).length,
    snapshots: multiple.filter((keys) => keys.length === 2 && keys[0] === w.authority && keys[1] === CLOCK_SYSVAR).length,
    deploy: multiple.filter((keys) => keys[0] === CONFIG.programId).length,
    balance: w.chain.calls.filter((c) => c.method === 'getBalance').length,
    tokenAccounts: w.chain.calls.filter((c) => c.method === 'getTokenAccountsByOwner').length,
  };
}

let clock = 0;
beforeEach(() => {
  clock = 0;
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
});
afterEach(() => mock.timers.reset());

/** Every pending answer, after the timers due by now. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `ms` of page time, in steps, calling `at(t)` at each step first. */
async function run(ms: number, at: (t: number) => void = () => {}) {
  const end = clock + ms;
  while (clock < end) {
    at(clock);
    await settle();
    clock += STEP_MS;
    mock.timers.tick(STEP_MS);
    await settle();
  }
}

function review(w: World) {
  const r = new TypedReview({ transportFor: () => w.chain.transport, configFor: () => CONFIG, now: () => clock, page: newPageReads() });
  const changes: string[] = [];
  r.subscribe(() => changes.push(`${r.getView().state.phase}${r.getView().canSign ? '+sign' : ''}`));
  return { r, changes };
}

test('one review, while the app syncs credentials six times: one full read, then a snapshot a second', async () => {
  const w = noTotal();
  const { r, changes } = review(w);
  r.show(w.req);
  // Each SDK message re-renders the page: the request is shown again, a new object each time.
  await run(6000, (t) => {
    if (SDK_SYNCS_MS.includes(t)) r.show(reparsed(w.req));
  });
  const reads = readsOf(w);
  assert.equal(reads.deploy, 1, 'the binary, once');
  assert.equal(reads.full, 1, 'the request, once');
  assert.equal(reads.balance, 1, "the vault's holdings, once");
  assert.equal(reads.tokenAccounts, 2, 'token and token-2022 accounts, once each');
  // One when the screen is ready, then one each SNAPSHOT_INTERVAL_MS.
  assert.ok(reads.snapshots >= 6 && reads.snapshots <= 6000 / SNAPSHOT_INTERVAL_MS + 1, `snapshots ${reads.snapshots}`);
  assert.equal(reads.total, reads.deploy + reads.full + reads.balance + reads.tokenAccounts + reads.snapshots, 'nothing else is read');
  assert.ok(reads.full <= 2, 'at most two full reads per review');
  // The screen went loading → ready → Approve on, once: no reloads, no re-arming.
  assert.deepEqual(changes, ['ready', 'ready+sign']);
  r.dispose();
});

test('the same request again is a no-op; another request, or Try again, reads afresh', async () => {
  const w = noTotal();
  const { r } = review(w);
  r.show(w.req);
  await run(1000);
  const before = readsOf(w);
  assert.equal(requestKey(reparsed(w.req)), requestKey(w.req), 'a re-parsed request has the same identity');
  r.show(reparsed(w.req));
  await run(STEP_MS);
  assert.equal(readsOf(w).full, before.full, 'shown again: no read');

  // Another request (one field changed): a new read, and the old snapshot is not signed from.
  const other = reparsed({ ...w.req, preparedSlot: w.req.preparedSlot + 1n });
  assert.notEqual(requestKey(other), requestKey(w.req));
  r.show(other);
  assert.equal(r.getView().state.phase, 'loading');
  assert.deepEqual(r.bind(), { kind: 'wait', reason: 'no-snapshot' }, 'nothing to sign until the new request is read');
  await run(STEP_MS * 2);
  assert.equal(readsOf(w).full, before.full + 1, 'another request is read');

  r.retry();
  await run(STEP_MS * 2);
  assert.equal(readsOf(w).full, before.full + 2, 'Try again reads afresh');

  // The screen closes: nothing more is read.
  r.show(null);
  const closed = readsOf(w).total;
  await run(3000);
  assert.equal(readsOf(w).total, closed);
  r.dispose();
});

test('Approve binds from the latest snapshot, and the challenge is recomputed with its slot and counter', async () => {
  const w = noTotal();
  const { r } = review(w);
  assert.deepEqual(r.bind(), { kind: 'wait', reason: 'no-snapshot' });
  r.show(w.req);
  await run(1500, (t) => {
    if (SDK_SYNCS_MS.includes(t)) r.show(reparsed(w.req));
  });
  assert.equal(r.getView().canSign, true);
  w.chain.setClock(SLOT + 3n, NOW + 1n);
  await run(SNAPSHOT_INTERVAL_MS + STEP_MS);
  const bound = r.bind();
  assert.equal(bound.kind, 'sign');
  if (bound.kind !== 'sign') return;
  assert.equal(bound.binding.slot, SLOT + 3n, 'the slot of the latest snapshot');
  assert.equal(bound.binding.counter, w.req.counter);
  assert.deepEqual(bound.binding.challenge, approvalChallenge(w.req, { slot: SLOT + 3n, counter: w.req.counter }));
  r.dispose();
});

test('a refusal from the snapshots stays until Try again: re-rendering the same request does not read it again', async () => {
  const w = noTotal();
  const { r } = review(w);
  r.show(w.req);
  await run(500);
  assert.equal(r.getView().state.phase, 'ready');
  // The network can't be read for longer than MAX_BEHIND_MS (a rate limit, say).
  w.chain.failWith = new RpcReadError('rate-limited', '429');
  await run(12_000, (t) => {
    if (t % 1000 === 0) r.show(reparsed(w.req));
  });
  const state = r.getView().state;
  assert.equal(state.phase, 'refused');
  assert.equal(state.phase === 'refused' && state.code, 'chain-unavailable');
  assert.equal(r.getView().canSign, false);
  assert.equal(r.bind().kind, 'wait', 'nothing binds on a refused screen');
  const reads = readsOf(w);
  assert.equal(reads.full, 1, 'no read restarts while refused');
  const calls = w.chain.calls.length;
  await run(3000, () => r.show(reparsed(w.req)));
  assert.equal(w.chain.calls.length, calls, 'refused: nothing more is read');
  // Try again reads afresh, and the screen is ready again.
  w.chain.failWith = null;
  r.retry();
  await run(500);
  assert.equal(r.getView().state.phase, 'ready');
  assert.equal(readsOf(w).full, 2);
  r.dispose();
});
