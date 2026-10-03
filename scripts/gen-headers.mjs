#!/usr/bin/env node
/**
 * Writes vercel.json's response headers from config/registry.json and
 * config/portal-policy.json, so who may frame the portal is decided in one
 * reviewed place.
 *
 *   node scripts/gen-headers.mjs           write vercel.json
 *   node scripts/gen-headers.mjs --check   fail when vercel.json is out of date
 *
 * framing.mode "report" (transition): any https page may frame the portal
 * (WebAuthn needs a secure context anyway), and a report-only policy limited
 * to registered origins reports every other embedder to /api/csp-report.
 * framing.mode "enforce": only registered origins (plus loopback when
 * allowed) may frame it.
 *
 * Never X-Frame-Options (it cannot list origins) and never
 * Cross-Origin-Opener-Policy: same-origin (it cuts the popup's opener).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePolicy, parseRegistry } from '../src/security/config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPORT_PATH = '/api/csp-report';
const LOOPBACK = ['http://localhost:*', 'http://127.0.0.1:*', 'https://localhost:*'];

/** The frame-ancestors source list for registered origins (and loopback when the policy allows it). */
export function registeredAncestors(registry, policy) {
  const origins = [...new Set(registry.apps.flatMap((app) => app.origins ?? []))].sort();
  const sources = [...origins, ...(policy.framing.allowLoopback ? LOOPBACK : [])];
  return sources.length ? sources.join(' ') : "'none'";
}

export function headersFor(registry, policy) {
  const reporting = `report-uri ${REPORT_PATH}; report-to csp`;
  const registered = registeredAncestors(registry, policy);
  const headers =
    policy.framing.mode === 'enforce'
      ? [{ key: 'Content-Security-Policy', value: `frame-ancestors ${registered}; ${reporting}` }]
      : [
          { key: 'Content-Security-Policy', value: `frame-ancestors https:${policy.framing.allowLoopback ? ` ${LOOPBACK.filter((s) => s.startsWith('http:')).join(' ')}` : ''}` },
          { key: 'Content-Security-Policy-Report-Only', value: `frame-ancestors ${registered}; ${reporting}` },
        ];
  return [
    ...headers,
    { key: 'Reporting-Endpoints', value: `csp="${REPORT_PATH}"` },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
  ];
}

export function vercelConfig(registry, policy) {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    headers: [{ source: '/(.*)', headers: headersFor(registry, policy) }],
  };
}

export function render(registry, policy) {
  return `${JSON.stringify(vercelConfig(registry, policy), null, 2)}\n`;
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
      console.error('vercel.json is out of date with config/: run `pnpm headers` and commit the result.');
      process.exit(1);
    }
    console.log('vercel.json matches config/.');
  } else {
    writeFileSync(file, expected);
    console.log('Wrote vercel.json.');
  }
}
