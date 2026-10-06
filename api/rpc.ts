/**
 * Solana JSON-RPC for the portal's pages, served from the portal's own
 * origin. The browser never holds an RPC URL or key: this route forwards a
 * short list of read-only methods, each with its parameters checked, to the
 * upstream configured for the cluster the request names.
 *
 *   POST /api/rpc?cluster=mainnet|devnet
 *   body: one JSON-RPC 2.0 request (no batches), at most 64 KiB
 *
 * Methods:
 *   transaction preview   getMultipleAccounts, simulateTransaction,
 *                         getLatestBlockhash, isBlockhashValid
 *   display               getAccountInfo, getBalance, getTokenAccountsByOwner
 *                         (SPL Token or Token-2022), getProgramAccounts (the
 *                         LazorKit v2 program of the cluster only, filtered to
 *                         one account type of one wallet),
 *                         getSignaturesForAddress, getTransaction
 * Nothing that writes, signs or airdrops is forwarded.
 *
 * Environment:
 *   RPC_MAINNET_URL  upstream for mainnet (secret; mainnet reads are
 *                    unavailable without it)
 *   RPC_DEVNET_URL   upstream for devnet (secret when keyed). Required on
 *                    Vercel production and preview deployments: the public
 *                    devnet RPC rate-limits the platform's shared addresses.
 *                    Elsewhere (local development) it defaults to the public
 *                    devnet RPC.
 *   PORTAL_ORIGIN    further origins allowed to call this route,
 *                    comma-separated (e.g. https://portal.lazor.sh)
 * The upstream must serve getProgramAccounts, getSignaturesForAddress and
 * getTransaction (transaction history) for the display reads.
 *
 * Callers: pages of the origin serving the request (same-origin), the
 * deployment's own Vercel URLs, and PORTAL_ORIGIN. Each client address has a
 * budget of request cost (`RATE_LIMIT`), charged for calls to the upstream
 * and kept in the memory of the instance that serves it: a first line of
 * defence, not a replacement for a rate limit at the edge.
 *
 * Responses are never stored by caches (`no-store`): account state changes.
 * Finalized transactions do not, so the instance keeps recent ones in memory
 * and answers repeats without the upstream.
 *
 * The file is self-contained (no local imports) so the platform can build it
 * as a function on its own.
 */

export type Cluster = 'mainnet' | 'devnet';

export const DEFAULT_DEVNET_URL = 'https://api.devnet.solana.com';
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 8_000;
export const MAX_ACCOUNT_KEYS = 100;
export const MAX_TRANSACTION_CHARS = 2048;
export const MAX_SIMULATION_ADDRESSES = 128;
export const MAX_SIGNATURES = 1000;
export const MAX_DATA_SLICE_BYTES = 10 * 1024 * 1024;

export const ALLOWED_METHODS = [
  'getMultipleAccounts',
  'simulateTransaction',
  'getLatestBlockhash',
  'isBlockhashValid',
  'getAccountInfo',
  'getBalance',
  'getTokenAccountsByOwner',
  'getProgramAccounts',
  'getSignaturesForAddress',
  'getTransaction',
] as const;
export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/** The LazorKit v2 program on each cluster: the only program whose accounts may be listed. */
export const LAZORKIT_PROGRAM: Readonly<Record<Cluster, string>> = {
  mainnet: 'LazorFroiVuAjcwwQ2me83vTr5nc5NRxSaTg3pmEXC8',
  devnet: '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv',
};

/**
 * LazorKit v2 account types that may be listed, by their first byte
 * (discriminator), with the offset of the wallet they belong to:
 * Authority (0x22) at 16, Session (0x23) at 8, DeferredExec (0x24) at 72
 * (lazorkit-protocol `program/src/state`).
 */
export const WALLET_OFFSET: Readonly<Record<number, number>> = { 0x22: 16, 0x23: 8, 0x24: 72 };

export const TOKEN_PROGRAMS: readonly string[] = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];

/**
 * Cost of one request against a client's budget, roughly in proportion to
 * what it costs the upstream. A budget of `capacity` refills at
 * `refillPerSecond`; a scan of a hundred transactions fits, a loop does not.
 */
