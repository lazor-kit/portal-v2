/**
 * What a typed request's screen says (DESIGN §5, RULES-lean): every number
 * from the signed bytes or a chain read, never from the app. Pure: the page
 * renders the result as it is, and the tests read the same strings.
 *
 *   createSession    session-create (also tokens-only, no-spend),
 *                    session-no-total (caution), session-no-limits (danger)
 *   revokeSession    session-stop
 *   removeAuthority  device-remove (a passkey), key-remove (an Ed25519 key)
 */
import { sha256 } from '@noble/hashes/sha256';
import { rawRule, type Action } from '../approval/actions.ts';
import { utf8 } from '../approval/bytes.ts';
import type { ApprovalRequest } from '../approval/envelope.ts';
import { andList, cap, formatMoment, formatUnits, LAMPORTS_DECIMALS, orList, relativePhrase, short, windowPhrase, type Clock } from './format.ts';
import type { MintRead, TypedChainView } from './reads.ts';
import { knownToken } from './tokens.ts';

export interface TextRow {
  readonly label: string;
  readonly value: string;
  /** A line under the value: a limit sentence, or where LazorKit read it ("From Solana"). */
  readonly note?: string;
  readonly testId?: string;
}

export interface Block {
  readonly tier: 'caution' | 'danger';
  readonly title: string;
  readonly body: string;
}

export type ScreenId = 'session-create' | 'session-no-total' | 'session-no-limits' | 'session-stop' | 'device-remove' | 'key-remove';

/** The first view, Details, buttons and receipt of one typed request. */
export interface TypedScreen {
  readonly id: ScreenId;
  readonly variant: 'tokens-only' | 'no-spend' | null;
  readonly tier: 'none' | 'caution' | 'danger';
  readonly eyebrow: string | null;
  /** Null when a caution or danger block takes its place. */
  readonly hero: string | null;
  readonly heroSize: 'amount' | 'action';
  readonly heroLine: string | null;
  readonly block: Block | null;
  readonly caution: string | null;
  readonly sentence: string | null;
  /** Up to two. */
  readonly facts: readonly TextRow[];
  /** After the match line. */
  readonly details: readonly TextRow[];
  readonly experts: readonly TextRow[];
  readonly approveLabel: string;
  readonly cancelLabel: string;
  /** Cancel is the solid button (danger). */
  readonly recommendCancel: boolean;
  /** The confirmation a danger screen asks for before Approve. */
  readonly ack: string | null;
  readonly receipt: {
    readonly eyebrow: string | null;
    readonly hero: string | null;
    readonly heroSize: 'amount' | 'action';
    readonly block: Block | null;
    readonly next: string;
    readonly facts: readonly TextRow[];
  };
}

export interface ScreenInput {
  readonly req: ApprovalRequest;
  readonly view: TypedChainView;
  /** How sentences name the requester: "Fernway", "swap.tinydex.fun", "the app". */
  readonly app: string;
  /** Hosts whose passkeys LazorKit can name ("Works on portal.lazor.sh"): the portal's own, and registered apps'. */
  readonly knownHosts?: readonly string[];
  /** A caution about where the request came from (another site); it takes the one caution slot. */
  readonly contextCaution?: string | null;
  readonly clock?: Clock;
}

// ─── Assets ─────────────────────────────────────────────────────────────────

interface Term {
  readonly amount: bigint;
  readonly expiresAt: bigint;
}
interface Recurring extends Term {
  readonly window: bigint;
  readonly spent: bigint;
  readonly lastReset: bigint;
}

interface Asset {
  readonly key: string;
  /** "SOL", "USDC", or null for a mint LazorKit doesn't list. */
  readonly symbol: string | null;
  /** How Details names it: "SOL", "USDC", "Token Gh9Z…tKJr". */
  readonly label: string;
  /** null when the mint can't be read: amounts are then base units. */
  readonly decimals: number | null;
  lifetime?: Term;
  recurring?: Recurring;
  perTx?: Term;
}

const SOL = 'sol';

