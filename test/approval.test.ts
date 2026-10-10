// The typed-request module (src/approval): the envelope codec, the strict
// action decoder, the challenge recipe against an independent reference, and
// the PDA helpers against @solana/web3.js. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { action, cat, mintBytes, sample, u64 } from './typed-fixtures.ts';
import {
  approvalChallenge,
  approvalRequestJson,
  base58Decode,
  base58Encode,
  base64urlDecode,
  base64urlEncode,
  decodeActions,
  decodeApprovalRequest,
  encodeApprovalRequest,
  passkeyAuthorityAddress,
  preparedChallenge,
  readApprovalFragment,
  sessionAddress,
  signedPayloadOf,
  vaultAddressOf,
  type ApprovalRequest,
} from '../src/approval/index.ts';

const PROGRAM = '57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv';
const addr = () => Keypair.generate().publicKey.toBase58();

function createSession(over: Partial<Record<string, unknown>> = {}, args: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'createSession',
    cluster: 'devnet',
    programId: PROGRAM,
    wallet: addr(),
    authority: addr(),
    credentialId: base64urlEncode(randomBytes(16)),
    payer: addr(),
    counter: 7,
    preparedSlot: '412388000',
    args: { sessionKey: addr(), expiresAt: '1791650000', actions: base64urlEncode(sample.solLimit(20_000_000n)), ...args },
    ...over,
  };
}
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const encode = (json: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(json)));

/** The challenge, written again from program/src/auth/secp256r1/mod.rs with node:crypto. */
function reference(req: ApprovalRequest, slot: bigint, counter: number): Uint8Array {
  const disc = { createSession: 5, revokeSession: 9, removeAuthority: 2 }[req.kind];
  const ix = { createSession: 6, revokeSession: 5, removeAuthority: 5 }[req.kind];
  const prefix = Buffer.alloc(14);
  prefix.writeBigUInt64LE(slot, 0);
  prefix.writeUInt32LE(counter, 8);
  prefix[12] = ix;
  prefix[13] = 0x80;
  const k = (a: string) => new PublicKey(a).toBuffer();
  let payload: Buffer;
  if (req.kind === 'createSession') {
    const e = Buffer.alloc(8);
    e.writeBigUInt64LE(req.args.expiresAt);
    const len = Buffer.alloc(2);
    len.writeUInt16LE(req.args.actions.length);
    payload = Buffer.concat([k(req.args.sessionKey), e, len, Buffer.from(req.args.actions), k(req.payer)]);
  } else if (req.kind === 'revokeSession') payload = Buffer.concat([k(req.args.session), k(req.args.refund)]);
  else payload = Buffer.concat([k(req.args.target), k(req.args.refund)]);
  const c = Buffer.alloc(4);
  c.writeUInt32LE(counter);
  return createHash('sha256').update(Buffer.concat([Buffer.from([disc]), prefix, payload, k(req.payer), k(req.wallet), c, k(req.programId)])).digest();
}

test('base58 and base64url: canonical only', () => {
  for (let i = 0; i < 200; i++) {
    const bytes = randomBytes(1 + (i % 40));
    assert.deepEqual(base58Decode(base58Encode(bytes)), new Uint8Array(bytes));
    assert.deepEqual(base64urlDecode(base64urlEncode(bytes)), new Uint8Array(bytes));
    assert.equal(base64urlEncode(bytes), Buffer.from(bytes).toString('base64url'));
  }
  const key = addr();
  assert.equal(base58Encode(new PublicKey(key).toBytes()), key);
  assert.equal(base58Decode('0OIl'), null);
  assert.equal(base64urlDecode('AQ=='), null, 'padding');
  assert.equal(base64urlDecode('A+/A'), null, 'standard alphabet');
  assert.equal(base64urlDecode('AR'), null, 'non-zero trailing bits');
  assert.equal(base64urlDecode('A'), null, 'a length no byte string has');
});

test('envelope: decode(encode(x)) is x; the JSON comes back in schema order', () => {
  const json = createSession({ minContextSlot: 412387990 });
  const decoded = decodeApprovalRequest(encode(json));
  assert.ok(decoded.ok, show(decoded));
  assert.deepEqual(approvalRequestJson(decoded.request), json);
  const again = decodeApprovalRequest(encodeApprovalRequest(decoded.request));
  assert.ok(again.ok);
  assert.deepEqual(approvalRequestJson(again.request), json);
  for (const kind of ['revokeSession', 'removeAuthority'] as const) {
    const args = kind === 'revokeSession' ? { session: addr(), refund: addr() } : { target: addr(), refund: addr() };
    const j = { ...createSession(), kind, args };
    const d = decodeApprovalRequest(encode(j));
    assert.ok(d.ok, show(d));
    assert.deepEqual(approvalRequestJson(d.request), j);
  }
});