export const METHOD_COST: Readonly<Record<AllowedMethod, number>> = {
  getMultipleAccounts: 1,
  simulateTransaction: 2,
  getLatestBlockhash: 1,
  isBlockhashValid: 1,
  getAccountInfo: 1,
  getBalance: 1,
  getTokenAccountsByOwner: 2,
  getProgramAccounts: 10,
  getSignaturesForAddress: 5,
  getTransaction: 1,
};
export const RATE_LIMIT = { capacity: 300, refillPerSecond: 5, maxClients: 10_000 } as const;
export const TRANSACTION_CACHE_BYTES = 8 * 1024 * 1024;

export interface RpcEnv {
  readonly RPC_MAINNET_URL?: string;
  readonly RPC_DEVNET_URL?: string;
  readonly PORTAL_ORIGIN?: string;
  /** `production`, `preview` or `development` on Vercel; unset elsewhere. */
  readonly VERCEL_ENV?: string;
  readonly VERCEL_URL?: string;
  readonly VERCEL_BRANCH_URL?: string;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string;
}

export interface RpcDeps {
  readonly env: RpcEnv;
  readonly fetch: typeof fetch;
  /** One structured log line; never given URLs, keys, client addresses or request bodies. */
  readonly log: (line: Record<string, unknown>) => void;
  readonly now: () => number;
  /** Per-client budget; none means no limit (tests). */
  readonly limiter?: RateLimiter;
  /** Finalized transactions already read; none means no cache. */
  readonly cache?: MemoryCache;
}

