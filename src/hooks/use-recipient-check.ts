/**
 * Hook point for the pay screens: the recipient check for one payment,
 * read through the portal's `/api/rpc`. It does not decide what is shown.
 *
 * The vault's history is read once a minute at most and shared by every
 * check: call `forgetPaymentHistory` after a payment from the vault.
 */
import { useEffect, useState } from 'react';
import { checkRecipient, HistoryMemo, portalTransport, readPaymentHistory, type Cluster, type RecipientCheck } from '@/chain';

export type RecipientCheckState = { readonly status: 'idle' } | { readonly status: 'checking' } | { readonly status: 'done'; readonly check: RecipientCheck };

export interface RecipientCheckInput {
  readonly cluster: Cluster;
  /** The paying vault. */
  readonly vault: string;
  /** The address being paid (for tokens, the owner, not the token account). */
  readonly recipient: string;
}

const histories = new HistoryMemo();

/** Forgets the vault's history, so the next check reads it afresh (after a payment from it). */
export function forgetPaymentHistory(cluster: Cluster, vault: string): void {
  histories.forget(cluster, vault);
}

/** `idle` without input; `checking` while the history is read; then the check (which may itself say `unknown`). */
export function useRecipientCheck(input: RecipientCheckInput | null): RecipientCheckState {
  const [state, setState] = useState<RecipientCheckState>({ status: 'idle' });
  const cluster = input?.cluster;
  const vault = input?.vault;
  const recipient = input?.recipient;
  useEffect(() => {
    if (!cluster || !vault || !recipient) {
      setState({ status: 'idle' });
      return;
    }
    let current = true;
    setState({ status: 'checking' });
    histories
      .read(cluster, vault, () => readPaymentHistory(portalTransport(cluster), vault))
      .then((history) => checkRecipient(recipient, history))
      .catch(() => checkRecipient(recipient, { status: 'unavailable', reason: 'malformed' }))
      .then((check) => {
        if (current) setState({ status: 'done', check });
      });
    return () => {
      current = false;
    };
  }, [cluster, vault, recipient]);
  return state;
}
