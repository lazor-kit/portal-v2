/**
 * Read-only JSON-RPC calls through the portal's own `/api/rpc` route, with
 * every failure sorted into a reason the page can be honest about.
 *
 * The page never holds an RPC URL or key; the route picks the upstream for
 * the cluster named in the request (`api/rpc.ts`).
 */

export type Cluster = 'mainnet' | 'devnet';

/**
 * Why a read did not answer:
 * - `not-configured`: the deployment has no RPC for this cluster;
 * - `rate-limited`: this client, or the upstream, is over its budget;
 * - `timeout`: the upstream did not answer in time;
 * - `upstream`: the upstream failed or answered with a JSON-RPC error;
 * - `refused`: the route refused the request (a bug in the caller);
 * - `network`: the route could not be reached;
 * - `malformed`: the answer was not the shape asked for.
 */
export type ReadFailure = 'not-configured' | 'rate-limited' | 'timeout' | 'upstream' | 'refused' | 'network' | 'malformed';

/** The outcome of a read: a value, or why there is none. Never a guess. */
export type Read<T> = { readonly status: 'ok'; readonly value: T } | { readonly status: 'unavailable'; readonly reason: ReadFailure };

export class RpcReadError extends Error {
  readonly reason: ReadFailure;
  /** The JSON-RPC error code, when the upstream answered with one. */
  readonly code: number | null;

  constructor(reason: ReadFailure, message: string, code: number | null = null) {
    super(message);
    this.name = 'RpcReadError';
    this.reason = reason;
    this.code = code;
  }
}

/** One JSON-RPC call; resolves with its `result`, or rejects with an `RpcReadError`. */
export type Transport = (method: string, params: readonly unknown[]) => Promise<unknown>;

export const failureOf = (error: unknown): ReadFailure => (error instanceof RpcReadError ? error.reason : 'malformed');

function failureForStatus(status: number): ReadFailure {
  if (status === 503) return 'not-configured';
  if (status === 429) return 'rate-limited';
  if (status === 504) return 'timeout';
  if (status >= 500) return 'upstream';
  return 'refused';
}

/**
 * Calls through `/api/rpc?cluster=…` at `origin` (the page's own, by default).
 * `fetchImpl` is the platform's `fetch` in the page and a stand-in in tests.
 */
export function portalTransport(
  cluster: Cluster,
  { origin = globalThis.location?.origin, fetchImpl = globalThis.fetch.bind(globalThis) }: { origin?: string; fetchImpl?: typeof fetch } = {},
): Transport {
  const endpoint = new URL(`/api/rpc?cluster=${cluster}`, origin).href;
  let nextId = 1;
  return async (method, params) => {
    const id = nextId++;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new RpcReadError('network', `${method}: the RPC route could not be reached`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RpcReadError(response.ok ? 'malformed' : failureForStatus(response.status), `${method}: answer is not JSON (${response.status})`);
    }
    const error = typeof body === 'object' && body !== null ? (body as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    if (!response.ok) {
      throw new RpcReadError(failureForStatus(response.status), `${method}: ${String(error?.message ?? response.status)}`, typeof error?.code === 'number' ? error.code : null);
    }
    if (error !== undefined) {
      throw new RpcReadError('upstream', `${method}: ${String(error?.message ?? 'error')}`, typeof error?.code === 'number' ? error.code : null);
    }
    if (typeof body !== 'object' || body === null || !('result' in body)) {
      throw new RpcReadError('malformed', `${method}: answer has no result`);
    }
    return (body as { result: unknown }).result;
  };
}
