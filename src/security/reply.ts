/**
 * Where a result goes, and in what shape.
 *
 *   iframe    window.parent.postMessage(message, requesting origin)
 *   popup     window.opener.postMessage(message, requesting origin), then close
 *   redirect  the checked destination, with the result in its query
 *
 * A message is always addressed to the origin the portal showed, so the
 * browser delivers it only to a window showing that origin. With no such
 * origin (or a conflict), or a destination that was refused, nothing is sent.
 *
 * Message shapes are the ones every @lazorkit/wallet 3.x accepts
 * (`WALLET_CONNECTED`, `SIGNATURE_CREATED`, `error`); redirect fields are the
 * ones @lazorkit/wallet-mobile-adapter 2.x reads.
 */
import type { RedirectDecision } from './redirect.ts';
import type { Requester } from './requester.ts';
import { webOrigin } from './requester.ts';

/** A WebAuthn assertion, base64 fields, as the SDKs read them. */
export interface AssertionFields {
  /** The signature, 64-byte r||s with low S. */
  readonly normalized: string;
  /** authenticatorData || SHA-256(clientDataJSON) */
  readonly msg: string;
  readonly clientDataJSONReturn: string;
  readonly authenticatorDataReturn: string;
}

interface ConnectedFields {
  readonly type: 'connected';
  readonly credentialId: string;
  /** Compressed P-256 key, base64: from the registration, or stored for this exact credential. */
  readonly publicKey?: string;
  readonly accountName?: string;
  readonly timestamp: number;
}

/**
 * A connect result. `kind` says what the reply proves:
 *
 * - `created`: the passkey was registered just now, and `publicKey` is its own;
 * - `asserted`: the sign-in signed the request's ownership proof, and
 *   `assertion` is over it;
 * - absent: a sign-in with no proof to sign. Then `publicKey`, if any, is the
 *   key stored for this exact credential when it was registered here.
 */
export type ConnectedResult =
  | (ConnectedFields & { readonly kind: 'created'; readonly publicKey: string; readonly assertion?: undefined })
  | (ConnectedFields & { readonly kind: 'asserted'; readonly assertion: AssertionFields })
  | (ConnectedFields & { readonly kind?: undefined; readonly assertion?: undefined });

