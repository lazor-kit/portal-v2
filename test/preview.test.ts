// What a transaction preview says it does: its fee payer, plain transfers
// (System and Token programs only) and fees, and the fee line. Run with
// `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { parseRegistry } from '../src/security/config.ts';
import { decodePreview, feeLine, formatUnits, paymentHero, summarizePreview, TOKEN_PROGRAM, type TokenFacts } from '../src/utils/preview.ts';

const key = () => Keypair.generate().publicKey;

function preview(instructions: TransactionInstruction[], payer = key()): string {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: key().toBase58(), instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

function tokenTransfer(source: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint, program = new PublicKey(TOKEN_PROGRAM)): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function tokenTransferChecked(source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

test('a SOL transfer: amount, recipient and fee payer, before any chain read', () => {
  const to = key();
  const payer = key();
  const decoded = decodePreview(preview([SystemProgram.transfer({ fromPubkey: key(), toPubkey: to, lamports: 250_000_000 })], payer))!;
  assert.equal(decoded.feePayer, payer.toBase58());
  const summary = summarizePreview(decoded, null);
  assert.deepEqual(summary.payment, { amount: '0.25', symbol: 'SOL', mint: null, to: to.toBase58(), toIsOwner: false });
  assert.equal(paymentHero(summary.payment!), 'Send 0.25 SOL');
  assert.deepEqual(summary.fees, []);
});

test('only the System and Token programs are read as transfers: the same bytes for another program are not', () => {
  const lookalike = SystemProgram.transfer({ fromPubkey: key(), toPubkey: key(), lamports: 1 });
  const other = new TransactionInstruction({ programId: key(), keys: lookalike.keys, data: lookalike.data });
  const decoded = decodePreview(preview([other]))!;
  assert.equal(decoded.transfers.length, 0);
  assert.equal(summarizePreview(decoded, null).payment, null);
  assert.equal(decoded.programs.length, 1);
});

test('two payments: no single hero amount', () => {
  const decoded = decodePreview(preview([
    SystemProgram.transfer({ fromPubkey: key(), toPubkey: key(), lamports: 1 }),
    SystemProgram.transfer({ fromPubkey: key(), toPubkey: key(), lamports: 2 }),
  ]))!;
  const summary = summarizePreview(decoded, null);
  assert.equal(summary.payment, null);
  assert.equal(summary.transfers, 2);
});

test('a token transfer: the recipient is the owner of the receiving account, once the chain says so', () => {
  const [source, destination, owner, recipient] = [key(), key(), key(), key()];
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const decoded = decodePreview(preview([tokenTransfer(source, destination, owner, 5_000_000n)]))!;
  // Before the chain read: the receiving account itself, amount unknown (no decimals).
  const before = summarizePreview(decoded, null).payment!;
  assert.deepEqual([before.to, before.toIsOwner, before.amount, before.symbol], [destination.toBase58(), false, null, null]);
  assert.equal(paymentHero(before), 'Send another token');
  const facts: TokenFacts = {
    accounts: { [source.toBase58()]: { mint: usdc, owner: owner.toBase58() }, [destination.toBase58()]: { mint: usdc, owner: recipient.toBase58() } },
    decimals: { [usdc]: 6 },
  };
  const after = summarizePreview(decoded, facts).payment!;
  assert.deepEqual([after.to, after.toIsOwner, after.amount, after.symbol, after.mint], [recipient.toBase58(), true, '5', 'USDC', usdc]);
  assert.equal(paymentHero(after), 'Send 5 USDC');
});

test('TransferChecked names its mint and decimals; an unknown mint is "another token"', () => {
  const mint = key();
  const decoded = decodePreview(preview([tokenTransferChecked(key(), mint, key(), key(), 1_500n, 3)]))!;
  const payment = summarizePreview(decoded, null).payment!;
  assert.deepEqual([payment.amount, payment.symbol, payment.mint], ['1.5', null, mint.toBase58()]);
  assert.equal(paymentHero(payment), 'Send 1.5 of another token');
});

test('a payment to the fee payer is a fee the user pays, shown on the first view', () => {
  const payer = key();
  const to = key();
  const decoded = decodePreview(preview([
    SystemProgram.transfer({ fromPubkey: key(), toPubkey: to, lamports: 1_000_000 }),
    SystemProgram.transfer({ fromPubkey: key(), toPubkey: payer, lamports: 5_000 }),
  ], payer))!;
  const summary = summarizePreview(decoded, null);
  assert.equal(summary.payment?.to, to.toBase58());
  assert.equal(summary.fees.length, 1);
  assert.deepEqual(feeLine({ feePayer: decoded.feePayer, fees: summary.fees, app: undefined }), { where: 'first-view', text: 'You pay 0.000005 SOL' });
});

test('fee line: "Paid by" names an app only for a fee payer registered to it; otherwise the user does not pay', () => {
  const payer = key().toBase58();
  const registry = parseRegistry({ version: 1, apps: [{ id: 'fernway', name: 'Fernway', origins: ['https://www.fernway.example'], feePayers: [payer] }] });
  const app = registry.apps[0];
  assert.deepEqual(feeLine({ feePayer: payer, fees: [], app }), { where: 'details', text: 'Paid by Fernway' });
  assert.deepEqual(feeLine({ feePayer: key().toBase58(), fees: [], app }), { where: 'details', text: "You don't pay it" });
  assert.deepEqual(feeLine({ feePayer: payer, fees: [], app: undefined }), { where: 'details', text: "You don't pay it" });
  assert.equal(feeLine({ feePayer: null, fees: [], app }), null);
});

test('a registry fee payer is a key, and belongs to one app', () => {
  const payer = key().toBase58();
  const app = (id: string, feePayers: unknown) => ({ id, name: id, origins: [], feePayers });
  assert.throws(() => parseRegistry({ version: 1, apps: [app('a', ['not-a-key'])] }), /base58 public key/);
  assert.throws(() => parseRegistry({ version: 1, apps: [app('a', payer)] }), /must be a list/);
  assert.throws(() => parseRegistry({ version: 1, apps: [app('a', [payer]), app('b', [payer])] }), /already registered to a/);
  assert.deepEqual(parseRegistry({ version: 1, apps: [app('a', [payer])] }).apps[0].feePayers, [payer]);
  assert.equal(parseRegistry({ version: 1, apps: [app('a', [])] }).apps[0].feePayers, undefined);
});

test('amounts keep their decimals and drop trailing zeros', () => {
  assert.equal(formatUnits(250_000_000n, 9), '0.25');
  assert.equal(formatUnits(1_234_500_000n, 6), '1,234.5');
  assert.equal(formatUnits(7n, 0), '7');
  assert.equal(formatUnits(1n, 9), '0.000000001');
});

test('a preview that is not a transaction decodes to nothing', () => {
  assert.equal(decodePreview(Buffer.from('not a transaction').toString('base64')), null);
});
