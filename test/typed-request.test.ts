// Typed requests on the portal (DESIGN §3): the fragment, the checks on load,
// every refusal code, the chain reads, and the slot and counter picked at
// Approve. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { addressBytes, approvalChallenge, base64urlEncode, readApprovalFragment, sessionAddress, vaultAddressOf, type ApprovalRequest } from '../src/approval/index.ts';
import { parsePolicy, parseRegistry } from '../src/security/config.ts';
import { readPortalRequest } from '../src/security/params.ts';
import { messageFor, redirectUrlFor } from '../src/security/reply.ts';
import { evaluateRequest } from '../src/security/request.ts';
import { refusalScreen, SIGNED_NOTHING } from '../src/security/refusal-screen.ts';
import type { Requester } from '../src/security/requester.ts';
import { bindAtApprove, MAX_BEHIND_MS, MAX_SNAPSHOT_AGE_MS, snapshotVerdict, typedReply } from '../src/typed/approve.ts';
import { captureFragment, capturedFragment, fragmentTampered, onFragmentTampered } from '../src/typed/fragment.ts';
import { parsePrograms } from '../src/typed/programs.ts';
import { readSnapshot, readTypedChain } from '../src/typed/reads.ts';
import { checkTypedRequest } from '../src/typed/request.ts';
import { needsHoldings } from '../src/typed/screen.ts';
import { addr, CONFIG, passkeyAuthority, sample, DEVNET_USDC, ed25519Authority, fragmentOf, mintData, NOW, PROGRAM, sessionData, SLOT, TOKEN, world } from './typed-fixtures.ts';