function buildAssets(rules: readonly Action[], cluster: ApprovalRequest['cluster'], mints: Readonly<Record<string, MintRead>>): Asset[] {
  const assets = new Map<string, Asset>();
  const asset = (key: string): Asset => {
    let a = assets.get(key);
    if (!a) {
      if (key === SOL) a = { key, symbol: 'SOL', label: 'SOL', decimals: LAMPORTS_DECIMALS };
      else {
        const known = knownToken(cluster, key);
        const read = mints[key];
        a = known
          ? { key, symbol: known.symbol, label: known.symbol, decimals: known.decimals }
          : { key, symbol: null, label: `Token ${short(key)}`, decimals: read?.kind === 'mint' ? read.decimals : null };
      }
      assets.set(key, a);
    }
    return a;
  };
  // SOL first, then tokens in the order the rules name them.
  if (rules.some((r) => r.type.startsWith('sol'))) asset(SOL);
  for (const r of rules) {
    switch (r.type) {
      case 'solLimit':
        asset(SOL).lifetime = { amount: r.remaining, expiresAt: r.expiresAt };
        break;
      case 'solRecurringLimit':
        asset(SOL).recurring = { amount: r.limit, window: r.window, spent: r.spent, lastReset: r.lastReset, expiresAt: r.expiresAt };
        break;
      case 'solMaxPerTx':
        asset(SOL).perTx = { amount: r.max, expiresAt: r.expiresAt };
        break;
      case 'tokenLimit':
        asset(r.mint).lifetime = { amount: r.remaining, expiresAt: r.expiresAt };
        break;
      case 'tokenRecurringLimit':
        asset(r.mint).recurring = { amount: r.limit, window: r.window, spent: r.spent, lastReset: r.lastReset, expiresAt: r.expiresAt };
        break;
      case 'tokenMaxPerTx':
        asset(r.mint).perTx = { amount: r.max, expiresAt: r.expiresAt };
        break;
      default:
        break;
    }
  }
  return [...assets.values()];
}

/** An expired limit counts as exhausted, not as absent (`actions.rs`). */
const expired = (t: Term | undefined, now: bigint) => !!t && t.expiresAt !== 0n && now > t.expiresAt;
const effective = (t: Term | undefined, now: bigint) => (t ? (expired(t, now) ? 0n : t.amount) : null);

/** Whether `a` can leave at all: no limit on it is spent out or expired. */
function canSpend(a: Asset, now: bigint): boolean {
  for (const t of [a.lifetime, a.recurring, a.perTx]) if (t && effective(t, now) === 0n) return false;
  return true;
}
const hasTotal = (a: Asset) => !!(a.lifetime || a.recurring);

/** "0.02 SOL", "5 USDC", "5 of token Gh9Z…tKJr", "5000 units of Gh9Z…tKJr". */
function amountOf(a: Asset, amount: bigint): string {
  if (a.decimals === null) return `${amount} units of ${short(a.key)}`;
  const n = formatUnits(amount, a.decimals);
  return a.symbol ? `${n} ${a.symbol}` : `${n} of token ${short(a.key)}`;
}
/** The number alone: "0.002" (for "0.002 at a time"). */
function numberOf(a: Asset, amount: bigint): string {
  return a.decimals === null ? `${amount}` : formatUnits(amount, a.decimals);
}

/** The asset's total as the hero says it: the lifetime one, else the recurring one. */
function totalPiece(a: Asset): string {
  if (a.lifetime) return amountOf(a, a.lifetime.amount);
  const r = a.recurring!;
  return `${amountOf(a, r.amount)} ${windowPhrase(r.window)}`;
}

/** At most two assets: "0.02 SOL + 5 USDC"; more: "0.02 SOL + 3 tokens". */
function heroOf(list: readonly Asset[]): string {
  if (list.length === 1) return totalPiece(list[0]);
  if (list.length === 2) {
    const [a, b] = list;
    if (a.symbol && b.symbol) return `${totalPiece(a)} + ${totalPiece(b)}`;
    const named = [a, b].find((x) => x.symbol);
    return named ? `${totalPiece(named)} + 1 other token` : '2 tokens';
  }
  const first = list[0];
  return first.symbol ? `${totalPiece(first)} + ${list.length - 1} tokens` : `${list.length} tokens`;
}

