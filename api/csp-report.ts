/**
 * Content-Security-Policy reports, logged as one JSON line each: the
 * directive, whether the policy blocked or would have blocked, and origins
 * only (never a path or query).
 *
 * For frame-ancestors, browsers report the portal's own URL and never the
 * site that framed it, so these lines count framings (by unregistered sites
 * in transition) without naming anyone. The embedders to register come from
 * /api/telemetry, whose events name the requesting origin. For the page's
 * content policy, `blocked` is the origin of what was (or would have been)
 * blocked.
 *
 *   POST /api/csp-report
 *     application/csp-report   { "csp-report": { ... } }       (report-uri)
 *     application/reports+json [ { type: "csp-violation", body } ] (report-to)
 *
 * Self-contained, like every function in api/.
 */

export const MAX_REPORT_BYTES = 16 * 1024;
const MAX_REPORTS = 10;

export interface CspDeps {
  readonly log: (line: Record<string, unknown>) => void;
}

/** `https://host[:port]` of a URL, the keyword the browser gave instead of one, or null. */
function originOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^[a-z-]+$/.test(value)) return value.slice(0, 32); // 'self', 'inline', 'eval', ...
  try {
    const url = new URL(value);
    return url.origin === 'null' ? `${url.protocol}` : url.origin;
  } catch {
    return null;
  }
}

/** The fields kept from one report, whichever format it came in. */
export function summarise(report: Record<string, unknown>): Record<string, unknown> | null {
  const directive = report.effectiveDirective ?? report['effective-directive'] ?? report.violatedDirective ?? report['violated-directive'];
  if (typeof directive !== 'string') return null;
  const disposition = report.disposition;
  return {
    directive: directive.split(' ')[0].slice(0, 32),
    disposition: disposition === 'enforce' || disposition === 'report' ? disposition : null,
    blocked: originOnly(report.blockedURL ?? report['blocked-uri']),
    document: originOnly(report.documentURL ?? report['document-uri']),
  };
}

export async function handleCspReport(request: Request, deps: CspDeps): Promise<Response> {
  const done = new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (Number(request.headers.get('content-length') ?? '0') > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const bodies: unknown[] = Array.isArray(parsed)
    ? parsed.filter((r) => r && typeof r === 'object' && (r as { type?: unknown }).type === 'csp-violation').map((r) => (r as { body?: unknown }).body)
    : [(parsed as { 'csp-report'?: unknown } | null)?.['csp-report']];
  for (const body of bodies.slice(0, MAX_REPORTS)) {
    if (!body || typeof body !== 'object') continue;
    const summary = summarise(body as Record<string, unknown>);
    if (summary) deps.log({ route: 'csp-report', ...summary });
  }
  return done;
}

export function POST(request: Request): Promise<Response> {
  return handleCspReport(request, { log: (line) => console.log(JSON.stringify(line)) });
}