const COMMITMENTS = new Set(['processed', 'confirmed', 'finalized']);
/** History methods: the RPC serves them at `confirmed` or `finalized` only. */
const HISTORY_COMMITMENTS = new Set(['confirmed', 'finalized']);
const TRANSACTION_ENCODINGS = new Set(['json', 'jsonParsed', 'base64']);
const TRANSACTION_VERSIONS = new Set([0, 1]);
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyKeys = (value: JsonObject, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

const isKey = (value: unknown): value is string => typeof value === 'string' && BASE58_KEY.test(value);

const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Base58 to bytes; null when it is not base58 or longer than 128 characters. */
export function decodeBase58(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > 128) return null;
  const bytes: number[] = [];
  for (const char of text) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const isSignature = (value: unknown): value is string =>
  typeof value === 'string' && BASE58_SIGNATURE.test(value) && decodeBase58(value)?.length === 64;

/** Optional `{ commitment, minContextSlot, dataSlice, ... }` with only `allowed` keys. */
function checkConfig(value: Json | undefined, allowed: readonly string[]): string | null {
  if (value === undefined) return null;
  if (!isObject(value) || !onlyKeys(value, allowed)) return 'unsupported config';
  if (value.commitment !== undefined && !COMMITMENTS.has(value.commitment as string)) return 'unsupported commitment';
  if (value.minContextSlot !== undefined && (typeof value.minContextSlot !== 'number' || !Number.isSafeInteger(value.minContextSlot))) {
    return 'unsupported minContextSlot';
  }
  if (value.dataSlice !== undefined) {
    const slice = value.dataSlice;
    if (!isObject(slice) || !onlyKeys(slice, ['offset', 'length']) || !isCount(slice.offset, MAX_DATA_SLICE_BYTES) || !isCount(slice.length, MAX_DATA_SLICE_BYTES)) {
      return 'unsupported dataSlice';
    }
  }
  return null;
}

/** As `checkConfig`, for methods served at `confirmed` or `finalized` only. */
function checkHistoryConfig(value: Json | undefined, allowed: readonly string[]): string | null {
  const invalid = checkConfig(value, allowed);
  if (invalid) return invalid;
  if (isObject(value) && value.commitment !== undefined && !HISTORY_COMMITMENTS.has(value.commitment as string)) {
    return 'expected confirmed or finalized';
  }
  return null;
}

/** The offset and bytes of a `{ memcmp }` filter (base58, or base64 when it says so); null otherwise. */
function memcmpOf(filter: Json): { offset: number; bytes: Uint8Array } | null {
  if (!isObject(filter) || !onlyKeys(filter, ['memcmp']) || !isObject(filter.memcmp)) return null;
  const memcmp = filter.memcmp;
  if (!onlyKeys(memcmp, ['offset', 'bytes', 'encoding']) || !isCount(memcmp.offset, 1024) || typeof memcmp.bytes !== 'string') return null;
  const encoding = memcmp.encoding ?? 'base58';
  const bytes = encoding === 'base58' ? decodeBase58(memcmp.bytes) : encoding === 'base64' ? decodeBase64(memcmp.bytes) : null;
  return bytes ? { offset: memcmp.offset, bytes } : null;
}

/**
 * Exactly two filters: the account type (one byte at offset 0, a type in
 * `WALLET_OFFSET`) and a 32-byte wallet address at that type's wallet offset.
 * A listing can therefore only ever be one wallet's accounts of one type.
 */
function checkWalletFilters(filters: Json | undefined): string | null {
  const refused = 'expected an account type filter and a wallet filter';
  if (!Array.isArray(filters) || filters.length !== 2) return refused;
  const [a, b] = filters.map(memcmpOf);
  if (!a || !b) return refused;
  const [type, wallet] = a.offset === 0 && a.bytes.length === 1 ? [a, b] : [b, a];
  if (type.offset !== 0 || type.bytes.length !== 1) return refused;
  const walletOffset = WALLET_OFFSET[type.bytes[0]];
  if (walletOffset === undefined || wallet.offset !== walletOffset || wallet.bytes.length !== 32) return refused;
  return null;
}

function checkParams(method: AllowedMethod, params: Json[], cluster: Cluster): string | null {
  switch (method) {
    case 'getMultipleAccounts': {
      if (params.length < 1 || params.length > 2) return 'expected [keys, config]';
      const [keys, config] = params;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_ACCOUNT_KEYS || !keys.every(isKey)) {
        return `expected 1 to ${MAX_ACCOUNT_KEYS} account addresses`;
      }
      if (!isObject(config) || config.encoding !== 'base64') return 'expected base64 encoding';
      return checkConfig(config, ['encoding', 'commitment', 'minContextSlot', 'dataSlice']);
    }
    case 'simulateTransaction': {
      if (params.length !== 2) return 'expected [transaction, config]';
      const [tx, config] = params;
      if (typeof tx !== 'string' || tx.length === 0 || tx.length > MAX_TRANSACTION_CHARS || !BASE64.test(tx)) {
        return 'expected a base64 transaction';
      }
      if (!isObject(config) || config.encoding !== 'base64') return 'expected base64 encoding';
      const invalid = checkConfig(config, ['encoding', 'commitment', 'minContextSlot', 'replaceRecentBlockhash', 'sigVerify', 'accounts', 'innerInstructions']);
      if (invalid) return invalid;
      if (config.sigVerify !== undefined && config.sigVerify !== false) return 'sigVerify is not supported';
      if (config.replaceRecentBlockhash !== undefined && typeof config.replaceRecentBlockhash !== 'boolean') return 'unsupported config';
      if (config.innerInstructions !== undefined && typeof config.innerInstructions !== 'boolean') return 'unsupported config';
      if (config.accounts !== undefined) {
        const accounts = config.accounts;
        if (!isObject(accounts) || !onlyKeys(accounts, ['encoding', 'addresses'])) return 'unsupported accounts config';
        if (accounts.encoding !== undefined && accounts.encoding !== 'base64') return 'expected base64 encoding';
        const addresses = accounts.addresses;
        if (!Array.isArray(addresses) || addresses.length > MAX_SIMULATION_ADDRESSES || !addresses.every(isKey)) {
          return `expected at most ${MAX_SIMULATION_ADDRESSES} account addresses`;
        }
      }
      return null;
    }
    case 'getLatestBlockhash':
      if (params.length > 1) return 'expected [config]';
      return checkConfig(params[0], ['commitment', 'minContextSlot']);
    case 'isBlockhashValid':
      if (params.length < 1 || params.length > 2 || !isKey(params[0])) return 'expected [blockhash, config]';
      return checkConfig(params[1], ['commitment', 'minContextSlot']);
    case 'getAccountInfo': {
      if (params.length !== 2 || !isKey(params[0])) return 'expected [address, config]';
      const config = params[1];
      if (!isObject(config) || config.encoding !== 'base64') return 'expected base64 encoding';
      return checkConfig(config, ['encoding', 'commitment', 'minContextSlot', 'dataSlice']);
    }
    case 'getBalance':
      if (params.length < 1 || params.length > 2 || !isKey(params[0])) return 'expected [address, config]';
      return checkConfig(params[1], ['commitment', 'minContextSlot']);
    case 'getTokenAccountsByOwner': {
      if (params.length !== 3 || !isKey(params[0])) return 'expected [owner, filter, config]';
      const [, filter, config] = params;
      const byMint = isObject(filter) && onlyKeys(filter, ['mint']) && isKey(filter.mint);
      const byProgram = isObject(filter) && onlyKeys(filter, ['programId']) && TOKEN_PROGRAMS.includes(filter.programId as string);
      if (!byMint && !byProgram) return 'expected a mint or a token program';
      if (!isObject(config) || (config.encoding !== 'base64' && config.encoding !== 'jsonParsed')) return 'expected base64 or jsonParsed encoding';
      if (config.encoding === 'jsonParsed' && config.dataSlice !== undefined) return 'unsupported dataSlice';
      return checkConfig(config, ['encoding', 'commitment', 'minContextSlot', 'dataSlice']);
    }
    case 'getProgramAccounts': {
      if (params.length !== 2) return 'expected [program, config]';
      const [program, config] = params;
      if (program !== LAZORKIT_PROGRAM[cluster]) return 'program not allowed';
      if (!isObject(config) || config.encoding !== 'base64') return 'expected base64 encoding';
      const invalid = checkConfig(config, ['encoding', 'commitment', 'minContextSlot', 'dataSlice', 'withContext', 'filters']);
      if (invalid) return invalid;
      if (config.withContext !== undefined && typeof config.withContext !== 'boolean') return 'unsupported config';
      return checkWalletFilters(config.filters);
    }
    case 'getSignaturesForAddress': {
      if (params.length < 1 || params.length > 2 || !isKey(params[0])) return 'expected [address, config]';
      const config = params[1];
      // The newest signatures only: no paging back through an address's history.
      const invalid = checkHistoryConfig(config, ['commitment', 'minContextSlot', 'limit']);
      if (invalid || config === undefined) return invalid;
      if (!isObject(config)) return 'unsupported config';
      if (config.limit !== undefined && (!isCount(config.limit, MAX_SIGNATURES) || config.limit === 0)) return `expected a limit of 1 to ${MAX_SIGNATURES}`;
      return null;
    }
    case 'getTransaction': {
      if (params.length !== 2 || !isSignature(params[0])) return 'expected [signature, config]';
      const config = params[1];
      if (!isObject(config)) return 'expected [signature, config]';
      const invalid = checkHistoryConfig(config, ['encoding', 'commitment', 'maxSupportedTransactionVersion']);
      if (invalid) return invalid;
      if (config.encoding !== undefined && !TRANSACTION_ENCODINGS.has(config.encoding as string)) return 'unsupported encoding';
      if (config.maxSupportedTransactionVersion !== undefined && !TRANSACTION_VERSIONS.has(config.maxSupportedTransactionVersion as number)) {
        return 'unsupported maxSupportedTransactionVersion';
      }
      return null;
    }
  }
}

