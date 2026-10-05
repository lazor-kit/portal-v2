/**
 * The request, as the URL states it. Nothing here is trusted: the challenge
 * is classified (challenge.ts), the requester comes from the browser
 * (requester.ts) and the redirect destination is checked (redirect.ts).
 */
import type { ChallengeRequest } from './challenge.ts';

export interface PortalRequest {
  readonly action: 'connect' | 'sign' | null;
  /** The challenge to sign, on `sign`. */
  readonly message: string | null;
  /** The ownership-proof challenge, on `connect`. */
  readonly challenge: string | null;
  /** The text of a signed message, which the portal checks against `message`. */
  readonly displayMessage: string | null;
  /** A transaction preview (base64), on `sign`. */
  readonly transaction: string | null;
  /** The passkey to sign with (base64), on `sign`. */
  readonly credentialId: string | null;
  readonly clusterSimulation: string | null;
  /** `redirect_url`, `redirectUrl` or `expo`: where a result goes on the redirect channel. */
  readonly redirectUrl: string | null;
  /** Which of the three names `redirectUrl` came from. */
  readonly redirectParam: 'redirect_url' | 'redirectUrl' | 'expo' | null;
  /** A request id the SDK may repeat in a `lazorkit:hello` handshake. */
  readonly rid: string | null;
}

const RID = /^[A-Za-z0-9_-]{8,64}$/;

/** `null` for an absent parameter; an empty value is kept, so a check can see it. */
function value(params: URLSearchParams, name: string): string | null {
  return params.has(name) ? params.get(name) : null;
}

export function readPortalRequest(search: string): PortalRequest {
  const params = new URLSearchParams(search);
  const action = params.get('action');
  let redirectUrl: string | null = null;
  let redirectParam: PortalRequest['redirectParam'] = null;
  for (const name of ['redirect_url', 'redirectUrl', 'expo'] as const) {
    const candidate = params.get(name);
    if (candidate) {
      redirectUrl = candidate;
      redirectParam = name;
      break;
    }
  }
  const rid = params.get('rid');
  return {
    action: action === 'connect' || action === 'sign' ? action : null,
    message: value(params, 'message'),
    challenge: value(params, 'challenge'),
    displayMessage: value(params, 'displayMessage'),
    transaction: value(params, 'transaction'),
    credentialId: params.get('credentialId') || null,
    clusterSimulation: params.get('clusterSimulation') || null,
    redirectUrl,
    redirectParam,
    rid: rid && RID.test(rid) ? rid : null,
  };
}

/** The fields the challenge classifier reads, or null when the action is unknown. */
export function challengeRequestOf(request: PortalRequest): ChallengeRequest | null {
  if (!request.action) return null;
  return {
    action: request.action,
    challenge: request.action === 'connect' ? request.challenge : request.message,
    displayMessage: request.displayMessage,
    transaction: request.transaction,
  };
}
