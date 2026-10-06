/**
 * Checks for config/portal-policy.json and config/registry.json. A file that
 * does not pass is a build and test failure, never a silently looser portal.
 */
import { addressBytes } from './address.ts';
import type { Gate, PortalPolicy } from './policy.ts';
import { isAlwaysDeniedScheme } from './redirect.ts';
import type { RegisteredApp, Registry } from './registry.ts';
import { isLoopback, webOrigin } from './requester.ts';

export class ConfigError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'ConfigError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(file: string, path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(file, `${path} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

const GATES: readonly Gate[] = ['allow', 'registered', 'deny'];

export function parsePolicy(json: unknown, file = 'portal-policy.json'): PortalPolicy {
  if (!isObj(json) || json.version !== 1) throw new ConfigError(file, 'version must be 1');
  const { gates, redirects, framing } = json;
  if (!isObj(gates) || !isObj(redirects) || !isObj(framing)) throw new ConfigError(file, 'gates, redirects and framing are required');
  const denied = redirects.deniedSchemes ?? [];
  if (!Array.isArray(denied) || !denied.every((s) => typeof s === 'string' && /^[a-z][a-z0-9+.-]*$/.test(s))) {
    throw new ConfigError(file, 'redirects.deniedSchemes must be lower-case scheme names');
  }
  if (typeof framing.allowLoopback !== 'boolean') throw new ConfigError(file, 'framing.allowLoopback must be true or false');
  return {
    version: 1,
    stage: oneOf(file, 'stage', json.stage, ['transition', 'enforce'] as const),
    gates: {
      messageWithoutText: oneOf(file, 'gates.messageWithoutText', gates.messageWithoutText, GATES),
      transaction: oneOf(file, 'gates.transaction', gates.transaction, GATES),
      approval: oneOf(file, 'gates.approval', gates.approval, GATES),
      webview: oneOf(file, 'gates.webview', gates.webview, GATES),
    },
    connectNonProofChallenge: oneOf(file, 'connectNonProofChallenge', json.connectNonProofChallenge, ['ignore', 'refuse'] as const),
    redirects: {
      unregisteredSchemes: oneOf(file, 'redirects.unregisteredSchemes', redirects.unregisteredSchemes, ['allow', 'deny'] as const),
      unregisteredWeb: oneOf(file, 'redirects.unregisteredWeb', redirects.unregisteredWeb, ['same-origin', 'deny'] as const),
      deniedSchemes: denied as string[],
    },
    framing: {
      mode: oneOf(file, 'framing.mode', framing.mode, ['report', 'enforce'] as const),
      allowLoopback: framing.allowLoopback,
    },
    contentPolicy: oneOf(file, 'contentPolicy', json.contentPolicy, ['report', 'enforce'] as const),
  };
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A plain DNS name or the IPv6 loopback: no wildcards or other pattern characters. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[::1\])$/;

/** A registered redirect prefix: "scheme://", or a URL with no query, fragment or credentials. */
function checkRedirectPrefix(file: string, id: string, prefix: unknown): string {
  if (typeof prefix !== 'string' || !prefix) throw new ConfigError(file, `${id}: redirects must be strings`);
  const schemeOnly = /^([a-z][a-z0-9+.-]*):(\/\/)?$/i.exec(prefix);
  const scheme = (schemeOnly ? schemeOnly[1] : prefix.split(':')[0]).toLowerCase();
  if (isAlwaysDeniedScheme(scheme)) throw new ConfigError(file, `${id}: ${scheme}: is never a redirect destination`);
  if (schemeOnly) {
    if (scheme === 'http' || scheme === 'https') throw new ConfigError(file, `${id}: register a web destination with its origin, not "${prefix}"`);
    return prefix;
  }
  let url: URL;
  try {
    url = new URL(prefix);
  } catch {
    throw new ConfigError(file, `${id}: "${prefix}" is not a URL`);
  }
  if (url.search || url.hash || url.username || url.password) throw new ConfigError(file, `${id}: "${prefix}" must have no query, fragment or credentials`);
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) throw new ConfigError(file, `${id}: "${prefix}" must use https`);
  if ((url.protocol === 'https:' || url.protocol === 'http:') && !HOSTNAME.test(url.hostname)) throw new ConfigError(file, `${id}: "${prefix}" must name one host`);
  return prefix;
}

export function parseRegistry(json: unknown, file = 'registry.json'): Registry {
  if (!isObj(json) || json.version !== 1 || !Array.isArray(json.apps)) throw new ConfigError(file, 'version must be 1, with an apps list');
  const ids = new Set<string>();
  const origins = new Map<string, string>();
  const payers = new Map<string, string>();
  const apps: RegisteredApp[] = json.apps.map((raw, i) => {
    if (!isObj(raw)) throw new ConfigError(file, `apps[${i}] must be an object`);
    const id = raw.id;
    if (typeof id !== 'string' || !APP_ID.test(id)) throw new ConfigError(file, `apps[${i}].id must be a lower-case slug`);
    if (ids.has(id)) throw new ConfigError(file, `${id}: duplicate id`);
    ids.add(id);
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 64) throw new ConfigError(file, `${id}: name must be 1 to 64 characters`);
    const appOrigins = raw.origins ?? [];
    if (!Array.isArray(appOrigins)) throw new ConfigError(file, `${id}: origins must be a list`);
    for (const origin of appOrigins) {
      if (typeof origin !== 'string' || webOrigin(origin) !== origin || !HOSTNAME.test(new URL(origin).hostname)) {
        throw new ConfigError(file, `${id}: "${String(origin)}" must be an exact https origin (or http on loopback), with no path`);
      }
      const owner = origins.get(origin);
      if (owner) throw new ConfigError(file, `${id}: ${origin} is already registered to ${owner}`);
      origins.set(origin, id);
    }
    const redirects = raw.redirects ?? [];
    if (!Array.isArray(redirects)) throw new ConfigError(file, `${id}: redirects must be a list`);
    redirects.forEach((r) => checkRedirectPrefix(file, id, r));
    if (raw.programChallenges !== undefined && typeof raw.programChallenges !== 'boolean') {
      throw new ConfigError(file, `${id}: programChallenges must be true or false`);
    }
    const feePayers = raw.feePayers ?? [];
    if (!Array.isArray(feePayers)) throw new ConfigError(file, `${id}: feePayers must be a list`);
    for (const key of feePayers) {
      if (typeof key !== 'string' || !addressBytes(key)) throw new ConfigError(file, `${id}: "${String(key)}" must be a base58 public key`);
      // "Paid by" names one app: a key two apps use is a shared paymaster.
      const owner = payers.get(key);
      if (owner) throw new ConfigError(file, `${id}: fee payer ${key} is already registered to ${owner}`);
      payers.set(key, id);
    }
    return {
      id,
      name: raw.name.trim(),
      origins: appOrigins as string[],
      redirects: redirects as string[],
      ...(raw.programChallenges === undefined ? {} : { programChallenges: raw.programChallenges }),
      ...(feePayers.length ? { feePayers: feePayers as string[] } : {}),
    };
  });
  return { version: 1, apps };
}