export type ValidatedRequest = {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly method: AllowedMethod;
  readonly params: Json[];
};

/** The request to forward, rebuilt from the checked fields only, or why it is refused. */
export function validateRpcRequest(
  body: unknown,
  cluster: Cluster,
): { ok: true; request: ValidatedRequest } | { ok: false; id: string | number | null; message: string } {
  if (!isObject(body)) return { ok: false, id: null, message: 'expected one JSON-RPC request object' };
  const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  if (body.jsonrpc !== '2.0') return { ok: false, id, message: 'expected jsonrpc 2.0' };
  if (!onlyKeys(body, ['jsonrpc', 'id', 'method', 'params'])) return { ok: false, id, message: 'unexpected fields' };
  if (body.id !== undefined && body.id !== null && id === null) return { ok: false, id, message: 'unsupported id' };
  const method = body.method;
  if (typeof method !== 'string' || !(ALLOWED_METHODS as readonly string[]).includes(method)) {
    return { ok: false, id, message: 'method not allowed' };
  }
  const params = body.params === undefined ? [] : body.params;
  if (!Array.isArray(params)) return { ok: false, id, message: 'expected params array' };
  const invalid = checkParams(method as AllowedMethod, params, cluster);
  if (invalid) return { ok: false, id, message: invalid };
  return { ok: true, request: { jsonrpc: '2.0', id, method: method as AllowedMethod, params } };
}

