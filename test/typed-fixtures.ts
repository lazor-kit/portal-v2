// A stubbed chain for typed requests: accounts laid out as lazorkit-protocol
// stores them, served through the same Transport shape as /api/rpc.
import { createHash, randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { base64urlEncode, decodeApprovalRequest, findProgramAddress, passkeyAuthorityAddress, preparedChallenge, type ApprovalRequest } from '../src/approval/index.ts';
import type { Transport } from '../src/chain/transport.ts';
import { RpcReadError } from '../src/chain/transport.ts';
import { CLOCK_SYSVAR, UPGRADEABLE_LOADER } from '../src/typed/reads.ts';
import type { ProgramConfig } from '../src/typed/programs.ts';

export const PROGRAM = '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** 2026-10-10 15:50:00 UTC: "6:50 PM" is three hours on. */
export const NOW = BigInt(Date.UTC(2026, 9, 10, 15, 50) / 1000);
export const SLOT = 412_388_000n;
export const DEPLOY_SLOT = 509_521_792;

/** Little-endian u64s, back to back. */
export const u64 = (...values: bigint[]) => {
  const out = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => out.writeBigUInt64LE(v, i * 8));
  return out;
};

export const addr = () => Keypair.generate().publicKey.toBase58();
const key = (a: string) => new PublicKey(a).toBuffer();

export interface Raw {
  owner: string;
  lamports: number;
  data: Uint8Array;
}

export const CONFIG: ProgramConfig = { programId: PROGRAM, lastDeploySlot: DEPLOY_SLOT, features: ['wallet-bound-challenge', 'd13', 'nonowner-invariants', 'time-expiry'] };

export function walletData(ownerCount = 1): Uint8Array {
  const d = Buffer.alloc(8);
  d[0] = 0x21;
  d[2] = 1;
  d.writeUInt32LE(ownerCount, 4);
  return d;
}

export function passkeyAuthority(o: { wallet: string; credentialId: Uint8Array; role?: 0 | 1 | 2; counter?: number; policy?: Uint8Array; rpId?: string }): Uint8Array {
  const policy = o.policy ?? new Uint8Array(0);
  const d = Buffer.alloc(145 + policy.length);
  d[0] = 0x22;
  d[1] = 1;
  d[2] = o.role ?? 0;
  d[4] = 1;
  d.writeUInt32LE(o.counter ?? 6, 8);
  d.writeUInt16LE(policy.length, 12);
  key(o.wallet).copy(d, 16);
  createHash('sha256').update(o.credentialId).digest().copy(d, 48);
  d[80] = 2;
  createHash('sha256').update(o.rpId ?? 'portal.lazor.sh').digest().copy(d, 113);
  Buffer.from(policy).copy(d, 145);
  return d;
}

export function ed25519Authority(o: { wallet: string; publicKey: string; role?: 0 | 1 | 2; policy?: Uint8Array }): Uint8Array {
  const policy = o.policy ?? new Uint8Array(0);
  const d = Buffer.alloc(80 + policy.length);
  d[0] = 0x22;
  d[1] = 0;
  d[2] = o.role ?? 2;
  d[4] = 1;
  d.writeUInt16LE(policy.length, 12);
  key(o.wallet).copy(d, 16);
  key(o.publicKey).copy(d, 48);
  Buffer.from(policy).copy(d, 80);
  return d;
}

export function sessionData(o: { wallet: string; sessionKey: string; expiresAt: bigint; actions?: Uint8Array }): Uint8Array {
  const actions = o.actions ?? new Uint8Array(0);
  const d = Buffer.alloc(80 + actions.length);
  d[0] = 0x23;
  d[2] = 1;
  key(o.wallet).copy(d, 8);
  key(o.sessionKey).copy(d, 40);
  u64(o.expiresAt).copy(d, 72);
  Buffer.from(actions).copy(d, 80);
  return d;
}

export function clockData(slot = SLOT, unix = NOW): Uint8Array {
  const d = Buffer.alloc(40);
  u64(slot).copy(d, 0);
  u64(unix).copy(d, 32);
  return d;
}