const policy = parsePolicy(JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/portal-policy.json', import.meta.url), 'utf8')));
const registry = parseRegistry({ version: 1, apps: [{ id: 'fernway', name: 'Fernway', origins: ['https://www.fernway.example'] }] });
const requester: Requester = { channel: 'iframe', origin: 'https://www.fernway.example', evidence: 'ancestor-origins', embeddedIn: [], openedFrom: null, conflict: false, unsupported: false } as unknown as Requester;

const createArgs = (actions = sample.solLimit(20_000_000n), expiresAt = NOW + 3n * 3600n) => ({ sessionKey: addr(), expiresAt: expiresAt.toString(), actions: base64urlEncode(actions) });
const read = (w: ReturnType<typeof world>, config = CONFIG) => readTypedChain(w.chain.transport, w.req, { config, needsHoldings, sleep: async () => {}, floorWaitMs: 0 });

function evaluate(w: ReturnType<typeof world>, fragment: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams({ action: 'sign', message: w.query.message, credentialId: w.query.credentialId, transaction: '', ...query });
  const request = readPortalRequest(`?${search}`);
  return evaluateRequest({ request, requester, registry, policy, typed: { fragment: readApprovalFragment(fragment), urlLength: 500 } });
}

test('on load: a typed request that recomputes to the message is shown, signed at Approve (no bytes from the URL)', () => {
  const w = world('createSession', createArgs());
  const e = evaluate(w, fragmentOf(w.json));
  assert.equal(e.subject?.kind, 'typed');
  assert.equal(e.decision.outcome, 'show');
  assert.equal(e.signBytes, null, 'nothing to sign until Approve picks the slot');
  assert.ok(e.credential);
});

test('on load: every refusal before the chain is read', () => {
  const w = world('createSession', createArgs());
  const reason = (fragment: string, query?: Record<string, string>) => {
    const e = evaluate(w, fragment, query);
    return e.decision.outcome === 'refuse' ? e.decision.reason : 'shown';
  };
  // The fragment form: #/?lk1= only (the live portal's router needs the path).
  assert.equal(reason(fragmentOf(w.json).replace('#/?', '#')), 'typed-malformed');
  assert.equal(reason(`${fragmentOf(w.json)}&open_in_browser=true`), 'typed-malformed');
  assert.equal(reason('#/?lk1=%%%'), 'typed-malformed');
  assert.equal(reason(fragmentOf({ ...w.json, label: 'Fernway' })), 'typed-malformed');
  assert.equal(reason(fragmentOf({ ...w.json, v: 2 })), 'typed-unsupported');
  assert.equal(reason(fragmentOf({ ...w.json, kind: 'execute' })), 'typed-unsupported');
  assert.equal(reason(`#/?lk1=${'A'.repeat(8193)}`), 'typed-malformed', 'over the cap');
  // The query the SDK sends with it.
  assert.equal(reason(fragmentOf(w.json), { transaction: 'AQID' }), 'typed-malformed');
  assert.equal(reason(fragmentOf(w.json), { message: Buffer.from(randomBytes(31)).toString('base64') }), 'typed-malformed');
  assert.equal(reason(fragmentOf(w.json), { action: 'connect' }), 'typed-malformed');
  // Mismatches: what is shown is not what the message signs.
  assert.equal(reason(fragmentOf(w.json), { credentialId: Buffer.from(randomBytes(24)).toString('base64') }), 'challenge-mismatch');
  assert.equal(reason(fragmentOf({ ...w.json, authority: addr() })), 'challenge-mismatch');
  assert.equal(reason(fragmentOf({ ...w.json, preparedSlot: (SLOT - 4n).toString() })), 'challenge-mismatch', 'preparedSlot is not the message slot');
  assert.equal(reason(fragmentOf({ ...w.json, counter: 8 })), 'challenge-mismatch');
  assert.equal(reason(fragmentOf({ ...w.json, args: { ...(w.json.args as object), actions: base64urlEncode(sample.solLimit(20_000_001n)) } })), 'challenge-mismatch');
  assert.equal(reason(fragmentOf({ ...w.json, minContextSlot: Number(SLOT) + 2000 })), 'typed-malformed');
  // A present-but-bad fragment never falls back to the legacy screen.
  const legacy = evaluate(w, '');
  assert.equal(legacy.subject?.kind, 'approval', 'without a fragment, the bare challenge is the legacy approval');
  assert.notEqual(evaluate(w, '#lk1=x').subject?.kind, 'approval');
});

test('checkTypedRequest: the URL cap', () => {
  const w = world('revokeSession', { session: addr(), refund: addr() });
  const r = checkTypedRequest({ kind: 'value', value: fragmentOf(w.json).slice(7) }, w.query, 16_385);
  assert.equal(!r.ok && r.code, 'typed-malformed');
});

test('an app registered without program challenges may not send typed requests either', () => {
  const w = world('createSession', createArgs());
  const denied = parseRegistry({ version: 1, apps: [{ id: 'fernway', name: 'Fernway', origins: ['https://www.fernway.example'], programChallenges: false }] });
  const search = new URLSearchParams({ action: 'sign', message: w.query.message, credentialId: w.query.credentialId, transaction: '' });
  const e = evaluateRequest({ request: readPortalRequest(`?${search}`), requester, registry: denied, policy, typed: { fragment: readApprovalFragment(fragmentOf(w.json)), urlLength: 1 } });
  assert.deepEqual(e.decision, { outcome: 'refuse', reason: 'kind-denied' });
});

test('read once: the fragment is removed at load, and a later hashchange is tampering', () => {
  const w = world('createSession', createArgs());
  const events: Record<string, () => void> = {};
  const replaced: string[] = [];
  const win = {
    location: { hash: fragmentOf(w.json), href: `https://portal.lazor.sh/?action=sign${fragmentOf(w.json)}`, pathname: '/', search: '?action=sign' },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    addEventListener: (name: string, fn: () => void) => (events[name] = fn),
  } as unknown as Window;
  captureFragment(win);
  assert.equal(capturedFragment().fragment.kind, 'value');
  assert.deepEqual(replaced, ['/?action=sign#/'], 'removed from the address bar, query kept');
  let told = 0;
  onFragmentTampered(() => told++);
  assert.equal(fragmentTampered(), false);
  events.hashchange();
  assert.equal(fragmentTampered(), true);
  assert.equal(told, 1);
});

test('programs.json: strict, and the committed file describes devnet as it runs today (the #57 binary, with time-expiry)', async () => {
  const committed = parsePrograms(JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/programs.json', import.meta.url), 'utf8')));
  assert.equal(committed.devnet?.programId, PROGRAM);
  assert.equal(committed.devnet?.lastDeploySlot, 509609649);
  assert.deepEqual(committed.devnet?.features, ['wallet-bound-challenge', 'd13', 'nonowner-invariants', 'time-expiry']);
  assert.equal(committed.mainnet, undefined);
  assert.throws(() => parsePrograms({ devnet: { ...CONFIG, programId: addr() } }));
  assert.throws(() => parsePrograms({ testnet: CONFIG }));
  assert.throws(() => parsePrograms({ devnet: { ...CONFIG, features: ['d14'] } }));
  assert.throws(() => parsePrograms({ devnet: { ...CONFIG, extra: 1 } }));
});

test('wrong-network: no config, another program, a binary other than the configured one, or a missing feature', async () => {
  const w = world('createSession', createArgs());
  const none = await readTypedChain(w.chain.transport, w.req, { config: undefined });
  assert.equal(!none.ok && none.code, 'wrong-network');
  const other = await read(w, { ...CONFIG, lastDeploySlot: 1 });
  assert.equal(!other.ok && other.code, 'wrong-network', 'devnet still runs #56: typed createSession stays refused');
  const noTime = await read(w, { ...CONFIG, features: ['wallet-bound-challenge', 'd13', 'nonowner-invariants'] });
  assert.equal(!noTime.ok && noTime.code, 'wrong-network');
  // Revoke and remove are shown on an unknown binary, without its claims.
  const sessionKey = addr();
  const r = world('revokeSession', { session: addr(), refund: addr() });
  r.chain.set((r.req as Extract<ApprovalRequest, { kind: 'revokeSession' }>).args.session, PROGRAM, sessionData({ wallet: r.wallet, sessionKey, expiresAt: NOW + 100n }));
  const shown = await read(r, { ...CONFIG, lastDeploySlot: 1 });
  assert.ok(shown.ok && shown.view.binary === 'unknown' && shown.view.features.size === 0);
});

test('request-invalid: whatever the program would refuse is refused before anything is signed', async () => {
  const cases: [string, () => ReturnType<typeof world>][] = [
    ['no wallet', () => {
      const w = world('createSession', createArgs());
      w.chain.accounts.delete(w.wallet);
      return w;
    }],
    ['authority on another wallet', () => {
      const w = world('createSession', createArgs());
      w.chain.set(w.authority, PROGRAM, Buffer.from(w.chain.accounts.get(w.authority)!.data).fill(7, 16, 48));
      return w;
    }],
    ['a delegate passkey', () => world('createSession', createArgs(), { role: 2 })],
    ['a passkey with a policy', () => world('createSession', createArgs(), { role: 1, policy: sample.solLimit(1n) })],
    ['expiry in the past', () => world('createSession', createArgs(undefined, NOW))],
    ['expiry past 30 days', () => world('createSession', createArgs(undefined, NOW + 30n * 86_400n + 1n))],
    ['session exists', () => {
      const args = createArgs();
      const w = world('createSession', args);
      w.chain.set(sessionAddress(PROGRAM, w.wallet, args.sessionKey), PROGRAM, sessionData({ wallet: w.wallet, sessionKey: args.sessionKey, expiresAt: 1n }));
      return w;
    }],
    ['devnet USDC with other decimals', () => {
      const w = world('createSession', createArgs(sample.tokenLimit(new Uint8Array(Buffer.from(addrBytes(DEVNET_USDC))), 1n)));
      w.chain.set(DEVNET_USDC, TOKEN, mintData(9));
      return w;
    }],
    ['counter at u32 max', () => {
      const w = world('createSession', createArgs());
      w.chain.set(w.authority, PROGRAM, passkeyAuthority({ wallet: w.wallet, credentialId: w.credentialId, counter: 0xffff_ffff }));
      return w;
    }],
    ['revoke a session that does not exist', () => world('revokeSession', { session: addr(), refund: addr() })],
    ['remove yourself', () => {
      const w = world('removeAuthority', { target: addr(), refund: addr() });
      return world('removeAuthority', { target: w.authority, refund: addr() });
    }],
  ];
  for (const [name, make] of cases) {
    const w = make();
    const r = await read(w);
    assert.equal(!r.ok && r.code, 'request-invalid', name);
    assert.ok(!r.ok && r.reason.length > 0, name);
  }
  // Removal follows can_remove: an Admin can't remove an Owner; the last Owner stays.
  const admin = world('removeAuthority', { target: addr(), refund: addr() }, { role: 1, ownerCount: 1 });
  const target = (admin.req as Extract<ApprovalRequest, { kind: 'removeAuthority' }>).args.target;
  admin.chain.set(target, PROGRAM, ed25519Authority({ wallet: admin.wallet, publicKey: addr(), role: 0 }));
  assert.equal((await read(admin)).ok, false);
  const last = world('removeAuthority', { target: addr(), refund: addr() }, { ownerCount: 1 });
  last.chain.set((last.req as Extract<ApprovalRequest, { kind: 'removeAuthority' }>).args.target, PROGRAM, ed25519Authority({ wallet: last.wallet, publicKey: addr(), role: 0 }));
  const lastRead = await read(last);
  assert.equal(!lastRead.ok && lastRead.reason, "It's the last device with full control.");
  // Refund or payer that is the account being closed, the wallet or its vault.
  const r = world('revokeSession', { session: addr(), refund: addr() });
  const session = (r.req as Extract<ApprovalRequest, { kind: 'revokeSession' }>).args.session;
  const self = world('revokeSession', { session, refund: session });
  self.chain.set(session, PROGRAM, sessionData({ wallet: self.wallet, sessionKey: addr(), expiresAt: NOW + 10n }));
  assert.equal((await read(self)).ok, false);
  const toVault = world('removeAuthority', { target: addr(), refund: addr() });
  const vaultRefund = world('removeAuthority', { target: (toVault.req as Extract<ApprovalRequest, { kind: 'removeAuthority' }>).args.target, refund: vaultAddressOf(PROGRAM, toVault.wallet) });
  assert.equal((await read(vaultRefund)).ok, false);
});

const addrBytes = (a: string) => addressBytes(a)!;

test('chain-unavailable: reads that fail are not guessed at', async () => {
  const w = world('createSession', createArgs());
  w.chain.failWith = new Error('down');
  const r = await read(w);
  assert.equal(!r.ok && r.code, 'chain-unavailable');
  const screen = refusalScreen('chain-unavailable', 'Fernway');
  assert.ok(screen.retry && screen.sentence.endsWith(SIGNED_NOTHING));
});

test('every refusal screen says the passkey signed nothing', () => {
  for (const code of ['typed-malformed', 'typed-unsupported', 'challenge-mismatch', 'wrong-network', 'request-invalid', 'stale-counter', 'chain-unavailable']) {
    const s = refusalScreen(code, 'Fernway', 'why');
    assert.ok(s.sentence.endsWith(SIGNED_NOTHING), code);
  }
  assert.equal(refusalScreen('challenge-mismatch', 'Fernway').kind, 'mismatch');
  assert.equal(refusalScreen('wrong-network', 'Fernway').hero, "Can't check this request on this network");
  assert.equal(refusalScreen('request-invalid', 'Fernway').hero, "This request can't go through");
  assert.equal(refusalScreen('stale-counter', 'Fernway').hero, 'This request is out of date');
  assert.equal(refusalScreen('chain-unavailable', 'Fernway').hero, "LazorKit can't check this right now");
});

test('Approve: the slot and counter come from the snapshot, never from the app', async () => {
  const w = world('createSession', createArgs());
  const r = await read(w);
  assert.ok(r.ok);
  w.chain.setClock(SLOT + 300n, NOW + 120n);
  const snap = await readSnapshot(w.chain.transport, w.req, () => 1000);
  assert.ok(snap);
  assert.equal(snap.counter, 6);
  const signed = bindAtApprove(w.req, snap, 1500);
  assert.equal(signed.kind, 'sign');
  if (signed.kind !== 'sign') return;
  assert.equal(signed.binding.slot, SLOT + 300n, 'the current slot, not the SDK prepared one');
  assert.equal(signed.binding.counter, 7);
  assert.deepEqual(signed.binding.challenge, approvalChallenge(w.req, { slot: SLOT + 300n, counter: 7 }));
  assert.notDeepEqual(signed.binding.challenge, Buffer.from(w.query.message, 'base64'));
  // Too old: wait for the next refresh.
  assert.deepEqual(bindAtApprove(w.req, snap, 1000 + MAX_SNAPSHOT_AGE_MS + 1), { kind: 'wait', reason: 'stale' });
  assert.deepEqual(bindAtApprove(w.req, null, 0), { kind: 'wait', reason: 'no-snapshot' });
  // The counter moved forward (another approval landed): sign with the chain's.
  const ahead = bindAtApprove(w.req, { ...snap, counter: 9 }, 1000);
  assert.ok(ahead.kind === 'sign' && ahead.binding.counter === 10);
  // The portal's node is behind the SDK's: never sign below its counter.
  assert.deepEqual(bindAtApprove(w.req, { ...snap, counter: 5 }, 1000), { kind: 'wait', reason: 'behind' });
});

test('the reply carries the binding: data.typed in a message, typed* in a redirect', () => {
  const w = world('revokeSession', { session: addr(), refund: addr() });
  const reply = typedReply(w.req, { slot: 18_446_744_073_709_551_615n, counter: 7, challenge: new Uint8Array(32) });
  assert.deepEqual(reply, { v: 1, kind: 'revokeSession', slot: '18446744073709551615', counter: 7, sysvarIxIndex: 5 });
  const assertion = { normalized: 'n', msg: 'm', clientDataJSONReturn: 'c', authenticatorDataReturn: 'a' };
  const result = { type: 'signed' as const, credentialId: 'id', assertion, timestamp: 1, typed: reply };
  const message = messageFor(result) as { type: string; data: Record<string, unknown> };
  assert.equal(message.type, 'SIGNATURE_CREATED');
  assert.deepEqual(message.data.typed, reply);
  assert.equal(message.data.clientDataJSONReturn, 'c', 'the fields 3.4.1 reads are unchanged');
  const url = new URL(redirectUrlFor(new URL('e2eapp://callback'), result));
  assert.deepEqual(
    ['typedV', 'typedKind', 'typedSlot', 'typedCounter', 'typedSysvarIx'].map((k) => url.searchParams.get(k)),
    ['1', 'revokeSession', '18446744073709551615', '7', '5'],
  );
  assert.equal(url.searchParams.get('signature'), 'n');
  // No typed block for a legacy signature.
  assert.equal(Object.hasOwn((messageFor({ type: 'signed', credentialId: 'id', assertion, timestamp: 1 }) as { data: object }).data, 'typed'), false);
});

test('a token named without a total: the vault is read for "could spend all"', async () => {
  const mint = addrBytes(DEVNET_USDC);
  const w = world('createSession', createArgs(Uint8Array.from([...sample.solMax(2_000_000n), ...sample.tokenLimit(mint, 5_000_000n)])));
  w.chain.set(DEVNET_USDC, TOKEN, mintData(6));
  const r = await read(w);
  assert.ok(r.ok && r.view.holdings && r.view.holdings.lamports === 1_250_000_000n);
  assert.ok(w.chain.calls.some((c) => c.method === 'getBalance'));
});

test('snapshots that stop: the screen refuses instead of waiting forever', async () => {
  const t = { startedAt: 0, lastGoodAt: null, goneSince: null, behindSince: null };
  assert.deepEqual(snapshotVerdict(t, MAX_BEHIND_MS), { kind: 'ok' });
  // No usable answer since the screen opened (reads failing, a rate limit): chain-unavailable, which offers Try again.
  const down = snapshotVerdict(t, MAX_BEHIND_MS + 1);
  assert.equal(down.kind === 'refuse' && down.code, 'chain-unavailable');
  assert.equal(refusalScreen('chain-unavailable', 'Fernway').retry, true);
  // Answers stopped after a good one.
  assert.deepEqual(snapshotVerdict({ ...t, lastGoodAt: 5000 }, 5000 + MAX_BEHIND_MS), { kind: 'ok' });
  assert.equal(snapshotVerdict({ ...t, lastGoodAt: 5000 }, 5001 + MAX_BEHIND_MS).kind, 'refuse');
  // The passkey was removed while the screen was open.
  const gone = snapshotVerdict({ ...t, lastGoodAt: 9000, goneSince: 9500 }, 9501 + MAX_BEHIND_MS);
  assert.equal(gone.kind === 'refuse' && gone.code, 'request-invalid');
  // A node behind the SDK's counter.
  const behind = snapshotVerdict({ ...t, lastGoodAt: 12_000, behindSince: 1000 }, 12_000);
  assert.equal(behind.kind === 'refuse' && behind.code, 'stale-counter');

  // readSnapshot: null when the authority is gone, a throw when the read fails.
  const w = world('createSession', createArgs());
  assert.ok(await readSnapshot(w.chain.transport, w.req, () => 0));
  w.chain.accounts.delete(w.authority);
  assert.equal(await readSnapshot(w.chain.transport, w.req, () => 0), null);
  w.chain.failWith = new Error('429');
  await assert.rejects(readSnapshot(w.chain.transport, w.req, () => 0));
});
