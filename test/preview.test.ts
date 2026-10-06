// What a transaction preview says it does: its fee payer, plain transfers
// (System and Token programs only) and fees, what it didn't read, and the fee
// line. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { parseRegistry } from '../src/security/config.ts';
import { COMPUTE_BUDGET_PROGRAM, decodePreview, feeLine, formatUnits, MEMO_PROGRAM, paymentHero, summarizePreview, TOKEN_PROGRAM, unreadKind, type TokenFacts } from '../src/utils/preview.ts';

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
  assert.equal(unreadKind(decoded), 'service');
});

/** Token Approve: u8 4, u64 amount; accounts [source, delegate, owner]. */
function tokenApprove(source: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 4;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

test('a transfer next to anything LazorKit does not read is never a payment hero', () => {
  const owner = key();
  const transfer = SystemProgram.transfer({ fromPubkey: owner, toPubkey: key(), lamports: 250_000_000 });
  // An unlimited Token approval to a third key.
  const approve = decodePreview(preview([transfer, tokenApprove(key(), key(), owner, 2n ** 64n - 1n)]))!;
  assert.equal(approve.transfers.length, 1);
  assert.equal(approve.instructions, 2);
  assert.deepEqual(approve.unread, [TOKEN_PROGRAM]);
  assert.equal(unreadKind(approve), 'step');
  assert.equal(summarizePreview(approve, null).payment, null);
  // An instruction of a program LazorKit can't read.
  const unknown = decodePreview(preview([transfer, new TransactionInstruction({ programId: key(), keys: [], data: Buffer.from([1]) })]))!;
  assert.equal(unreadKind(unknown), 'service');
  assert.equal(summarizePreview(unknown, null).payment, null);
  // Compute-budget and memo instructions move nothing: still one payment.
  const budget = new TransactionInstruction({ programId: new PublicKey(COMPUTE_BUDGET_PROGRAM), keys: [], data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]) });
  const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from('order 42') });
  const plain = decodePreview(preview([budget, transfer, memo]))!;
  assert.equal(unreadKind(plain), null);
  assert.equal(paymentHero(summarizePreview(plain, null).payment!), 'Send 0.25 SOL');
});

test('an instruction naming an account from a lookup table is not read, and is never a payment', () => {
  const payer = key();
  const to = key();
  const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [to] } });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: key().toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: key(), toPubkey: to, lamports: 1_000 })],
  }).compileToV0Message([table]);
  const decoded = decodePreview(Buffer.from(new VersionedTransaction(message).serialize()).toString('base64'))!;
  assert.equal(decoded.transfers.length, 0);
  assert.deepEqual(decoded.unread, [SystemProgram.programId.toBase58()]);
  assert.equal(summarizePreview(decoded, null).payment, null);
});

test("what the fee payer sends is the app's, not the user's payment", () => {
  const payer = key();
  const sol = decodePreview(preview([SystemProgram.transfer({ fromPubkey: payer, toPubkey: key(), lamports: 1_000 })], payer))!;
  assert.equal(summarizePreview(sol, null).payment, null);
  const token = decodePreview(preview([tokenTransfer(key(), key(), payer, 5n)], payer))!;
  assert.equal(summarizePreview(token, null).payment, null);
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
