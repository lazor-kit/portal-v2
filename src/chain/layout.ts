/**
 * LazorKit v2 accounts as stored on chain (lazorkit-protocol
 * `program/src/state`): program addresses, the vault address, and decoders
 * that accept only a v2 account of the expected type and a layout revision
 * this page knows.
 */
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Cluster } from './transport.ts';

export const LAZORKIT_PROGRAM: Readonly<Record<Cluster, string>> = {
  mainnet: 'LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8',
  devnet: '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv',
};

/** First byte of each account: the protocol version (2) in the high nibble, the type in the low one. */
export const DISCRIMINATOR = { wallet: 0x21, authority: 0x22, session: 0x23, deferred: 0x24 } as const;

/** The first account layout revision (`layout_version::FIRST`): every read path accepts it. Wallets and DeferredExecs are only ever this one. */
export const ACCOUNT_VERSION = 1;
/**
 * Layout revision 2 (lazorkit-protocol #62, `layout_version::AUTHORITY` and
 * `SESSION`): an authority or a session records the account that paid its
 * rent (32 bytes) after its fixed part, so its policy or actions start 32
 * bytes later. The program refunds such an account's rent only to that payer.
 */
export const RENT_PAYER_VERSION = 2;

/** How many bytes of rent payer an authority or session of `revision` records, or null for a revision this page doesn't know. */
function rentPayerBytes(revision: number): 0 | 32 | null {
  return revision === ACCOUNT_VERSION ? 0 : revision === RENT_PAYER_VERSION ? 32 : null;
}

/** Where each listable account names its wallet. */
export const WALLET_OFFSET = { authority: 16, session: 8, deferred: 72 } as const;
export type ListedKind = keyof typeof WALLET_OFFSET;

const AUTHORITY_HEADER = 48;
const ED25519_END = 80;
const SECP256R1_END = 145;
const SESSION_HEADER = 80;
const DEFERRED_SIZE = 176;

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** The vault (`["lk2:vault", wallet]`): the system account that holds the wallet's SOL and owns its token accounts. */
export function vaultAddress(cluster: Cluster, wallet: string): string {
  const [vault] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('lk2:vault'), bs58.decode(wallet)],
    new PublicKey(LAZORKIT_PROGRAM[cluster]),
  );
  return vault.toBase58();
}

export type Role = 'owner' | 'admin' | 'spender';

export interface AuthorityAccount {
  readonly address: string;
  readonly wallet: string;
  readonly role: Role;
  /** Replay counter of a passkey; 0 for an Ed25519 key. */
  readonly counter: number;
  readonly key:
    | { readonly type: 'ed25519'; readonly publicKey: string }
    | {
        readonly type: 'passkey';
        /** SHA-256 of the credential id, hex. */
        readonly credentialIdHash: string;
        /** Compressed P-256 public key (33 bytes), hex. */
        readonly publicKey: string;
        /** SHA-256 of the relying party id, hex. */
        readonly rpIdHash: string;
      };
  /** The spending policy (an action buffer), or null when it has none. */
  readonly policy: Uint8Array | null;
  /**
   * The account that paid its rent (layout revision 2), which RemoveAuthority
   * refunds only to; null for a revision-1 authority, which records none and
   * refunds where the instruction says.
   */
  readonly rentPayer: string | null;
}

export interface SessionAccount {
  readonly address: string;
  readonly wallet: string;
  /** The ephemeral key allowed to sign. */
  readonly sessionKey: string;
  /**
   * When it stops working. On a binary with time-based expiry (lazorkit-protocol
   * #57) this is Unix seconds, and the action buffer's windows are seconds too;
   * builds before it stored a slot here. Which one a binary uses is a property
   * of the binary (config/programs.json `time-expiry`), not of the account.
   */
  readonly expiresAt: bigint;
  /** The limits (an action buffer); empty when it has none. */
  readonly actions: Uint8Array;
  /**
   * The account that paid its rent (layout revision 2), which RevokeSession
   * and CloseExpiredSession refund only to; null for a revision-1 session,
   * which records none and refunds where the instruction says.
   */
  readonly rentPayer: string | null;
}