// ─── Who is asking ──────────────────────────────────────────────────────────

function hostOrigin(host: string | undefined): string | null {
  return host ? `https://${host}` : null;
}

/** Origins listed as callers: PORTAL_ORIGIN, plus this deployment's own Vercel URLs. */
export function allowedOrigins(env: RpcEnv): Set<string> {
  const listed = (env.PORTAL_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const own = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].map(hostOrigin);
  return new Set([...listed, ...own].filter((o): o is string => o !== null));
}

/**
 * Whether a browser request from `origin` may call the route: a page of the
 * origin serving `requestUrl` (any domain the deployment answers on, a
 * staging domain included), or a listed origin.
 */
export function isAllowedCaller(origin: string | null, env: RpcEnv, requestUrl: string): boolean {
  if (!origin || origin === 'null') return false;
  if (origin === new URL(requestUrl).origin) return true;
  return allowedOrigins(env).has(origin);
}

/** The first 64 bits of an IPv6 address (one subscriber's block), or null when it is not one. */
function ipv6Block(ip: string): string | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * Whom a request's budget belongs to: the client address the platform
 * reports (Vercel sets `x-real-ip` and `x-forwarded-for` itself), an IPv6
 * client by its /64. Never logged.
 */
export function clientKey(request: Request): string {
  const reported = request.headers.get('x-real-ip')?.trim() || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!reported) return 'unknown';
  if (reported.includes('.')) return reported.slice(reported.lastIndexOf(':') + 1);
  return ipv6Block(reported) ?? reported;
}

/** A token bucket per client, in this instance's memory; the least recently seen client is forgotten first. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxClients: number;

  constructor(limit: { capacity: number; refillPerSecond: number; maxClients: number } = RATE_LIMIT) {
    this.capacity = limit.capacity;
    this.refillPerSecond = limit.refillPerSecond;
    this.maxClients = limit.maxClients;
  }

  /** Takes `cost` from `key`'s budget at `now` (ms): 0 when allowed, else the seconds until it would be. */
  take(key: string, cost: number, now: number): number {
    const previous = this.buckets.get(key);
    this.buckets.delete(key);
    const tokens = previous
      ? Math.min(this.capacity, previous.tokens + ((now - previous.at) / 1000) * this.refillPerSecond)
      : this.capacity;
    const allowed = tokens >= cost;
    this.buckets.set(key, { tokens: allowed ? tokens - cost : tokens, at: now });
    while (this.buckets.size > this.maxClients) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return allowed ? 0 : Math.max(1, Math.ceil((cost - tokens) / this.refillPerSecond));
  }
}

/** Values by key up to `maxBytes` of UTF-16 text; the least recently used goes first. */
export class MemoryCache {
  private readonly entries = new Map<string, string>();
  private size = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = TRANSACTION_CACHE_BYTES) {
    this.maxBytes = maxBytes;
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    const bytes = (key.length + value.length) * 2;
    if (bytes > this.maxBytes / 8 || this.entries.has(key)) return;
    this.entries.set(key, value);
    this.size += bytes;
    for (const [oldKey, oldValue] of this.entries) {
      if (this.size <= this.maxBytes) break;
      this.entries.delete(oldKey);
      this.size -= (oldKey.length + oldValue.length) * 2;
    }
  }
}

/** The cache key of a request whose answer cannot change (a finalized transaction); null for anything else. */
function immutableKey(request: ValidatedRequest, cluster: Cluster): string | null {
  if (request.method !== 'getTransaction') return null;
  const config = request.params[1] as JsonObject;
  if (config.commitment !== 'finalized') return null;
  return [cluster, request.params[0], config.encoding ?? 'json', config.maxSupportedTransactionVersion ?? 'legacy'].join(' ');
}

/** Whether this is a Vercel production or preview deployment. */
function deployed(env: RpcEnv): boolean {
  return env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
}

export function upstreamFor(env: RpcEnv, cluster: Cluster): string | null {
  if (cluster === 'mainnet') return env.RPC_MAINNET_URL?.trim() || null;
  const configured = env.RPC_DEVNET_URL?.trim();
  if (configured) return configured;
  return deployed(env) ? null : DEFAULT_DEVNET_URL;
}

