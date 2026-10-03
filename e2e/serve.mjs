/**
 * Local stand-ins for the hosting: the built portal with vercel.json's
 * headers and the api/ functions, the test dApp, and a fake Solana RPC.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json' };

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function toRequest(req, origin) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  return new Request(new URL(req.url, origin), {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
}

async function send(res, response, extraHeaders = []) {
  res.statusCode = response.status;
  for (const { key, value } of extraHeaders) res.setHeader(key, value);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function serveFile(res, root, pathname, headers = []) {
  const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  for (const { key, value } of headers) res.setHeader(key, value);
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
}

/**
 * The portal: `dist` with the headers from `vercelJson`, and /api/<name> served by api/<name>.ts.
 * `env` is what the functions see; `delayAssets` holds back the JS bundle (a slow network).
 */
export async function startPortal({ port, dist, vercelJson, apiDir, env, log, delayAssetsMs = () => 0 }) {
  const origin = `http://localhost:${port}`;
  const headers = JSON.parse(readFileSync(vercelJson, 'utf8')).headers.flatMap((h) => h.headers);
  const handlers = {};
  for (const name of ['rpc', 'telemetry', 'csp-report']) handlers[name] = await import(`${apiDir}/${name}.ts`);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const api = /^\/api\/([a-z-]+)$/.exec(url.pathname)?.[1];
      if (api && handlers[api]) {
        const request = await toRequest(req, origin);
        const mod = handlers[api];
        const response = api === 'rpc'
          ? await mod.handleRpc(request, { env, fetch, log: (line) => log({ port, ...line }), now: Date.now })
          : api === 'telemetry'
            ? await mod.handleTelemetry(request, { env, log: (line) => log({ port, ...line }) })
            : await mod.handleCspReport(request, { log: (line) => log({ port, ...line }) });
        return send(res, response, headers);
      }
      const delay = url.pathname.endsWith('.js') ? delayAssetsMs() : 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      serveFile(res, dist, url.pathname, headers);
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  return listen(server, port, 'localhost');
}

/**
 * The test dApp on `host:port`: its build, a page served with any Referrer-Policy (`?referrer=`),
 * a callback page that shows its query, and a bouncer page that navigates on to `?to=`.
 */
export async function startDapp({ port, host, dist }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === '/callback') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><title>callback</title><p id="callback">callback</p>');
    }
    if (url.pathname === '/bounce') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><script>location.replace(new URLSearchParams(location.search).get('to'))</script>`);
    }
    const referrer = url.searchParams.get('referrer');
    serveFile(res, dist, url.pathname, referrer ? [{ key: 'Referrer-Policy', value: referrer }] : []);
  });
  return listen(server, port, host);
}

/**
 * A fake Solana RPC: `/devnet` and `/mainnet`. A blockhash is valid on the
 * cluster named in `validOn` (default devnet); simulations succeed and change nothing.
 */
export async function startRpc({ port, validOn = () => 'devnet', calls }) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const cluster = new URL(req.url, 'http://x').pathname.slice(1);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ cluster, method: body.method, url: req.url });
    const context = { slot: 1, apiVersion: '2.0.0' };
    const results = {
      getMultipleAccounts: () => ({ context, value: (Array.isArray(body.params?.[0]) ? body.params[0] : []).map(() => null) }),
      getLatestBlockhash: () => ({ context, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } }),
      isBlockhashValid: () => ({ context, value: validOn() === cluster }),
      simulateTransaction: () => ({ context, value: { err: null, logs: ['Program 11111111111111111111111111111111 success'], accounts: null, unitsConsumed: 150, returnData: null } }),
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method]?.() ?? null }));
  });
  return listen(server, port, '127.0.0.1');
}