test('envelope: anything off-schema is refused, never repaired', () => {
  const bad: [string, unknown, string][] = [
    ['unknown key', createSession({ note: 'hi' }), 'typed-malformed'],
    ['missing key', Object.fromEntries(Object.entries(createSession()).filter(([k]) => k !== 'payer')), 'typed-malformed'],
    ['unknown args key', createSession({}, { label: 'Fernway' }), 'typed-malformed'],
    ['v 2', createSession({ v: 2 }), 'typed-unsupported'],
    ['v as text', createSession({ v: '1' }), 'typed-malformed'],
    ['unknown kind', createSession({ kind: 'execute' }), 'typed-unsupported'],
    ['cluster testnet', createSession({ cluster: 'testnet' }), 'typed-malformed'],
    ['address with a zero', createSession({ wallet: '0' + addr().slice(1) }), 'typed-malformed'],
    ['address of 31 bytes', createSession({ payer: base58Encode(randomBytes(31)) }), 'typed-malformed'],
    ['counter as text', createSession({ counter: '7' }), 'typed-malformed'],
    ['counter over u32', createSession({ counter: 2 ** 32 }), 'typed-malformed'],
    ['counter fraction', createSession({ counter: 7.5 }), 'typed-malformed'],
    ['slot as number', createSession({ preparedSlot: 412388000 }), 'typed-malformed'],
    ['slot with a leading zero', createSession({ preparedSlot: '0412388000' }), 'typed-malformed'],
    ['slot over u64', createSession({ preparedSlot: '18446744073709551616' }), 'typed-malformed'],
    ['expiresAt at 2^63', createSession({}, { expiresAt: (1n << 63n).toString() }), 'typed-malformed'],
    ['actions padded', createSession({}, { actions: Buffer.from(sample.solLimit(1n)).toString('base64') }), 'typed-malformed'],
    ['credential empty', createSession({ credentialId: '' }), 'typed-malformed'],
    ['credential 1024 bytes', createSession({ credentialId: base64urlEncode(randomBytes(1024)) }), 'typed-malformed'],
    ['minContextSlot as text', createSession({ minContextSlot: '1' }), 'typed-malformed'],
    ['array', [createSession()], 'typed-malformed'],
  ];
  for (const [name, json, code] of bad) {
    const d = decodeApprovalRequest(encode(json));
    assert.equal(d.ok, false, name);
    assert.equal(!d.ok && d.code, code, name);
  }
  assert.equal(decodeApprovalRequest('not base64!').ok, false);
  assert.equal(decodeApprovalRequest(base64urlEncode(Uint8Array.of(0xff, 0xfe))).ok, false, 'not UTF-8');
  assert.equal(decodeApprovalRequest('A'.repeat(8193)).ok, false, 'over the cap');
});

test('fragment: only #/?lk1=<value>; any other form naming lk1 is malformed; no lk1 is none', () => {
  assert.deepEqual(readApprovalFragment(''), { kind: 'none' });
  assert.deepEqual(readApprovalFragment('#/'), { kind: 'none' });
  assert.deepEqual(readApprovalFragment('#/?lk1=abc_-1'), { kind: 'value', value: 'abc_-1' });
  assert.equal(readApprovalFragment('#lk1=abc').kind, 'malformed');
  assert.equal(readApprovalFragment('#/?lk1=abc&open_in_browser=true').kind, 'malformed');
  assert.equal(readApprovalFragment('#/?x=1&lk1=abc').kind, 'malformed');
});

