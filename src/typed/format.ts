/**
 * How typed screens write amounts, times and windows (DESIGN §5.1):
 *
 * - amounts exactly, from base units, trailing zeros trimmed, never rounded;
 * - times in the viewer's time zone, "about" because the cluster clock can
 *   drift from wall time; the relative form is measured against the
 *   cluster's clock, not the device's;
 * - a recurring window in words ("a day", "every 3 days", "every 90 minutes").
 */

/** `amount` base units with `decimals`, exact: 20000000 lamports → "0.02". Thousands grouped. */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const LAMPORTS_DECIMALS = 9;

/**
 * A window in seconds, after an amount: "a day", "an hour", "every minute",
 * "every second", "every 3 days", "every 90 minutes".
 */
export function windowPhrase(seconds: bigint): string {
  if (seconds === 86_400n) return 'a day';
  if (seconds === 604_800n) return 'a week';
  if (seconds === 3_600n) return 'an hour';
  if (seconds === 60n) return 'every minute';
  if (seconds === 1n) return 'every second';
  if (seconds % 86_400n === 0n) return `every ${seconds / 86_400n} days`;
  if (seconds % 3_600n === 0n) return `every ${seconds / 3_600n} hours`;
  if (seconds % 60n === 0n) return `every ${seconds / 60n} minutes`;
  return `every ${seconds} seconds`;
}

/** A window a binary without Unix-time expiry measures in slots: "every slot", "every 216,000 slots". */
export function slotWindowPhrase(slots: bigint): string {
  return slots === 1n ? 'every slot' : `every ${slots.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} slots`;
}

export interface Clock {
  /** The viewer's time zone (the browser's when absent). */
  readonly timeZone?: string;
}

function parts(unixSeconds: bigint, timeZone: string | undefined): { day: string; time: string; date: string } {
  const at = new Date(Number(unixSeconds) * 1000);
  const tz = timeZone ? { timeZone } : {};
  const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...tz }).format(at);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', ...tz }).format(at);
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...tz }).format(at);
  return { day, time: time.replace(/\u202f/g, ' '), date };
}

/**
 * A moment as a person reads it, relative to `now` (both Unix seconds):
 * "6:50 PM", "6:50 PM tomorrow", "Oct 14, 6:50 PM".
 */
export function formatMoment(unixSeconds: bigint, now: bigint, clock: Clock = {}): string {
  const at = parts(unixSeconds, clock.timeZone);
  const today = parts(now, clock.timeZone);
  const tomorrow = parts(now + 86_400n, clock.timeZone);
  if (at.day === today.day) return at.time;
  if (at.day === tomorrow.day) return `${at.time} tomorrow`;
  return `${at.date}, ${at.time}`;
}

/** "in about 3 hours", against the cluster's clock. */
export function relativePhrase(unixSeconds: bigint, now: bigint): string {
  const s = Number(unixSeconds - now);
  if (s <= 90) return 'in about a minute';
  if (s < 3_600 * 1.5) {
    const m = Math.round(s / 60);
    return m >= 60 ? 'in about an hour' : `in about ${m} minutes`;
  }
  if (s < 86_400 * 1.5) {
    const h = Math.round(s / 3_600);
    return h === 1 ? 'in about an hour' : h >= 24 ? 'in about a day' : `in about ${h} hours`;
  }
  const d = Math.round(s / 86_400);
  return d === 1 ? 'in about a day' : `in about ${d} days`;
}

/** A requester's name at the start of a sentence: "the app" becomes "The app"; a host stays as it is. */
export function cap(text: string): string {
  return text.startsWith('the ') ? `T${text.slice(1)}` : text;
}

/** `7xKX…gAsU`. */
export function short(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** "SOL", "SOL or USDC", "SOL, USDC or USDT". */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
