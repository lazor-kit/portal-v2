/**
 * What a transaction preview says it does, read from its instructions alone:
 * the fee payer, and the plain transfers (System Program SOL transfers, and
 * Token or Token-2022 Transfer and TransferChecked) with their amounts and
 * destinations. Only instructions of those programs are read as transfers;
 * compute-budget and memo instructions move nothing; every other
 * instruction is counted as one LazorKit didn't read, and a preview with one
 * never gets a payment hero.
 *
 * Until requests carry the signed preimage, a preview is the requesting
 * app's claim: the screen attributes everything read here to the app.
 */
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { paysFees, type RegisteredApp } from '../security/registry.ts';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_V1_PROGRAM = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

/** Programs whose instructions move nothing: they set the compute budget, or attach a note. */
const NEUTRAL_PROGRAMS: readonly string[] = [COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, MEMO_V1_PROGRAM];
/** Programs LazorKit reads some instructions of (the transfers). */
const READ_PROGRAMS: readonly string[] = [SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

/** Mainnet mints the screen names; every other token is "another token". */
export const KNOWN_TOKENS: Readonly<Record<string, { symbol: string; decimals: number }>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  So11111111111111111111111111111111111111112: { symbol: 'WSOL', decimals: 9 },
};

export type DecodedTransfer =
  | { readonly kind: 'sol'; readonly lamports: bigint; readonly from: string; readonly to: string }
  | {
      readonly kind: 'token';
      readonly program: string;
      readonly amount: bigint;
      /** The source token account. */
      readonly source: string;
      /** The account that signs for the source: its owner or delegate. */
      readonly authority: string;
      /** The destination token account (not its owner). */
      readonly destination: string;
      /** Named by TransferChecked; otherwise read from the source account. */
      readonly mint: string | null;
      /** Named by TransferChecked. */
      readonly decimals: number | null;
    };

export interface DecodedPreview {
  /** The first account: the fee payer. */
  readonly feePayer: string | null;
  readonly programs: readonly string[];
  readonly transfers: readonly DecodedTransfer[];
  /** How many instructions the preview has. */
  readonly instructions: number;
  /**
   * The programs of the instructions LazorKit didn't read: anything but a
   * plain transfer, a compute-budget or a memo instruction, and any
   * instruction that names an account from a lookup table.
   */
  readonly unread: readonly string[];
}

interface RawInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

function message(bytes: Uint8Array): VersionedMessage | null {
  try {
    return VersionedTransaction.deserialize(bytes).message;
  } catch {
    // Not a transaction: maybe a message on its own.
  }
  try {
    return VersionedMessage.deserialize(bytes);
  } catch {
    return null;
  }
}

/**
 * The instructions of a preview whose accounts are all in the message itself.
 * An instruction that names an account from a lookup table is listed by
 * program only (in `skipped`), and never read as a transfer.
 */
function instructionsOf(msg: VersionedMessage): { list: RawInstruction[]; programs: string[]; skipped: string[]; count: number } {
  const keys = msg.staticAccountKeys.map((k: PublicKey) => k.toBase58());
  const list: RawInstruction[] = [];
  const programs: string[] = [];
  const skipped: string[] = [];
  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId) {
      skipped.push('');
      continue;
    }
    if (!programs.includes(programId)) programs.push(programId);
    if (ix.accountKeyIndexes.some((i) => i >= keys.length)) {
      skipped.push(programId);
      continue;
    }
    list.push({ programId, accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: ix.data });
  }
  return { list, programs, skipped, count: msg.compiledInstructions.length };
}

function u64(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(offset);
}

function transferOf(ix: RawInstruction): DecodedTransfer | null {
  const { data, accounts } = ix;
  if (ix.programId === SYSTEM_PROGRAM) {
    // Transfer: u32 2, u64 lamports; accounts [from, to].
    if (data.length !== 12 || Buffer.from(data.buffer, data.byteOffset, 4).readUInt32LE(0) !== 2 || accounts.length < 2) return null;
    return { kind: 'sol', lamports: u64(data, 4), from: accounts[0], to: accounts[1] };
  }
  if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
    // Transfer: u8 3, u64 amount; accounts [source, destination, owner, …].
    if (data[0] === 3 && data.length === 9 && accounts.length >= 3) {
      return { kind: 'token', program: ix.programId, amount: u64(data, 1), source: accounts[0], authority: accounts[2], destination: accounts[1], mint: null, decimals: null };
    }
    // TransferChecked: u8 12, u64 amount, u8 decimals; accounts [source, mint, destination, owner, …].
    if (data[0] === 12 && data.length === 10 && accounts.length >= 4) {
      return { kind: 'token', program: ix.programId, amount: u64(data, 1), source: accounts[0], authority: accounts[3], destination: accounts[2], mint: accounts[1], decimals: data[9] };
    }
  }
  return null;
}

/** The preview's fee payer, programs and plain transfers; null when it is not a transaction or message. */
export function decodePreview(base64: string): DecodedPreview | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }
  const msg = message(bytes);
  if (!msg) return null;
  const { list, programs, skipped, count } = instructionsOf(msg);
  const transfers: DecodedTransfer[] = [];
  const unread = [...skipped];
  for (const ix of list) {
    const transfer = transferOf(ix);
    if (transfer) transfers.push(transfer);
    else if (!NEUTRAL_PROGRAMS.includes(ix.programId)) unread.push(ix.programId);
  }
  return { feePayer: msg.staticAccountKeys[0]?.toBase58() ?? null, programs, transfers, instructions: count, unread };
}

