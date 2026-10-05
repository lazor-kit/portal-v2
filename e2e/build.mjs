/**
 * Builds what the e2e run serves: the portal twice (the committed policy, and
 * the same with every gate at its enforce setting), each with a registry
 * that lists the test dApp, and the test dApp against the SDK in SDK_DIST.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { render } from '../scripts/gen-headers.mjs';
import { parsePolicy, parseRegistry } from '../src/security/config.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUT = join(ROOT, 'e2e/.out');

export const DAPP = 'http://localhost:5174';
/** The portal builds the run serves: the committed policy (transition), and every gate at enforce. */
export const PORTAL_T = 'http://localhost:4173';
export const PORTAL_E = 'http://localhost:4174';
export const REGISTRY = {
  version: 1,
  apps: [{ id: 'e2e-dapp', name: 'E2E dApp', origins: [DAPP], redirects: [`${DAPP}/callback`, 'e2eapp://'] }],
};

function enforce(policy) {
  return {
    ...policy,
    stage: 'enforce',
    gates: { ...policy.gates, transaction: 'registered', approval: 'registered' },
    redirects: { ...policy.redirects, unregisteredSchemes: 'deny', unregisteredWeb: 'deny' },
    framing: { ...policy.framing, mode: 'enforce' },
    contentPolicy: 'enforce',
  };
}

async function buildPortal(name, policy) {
  const dir = join(OUT, `config-${name}`);
  mkdirSync(dir, { recursive: true });
  const registry = parseRegistry(REGISTRY);
  const checked = parsePolicy(policy);
  writeFileSync(join(dir, 'portal-policy.json'), JSON.stringify(checked, null, 2));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry, null, 2));
  writeFileSync(join(dir, 'vercel.json'), render(registry, checked));
  await build({
    configFile: join(ROOT, 'vite.config.ts'),
    root: ROOT,
    logLevel: 'warn',
    build: { outDir: join(OUT, `portal-${name}`), emptyOutDir: true },
    resolve: {
      alias: [
        { find: /^\.\.\/config\/portal-policy\.json$/, replacement: join(dir, 'portal-policy.json') },
        { find: /^\.\.\/config\/registry\.json$/, replacement: join(dir, 'registry.json') },
      ],
    },
  });
  return { dist: join(OUT, `portal-${name}`), vercelJson: join(dir, 'vercel.json') };
}

/** The @lazorkit/wallet build to test against: SDK_DIST, or the one installed here. */
export function sdkEntry() {
  const dir = process.env.SDK_DIST ?? join(ROOT, 'node_modules/@lazorkit/wallet');
  const entry = join(dir, 'dist/index.mjs');
  if (!existsSync(entry)) throw new Error(`No @lazorkit/wallet build at ${entry}. Set SDK_DIST to a built packages/react.`);
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  return { entry, version };
}

export async function buildAll() {
  const policy = JSON.parse(readFileSync(join(ROOT, 'config/portal-policy.json'), 'utf8'));
  const transition = await buildPortal('transition', policy);
  const enforced = await buildPortal('enforce', enforce(policy));
  const sdk = sdkEntry();
  await build({
    configFile: false,
    root: join(ROOT, 'e2e/dapp'),
    logLevel: 'warn',
    build: { outDir: join(OUT, 'dapp'), emptyOutDir: true, minify: false },
    resolve: { alias: { '@lazorkit/wallet': sdk.entry } },
    // The only portals the dApp will frame (`?portal=` picks one of them).
    define: { global: 'globalThis', __E2E_PORTALS__: JSON.stringify([PORTAL_T, PORTAL_E]) },
  });
  return { transition, enforced, dapp: join(OUT, 'dapp'), sdkVersion: sdk.version };
}
