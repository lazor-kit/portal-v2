/**
 * What a typed request needs from the chain before it is shown (DESIGN §3.2
 * step 4), through the portal's read-only `/api/rpc`:
 *
 *   - once per page, the binary: the program account and the first bytes of
 *     its program data, whose last-deploy slot must be the configured one;
 *   - one `getMultipleAccounts` at `confirmed`: the wallet, the signing
 *     authority, the Clock sysvar, and per kind the would-be session (create),
 *     the session (revoke) or the target authority (remove), and every mint
 *     the actions name;
 *   - the vault's holdings, only when a "could spend all X" line needs them.
 *
 * The same call, reduced to the authority and the Clock, is the snapshot the
 * Approve click signs from (`readSnapshot`).
 *
 * Every one of these reads is asked of a node at or past a floor slot
 * (`minContextSlot`): the request's `preparedSlot` and `minContextSlot`, and
 * the newest slot the page has already seen. The Clock read in the same call
 * must agree: at or past the floor, and within `MAX_CLOCK_SKEW_SLOTS` of the
 * slot the answer claims. An RPC behind a load balancer can hand back a
 * lagging node's state under a current context slot; such an answer is
 * `behind`, read again after a pause, and after `READ_RETRY_DELAYS_MS` the
 * request is refused as `chain-unavailable` (Try again). Only fresh answers
 * decide anything, and a `request-invalid` needs two fresh answers in a row,
 * the second at or past the first: an account the app has just created may
 * not have reached the first node asked.
 */
import { sha256 } from '@noble/hashes/sha256';
import { decodeActions, type Action } from '../approval/actions.ts';
import { addressBytes, bytesEqual, readU32, readU64 } from '../approval/bytes.ts';
import type { ApprovalRequest } from '../approval/envelope.ts';
import { findProgramAddress, passkeyAuthorityAddress, sessionAddress, vaultAddressOf } from '../approval/pda.ts';
import { decodeAuthority, decodeSession, DISCRIMINATOR, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type AuthorityAccount, type SessionAccount } from '../chain/layout.ts';
import { readVault, type VaultHoldings } from '../chain/reads.ts';
import { RpcReadError, type Transport } from '../chain/transport.ts';
import { REQUIRED_FEATURES, type Feature, type ProgramConfig } from './programs.ts';
import { knownToken } from './tokens.ts';

export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Base64 account data as the RPC answers it. */
interface RawAccount {
  readonly owner: string;
  readonly lamports: number;
  readonly data: Uint8Array;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const base64Bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const malformed = (what: string) => new RpcReadError('malformed', `unexpected ${what}`);

/** `getMultipleAccounts` (base64, confirmed): one entry per key, null where no account is. */
async function multipleAccounts(transport: Transport, keys: readonly string[], config: Obj): Promise<{ slot: number; accounts: (RawAccount | null)[] }> {
  const result = await transport('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed', ...config }]);
  if (!isObj(result) || !isObj(result.context) || typeof result.context.slot !== 'number' || !Array.isArray(result.value) || result.value.length !== keys.length) {
    throw malformed('accounts');
  }
  const accounts = result.value.map((row) => {
    if (row === null) return null;
    if (!isObj(row) || typeof row.owner !== 'string' || typeof row.lamports !== 'number' || !Array.isArray(row.data) || typeof row.data[0] !== 'string' || row.data[1] !== 'base64') {
      throw malformed('account');
    }
    return { owner: row.owner, lamports: row.lamports, data: base64Bytes(row.data[0]) };
  });
  return { slot: result.context.slot, accounts };
}

/** The owner of every sysvar account, the Clock included. */
export const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';

/**
 * How far the Clock in an answer may be from the slot the answer claims. At
 * one commitment the two are the same bank's, so equal; a node that serves
 * state from far behind the context it reports is not answering for now.
 */
export const MAX_CLOCK_SKEW_SLOTS = 32n;

/** The pauses between reads while answers are behind (about 9 s in all), and before the read that confirms a refusal. */
export const READ_RETRY_DELAYS_MS: readonly number[] = [400, 800, 1600, 3200, 3200];

const behind = (error: unknown) => error instanceof RpcReadError && error.reason === 'behind';

/**
 * The slot a typed request's reads must be at or past: the newest of its
 * `minContextSlot`, its `preparedSlot` (the SDK read the chain there, so
 * every account it prepared from exists there) and `observed`, the newest
 * slot this page has already seen. 0 means no floor.
 */
