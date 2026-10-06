/**
 * What a wallet holds and who may act for it, read from the chain for
 * display: the vault's SOL and token accounts, and the wallet's authorities,
 * sessions and pending deferred executions. Each read answers in full or
 * says why it could not; nothing is filled in.
 */
import bs58 from 'bs58';
import {
  decodeAuthority,
  decodeDeferred,
  decodeSession,
  DISCRIMINATOR,
  LAZORKIT_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WALLET_OFFSET,
  type AuthorityAccount,
  type DeferredAccount,
  type ListedKind,
  type SessionAccount,
} from './layout.ts';
import { failureOf, RpcReadError, type Cluster, type Read, type Transport } from './transport.ts';

export interface TokenHolding {
  /** The token account. */
  readonly account: string;
  readonly mint: string;
  readonly program: 'token' | 'token-2022';
  /** Base units. */
  readonly amount: bigint;
  readonly decimals: number;
  readonly frozen: boolean;
  /** Who may move tokens out of this account without asking, and how many base units. */
  readonly delegate: { readonly address: string; readonly amount: bigint } | null;
}

export interface VaultHoldings {
  readonly vault: string;
  /** The oldest slot the answers were read at. */
  readonly slot: number;
  readonly lamports: bigint;
  readonly tokens: readonly TokenHolding[];
}

export interface WalletAccounts {
  readonly wallet: string;
  /** The oldest slot the answers were read at; compare session expiries with it. */
  readonly slot: number;
  readonly authorities: readonly AuthorityAccount[];
  readonly sessions: readonly SessionAccount[];
  readonly deferred: readonly DeferredAccount[];
  /** Accounts of the program naming this wallet that are not of a layout this page reads (a newer version). */
  readonly unreadable: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const malformed = (what: string) => new RpcReadError('malformed', `unexpected ${what}`);

/** `{ context: { slot }, value }` as the RPC answers with context. */
function withContext(result: unknown, what: string): { slot: number; value: unknown } {
  if (!isObj(result) || !isObj(result.context) || typeof result.context.slot !== 'number') throw malformed(what);
  return { slot: result.context.slot, value: result.value };
}

const toBigInt = (value: unknown): bigint | null => {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
};

function tokenHolding(row: unknown, owner: string, program: TokenHolding['program']): TokenHolding {
  if (!isObj(row) || typeof row.pubkey !== 'string' || !isObj(row.account) || !isObj(row.account.data)) throw malformed('token account');
  const parsed = row.account.data.parsed;
  const info = isObj(parsed) ? parsed.info : undefined;
  if (!isObj(info) || typeof info.mint !== 'string' || info.owner !== owner || !isObj(info.tokenAmount)) throw malformed('token account');
  const amount = toBigInt(info.tokenAmount.amount);
  const decimals = info.tokenAmount.decimals;
  if (amount === null || typeof decimals !== 'number') throw malformed('token amount');
  let delegate: TokenHolding['delegate'] = null;
  if (typeof info.delegate === 'string') {
    const delegated = isObj(info.delegatedAmount) ? toBigInt(info.delegatedAmount.amount) : null;
    if (delegated === null) throw malformed('delegated amount');
    delegate = { address: info.delegate, amount: delegated };
  }
  return { account: row.pubkey, mint: info.mint, program, amount, decimals, frozen: info.state === 'frozen', delegate };
}

/** The vault's SOL and its token accounts under SPL Token and Token-2022. */
export async function readVault(transport: Transport, vault: string): Promise<Read<VaultHoldings>> {
  try {
    const tokenAccounts = (programId: string) =>
      transport('getTokenAccountsByOwner', [vault, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const [balance, spl, token2022] = await Promise.all([
      transport('getBalance', [vault, { commitment: 'confirmed' }]),
      tokenAccounts(TOKEN_PROGRAM),
      tokenAccounts(TOKEN_2022_PROGRAM),
    ]);
    const lamports = withContext(balance, 'balance');
    const splRows = withContext(spl, 'token accounts');
    const token2022Rows = withContext(token2022, 'token accounts');
    const balanceValue = toBigInt(lamports.value);
    if (balanceValue === null || !Array.isArray(splRows.value) || !Array.isArray(token2022Rows.value)) throw malformed('balance');
    return {
      status: 'ok',
      value: {
        vault,
        slot: Math.min(lamports.slot, splRows.slot, token2022Rows.slot),
        lamports: balanceValue,
        tokens: [
          ...splRows.value.map((row) => tokenHolding(row, vault, 'token')),
          ...token2022Rows.value.map((row) => tokenHolding(row, vault, 'token-2022')),
        ],
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: failureOf(error) };
  }
}

const base64Bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The program's accounts of `kind` that name `wallet`: one filtered listing. */
async function listWalletAccounts(transport: Transport, program: string, wallet: string, kind: ListedKind) {
  const result = await transport('getProgramAccounts', [
    program,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      withContext: true,
      filters: [
        { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(DISCRIMINATOR[kind])) } },
        { memcmp: { offset: WALLET_OFFSET[kind], bytes: wallet } },
      ],
    },
  ]);
  const { slot, value } = withContext(result, 'program accounts');
  if (!Array.isArray(value)) throw malformed('program accounts');
  const rows = value.map((row) => {
    if (!isObj(row) || typeof row.pubkey !== 'string' || !isObj(row.account) || row.account.owner !== program) throw malformed('program account');
    const data = row.account.data;
    if (!Array.isArray(data) || typeof data[0] !== 'string' || data[1] !== 'base64') throw malformed('account data');
    return { address: row.pubkey, data: base64Bytes(data[0]) };
  });
  return { slot, rows };
}

/** The wallet's authorities, sessions and deferred executions (three filtered listings). */
export async function readWalletAccounts(transport: Transport, cluster: Cluster, wallet: string): Promise<Read<WalletAccounts>> {
  const program = LAZORKIT_PROGRAM[cluster];
  try {
    const [authorities, sessions, deferred] = await Promise.all([
      listWalletAccounts(transport, program, wallet, 'authority'),
      listWalletAccounts(transport, program, wallet, 'session'),
      listWalletAccounts(transport, program, wallet, 'deferred'),
    ]);
    let unreadable = 0;
    const decodeAll = <T extends { wallet: string }>(rows: { address: string; data: Uint8Array }[], decode: (a: string, d: Uint8Array) => T | null) =>
      rows.flatMap((row) => {
        const decoded = decode(row.address, row.data);
        if (!decoded || decoded.wallet !== wallet) {
          unreadable++;
          return [];
        }
        return [decoded];
      });
    return {
      status: 'ok',
      value: {
        wallet,
        slot: Math.min(authorities.slot, sessions.slot, deferred.slot),
        authorities: decodeAll(authorities.rows, decodeAuthority),
        sessions: decodeAll(sessions.rows, decodeSession).sort((a, b) => (a.expiresAtSlot < b.expiresAtSlot ? -1 : a.expiresAtSlot > b.expiresAtSlot ? 1 : 0)),
        deferred: decodeAll(deferred.rows, decodeDeferred),
        unreadable,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: failureOf(error) };
  }
}

