/**
 * Where a result may be redirected: registered destinations, plus what the
 * policy allows while the registry is being filled.
 */
import type { RegisteredApp, Registry } from './registry.ts';
import { appForRedirect } from './registry.ts';
import { isLoopback } from './requester.ts';

export interface RedirectPolicy {
  /**
   * Custom schemes ("acme://") not in the registry: `allow` (shown as an
   * unregistered app) or `deny`.
   */
  readonly unregisteredSchemes: 'allow' | 'deny';
  /**
   * http(s) destinations not in the registry: `same-origin` allows one on the
   * requesting web origin only; `deny` refuses them all. Loopback http is
   * treated like https.
   */
  readonly unregisteredWeb: 'same-origin' | 'deny';
  /** Schemes never redirected to, registered or not. */
  readonly deniedSchemes: readonly string[];
}

export const ALWAYS_DENIED_SCHEMES: readonly string[] = [
  'javascript', 'data', 'blob', 'file', 'filesystem', 'about', 'vbscript',
  'intent', 'chrome', 'chrome-extension', 'ws', 'wss', 'ftp',
];

export type RedirectDecision =
  | { readonly ok: true; readonly url: URL; readonly app?: RegisteredApp; readonly registered: boolean }
  | { readonly ok: false; readonly reason: 'invalid-url' | 'denied-scheme' | 'insecure-http' | 'unregistered-destination' };

export function checkRedirect(
  raw: string,
  context: { registry: Registry; policy: RedirectPolicy; requesterOrigin: string | null },
): RedirectDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const denied = new Set([...ALWAYS_DENIED_SCHEMES, ...context.policy.deniedSchemes.map((s) => s.toLowerCase())]);
  if (denied.has(scheme)) return { ok: false, reason: 'denied-scheme' };
  if (url.username || url.password) return { ok: false, reason: 'invalid-url' };

  const isWeb = scheme === 'https' || scheme === 'http';
  if (scheme === 'http' && !isLoopback(url.hostname)) return { ok: false, reason: 'insecure-http' };

  const app = appForRedirect(context.registry, url);
  if (app) return { ok: true, url, app, registered: true };

  if (isWeb) {
    if (context.policy.unregisteredWeb === 'same-origin' && context.requesterOrigin !== null && url.origin === context.requesterOrigin) {
      return { ok: true, url, registered: false };
    }
    return { ok: false, reason: 'unregistered-destination' };
  }

  if (context.policy.unregisteredSchemes === 'allow') return { ok: true, url, registered: false };
  return { ok: false, reason: 'unregistered-destination' };
}
