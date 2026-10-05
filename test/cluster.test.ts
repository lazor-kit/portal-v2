// The preview is simulated on the network its blockhash belongs to.
// Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { parseCluster, previewBlockhash, resolveCluster, type BlockhashCheck, type Cluster } from '../src/utils/cluster.ts';

const blockhash = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey;
const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });

/** A check that finds `blockhash` valid on `on` only (or nowhere), and fails for `broken`. */
const validOn = (on: Cluster | null, broken: Cluster[] = []): BlockhashCheck => async (cluster) => {
  if (broken.includes(cluster)) throw new Error('rpc down');
  return cluster === on;
};

test('the blockhash of a v0 preview (as the SDK builds it), a legacy transaction, or a bare message', () => {
  const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
  assert.equal(previewBlockhash(v0.serialize()), blockhash);
  const legacy = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(ix);
  assert.equal(previewBlockhash(legacy.serialize({ requireAllSignatures: false, verifySignatures: false })), blockhash);
  assert.equal(previewBlockhash(legacy.compileMessage().serialize()), blockhash);
  assert.equal(previewBlockhash(new Uint8Array([1, 2, 3])), null);
  assert.equal(previewBlockhash(new Uint8Array(0)), null);
});

test('the requested cluster when the blockhash is valid there', async () => {
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn('mainnet')), { cluster: 'mainnet', source: 'request', verified: true, mismatch: false, known: true });
  assert.deepEqual(await resolveCluster(null, blockhash, validOn('devnet')), { cluster: 'devnet', source: 'default', verified: true, mismatch: false, known: true });
});

test('the other cluster when the blockhash is valid only there, flagged when the app asked otherwise', async () => {
  assert.deepEqual(await resolveCluster('devnet', blockhash, validOn('mainnet')), { cluster: 'mainnet', source: 'preview', verified: true, mismatch: true, known: true });
  // No cluster asked: devnet was only the default, so mainnet is no mismatch.
  assert.deepEqual(await resolveCluster(null, blockhash, validOn('mainnet')), { cluster: 'mainnet', source: 'preview', verified: true, mismatch: false, known: true });
  // Found on the other cluster even while the requested one cannot be checked.
  assert.deepEqual(await resolveCluster('devnet', blockhash, validOn('mainnet', ['devnet'])), { cluster: 'mainnet', source: 'preview', verified: true, mismatch: true, known: true });
});

test('unverified, but known, when the app named the cluster and no check contradicts it', async () => {
  // Valid nowhere (an expired blockhash): the app's word stands.
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn(null)), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false, known: true });
  // Neither cluster could be checked.
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn('devnet', ['devnet', 'mainnet'])), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false, known: true });
  // The requested cluster could not be checked, the other says no.
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn(null, ['mainnet'])), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false, known: true });
});

test('not known when the network is only the devnet default, or the blockhash was refused there and the other cluster could not be checked', async () => {
  // A mainnet preview, no cluster named, mainnet unreachable (rate limited,
  // or RPC_MAINNET_URL unset): devnet refuses the blockhash, so a devnet
  // simulation says nothing about the transaction.
  assert.deepEqual(await resolveCluster(null, blockhash, validOn('mainnet', ['mainnet'])), { cluster: 'devnet', source: 'default', verified: false, mismatch: false, known: false });
  // The same with devnet named.
  assert.deepEqual(await resolveCluster('devnet', blockhash, validOn('mainnet', ['mainnet'])), { cluster: 'devnet', source: 'request', verified: false, mismatch: false, known: false });
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn('devnet', ['devnet'])), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false, known: false });
  // Valid nowhere, or unchecked, with only the default to go on.
  assert.deepEqual(await resolveCluster(null, blockhash, validOn(null)), { cluster: 'devnet', source: 'default', verified: false, mismatch: false, known: false });
  assert.deepEqual(await resolveCluster(null, blockhash, validOn(null, ['devnet', 'mainnet'])), { cluster: 'devnet', source: 'default', verified: false, mismatch: false, known: false });
  // No blockhash to check: the app's word, or nothing.
  assert.deepEqual(await resolveCluster(null, null, validOn('mainnet')), { cluster: 'devnet', source: 'default', verified: false, mismatch: false, known: false });
  assert.deepEqual(await resolveCluster('mainnet', null, validOn('mainnet')), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false, known: true });
});

test('only mainnet and devnet are clusters', () => {
  assert.equal(parseCluster('mainnet'), 'mainnet');
  assert.equal(parseCluster('devnet'), 'devnet');
  for (const v of [null, '', 'testnet', 'mainnet-beta', 'MAINNET']) assert.equal(parseCluster(v), null);
});
