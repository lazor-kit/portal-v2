/**
 * A host as the screen shows it, with the part a person should read set
 * apart: the name registered under its public suffix ("fernway" in
 * www.fernway.example, "tinydex" in swap.tinydex.fun, "foo" in
 * foo.github.io). The split uses the Public Suffix List, private domains
 * included, so a site on a shared host never has the host's name set apart.
 * Hosts with no registrable name (localhost, an IP address, a public suffix
 * itself) are set apart whole.
 */
import { parse } from 'tldts';

export interface HostParts {
  /** Subdomains and their dot, e.g. "www." */
  readonly before: string;
  /** The registered name, e.g. "fernway"; the whole host when there is none. */
  readonly registrable: string;
  /** The public suffix with its dot, and any port, e.g. ".example" or ":5174". */
  readonly after: string;
}

/** `host` is a URL host: a lower-case (punycode) hostname, with an optional port. */
export function hostParts(host: string): HostParts {
  const port = /:(\d+)$/.exec(host);
  const hostname = port ? host.slice(0, port.index) : host;
  const portPart = port ? port[0] : '';
  const parsed = parse(hostname, { allowPrivateDomains: true });
  const name = parsed.domainWithoutSuffix;
  if (parsed.isIp || !parsed.domain || !name || !parsed.publicSuffix) {
    return { before: '', registrable: hostname, after: portPart };
  }
  const before = parsed.subdomain ? `${parsed.subdomain}.` : '';
  const after = `.${parsed.publicSuffix}${portPart}`;
  // Only a split that puts the host back together exactly is used.
  if (`${before}${name}${after}` !== host) return { before: '', registrable: hostname, after: portPart };
  return { before, registrable: name, after };
}

/** The host of a web origin (`https://www.fernway.example` → `www.fernway.example`), or null. */
export function originHost(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * Whether two web origins are the same site: the same scheme and registrable
 * domain (by the Public Suffix List, private domains included), so
 * app.fernway.example and www.fernway.example are one site and two
 * foo.github.io sites are not. Hosts with no registrable domain (localhost,
 * an IP address) must match exactly.
 */
export function sameSite(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  let x: URL;
  let y: URL;
  try {
    x = new URL(a);
    y = new URL(b);
  } catch {
    return false;
  }
  if (x.protocol !== y.protocol) return false;
  const site = (url: URL) => {
    const parsed = parse(url.hostname, { allowPrivateDomains: true });
    return !parsed.isIp && parsed.domain ? parsed.domain : url.hostname;
  };
  return site(x) === site(y);
}
