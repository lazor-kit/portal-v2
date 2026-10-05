/**
 * One event per decision and per result, so the registry and the rollout
 * stages can be judged from what integrations actually send.
 *
 * An event names the requester by origin (or "scheme://" for an app) and
 * never carries the challenge, credential, key, signature, message text,
 * transaction, or the path or query of any URL. A refused redirect is named
 * the same way, by its destination's origin or scheme, so the apps it
 * affects can be found and registered.
 */
import type { Decision, PortalPolicy, Subject } from './policy.ts';
import { destinationName, type RedirectDecision } from './redirect.ts';
import type { Channel, OriginEvidence, Requester } from './requester.ts';

export type Outcome = 'shown' | 'refused' | 'approved' | 'rejected' | 'failed' | 'undelivered';

/**
 * Whether the page could check that it was visible when Approve was enabled:
 * `tracked` (a frame, with IntersectionObserver v2), `untracked` (a frame
 * without it), `top-level` (a popup or a page of its own).
 */
export type VisibilityTracking = 'tracked' | 'untracked' | 'top-level';

export interface TelemetryEvent {
  readonly v: 1;
  readonly stage: PortalPolicy['stage'];
  readonly event: 'request' | 'result';
  readonly action: 'connect' | 'sign' | null;
  readonly channel: Channel;
  readonly evidence: OriginEvidence;
  /** `https://host[:port]`, `scheme://`, or null. */
  readonly requester: string | null;
  readonly registered: boolean;
  readonly app: string | null;
  readonly kind: Subject['kind'] | null;
  readonly outcome: Outcome;
  readonly reason: string | null;
  readonly warnings: readonly string[];
  readonly cluster: string | null;
  readonly clusterSource: string | null;
  readonly browser: string;
  readonly embedded: boolean;
  readonly visibility: VisibilityTracking;
}

/** The requester as telemetry names it: an origin, or a redirect's scheme. */
export function requesterName(requester: Requester, redirect?: RedirectDecision): string | null {
  if (requester.channel === 'redirect') {
    if (!redirect) return null;
    return redirect.ok ? destinationName(redirect.url) : redirect.destination;
  }
  return requester.origin;
}

export function buildEvent(input: {
  policy: PortalPolicy;
  event: TelemetryEvent['event'];
  action: TelemetryEvent['action'];
  requester: Requester;
  redirect?: RedirectDecision;
  subject: Subject | null;
  decision: Decision;
  outcome: Outcome;
  reason?: string | null;
  cluster?: { cluster: string; source: string } | null;
  browser: string;
  visibility: VisibilityTracking;
}): TelemetryEvent {
  const { decision } = input;
  const shown = decision.outcome === 'show';
  return {
    v: 1,
    stage: input.policy.stage,
    event: input.event,
    action: input.action,
    channel: input.requester.channel,
    evidence: input.requester.evidence,
    requester: requesterName(input.requester, input.redirect),
    registered: shown && decision.app !== undefined,
    app: shown ? decision.app?.id ?? null : null,
    kind: input.subject ? (input.subject.kind === 'refused' ? 'refused' : input.subject.kind) : null,
    outcome: input.outcome,
    reason: input.reason ?? (decision.outcome === 'refuse' ? decision.reason : null),
    warnings: shown ? [...decision.warnings] : [],
    cluster: input.cluster?.cluster ?? null,
    clusterSource: input.cluster?.source ?? null,
    browser: input.browser,
    embedded: input.requester.embeddedIn.length > 0,
    visibility: input.visibility,
  };
}

/** Sends the event without waiting; telemetry never blocks or fails a request. */
export function sendEvent(event: TelemetryEvent, endpoint = '/api/telemetry'): void {
  try {
    const body = JSON.stringify(event);
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) return;
    void fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {
    // Dropped.
  }
}