export function mintData(decimals: number): Uint8Array {
  const d = Buffer.alloc(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
}

/** A chain of `accounts`, plus the program and its program data at `deploySlot`. */
export class FakeChain {
  readonly accounts = new Map<string, Raw>();
  readonly calls: { method: string; params: readonly unknown[] }[] = [];
  /** Throw this for every call (a network that can't be read). */
  failWith: Error | null = null;
  lamports = 1_250_000_000n;
  /** getBalance fails (the vault's holdings can't be read). */
  failBalance = false;
  tokens: { mint: string; amount: bigint; decimals: number }[] = [];

  constructor(deploySlot = DEPLOY_SLOT) {
    const [programData] = findProgramAddress([new PublicKey(PROGRAM).toBytes()], UPGRADEABLE_LOADER);
    this.accounts.set(PROGRAM, { owner: UPGRADEABLE_LOADER, lamports: 1, data: Buffer.concat([Buffer.from([2, 0, 0, 0]), key(programData)]) });
    this.accounts.set(programData, { owner: UPGRADEABLE_LOADER, lamports: 1, data: Buffer.concat([Buffer.from([3, 0, 0, 0]), u64(BigInt(deploySlot)), Buffer.from([1]), Buffer.alloc(40)]) });
    this.accounts.set(CLOCK_SYSVAR, { owner: 'Sysvar1111111111111111111111111111111111111', lamports: 1, data: clockData() });
  }

  set(address: string, owner: string, data: Uint8Array): this {
    this.accounts.set(address, { owner, lamports: 1_000_000, data });
    return this;
  }

  setClock(slot: bigint, unix: bigint): void {
    this.set(CLOCK_SYSVAR, 'Sysvar1111111111111111111111111111111111111', clockData(slot, unix));
  }

  transport: Transport = async (method, params) => {
    this.calls.push({ method, params });
    if (this.failWith) throw this.failWith;
    const context = { slot: Number(SLOT) };
    if (method === 'getMultipleAccounts') {
      const [keys, config] = params as [string[], { dataSlice?: { offset: number; length: number } }];
      return {
        context,
        value: keys.map((k) => {
          const a = this.accounts.get(k);
          if (!a) return null;
          const data = config.dataSlice ? a.data.slice(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length) : a.data;
          return { owner: a.owner, lamports: a.lamports, executable: false, rentEpoch: 0, data: [Buffer.from(data).toString('base64'), 'base64'] };
        }),
      };
    }
    if (method === 'getBalance') {
      if (this.failBalance) throw new RpcReadError('upstream', 'getBalance failed');
      return { context, value: Number(this.lamports) };
    }
    if (method === 'getTokenAccountsByOwner') {
      const [owner, filter] = params as [string, { programId: string }];
      const rows = filter.programId === TOKEN ? this.tokens : [];
      return {
        context,
        value: rows.map((t) => ({
          pubkey: addr(),
          account: { data: { parsed: { info: { mint: t.mint, owner, tokenAmount: { amount: t.amount.toString(), decimals: t.decimals }, state: 'initialized' } } } },
        })),
      };
    }
    throw new RpcReadError('refused', `${method} not stubbed`);
  };
}

export interface World {
  chain: FakeChain;
  json: Record<string, unknown>;
  req: ApprovalRequest;
  credentialId: Uint8Array;
  wallet: string;
  authority: string;
  payer: string;
  /** The query 3.4.1 sends with it. */
  query: { action: 'sign'; message: string; credentialId: string; transaction: string; displayMessage: null };
}

/** A wallet with one passkey (counter 6) and the request `args` of `kind`, consistent with it. */
export function world(kind: ApprovalRequest['kind'], args: Record<string, string>, o: { counter?: number; role?: 0 | 1 | 2; policy?: Uint8Array; ownerCount?: number } = {}): World {
  const chain = new FakeChain();
  const credentialId = randomBytes(24);
  const wallet = addr();
  const payer = addr();
  const authority = passkeyAuthorityAddress(PROGRAM, wallet, credentialId);
  chain.set(wallet, PROGRAM, walletData(o.ownerCount ?? 1));
  chain.set(authority, PROGRAM, passkeyAuthority({ wallet, credentialId, role: o.role, counter: o.counter ?? 6, policy: o.policy }));
  const json = {
    v: 1,
    kind,
    cluster: 'devnet',
    programId: PROGRAM,
    wallet,
    authority,
    credentialId: base64urlEncode(credentialId),
    payer,
    counter: (o.counter ?? 6) + 1,
    preparedSlot: (SLOT - 5n).toString(),
    args,
  };
  const decoded = decodeApprovalRequest(base64urlEncode(new TextEncoder().encode(JSON.stringify(json))));
  if (!decoded.ok) throw new Error(`fixture: ${decoded.reason}`);
  const req = decoded.request;
  const query = {
    action: 'sign' as const,
    message: Buffer.from(preparedChallenge(req)).toString('base64'),
    credentialId: Buffer.from(credentialId).toString('base64'),
    transaction: '',
    displayMessage: null,
  };
  return { chain, json, req, credentialId, wallet, authority, payer, query };
}

export const fragmentOf = (json: unknown) => `#/?lk1=${base64urlEncode(new TextEncoder().encode(JSON.stringify(json)))}`;

// ─── Action buffers ─────────────────────────────────────────────────────────

/** An action, as the program lays it out: type, data_len, expires_at, data. */
export function action(type: number, data: Uint8Array, expiresAt = 0n): Uint8Array {
  const out = new Uint8Array(11 + data.length);
  out[0] = type;
  out[1] = data.length & 0xff;
  out[2] = data.length >> 8;
  new DataView(out.buffer).setBigUint64(3, expiresAt, true);
  out.set(data, 11);
  return out;
}

export const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
export const mintBytes = () => Keypair.generate().publicKey.toBytes();

export const sample = {
  solLimit: (n: bigint, exp = 0n) => action(1, u64(n), exp),
  solRecurring: (limit: bigint, window: bigint, exp = 0n) => action(2, u64(limit, 0n, window, 0n), exp),
  solMax: (n: bigint, exp = 0n) => action(3, u64(n), exp),
  tokenLimit: (mint: Uint8Array, n: bigint, exp = 0n) => action(4, cat(mint, u64(n)), exp),
  tokenRecurring: (mint: Uint8Array, limit: bigint, window: bigint, exp = 0n) => action(5, cat(mint, u64(limit, 0n, window, 0n)), exp),
  tokenMax: (mint: Uint8Array, n: bigint, exp = 0n) => action(6, cat(mint, u64(n)), exp),
  whitelist: (program: Uint8Array) => action(10, program),
  blacklist: (program: Uint8Array) => action(11, program),
};