/** One Details row per asset: its totals, per-payment cap, or that it can't be spent. */
function assetRows(assets: readonly Asset[], now: bigint, stored: boolean): TextRow[] {
  return assets.map((a) => {
    if (!canSpend(a, now)) return { label: a.label, value: `Can't be spent with this`, testId: `asset-${a.label}` };
    const parts: string[] = [];
    if (a.lifetime) parts.push(stored ? `${amountOf(a, a.lifetime.amount)} left in total` : `Up to ${amountOf(a, a.lifetime.amount)} in total`);
    if (a.recurring) parts.push(`Up to ${amountOf(a, a.recurring.amount)} ${windowPhrase(a.recurring.window)}`);
    if (a.perTx) parts.push(`At most ${amountOf(a, a.perTx.amount)} per payment`);
    return {
      label: a.label,
      value: parts.join(' · '),
      ...(a.recurring ? { note: 'Counted from the first payment in each window.' } : {}),
      testId: `asset-${a.label}`,
    };
  });
}

/** A limit that ends before the permission does: after it, that asset can't be spent. */
function earlyEnds(assets: readonly Asset[], until: bigint, now: bigint, clock: Clock): TextRow[] {
  const rows: TextRow[] = [];
  for (const a of assets) {
    if (!canSpend(a, now)) continue;
    const ends = [a.lifetime, a.recurring, a.perTx].filter((t): t is Term => !!t && t.expiresAt !== 0n && t.expiresAt < until).map((t) => t.expiresAt);
    if (!ends.length) continue;
    const first = ends.reduce((x, y) => (y < x ? y : x));
    rows.push({ label: 'Limit ends', value: `This limit ends at about ${formatMoment(first, now, clock)}; after that it can't spend ${a.symbol ?? 'this token'}` });
  }
  return rows;
}

function programRows(rules: readonly Action[]): TextRow[] {
  const allow = rules.flatMap((r) => (r.type === 'programWhitelist' ? [short(r.program)] : []));
  const deny = rules.flatMap((r) => (r.type === 'programBlacklist' ? [short(r.program)] : []));
  if (allow.length) return [{ label: 'Apps it can use', value: [...new Set(allow)].join(', '), note: 'It can still reach other apps through these.' }];
  if (deny.length) return [{ label: "Apps it can't use", value: [...new Set(deny)].join(', '), note: 'It can still reach them through other apps.' }];
  return [];
}