export function readFloor(req: ApprovalRequest, observed = 0): number {
  const prepared = req.preparedSlot <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(req.preparedSlot) : 0;
  return Math.max(req.minContextSlot ?? 0, prepared, observed);
}

/**
 * `keys` and the Clock in one `getMultipleAccounts`, asked of a node at or
 * past `floor`. Throws `behind` when the node had not reached it, or when the
 * answer's own Clock is before `floor` or more than `MAX_CLOCK_SKEW_SLOTS`
 * from the slot the answer claims.
 */
async function freshAccounts(transport: Transport, keys: readonly string[], floor: number, config: Obj = {}): Promise<{ clock: Clock; accounts: (RawAccount | null)[] }> {
  const { slot, accounts } = await multipleAccounts(transport, [...keys, CLOCK_SYSVAR], floor > 0 ? { ...config, minContextSlot: floor } : config);
  const clockAcc = accounts[keys.length];
  const clock = clockAcc && clockAcc.owner === SYSVAR_OWNER ? decodeClock(clockAcc.data) : null;
  if (!clock) throw malformed('clock');
  const skew = BigInt(slot) - clock.slot;
  if (clock.slot < BigInt(floor) || skew > MAX_CLOCK_SKEW_SLOTS || skew < -MAX_CLOCK_SKEW_SLOTS) {
    throw new RpcReadError('behind', `the answer's Clock is at slot ${clock.slot}, its context at ${slot}, the floor at ${floor}`);
  }
  return { clock, accounts: accounts.slice(0, keys.length) };
}

