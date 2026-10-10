// What typed screens say (DESIGN §5, RULES-lean): the first view and Details
// for each case, word budgets, numbers taken from the signed bytes, and no
// string from the app on the first view. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlEncode, type ApprovalRequest } from '../src/approval/index.ts';
import { readTypedChain, type TypedChainView } from '../src/typed/reads.ts';
import { countWords, firstViewTexts, needsHoldings, typedScreen, type TypedScreen } from '../src/typed/screen.ts';
import { addressBytes } from '../src/approval/bytes.ts';
import { addr, cat, CONFIG, DEVNET_USDC, ed25519Authority, mintData, NOW, passkeyAuthority, PROGRAM, sample, sessionData, TOKEN, world } from './typed-fixtures.ts';

const USDC = addressBytes(DEVNET_USDC)!;
const clock = { timeZone: 'UTC' };
const H3 = NOW + 3n * 3600n;

async function screenFor(w: ReturnType<typeof world>, o: { app?: string; features?: typeof CONFIG.features; knownHosts?: string[] } = {}): Promise<{ screen: TypedScreen; view: TypedChainView }> {
  const r = await readTypedChain(w.chain.transport, w.req, { config: { ...CONFIG, features: o.features ?? CONFIG.features }, needsHoldings });
  assert.ok(r.ok, !r.ok ? `${r.code}: ${r.reason}` : '');
  return { screen: typedScreen({ req: w.req, view: r.view, app: o.app ?? 'Fernway', knownHosts: o.knownHosts, clock }), view: r.view };
}

function create(actions: Uint8Array, expiresAt = H3, setup?: (w: ReturnType<typeof world>) => void) {
  const w = world('createSession', { sessionKey: addr(), expiresAt: expiresAt.toString(), actions: base64urlEncode(actions) });
  w.chain.set(DEVNET_USDC, TOKEN, mintData(6));
  setup?.(w);
  return w;
}

/**
 * The first view's words, chrome included, as RULES-lean §2 counts them:
 * "LazorKit", the app ("Fernway", "Verified site", its domain), the test chip,
 * "Details", the buttons and the passkey caption.
 */
function firstViewWords(s: TypedScreen): number {
  const chrome = ['LazorKit', 'Fernway', 'Verified site', 'www.fernway.example', 'Not real money', 'Details'];
  const buttons = s.tier === 'danger' ? ['Approve anyway…', s.cancelLabel] : [s.cancelLabel, s.approveLabel, 'Passkey for portal.lazor.sh'];
  return countWords([...chrome, ...buttons, ...firstViewTexts(s)]);
}
const detail = (s: TypedScreen, label: string) => s.details.find((d) => d.label === label);

test('session-create: totals as the hero, one sentence, when it ends and where to stop it', async () => {
  const w = create(cat(sample.solLimit(20_000_000n), sample.solMax(2_000_000n), sample.tokenLimit(USDC, 5_000_000n), sample.tokenMax(USDC, 1_000_000n)));
  const { screen: s } = await screenFor(w);
  assert.equal(s.id, 'session-create');
  assert.equal(s.eyebrow, 'Spending limit');
  assert.equal(s.hero, '0.02 SOL + 5 USDC');
  assert.equal(s.sentence, 'Fernway can spend this to anyone, without asking you.');
  assert.deepEqual(s.facts.map((f) => [f.label, f.value]), [['Ends', 'About 6:50 PM'], ['Stop sooner', 'In Fernway']]);
  assert.equal(s.block, null);
  assert.equal(s.caution, null);
  assert.equal(detail(s, 'SOL')?.value, 'Up to 0.02 SOL in total · At most 0.002 SOL per payment');
  assert.equal(detail(s, 'USDC')?.value, 'Up to 5 USDC in total · At most 1 USDC per payment');
  assert.equal(detail(s, 'Your other SOL and tokens')?.note, "Your account blocks it. Some NFTs and money in other apps aren't covered.");
  assert.equal(detail(s, 'Sends to')?.value, 'Any address or app');
  assert.match(detail(s, 'Who can use it')!.value, /^Whoever has key \w{4}…\w{4}$/);
  assert.equal(detail(s, 'Fee')?.value, "You don't pay it");
  assert.equal(detail(s, 'Ends')?.value, 'About 6:50 PM (in about 3 hours)');
  assert.equal(s.approveLabel, 'Approve with passkey');
  assert.equal(s.receipt.next, 'Once Fernway sets it up, it can spend this without asking.');
  assert.ok(firstViewWords(s) <= 45, `${firstViewWords(s)} words`);
});

