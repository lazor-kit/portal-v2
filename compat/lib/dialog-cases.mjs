/**
 * The portal's replies through a released DialogManager (2.x, 3.x): what
 * connect, a transaction, an approval and a message request come back as.
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PORTAL, RP_ID, closePage } from './page.mjs';
import { passkey, servePortal } from './portal.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest();

function preview() {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1_000 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

/** The SDK's sign result is a valid passkey signature over `challenge` on the portal. */
function checkSignature(key, result, challenge) {
  const clientData = JSON.parse(Buffer.from(result.clientDataJsonBase64, 'base64').toString('utf8'));
  assert.equal(clientData.challenge, Buffer.from(challenge).toString('base64url'));
  assert.equal(clientData.origin, PORTAL);
  const authenticatorData = Buffer.from(result.authenticatorDataBase64, 'base64');
  assert.deepEqual(authenticatorData.subarray(0, 32), sha256(RP_ID));
  const signed = Buffer.concat([authenticatorData, sha256(Buffer.from(result.clientDataJsonBase64, 'base64'))]);
  assert.deepEqual(Buffer.from(result.signedPayload, 'base64'), signed);
  assert.ok(verify('sha256', signed, { key: createPublicKey(key.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(result.signature, 'base64')));
}

export function dialogCases(version, { DialogManager }) {
  const key = passkey();
  let portal = null;
  let dm = null;
  /** A fresh DialogManager, the portal answering it as `options` say. */
  const open = (options) => {
    portal?.stop();
    dm?.destroy();
    portal = servePortal({ key, ...options });
    dm = new DialogManager({ portalUrl: PORTAL });
    return dm;
  };
  afterEach(() => {
    portal?.stop();
    dm?.destroy();
    dm = null;
  });
  after(closePage);

  test(`${version}: connect, signing in with a passkey made here, reads the stored key; no kind is claimed`, async () => {
    const dm = open({ stored: { publicKey: key.publicKey, name: 'Alice' } });
    const result = await dm.openConnect();
    assert.equal(result.credentialId, key.credentialId);
    assert.equal(result.publicKey, key.publicKey);
    assert.equal(result.connectionType, 'get');
    assert.equal(result.accountName, 'Alice');
    assert.equal(result.kind, undefined);
    assert.deepEqual(portal.shown.map((s) => [s.action, s.subject]), [['connect', 'sign-in']]);
  });

  test(`${version}: connect with a passkey stored elsewhere: no key, so the SDK reads it from the chain`, async () => {
    const result = await open({ stored: undefined }).openConnect();
    assert.equal(result.credentialId, key.credentialId);
    assert.equal(result.publicKey, '');
    assert.equal(result.connectionType, 'get');
  });

  test(`${version}: connect creating a passkey: its own key, as created`, async () => {
    const result = await open({ create: 'Bob' }).openConnect();
    assert.equal(result.publicKey, key.publicKey);
    assert.equal(result.connectionType, 'create');
    assert.equal(result.isCreated, true);
    assert.equal(result.accountName, 'Bob');
  });

  test(`${version}: a transaction (32-byte challenge with a preview) is shown and signed`, async () => {
    const challenge = Keypair.generate().publicKey.toBytes();
    const result = await open({}).openSign(Buffer.from(challenge).toString('base64'), preview(), key.credentialId, 'devnet');
    assert.deepEqual(portal.shown.map((s) => [s.action, s.subject, s.decision.outcome]), [['sign', 'transaction', 'show']]);
    checkSignature(key, result, challenge);
  });

  test(`${version}: an approval (32-byte challenge, no preview) is shown and signed`, async () => {
    const challenge = Keypair.generate().publicKey.toBytes();
    const result = await open({}).openSign(Buffer.from(challenge).toString('base64'), '', key.credentialId);
    assert.deepEqual(portal.shown.map((s) => [s.action, s.subject]), [['sign', 'approval']]);
    checkSignature(key, result, challenge);
  });

  test(`${version}: signMessage sends the message bytes as the challenge; refused, and the app is told why`, async () => {
    for (const message of ['Sign in to app.test', Buffer.from('Sign in to app.test').toString('base64')]) {
      const error = await open({}).openSignMessage(message, key.credentialId).then(
        () => assert.fail('signed'),
        (e) => e,
      );
      assert.equal(portal.shown[0].decision.outcome, 'refuse');
      assert.match(error.message, /Request not (recognised|readable)/);
    }
  });
}