/** `read`, again after each of `delays` while it throws `behind`; any other failure, or the last `behind`, is thrown. */
async function untilFresh<T>(read: () => Promise<T>, delays: readonly number[], sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!behind(error) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Clock {
  readonly slot: bigint;
  /** Unix seconds, the cluster's. */
  readonly unixTimestamp: bigint;
}

export function decodeClock(data: Uint8Array): Clock | null {
  if (data.length < 40) return null;
  const ts = readU64(data, 32);
  return { slot: readU64(data, 0), unixTimestamp: ts >= 1n << 63n ? ts - (1n << 64n) : ts };
}

/** What a mint read says: a token mint and its decimals, or not one. */
export type MintRead = { readonly kind: 'mint'; readonly decimals: number; readonly program: 'token' | 'token-2022' } | { readonly kind: 'not-a-mint' };

export function decodeMint(account: RawAccount | null): MintRead {
  if (!account) return { kind: 'not-a-mint' };
  const program = account.owner === TOKEN_PROGRAM ? 'token' : account.owner === TOKEN_2022_PROGRAM ? 'token-2022' : null;
  if (!program || account.data.length < 82 || account.data[45] !== 1) return { kind: 'not-a-mint' };
  // Token-2022 marks an extended mint at byte 165 (1 = Mint); a token account is never one.
  if (account.data.length > 82 && (program === 'token' || account.data.length < 166 || account.data[165] !== 1)) return { kind: 'not-a-mint' };
  return { kind: 'mint', decimals: account.data[44], program };
}

export interface DeployReadOptions {
  /** The slot the read must be at or past (`readFloor`). */
  readonly minContextSlot?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The binary on the cluster: its last-deploy slot, or null when the program
 * is not an upgradeable program. Read fresh (see `freshAccounts`); a read
 * that stays behind, or fails, throws: an old answer must not pass for
 * another binary.
 */
export async function readDeploySlot(transport: Transport, programId: string, options: DeployReadOptions = {}): Promise<number | null> {
  const [programData] = findProgramAddress([addressOf(programId)], UPGRADEABLE_LOADER);
  const read = () => freshAccounts(transport, [programId, programData], options.minContextSlot ?? 0, { dataSlice: { offset: 0, length: 45 } });
  const { accounts } = await untilFresh(read, options.retryDelaysMs ?? READ_RETRY_DELAYS_MS, options.sleep ?? defaultSleep);
  const [program, data] = accounts;
  if (!program || !data || program.owner !== UPGRADEABLE_LOADER || data.owner !== UPGRADEABLE_LOADER) return null;
  if (program.data.length < 36 || readU32(program.data, 0) !== 2 || !bytesEqual(program.data.subarray(4, 36), addressOf(programData))) return null;
  if (data.data.length < 12 || readU32(data.data, 0) !== 3) return null;
  const slot = readU64(data.data, 4);
  return slot > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(slot);
}

function addressOf(address: string): Uint8Array {
  const bytes = addressBytes(address);
  if (!bytes) throw new Error(`not an address: ${address}`);
  return bytes;
}

export type Role = AuthorityAccount['role'];

/** The program's removal rule (`manage.rs` `can_remove`); self-removal is refused separately. */
export function canRemove(actor: Role, target: Role, ownerCount: number): boolean {
  if (actor === 'owner' && target === 'owner') return ownerCount > 1;
  if (actor === 'owner') return true;
  return actor === 'admin' && target === 'spender';
}

export interface TypedChainView {
  /** Features the screen may rely on: the configured ones when the chain runs the configured binary, none otherwise. */
  readonly features: ReadonlySet<Feature>;
  readonly binary: 'configured' | 'unknown';
  readonly clock: Clock;
  readonly ownerCount: number;
  readonly signer: AuthorityAccount;
  readonly vault: string;
  /** createSession: each named mint, read. */
  readonly mints: Readonly<Record<string, MintRead>>;
  /** revokeSession: the session and its rules (shape-checked). */
  readonly session?: SessionAccount & { readonly rules: readonly Action[] };
  /** removeAuthority: the authority to remove, and its policy's rules. */
  readonly target?: AuthorityAccount & { readonly rules: readonly Action[] };
  /** The vault's holdings, when a "could spend all" line needs them; null when they could not be read. */
  readonly holdings?: VaultHoldings | null;
}

export type TypedRead =
  | { readonly ok: true; readonly view: TypedChainView }
  | { readonly ok: false; readonly code: 'wrong-network' | 'request-invalid' | 'chain-unavailable'; readonly reason: string };

export interface ReadOptions {
  readonly config: ProgramConfig | undefined;
  /**
   * The binary's deploy slot as this page knows it (it is read once per page):
   * a value, or how to read it; read here when absent. Never read for a
   * cluster that isn't configured.
   */
  readonly deploySlot?: number | null | (() => Promise<number | null>);
  /** The newest slot this page has already seen: reads are asked of nodes at or past it too. */
  readonly observedSlot?: number;
  /** The pauses between reads while answers are behind, and before the read that confirms a refusal. */
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  /** Whether the screen will need the vault's holdings (a "could spend all X" line). */
  readonly needsHoldings?: (req: ApprovalRequest, mints: Readonly<Record<string, MintRead>>, now: bigint) => boolean;
}

const invalid = (reason: string): TypedRead => ({ ok: false, code: 'request-invalid', reason });

/** The mints a createSession's actions name, in order, once each. */
export function namedMints(actions: readonly Action[]): string[] {
  const out: string[] = [];
  for (const a of actions) if ('mint' in a && !out.includes(a.mint)) out.push(a.mint);
  return out;
}

/**
 * Reads and checks everything `req` needs, refusing what would fail on chain
 * (DESIGN §3.4). Pure but for `transport` and `sleep`.
 *
 * Answers that are behind are read again (`READ_RETRY_DELAYS_MS`), then the
 * request is `chain-unavailable`. A `request-invalid` is returned only when
 * two fresh answers in a row say so, the second asked at or past the first.
 */
export async function readTypedChain(transport: Transport, req: ApprovalRequest, options: ReadOptions): Promise<TypedRead> {
  const { config } = options;
  if (!config || config.programId !== req.programId) return { ok: false, code: 'wrong-network', reason: `LazorKit isn't set up for this program on ${req.cluster}.` };
  const sleep = options.sleep ?? defaultSleep;
  const delays = options.retryDelaysMs ?? READ_RETRY_DELAYS_MS;
  let floor = readFloor(req, options.observedSlot);
  try {
    const known = options.deploySlot;
    const deploySlot =
      typeof known === 'function' ? await known() : known !== undefined ? known : await readDeploySlot(transport, req.programId, { minContextSlot: floor, retryDelaysMs: delays, sleep });
    const binary = deploySlot !== null && deploySlot === config.lastDeploySlot ? 'configured' : 'unknown';
    const features = new Set<Feature>(binary === 'configured' ? config.features : []);
    if (req.kind === 'createSession' && !REQUIRED_FEATURES.createSession.every((f) => features.has(f))) {
      return { ok: false, code: 'wrong-network', reason: binary === 'configured' ? "This network's LazorKit can't check this kind of request yet." : "The LazorKit program on this network isn't the one this page knows." };
    }
    if (!config.features.includes('wallet-bound-challenge')) return { ok: false, code: 'wrong-network', reason: "The LazorKit program on this network doesn't sign this way." };

    const kindKeys =
      req.kind === 'createSession'
        ? [sessionAddress(req.programId, req.wallet, req.args.sessionKey), ...namedMints(req.args.decoded)]
        : req.kind === 'revokeSession'
          ? [req.args.session]
          : [req.args.target];
    const keys = [req.wallet, req.authority, ...kindKeys];

    /** The first fresh answer's refusal, waiting for a second fresh answer to confirm it. */
    let refusal: TypedRead | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        const { clock, accounts } = await freshAccounts(transport, keys, floor);
        // The next read, if any, is asked of a node at least this far.
        floor = Math.max(floor, Number(clock.slot));
        const checked = checkTypedState(req, keys, accounts, clock, features, binary);
        if (checked.ok) return await withHoldings(transport, req, checked, options);
        if (refusal) return checked;
        refusal = checked;
      } catch (error) {
        if (!behind(error)) throw error;
      }
      if (attempt >= delays.length) {
        return { ok: false, code: 'chain-unavailable', reason: "The network's answers were out of date; LazorKit couldn't check this request." };
      }
      await sleep(delays[attempt]);
    }
  } catch (error) {
    return { ok: false, code: 'chain-unavailable', reason: error instanceof Error ? error.message : 'read failed' };
  }
}

