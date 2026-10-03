import { Buffer } from 'buffer';
import { secp256r1 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import type { AssertionFields } from '@/security/reply';

const CEREMONY_TIMEOUT_MS = 60_000;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const toBase64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');

/** The compressed P-256 key (33 bytes, base64) from a registration's SPKI. */
function compressedPublicKey(spki: ArrayBuffer): string {
  const uncompressed = new Uint8Array(spki).slice(-65);
  if (uncompressed[0] !== 0x04) throw new Error('The passkey did not return a P-256 public key.');
  return toBase64(secp256r1.ProjectivePoint.fromHex(uncompressed).toRawBytes(true));
}

/** The fields the SDKs read from an assertion. */
function assertionFields(response: AuthenticatorAssertionResponse): AssertionFields {
  const authenticatorData = new Uint8Array(response.authenticatorData);
  const clientDataJSON = new Uint8Array(response.clientDataJSON);
  const signature = secp256r1.Signature.fromDER(new Uint8Array(response.signature)).normalizeS();
  const msg = new Uint8Array(authenticatorData.length + 32);
  msg.set(authenticatorData, 0);
  msg.set(sha256(clientDataJSON), authenticatorData.length);
  return {
    normalized: toBase64(signature.toCompactRawBytes()),
    msg: toBase64(msg),
    clientDataJSONReturn: toBase64(clientDataJSON),
    authenticatorDataReturn: toBase64(authenticatorData),
  };
}

/**
 * Sign `challenge` with the passkey `credentialId` names, and no other. The
 * challenge is the classified request bytes, never a URL parameter.
 */
export async function signChallenge(challenge: Uint8Array, credentialId: Uint8Array): Promise<{ credentialId: string; assertion: AssertionFields }> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: CEREMONY_TIMEOUT_MS,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey answered.');
  return { credentialId: toBase64(credential.rawId), assertion: assertionFields(credential.response as AuthenticatorAssertionResponse) };
}

/**
 * Sign in with any passkey for this portal. With an ownership-proof
 * challenge, the assertion over it is returned; without one, a random
 * challenge is used and only the credential is.
 */
export async function signIn(proof: Uint8Array | null): Promise<{ credentialId: string; assertion?: AssertionFields }> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: proof ?? randomBytes(32),
      userVerification: 'required',
      timeout: CEREMONY_TIMEOUT_MS,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey answered.');
  const credentialId = toBase64(credential.rawId);
  if (!proof) return { credentialId };
  return { credentialId, assertion: assertionFields(credential.response as AuthenticatorAssertionResponse) };
}

/** Register a new passkey named `name`; its public key comes from the registration itself. */
export async function createPasskey(name: string): Promise<{ credentialId: string; publicKey: string }> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Lazor Kit Portal', id: window.location.hostname },
      user: { id: randomBytes(32), name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
      timeout: CEREMONY_TIMEOUT_MS,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was created.');
  const spki = (credential.response as AuthenticatorAttestationResponse).getPublicKey();
  if (!spki) throw new Error('The passkey did not return a public key.');
  return { credentialId: toBase64(credential.rawId), publicKey: compressedPublicKey(spki) };
}

/** A WebAuthn failure in words a person can act on. */
export function ceremonyErrorText(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This passkey already exists on this device.';
  if (name === 'SecurityError') return 'Passkeys are not available on this page.';
  return error instanceof Error && error.message ? error.message : 'The passkey request failed.';
}
