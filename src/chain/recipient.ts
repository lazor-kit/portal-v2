/**
 * What the chain says about an address the user is about to pay: whether
 * this account has paid it before, and whether it looks like an address it
 * has dealt with (paid, or received from), one of the user's own or a saved
 * one, without being it.
 *
 * Every conclusion compares the full 32 bytes. The short form `7xKX…gAsU`
 * is for recognising an address, never for matching one: an attacker can
 * make an address that shares its first and last characters with another.
 */
import type { OutgoingTransfer, PaymentHistory } from './history.ts';
import { addressBytes } from './layout.ts';
import type { Read, ReadFailure } from './transport.ts';

/**
 * The account's relation to the recipient:
 * - `own-account`: the vault itself, or an address the caller proved is the user's;
 * - `paid`: paid this many times (at least: `coverage` says whether the whole history was read);
 * - `first-time`: the whole history was read, every payment's recipient was
 *   named, and none was this address;
 * - `not-in-recent`: not paid in the newest `scanned` transactions; older ones were not read;
 * - `unknown`: the history could not be read (`reason`), or it was read but
 *   some payments out went to an address it does not name
 *   (`unnamed-recipient`), so nothing is said.
 */
export type Relation =
  | { readonly kind: 'own-account' }
  | { readonly kind: 'paid'; readonly times: number; readonly lastBlockTime: number | null; readonly coverage: PaymentHistory['coverage'] }
  | { readonly kind: 'first-time' }
  | { readonly kind: 'not-in-recent'; readonly scanned: number }
  | { readonly kind: 'unknown'; readonly reason: ReadFailure | 'invalid-address' | 'unnamed-recipient' };

export interface KnownAddress {
  readonly address: string;
  /**
   * `paid`: paid from this account (the history); `own`: one of the user's
   * accounts; `saved`: one the user saved; `counterparty`: in the history but
   * never paid from this account (it sent money in, or received a zero-value
   * transfer or one this account did not sign). A screen must not say "paid
   * before" of a counterparty.
   */
  readonly kind: 'paid' | 'own' | 'saved' | 'counterparty';
}

export interface AddressMatch {
  /** The same 32 bytes. */
  readonly same: boolean;
  /** Leading and trailing characters the two base58 forms share. */
  readonly prefix: number;
  readonly suffix: number;
}

export type LookalikeLevel = 'danger' | 'caution';

/**
 * - `found`: the recipient is not `like`, but shares its ends: `danger` when at
 *   least 3 leading and 3 trailing characters match (the short forms may be
 *   identical); `caution` when only the first 4 or only the last 4 do;
 * - `none`: no such address among those compared, the whole history included;
 * - `none-in-recent`: none among those compared, but only the newest
 *   `scanned` transactions were read: older counterparties were not compared,
 *   so this is not a clean result and must not be shown as one;
 * - `unknown`: the history could not be read and nothing else matched.
 */
export type LookalikeResult =
  | { readonly status: 'found'; readonly level: LookalikeLevel; readonly like: KnownAddress; readonly prefix: number; readonly suffix: number }
  | { readonly status: 'none' }
  | { readonly status: 'none-in-recent'; readonly scanned: number }
  | { readonly status: 'unknown'; readonly reason: ReadFailure };

export interface RecipientCheck {
  readonly recipient: string;
  readonly relation: Relation;
  readonly lookalike: LookalikeResult;
  /** The part of the history both answers rest on; null when it could not be read. */
  readonly scope: { readonly coverage: PaymentHistory['coverage']; readonly scanned: number } | null;
}

export function compareAddresses(a: string, b: string): AddressMatch {
  const bytesA = addressBytes(a);
  const bytesB = addressBytes(b);
  const same = bytesA !== null && bytesB !== null && bytesA.every((byte, i) => byte === bytesB[i]);
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { same, prefix, suffix };
}

export function lookalikeLevel(match: AddressMatch): LookalikeLevel | null {
  if (match.same) return null;
  if (match.prefix >= 3 && match.suffix >= 3) return 'danger';
  if (match.prefix >= 4 || match.suffix >= 4) return 'caution';
  return null;
}