/** The vault's holdings, added to an accepted createSession's view when a "could spend all" line needs them. */
async function withHoldings(transport: Transport, req: ApprovalRequest, read: Extract<TypedRead, { ok: true }>, options: ReadOptions): Promise<TypedRead> {
  if (req.kind !== 'createSession' || !options.needsHoldings?.(req, read.view.mints, read.view.clock.unixTimestamp)) return read;
  const holdings = await readVault(transport, read.view.vault);
  return { ok: true, view: { ...read.view, holdings: holdings.status === 'ok' ? holdings.value : null } };
}

/** What one fresh answer says about `req`: the view to show, or why the program would refuse it. */
function checkTypedState(
  req: ApprovalRequest,
  keys: readonly string[],
  accounts: readonly (RawAccount | null)[],
  clock: Clock,
  features: ReadonlySet<Feature>,
  binary: TypedChainView['binary'],
): TypedRead {
  const vault = vaultAddressOf(req.programId, req.wallet);
  const [walletAcc, authorityAcc, ...rest] = accounts;
  if (!walletAcc || walletAcc.owner !== req.programId || walletAcc.data.length < 8 || walletAcc.data[0] !== DISCRIMINATOR.wallet) {
    return invalid("The account it names isn't a LazorKit account on this network.");
  }
  const ownerCount = readU32(walletAcc.data, 4);
  const signer = authorityAcc && authorityAcc.owner === req.programId ? decodeAuthority(req.authority, authorityAcc.data) : null;
  if (!signer) return invalid("The passkey it names isn't part of this account.");
  if (signer.wallet !== req.wallet) return invalid('The passkey it names belongs to another account.');
  if (signer.key.type !== 'passkey' || signer.key.credentialIdHash !== hex(sha256(req.credentialId))) return invalid("The passkey it names isn't the one asked to sign.");
  if (signer.role === 'spender') return invalid("This passkey can't make this change.");
  if (signer.counter >= 0xffff_ffff) return invalid("This passkey can't sign any more changes.");
  if (passkeyAuthorityAddress(req.programId, req.wallet, req.credentialId) !== req.authority) return invalid("The passkey it names isn't the one asked to sign.");

  const cannotPayOrReceive = new Set([req.wallet, vault, req.authority]);
  const view: TypedChainView = { features, binary, clock, ownerCount, signer, vault, mints: {} };

  if (req.kind === 'createSession') {
    if (signer.policy) return invalid("This passkey has spending limits of its own, so it can't give out a permission.");
    const now = clock.unixTimestamp;
    if (req.args.expiresAt <= now) return invalid('It would end before it starts.');
    if (req.args.expiresAt > now + 30n * 86_400n) return invalid('It would last more than 30 days, the most LazorKit allows.');
    const [sessionAcc, ...mintAccs] = rest;
    if (sessionAcc && sessionAcc.data.length > 0) return invalid('This permission already exists.');
    const session = keys[2];
    if (cannotPayOrReceive.has(req.payer) || req.payer === session) return invalid("The fee payer it names can't pay for this.");
    const mints: Record<string, MintRead> = {};
    namedMints(req.args.decoded).forEach((mint, i) => {
      mints[mint] = decodeMint(mintAccs[i] ?? null);
    });
    for (const [mint, read] of Object.entries(mints)) {
      const known = knownToken(req.cluster, mint);
      if (known && (read.kind !== 'mint' || read.decimals !== known.decimals)) return invalid(`Solana doesn't describe ${known.symbol} the way LazorKit knows it.`);
    }
    return { ok: true, view: { ...view, mints } };
  }
  if (req.kind === 'revokeSession') {
    const [sessionAcc] = rest;
    const session = sessionAcc && sessionAcc.owner === req.programId ? decodeSession(req.args.session, sessionAcc.data) : null;
    if (!session) return invalid("The permission to stop doesn't exist.");
    if (session.wallet !== req.wallet) return invalid('The permission to stop belongs to another account.');
    const rules = decodeActions(session.actions, { forNewSession: false });
    if (!rules.ok) return invalid("LazorKit can't read the permission's limits.");
    if (cannotPayOrReceive.has(req.payer) || req.payer === req.args.session) return invalid("The fee payer it names can't pay for this.");
    if (cannotPayOrReceive.has(req.args.refund) || req.args.refund === req.args.session) return invalid("The deposit can't go back to the address it names.");
    return { ok: true, view: { ...view, session: { ...session, rules: rules.actions } } };
  }
  const [targetAcc] = rest;
  const target = targetAcc && targetAcc.owner === req.programId ? decodeAuthority(req.args.target, targetAcc.data) : null;
  if (!target) return invalid("The device or key to remove isn't part of this account.");
  if (target.wallet !== req.wallet) return invalid('The device or key to remove belongs to another account.');
  if (req.args.target === req.authority) return invalid("A passkey can't remove itself.");
  if (!canRemove(signer.role, target.role, ownerCount)) {
    return invalid(target.role === 'owner' && ownerCount <= 1 ? "It's the last device with full control." : "This passkey can't remove that device or key.");
  }
  const rules = target.policy ? decodeActions(target.policy, { forNewSession: false }) : { ok: true as const, actions: [] };
  if (!rules.ok) return invalid("LazorKit can't read that key's limits.");
  if (cannotPayOrReceive.has(req.payer) || req.payer === req.args.target) return invalid("The fee payer it names can't pay for this.");
  if (cannotPayOrReceive.has(req.args.refund) || req.args.refund === req.args.target) return invalid("The deposit can't go back to the address it names.");
  return { ok: true, view: { ...view, target: { ...target, rules: rules.actions } } };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** What the Approve click signs from: the authority's counter and the cluster's clock, and when they were read. */
export interface Snapshot {
  readonly counter: number;
  readonly slot: bigint;
  readonly unixTimestamp: bigint;
  /** `performance.now()`-style milliseconds at which the answer arrived. */
  readonly at: number;
}

/**
 * The snapshot: one `getMultipleAccounts` of the authority and the Clock,
 * asked of a node at or past `floor` (`readFloor`, with the newest slot the
 * page has seen). Null when a fresh answer says the signing authority is no
 * longer this wallet's (removed while the screen is open); a read that fails,
 * a Clock that isn't one, or an answer that is behind, throws.
 */
export async function readSnapshot(transport: Transport, req: ApprovalRequest, now: () => number, floor = readFloor(req)): Promise<Snapshot | null> {
  const { clock, accounts } = await freshAccounts(transport, [req.authority], floor);
  const [authorityAcc] = accounts;
  const authority = authorityAcc && authorityAcc.owner === req.programId ? decodeAuthority(req.authority, authorityAcc.data) : null;
  if (!authority || authority.wallet !== req.wallet) return null;
  return { counter: authority.counter, slot: clock.slot, unixTimestamp: clock.unixTimestamp, at: now() };
}
