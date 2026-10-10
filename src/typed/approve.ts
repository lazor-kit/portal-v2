/**
 * The slot and counter a typed approval signs with, picked at the Approve
 * click from the portal's own snapshot (DESIGN §3.3), never from the app:
 *
 *   - the snapshot is at most `MAX_SNAPSHOT_AGE_MS` old, else the button waits;
 *   - counter = the authority's counter + 1, and at least the SDK's; above it,
 *     another approval from this passkey landed since the SDK prepared, which
 *     changes nothing shown, so the chain's value is signed and returned;
 *     below it, the portal's node is behind: wait, and after
 *     `MAX_BEHIND_MS` refuse (`stale-counter`);
 *   - slot = the snapshot's Clock slot (confirmed, so never ahead of the
 *     cluster), which starts the program's 150-slot window at the click.
 *
 * Pure and synchronous: the page calls it inside the click handler, so the
 * passkey prompt keeps the user's activation.
 */
import { approvalChallenge } from '../approval/challenge.ts';
import { SYSVAR_IX_INDEX } from '../approval/constants.ts';
import type { ApprovalRequest } from '../approval/envelope.ts';
import type { Snapshot } from './reads.ts';

export const SNAPSHOT_INTERVAL_MS = 1000;
export const MAX_SNAPSHOT_AGE_MS = 3000;
export const MAX_BEHIND_MS = 10_000;

export interface Binding {
  readonly slot: bigint;
  readonly counter: number;
  readonly challenge: Uint8Array;
}

export type BindResult =
  | { readonly kind: 'sign'; readonly binding: Binding }
  /** Not yet: no snapshot, or it is too old (`stale`), or the node is behind the SDK (`behind`). */
  | { readonly kind: 'wait'; readonly reason: 'no-snapshot' | 'stale' | 'behind' };

export function bindAtApprove(req: ApprovalRequest, snapshot: Snapshot | null, now: number): BindResult {
  if (!snapshot) return { kind: 'wait', reason: 'no-snapshot' };
  if (now - snapshot.at > MAX_SNAPSHOT_AGE_MS || now < snapshot.at) return { kind: 'wait', reason: 'stale' };
  const counter = snapshot.counter + 1;
  if (counter < req.counter) return { kind: 'wait', reason: 'behind' };
  const slot = snapshot.slot;
  return { kind: 'sign', binding: { slot, counter, challenge: approvalChallenge(req, { slot, counter }) } };
}

/** The `typed` block of a reply: what the SDK rebinds its prepared transaction with. */
export interface TypedReply {
  readonly v: 1;
  readonly kind: ApprovalRequest['kind'];
  /** Decimal u64. */
  readonly slot: string;
  readonly counter: number;
  readonly sysvarIxIndex: number;
}

export function typedReply(req: ApprovalRequest, binding: Binding): TypedReply {
  return { v: 1, kind: req.kind, slot: binding.slot.toString(), counter: binding.counter, sysvarIxIndex: SYSVAR_IX_INDEX[req.kind] };
}
