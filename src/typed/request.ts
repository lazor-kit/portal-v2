/**
 * A typed request on load (DESIGN §3.2 steps 1-3), before any chain read:
 * the fragment decodes strictly; the query is the one 3.4.1 sends (`action=sign`,
 * `message`, `credentialId`, no preview or text); the query's passkey is the
 * envelope's; the authority is that passkey's on this wallet; and the
 * envelope, with its own `preparedSlot` and `counter`, recomputes to exactly
 * the `message` the SDK sent. A request that fails any of these is refused;
 * it never falls back to the screen for a change LazorKit can't show.
 */
import { bytesEqual } from '../approval/bytes.ts';
import { preparedChallenge } from '../approval/challenge.ts';
import { MAX_URL_CHARS } from '../approval/constants.ts';
import { decodeApprovalRequest, type ApprovalRequest, type FragmentRead } from '../approval/envelope.ts';
import { passkeyAuthorityAddress } from '../approval/pda.ts';
import { decodeBase64Strict } from '../security/encoding.ts';

export type TypedRefusal = 'typed-malformed' | 'typed-unsupported' | 'challenge-mismatch';

export type TypedCheck =
  | { readonly ok: true; readonly request: ApprovalRequest; readonly challenge: Uint8Array }
  | { readonly ok: false; readonly code: TypedRefusal; readonly reason: string };

export interface TypedQuery {
  readonly action: 'connect' | 'sign' | null;
  readonly message: string | null;
  readonly credentialId: string | null;
  readonly transaction: string | null;
  readonly displayMessage: string | null;
}

/** How far ahead of the SDK's own slot a `minContextSlot` may be. */
export const MAX_FLOOR_AHEAD = 1000n;

export function checkTypedRequest(fragment: Exclude<FragmentRead, { kind: 'none' }>, query: TypedQuery, urlLength: number): TypedCheck {
  const refuse = (code: TypedRefusal, reason: string): TypedCheck => ({ ok: false, code, reason });
  if (urlLength > MAX_URL_CHARS) return refuse('typed-malformed', 'the URL is over the size cap');
  if (fragment.kind === 'malformed') return refuse('typed-malformed', fragment.reason);
  if (query.action !== 'sign') return refuse('typed-malformed', 'a typed request is a sign request');
  if ((query.transaction !== null && query.transaction !== '') || query.displayMessage !== null) {
    return refuse('typed-malformed', 'a typed request carries no preview and no text');
  }
  const decoded = decodeApprovalRequest(fragment.value);
  if (!decoded.ok) return refuse(decoded.code, decoded.reason);
  const req = decoded.request;

  const message = decodeBase64Strict(query.message ?? '');
  if (!message || message.length !== 32) return refuse('typed-malformed', 'message is not a 32-byte challenge');
  const credential = decodeBase64Strict(query.credentialId ?? '');
  if (!credential || !bytesEqual(credential, req.credentialId)) return refuse('challenge-mismatch', 'the query names another passkey than the request');
  if (passkeyAuthorityAddress(req.programId, req.wallet, req.credentialId) !== req.authority) {
    return refuse('challenge-mismatch', "the authority is not this passkey's on this wallet");
  }
  if (req.minContextSlot !== undefined && BigInt(req.minContextSlot) > req.preparedSlot + MAX_FLOOR_AHEAD) {
    return refuse('typed-malformed', 'minContextSlot is far past the prepared slot');
  }
  const challenge = preparedChallenge(req);
  if (!bytesEqual(challenge, message)) return refuse('challenge-mismatch', 'the request does not recompute to the challenge sent');
  return { ok: true, request: req, challenge };
}
