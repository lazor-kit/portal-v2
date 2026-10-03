/**
 * Decision events from the portal page (src/security/telemetry.ts), logged as
 * one JSON line each. Only the listed fields, of the listed shapes, are kept;
 * anything else in a body is dropped, so nothing the page did not mean to
 * report reaches the logs.
 *
 *   POST /api/telemetry   body: one event, at most 4 KiB
 *
 * Callers: pages of the origin serving the request, the deployment's own
 * Vercel URLs, and PORTAL_ORIGIN (as for /api/rpc).
 * Self-contained, like every function in api/.
 */

export const MAX_EVENT_BYTES = 4 * 1024;

export interface TelemetryEnv {
  readonly PORTAL_ORIGIN?: string;
  readonly VERCEL_URL?: string;
  readonly VERCEL_BRANCH_URL?: string;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string;
}

export interface TelemetryDeps {
  readonly env: TelemetryEnv;
  readonly log: (line: Record<string, unknown>) => void;
}

const ENUMS: Record<string, readonly string[]> = {
  stage: ['transition', 'enforce'],
  event: ['request', 'result'],
  action: ['connect', 'sign'],
  channel: ['iframe', 'popup', 'redirect', 'webview', 'none'],
  evidence: ['ancestor-origins', 'message', 'referrer', 'none'],
  kind: ['message', 'message-without-text', 'ownership', 'transaction', 'approval', 'refused', 'sign-in'],
  outcome: ['shown', 'refused', 'approved', 'rejected', 'failed', 'undelivered'],
  cluster: ['mainnet', 'devnet'],
  clusterSource: ['request', 'default', 'preview'],
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}:\/\/$/;

export function allowedOrigins(env: TelemetryEnv): Set<string> {
  const listed = (env.PORTAL_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const own = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean).map((h) => `https://${h}`);
  return new Set([...listed, ...own]);
}

/** A page of the origin serving `requestUrl`, or a listed origin. */
export function isAllowedCaller(origin: string | null, env: TelemetryEnv, requestUrl: string): boolean {
  if (!origin || origin === 'null') return false;
  if (origin === new URL(requestUrl).origin) return true;
  return allowedOrigins(env).has(origin);
}

/** The event with only known fields of known shapes; null when it is not an event. */
export function cleanEvent(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const e = body as Record<string, unknown>;
  if (e.v !== 1 || !ENUMS.event.includes(e.event as string) || !ENUMS.outcome.includes(e.outcome as string)) return null;
  const pickEnum = (key: string) => (ENUMS[key].includes(e[key] as string) ? (e[key] as string) : null);
  const requester = typeof e.requester === 'string' && (ORIGIN.test(e.requester) || SCHEME.test(e.requester)) ? e.requester : null;
  const slug = (value: unknown) => (typeof value === 'string' && SLUG.test(value) ? value : null);
  return {
    v: 1,
    stage: pickEnum('stage'),
    event: e.event,
    action: pickEnum('action'),
    channel: pickEnum('channel'),
    evidence: pickEnum('evidence'),
    requester,
    registered: e.registered === true,
    app: slug(e.app),
    kind: pickEnum('kind'),
    outcome: e.outcome,
    reason: slug(e.reason),
    warnings: Array.isArray(e.warnings) ? e.warnings.map(slug).filter((w): w is string => w !== null).slice(0, 8) : [],
    cluster: pickEnum('cluster'),
    clusterSource: pickEnum('clusterSource'),
    browser: slug(e.browser),
    embedded: e.embedded === true,
  };
}

const empty = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export async function handleTelemetry(request: Request, deps: TelemetryDeps): Promise<Response> {
  if (request.method !== 'POST') return empty(405);
  const origin = request.headers.get('origin');
  if (!isAllowedCaller(origin, deps.env, request.url)) return empty(403);
  if (Number(request.headers.get('content-length') ?? '0') > MAX_EVENT_BYTES) return empty(413);
  const text = await request.text();
  if (text.length > MAX_EVENT_BYTES) return empty(413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const event = cleanEvent(parsed);
  if (!event) return empty(400);
  deps.log({ route: 'telemetry', ...event });
  return empty(204);
}

export function POST(request: Request): Promise<Response> {
  return handleTelemetry(request, { env: process.env as TelemetryEnv, log: (line) => console.log(JSON.stringify(line)) });
}
