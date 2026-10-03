/**
 * Text as the user is shown it: characters that are invisible, or that
 * reorder or hide what follows (control, bidirectional and zero-width
 * characters), are shown as their code point instead, so the text on screen
 * is the text that is signed. The zero-width joiner and variation selectors
 * stay, since emoji are built from them.
 */

export type Segment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'hidden'; readonly code: string };

const HIDDEN_RANGES: readonly [number, number][] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f], // includes CR; LF and TAB are shown as line breaks and tabs
  [0x007f, 0x009f], // DEL and C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200c], // zero-width space, zero-width non-joiner
  [0x200e, 0x200f], // LRM, RLM
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0x206a, 0x206f], // deprecated format characters
  [0x3164, 0x3164], // Hangul filler
  [0xfeff, 0xfeff], // byte-order mark
  [0xfff9, 0xfffb], // interlinear annotation
  [0xe0000, 0xe007f], // tags
];

export function isHiddenCodePoint(cp: number): boolean {
  return HIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

const codeOf = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

export function revealHidden(text: string): { segments: Segment[]; hidden: number } {
  const segments: Segment[] = [];
  let buffer = '';
  let hidden = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    // Lone surrogates cannot be encoded as UTF-8, so they never reach here
    // from a signed message; show one anyway rather than drop it.
    if (isHiddenCodePoint(cp) || (cp >= 0xd800 && cp <= 0xdfff)) {
      if (buffer) segments.push({ kind: 'text', text: buffer });
      buffer = '';
      segments.push({ kind: 'hidden', code: codeOf(cp) });
      hidden++;
    } else {
      buffer += ch;
    }
  }
  if (buffer) segments.push({ kind: 'text', text: buffer });
  return { segments, hidden };
}

/** `abcd…wxyz` style short form of a long identifier. */
export function shorten(value: string, keep = 8): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Hex in groups of four, for fingerprints read aloud or compared by eye. */
export function groupHex(hex: string): string {
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}
