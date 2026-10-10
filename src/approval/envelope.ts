/**
 * The typed approval request, v1: a JSON object carried as base64url(UTF-8
 * JSON) in the URL fragment `#/?lk1=…`. Strict: the exact key set per kind,
 * canonical values only (base58 addresses, decimal u64 strings, unpadded
 * base64url), within the size caps. Anything else is refused, never repaired.
 *
 *   { v: 1, kind, cluster, programId, wallet, authority, credentialId, payer,
 *     counter, preparedSlot, minContextSlot?, args }
 *
 *   createSession    args { sessionKey, expiresAt, actions }
 *   revokeSession    args { session, refund }
 *   removeAuthority  args { target, refund }
 */
import { decodeActions, type Action } from './actions.ts';
import { addressBytes, base64urlDecode, base64urlEncode, fromUtf8, U32_MAX, U64_MAX, utf8 } from './bytes.ts';
import {
  APPROVAL_CLUSTERS,
  APPROVAL_KINDS,
  APPROVAL_VERSION,
  FRAGMENT_PARAM,
  FRAGMENT_PREFIX,
  MAX_ACTIONS_BUFFER,
  MAX_CREDENTIAL_ID,
  MAX_EXPIRES_AT,
  MAX_FRAGMENT_CHARS,
  type ApprovalCluster,
  type ApprovalKind,
} from './constants.ts';

export interface CreateSessionArgs {
  readonly sessionKey: string;
  /** Unix seconds. */
  readonly expiresAt: bigint;
  /** The exact actions buffer the program receives; empty for none. */
  readonly actions: Uint8Array;
  /** `actions`, decoded (creation rules applied). */
  readonly decoded: readonly Action[];
}
export interface RevokeSessionArgs {
  readonly session: string;
  readonly refund: string;
}
export interface RemoveAuthorityArgs {
  readonly target: string;
  readonly refund: string;
}

interface Common {
  readonly v: 1;
  readonly cluster: ApprovalCluster;
  readonly programId: string;
  readonly wallet: string;
  readonly authority: string;
  readonly credentialId: Uint8Array;
  readonly payer: string;
  /** The counter the SDK expects to sign with (the stored one + 1). */
  readonly counter: number;
  /** The slot of the SDK's own challenge (the `message` parameter). */
  readonly preparedSlot: bigint;
  readonly minContextSlot?: number;
}

export type ApprovalRequest =
  | (Common & { readonly kind: 'createSession'; readonly args: CreateSessionArgs })
  | (Common & { readonly kind: 'revokeSession'; readonly args: RevokeSessionArgs })
  | (Common & { readonly kind: 'removeAuthority'; readonly args: RemoveAuthorityArgs });

/** Why a request could not be read: `typed-unsupported` for an unknown `v` or `kind`, `typed-malformed` for anything else. */
export type DecodeFailure = { readonly ok: false; readonly code: 'typed-malformed' | 'typed-unsupported'; readonly reason: string };
export type DecodeResult = { readonly ok: true; readonly request: ApprovalRequest } | DecodeFailure;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const U64_TEXT = /^(0|[1-9][0-9]{0,19})$/;

class Malformed extends Error {}
const malformed = (reason: string): never => {
  throw new Malformed(reason);
};

function exactKeys(o: Obj, required: readonly string[], optional: readonly string[] = [], where = 'request'): void {
  const keys = Object.keys(o);
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) malformed(`${where}: missing ${k}`);
  for (const k of keys) if (!required.includes(k) && !optional.includes(k)) malformed(`${where}: unknown key ${k}`);
}

function address(o: Obj, key: string, where = 'request'): string {
  const v = o[key];
  if (typeof v !== 'string' || !addressBytes(v)) malformed(`${where}.${key} is not a base58 address`);
  return v as string;
}

function u64Text(o: Obj, key: string, where: string, max = U64_MAX): bigint {
  const v = o[key];
  if (typeof v !== 'string' || !U64_TEXT.test(v)) malformed(`${where}.${key} is not a decimal u64 string`);
  const n = BigInt(v as string);
  if (n > max) malformed(`${where}.${key} is out of range`);
  return n;
}

function parseArgs(kind: ApprovalKind, raw: unknown): ApprovalRequest['args'] {
  if (!isObj(raw)) return malformed('args is not an object');
  switch (kind) {
    case 'createSession': {
      exactKeys(raw, ['sessionKey', 'expiresAt', 'actions'], [], 'args');
      const sessionKey = address(raw, 'sessionKey', 'args');
      const expiresAt = u64Text(raw, 'expiresAt', 'args', MAX_EXPIRES_AT);
      if (typeof raw.actions !== 'string') malformed('args.actions is not a string');
      const actions = base64urlDecode(raw.actions as string);
      if (!actions) return malformed('args.actions is not unpadded base64url');
      if (actions.length > MAX_ACTIONS_BUFFER) malformed('args.actions is over the program cap');
      const decoded = decodeActions(actions);
      if (!decoded.ok) return malformed(`args.actions: ${decoded.reason}`);
      return { sessionKey, expiresAt, actions, decoded: decoded.actions };
    }
    case 'revokeSession':
      exactKeys(raw, ['session', 'refund'], [], 'args');
      return { session: address(raw, 'session', 'args'), refund: address(raw, 'refund', 'args') };
    case 'removeAuthority':
      exactKeys(raw, ['target', 'refund'], [], 'args');
      return { target: address(raw, 'target', 'args'), refund: address(raw, 'refund', 'args') };
  }
}

