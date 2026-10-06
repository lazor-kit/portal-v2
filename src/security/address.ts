/**
 * How a Solana address is shown: a short form to recognise it by, the whole
 * address in groups of four to check it, the words a screen reader says for
 * each, and an identicon.
 *
 * The short form and the identicon help a person recognise an address they
 * have seen; neither identifies it. An attacker can grind an address that
 * shares the first and last four characters with another, so nothing here
 * ever says two addresses match: comparisons are on all 32 bytes.
 */
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';

/** The 32 bytes of a base58 address, or null when `address` is not one. */
export function addressBytes(address: string): Uint8Array | null {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** `7xKX…gAsU`: the first four and the last four characters, never fewer. */
export function shortAddress(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** The whole address in groups of four, every group alike. */
export function addressGroups(address: string): string[] {
  return address.match(/.{1,4}/g) ?? [];
}

/** One character as a screen reader should say it: base58 is case-sensitive. */
function spokenChar(ch: string): string {
  if (/[A-Z]/.test(ch)) return `capital ${ch}`;
  return ch;
}

const spell = (part: string) => [...part].map(spokenChar).join(', ');

/** "address starting 7, x, capital K, capital X, ending g, capital A, s, capital U" */
export function spokenShortAddress(address: string): string {
  if (address.length <= 9) return `address ${spell(address)}`;
  return `address starting ${spell(address.slice(0, 4))}, ending ${spell(address.slice(-4))}`;
}

/** The whole address, group by group, with the case of every letter. */
export function spokenFullAddress(address: string): string {
  return addressGroups(address)
    .map((group, i) => `group ${i + 1}: ${spell(group)}`)
    .join('; ');
}

/** Number of identicon colours; each one has its own CSS token (`--id-0` … `--id-7`). */
export const IDENTICON_COLORS = 8;
export const IDENTICON_SIZE = 5;

export interface Identicon {
  /** Row-major 5×5 cells, mirrored left to right. */
  readonly cells: readonly boolean[];
  /** 0 to 7. */
  readonly color: number;
}

/**
 * A 5×5 left-right symmetric pattern and one of eight colours, from SHA-256
 * of the address's 32 bytes. The pattern carries the information, so it
 * reads the same in greyscale and to people who don't see colour.
 */
export function identicon(bytes: Uint8Array): Identicon {
  const digest = sha256(bytes);
  const half = Math.ceil(IDENTICON_SIZE / 2); // 3 columns, mirrored
  const cells: boolean[] = new Array(IDENTICON_SIZE * IDENTICON_SIZE).fill(false);
  let bit = 0;
  for (let row = 0; row < IDENTICON_SIZE; row++) {
    for (let col = 0; col < half; col++) {
      const on = ((digest[bit >> 3] >> (bit & 7)) & 1) === 1;
      bit++;
      cells[row * IDENTICON_SIZE + col] = on;
      cells[row * IDENTICON_SIZE + (IDENTICON_SIZE - 1 - col)] = on;
    }
  }
  // Never blank: an empty square would look like a missing image.
  if (!cells.some(Boolean)) cells[2 * IDENTICON_SIZE + 2] = true;
  return { cells, color: digest[31] % IDENTICON_COLORS };
}