test('session-create variants: recurring, tokens only, more than two assets, an earlier limit end, other tokens', async () => {
  const day = (await screenFor(create(sample.solRecurring(20_000_000n, 86_400n)))).screen;
  assert.equal(day.hero, '0.02 SOL a day');
  assert.equal(detail(day, 'SOL')?.note, 'Counted from the first payment in each window.');
  assert.equal((await screenFor(create(sample.solRecurring(1_000_000_000n, 3n * 86_400n)))).screen.hero, '1 SOL every 3 days');
  assert.equal((await screenFor(create(sample.solRecurring(1n, 5400n)))).screen.hero, '0.000000001 SOL every 90 minutes');

  const tokens = (await screenFor(create(sample.tokenLimit(USDC, 5_000_000n)))).screen;
  assert.equal(tokens.variant, 'tokens-only');
  assert.equal(tokens.hero, '5 USDC');
  assert.equal(tokens.sentence, 'Fernway can spend this to anyone, without asking you. Not SOL.');

  const other = addr();
  const many = create(cat(sample.solLimit(20_000_000n), sample.tokenLimit(USDC, 5_000_000n), sample.tokenLimit(addressBytes(other)!, 7n)), H3, (w) => w.chain.set(other, TOKEN, mintData(0)));
  const m = (await screenFor(many)).screen;
  assert.equal(m.hero, '0.02 SOL + 2 tokens');
  assert.equal(detail(m, `Token ${other.slice(0, 4)}…${other.slice(-4)}`)?.value, 'Up to 7 of token ' + `${other.slice(0, 4)}…${other.slice(-4)}` + ' in total');

  const early = (await screenFor(create(sample.solLimit(20_000_000n, NOW + 3600n)))).screen;
  assert.equal(detail(early, 'Limit ends')?.value, "This limit ends at about 4:50 PM; after that it can't spend SOL");

  const notAMint = addr();
  const unread = (await screenFor(create(cat(sample.solLimit(1_000_000n), sample.tokenLimit(addressBytes(notAMint)!, 5n))))).screen;
  assert.equal(unread.caution, "LazorKit can't read this token.");
  assert.equal(unread.hero, '0.001 SOL + 1 other token');

  // A limit of 0 is "can't spend", not a total.
  const zero = (await screenFor(create(cat(sample.solLimit(0n), sample.tokenLimit(USDC, 5_000_000n))))).screen;
  assert.equal(zero.hero, '5 USDC');
  assert.equal(detail(zero, 'SOL')?.value, "Can't be spent with this");
  // An already expired limit is exhausted.
  const gone = (await screenFor(create(cat(sample.solMax(5n, NOW - 1n), sample.tokenLimit(USDC, 5_000_000n))))).screen;
  assert.equal(gone.id, 'session-create');
  assert.equal(detail(gone, 'SOL')?.value, "Can't be spent with this");

  const later = (await screenFor(create(sample.solLimit(1n), NOW + 10n * 86_400n))).screen;
  assert.deepEqual(later.facts[0], { label: 'Ends', value: 'About Oct 20, 3:50 PM', testId: 'fact-ends' });
  const tomorrow = (await screenFor(create(sample.solLimit(1n), NOW + 86_400n))).screen;
  assert.equal(tomorrow.facts[0].value, 'About 3:50 PM tomorrow');
});

