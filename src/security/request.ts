/**
 * From a request URL and its requester to what the portal does: the subject
 * to show, the decision, and the exact bytes a passkey would sign. The page
 * signs `signBytes` and nothing else.
 */
import type { FragmentRead } from '../approval/envelope.ts';
import { checkTypedRequest } from '../typed/request.ts';
import { classifyChallenge } from './challenge.ts';
import { decodeBase64Strict } from './encoding.ts';
import { challengeRequestOf, type PortalRequest } from './params.ts';
import { decide, type Decision, type PortalPolicy, type Subject } from './policy.ts';
import type { RedirectDecision } from './redirect.ts';
import type { Registry } from './registry.ts';
import type { Requester } from './requester.ts';

export interface Evaluation {
  readonly subject: Subject | null;
  readonly decision: Decision;
  /**
   * The WebAuthn challenge: the classified bytes; null for a sign-in with no
   * proof (a random one is used) and for a typed request (computed at Approve).
   */
  readonly signBytes: Uint8Array | null;
  /** The passkey a sign request names; null on connect. */
  readonly credential: Uint8Array | null;
}

/**
 * On connect, an ownership proof is signed as part of the sign-in. Anything
 * else in `challenge` is not signed: by policy the sign-in goes ahead without
 * it (older SDKs send random bytes there) or the connect is refused.
 */
export function connectSubject(request: PortalRequest, policy: PortalPolicy): Subject {
  const challengeRequest = challengeRequestOf(request);
  if (!challengeRequest) return { kind: 'refused', reason: 'missing-challenge' };
  const classified = classifyChallenge(challengeRequest);
  if (classified.kind !== 'refused') return classified;
  if (classified.reason === 'missing-challenge') return { kind: 'sign-in' };
  if ((classified.reason === 'connect-challenge-not-proof' || classified.reason === 'malformed-challenge') && policy.connectNonProofChallenge === 'ignore') {
    return { kind: 'sign-in' };
  }
  return classified;
}

export function evaluateRequest(input: {
  request: PortalRequest;
  requester: Requester;
  redirect?: RedirectDecision;
  registry: Registry;
  policy: PortalPolicy;
  /** The URL fragment as read at load, and the URL's length then. */
  typed?: { readonly fragment: FragmentRead; readonly urlLength: number };
}): Evaluation {
  const { request, requester, redirect, registry, policy, typed } = input;
  if (!request.action) return { subject: null, decision: { outcome: 'refuse', reason: 'unknown-action' }, signBytes: null, credential: null };

  let subject: Subject;
  let credential: Uint8Array | null = null;
  if (typed && typed.fragment.kind !== 'none') {
    // Once a fragment carries a request, nothing else is read: never the legacy screen.
    const checked = checkTypedRequest(typed.fragment, request, typed.urlLength);
    subject = checked.ok ? { kind: 'typed', request: checked.request, challenge: checked.challenge } : { kind: 'refused', reason: checked.code };
    credential = decodeBase64Strict(request.credentialId ?? '');
    if (credential && credential.length === 0) credential = null;
  } else if (request.action === 'connect') {
    subject = connectSubject(request, policy);
  } else {
    subject = classifyChallenge(challengeRequestOf(request)!);
    credential = decodeBase64Strict(request.credentialId ?? '');
    if (credential && credential.length === 0) credential = null;
  }

  const decision = decide({ challenge: subject, requester, redirect, registry, policy });
  if (decision.outcome === 'show' && request.action === 'sign' && !credential) {
    return { subject, decision: { outcome: 'refuse', reason: 'credential-missing' }, signBytes: null, credential: null };
  }
  const signBytes = decision.outcome === 'show' && subject.kind !== 'sign-in' && subject.kind !== 'refused' && subject.kind !== 'typed' ? subject.challenge : null;
  return { subject, decision, signBytes, credential };
}
