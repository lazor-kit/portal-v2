/**
 * Per-kind constants of the typed approval requests (v1), from the program
 * (lazorkit-protocol `program/src/processor`, `program/src/auth/secp256r1`).
 */

export const APPROVAL_VERSION = 1;

export type ApprovalKind = 'createSession' | 'revokeSession' | 'removeAuthority';
export const APPROVAL_KINDS: readonly ApprovalKind[] = ['createSession', 'revokeSession', 'removeAuthority'];

export type ApprovalCluster = 'devnet' | 'mainnet';
export const APPROVAL_CLUSTERS: readonly ApprovalCluster[] = ['devnet', 'mainnet'];

/** Instruction discriminator: the first byte the challenge hashes. */
export const DISCRIMINATOR: Readonly<Record<ApprovalKind, number>> = {
  createSession: 5,
  revokeSession: 9,
  removeAuthority: 2,
};

/** Index of the Instructions sysvar in each instruction's account list. */
export const SYSVAR_IX_INDEX: Readonly<Record<ApprovalKind, number>> = {
  createSession: 6,
  revokeSession: 5,
  removeAuthority: 5,
};

/** The auth payload's reserved byte: hashed, not checked; every SDK writes 0x80. */
export const RESERVED_BYTE = 0x80;

/** The longest a session may live (`MAX_SESSION_SECONDS`). */
export const MAX_SESSION_SECONDS = 30n * 24n * 60n * 60n;

/** `expires_at` is written as an i64 by the SDK; the codec refuses anything at or above 2^63. */
export const MAX_EXPIRES_AT = (1n << 63n) - 1n;

/** The program's cap on an actions buffer (`MAX_ACTIONS_BUFFER_SIZE`). */
export const MAX_ACTIONS_BUFFER = 2048;

/** A credential id is at most 1023 bytes (WebAuthn). */
export const MAX_CREDENTIAL_ID = 1023;

/** The encoded fragment value, and the whole URL, at most. */
export const MAX_FRAGMENT_CHARS = 8192;
export const MAX_URL_CHARS = 16384;

/** The fragment parameter that carries a v1 request: `#/?lk1=<base64url(JSON)>`. */
export const FRAGMENT_PARAM = 'lk1';
export const FRAGMENT_PREFIX = `#/?${FRAGMENT_PARAM}=`;

export const SEEDS = {
  wallet: 'lk2:wallet',
  vault: 'lk2:vault',
  authority: 'lk2:authority',
  session: 'lk2:session',
} as const;
