#!/usr/bin/env node
/**
 * Writes vercel.json's response headers from config/registry.json,
 * config/portal-policy.json and index.html, so who may frame the portal, and
 * what the page may load, are decided in one reviewed place.
 *
 *   node scripts/gen-headers.mjs           write vercel.json
 *   node scripts/gen-headers.mjs --check   fail when vercel.json is out of date
 *
 * Framing (framing.mode):
 *   "report" (transition): any https page may frame the portal (WebAuthn
 *   needs a secure context anyway); a report-only policy limited to
 *   registered origins counts every other framing at /api/csp-report.
 *   "enforce": only registered origins (plus loopback when allowed) may
 *   frame it.
 *
 * Content (contentPolicy, "report" or "enforce"): scripts from the portal's
 * own origin and the inline message recorder in index.html (by hash),
 * styles from its own origin, data from its own origin and the price API,
 * nothing else; no plugins, no <base>, no form submissions.
 *
 * Never X-Frame-Options (it cannot list origins) and never
 * Cross-Origin-Opener-Policy: same-origin (it cuts the popup's opener).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePolicy, parseRegistry } from '../src/security/config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPORT_PATH = '/api/csp-report';
const LOOPBACK = ['http://localhost:*', 'http://127.0.0.1:*', 'https://localhost:*'];
/** Where the page fetches data: its own /api routes, and the SOL price for the fee in USD. */
export const CONNECT_SOURCES = ["'self'", 'https://api.coingecko.com'];

/** The CSP sources (`'sha256-…'`) for the inline scripts of an HTML page. */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    hashes.push(`'sha256-${createHash('sha256').update(match[2], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** The frame-ancestors source list for registered origins (and loopback when the policy allows it). */
export function registeredAncestors(registry, policy) {
  const origins = [...new Set(registry.apps.flatMap((app) => app.origins ?? []))].sort();
  const sources = [...origins, ...(policy.framing.allowLoopback ? LOOPBACK : [])];
  return sources.length ? sources.join(' ') : "'none'";
}

/** The page's content directives. */
export function contentDirectives(scriptHashes) {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${CONNECT_SOURCES.join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
}

export function headersFor(registry, policy, scriptHashes = inlineScriptHashes(readFileSync(`${ROOT}/index.html`, 'utf8'))) {
  const reporting = [`report-uri ${REPORT_PATH}`, 'report-to csp'];
  const registered = `frame-ancestors ${registeredAncestors(registry, policy)}`;
  const anyHttps = `frame-ancestors https:${policy.framing.allowLoopback ? ` ${LOOPBACK.filter((s) => s.startsWith('http:')).join(' ')}` : ''}`;
  const content = contentDirectives(scriptHashes);

  const enforced = [];
  const reportOnly = [];
  if (policy.framing.mode === 'enforce') enforced.push(registered);
  else {
    enforced.push(anyHttps);
    reportOnly.push(registered);
  }
  if (policy.contentPolicy === 'enforce') enforced.push(...content);
  else reportOnly.push(...content);
  // The enforced policy reports once it holds more than the transition's "any https page".
  const enforcedReports = policy.framing.mode === 'enforce' || policy.contentPolicy === 'enforce';

  return [
    { key: 'Content-Security-Policy', value: [...enforced, ...(enforcedReports ? reporting : [])].join('; ') },
    ...(reportOnly.length ? [{ key: 'Content-Security-Policy-Report-Only', value: [...reportOnly, ...reporting].join('; ') }] : []),
    { key: 'Reporting-Endpoints', value: `csp="${REPORT_PATH}"` },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
  ];
}

export function vercelConfig(registry, policy, scriptHashes) {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    headers: [{ source: '/(.*)', headers: headersFor(registry, policy, scriptHashes) }],
  };
}

export function render(registry, policy, scriptHashes) {
  return `${JSON.stringify(vercelConfig(registry, policy, scriptHashes), null, 2)}\n`;
}

function load(root = ROOT) {
  const read = (file) => JSON.parse(readFileSync(`${root}/config/${file}`, 'utf8'));
  return { registry: parseRegistry(read('registry.json')), policy: parsePolicy(read('portal-policy.json')) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { registry, policy } = load();
  const expected = render(registry, policy);
  const file = `${ROOT}/vercel.json`;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // Missing counts as out of date.
    }
    if (current !== expected) {
      console.error('vercel.json is out of date with config/ or index.html: run `pnpm headers` and commit the result.');
      process.exit(1);
    }
    console.log('vercel.json matches config/ and index.html.');
  } else {
    writeFileSync(file, expected);
    console.log('Wrote vercel.json.');
  }
}
