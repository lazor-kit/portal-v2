// Framing headers come from the registry and the policy, and vercel.json is
// in sync with them; the report route keeps origins only. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headersFor, render } from '../scripts/gen-headers.mjs';
import { parsePolicy, parseRegistry } from '../src/security/config.ts';
import type { PortalPolicy } from '../src/security/policy.ts';
import { handleCspReport } from '../api/csp-report.ts';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const policy = parsePolicy(read('config/portal-policy.json'));
const registry = parseRegistry(read('config/registry.json'));
const acme = parseRegistry({ version: 1, apps: [{ id: 'acme', name: 'Acme', origins: ['https://b.acme.example', 'https://a.acme.example'] }] });
const enforce: PortalPolicy = { ...policy, stage: 'enforce', framing: { mode: 'enforce', allowLoopback: false } };
type Header = { key: string; value: string };
const header = (headers: Header[], key: string) => headers.find((h) => h.key === key)?.value;

test('vercel.json matches config/ (run `pnpm headers` after changing either)', () => {
  assert.equal(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'), render(registry, policy));
});

test('transition: any https page (and loopback) may frame; others than registered are reported', () => {
  const headers: Header[] = headersFor(acme, policy);
  assert.equal(header(headers, 'Content-Security-Policy'), 'frame-ancestors https: http://localhost:* http://127.0.0.1:*');
  assert.equal(
    header(headers, 'Content-Security-Policy-Report-Only'),
    'frame-ancestors https://a.acme.example https://b.acme.example http://localhost:* http://127.0.0.1:* https://localhost:*; report-uri /api/csp-report; report-to csp',
  );
  assert.equal(header(headers, 'Reporting-Endpoints'), 'csp="/api/csp-report"');
});

test('enforce: only registered origins may frame; with none registered, no page may', () => {
  assert.equal(header(headersFor(acme, enforce), 'Content-Security-Policy'), 'frame-ancestors https://a.acme.example https://b.acme.example; report-uri /api/csp-report; report-to csp');
  assert.equal(header(headersFor(acme, enforce), 'Content-Security-Policy-Report-Only'), undefined);
  assert.match(header(headersFor(registry, enforce), 'Content-Security-Policy')!, /^frame-ancestors 'none';/);
});

test('never X-Frame-Options or a same-origin opener policy', () => {
  for (const p of [policy, enforce]) {
    const keys = headersFor(acme, p).map((h: Header) => h.key.toLowerCase());
    assert.ok(!keys.includes('x-frame-options'));
    assert.ok(!keys.includes('cross-origin-opener-policy'));
  }
});

// ─── /api/csp-report ────────────────────────────────────────────────────────

test('CSP reports are logged as origins only, in both report formats', async () => {
  const lines: Record<string, unknown>[] = [];
  const log = (line: Record<string, unknown>) => lines.push(line);
  const legacy = { 'csp-report': { 'document-uri': 'https://portal.example/?action=sign&message=SECRET', 'blocked-uri': 'https://framer.example/page?x=SECRET', 'effective-directive': 'frame-ancestors', disposition: 'report' } };
  const modern = [{ type: 'csp-violation', body: { documentURL: 'https://portal.example/?message=SECRET', blockedURL: 'https://other.example/a', effectiveDirective: 'frame-ancestors', disposition: 'enforce' } }];
  for (const body of [legacy, modern]) {
    const r = await handleCspReport(new Request('https://portal.example/api/csp-report', { method: 'POST', body: JSON.stringify(body) }), { log });
    assert.equal(r.status, 204);
  }
  assert.deepEqual(lines, [
    { route: 'csp-report', directive: 'frame-ancestors', disposition: 'report', blocked: 'https://framer.example', document: 'https://portal.example' },
    { route: 'csp-report', directive: 'frame-ancestors', disposition: 'enforce', blocked: 'https://other.example', document: 'https://portal.example' },
  ]);
  assert.ok(!JSON.stringify(lines).includes('SECRET'));
});
