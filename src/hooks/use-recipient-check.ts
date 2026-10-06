/**
 * Hook point for the pay screens: the recipient check for one payment,
 * read through the portal's `/api/rpc`. It does not decide what is shown.
 */
import { useEffect, useState } from 'react';
import { checkRecipient, portalTransport, readRecipientCheck, type Cluster, type RecipientCheck } from '@/chain';

export type RecipientCheckState = { readonly status: 'idle' } | { readonly status: 'checking' } | { readonly status: 'done'; readonly check: RecipientCheck };

export interface RecipientCheckInput {
  readonly cluster: Cluster;
  /** The paying vault. */
  readonly vault: string;
  /** The address being paid (for tokens, the owner, not the token account). */
  readonly recipient: string;
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
    readRecipientCheck(portalTransport(cluster), vault, recipient)
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
