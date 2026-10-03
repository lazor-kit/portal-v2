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
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn('mainnet')), { cluster: 'mainnet', source: 'request', verified: true, mismatch: false });
  assert.deepEqual(await resolveCluster(null, blockhash, validOn('devnet')), { cluster: 'devnet', source: 'default', verified: true, mismatch: false });
});

test('the other cluster when the blockhash is valid only there, flagged when the app asked otherwise', async () => {
  assert.deepEqual(await resolveCluster('devnet', blockhash, validOn('mainnet')), { cluster: 'mainnet', source: 'preview', verified: true, mismatch: true });
  // No cluster asked: devnet was only the default, so mainnet is no mismatch.
  assert.deepEqual(await resolveCluster(null, blockhash, validOn('mainnet')), { cluster: 'mainnet', source: 'preview', verified: true, mismatch: false });
});

test('unverified when the blockhash is valid nowhere, cannot be checked, or is missing', async () => {
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn(null)), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false });
  assert.deepEqual(await resolveCluster('mainnet', blockhash, validOn('devnet', ['devnet', 'mainnet'])), { cluster: 'mainnet', source: 'request', verified: false, mismatch: false });
  assert.deepEqual(await resolveCluster(null, null, validOn('mainnet')), { cluster: 'devnet', source: 'default', verified: false, mismatch: false });
});

test('only mainnet and devnet are clusters', () => {
  assert.equal(parseCluster('mainnet'), 'mainnet');
  assert.equal(parseCluster('devnet'), 'devnet');
  for (const v of [null, '', 'testnet', 'mainnet-beta', 'MAINNET']) assert.equal(parseCluster(v), null);
});