/**
 * What the preview does that LazorKit didn't read: `service` when an
 * instruction belongs to a program it can't read at all, `step` when only
 * instructions of the System or Token programs went unread (an approval or
 * a closed account, say), null when it read everything.
 */
export function unreadKind(decoded: DecodedPreview): 'service' | 'step' | null {
  if (!decoded.unread.length) return null;
  return decoded.unread.some((program) => !READ_PROGRAMS.includes(program)) ? 'service' : 'step';
}

/** `amount` in units of 10^-decimals, without trailing zeros: 1500000, 6 → "1.5". */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toLocaleString('en-US');
  const fraction = decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** What the chain says about the token accounts and mints a preview names (read during the simulation). */
export interface TokenFacts {
  /** Token account → its mint and owner. */
  readonly accounts: Readonly<Record<string, { readonly mint: string; readonly owner: string }>>;
  /** Mint → decimals. */
  readonly decimals: Readonly<Record<string, number>>;
}

export interface Payment {
  /** "0.25", or null when the token's decimals are not known. */
  readonly amount: string | null;
  /** "SOL", "USDC", or null for a token LazorKit doesn't name. */
  readonly symbol: string | null;
  /** The mint, for a token. */
  readonly mint: string | null;
  /** Who receives it: the destination's owner for a token, when known; otherwise the account itself. */
  readonly to: string;
  /** `to` is the owner of the token account that receives it. */
  readonly toIsOwner: boolean;
}

export interface PreviewSummary {
  /**
   * The one payment the preview makes: only when it is the one plain
   * transfer besides fees, every other instruction is a compute-budget or
   * memo instruction, and the fee payer isn't the one paying.
   */
  readonly payment: Payment | null;
  /** Payments to the fee payer: a fee the user pays. */
  readonly fees: readonly Payment[];
  /** Plain transfers that are not fees. */
  readonly transfers: number;
}

function paymentOf(t: DecodedTransfer, facts: TokenFacts | null): Payment {
  if (t.kind === 'sol') return { amount: formatUnits(t.lamports, 9), symbol: 'SOL', mint: null, to: t.to, toIsOwner: false };
  const destination = facts?.accounts[t.destination];
  const mint = t.mint ?? facts?.accounts[t.source]?.mint ?? destination?.mint ?? null;
  const known = mint ? KNOWN_TOKENS[mint] : undefined;
  const decimals = t.decimals ?? (mint ? facts?.decimals[mint] : undefined) ?? known?.decimals ?? null;
  return {
    amount: decimals === null ? null : formatUnits(t.amount, decimals),
    symbol: known?.symbol ?? null,
    mint,
    to: destination?.owner ?? t.destination,
    toIsOwner: destination !== undefined,
  };
}

/** The payment and fees a decoded preview makes, with token owners and decimals where the chain gave them. */
export function summarizePreview(decoded: DecodedPreview, facts: TokenFacts | null): PreviewSummary {
  const { feePayer } = decoded;
  const payments = decoded.transfers.map((t) => ({ t, p: paymentOf(t, facts) }));
  const isFee = (p: Payment) => feePayer !== null && p.to === feePayer && (p.toIsOwner || p.symbol === 'SOL');
  // The fee payer is the app's key, not the user's: what it sends isn't the user's payment.
  const fromFeePayer = (t: DecodedTransfer) => feePayer !== null && (t.kind === 'sol' ? t.from : t.authority) === feePayer;
  const fees = payments.filter(({ p }) => isFee(p)).map(({ p }) => p);
  const others = payments.filter(({ p }) => !isFee(p));
  const only = others.length === 1 && decoded.unread.length === 0 && !fromFeePayer(others[0].t) ? others[0].p : null;
  return { payment: only, fees, transfers: others.length };
}

/** What is paid, in words: "0.25 SOL", "5 of another token", "another token". */
export function paymentWhat(p: Payment): string {
  if (p.amount !== null) return p.symbol ? `${p.amount} ${p.symbol}` : `${p.amount} of another token`;
  return p.symbol ?? 'another token';
}

/** The hero for a payment: "Send 0.25 SOL". */
export function paymentHero(p: Payment): string {
  return `Send ${paymentWhat(p)}`;
}

export type FeeLine =
  /** A cost the user pays: shown on the first view. */
  | { readonly where: 'first-view'; readonly text: string }
  /** The user doesn't pay: shown in Details. */
  | { readonly where: 'details'; readonly text: string };

/**
 * The fee as the screen states it. A payment to the fee payer is a fee the
 * user pays. Otherwise the fee payer pays: "Paid by <app>" only when that key
 * is registered to the requesting app alone (a shared paymaster serves many
 * apps, so it names none), and "You don't pay it" for any other.
 */
export function feeLine(input: { feePayer: string | null; fees: readonly Payment[]; app: RegisteredApp | undefined }): FeeLine | null {
  const { feePayer, fees, app } = input;
  if (fees.length) {
    const to = paysFees(app, feePayer) && app ? ` to ${app.name}` : '';
    return { where: 'first-view', text: `You pay ${fees.map(paymentWhat).join(' and ')}${to}` };
  }
  if (!feePayer) return null;
  if (paysFees(app, feePayer) && app) return { where: 'details', text: `Paid by ${app.name}` };
  return { where: 'details', text: "You don't pay it" };
}
