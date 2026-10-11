/**
 * Text as the user is shown it: characters that are invisible, or that
 * reorder or hide what follows (control, bidirectional and zero-width
 * characters), are shown as a labelled marker instead ("reversed text",
 * "invisible character"), never applied, so the text on screen is the text
 * that is signed; each marker's code point is listed in the details. The
 * zero-width joiner and variation selectors stay, since emoji are built from
 * them.
 */

export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'hidden';
      /** `U+202E` */
      readonly code: string;
      /** What the screen shows in its place, e.g. "reversed text". */
      readonly label: string;
      /** The character's name, e.g. "right-to-left override". */
      readonly name: string;
      /** It changes the direction text is read in. */
      readonly direction: boolean;
      /** Position in the text, counted in characters from 1. */
      readonly position: number;
    };

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

const NAMES: Record<number, string> = {
  0x000d: 'carriage return',
  0x00ad: 'soft hyphen',
  0x061c: 'Arabic letter mark',
  0x115f: 'Hangul choseong filler',
  0x1160: 'Hangul jungseong filler',
  0x180e: 'Mongolian vowel separator',
  0x200b: 'zero width space',
  0x200c: 'zero width non-joiner',
  0x200e: 'left-to-right mark',
  0x200f: 'right-to-left mark',
  0x2028: 'line separator',
  0x2029: 'paragraph separator',
  0x202a: 'left-to-right embedding',
  0x202b: 'right-to-left embedding',
  0x202c: 'pop directional formatting',
  0x202d: 'left-to-right override',
  0x202e: 'right-to-left override',
  0x2060: 'word joiner',
  0x2061: 'function application',
  0x2062: 'invisible times',
  0x2063: 'invisible separator',
  0x2064: 'invisible plus',
  0x2066: 'left-to-right isolate',
  0x2067: 'right-to-left isolate',
  0x2068: 'first strong isolate',
  0x2069: 'pop directional isolate',
  0x3164: 'Hangul filler',
  0xfeff: 'zero width no-break space',
};

/** Characters that change the direction the text after them is read in. */
const DIRECTIONAL = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/** How a hidden character is shown in its place, and its name. */
export function describeHidden(cp: number): { label: string; name: string; direction: boolean } {
  const direction = DIRECTIONAL.has(cp);
  const name = NAMES[cp];
  if (cp === 0x202e) return { label: 'reversed text', name: name, direction };
  if (direction) return { label: 'direction change', name: name, direction };
  if (cp >= 0xd800 && cp <= 0xdfff) return { label: 'invalid character', name: 'lone surrogate', direction };
  if (cp === 0x2028 || cp === 0x2029) return { label: 'line break character', name: name, direction };
  if (cp >= 0xe0000 && cp <= 0xe007f) return { label: 'invisible tag', name: 'tag character', direction };
  if (cp >= 0xfff9 && cp <= 0xfffb) return { label: 'invisible annotation', name: 'interlinear annotation character', direction };
  if (cp >= 0x206a && cp <= 0x206f) return { label: 'invisible character', name: 'deprecated format character', direction };
  if (cp === 0x115f || cp === 0x1160 || cp === 0x3164) return { label: 'blank filler', name: name, direction };
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return { label: 'control character', name: name ?? 'control character', direction };
  return { label: 'invisible character', name: name ?? 'format character', direction };
}

export function revealHidden(text: string): { segments: Segment[]; hidden: number; directional: number } {
  const segments: Segment[] = [];
  let buffer = '';
  let hidden = 0;
  let directional = 0;
  let position = 0;
  for (const ch of text) {
    position++;
    const cp = ch.codePointAt(0) as number;
    // Lone surrogates cannot be encoded as UTF-8, so they never reach here
    // from a signed message; show one anyway rather than drop it.
    if (isHiddenCodePoint(cp) || (cp >= 0xd800 && cp <= 0xdfff)) {
      if (buffer) segments.push({ kind: 'text', text: buffer });
      buffer = '';
      const described = describeHidden(cp);
      segments.push({ kind: 'hidden', code: codeOf(cp), position, ...described });
      hidden++;
      if (described.direction) directional++;
    } else {
      buffer += ch;
    }
  }
  if (buffer) segments.push({ kind: 'text', text: buffer });
  return { segments, hidden, directional };
}

/** Hex in groups of four, for fingerprints read aloud or compared by eye. */
export function groupHex(hex: string): string {
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}
