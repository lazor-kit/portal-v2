/**
 * Messages from the window that embedded or opened the portal, kept as
 * evidence of who that window is (its browser-reported `origin`), and the
 * optional `lazorkit:hello` handshake:
 *
 *   SDK -> portal   { type: 'lazorkit:hello', v: 1, rid }   to the portal origin
 *   portal -> SDK   { type: 'lazorkit:hello-ack', rid }     to the sender's origin
 *
 * `rid` must equal the `rid` the portal URL carries. Only a message's origin,
 * type and rid are kept; its data never is.
 */
import { webOrigin } from './requester.ts';

export const HELLO = 'lazorkit:hello';
export const HELLO_ACK = 'lazorkit:hello-ack';

export interface ParentMessage {
  readonly origin: string;
  readonly from: 'parent' | 'opener';
  /** `data.type` when it is a short string. */
  readonly type: string | null;
  /** `data.rid` of a version-1 hello. */
  readonly rid: string | null;
}

export interface WindowRefs {
  readonly self: unknown;
  readonly parent: unknown;
  readonly opener: unknown;
}

export interface IncomingMessage {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

/** The message as evidence when the parent (in a frame) or the opener (in a popup) sent it; null otherwise. */
export function fromParentOrOpener(event: IncomingMessage, refs: WindowRefs): ParentMessage | null {
  if (event.source === null || event.source === undefined) return null;
  const framed = refs.parent !== refs.self;
  let from: ParentMessage['from'] | null = null;
  if (framed && event.source === refs.parent) from = 'parent';
  else if (!framed && refs.opener && refs.opener !== refs.self && event.source === refs.opener) from = 'opener';
  if (!from) return null;
  const data = typeof event.data === 'object' && event.data !== null ? (event.data as Record<string, unknown>) : {};
  const type = typeof data.type === 'string' && data.type.length <= 64 ? data.type : null;
  const rid = type === HELLO && data.v === 1 && typeof data.rid === 'string' && data.rid.length <= 64 ? data.rid : null;
  return { origin: String(event.origin), from, type, rid };
}

/** The ack for a hello that names this request's `rid`, addressed to its sender; null for anything else. */
export function helloAck(message: ParentMessage, rid: string | null): { message: { type: string; rid: string }; targetOrigin: string } | null {
  if (message.type !== HELLO || !rid || message.rid !== rid) return null;
  const origin = webOrigin(message.origin);
  if (!origin) return null;
  return { message: { type: HELLO_ACK, rid }, targetOrigin: origin };
}

/** The origins the evidence uses: every message from the parent or opener. */
export function messageOrigins(messages: readonly ParentMessage[]): string[] {
  return messages.map((m) => m.origin);
}