test('session-no-total: the caution replaces the hero and says how much could go, 0.002 at a time', async () => {
  const w = create(cat(sample.solMax(2_000_000n), sample.tokenLimit(USDC, 5_000_000n)));
  const { screen: s } = await screenFor(w);
  assert.equal(s.id, 'session-no-total');
  assert.equal(s.tier, 'caution');
  assert.equal(s.hero, null);
  assert.deepEqual(s.block, { tier: 'caution', title: 'No total limit on SOL', body: 'Fernway could spend all 1.25 SOL, 0.002 at a time, plus 5 USDC, to anyone, without asking.' });
  assert.deepEqual(s.facts.map((f) => f.value), ['About 6:50 PM', 'In Fernway']);
  assert.equal(detail(s, 'Your SOL')?.note, 'From Solana');
  assert.equal(s.receipt.block?.title, 'No total limit on SOL', 'the receipt keeps the caution');
  // Risk wins the budget (RULES-lean §2): the one screen over 45, by its risk sentence.
  assert.ok(firstViewWords(s) <= 50, `${firstViewWords(s)} words`);
  // Without a balance read, no number is invented.
  const unread = create(cat(sample.solMax(2_000_000n)), H3, (x) => (x.chain.failBalance = true));
  const u = (await screenFor(unread)).screen;
  assert.equal(u.block?.body, 'Fernway could spend all your SOL, 0.002 at a time, to anyone, without asking.');
});