const NO_STORE = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

function rpcError(status: number, id: string | number | null, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: { ...NO_STORE, ...headers },
  });
}

/** The body as text, or null once it passes `limit` bytes. */
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The `result` of a successful upstream answer, as JSON text; null when there is none to keep. */
function resultText(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isObject(parsed) || parsed.error !== undefined || parsed.result === undefined || parsed.result === null) return null;
    return JSON.stringify(parsed.result);
  } catch {
    return null;
  }
}

export async function handleRpc(request: Request, deps: RpcDeps): Promise<Response> {
  const started = deps.now();
  const url = new URL(request.url);
  const clusterParam = url.searchParams.get('cluster');
  let method: string | null = null;
  const finish = (response: Response) => {
    deps.log({ route: 'rpc', method, cluster: clusterParam === 'mainnet' || clusterParam === 'devnet' ? clusterParam : null, status: response.status, ms: deps.now() - started });
    return response;
  };

  if (request.method !== 'POST') return finish(rpcError(405, null, -32600, 'POST only'));
  const origin = request.headers.get('origin');
  if (!isAllowedCaller(origin, deps.env, request.url)) return finish(rpcError(403, null, -32600, 'origin not allowed'));
  if (clusterParam !== 'mainnet' && clusterParam !== 'devnet') return finish(rpcError(400, null, -32600, 'cluster must be mainnet or devnet'));

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) return finish(rpcError(413, null, -32600, 'request too large'));
  const text = await readLimited(request.body, MAX_REQUEST_BYTES);
  if (text === null) return finish(rpcError(413, null, -32600, 'request too large'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return finish(rpcError(400, null, -32700, 'invalid JSON'));
  }
  const checked = validateRpcRequest(parsed, clusterParam);
  if (!checked.ok) return finish(rpcError(400, checked.id, -32600, checked.message));
  method = checked.request.method;
  const id = checked.request.id;

  const upstream = upstreamFor(deps.env, clusterParam);
  if (!upstream) return finish(rpcError(503, id, -32603, `${clusterParam} RPC is not configured`));

  const cacheKey = deps.cache ? immutableKey(checked.request, clusterParam) : null;
  const cached = cacheKey ? deps.cache?.get(cacheKey) : undefined;
  if (cached !== undefined) {
    return finish(new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${cached}}`, { status: 200, headers: NO_STORE }));
  }

  // Only a call to the upstream costs budget; an answer from memory does not.
  const wait = deps.limiter?.take(clientKey(request), METHOD_COST[checked.request.method], deps.now()) ?? 0;
  if (wait > 0) return finish(rpcError(429, id, -32005, 'rate limited', { 'retry-after': String(wait) }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await deps.fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checked.request),
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 429) return finish(rpcError(429, id, -32005, 'upstream rate limited'));
    if (!response.ok) return finish(rpcError(502, id, -32603, 'upstream error'));
    const declaredResponse = Number(response.headers.get('content-length') ?? '0');
    if (declaredResponse > MAX_RESPONSE_BYTES) return finish(rpcError(502, id, -32603, 'upstream response too large'));
    const body = await readLimited(response.body, MAX_RESPONSE_BYTES);
    if (body === null) return finish(rpcError(502, id, -32603, 'upstream response too large'));
    if (cacheKey) {
      const result = resultText(body);
      if (result !== null) deps.cache?.set(cacheKey, result);
    }
    return finish(new Response(body, { status: 200, headers: NO_STORE }));
  } catch {
    // The upstream URL never reaches the client, not even in an error.
    return finish(rpcError(controller.signal.aborted ? 504 : 502, id, -32603, controller.signal.aborted ? 'upstream timed out' : 'upstream unavailable'));
  } finally {
    clearTimeout(timer);
  }
}

/** Kept for the life of the instance: budgets and finalized transactions. */
const limiter = new RateLimiter();
const cache = new MemoryCache();

export function POST(request: Request): Promise<Response> {
  return handleRpc(request, {
    env: process.env as RpcEnv,
    fetch,
    log: (line) => console.log(JSON.stringify(line)),
    now: Date.now,
    limiter,
    cache,
  });
}
