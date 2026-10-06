/**
 * Payments out of a vault, read from its confirmed transaction history.
 *
 * A payment counts only when it left the vault, in a transaction that
 * succeeded, for more than zero: a SOL transfer from the vault, or a token
 * transfer the vault signed out of a token account it owns. Money coming in never
 * counts (address poisoning works by sending it), and neither do failed or
 * zero-value transfers.
 *
 * The other addresses the vault dealt with are kept apart, as
 * counterparties: senders of SOL or tokens into it, and recipients of
 * zero-value transfers or of transfers it did not sign. They are never
 * "paid", but a recipient that looks like one of them is worth a warning.
 * Tokens sent to one of the vault's token accounts show up only when the
 * transaction lists the vault itself.
 *
 * The history is read newest first and may stop short: `scanned` says how
 * many of the newest transactions were read without a gap, and `coverage`
 * whether that was all of them.
 */
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './layout.ts';
import { failureOf, RpcReadError, type Read, type ReadFailure, type Transport } from './transport.ts';

export interface OutgoingTransfer {
  readonly signature: string;
  readonly slot: number;
  /** Unix seconds, when the RPC knows it. */
  readonly blockTime: number | null;
  /** Who was paid: the destination of SOL, the owner of the token account that received tokens. */
  readonly to: string;
  readonly asset: { readonly kind: 'sol' } | { readonly kind: 'token'; readonly mint: string | null; readonly tokenAccount: string };
  /** Lamports or token base units; always more than zero. */
  readonly amount: bigint;
}

export interface PaymentHistory {
  readonly vault: string;
  /** `complete`: every transaction of the vault was read; `recent`: only the newest `scanned`. */
  readonly coverage: 'complete' | 'recent';
  /** How many of the vault's newest transactions were read, without a gap. */
  readonly scanned: number;
  /**
   * Payments out of the vault, newest first: those in the `scanned` window,
   * plus any found beyond a gap (still facts, but the window is what was
   * checked).
   */
  readonly transfers: readonly OutgoingTransfer[];
  /** Token payments out of the vault whose recipient could not be named (the receiving account's owner is not in the transaction). */
  readonly unattributed: number;
  /**
   * Addresses the vault dealt with without paying them, newest first, each
   * once: senders of money into it, recipients of zero-value transfers or of
   * transfers it did not sign. An address may also be among those paid.
   */
  readonly counterparties: readonly string[];
}

/** What one transaction says about the vault. */
export interface VaultTransfers {
  readonly transfers: OutgoingTransfer[];
  readonly unattributed: number;
  readonly counterparties: string[];
}

export interface HistoryOptions {
  /** Signatures to list, newest first (one call; at most 1000). */
  readonly maxSignatures?: number;
  /** Successful transactions to read (one call each). */
  readonly maxTransactions?: number;
  /** Transactions read at once. */
  readonly concurrency?: number;
}

export const HISTORY_DEFAULTS = { maxSignatures: 1000, maxTransactions: 100, concurrency: 4 } as const;

// ─── One transaction ────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const TOKEN_TRANSFERS = new Set(['transfer', 'transferChecked', 'transferCheckedWithFee']);

function positiveAmount(value: unknown): bigint | null {
  let amount: bigint | null = null;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) amount = BigInt(value);
  else if (typeof value === 'number' && Number.isInteger(value)) amount = BigInt(value);
  return amount !== null && amount > 0n ? amount : null;
}

/** Owner and mint of each token account the transaction's balances list, by address. */
function tokenAccountsOf(tx: Obj): Map<string, { owner: string | null; mint: string | null }> {
  const accounts = new Map<string, { owner: string | null; mint: string | null }>();
  const message = isObj(tx.transaction) && isObj(tx.transaction.message) ? tx.transaction.message : null;
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const keyAt = (index: unknown) => {
    const entry = typeof index === 'number' ? keys[index] : undefined;
    return typeof entry === 'string' ? entry : isObj(entry) && typeof entry.pubkey === 'string' ? entry.pubkey : null;
  };
  const meta = isObj(tx.meta) ? tx.meta : null;
  for (const list of [meta?.preTokenBalances, meta?.postTokenBalances]) {
    if (!Array.isArray(list)) continue;
    for (const balance of list) {
      if (!isObj(balance)) continue;
      const address = keyAt(balance.accountIndex);
      if (!address) continue;
      const known = accounts.get(address);
      accounts.set(address, {
        owner: typeof balance.owner === 'string' ? balance.owner : (known?.owner ?? null),
        mint: typeof balance.mint === 'string' ? balance.mint : (known?.mint ?? null),
      });
    }
  }
  return accounts;
}