test('actions: accepted exactly when the program accepts them', () => {
  const m1 = mintBytes();
  const m2 = mintBytes();
  const ok = [
    new Uint8Array(0),
    sample.solLimit(1n),
    cat(sample.solMax(2_000_000n), sample.tokenLimit(m1, 5_000_000n), sample.tokenMax(m1, 1n), sample.tokenLimit(m2, 1n)),
    cat(sample.solRecurring(1n, 86_400n), sample.tokenRecurring(m1, 1n, 3_600n)),
    cat(sample.whitelist(m1), sample.whitelist(m1)),
    cat(...Array.from({ length: 16 }, () => sample.tokenRecurring(mintBytes(), 1n, 1n))),
  ];
  for (const buf of ok) assert.ok(decodeActions(buf).ok, Buffer.from(buf).toString('hex'));
  const bad = [
    sample.solLimit(1n).subarray(0, 18),
    cat(sample.solLimit(1n), Uint8Array.of(0)),
    action(7, u64(1n)),
    action(1, new Uint8Array(9)),
    cat(sample.solLimit(1n), sample.solLimit(2n)),
    cat(sample.solMax(1n), sample.solMax(1n)),
    cat(sample.tokenLimit(m1, 1n), sample.tokenLimit(m1, 2n)),
    cat(sample.whitelist(m1), sample.blacklist(m2)),
    sample.solRecurring(1n, 0n),
    action(2, u64(1n, 1n, 1n, 0n)),
    action(2, u64(1n, 0n, 1n, 1n)),
    action(5, cat(m1, u64(1n, 0n, 1n, 5n))),
    cat(...Array.from({ length: 17 }, () => sample.tokenLimit(mintBytes(), 1n))),
  ];
  for (const buf of bad) assert.equal(decodeActions(buf).ok, false, Buffer.from(buf).toString('hex'));
  // A stored session carries what was spent since: shape only.
  assert.ok(decodeActions(action(2, u64(10n, 4n, 60n, 1_791_000_000n)), { forNewSession: false }).ok);
});

test('challenge: equals an independent reference for every kind, and binds every field', () => {
  for (let i = 0; i < 300; i++) {
    const kind = (['createSession', 'revokeSession', 'removeAuthority'] as const)[i % 3];
    const args =
      kind === 'createSession'
        ? { sessionKey: addr(), expiresAt: String(1_700_000_000 + i), actions: base64urlEncode(i % 2 ? sample.solMax(BigInt(i)) : new Uint8Array(0)) }
        : kind === 'revokeSession'
          ? { session: addr(), refund: addr() }
          : { target: addr(), refund: addr() };
    const d = decodeApprovalRequest(encode({ ...createSession({ counter: i === 0 ? 0 : i === 1 ? 0xfffffffe : i }), kind, args }));
    assert.ok(d.ok);
    const slot = i === 2 ? (1n << 64n) - 1n : BigInt(400_000_000 + i);
    const counter = d.request.counter;
    assert.deepEqual(Buffer.from(approvalChallenge(d.request, { slot, counter })), Buffer.from(reference(d.request, slot, counter)));
  }
  const d = decodeApprovalRequest(encode(createSession()));
  assert.ok(d.ok && d.request.kind === 'createSession');
  const base = Buffer.from(preparedChallenge(d.request)).toString('hex');
  const variants = [
    { ...d.request, payer: addr() },
    { ...d.request, wallet: addr() },
    { ...d.request, programId: addr() },
    { ...d.request, args: { ...d.request.args, sessionKey: addr() } },
    { ...d.request, args: { ...d.request.args, expiresAt: d.request.args.expiresAt + 1n } },
    { ...d.request, args: { ...d.request.args, actions: sample.solLimit(20_000_001n) } },
    { ...d.request, counter: d.request.counter + 1 },
    { ...d.request, preparedSlot: d.request.preparedSlot + 1n },
  ] as ApprovalRequest[];
  for (const v of variants) assert.notEqual(Buffer.from(preparedChallenge(v)).toString('hex'), base);
  assert.equal(signedPayloadOf(d.request).length, 32 + 8 + 2 + d.request.args.actions.length + 32);
});

test('PDAs: authority, session and vault as the program derives them', () => {
  const program = new PublicKey(PROGRAM);
  for (let i = 0; i < 20; i++) {
    const wallet = Keypair.generate().publicKey;
    const credential = randomBytes(16 + i);
    const hash = createHash('sha256').update(credential).digest();
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('lk2:authority'), wallet.toBuffer(), hash], program);
    assert.equal(passkeyAuthorityAddress(PROGRAM, wallet.toBase58(), credential), authority.toBase58());
    const sessionKey = Keypair.generate().publicKey;
    const [session] = PublicKey.findProgramAddressSync([Buffer.from('lk2:session'), wallet.toBuffer(), sessionKey.toBuffer()], program);
    assert.equal(sessionAddress(PROGRAM, wallet.toBase58(), sessionKey.toBase58()), session.toBase58());
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from('lk2:vault'), wallet.toBuffer()], program);
    assert.equal(vaultAddressOf(PROGRAM, wallet.toBase58()), vault.toBase58());
  }
});
