/**
 * One event per decision and per result, so the registry and the rollout
 * stages can be judged from what integrations actually send.
 *
 * An event names the requester by origin (or "scheme://" for an app) and
 * never carries the challenge, credential, key, signature, message text,
 * transaction, or the path or query of any URL.
 */
import type { Decision, PortalPolicy, Subject } from './policy.ts';
import type { RedirectDecision } from './redirect.ts';
import type { Channel, OriginEvidence, Requester } from './requester.ts';

export type Outcome = 'shown' | 'refused' | 'approved' | 'rejected' | 'failed' | 'undelivered';

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
}

/** The requester as telemetry names it: an origin, or a redirect's scheme. */
export function requesterName(requester: Requester, redirect?: RedirectDecision): string | null {
  if (requester.channel === 'redirect') {
    if (!redirect?.ok) return null;
    const { protocol } = redirect.url;
    return protocol === 'https:' || protocol === 'http:' ? redirect.url.origin : `${protocol}//`;
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
