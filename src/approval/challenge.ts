/**
 * The passkey challenge the program verifies (lazorkit-protocol
 * `program/src/auth/secp256r1/mod.rs`):
 *
 *   SHA256( discriminator(1)
 *         || slot_le8 || counter_le4 || sysvarIxIdx(1) || reserved(1)
 *         || signed_payload
 *         || payer(32) || wallet(32) || counter_le4 || program_id(32) )
 *
 * signed_payload per kind:
 *   createSession    session_key(32) || expires_at_le8 || actions_len_le2 || actions || payer(32)
 *   revokeSession    session(32) || refund(32)
 *   removeAuthority  target(32) || refund(32)
 */
import { sha256 } from '@noble/hashes/sha256';
import { addressBytes, concatBytes, u16le, u32le, u64le } from './bytes.ts';
import { DISCRIMINATOR, RESERVED_BYTE, SYSVAR_IX_INDEX } from './constants.ts';
import type { ApprovalRequest } from './envelope.ts';

export interface ChallengeBinding {
  readonly slot: bigint;
  readonly counter: number;
}

function key(address: string): Uint8Array {
  const bytes = addressBytes(address);
  if (!bytes) throw new Error(`not an address: ${address}`);
  return bytes;
}

/** The bytes the instruction contributes to the challenge for `req`. */
export function signedPayloadOf(req: ApprovalRequest): Uint8Array {
  switch (req.kind) {
    case 'createSession':
      return concatBytes([key(req.args.sessionKey), u64le(req.args.expiresAt), u16le(req.args.actions.length), req.args.actions, key(req.payer)]);
    case 'revokeSession':
      return concatBytes([key(req.args.session), key(req.args.refund)]);
    case 'removeAuthority':
      return concatBytes([key(req.args.target), key(req.args.refund)]);
  }
}

/** The challenge a passkey signs to approve `req` at `slot` with `counter`. */
export function approvalChallenge(req: ApprovalRequest, { slot, counter }: ChallengeBinding): Uint8Array {
  const counterBytes = u32le(counter);
  return sha256(
    concatBytes([
      Uint8Array.of(DISCRIMINATOR[req.kind]),
      u64le(slot),
      counterBytes,
      Uint8Array.of(SYSVAR_IX_INDEX[req.kind], RESERVED_BYTE),
      signedPayloadOf(req),
      key(req.payer),
      key(req.wallet),
      counterBytes,
      key(req.programId),
    ]),
  );
}

/** The challenge the SDK prepared, from the envelope's own `preparedSlot` and `counter`. */
export function preparedChallenge(req: ApprovalRequest): Uint8Array {
  return approvalChallenge(req, { slot: req.preparedSlot, counter: req.counter });
}
