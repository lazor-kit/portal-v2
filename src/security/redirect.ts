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
   * unregistered app, with the full destination) or `deny`.
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

/**
 * Schemes that are never a redirect destination, registered or not:
 *
 * - script, document and local-resource schemes;
 * - schemes that hand a URL to a browser app, which then opens it on a web
 *   host (`x-safari-https://host/path`, `googlechromes://host/path`,
 *   `firefox://open-url?url=…`, Android `intent:` and `android-app:`), so
 *   the result would reach a web origin the web rules never checked;
 * - schemes that are not app callbacks (mail, messages, calls).
 *
 * Any scheme ending in `-http` or `-https` is refused as well (see
 * `isAlwaysDeniedScheme`).
 */
export const ALWAYS_DENIED_SCHEMES: readonly string[] = [
  // script, document, local resources
  'javascript', 'data', 'blob', 'file', 'filesystem', 'about', 'vbscript', 'view-source',
  'chrome', 'chrome-extension', 'moz-extension', 'safari-web-extension', 'ws', 'wss', 'ftp',
  // URL hand-off to a browser app
  'intent', 'android-app',
  'x-safari-http', 'x-safari-https', 'x-web-search',
  'googlechrome', 'googlechromes', 'googlechrome-x-callback',
  'firefox', 'firefox-focus', 'firefox-klar',
  'microsoft-edge', 'microsoft-edge-http', 'microsoft-edge-https',
  'opera', 'opera-http', 'opera-https', 'touch-http', 'touch-https',
  'brave', 'duckduckgo', 'ddgquicklink', 'vivaldi', 'samsunginternet', 'yandexbrowser-open-url', 'ucbrowser',
  // not app callbacks
  'mailto', 'sms', 'tel',
];

/** Whether `scheme` (lower case, no colon) is never a redirect destination. */
export function isAlwaysDeniedScheme(scheme: string): boolean {
  const s = scheme.toLowerCase();
  return ALWAYS_DENIED_SCHEMES.includes(s) || /-https?$/.test(s);
}

export type RedirectRefusal = 'invalid-url' | 'denied-scheme' | 'insecure-http' | 'unregistered-destination';

export type RedirectDecision =
  | { readonly ok: true; readonly url: URL; readonly app?: RegisteredApp; readonly registered: boolean }
  | {
      readonly ok: false;
      readonly reason: RedirectRefusal;
      /** The refused destination as telemetry names it (`https://host` or `scheme://`); null when it is not a URL. */
      readonly destination: string | null;
    };

/** `https://host[:port]` for a web URL, `scheme://` otherwise: never a path or query. */
export function destinationName(url: URL): string {
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : `${url.protocol}//`;
}

/**
 * What the screen shows for a destination: the origin for a web URL; for an
 * app scheme, everything before the query (scheme, host and path), so a
 * destination such as `newapp://evil.example/cb` is never shown as just
 * `newapp://`.
 */
export function destinationLabel(url: URL): string {
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  return url.href.split(/[?#]/)[0];
}

export function checkRedirect(
  raw: string,
  context: { registry: Registry; policy: RedirectPolicy; requesterOrigin: string | null },
): RedirectDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url', destination: null };
  }
  const refuse = (reason: RedirectRefusal): RedirectDecision => ({ ok: false, reason, destination: destinationName(url) });
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const denied = new Set(context.policy.deniedSchemes.map((s) => s.toLowerCase()));
  if (isAlwaysDeniedScheme(scheme) || denied.has(scheme)) return refuse('denied-scheme');
  if (url.username || url.password) return refuse('invalid-url');

  const isWeb = scheme === 'https' || scheme === 'http';
  if (scheme === 'http' && !isLoopback(url.hostname)) return refuse('insecure-http');

  const app = appForRedirect(context.registry, url);
  if (app) return { ok: true, url, app, registered: true };

  if (isWeb) {
    if (context.policy.unregisteredWeb === 'same-origin' && context.requesterOrigin !== null && url.origin === context.requesterOrigin) {
      return { ok: true, url, registered: false };
    }
    return refuse('unregistered-destination');
  }

  if (context.policy.unregisteredSchemes === 'allow') return { ok: true, url, registered: false };
  return refuse('unregistered-destination');
}
