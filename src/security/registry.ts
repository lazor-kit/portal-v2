/**
 * Apps registered with the portal: the web origins that may embed or open
 * it, and the destinations it may redirect to. Loaded from
 * config/registry.json at build time.
 */
import { webOrigin } from './requester.ts';

export interface RegisteredApp {
  /** Stable id, e.g. "acme-wallet". */
  readonly id: string;
  /** Shown to the user next to the requesting origin or app. */
  readonly name: string;
  /** Exact web origins, e.g. "https://app.acme.xyz". */
  readonly origins?: readonly string[];
  /**
   * Redirect destinations, each a prefix: "acme://" (any URL of that
   * scheme), "acme://auth/" or "https://app.acme.xyz/callback".
   */
  readonly redirects?: readonly string[];
  /** Whether the app may ask for 32-byte program challenges (until preimage support). Default true. */
  readonly programChallenges?: boolean;
}

export interface Registry {
  readonly version: 1;
  readonly apps: readonly RegisteredApp[];
}

export function appForOrigin(registry: Registry, origin: string | null): RegisteredApp | undefined {
  if (!origin) return undefined;
  return registry.apps.find((app) => app.origins?.some((o) => webOrigin(o) === origin));
}

/**
 * Whether `url` falls under the registered `prefix`. A scheme-only prefix
 * ("acme://") covers the whole scheme; otherwise the URL must have the same
 * scheme, host and port, and a path that equals the prefix's path or
 * continues it after a "/".
 */
export function redirectMatches(prefix: string, url: URL): boolean {
  const schemeOnly = /^([a-z][a-z0-9+.-]*):(\/\/)?$/i.exec(prefix);
  if (schemeOnly) return url.protocol === `${schemeOnly[1].toLowerCase()}:`;
  let base: URL;
  try {
    base = new URL(prefix);
  } catch {
    return false;
  }
  if (base.protocol !== url.protocol || base.host !== url.host) return false;
  // Custom schemes keep an empty host in some engines: compare the href
  // before the query instead.
  const target = url.href.split(/[?#]/)[0];
  const root = base.href.split(/[?#]/)[0];
  if (target === root) return true;
  const withSlash = root.endsWith('/') ? root : `${root}/`;
  return target.startsWith(withSlash);
}

export function appForRedirect(registry: Registry, url: URL): RegisteredApp | undefined {
  return registry.apps.find((app) => app.redirects?.some((prefix) => redirectMatches(prefix, url)));
}