/** Every instruction, top-level and inner, as the RPC parsed it. */
function instructionsOf(tx: Obj): Obj[] {
  const message = isObj(tx.transaction) && isObj(tx.transaction.message) ? tx.transaction.message : null;
  const top = Array.isArray(message?.instructions) ? message.instructions : [];
  const meta = isObj(tx.meta) ? tx.meta : null;
  const inner = Array.isArray(meta?.innerInstructions)
    ? meta.innerInstructions.flatMap((group) => (isObj(group) && Array.isArray(group.instructions) ? group.instructions : []))
    : [];
  return [...top, ...inner].filter(isObj);
}

/**
 * What one transaction (`jsonParsed`) says about `vault`: its payments out,
 * the token payments out whose recipient is unknown (`unattributed`), and
 * its counterparties. Nothing when the transaction failed.
 */
export function vaultTransfers(vault: string, signature: string, tx: unknown): VaultTransfers {
  if (!isObj(tx) || !isObj(tx.meta) || tx.meta.err !== null || typeof tx.slot !== 'number') return { transfers: [], unattributed: 0, counterparties: [] };
  const blockTime = typeof tx.blockTime === 'number' ? tx.blockTime : null;
  const tokenAccounts = tokenAccountsOf(tx);
  const transfers: OutgoingTransfer[] = [];
  let unattributed = 0;
  const counterparties = new Set<string>();
  const note = (address: unknown) => {
    if (typeof address === 'string' && address !== vault) counterparties.add(address);
  };
  for (const instruction of instructionsOf(tx)) {
    const parsed = instruction.parsed;
    if (!isObj(parsed) || !isObj(parsed.info) || typeof parsed.type !== 'string') continue;
    const info = parsed.info;
    if (instruction.programId === SYSTEM_PROGRAM && parsed.type === 'transfer') {
      if (info.source === vault) {
        if (typeof info.destination !== 'string' || info.destination === vault) continue;
        const amount = positiveAmount(info.lamports);
        if (amount === null) note(info.destination);
        else transfers.push({ signature, slot: tx.slot, blockTime, to: info.destination, asset: { kind: 'sol' }, amount });
      } else if (info.destination === vault) {
        note(info.source);
      }
      continue;
    }
    if (TOKEN_PROGRAMS.has(instruction.programId as string) && TOKEN_TRANSFERS.has(parsed.type)) {
      if (typeof info.source !== 'string' || typeof info.destination !== 'string') continue;
      const sourceOwner = tokenAccounts.get(info.source)?.owner ?? null;
      const destination = tokenAccounts.get(info.destination);
      const destinationOwner = destination?.owner ?? null;
      // A payment by this account is one it signed: tokens moved out of its
      // token account by another authority (a delegate, or a mint's permanent
      // delegate) were not paid by it.
      const signedByVault = info.authority === vault || info.multisigAuthority === vault;
      const fromVaultAccount = sourceOwner === vault || (sourceOwner === null && signedByVault);
      if (!fromVaultAccount) {
        if (destinationOwner === vault) note(sourceOwner ?? info.authority ?? info.multisigAuthority);
        continue;
      }
      if (destinationOwner === vault) continue;
      const amount = positiveAmount(parsed.type === 'transfer' ? info.amount : isObj(info.tokenAmount) ? info.tokenAmount.amount : undefined);
      if (!signedByVault || amount === null) {
        note(destinationOwner);
        continue;
      }
      if (destinationOwner === null) {
        unattributed++;
        continue;
      }
      const mint = typeof info.mint === 'string' ? info.mint : (destination?.mint ?? tokenAccounts.get(info.source)?.mint ?? null);
      transfers.push({ signature, slot: tx.slot, blockTime, to: destinationOwner, asset: { kind: 'token', mint, tokenAccount: info.destination }, amount });
    }
  }
  return { transfers, unattributed, counterparties: [...counterparties] };
}

// ─── The history ────────────────────────────────────────────────────────────

interface SignatureEntry {
  readonly signature: string;
  readonly failed: boolean;
  readonly finalized: boolean;
}

