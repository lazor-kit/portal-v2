// What the approval screens say about who is asking, what a refusal tells
// the user, and that the colours read in both themes. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostParts, originHost } from '../src/security/domain.ts';
import { badgeExplainer, whoIsAsking } from '../src/security/identity.ts';
import { refusalScreen, SIGNED_NOTHING } from '../src/security/refusal-screen.ts';
import { REFUSAL_TEXT } from '../src/security/refusal-text.ts';

test('the registered name of a host is set apart, by the Public Suffix List (private domains too)', () => {
  const split = (host: string) => {
    const p = hostParts(host);
    return `${p.before}[${p.registrable}]${p.after}`;
  };
  assert.equal(split('www.fernway.example'), 'www.[fernway].example');
  assert.equal(split('swap.tinydex.fun'), 'swap.[tinydex].fun');
  assert.equal(split('app.acme.co.uk'), 'app.[acme].co.uk');
  // A shared host's name is never the part set apart.
  assert.equal(split('fernway.github.io'), '[fernway].github.io');
  assert.equal(split('login.fernway.vercel.app'), 'login.[fernway].vercel.app');
  assert.equal(split('localhost:5174'), '[localhost]:5174');
  assert.equal(split('127.0.0.1:5175'), '[127.0.0.1]:5175');
  assert.equal(split('github.io'), '[github.io]');
  assert.equal(split('xn--80ak6aa92e.com'), '[xn--80ak6aa92e].com');
  assert.equal(originHost('https://www.fernway.example'), 'www.fernway.example');
  assert.equal(originHost('fernway://cb'), null);
});

test('who is asking: the registered name is a verified site; any other origin is its host, not verified', () => {
  const verified = whoIsAsking({ channel: 'iframe', label: 'https://www.fernway.example', appName: 'Fernway' });
  assert.deepEqual([verified.kind, verified.title, verified.name, verified.verified, verified.host], ['site', 'Fernway', 'Fernway', true, 'www.fernway.example']);
  assert.equal(
    badgeExplainer(verified),
    "Verified site means the request came from www.fernway.example, a website Fernway registered with LazorKit. It doesn't mean LazorKit vouches for Fernway.",
  );
  const unverified = whoIsAsking({ channel: 'popup', label: 'https://swap.tinydex.fun' });
  assert.deepEqual([unverified.title, unverified.name, unverified.verified], ['swap.tinydex.fun', 'swap.tinydex.fun', false]);
  assert.match(badgeExplainer(unverified), /^LazorKit hasn't verified who runs this site\./);
  const local = whoIsAsking({ channel: 'iframe', label: 'http://localhost:5174' });
  assert.equal(local.insecure, true);
});

test('who is asking: an app scheme is never verified, registered or not; a registered https destination is a site', () => {
  const app = whoIsAsking({ channel: 'redirect', label: 'fernway://callback', appName: 'Fernway' });
  assert.deepEqual([app.kind, app.title, app.name, app.verified, app.returnsTo], ['app', 'An app on this phone', 'the app', false, 'fernway://callback']);
  assert.match(badgeExplainer(app), /a link Fernway registered\. LazorKit can't confirm which app receives it\./);
  const web = whoIsAsking({ channel: 'redirect', label: 'https://www.fernway.example', appName: 'Fernway' });
  assert.deepEqual([web.kind, web.verified, web.host], ['site', true, 'www.fernway.example']);
  assert.equal(whoIsAsking({ channel: 'iframe', label: null }).kind, 'unknown');
  assert.equal(whoIsAsking({ channel: 'webview', label: 'In-app browser' }).verified, false);
});

test('every refusal says, in plain words, that the passkey signed nothing; the reason code stays for experts', () => {
  const reasons = [...Object.keys(REFUSAL_TEXT), 'something-new'];
  for (const reason of reasons) {
    const screen = refusalScreen(reason, 'Fernway');
    assert.ok(screen.sentence.endsWith(SIGNED_NOTHING), `${reason}: ${screen.sentence}`);
    assert.ok(screen.hero.length > 0 && screen.hero.split(' ').length <= 7, `${reason}: hero "${screen.hero}"`);
    assert.deepEqual(screen.experts[0], { label: 'Reason', value: reason });
    assert.ok(!/[‘’]/.test(JSON.stringify(screen)), 'straight apostrophes');
  }
  assert.equal(refusalScreen('display-text-mismatch', 'Fernway').kind, 'mismatch');
  assert.equal(refusalScreen('unrecognised-format', 'Fernway').kind, 'unreadable');
  assert.equal(refusalScreen('credential-missing', 'Fernway').details[0].value, "The request doesn't say which passkey should sign it.");
  assert.equal(refusalScreen('requires-registered-app', 'swap.tinydex.fun').hero, "swap.tinydex.fun can't ask for this");
  // When the portal can't tell who asked, the header doesn't name anyone.
  assert.equal(refusalScreen('requester-unknown', 'the app').showRequester, false);
  assert.equal(refusalScreen('requester-conflict', 'the app').showRequester, false);
  assert.equal(refusalScreen('kind-denied', 'Fernway').showRequester, true);
});

// ─── Colours ────────────────────────────────────────────────────────────────

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

/** The `--name: #hex` tokens of the first `:root` block after `marker`. */
function tokens(marker: string): Record<string, string> {
  const from = css.indexOf(marker);
  const block = css.slice(css.indexOf('{', css.indexOf(':root', from)) + 1, css.indexOf('}', css.indexOf(':root', from)));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('colours: text at least 4.5:1, outlines and identicons at least 3:1, in light and dark', () => {
  const light = tokens(':root {');
  const dark = { ...light, ...tokens('@media (prefers-color-scheme: dark)') };
  assert.notEqual(light.surface, dark.surface, 'the dark block was read');
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    const pairs: [string, string, number][] = [
      ['ink', 'surface', 4.5],
      ['ink', 'ground', 4.5],
      ['ink-2', 'surface', 4.5],
      ['ink-2', 'ground', 4.5],
      ['on-accent', 'accent', 4.5],
      ['info-ink', 'info-bg', 4.5],
      ['caution-ink', 'caution-bg', 4.5],
      ['danger-ink', 'danger-bg', 4.5],
      ['danger-text', 'surface', 4.5],
      ['accent', 'surface', 3],
      ['caution-line', 'surface', 3],
      ['test', 'surface', 3],
    ];
    for (let i = 0; i < 8; i++) pairs.push([`id-${i}`, 'surface', 3], [`id-${i}`, 'ground', 3]);
    for (const [fg, bg, min] of pairs) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= min, `${name}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, under ${min}:1`);
    }
  }
  // Risk tiers differ in lightness, not hue alone.
  assert.ok(Math.abs(luminance(light['caution-bg']) - luminance(light['danger-bg'])) > 0.3);
  assert.ok(Math.abs(luminance(dark['caution-bg']) - luminance(dark['danger-bg'])) > 0.1);
});
