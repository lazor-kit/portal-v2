/**
 * Strict base64 / base64url decoding for request parameters.
 *
 * Accepts standard base64 (padded or not) or base64url (padded or not), one
 * alphabet per value, in canonical form only: a value that does not
 * re-encode to itself (stray characters, non-zero trailing bits, a length
 * that no byte string has) is refused rather than repaired.
 */

const STANDARD = /^[A-Za-z0-9+/]*={0,2}$/;
const URL_SAFE = /^[A-Za-z0-9_-]*={0,2}$/;

/** The bytes `input` encodes, or `null` when it is not canonical base64 or base64url. */
export function decodeBase64Strict(input: string): Uint8Array | null {
  if (typeof input !== 'string') return null;
  const isStandard = STANDARD.test(input);
  const isUrlSafe = URL_SAFE.test(input);
  if (!isStandard && !isUrlSafe) return null;

  const unpadded = input.replace(/=+$/, '');
  const padding = input.length - unpadded.length;
  if (unpadded.length % 4 === 1) return null;
  if (padding > 0 && input.length % 4 !== 0) return null;

  const standard = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // Canonical only: the same bytes must encode back to the same characters.
  if (encodeBase64(bytes).replace(/=+$/, '') !== standard) return null;
  return bytes;
}

/** Standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Lower-case hex. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** Constant-time equality for two byte strings. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
