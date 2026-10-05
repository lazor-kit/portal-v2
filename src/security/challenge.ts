/**
 * The challenge formats the portal signs, and nothing else.
 *
 *   message     58 bytes  "LazorKit signed message v1" (26) || SHA-256(tag || UTF-8 text)
 *   ownership   59 bytes  "LazorKit ownership proof v1" (27) || 32 random bytes
 *   transaction 32 bytes  a program challenge hash, with a transaction preview
 *   approval    32 bytes  a program challenge hash with no preview (session,
 *                         authority and deferred operations of current SDKs)
 *
 * The two 32-byte kinds are gated by the portal policy (see policy.ts) until
 * requests carry the challenge preimage. Every other request is refused with
 * a reason.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesEqual, decodeBase64Strict, toHex } from './encoding.ts';

export const SIGNED_MESSAGE_DOMAIN = 'LazorKit signed message v1';
export const OWNERSHIP_PROOF_DOMAIN = 'LazorKit ownership proof v1';

const encoder = new TextEncoder();
const MESSAGE_TAG = encoder.encode(SIGNED_MESSAGE_DOMAIN);
const PROOF_TAG = encoder.encode(OWNERSHIP_PROOF_DOMAIN);

export const MESSAGE_CHALLENGE_LENGTH = MESSAGE_TAG.length + 32; // 58
export const OWNERSHIP_CHALLENGE_LENGTH = PROOF_TAG.length + 32; // 59
export const PROGRAM_CHALLENGE_LENGTH = 32;

/** What the request asks for, as read from the URL. `null` means the parameter is absent. */
export interface ChallengeRequest {
  readonly action: 'connect' | 'sign';
  /** The challenge: `challenge` on connect, `message` on sign. */
  readonly challenge: string | null;
  readonly displayMessage: string | null;
  readonly transaction: string | null;
}

export type RefusalReason =
  | 'missing-challenge'
  | 'malformed-challenge'
  | 'unrecognised-format'
  | 'display-text-mismatch'
  | 'payload-not-allowed'
  | 'connect-challenge-not-proof';

export type ClassifiedChallenge =
  | { readonly kind: 'message'; readonly challenge: Uint8Array; readonly text: string }
  | { readonly kind: 'message-without-text'; readonly challenge: Uint8Array; readonly fingerprint: string }
  | { readonly kind: 'ownership'; readonly challenge: Uint8Array }
  | { readonly kind: 'transaction'; readonly challenge: Uint8Array; readonly preview: string }
  | { readonly kind: 'approval'; readonly challenge: Uint8Array }
  | { readonly kind: 'refused'; readonly reason: RefusalReason };

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return bytesEqual(bytes.subarray(0, prefix.length), prefix);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** `tag || SHA-256(tag || UTF-8(text))`: the challenge for a signed message. */
export function messageChallengeFor(text: string): Uint8Array {
  return concat(MESSAGE_TAG, sha256(concat(MESSAGE_TAG, encoder.encode(text))));
}

/** Whether `bytes` has the ownership-proof shape. */
export function isOwnershipChallenge(bytes: Uint8Array): boolean {
  return bytes.length === OWNERSHIP_CHALLENGE_LENGTH && startsWith(bytes, PROOF_TAG);
}

/** Whether `bytes` has the signed-message shape. */
export function isMessageChallenge(bytes: Uint8Array): boolean {
  return bytes.length === MESSAGE_CHALLENGE_LENGTH && startsWith(bytes, MESSAGE_TAG);
}

const present = (value: string | null): value is string => value !== null;
const nonEmpty = (value: string | null): value is string => value !== null && value !== '';

/**
 * Sorts a request into one of the recognised formats, or refuses it.
 *
 * - A message challenge is shown as `displayMessage` only when the challenge
 *   recomputed from that text is exactly the one requested; with no
 *   `displayMessage` it is a message the portal cannot show.
 * - An ownership proof carries no transaction and no text.
 * - On connect, only an ownership proof is a challenge.
 * - A 32-byte hash carries no text; with a preview it is a transaction,
 *   without one an approval.
 */
export function classifyChallenge(request: ChallengeRequest): ClassifiedChallenge {
  if (!nonEmpty(request.challenge)) return { kind: 'refused', reason: 'missing-challenge' };
  const bytes = decodeBase64Strict(request.challenge);
  if (!bytes) return { kind: 'refused', reason: 'malformed-challenge' };

  const hasPreview = nonEmpty(request.transaction);
  const hasText = present(request.displayMessage);

  if (request.action === 'connect') {
    if (!isOwnershipChallenge(bytes)) return { kind: 'refused', reason: 'connect-challenge-not-proof' };
    if (hasPreview || hasText) return { kind: 'refused', reason: 'payload-not-allowed' };
    return { kind: 'ownership', challenge: bytes };
  }

  if (isMessageChallenge(bytes)) {
    if (hasPreview) return { kind: 'refused', reason: 'payload-not-allowed' };
    if (!hasText) return { kind: 'message-without-text', challenge: bytes, fingerprint: toHex(bytes.subarray(MESSAGE_TAG.length)) };
    if (!bytesEqual(messageChallengeFor(request.displayMessage as string), bytes)) {
      return { kind: 'refused', reason: 'display-text-mismatch' };
    }
    return { kind: 'message', challenge: bytes, text: request.displayMessage as string };
  }

  if (isOwnershipChallenge(bytes)) {
    if (hasPreview || hasText) return { kind: 'refused', reason: 'payload-not-allowed' };
    return { kind: 'ownership', challenge: bytes };
  }

  if (bytes.length === PROGRAM_CHALLENGE_LENGTH) {
    if (hasText) return { kind: 'refused', reason: 'payload-not-allowed' };
    if (hasPreview) return { kind: 'transaction', challenge: bytes, preview: request.transaction as string };
    return { kind: 'approval', challenge: bytes };
  }

  return { kind: 'refused', reason: 'unrecognised-format' };
}