function signatureEntries(result: unknown): SignatureEntry[] {
  if (!Array.isArray(result)) throw new RpcReadError('malformed', 'unexpected signature list');
  return result.map((row) => {
    if (!isObj(row) || typeof row.signature !== 'string' || !('err' in row)) throw new RpcReadError('malformed', 'unexpected signature');
    return { signature: row.signature, failed: row.err !== null, finalized: row.confirmationStatus === 'finalized' };
  });
}

/** The upstream refuses a transaction newer than the version asked for (-32015), or a version it does not know (-32602). */
const VERSION_TOO_LOW = -32015;
const INVALID_PARAMS = -32602;
const STOP_ON: ReadonlySet<ReadFailure> = new Set(['rate-limited', 'network', 'not-configured', 'refused']);

type Slot = ({ kind: 'read' } & VaultTransfers) | { kind: 'failed-transaction' } | { kind: 'unread' };

/**
 * The vault's payments out, from its newest `maxSignatures` transactions, of
 * which at most `maxTransactions` successful ones are read. Unavailable when
 * not even the newest transaction could be read.
 */
export async function readPaymentHistory(transport: Transport, vault: string, options: HistoryOptions = {}): Promise<Read<PaymentHistory>> {
  const maxSignatures = Math.min(Math.max(1, options.maxSignatures ?? HISTORY_DEFAULTS.maxSignatures), 1000);
  const maxTransactions = Math.max(1, options.maxTransactions ?? HISTORY_DEFAULTS.maxTransactions);
  const concurrency = Math.max(1, options.concurrency ?? HISTORY_DEFAULTS.concurrency);

  let entries: SignatureEntry[];
  try {
    entries = signatureEntries(await transport('getSignaturesForAddress', [vault, { commitment: 'confirmed', limit: maxSignatures }]));
  } catch (error) {
    return { status: 'unavailable', reason: failureOf(error) };
  }

  const slots: Slot[] = entries.map((entry) => (entry.failed ? { kind: 'failed-transaction' } : { kind: 'unread' }));
  const toRead = entries.flatMap((entry, index) => (entry.failed ? [] : [index])).slice(0, maxTransactions);

  // Start with version 0, which every RPC knows; move to 1 once a transaction needs it.
  let version = 0;
  const fetchOne = async (entry: SignatureEntry, commitment: 'confirmed' | 'finalized'): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const asked = version;
      try {
        return await transport('getTransaction', [entry.signature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: asked }]);
      } catch (error) {
        const code = error instanceof RpcReadError ? error.code : null;
        if (attempt > 0) throw error;
        if (asked === 0 && code === VERSION_TOO_LOW) version = 1;
        else if (asked === 1 && code === INVALID_PARAMS) version = 0;
        else throw error;
      }
    }
  };

  let firstFailure: ReadFailure | null = null;
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < toRead.length) {
      const index = toRead[next++];
      const entry = entries[index];
      try {
        let tx = await fetchOne(entry, entry.finalized ? 'finalized' : 'confirmed');
        // A node behind the one that listed it may not have it yet.
        if (tx === null) tx = await fetchOne(entry, 'confirmed');
        if (tx === null) throw new RpcReadError('upstream', 'transaction not found');
        if (!isObj(tx) || !isObj(tx.meta)) throw new RpcReadError('malformed', 'unexpected transaction');
        slots[index] = { kind: 'read', ...vaultTransfers(vault, entry.signature, tx) };
      } catch (error) {
        const reason = failureOf(error);
        firstFailure ??= reason;
        if (STOP_ON.has(reason)) stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toRead.length) }, worker));

  const gap = slots.findIndex((slot) => slot.kind === 'unread');
  const scanned = gap === -1 ? slots.length : gap;
  if (scanned === 0 && entries.length > 0) return { status: 'unavailable', reason: firstFailure ?? 'rate-limited' };
  const read = slots.filter((slot): slot is Extract<Slot, { kind: 'read' }> => slot.kind === 'read');
  return {
    status: 'ok',
    value: {
      vault,
      coverage: scanned === entries.length && entries.length < maxSignatures ? 'complete' : 'recent',
      scanned,
      transfers: read.flatMap((slot) => slot.transfers),
      unattributed: read.reduce((sum, slot) => sum + slot.unattributed, 0),
      counterparties: [...new Set(read.flatMap((slot) => slot.counterparties))],
    },
  };
}
