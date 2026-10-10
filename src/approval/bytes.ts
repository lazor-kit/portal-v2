/**
 * Byte helpers for the approval module: little-endian integers, base58
 * addresses and base64url, each in one canonical form. Decoders return null
 * for anything that does not re-encode to the same text.
 *
 * Only @noble/hashes and @noble/curves are imported anywhere in
 * src/approval, so the module bundles for the browser and React Native
 * without polyfills.
 */

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const U64_MAX = (1n << 64n) - 1n;
export const U32_MAX = 0xffff_ffff;

export function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new RangeError('u64 out of range');
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError('u32 out of range');
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

export function u16le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError('u16 out of range');
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

export function readU64(bytes: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}

export function readU32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}

export function readU16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ─── base58 ────────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX: Record<string, number> = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** The bytes `text` encodes, or null when it is not base58 in canonical form. */
export function base58Decode(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 128) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of text) {
    const d = B58_INDEX[c];
    if (d === undefined) return null;
    n = n * 58n + BigInt(d);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return base58Encode(out) === text ? out : null;
}

/** A 32-byte address in canonical base58, or null. */
export function addressBytes(text: string): Uint8Array | null {
  const bytes = base58Decode(text);
  return bytes && bytes.length === 32 ? bytes : null;
}

// ─── base64url (no padding) ────────────────────────────────────────────────

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX: Record<string, number> = Object.fromEntries([...B64URL].map((c, i) => [c, i]));

export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/** The bytes of unpadded base64url `text`, or null when it is anything else (padding, `+`/`/`, stray bits). */
export function base64urlDecode(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const c of text) {
    const d = B64URL_INDEX[c];
    if (d === undefined) return null;
    acc = (acc << 6) | d;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  if (at !== out.length) return null;
  return base64urlEncode(out) === text ? out : null;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** UTF-8 text, or null when `bytes` is not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}
