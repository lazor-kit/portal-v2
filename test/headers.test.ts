// Framing and content headers come from the registry, the policy and
// index.html, and vercel.json is in sync with them; the report route keeps
// origins only. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { contentDirectives, headersFor, inlineScriptHashes, render } from '../scripts/gen-headers.mjs';
import { parsePolicy, parseRegistry } from '../src/security/config.ts';
import type { PortalPolicy } from '../src/security/policy.ts';
import { handleCspReport } from '../api/csp-report.ts';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const policy = parsePolicy(read('config/portal-policy.json'));
const registry = parseRegistry(read('config/registry.json'));
const acme = parseRegistry({ version: 1, apps: [{ id: 'acme', name: 'Acme', origins: ['https://b.acme.example', 'https://a.acme.example'] }] });
const enforce: PortalPolicy = { ...policy, stage: 'enforce', framing: { mode: 'enforce', allowLoopback: false }, contentPolicy: 'enforce' };
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const hashes = inlineScriptHashes(indexHtml);
const content = contentDirectives(hashes).join('; ');
const reporting = 'report-uri /api/csp-report; report-to csp';
type Header = { key: string; value: string };
const header = (headers: Header[], key: string) => headers.find((h) => h.key === key)?.value;

test('vercel.json matches config/ (run `pnpm headers` after changing either)', () => {
  assert.equal(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'), render(registry, policy));
});

test('transition: any https page (and loopback) may frame; others than registered, and content outside the policy, are reported', () => {
  const headers: Header[] = headersFor(acme, policy);
  assert.equal(header(headers, 'Content-Security-Policy'), 'frame-ancestors https: http://localhost:* http://127.0.0.1:*');
  assert.equal(
    header(headers, 'Content-Security-Policy-Report-Only'),
    `frame-ancestors https://a.acme.example https://b.acme.example http://localhost:* http://127.0.0.1:* https://localhost:*; ${content}; ${reporting}`,
  );
  assert.equal(header(headers, 'Reporting-Endpoints'), 'csp="/api/csp-report"');
});

test('enforce: only registered origins may frame, and the content policy is enforced; with none registered, no page may frame', () => {
  assert.equal(header(headersFor(acme, enforce), 'Content-Security-Policy'), `frame-ancestors https://a.acme.example https://b.acme.example; ${content}; ${reporting}`);
  assert.equal(header(headersFor(acme, enforce), 'Content-Security-Policy-Report-Only'), undefined);
  assert.match(header(headersFor(registry, enforce), 'Content-Security-Policy')!, /^frame-ancestors 'none'; default-src 'self';/);
  // Each half can move on its own.
  const contentFirst: PortalPolicy = { ...policy, contentPolicy: 'enforce' };
  assert.equal(header(headersFor(acme, contentFirst), 'Content-Security-Policy'), `frame-ancestors https: http://localhost:* http://127.0.0.1:*; ${content}; ${reporting}`);
  assert.equal(header(headersFor(acme, contentFirst), 'Content-Security-Policy-Report-Only'), `frame-ancestors https://a.acme.example https://b.acme.example http://localhost:* http://127.0.0.1:* https://localhost:*; ${reporting}`);
});

test('content policy: own origin only, the inline recorder by hash, no plugins, <base> or form posts', () => {
  assert.deepEqual(contentDirectives(['sha']), [
    "default-src 'self'",
    "script-src 'self' sha",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://api.coingecko.com",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]);
  // The one inline script, hashed as the browser hashes it.
  const inline = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)![1];
  assert.deepEqual(hashes, [`'sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}'`]);
  assert.deepEqual(inlineScriptHashes('<script type="module" src="/x.js"></script><script>a()</script>'), [`'sha256-${createHash('sha256').update('a()').digest('base64')}'`]);
  // Nothing in the page comes from another origin.
  for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^(https?:)?\/\//.test(match[1]), `third-party resource ${match[1]}`);
  }
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