test('session-no-limits: danger, Cancel solid, a confirmation, and the lasting effect only on a binary without the non-owner invariants', async () => {
  const w = create(new Uint8Array(0));
  const { screen: s } = await screenFor(w);
  assert.equal(s.id, 'session-no-limits');
  assert.equal(s.tier, 'danger');
  assert.deepEqual(s.block, {
    tier: 'danger',
    title: 'Let Fernway spend anything',
    body: 'No limits. Whoever has this key can move all your money through any service, until about 6:50 PM.',
  });
  assert.equal(s.recommendCancel, true);
  assert.equal(s.ack, 'I understand this key can take everything in my account.');
  assert.ok(firstViewWords(s) <= 45, `${firstViewWords(s)} words`);
  const old = (await screenFor(create(new Uint8Array(0)), { features: ['wallet-bound-challenge', 'd13', 'time-expiry'] })).screen;
  assert.match(old.block!.body, /It could also give your account away for good\. Stopping it later won't undo that\.$/);
});

test('no-spend: only a program list, on a D13 binary', async () => {
  const program = addr();
  const s = (await screenFor(create(sample.whitelist(addressBytes(program)!)))).screen;
  assert.equal(s.variant, 'no-spend');
  assert.equal(s.eyebrow, 'Permission');
  assert.equal(s.hero, `Use ${program.slice(0, 4)}…${program.slice(-4)} without asking`);
  assert.equal(s.sentence, "It can't spend your money.");
  assert.equal(detail(s, 'Apps it can use')?.note, 'It can still reach other apps through these.');
});

test('session-stop: neutral hero, what is left, and that no money moves', async () => {
  const w = world('revokeSession', { session: addr(), refund: addr() });
  const session = (w.req as Extract<ApprovalRequest, { kind: 'revokeSession' }>).args.session;
  w.chain.set(session, PROGRAM, sessionData({ wallet: w.wallet, sessionKey: addr(), expiresAt: H3, actions: cat(sample.solLimit(15_000_000n), sample.tokenLimit(USDC, 5_000_000n)) }));
  const s = (await screenFor(w)).screen;
  assert.equal(s.id, 'session-stop');
  assert.equal(s.hero, 'Stop this spending permission');
  assert.equal(s.heroLine, '0.015 SOL + 5 USDC · ends about 6:50 PM');
  assert.equal(s.sentence, 'No money moves.');
  assert.equal(s.approveLabel, 'Stop with passkey');
  assert.equal(s.cancelLabel, 'Keep it');
  assert.equal(detail(s, 'Left to spend: SOL')?.value, '0.015 SOL in total');
  const refund = (w.req as Extract<ApprovalRequest, { kind: 'revokeSession' }>).args.refund;
  assert.equal(detail(s, 'Deposit goes back to')?.value, `${refund.slice(0, 4)}…${refund.slice(-4)}`);
  // The permission set to stop names no app (no on-chain label): neutral hero.
  assert.ok(!s.hero!.includes('Fernway'));
  // Already ended.
  const ended = world('revokeSession', { session: addr(), refund: addr() });
  ended.chain.set((ended.req as Extract<ApprovalRequest, { kind: 'revokeSession' }>).args.session, PROGRAM, sessionData({ wallet: ended.wallet, sessionKey: addr(), expiresAt: NOW - 3600n }));
  assert.equal((await screenFor(ended)).screen.heroLine, 'It already ended at about 2:50 PM');
  // On a binary that isn't the configured one: no time (its expiry might be a slot).
  const unknown = world('revokeSession', { session: addr(), refund: addr() });
  unknown.chain.set((unknown.req as Extract<ApprovalRequest, { kind: 'revokeSession' }>).args.session, PROGRAM, sessionData({ wallet: unknown.wallet, sessionKey: addr(), expiresAt: 412_000_000n }));
  const r = await readTypedChain(unknown.chain.transport, unknown.req, { config: { ...CONFIG, lastDeploySlot: 1 } });
  assert.ok(r.ok);
  assert.equal(typedScreen({ req: unknown.req, view: r.view, app: 'Fernway', clock }).heroLine, 'No limits');
});

test('device-remove and key-remove: what goes, and who keeps full control', async () => {
  const w = world('removeAuthority', { target: addr(), refund: addr() }, { ownerCount: 2 });
  const target = (w.req as Extract<ApprovalRequest, { kind: 'removeAuthority' }>).args.target;
  w.chain.set(target, PROGRAM, passkeyAuthority({ wallet: w.wallet, credentialId: new Uint8Array(16).fill(9), role: 0, rpId: 'portal.lazor.sh' }));
  const s = (await screenFor(w, { knownHosts: ['portal.lazor.sh'] })).screen;
  assert.equal(s.id, 'device-remove');
  assert.equal(s.hero, 'Remove a device');
  assert.equal(s.heroLine, 'Works on portal.lazor.sh');
  assert.equal(s.sentence, "It won't be able to get into your account anymore.");
  assert.deepEqual(s.facts.map((f) => [f.label, f.value]), [['Full control left', "Only the passkey you're using now"]]);
  assert.equal(detail(s, 'What it can do now')?.value, 'Full control');
  assert.equal(detail(s, 'Money')?.value, 'None moves');
  assert.equal(s.approveLabel, 'Remove with passkey');
  assert.ok(firstViewWords(s) <= 45, `${firstViewWords(s)} words`);
  // An rpId LazorKit doesn't know: no line.
  assert.equal((await screenFor(w, { knownHosts: ['www.fernway.example'] })).screen.heroLine, null);

  const k = world('removeAuthority', { target: addr(), refund: addr() });
  const keyTarget = (k.req as Extract<ApprovalRequest, { kind: 'removeAuthority' }>).args.target;
  const pub = addr();
  k.chain.set(keyTarget, PROGRAM, ed25519Authority({ wallet: k.wallet, publicKey: pub, role: 2, policy: sample.tokenRecurring(USDC, 50_000_000n, 86_400n) }));
  const ks = (await screenFor(k)).screen;
  assert.equal(ks.id, 'key-remove');
  assert.equal(ks.hero, 'Remove a key');
  assert.equal(ks.heroLine, `Key ending ${pub.slice(-4)}`);
  assert.equal(ks.sentence, "It won't be able to spend from your account anymore.");
  assert.equal(detail(ks, 'What it can do now')?.value, 'Can spend within its limits');
  assert.equal(detail(ks, 'USDC')?.value, 'Up to 50 USDC a day', 'a delegate policy is decoded with the same rules');
});

test('the first view carries nothing the app wrote: no addresses, no keys, only the app name LazorKit resolved', async () => {
  const w = create(cat(sample.solMax(2_000_000n), sample.tokenLimit(USDC, 5_000_000n)));
  const s = (await screenFor(w, { app: 'swap.tinydex.fun' })).screen;
  const first = firstViewTexts(s).join(' ');
  const json = JSON.stringify(w.json);
  for (const token of json.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []) assert.ok(!first.includes(token), `first view shows ${token}`);
  assert.match(first, /swap\.tinydex\.fun could spend/);
  // Numbers come from the signed bytes: 2,000,000 lamports and 5,000,000 base units.
  assert.match(s.block!.body, /0\.002 at a time, plus 5 USDC/);
});