export interface DeferredAccount {
  readonly address: string;
  readonly wallet: string;
  readonly authority: string;
  readonly payer: string;
  readonly expiresAtSlot: bigint;
  /** Hashes of what will run, hex; the content itself is not on chain. */
  readonly instructionsHash: string;
  readonly accountsHash: string;
}

const ROLES: readonly Role[] = ['owner', 'admin', 'spender'];

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const key = (data: Uint8Array, at: number) => bs58.encode(data.subarray(at, at + 32));
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

/**
 * An Authority account, or null when `data` is not a v2 Authority of layout
 * revision 1 or 2: header (48), key material (to 80 for Ed25519, to 145 for
 * a passkey), from revision 2 the rent payer (32), then the policy.
 */
export function decodeAuthority(address: string, data: Uint8Array): AuthorityAccount | null {
  if (data.length < AUTHORITY_HEADER || data[0] !== DISCRIMINATOR.authority) return null;
  const payerBytes = rentPayerBytes(data[4]);
  if (payerBytes === null) return null;
  const role = ROLES[data[2]];
  if (!role) return null;
  const dv = view(data);
  const policyLength = dv.getUint16(12, true);
  let end: number;
  let authorityKey: AuthorityAccount['key'];
  if (data[1] === 0) {
    if (data.length < ED25519_END) return null;
    end = ED25519_END;
    authorityKey = { type: 'ed25519', publicKey: key(data, AUTHORITY_HEADER) };
  } else if (data[1] === 1) {
    if (data.length < SECP256R1_END) return null;
    end = SECP256R1_END;
    authorityKey = {
      type: 'passkey',
      credentialIdHash: hex(data.subarray(48, 80)),
      publicKey: hex(data.subarray(80, 113)),
      rpIdHash: hex(data.subarray(113, 145)),
    };
  } else {
    return null;
  }
  const policyAt = end + payerBytes;
  if (data.length < policyAt + policyLength) return null;
  return {
    address,
    wallet: key(data, 16),
    role,
    counter: dv.getUint32(8, true),
    key: authorityKey,
    policy: policyLength > 0 ? data.slice(policyAt, policyAt + policyLength) : null,
    rentPayer: payerBytes ? key(data, end) : null,
  };
}

/**
 * A Session account, or null when `data` is not a v2 Session of layout
 * revision 1 or 2: header (80), from revision 2 the rent payer (80..112),
 * then the actions.
 */
export function decodeSession(address: string, data: Uint8Array): SessionAccount | null {
  if (data.length < SESSION_HEADER || data[0] !== DISCRIMINATOR.session) return null;
  const payerBytes = rentPayerBytes(data[2]);
  if (payerBytes === null || data.length < SESSION_HEADER + payerBytes) return null;
  return {
    address,
    wallet: key(data, 8),
    sessionKey: key(data, 40),
    expiresAt: view(data).getBigUint64(72, true),
    actions: data.slice(SESSION_HEADER + payerBytes),
    rentPayer: payerBytes ? key(data, SESSION_HEADER) : null,
  };
}

/** A DeferredExec account, or null when `data` is not a v2 DeferredExec of layout revision 1 (the only one it has). */
export function decodeDeferred(address: string, data: Uint8Array): DeferredAccount | null {
  if (data.length < DEFERRED_SIZE || data[0] !== DISCRIMINATOR.deferred || data[1] !== ACCOUNT_VERSION) return null;
  return {
    address,
    instructionsHash: hex(data.subarray(8, 40)),
    accountsHash: hex(data.subarray(40, 72)),
    wallet: key(data, 72),
    authority: key(data, 104),
    payer: key(data, 136),
    expiresAtSlot: view(data).getBigUint64(168, true),
  };
}

/** Base58 to 32 bytes, or null when it is not a 32-byte address. */
export function addressBytes(address: string): Uint8Array | null {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