/** The known address the recipient most resembles without being it: danger before caution, then the longest shared ends, then list order. */
export function findLookalike(recipient: string, known: readonly KnownAddress[]): Extract<LookalikeResult, { status: 'found' }> | null {
  let best: Extract<LookalikeResult, { status: 'found' }> | null = null;
  for (const candidate of known) {
    const match = compareAddresses(recipient, candidate.address);
    const level = lookalikeLevel(match);
    if (!level) continue;
    const better =
      !best ||
      (level === 'danger' && best.level === 'caution') ||
      (level === best.level && match.prefix + match.suffix > best.prefix + best.suffix);
    if (better) best = { status: 'found', level, like: candidate, prefix: match.prefix, suffix: match.suffix };
  }
  return best;
}

/** Addresses the history paid, most recently paid first. */
export function paidAddresses(history: PaymentHistory): KnownAddress[] {
  const seen = new Set<string>();
  const paid: KnownAddress[] = [];
  for (const transfer of history.transfers) {
    if (seen.has(transfer.to)) continue;
    seen.add(transfer.to);
    paid.push({ address: transfer.to, kind: 'paid' });
  }
  return paid;
}

/** The history's payments to `recipient` (full 32-byte match), newest first. */
export function paymentsTo(history: PaymentHistory, recipient: string): OutgoingTransfer[] {
  return history.transfers.filter((transfer) => compareAddresses(recipient, transfer.to).same);
}

export function relationTo(recipient: string, history: Read<PaymentHistory>, own: readonly string[] = []): Relation {
  if (!addressBytes(recipient)) return { kind: 'unknown', reason: 'invalid-address' };
  if (own.some((address) => compareAddresses(recipient, address).same)) return { kind: 'own-account' };
  if (history.status !== 'ok') return { kind: 'unknown', reason: history.reason };
  if (compareAddresses(recipient, history.value.vault).same) return { kind: 'own-account' };
  const payments = paymentsTo(history.value, recipient);
  if (payments.length > 0) {
    const times = new Set(payments.map((payment) => payment.signature)).size;
    const blockTimes = payments.map((payment) => payment.blockTime).filter((time): time is number => time !== null);
    return { kind: 'paid', times, lastBlockTime: blockTimes.length ? Math.max(...blockTimes) : null, coverage: history.value.coverage };
  }
  if (history.value.coverage === 'recent') return { kind: 'not-in-recent', scanned: history.value.scanned };
  return history.value.unattributed === 0 ? { kind: 'first-time' } : { kind: 'unknown', reason: 'unnamed-recipient' };
}

/**
 * The relation and the lookalike check for `recipient`, against the payment
 * history (addresses paid, then counterparties) and the caller's own and
 * saved addresses.
 *
 * Counterparties are compared only when the recipient is not itself an
 * address paid, one of the user's own or a saved one: anyone can send this
 * account money, and a look-alike sender must not cast doubt on an address
 * the account already knows.
 */
export function checkRecipient(
  recipient: string,
  history: Read<PaymentHistory>,
  { own = [], saved = [] }: { own?: readonly string[]; saved?: readonly string[] } = {},
): RecipientCheck {
  const relation = relationTo(recipient, history, own);
  const scope = history.status === 'ok' ? { coverage: history.value.coverage, scanned: history.value.scanned } : null;
  if (relation.kind === 'unknown' && relation.reason === 'invalid-address') {
    return { recipient, relation, lookalike: { status: 'none' }, scope };
  }
  const known: KnownAddress[] = [
    ...own.map((address) => ({ address, kind: 'own' as const })),
    ...(history.status === 'ok' ? [{ address: history.value.vault, kind: 'own' as const }, ...paidAddresses(history.value)] : []),
    ...saved.map((address) => ({ address, kind: 'saved' as const })),
  ];
  const isKnown = known.some((entry) => compareAddresses(recipient, entry.address).same);
  if (history.status === 'ok' && !isKnown) {
    const listed = new Set(known.map((entry) => entry.address));
    for (const address of history.value.counterparties) {
      if (!listed.has(address)) known.push({ address, kind: 'counterparty' });
    }
  }
  const found = findLookalike(recipient, known);
  if (found) return { recipient, relation, lookalike: found, scope };
  if (history.status !== 'ok') return { recipient, relation, lookalike: { status: 'unknown', reason: history.reason }, scope };
  const lookalike: LookalikeResult = history.value.coverage === 'complete' ? { status: 'none' } : { status: 'none-in-recent', scanned: history.value.scanned };
  return { recipient, relation, lookalike, scope };
}
