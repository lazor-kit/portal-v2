/**
 * Who is asking, as the screen names it. Only two sources count: the origin
 * the browser reports (or the checked redirect destination) and the
 * registry. Nothing the app sends changes what is shown here.
 *
 * - A registered web origin (a frame or a popup, which the browser names) is
 *   a "Verified site": its registered name, with the host underneath.
 * - Any other web origin is "Not verified", and the host is the name.
 * - A web destination on the redirect channel is never verified: any page
 *   can open the portal with it. A registered one is shown as where the
 *   answer returns to ("Registered link").
 * - An app destination (a custom scheme) is "An app on this phone", never
 *   verified: any app can claim a scheme.
 */
import { originHost } from './domain.ts';
import type { Channel } from './requester.ts';

export interface Who {
  readonly kind: 'site' | 'app' | 'unknown';
  /** The header's title: the registered name, the host, or "An app on this phone". */
  readonly title: string;
  /** How sentences name the requester: "Fernway", "swap.tinydex.fun", "the app". */
  readonly name: string;
  /** A registered web origin that the browser reported (a frame or a popup). */
  readonly verified: boolean;
  /** A web destination on the redirect channel: where the answer goes, not who asked. */
  readonly destination: boolean;
  /** The web host (with its port), for a site. */
  readonly host: string | null;
  /** The site is served over plain http (loopback only). */
  readonly insecure: boolean;
  /** The full origin of a site, e.g. "https://www.fernway.example". */
  readonly origin: string | null;
  /** Where the answer goes, for an app: scheme, host and path. */
  readonly returnsTo: string | null;
  /** The registered app's name, for a destination (app or web) registered to one. */
  readonly registeredAs: string | null;
}

const UNKNOWN: Who = {
  kind: 'unknown',
  title: 'Unknown site',
  name: 'the app',
  verified: false,
  destination: false,
  host: null,
  insecure: false,
  origin: null,
  returnsTo: null,
  registeredAs: null,
};

/**
 * `label` is the origin (iframe, popup), the redirect destination as
 * `destinationLabel` shows it, or null; `appName` the registered app's name.
 */
export function whoIsAsking(input: { channel: Channel; label: string | null; appName?: string }): Who {
  const { channel, label, appName } = input;
  if (channel === 'webview') {
    return { ...UNKNOWN, kind: 'app', title: 'An app on this phone', returnsTo: null };
  }
  if (!label) return UNKNOWN;
  const host = originHost(label);
  if (host && (channel === 'iframe' || channel === 'popup' || channel === 'redirect')) {
    const origin = new URL(label).origin;
    // On the redirect channel the label is where the answer goes; any page
    // could have opened the portal with it, so it is never "verified".
    const destination = channel === 'redirect';
    return {
      kind: 'site',
      title: appName ?? host,
      name: appName ?? host,
      verified: !destination && appName !== undefined,
      destination,
      host,
      insecure: origin.startsWith('http:'),
      origin,
      returnsTo: null,
      registeredAs: destination ? (appName ?? null) : null,
    };
  }
  if (channel === 'redirect') {
    return { ...UNKNOWN, kind: 'app', title: 'An app on this phone', returnsTo: label, registeredAs: appName ?? null };
  }
  return UNKNOWN;
}

/** The popover text for the header's badge or chip. */
export function badgeExplainer(who: Who): string {
  if (who.kind === 'site' && who.verified) {
    return `Verified site means the request came from ${who.host}, a website ${who.name} registered with LazorKit. It doesn't mean LazorKit vouches for ${who.name}.`;
  }
  if (who.kind === 'site' && who.destination) {
    return who.registeredAs
      ? `The answer goes to ${who.host}, an address ${who.registeredAs} registered with LazorKit. LazorKit can't tell which page opened this.`
      : "LazorKit hasn't verified who runs this site. The answer goes back to it.";
  }
  if (who.kind === 'site') {
    return "LazorKit hasn't verified who runs this site. That's common for new apps. Only continue if you trust it.";
  }
  if (who.kind === 'app') {
    return who.registeredAs
      ? `The answer goes to ${who.returnsTo}, a link ${who.registeredAs} registered. LazorKit can't confirm which app receives it.`
      : "LazorKit can't confirm which app on this phone receives the answer.";
  }
  return "LazorKit can't tell which site opened this.";
}
