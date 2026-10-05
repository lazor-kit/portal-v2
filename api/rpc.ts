/**
 * Solana JSON-RPC for the transaction preview, served from the portal's own
 * origin. The browser never holds an RPC URL or key: this route forwards a
 * short list of read-only methods to the upstream configured for the cluster.
 *
 *   POST /api/rpc?cluster=mainnet|devnet
 *   body: one JSON-RPC 2.0 request (no batches), at most 64 KiB
 *
 * Environment:
 *   RPC_MAINNET_URL  upstream for mainnet (secret; mainnet previews are
 *                    unavailable without it)
 *   RPC_DEVNET_URL   upstream for devnet (secret when keyed). Required on
 *                    Vercel production and preview deployments: the public
 *                    devnet RPC rate-limits the platform's shared addresses.
 *                    Elsewhere (local development) it defaults to the public
 *                    devnet RPC.
 *   PORTAL_ORIGIN    further origins allowed to call this route,
 *                    comma-separated (e.g. https://portal.lazor.sh)
 *
 * Callers: pages of the origin serving the request (same-origin), the
 * deployment's own Vercel URLs, and PORTAL_ORIGIN.
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

export const ALLOWED_METHODS = ['getMultipleAccounts', 'simulateTransaction', 'getLatestBlockhash', 'isBlockhashValid'] as const;
export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

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
  /** One structured log line; never given URLs, keys or request bodies. */
  readonly log: (line: Record<string, unknown>) => void;
  readonly now: () => number;
}

const COMMITMENTS = new Set(['processed', 'confirmed', 'finalized']);
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyKeys = (value: JsonObject, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

const isKey = (value: unknown): value is string => typeof value === 'string' && BASE58_KEY.test(value);

/** Optional `{ commitment, minContextSlot, ... }` with only `allowed` keys. */
function checkConfig(value: Json | undefined, allowed: readonly string[]): string | null {
  if (value === undefined) return null;
  if (!isObject(value) || !onlyKeys(value, allowed)) return 'unsupported config';
  if (value.commitment !== undefined && !COMMITMENTS.has(value.commitment as string)) return 'unsupported commitment';
  if (value.minContextSlot !== undefined && (typeof value.minContextSlot !== 'number' || !Number.isSafeInteger(value.minContextSlot))) {
    return 'unsupported minContextSlot';
  }
  return null;
}

function checkParams(method: AllowedMethod, params: Json[]): string | null {
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
  }
}

export type ValidatedRequest = {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly method: AllowedMethod;
  readonly params: Json[];
};

/** The request to forward, rebuilt from the checked fields only, or why it is refused. */
export function validateRpcRequest(body: unknown): { ok: true; request: ValidatedRequest } | { ok: false; id: string | number | null; message: string } {
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
  const invalid = checkParams(method as AllowedMethod, params);
  if (invalid) return { ok: false, id, message: invalid };
  return { ok: true, request: { jsonrpc: '2.0', id, method: method as AllowedMethod, params } };
}

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

function rpcError(status: number, id: string | number | null, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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
  const checked = validateRpcRequest(parsed);
  if (!checked.ok) return finish(rpcError(400, checked.id, -32600, checked.message));
  method = checked.request.method;

  const upstream = upstreamFor(deps.env, clusterParam);
  if (!upstream) return finish(rpcError(503, checked.request.id, -32603, `${clusterParam} RPC is not configured`));

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
    if (response.status === 429) return finish(rpcError(429, checked.request.id, -32005, 'upstream rate limited'));
    if (!response.ok) return finish(rpcError(502, checked.request.id, -32603, 'upstream error'));
    const declaredResponse = Number(response.headers.get('content-length') ?? '0');
    if (declaredResponse > MAX_RESPONSE_BYTES) return finish(rpcError(502, checked.request.id, -32603, 'upstream response too large'));
    const body = await readLimited(response.body, MAX_RESPONSE_BYTES);
    if (body === null) return finish(rpcError(502, checked.request.id, -32603, 'upstream response too large'));
    return finish(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
    );
  } catch {
    // The upstream URL never reaches the client, not even in an error.
    return finish(rpcError(controller.signal.aborted ? 504 : 502, checked.request.id, -32603, controller.signal.aborted ? 'upstream timed out' : 'upstream unavailable'));
  } finally {
    clearTimeout(timer);
  }
}

export function POST(request: Request): Promise<Response> {
  return handleRpc(request, {
    env: process.env as RpcEnv,
    fetch,
    log: (line) => console.log(JSON.stringify(line)),
    now: Date.now,
  });
}
