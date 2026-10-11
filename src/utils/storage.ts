/**
 * What the portal remembers about passkeys made here, keyed by credential id.
 * Only the registration reveals a passkey's public key, so it is kept for
 * that credential and reported for it alone. Browsers partition this storage
 * by the embedding site, so an entry may be missing; nothing depends on one
 * being there.
 */

export interface StoredCredential {
  /** Compressed P-256 key, base64. */
  readonly publicKey?: string;
  /** The name given when the passkey was created. */
  readonly name?: string;
  readonly createdAt?: number;
}

const KEY = 'lazorkit-portal:credentials';
const LEGACY = { id: 'CREDENTIAL_ID', publicKey: 'PUBLIC_KEY', name: 'ACCOUNT_NAME', status: 'WALLET_STATUS' };

type Store = Record<string, StoredCredential>;

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable (blocked, full): nothing is remembered.
  }
}

/** Moves the single credential kept by earlier versions into the map, once. */
function migrate(): void {
  try {
    const id = localStorage.getItem(LEGACY.id);
    const publicKey = localStorage.getItem(LEGACY.publicKey);
    if (id && publicKey) {
      const store = read();
      store[id] ??= { publicKey, name: localStorage.getItem(LEGACY.name) ?? undefined };
      write(store);
    }
    for (const key of Object.values(LEGACY)) localStorage.removeItem(key);
  } catch {
    // Nothing to migrate.
  }
}

export function storedCredential(credentialId: string): StoredCredential | undefined {
  migrate();
  return Object.prototype.hasOwnProperty.call(read(), credentialId) ? read()[credentialId] : undefined;
}

export function rememberCredential(credentialId: string, entry: StoredCredential): void {
  const store = read();
  store[credentialId] = { ...store[credentialId], ...entry };
  write(store);
}

const APPROVED_BEFORE = 'lazorkit-portal:approved-before';

/**
 * Whether a passkey approval finished on this browser before (per app inside
 * an app's page, where storage is partitioned). Unknown counts as no, so the
 * longer passkey note shows rather than goes missing.
 */
export function approvedBefore(): boolean {
  try {
    return localStorage.getItem(APPROVED_BEFORE) === '1';
  } catch {
    return false;
  }
}

export function rememberApproval(): void {
  try {
    localStorage.setItem(APPROVED_BEFORE, '1');
  } catch {
    // Storage unavailable: the longer note shows again next time.
  }
}
