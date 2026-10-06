/**
 * Read-only chain access for display, through the portal's `/api/rpc`.
 *
 *   readVault            the vault's SOL and token accounts (with delegates)
 *   readWalletAccounts   the wallet's authorities, sessions, deferred executions
 *   readPaymentHistory   payments out of the vault and its other
 *                        counterparties, with how much was read
 *   checkRecipient       relation ("Paid 3 times before", "First time paying",
 *                        "Not in your last N transactions", unknown) and the
 *                        lookalike check (addresses paid, counterparties, own
 *                        and saved ones), from a history read
 *
 * Every read is `{ status: 'ok', value }` or `{ status: 'unavailable', reason }`.
 */
import { readPaymentHistory, type HistoryOptions } from './history.ts';
import { checkRecipient, type RecipientCheck } from './recipient.ts';
import type { Transport } from './transport.ts';

export * from './transport.ts';
export * from './layout.ts';
export * from './reads.ts';
export * from './history.ts';
export * from './recipient.ts';

/** Reads the vault's payment history and checks `recipient` against it. */
export async function readRecipientCheck(
  transport: Transport,
  vault: string,
  recipient: string,
  options: HistoryOptions & { own?: readonly string[]; saved?: readonly string[] } = {},
): Promise<RecipientCheck> {
  const history = await readPaymentHistory(transport, vault, options);
  return checkRecipient(recipient, history, options);
}
