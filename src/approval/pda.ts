/**
 * Program-derived addresses, as Solana derives them: the first bump from 255
 * down whose hash is not a point on ed25519. Seeds follow
 * lazorkit-protocol `program/src/seeds.rs`.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { addressBytes, base58Encode, concatBytes, utf8 } from './bytes.ts';
import { SEEDS } from './constants.ts';

const PDA_MARKER = utf8('ProgramDerivedAddress');

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** `[address, bump]` for `seeds` under `programId` (base58). */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): [string, number] {
  const program = addressBytes(programId);
  if (!program) throw new Error('programId is not an address');
  for (const seed of seeds) if (seed.length > 32) throw new Error('seed longer than 32 bytes');
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concatBytes([...seeds, Uint8Array.of(bump), program, PDA_MARKER]));
    if (!onCurve(hash)) return [base58Encode(hash), bump];
  }
  throw new Error('no program address');
}

function key(address: string): Uint8Array {
  const bytes = addressBytes(address);
  if (!bytes) throw new Error(`not an address: ${address}`);
  return bytes;
}

/** The authority PDA of a passkey: `["lk2:authority", wallet, sha256(credentialId)]`. */
export function passkeyAuthorityAddress(programId: string, wallet: string, credentialId: Uint8Array): string {
  return findProgramAddress([utf8(SEEDS.authority), key(wallet), sha256(credentialId)], programId)[0];
}

/** The authority PDA of an Ed25519 key: `["lk2:authority", wallet, publicKey]`. */
export function ed25519AuthorityAddress(programId: string, wallet: string, publicKey: string): string {
  return findProgramAddress([utf8(SEEDS.authority), key(wallet), key(publicKey)], programId)[0];
}

/** The session PDA: `["lk2:session", wallet, sessionKey]`. */
export function sessionAddress(programId: string, wallet: string, sessionKey: string): string {
  return findProgramAddress([utf8(SEEDS.session), key(wallet), key(sessionKey)], programId)[0];
}

/** The vault PDA: `["lk2:vault", wallet]`. */
export function vaultAddressOf(programId: string, wallet: string): string {
  return findProgramAddress([utf8(SEEDS.vault), key(wallet)], programId)[0];
}
