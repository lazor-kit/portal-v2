/**
 * What the portal does with a request: show it for approval (with the
 * warnings it carries) or refuse it. Pure: every input is passed in.
 *
 * Loaded from config/portal-policy.json at build time.
 */
import type { ApprovalRequest } from '../approval/envelope.ts';
import type { ClassifiedChallenge, RefusalReason } from './challenge.ts';
import { destinationLabel, type RedirectDecision, type RedirectPolicy } from './redirect.ts';
import type { RegisteredApp, Registry } from './registry.ts';
import { appForOrigin } from './registry.ts';
import type { Requester } from './requester.ts';

/** `allow`: anyone; `registered`: registered apps only; `deny`: no one. */
export type Gate = 'allow' | 'registered' | 'deny';

export interface PortalPolicy {
  readonly version: 1;
  /** Reported with telemetry, so events can be read against the rollout stage. */
  readonly stage: 'transition' | 'enforce';
  readonly gates: {
    /** A message challenge sent without its text (bytes that are not UTF-8). */
    readonly messageWithoutText: Gate;
    /** A 32-byte program challenge with a transaction preview. */
    readonly transaction: Gate;
    /** A 32-byte program challenge with no preview. */
    readonly approval: Gate;
    /** Replies through a host app's WebView bridge (`window.ReactNativeWebView`); no app can be registered for it. */
    readonly webview: Gate;
  };
  /** On connect, a `challenge` that is not an ownership proof: sign in without it, or refuse the connect. */
  readonly connectNonProofChallenge: 'ignore' | 'refuse';
  readonly redirects: RedirectPolicy;
  readonly framing: {
    /** `report`: Content-Security-Policy-Report-Only; `enforce`: Content-Security-Policy. */
    readonly mode: 'report' | 'enforce';
    readonly allowLoopback: boolean;
  };
  /**
   * The page's own content policy (where scripts, styles and data may come
   * from; see scripts/gen-headers.mjs): `report` (report-only) or `enforce`.
   */
  readonly contentPolicy: 'report' | 'enforce';
}

export type Warning =
  | 'unregistered-requester'
  | 'undisplayable-message'
  | 'preview-not-verified'
  | 'content-not-shown'
  | 'embedded'
  | 'opened-from-web';

export type DecisionReason =
  | RefusalReason
  | 'channel-unsupported'
  | 'requester-unknown'
  | 'requester-conflict'
  | 'redirect-refused'
  | 'kind-denied'
  | 'requires-registered-app'
  /** No `action` the portal knows. */
  | 'unknown-action'
  /** A sign request that names no passkey (`credentialId`). */
  | 'credential-missing';

export type Decision =
  | {
      readonly outcome: 'show';
      readonly app?: RegisteredApp;
      /** What the screen names as the requester: an origin, or a redirect destination (an app scheme with its host and path). */
      readonly requesterLabel: string;
      readonly warnings: readonly Warning[];
    }
  | { readonly outcome: 'refuse'; readonly reason: DecisionReason };

/**
 * What is to be signed: a classified challenge, a sign-in with no challenge
 * from the request, or a typed request whose envelope recomputes to the
 * challenge sent (`challenge`); a typed request is signed with the slot and
 * counter picked at Approve, never with `challenge` itself.
 */
export type Subject =
  | ClassifiedChallenge
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'typed'; readonly request: ApprovalRequest; readonly challenge: Uint8Array };

const GATED: Partial<Record<Subject['kind'], keyof PortalPolicy['gates']>> = {
  'message-without-text': 'messageWithoutText',
  transaction: 'transaction',
  approval: 'approval',
};

function passes(gate: Gate, registered: boolean): boolean {
  return gate === 'allow' || (gate === 'registered' && registered);
}

export function decide(input: {
  challenge: Subject;
  requester: Requester;
  /** Required on the redirect channel. */
  redirect?: RedirectDecision;
  registry: Registry;
  policy: PortalPolicy;
}): Decision {
  const { challenge, requester, redirect, registry, policy } = input;
  if (challenge.kind === 'refused') return { outcome: 'refuse', reason: challenge.reason };
  if (requester.unsupported) return { outcome: 'refuse', reason: 'channel-unsupported' };
  if (requester.conflict) return { outcome: 'refuse', reason: 'requester-conflict' };

  let app: RegisteredApp | undefined;
  let label: string;
  const warnings: Warning[] = [];

  switch (requester.channel) {
    case 'iframe':
    case 'popup':
      if (!requester.origin) return { outcome: 'refuse', reason: 'requester-unknown' };
      app = appForOrigin(registry, requester.origin);
      label = requester.origin;
      if (requester.embeddedIn.length) warnings.push('embedded');
      break;
    case 'redirect':
      if (!redirect || !redirect.ok) return { outcome: 'refuse', reason: 'redirect-refused' };
      app = redirect.app;
      label = destinationLabel(redirect.url);
      if (requester.openedFrom) warnings.push('opened-from-web');
      break;
    case 'webview':
      if (!passes(policy.gates.webview, false)) return { outcome: 'refuse', reason: 'channel-unsupported' };
      label = 'In-app browser';
      break;
    default:
      return { outcome: 'refuse', reason: 'channel-unsupported' };
  }

  const registered = app !== undefined;
  if (!registered) warnings.push('unregistered-requester');

  const gateName = GATED[challenge.kind];
  if (gateName) {
    const gate = policy.gates[gateName];
    if (gate === 'deny') return { outcome: 'refuse', reason: 'kind-denied' };
    if (!passes(gate, registered)) return { outcome: 'refuse', reason: 'requires-registered-app' };
    if ((challenge.kind === 'transaction' || challenge.kind === 'approval') && app?.programChallenges === false) {
      return { outcome: 'refuse', reason: 'kind-denied' };
    }
  }
  // A typed request shows what is signed, so no gate holds it back; an app
  // that may not ask for program challenges may not ask for these either.
  if (challenge.kind === 'typed' && app?.programChallenges === false) return { outcome: 'refuse', reason: 'kind-denied' };
  if (challenge.kind === 'message-without-text') warnings.push('undisplayable-message');
  if (challenge.kind === 'transaction') warnings.push('preview-not-verified');
  if (challenge.kind === 'approval') warnings.push('content-not-shown');

  return { outcome: 'show', app, requesterLabel: label, warnings };
}