function networkRow(req: ApprovalRequest): TextRow {
  return { label: 'Network', value: req.cluster === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet', testId: 'network' };
}

const FEE: TextRow = { label: 'Fee', value: "You don't pay it" };
const SIGNED_WITH: TextRow = { label: 'Signed with', value: "The network's current slot and your passkey's next count, picked when you approve" };

function vaultBalance(a: Asset, view: TypedChainView): bigint | null {
  const h = view.holdings;
  if (!h) return null;
  if (a.key === SOL) return h.lamports;
  return h.tokens.filter((t) => t.mint === a.key).reduce((sum, t) => sum + t.amount, 0n);
}

// ─── Screens ────────────────────────────────────────────────────────────────

/** Whether a createSession screen will say "could spend all X": it then reads the vault. */
export function needsHoldings(req: ApprovalRequest, mints: Readonly<Record<string, MintRead>>, now: bigint): boolean {
  if (req.kind !== 'createSession') return false;
  const assets = buildAssets(req.args.decoded, req.cluster, mints);
  return assets.some((a) => canSpend(a, now) && !hasTotal(a));
}

export function typedScreen(input: ScreenInput): TypedScreen {
  switch (input.req.kind) {
    case 'createSession':
      return createScreen(input as ScreenInput & { req: Extract<ApprovalRequest, { kind: 'createSession' }> });
    case 'revokeSession':
      return stopScreen(input as ScreenInput & { req: Extract<ApprovalRequest, { kind: 'revokeSession' }> });
    case 'removeAuthority':
      return removeScreen(input as ScreenInput & { req: Extract<ApprovalRequest, { kind: 'removeAuthority' }> });
  }
}

function createScreen({ req, view, app, contextCaution = null, clock = {} }: ScreenInput & { req: Extract<ApprovalRequest, { kind: 'createSession' }> }): TypedScreen {
  const now = view.clock.unixTimestamp;
  const { expiresAt, decoded: rules, sessionKey } = req.args;
  const moment = formatMoment(expiresAt, now, clock);
  const until = `until about ${moment}`;
  const App = cap(app);
  const facts: TextRow[] = [
    { label: 'Ends', value: `About ${moment}`, testId: 'fact-ends' },
    { label: 'Stop sooner', value: `In ${app}`, testId: 'fact-stop' },
  ];
  const stopFact = facts[1];

  const assets = buildAssets(rules, req.cluster, view.mints);
  const spendable = assets.filter((a) => canSpend(a, now));
  const noTotal = spendable.filter((a) => !hasTotal(a));
  const withTotal = spendable.filter(hasTotal);
  const unreadable = spendable.some((a) => a.decimals === null);
  const caution = contextCaution ?? (unreadable ? "LazorKit can't read this token." : null);

  const sources: TextRow[] = [];
  for (const a of assets) {
    if (a.symbol || a.key === SOL) continue;
    const read = view.mints[a.key];
    sources.push(
      read?.kind === 'mint'
        ? { label: a.label, value: `${read.decimals} decimals`, note: 'From Solana' }
        : { label: a.label, value: "Not a token LazorKit can read; amounts are shown in its smallest units", note: 'From Solana' },
    );
  }
  if (contextCaution && unreadable) sources.push({ label: 'Token', value: "LazorKit can't read this token." });

  const experts: TextRow[] = [
    networkRow(req),
    { label: 'Program', value: req.programId },
    { label: 'Your account', value: req.wallet },
    { label: 'Session key', value: sessionKey },
    { label: 'Rules', value: rules.length ? rules.map(rawRule).join('\n') : 'None (no limits)', testId: 'raw-rules' },
    { label: 'Ends at', value: `${expiresAt} (Unix time)` },
    { label: 'Fee payer', value: req.payer },
    SIGNED_WITH,
  ];
  const who: TextRow = { label: 'Who can use it', value: `Whoever has key ${short(sessionKey)}` };
  const ends: TextRow = { label: 'Ends', value: `About ${moment} (${relativePhrase(expiresAt, now)})` };
  const common = { heroLine: null, approveLabel: 'Approve with passkey', cancelLabel: 'Cancel' } as const;

  // No actions: no limits at all.
  if (rules.length === 0) {
    const body =
      `No limits. Whoever has this key can move all your money through any service, ${until}.` +
      (view.features.has('nonowner-invariants') ? '' : " It could also give your account away for good. Stopping it later won't undo that.");
    const block: Block = { tier: 'danger', title: `Let ${app} spend anything`, body };
    return {
      ...common,
      id: 'session-no-limits',
      variant: null,
      tier: 'danger',
      eyebrow: null,
      hero: null,
      heroSize: 'action',
      block,
      caution: contextCaution,
      sentence: null,
      facts: [stopFact],
      details: [{ label: 'Sends to', value: 'Any address or app' }, who, FEE, ends],
      experts,
      recommendCancel: true,
      ack: 'I understand this key can take everything in my account.',
      receipt: { eyebrow: null, hero: null, heroSize: 'action', block, next: `Once ${app} sets it up, it can spend this without asking.`, facts: [stopFact] },
    };
  }

  const d13: TextRow[] = view.features.has('d13')
    ? [{ label: 'Your other SOL and tokens', value: "Can't be spent with this", note: "Your account blocks it. Some NFTs and money in other apps aren't covered." }]
    : [];
  const details: TextRow[] = [
    ...assetRows(assets, now, false),
    ...earlyEnds(assets, expiresAt, now, clock),
    ...d13,
    { label: 'Sends to', value: 'Any address or app' },
    ...programRows(rules),
    who,
    FEE,
    ends,
    ...sources,
  ];

  // Some asset has only a per-payment cap: whoever has the key could spend all of it.
  if (noTotal.length) {
    const all = noTotal.map((a) => {
      const balance = vaultBalance(a, view);
      const what = balance === null ? `all your ${a.symbol ?? 'tokens of that kind'}` : `all ${amountOf(a, balance)}`;
      return `${what}, ${numberOf(a, a.perTx!.amount)} at a time`;
    });
    const plus = withTotal.length ? `, plus ${andList(withTotal.map(totalPiece))}` : '';
    const block: Block = {
      tier: 'caution',
      title: `No total limit on ${orList(noTotal.map((a) => a.symbol ?? 'a token'))}`,
      body: `${App} could spend ${andList(all)}${plus}, to anyone, without asking.`,
    };
    const holdingRows: TextRow[] = noTotal.flatMap((a) => {
      const balance = vaultBalance(a, view);
      return balance === null
        ? [{ label: `Your ${a.symbol ?? 'token'}`, value: "LazorKit couldn't read how much you have." }]
        : [{ label: `Your ${a.symbol ?? 'token'}`, value: amountOf(a, balance), note: 'From Solana' }];
    });
    return {
      ...common,
      id: 'session-no-total',
      variant: null,
      tier: 'caution',
      eyebrow: null,
      hero: null,
      heroSize: 'action',
      block,
      caution,
      sentence: null,
      facts,
      details: [...details, ...holdingRows],
      experts,
      recommendCancel: false,
      ack: null,
      receipt: { eyebrow: null, hero: null, heroSize: 'action', block, next: `Once ${app} sets it up, it can spend this without asking.`, facts: [stopFact] },
    };
  }

  // Every asset that can leave has a total.
  if (withTotal.length) {
    const tokensOnly = !assets.some((a) => a.key === SOL) && view.features.has('d13');
    const hero = heroOf(withTotal);
    return {
      ...common,
      id: 'session-create',
      variant: tokensOnly ? 'tokens-only' : null,
      tier: caution ? 'caution' : 'none',
      eyebrow: 'Spending limit',
      hero,
      heroSize: 'amount',
      block: null,
      caution,
      sentence: `${App} can spend this to anyone, without asking you.${tokensOnly ? ' Not SOL.' : ''}`,
      facts,
      details,
      experts,
      recommendCancel: false,
      ack: null,
      receipt: { eyebrow: 'Spending limit', hero, heroSize: 'amount', block: null, next: `Once ${app} sets it up, it can spend this without asking.`, facts: [stopFact] },
    };
  }

  // Nothing can leave: a list of apps it may use, or nothing at all.
  const allow = [...new Set(rules.flatMap((r) => (r.type === 'programWhitelist' ? [r.program] : [])))];
  const hero = allow.length === 1 ? `Use ${short(allow[0])} without asking` : allow.length > 1 ? `Use ${allow.length} apps without asking` : 'Use apps without asking';
  return {
    ...common,
    id: 'session-create',
    variant: 'no-spend',
    tier: caution ? 'caution' : 'none',
    eyebrow: 'Permission',
    hero,
    heroSize: 'action',
    block: null,
    caution,
    sentence: "It can't spend your money.",
    facts,
    details,
    experts,
    recommendCancel: false,
    ack: null,
    receipt: { eyebrow: 'Permission', hero, heroSize: 'action', block: null, next: `Once ${app} sets it up, it can use this without asking.`, facts: [stopFact] },
  };
}

function depositRow(req: ApprovalRequest & { args: { refund: string } }, app: string): TextRow {
  return { label: 'Deposit goes back to', value: req.args.refund === req.payer ? `${cap(app)}'s fee payer` : short(req.args.refund) };
}

function stopScreen({ req, view, app, contextCaution = null, clock = {} }: ScreenInput & { req: Extract<ApprovalRequest, { kind: 'revokeSession' }> }): TypedScreen {
  const session = view.session!;
  const now = view.clock.unixTimestamp;
  const timed = view.features.has('time-expiry');
  const assets = buildAssets(session.rules, req.cluster, {});
  const spendable = assets.filter((a) => canSpend(a, now));
  const noTotal = spendable.filter((a) => !hasTotal(a));
  const withTotal = spendable.filter(hasTotal);

  let summary: string;
  if (!session.rules.length) summary = 'No limits';
  else if (noTotal.length) summary = `No total limit on ${orList(noTotal.map((a) => a.symbol ?? 'a token'))}`;
  else if (withTotal.length) summary = heroOf(withTotal);
  else summary = "Can't spend your money";
  const moment = formatMoment(session.expiresAt, now, clock);
  const heroLine = !timed ? summary : now > session.expiresAt ? `It already ended at about ${moment}` : `${summary} · ends about ${moment}`;

  const left: TextRow[] = [];
  for (const a of assets) {
    if (!hasTotal(a)) continue;
    const parts: string[] = [];
    if (a.lifetime) parts.push(expired(a.lifetime, now) ? 'Its total has ended' : `${amountOf(a, a.lifetime.amount)} in total`);
    if (a.recurring && timed) {
      const r = a.recurring;
      const fresh = r.lastReset === 0n || now - r.lastReset >= r.window;
      parts.push(expired(r, now) ? 'Its limit has ended' : `${amountOf(a, fresh ? r.amount : r.amount - r.spent > 0n ? r.amount - r.spent : 0n)} this window`);
    }
    if (parts.length) left.push({ label: `Left to spend: ${a.label}`, value: parts.join(' · ') });
  }
  return {
    id: 'session-stop',
    variant: null,
    tier: contextCaution ? 'caution' : 'none',
    eyebrow: null,
    hero: 'Stop this spending permission',
    heroSize: 'action',
    heroLine,
    block: null,
    caution: contextCaution,
    sentence: 'No money moves.',
    facts: [],
    details: [...left, { label: 'Money', value: 'None moves' }, FEE, depositRow(req, app)],
    experts: [
      networkRow(req),
      { label: 'Permission', value: req.args.session },
      { label: 'Session key', value: session.sessionKey },
      { label: 'Rules', value: session.rules.length ? session.rules.map(rawRule).join('\n') : 'None (no limits)', testId: 'raw-rules' },
      { label: 'Fee payer', value: req.payer },
      SIGNED_WITH,
    ],
    approveLabel: 'Stop with passkey',
    cancelLabel: 'Keep it',
    recommendCancel: false,
    ack: null,
    receipt: { eyebrow: null, hero: 'Stop this spending permission', heroSize: 'action', block: null, next: `Once ${app} sends it, this permission stops.`, facts: [] },
  };
}

const ROLE_WORDS = { owner: 'Full control', admin: 'Can add keys and spend', spender: 'Can spend within its limits' } as const;

function removeScreen({ req, view, app, knownHosts = [], contextCaution = null }: ScreenInput & { req: Extract<ApprovalRequest, { kind: 'removeAuthority' }> }): TypedScreen {
  const target = view.target!;
  const now = view.clock.unixTimestamp;
  const passkey = target.key.type === 'passkey';
  const rpHost = target.key.type === 'passkey' ? knownHosts.find((h) => hexOf(sha256(utf8(h))) === (target.key as { rpIdHash: string }).rpIdHash) : undefined;
  const hero = passkey ? 'Remove a device' : 'Remove a key';
  const heroLine = passkey ? (rpHost ? `Works on ${rpHost}` : null) : `Key ending ${(target.key as { publicKey: string }).publicKey.slice(-4)}`;
  const facts: TextRow[] = target.role === 'owner' && view.ownerCount === 2 ? [{ label: 'Full control left', value: "Only the passkey you're using now", testId: 'fact-owners' }] : [];
  const policyRows = target.rules.length ? assetRows(buildAssets(target.rules, req.cluster, {}), now, true) : [];
  return {
    id: passkey ? 'device-remove' : 'key-remove',
    variant: null,
    tier: contextCaution ? 'caution' : 'none',
    eyebrow: null,
    hero,
    heroSize: 'action',
    heroLine,
    block: null,
    caution: contextCaution,
    sentence: passkey ? "It won't be able to get into your account anymore." : "It won't be able to spend from your account anymore.",
    facts,
    details: [
      { label: 'What it can do now', value: ROLE_WORDS[target.role], testId: 'target-role' },
      ...policyRows,
      ...programRows(target.rules),
      { label: 'Money', value: 'None moves' },
      FEE,
      depositRow(req, app),
    ],
    experts: [
      networkRow(req),
      { label: passkey ? 'Device' : 'Key', value: req.args.target },
      ...(target.key.type === 'ed25519' ? [{ label: 'Public key', value: target.key.publicKey }] : []),
      ...(target.rules.length ? [{ label: 'Rules', value: target.rules.map(rawRule).join('\n') }] : []),
      { label: 'Fee payer', value: req.payer },
      SIGNED_WITH,
    ],
    approveLabel: 'Remove with passkey',
    cancelLabel: 'Cancel',
    recommendCancel: false,
    ack: null,
    receipt: {
      eyebrow: null,
      hero,
      heroSize: 'action',
      block: null,
      next: passkey ? `Once ${app} sends it, this device can't get into your account anymore.` : `Once ${app} sends it, this key can't spend from your account anymore.`,
      facts: [],
    },
  };
}

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Words on the first view, counted as RULES-lean §2 counts them: tokens with a letter or digit. */
export function countWords(texts: readonly (string | null | undefined)[]): number {
  return texts.reduce((n, t) => n + (t ? t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0), 0);
}

/** The first view's own text (hero, block, caution, sentence, facts), without the chrome. */
export function firstViewTexts(s: TypedScreen): string[] {
  return [s.eyebrow, s.hero, s.heroLine, s.block?.title, s.block?.body, s.caution, s.sentence, ...s.facts.flatMap((f) => [f.label, f.value])].filter((t): t is string => !!t);
}
