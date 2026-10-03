/**
 * Who is asking: the channel a reply goes back on, and the web origin it is
 * addressed to.
 *
 * Origins come only from what the browser reports, never from a URL
 * parameter: `location.ancestorOrigins` and the `origin` of a message from
 * the parent or opener are browser-attested; `document.referrer` is weaker
 * (an embedder can blank it, and a page that navigates a frame or popup to
 * the portal is named instead of the frame's parent or the opener). A reply
 * is posted with that origin as its target, so the browser delivers it only
 * to a window showing that origin: whatever the evidence, a reply never
 * reaches an origin other than the one the portal displayed.
 */

export type Channel = 'iframe' | 'popup' | 'redirect' | 'webview' | 'none';
export type OriginEvidence = 'ancestor-origins' | 'message' | 'referrer' | 'none';

export interface RequesterInput {
  /** `window.parent !== window` */
  readonly framed: boolean;
  /** `!!window.opener && window.opener !== window` */
  readonly hasOpener: boolean;
  /** `Array.from(location.ancestorOrigins)`, or null where the browser has none. */
  readonly ancestorOrigins: readonly string[] | null;
  /** `document.referrer` */
  readonly referrer: string;
  /** `event.origin` of each message whose `source` is the parent (framed) or the opener (popup). */
  readonly messageOrigins: readonly string[];
  /** The redirect destination from the URL, if any. */
  readonly redirectUrl: string | null;
  /** `!!window.ReactNativeWebView` */
  readonly webview: boolean;
  /** The portal's own origin. */
  readonly selfOrigin: string;
}

export interface Requester {
  readonly channel: Channel;
  /** The web origin replies are addressed to (iframe, popup); null otherwise. */
  readonly origin: string | null;
  readonly evidence: OriginEvidence;
  /** Further ancestors above the parent, nearest first (iframe only). */
  readonly embeddedIn: readonly string[];
  /** The page that sent the user here, on the redirect channel. */
  readonly openedFrom: string | null;
  /** Two pieces of evidence name different origins: nothing is signed. */
  readonly conflict: boolean;
  /** The channel cannot be served (a redirect inside a frame, say). */
  readonly unsupported: boolean;
}

/** `https://host[:port]`, or `http://` for loopback hosts; null for anything else (opaque, other schemes). */
export function webOrigin(value: string | null | undefined): string | null {
  if (!value || value === 'null') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url.origin;
  return null;
}

export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

function result(partial: Partial<Requester> & Pick<Requester, 'channel'>): Requester {
  return {
    origin: null,
    evidence: 'none',
    embeddedIn: [],
    openedFrom: null,
    conflict: false,
    unsupported: false,
    ...partial,
  };
}

interface Source {
  readonly evidence: OriginEvidence;
  readonly origin: string | null;
  /** Evidence that names a sender that is not a usable web origin (opaque, plain http). */
  readonly unusable?: boolean;
}

/** Picks the strongest evidence, and flags a conflict when two sources disagree. */
function pick(sources: Source[]): Pick<Requester, 'origin' | 'evidence' | 'conflict'> {
  const named = sources.filter((s) => s.origin !== null || s.unusable);
  if (!named.length) return { origin: null, evidence: 'none', conflict: false };
  const first = named[0];
  const conflict = named.some((s) => s.unusable || s.origin !== first.origin);
  return { origin: first.unusable ? null : first.origin, evidence: first.evidence, conflict };
}

/**
 * Every message counts: a sender that is not a web origin (an opaque "null"
 * origin, say) cannot be answered, and makes the evidence a conflict.
 */
function fromMessages(origins: readonly string[]): Source[] {
  return origins.map((raw) => {
    const origin = webOrigin(raw);
    return { evidence: 'message', origin, unusable: origin === null };
  });
}

export function resolveRequester(input: RequesterInput): Requester {
  if (input.webview) return result({ channel: 'webview' });

  const referrer = webOrigin(input.referrer);
  const fromSelf = referrer === input.selfOrigin;

  if (input.redirectUrl !== null) {
    // A redirect replaces the page that shows it: inside a frame it would
    // carry the result to whatever that frame's embedder can read.
    if (input.framed) return result({ channel: 'redirect', unsupported: true });
    return result({ channel: 'redirect', openedFrom: referrer && !fromSelf ? referrer : null });
  }

  if (input.framed) {
    const ancestors = input.ancestorOrigins ?? [];
    const parent = input.ancestorOrigins ? webOrigin(ancestors[0]) : null;
    const chosen = pick([
      { evidence: 'ancestor-origins', origin: parent },
      ...fromMessages(input.messageOrigins),
      { evidence: 'referrer', origin: fromSelf ? null : referrer },
    ]);
    // An ancestor the browser redacted ("null") is still an ancestor.
    const embeddedIn = ancestors.slice(1).map((a) => webOrigin(a) ?? 'null');
    return result({ channel: 'iframe', ...chosen, embeddedIn });
  }

  if (input.hasOpener) {
    const chosen = pick([
      ...fromMessages(input.messageOrigins),
      { evidence: 'referrer', origin: fromSelf ? null : referrer },
    ]);
    return result({ channel: 'popup', ...chosen });
  }

  return result({ channel: 'none', unsupported: true });
}
