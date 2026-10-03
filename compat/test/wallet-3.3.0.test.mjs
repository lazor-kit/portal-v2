// @lazorkit/wallet 3.3.0 (and 3.0.0-3.2.1, which share its connect code)
// against the portal's request handling: a returning user's connect needs
// one prompt, the sign-in. These versions send 32 random bytes as the
// connect challenge, which the portal does not sign; the reply then claims
// no assertion, so the SDK takes the key the portal stored for this exact
// credential instead of asking for a second signature.
// Run with `pnpm test` in compat/.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL, RPC, RP_ID, closePage } from '../lib/page.mjs';
import { passkey, portalAnswer, servePortal } from '../lib/portal.mjs';
import { scriptedChain } from '../lib/chain.mjs';

const W = await import('wallet-3.3.0');
const PROGRAM = W.PROGRAM_ID_DEVNET;
const store = W.useWalletStore;
const key = passkey();
const chain = scriptedChain();
let portal = null;

beforeEach(() => {
  portal?.stop();
  chain.accounts.clear();
  chain.calls.length = 0;
  localStorage.clear();
  store.getState().setConfig({ rpcUrl: RPC, portalUrl: PORTAL, paymasterConfig: { paymasterUrl: 'https://paymaster.test/' }, cluster: 'devnet' });
  store.setState({ connection: chain.connection, wallet: null, isConnecting: false, isSigning: false, error: null });
});
after(() => {
  portal?.stop();
  closePage();
});

test('3.3.0 sends 32 random bytes as the connect challenge; the portal signs in without them and claims no assertion', async () => {
  const { wallet, vault } = chain.walletOf({ W, programId: PROGRAM, credentialId: key.credentialId, key: key.compressed, rpId: RP_ID });
  portal = servePortal({ key, stored: { publicKey: key.publicKey } });
  const connected = await store.getState().connect();

  const [connect] = portal.shown;
  assert.equal(connect.action, 'connect');
  assert.equal(Buffer.from(connect.url.searchParams.get('challenge'), 'base64url').length, 32);
  assert.equal(connect.subject, 'sign-in', 'not an ownership proof: not signed');
  // One prompt: no portal sign after the connect.
  assert.deepEqual(portal.shown.map((s) => s.action), ['connect']);
  // The wallet the passkey owns, adopted with the stored key.
  assert.equal(connected.smartWallet, wallet.toBase58());
  assert.equal(connected.vaultPda, vault.toBase58());
  assert.deepEqual(Buffer.from(connected.passkeyPubkey), key.compressed);
});

test('the same connect, had the reply said "asserted" with no assertion: 3.3.0 asks for a second signature, which the portal shows as an approval', async () => {
  chain.walletOf({ W, programId: PROGRAM, credentialId: key.credentialId, key: key.compressed, rpId: RP_ID });
  // A reply that claims a sign-in assertion it does not carry.
  portal = servePortal({ key, stored: { publicKey: key.publicKey } }, (src) => {
    const answer = portalAnswer(src, { key, stored: { publicKey: key.publicKey } });
    if (answer.shown.action === 'connect') answer.message.data.kind = 'asserted';
    return answer;
  });
  await store.getState().connect();
  assert.deepEqual(portal.shown.map((s) => s.action), ['connect', 'sign']);
  const sign = portal.shown[1];
  assert.equal(Buffer.from(sign.url.searchParams.get('message'), 'base64url').length, 32);
  assert.equal(sign.subject, 'approval', 'shown as "Approve wallet change", with a confirmation');
});

test('a passkey the portal stored no key for: 3.3.0 proves it with one more signature, as before', async () => {
  chain.walletOf({ W, programId: PROGRAM, credentialId: key.credentialId, key: key.compressed, rpId: RP_ID });
  portal = servePortal({ key, stored: undefined });
  await store.getState().connect();
  assert.deepEqual(portal.shown.map((s) => [s.action, s.subject]), [['connect', 'sign-in'], ['sign', 'approval']]);
});