/** The request in `json` (already parsed), checked against the v1 schema. */
export function parseApprovalRequest(json: unknown): DecodeResult {
  try {
    if (!isObj(json)) return malformed('not a JSON object');
    const o = json as Obj;
    if (!Number.isInteger(o.v)) return malformed('v is not an integer');
    if (o.v !== APPROVAL_VERSION) return { ok: false, code: 'typed-unsupported', reason: `version ${String(o.v)}` };
    if (typeof o.kind !== 'string') return malformed('kind is not a string');
    if (!(APPROVAL_KINDS as readonly string[]).includes(o.kind)) return { ok: false, code: 'typed-unsupported', reason: `kind ${o.kind}` };
    const kind = o.kind as ApprovalKind;
    exactKeys(o, ['v', 'kind', 'cluster', 'programId', 'wallet', 'authority', 'credentialId', 'payer', 'counter', 'preparedSlot', 'args'], ['minContextSlot']);
    if (!(APPROVAL_CLUSTERS as readonly unknown[]).includes(o.cluster)) malformed('cluster is not devnet or mainnet');
    if (typeof o.credentialId !== 'string') malformed('credentialId is not a string');
    const credentialId = base64urlDecode(o.credentialId as string);
    if (!credentialId || credentialId.length === 0 || credentialId.length > MAX_CREDENTIAL_ID) malformed('credentialId is not 1 to 1023 bytes of unpadded base64url');
    if (typeof o.counter !== 'number' || !Number.isInteger(o.counter) || o.counter < 0 || o.counter > U32_MAX) malformed('counter is not a u32');
    if (o.minContextSlot !== undefined && (typeof o.minContextSlot !== 'number' || !Number.isSafeInteger(o.minContextSlot) || o.minContextSlot < 0)) {
      malformed('minContextSlot is not a slot');
    }
    const common: Common = {
      v: 1,
      cluster: o.cluster as ApprovalCluster,
      programId: address(o, 'programId'),
      wallet: address(o, 'wallet'),
      authority: address(o, 'authority'),
      credentialId: credentialId as Uint8Array,
      payer: address(o, 'payer'),
      counter: o.counter as number,
      preparedSlot: u64Text(o, 'preparedSlot', 'request'),
      ...(o.minContextSlot === undefined ? {} : { minContextSlot: o.minContextSlot as number }),
    };
    return { ok: true, request: { ...common, kind, args: parseArgs(kind, o.args) } as ApprovalRequest };
  } catch (error) {
    if (error instanceof Malformed) return { ok: false, code: 'typed-malformed', reason: error.message };
    throw error;
  }
}

/** Decodes the `lk1` value: base64url (unpadded) of UTF-8 JSON, at most `MAX_FRAGMENT_CHARS`. */
export function decodeApprovalRequest(value: string): DecodeResult {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, code: 'typed-malformed', reason: 'empty' };
  if (value.length > MAX_FRAGMENT_CHARS) return { ok: false, code: 'typed-malformed', reason: 'over the size cap' };
  const bytes = base64urlDecode(value);
  if (!bytes) return { ok: false, code: 'typed-malformed', reason: 'not unpadded base64url' };
  const text = fromUtf8(bytes);
  if (text === null) return { ok: false, code: 'typed-malformed', reason: 'not UTF-8' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'typed-malformed', reason: 'not JSON' };
  }
  return parseApprovalRequest(json);
}

/** The request as JSON, keys in schema order, values in their canonical text. */
export function approvalRequestJson(req: ApprovalRequest): Record<string, unknown> {
  const args =
    req.kind === 'createSession'
      ? { sessionKey: req.args.sessionKey, expiresAt: req.args.expiresAt.toString(), actions: base64urlEncode(req.args.actions) }
      : req.kind === 'revokeSession'
        ? { session: req.args.session, refund: req.args.refund }
        : { target: req.args.target, refund: req.args.refund };
  return {
    v: req.v,
    kind: req.kind,
    cluster: req.cluster,
    programId: req.programId,
    wallet: req.wallet,
    authority: req.authority,
    credentialId: base64urlEncode(req.credentialId),
    payer: req.payer,
    counter: req.counter,
    preparedSlot: req.preparedSlot.toString(),
    ...(req.minContextSlot === undefined ? {} : { minContextSlot: req.minContextSlot }),
    args,
  };
}

/** The `lk1` value for `req`. */
export function encodeApprovalRequest(req: ApprovalRequest): string {
  return base64urlEncode(utf8(JSON.stringify(approvalRequestJson(req))));
}

/**
 * What a URL fragment holds: nothing typed (`none`), the `lk1` value of a
 * `#/?lk1=…` fragment (`value`), or a fragment that names `lk1` in any other
 * form (`malformed`): once a fragment carries a request, nothing else is read.
 */
export type FragmentRead = { readonly kind: 'none' } | { readonly kind: 'value'; readonly value: string } | { readonly kind: 'malformed'; readonly reason: string };

export function readApprovalFragment(hash: string): FragmentRead {
  if (!hash || !hash.includes(FRAGMENT_PARAM)) return { kind: 'none' };
  if (!hash.startsWith(FRAGMENT_PREFIX)) return { kind: 'malformed', reason: `fragment is not ${FRAGMENT_PREFIX}…` };
  const value = hash.slice(FRAGMENT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return { kind: 'malformed', reason: 'fragment carries more than one base64url value' };
  return { kind: 'value', value };
}
