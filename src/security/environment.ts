/**
 * The browser side of requester resolution: what the window reports about
 * who embedded or opened the portal, and the messages that window sends.
 *
 * index.html starts recording messages from the parent or opener before the
 * app loads (the SDK may post before the bundle runs); `watchParentMessages`
 * takes over that record and keeps listening.
 */
import { fromParentOrOpener, helloAck, messageOrigins, type ParentMessage } from './handshake.ts';
import type { RequesterInput } from './requester.ts';

declare global {
  interface Window {
    /** Filled by the recorder in index.html until the app takes over. */
    __lkEarlyMessages?: ParentMessage[];
    /** Stops that recorder. */
    __lkEarlyStop?: () => void;
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

const MAX_MESSAGES = 32;

export function isFramed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

export function requesterInput(messages: readonly ParentMessage[], redirectUrl: string | null): RequesterInput {
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return {
    framed: isFramed(),
    hasOpener: !!window.opener && window.opener !== window,
    ancestorOrigins: ancestors ? Array.from(ancestors) : null,
    referrer: document.referrer,
    messageOrigins: messageOrigins(messages),
    redirectUrl,
    webview: !!window.ReactNativeWebView,
    selfOrigin: location.origin,
  };
}

/**
 * Calls `onChange` with every message so far from the parent or opener, now
 * and on each new one, and answers a hello that names `rid`. Returns the
 * function that stops listening.
 */
export function watchParentMessages(rid: string | null, onChange: (messages: readonly ParentMessage[]) => void): () => void {
  const messages: ParentMessage[] = [];
  const acked = new Set<string>();
  const add = (message: ParentMessage) => {
    if (messages.length >= MAX_MESSAGES) return;
    messages.push(message);
    const ack = helloAck(message, rid);
    if (ack && !acked.has(ack.targetOrigin)) {
      acked.add(ack.targetOrigin);
      const target = message.from === 'parent' ? window.parent : window.opener;
      try {
        target?.postMessage(ack.message, ack.targetOrigin);
      } catch {
        // The sender is gone.
      }
    }
  };

  for (const early of window.__lkEarlyMessages ?? []) add(early);
  const listener = (event: MessageEvent) => {
    const message = fromParentOrOpener(event, { self: window, parent: window.parent, opener: window.opener });
    if (!message) return;
    add(message);
    onChange([...messages]);
  };
  window.addEventListener('message', listener);
  window.__lkEarlyStop?.();
  onChange([...messages]);
  return () => window.removeEventListener('message', listener);
}

/** A coarse browser family for telemetry: never the user agent itself. */
export function browserFamily(): string {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? '-mobile' : '';
  if (/Edg\//.test(ua)) return `edge${mobile}`;
  if (/Firefox\//.test(ua) || /FxiOS/.test(ua)) return `firefox${mobile}`;
  if (/Chrome\//.test(ua) || /CriOS/.test(ua)) return `chrome${mobile}`;
  if (/Safari\//.test(ua)) return `safari${mobile}`;
  return `other${mobile}`;
}
