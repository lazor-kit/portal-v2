// The portal's challenge recipe (src/approval) against the SDK's own
// prepareCreateSession / prepareRevokeSession / prepareRemoveAuthority
// (@lazorkit/sdk-legacy, a dev dependency), on 1,000 random requests: any
// skew between the portal's copy and the SDK the apps run fails here.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import sdk from '@lazorkit/sdk-legacy';
import { approvalChallenge, base64urlEncode, decodeApprovalRequest, type ApprovalRequest } from '../src/approval/index.ts';

const { Actions, LazorKitClient, PROGRAM_ID_DEVNET, serializeActions } = sdk;
const PROGRAM = PROGRAM_ID_DEVNET.toBase58();

/** A connection that answers the one read prepareX makes: the authority's counter. */
function stubConnection(counter: number) {
  const data = new Uint8Array(145);
  data[0] = 0x22;
  data[1] = 1;
  new DataView(data.buffer).setUint32(8, counter, true);
  return {
    commitment: 'confirmed',
    rpcEndpoint: 'http://stub.invalid',
    getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: { data, owner: PROGRAM_ID_DEVNET, lamports: 1, executable: false } }),
  };
}

const key = () => Keypair.generate().publicKey;
const u64 = () => (BigInt(randomInt(0, 2 ** 32)) << 32n) | BigInt(randomInt(0, 2 ** 32));

/** Random actions, valid by construction, from the SDK's own builders. */
function randomActions(): unknown[] {
  const out: unknown[] = [];
  const n = randomInt(0, 9);
  const exp = () => (randomInt(0, 3) === 0 ? BigInt(1_700_000_000 + randomInt(0, 10_000_000)) : undefined);
  const mints = Array.from({ length: 4 }, key);
  const used = new Set<string>();
  const once = (tag: string) => (used.has(tag) ? false : (used.add(tag), true));
  const list = randomInt(0, 2) === 0 ? 'white' : 'black';
  for (let i = 0; i < n; i++) {
    const mint = mints[randomInt(0, mints.length)];
    switch (randomInt(0, 8)) {
      case 0:
        if (once('solLimit')) out.push(Actions.solLimit(u64(), exp()));
        break;
      case 1:
        if (once('solRec')) out.push(Actions.solRecurringLimit({ limit: u64(), window: BigInt(randomInt(1, 10_000_000)), expiresAt: exp() }));
        break;
      case 2:
        if (once('solMax')) out.push(Actions.solMaxPerTx(u64(), exp()));
        break;
      case 3:
        if (once(`tl${mint}`)) out.push(Actions.tokenLimit({ mint, remaining: u64(), expiresAt: exp() }));
        break;
      case 4:
        if (once(`tr${mint}`)) out.push(Actions.tokenRecurringLimit({ mint, limit: u64(), window: BigInt(randomInt(1, 10_000_000)), expiresAt: exp() }));
        break;
      case 5:
        if (once(`tm${mint}`)) out.push(Actions.tokenMaxPerTx({ mint, max: u64(), expiresAt: exp() }));
        break;
      default:
        out.push(list === 'white' ? Actions.programWhitelist(key()) : Actions.programBlacklist(key()));
    }
  }
  return out;
}

const encode = (json: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(json)));

test('1,000 random requests: the portal recomputes exactly the challenge sdk-legacy prepares', async () => {
  for (let i = 0; i < 1000; i++) {
    const kind = (['createSession', 'revokeSession', 'removeAuthority'] as const)[i % 3];
    const stored = [0, 1, 0xfffffffd][i % 7] ?? randomInt(0, 2 ** 31);
    const client = new LazorKitClient(stubConnection(stored) as never, PROGRAM_ID_DEVNET);
    const wallet = key();
    const payer = key();
    const credentialId = randomBytes(randomInt(16, 200));
    const credentialIdHash = createHash('sha256').update(credentialId).digest();
    const slot = i % 11 === 0 ? (1n << 64n) - 1n : u64();
    const secp256r1 = { credentialIdHash: new Uint8Array(credentialIdHash), publicKeyBytes: new Uint8Array(33).fill(2), slotOverride: slot };
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('lk2:authority'), wallet.toBuffer(), credentialIdHash], PROGRAM_ID_DEVNET);
    let challenge: Uint8Array;
    let args: Record<string, string>;
    if (kind === 'createSession') {
      const sessionKey = key();
      const expiresAt = BigInt(randomInt(1_700_000_000, 2_000_000_000));
      const actions = randomActions();
      const prepared = await client.prepareCreateSession({ payer, walletPda: wallet, secp256r1, sessionKey, expiresAt, actions: actions as never, unrestricted: actions.length === 0 });
      challenge = prepared.challenge;
      args = { sessionKey: sessionKey.toBase58(), expiresAt: expiresAt.toString(), actions: base64urlEncode(actions.length ? serializeActions(actions as never) : new Uint8Array(0)) };
    } else if (kind === 'revokeSession') {
      const session = key();
      const refund = i % 2 ? payer : key();
      challenge = (await client.prepareRevokeSession({ payer, walletPda: wallet, secp256r1, sessionPda: session, refundDestination: refund })).challenge;
      args = { session: session.toBase58(), refund: refund.toBase58() };
    } else {
      const target = key();
      const refund = i % 2 ? payer : key();
      challenge = (await client.prepareRemoveAuthority({ payer, walletPda: wallet, secp256r1, targetAuthorityPda: target, refundDestination: refund })).challenge;
      args = { target: target.toBase58(), refund: refund.toBase58() };
    }
    const decoded = decodeApprovalRequest(
      encode({
        v: 1,
        kind,
        cluster: 'devnet',
        programId: PROGRAM,
        wallet: wallet.toBase58(),
        authority: authority.toBase58(),
        credentialId: base64urlEncode(credentialId),
        payer: payer.toBase58(),
        counter: stored + 1,
        preparedSlot: slot.toString(),
        args,
      }),
    );
    assert.ok(decoded.ok, `case ${i}: ${!decoded.ok && decoded.reason}`);
    const request: ApprovalRequest = decoded.request;
    assert.equal(
      Buffer.from(approvalChallenge(request, { slot, counter: stored + 1 })).toString('hex'),
      Buffer.from(challenge).toString('hex'),
      `case ${i} (${kind})`,
    );
  }
});
