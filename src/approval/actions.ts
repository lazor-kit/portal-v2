/**
 * The session action buffer (lazorkit-protocol `program/src/state/action.rs`),
 * decoded strictly: a buffer is accepted for a new session exactly when
 * `validate_actions_buffer` would accept it.
 *
 * Each action: type u8 · data_len u16 LE · expires_at u64 LE (Unix seconds,
 * 0 = never) · data. At most 16 actions, no trailing bytes.
 */
import { base58Encode, readU16, readU64 } from './bytes.ts';

export const ACTION_HEADER_SIZE = 11;
export const MAX_ACTIONS = 16;

export type Action =
  | { readonly type: 'solLimit'; readonly expiresAt: bigint; readonly remaining: bigint }
  | { readonly type: 'solRecurringLimit'; readonly expiresAt: bigint; readonly limit: bigint; readonly spent: bigint; readonly window: bigint; readonly lastReset: bigint }
  | { readonly type: 'solMaxPerTx'; readonly expiresAt: bigint; readonly max: bigint }
  | { readonly type: 'tokenLimit'; readonly expiresAt: bigint; readonly mint: string; readonly remaining: bigint }
  | {
      readonly type: 'tokenRecurringLimit';
      readonly expiresAt: bigint;
      readonly mint: string;
      readonly limit: bigint;
      readonly spent: bigint;
      readonly window: bigint;
      readonly lastReset: bigint;
    }
  | { readonly type: 'tokenMaxPerTx'; readonly expiresAt: bigint; readonly mint: string; readonly max: bigint }
  | { readonly type: 'programWhitelist'; readonly expiresAt: bigint; readonly program: string }
  | { readonly type: 'programBlacklist'; readonly expiresAt: bigint; readonly program: string };

export type ActionType = Action['type'];

/** Type byte → name and data size. */
const TYPES: Readonly<Record<number, { type: ActionType; size: number }>> = {
  1: { type: 'solLimit', size: 8 },
  2: { type: 'solRecurringLimit', size: 32 },
  3: { type: 'solMaxPerTx', size: 8 },
  4: { type: 'tokenLimit', size: 40 },
  5: { type: 'tokenRecurringLimit', size: 64 },
  6: { type: 'tokenMaxPerTx', size: 40 },
  10: { type: 'programWhitelist', size: 32 },
  11: { type: 'programBlacklist', size: 32 },
};

export type ActionsResult = { readonly ok: true; readonly actions: readonly Action[] } | { readonly ok: false; readonly reason: string };

/**
 * Decodes `buf`. `forNewSession` (the default) applies the creation rules too:
 * recurring limits start with nothing spent, no reset time and a window
 * above 0. A stored session's buffer (`forNewSession: false`) carries what
 * was spent since, and is only checked for shape.
 */
export function decodeActions(buf: Uint8Array, { forNewSession = true }: { forNewSession?: boolean } = {}): ActionsResult {
  const fail = (reason: string): ActionsResult => ({ ok: false, reason });
  const actions: Action[] = [];
  let cursor = 0;
  while (cursor < buf.length) {
    if (cursor + ACTION_HEADER_SIZE > buf.length) return fail('truncated action header');
    const spec = TYPES[buf[cursor]];
    if (!spec) return fail(`unknown action type ${buf[cursor]}`);
    const dataLen = readU16(buf, cursor + 1);
    const expiresAt = readU64(buf, cursor + 3);
    const at = cursor + ACTION_HEADER_SIZE;
    if (at + dataLen > buf.length) return fail('action data past the end');
    if (actions.length + 1 > MAX_ACTIONS) return fail(`more than ${MAX_ACTIONS} actions`);
    if (dataLen !== spec.size) return fail(`${spec.type} data is ${dataLen} bytes, not ${spec.size}`);
    const d = buf.subarray(at, at + dataLen);
    const mint = () => base58Encode(d.subarray(0, 32));
    switch (spec.type) {
      case 'solLimit':
        actions.push({ type: 'solLimit', expiresAt, remaining: readU64(d, 0) });
        break;
      case 'solRecurringLimit':
        actions.push({ type: 'solRecurringLimit', expiresAt, limit: readU64(d, 0), spent: readU64(d, 8), window: readU64(d, 16), lastReset: readU64(d, 24) });
        break;
      case 'solMaxPerTx':
        actions.push({ type: 'solMaxPerTx', expiresAt, max: readU64(d, 0) });
        break;
      case 'tokenLimit':
        actions.push({ type: 'tokenLimit', expiresAt, mint: mint(), remaining: readU64(d, 32) });
        break;
      case 'tokenRecurringLimit':
        actions.push({ type: 'tokenRecurringLimit', expiresAt, mint: mint(), limit: readU64(d, 32), spent: readU64(d, 40), window: readU64(d, 48), lastReset: readU64(d, 56) });
        break;
      case 'tokenMaxPerTx':
        actions.push({ type: 'tokenMaxPerTx', expiresAt, mint: mint(), max: readU64(d, 32) });
        break;
      case 'programWhitelist':
        actions.push({ type: 'programWhitelist', expiresAt, program: base58Encode(d) });
        break;
      case 'programBlacklist':
        actions.push({ type: 'programBlacklist', expiresAt, program: base58Encode(d) });
        break;
    }
    cursor = at + dataLen;
  }

  if (actions.some((a) => a.type === 'programWhitelist') && actions.some((a) => a.type === 'programBlacklist')) {
    return fail('a program whitelist and a blacklist together');
  }
  for (const single of ['solLimit', 'solRecurringLimit', 'solMaxPerTx'] as const) {
    if (actions.filter((a) => a.type === single).length > 1) return fail(`more than one ${single}`);
  }
  for (const perMint of ['tokenLimit', 'tokenRecurringLimit', 'tokenMaxPerTx'] as const) {
    const mints = actions.flatMap((a) => (a.type === perMint ? [a.mint] : []));
    if (new Set(mints).size !== mints.length) return fail(`two ${perMint} actions for one mint`);
  }
  if (forNewSession) {
    for (const a of actions) {
      if (a.type === 'solRecurringLimit' || a.type === 'tokenRecurringLimit') {
        if (a.spent !== 0n) return fail(`${a.type} starts with an amount spent`);
        if (a.window === 0n) return fail(`${a.type} has a window of 0`);
        if (a.lastReset !== 0n) return fail(`${a.type} starts with a reset time`);
      }
    }
  }
  return { ok: true, actions };
}

/** The raw rules, one per action, for "For experts". */
export function rawRule(a: Action): string {
  const ends = a.expiresAt === 0n ? '' : ` until ${a.expiresAt}`;
  switch (a.type) {
    case 'solLimit':
      return `SolLimit ${a.remaining} lamports${ends}`;
    case 'solRecurringLimit':
      return `SolRecurringLimit ${a.limit} lamports / ${a.window} s (spent ${a.spent})${ends}`;
    case 'solMaxPerTx':
      return `SolMaxPerTx ${a.max} lamports${ends}`;
    case 'tokenLimit':
      return `TokenLimit ${a.mint} ${a.remaining}${ends}`;
    case 'tokenRecurringLimit':
      return `TokenRecurringLimit ${a.mint} ${a.limit} / ${a.window} s (spent ${a.spent})${ends}`;
    case 'tokenMaxPerTx':
      return `TokenMaxPerTx ${a.mint} ${a.max}${ends}`;
    case 'programWhitelist':
      return `ProgramWhitelist ${a.program}${ends}`;
    case 'programBlacklist':
      return `ProgramBlacklist ${a.program}${ends}`;
  }
}