export type PortalResult =
  | ConnectedResult
  | { readonly type: 'signed'; readonly credentialId: string; readonly assertion: AssertionFields; readonly timestamp: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

/**
 * The result of a sign-in: `asserted` only with an assertion over the
 * request's ownership proof; otherwise no `kind`, and the key stored for this
 * exact credential, if one was.
 */
export function signInResult(input: {
  credentialId: string;
  assertion?: AssertionFields;
  stored?: { readonly publicKey?: string; readonly name?: string };
  timestamp: number;
}): ConnectedResult {
  const fields: ConnectedFields = {
    type: 'connected',
    credentialId: input.credentialId,
    ...(input.stored?.publicKey ? { publicKey: input.stored.publicKey } : {}),
    ...(input.stored?.name ? { accountName: input.stored.name } : {}),
    timestamp: input.timestamp,
  };
  return input.assertion ? { ...fields, kind: 'asserted', assertion: input.assertion } : fields;
}

export type ReplyRoute =
  | { readonly channel: 'iframe' | 'popup'; readonly origin: string }
  | { readonly channel: 'redirect'; readonly url: URL; readonly legacyExpo: boolean }
  | { readonly channel: 'none' };

/** The route a reply takes, from the requester and (on the redirect channel) the checked destination. */
export function routeFor(requester: Requester, redirect?: RedirectDecision, legacyExpo = false): ReplyRoute {
  if (requester.unsupported || requester.conflict) return { channel: 'none' };
  if ((requester.channel === 'iframe' || requester.channel === 'popup') && requester.origin && webOrigin(requester.origin) === requester.origin) {
    return { channel: requester.channel, origin: requester.origin };
  }
  if (requester.channel === 'redirect' && redirect?.ok) return { channel: 'redirect', url: redirect.url, legacyExpo };
  return { channel: 'none' };
}

/**
 * Where the answer to a refused request goes: the requesting origin, or a
 * registered redirect destination. A destination that is not registered is
 * not navigated to for a refusal, so a refused request never sends the user
 * to an address it chose itself.
 */
export function refusalRoute(route: ReplyRoute, redirect?: RedirectDecision): ReplyRoute {
  if (route.channel !== 'redirect') return route;
  return redirect?.ok && redirect.registered ? route : { channel: 'none' };
}

/** The postMessage payload. */
export function messageFor(result: PortalResult): Record<string, unknown> {
  switch (result.type) {
    case 'connected':
      return {
        type: 'WALLET_CONNECTED',
        data: {
          credentialId: result.credentialId,
          ...(result.kind ? { kind: result.kind } : {}),
          connectionType: result.kind === 'created' ? 'create' : 'get',
          timestamp: result.timestamp,
          ...(result.publicKey ? { publickey: result.publicKey, publicKey: result.publicKey } : {}),
          ...(result.accountName ? { accountName: result.accountName } : {}),
          ...(result.assertion ?? {}),
        },
      };
    case 'signed':
      return {
        type: 'SIGNATURE_CREATED',
        data: { credentialId: result.credentialId, timestamp: result.timestamp, ...result.assertion },
      };
    case 'error':
      return { type: 'error', error: { message: result.message, code: result.code } };
  }
}

function setAssertion(params: URLSearchParams, a: AssertionFields): void {
  params.set('signature', a.normalized);
  params.set('msg', a.msg);
  params.set('clientDataJSONReturn', a.clientDataJSONReturn);
  params.set('authenticatorDataReturn', a.authenticatorDataReturn);
}

/** The destination with the result in its query. */
export function redirectUrlFor(destination: URL, result: PortalResult, legacyExpo = false): string {
  const url = new URL(destination.href);
  const params = url.searchParams;
  if (result.type === 'error') {
    params.set('type', 'error');
    params.set('error', result.message);
    params.set('code', result.code);
    return url.href;
  }
  params.set('success', 'true');
  params.set('credentialId', result.credentialId);
  params.set('timestamp', String(result.timestamp));
  params.set('environment', legacyExpo ? 'expo' : 'browser');
  params.set('platform', legacyExpo ? 'mobile' : 'web');
  if (result.type === 'connected') {
    params.set('type', 'WALLET_CONNECTED');
    if (result.kind) params.set('kind', result.kind);
    if (result.publicKey) params.set('publicKey', result.publicKey);
    if (result.accountName) params.set('accountName', result.accountName);
    if (result.assertion) setAssertion(params, result.assertion);
  } else {
    params.set('type', 'SIGNATURE_CREATED');
    setAssertion(params, result.assertion);
  }
  return url.href;
}

export interface ReplyWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  readonly opener: { postMessage(message: unknown, targetOrigin: string): void } | null;
  close(): void;
  navigate(url: string): void;
}

export type Delivery = 'posted' | 'redirected' | 'dropped';

export function sendReply(route: ReplyRoute, result: PortalResult, win: ReplyWindow): Delivery {
  switch (route.channel) {
    case 'iframe':
    case 'popup': {
      // Never a wildcard: only the origin the portal showed.
      if (webOrigin(route.origin) !== route.origin) return 'dropped';
      const target = route.channel === 'iframe' ? win.parent : win.opener;
      if (!target) return 'dropped';
      try {
        target.postMessage(messageFor(result), route.origin);
      } catch {
        return 'dropped';
      }
      if (route.channel === 'popup') win.close();
      return 'posted';
    }
    case 'redirect':
      win.navigate(redirectUrlFor(route.url, result, route.legacyExpo));
      return 'redirected';
    default:
      return 'dropped';
  }
}
