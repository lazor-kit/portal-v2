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

const SPACE = new Set(['\t', '\n', '\f', '\r', ' ']);
/** Elements whose content is text, not markup (RCDATA and RAWTEXT; noscript as a page with scripting reads it). */
const TEXT_ONLY = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

/**
 * The text of each inline script of an HTML page: what the browser hashes
 * for `script-src`.
 *
 * Read by the HTML tokenizer's own rules for everything that decides where a
 * script starts and ends: tag and attribute names in any case; attribute
 * values in any quoting (a `>` inside quotes does not end a tag); an end tag
 * as `</script` then whitespace, `/` or `>`, then anything up to `>`;
 * comments, doctypes and other declarations; the text-only elements (title,
 * textarea, style, …), whose `<script>` is text; and the input stream's
 * newline normalisation (CR LF and CR become LF). A script with a `src`
 * attribute, in any case or quoting, is external, and its body is not run.
 *
 * Where the tokenizer would need state this reader does not keep, it throws
 * rather than guess: a script body containing `<!--` (the escaped states,
 * which can move where the script ends), a script inside SVG or MathML, a
 * comment that closes early (`<!-->`, `--!>`), a NUL, or a tag, attribute
 * value, comment or element left open.
 */
export function inlineScripts(html) {
  const text = html.replace(/\r\n?/g, '\n');
  // ASCII-only lower case, so offsets in `lower` are offsets in `text`.
  const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const fail = (what, at) => {
    throw new Error(`HTML not read for the content policy: ${what} at offset ${at}.`);
  };
  if (text.includes('\0')) fail('a NUL character', text.indexOf('\0'));

  /** The tag whose name starts at `at`: lower-case name, attribute names, whether it ends `/>`, and the offset after it. */
  const readTag = (at) => {
    let i = at;
    while (i < text.length && !SPACE.has(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
    const name = lower.slice(at, i);
    const attributes = new Set();
    for (;;) {
      while (SPACE.has(text[i])) i++;
      if (i >= text.length) fail(`an unterminated <${name}> tag`, at);
      if (text[i] === '>') return { name, attributes, selfClosing: false, end: i + 1 };
      if (text[i] === '/') {
        if (text[i + 1] === '>') return { name, attributes, selfClosing: true, end: i + 2 };
        i++;
        continue;
      }
      // An attribute: its name (whose first character may be `=`), then an optional value.
      const nameAt = i++;
      while (i < text.length && !SPACE.has(text[i]) && text[i] !== '/' && text[i] !== '>' && text[i] !== '=') i++;
      attributes.add(lower.slice(nameAt, i));
      while (SPACE.has(text[i])) i++;
      if (text[i] !== '=') continue;
      i++;
      while (SPACE.has(text[i])) i++;
      if (text[i] === '"' || text[i] === "'") {
        const close = text.indexOf(text[i], i + 1);
        if (close === -1) fail(`an unterminated attribute value in <${name}>`, i);
        i = close + 1;
      } else {
        while (i < text.length && !SPACE.has(text[i]) && text[i] !== '>') i++;
      }
    }
  };

  /** The end tag that closes a script or text-only element `name` whose content starts at `from`. */
  const closeOf = (name, from) => {
    for (let i = lower.indexOf(`</${name}`, from); i !== -1; i = lower.indexOf(`</${name}`, i + 1)) {
      const next = text[i + 2 + name.length];
      if (next === undefined || SPACE.has(next) || next === '/' || next === '>') return { start: i, end: readTag(i + 2).end };
    }
    return fail(`an unterminated <${name}> element`, from);
  };

  const scripts = [];
  let foreign = 0;
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i)) {
    if (lower.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1 || /^-?>/.test(text.slice(i + 4, i + 6)) || text.slice(i + 4, end).includes('--!>')) {
        fail('an unterminated comment, or one that closes early', i);
      }
      i = end + 3;
      continue;
    }
    const closing = text[i + 1] === '/';
    const nameAt = i + (closing ? 2 : 1);
    const startsName = /[a-z]/.test(lower[nameAt] ?? '');
    if (text[i + 1] === '!' || text[i + 1] === '?' || (closing && !startsName && nameAt < text.length)) {
      // A doctype or another declaration, up to the first `>` (as the tokenizer reads it, even inside quotes).
      const end = text.indexOf('>', i + 2);
      if (end === -1) fail('an unterminated declaration', i);
      i = end + 1;
      continue;
    }
    if (!startsName) {
      i += 1; // a `<` in text
      continue;
    }
    const tag = readTag(nameAt);
    if (tag.name === 'svg' || tag.name === 'math') {
      if (closing) foreign = Math.max(0, foreign - 1);
      else if (!tag.selfClosing) foreign += 1;
      i = tag.end;
    } else if (closing) {
      i = tag.end;
    } else if (tag.name === 'script') {
      if (foreign) fail('a script inside SVG or MathML', i);
      const close = closeOf('script', tag.end);
      const body = text.slice(tag.end, close.start);
      if (body.includes('<!--')) fail('a script containing "<!--"', tag.end);
      if (!tag.attributes.has('src')) scripts.push(body);
      i = close.end;
    } else if (tag.name === 'plaintext' && !foreign) {
      break; // the rest of the page is text
    } else if (TEXT_ONLY.has(tag.name) && !foreign) {
      i = closeOf(tag.name, tag.end).end;
    } else {
      i = tag.end;
    }
  }
  return scripts;
}

/** The CSP sources (`'sha256-…'`) for the inline scripts of an HTML page. */
export function inlineScriptHashes(html) {
  return inlineScripts(html).map((script) => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`);
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
