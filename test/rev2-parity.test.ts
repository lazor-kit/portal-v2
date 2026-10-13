// The portal's account decoders (src/chain/layout.ts) and its refund rule
// (src/typed/reads.ts) against @lazorkit/sdk-legacy's approval module, on
// random authorities and sessions of layout revisions 0 to 3 and on random
// revoke/remove requests: the two must agree on what reads, where the policy
// and actions start, the recorded rent payer, and which refunds are refused.
//
// Needs @lazorkit/sdk-legacy 2.1.0 or later (layout revision 2,
// lazorkit-protocol #62). With an older dev dependency the tests are skipped
// and say so. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import bs58 from 'bs58';
import { decodeAuthority, decodeSession } from '../src/chain/layout.ts';
import { readTypedChain, RENT_PAYER_ONLY } from '../src/typed/reads.ts';
import { needsHoldings } from '../src/typed/screen.ts';
import type { ApprovalRequest } from '../src/approval/index.ts';
import { addr, CONFIG, ed25519Authority, NOW, PROGRAM, sample, sessionData, world, type World } from './typed-fixtures.ts';

interface Snapshot {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
}
interface SdkAuthority {
  type: 'ed25519' | 'passkey';
  role: 'owner' | 'admin' | 'delegate';
  counter: number;
  wallet: string;
  publicKey: Uint8Array;
  credentialIdHash?: Uint8Array;
  rpIdHash?: Uint8Array;
  policy: Uint8Array;
  rentPayer: string | null;
}
interface SdkSession {
  wallet: string;
  sessionKey: string;
  expiresAt: bigint;
  actions: Uint8Array;
  rentPayer: string | null;
}
interface SdkApproval {
  RENT_PAYER_LAYOUT_VERSION?: number;
  decodeAuthorityAccount(acc: Snapshot, programId: string): SdkAuthority | null;
  decodeSessionAccount(acc: Snapshot, programId: string): SdkSession | null;
  decodeApprovalRequest(encoded: string): unknown;
  describeApproval(req: unknown, view: Record<string, unknown>, opts: { features: readonly string[] | null }): { ok: true } | { ok: false; code: string; reason: string };
}

// A non-literal specifier: the type checker doesn't resolve it, so the file
// compiles against any dev dependency, and the tests skip without 2.1.0.
const SPECIFIER: string = '@lazorkit/sdk-legacy/approval';
const sdk = (await import(SPECIFIER).catch(() => null)) as SdkApproval | null;
const skip = sdk?.RENT_PAYER_LAYOUT_VERSION === 2 ? false : 'needs @lazorkit/sdk-legacy 2.1.0 or later (layout revision 2) as the dev dependency';

const ROLE: Record<SdkAuthority['role'], string> = { owner: 'owner', admin: 'admin', delegate: 'spender' };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const snap = (data: Uint8Array): Snapshot => ({ owner: PROGRAM, lamports: 1n, data });

/** A random authority: any revision 0-3, any type byte 0-2, any role byte 0-3, a policy that may not fit, and sometimes cut short. */
function randomAuthority(): Uint8Array {
  const type = randomInt(0, 3);
  const revision = [1, 2, 2, 1, 0, 3][randomInt(0, 6)];
  const keyEnd = type === 1 ? 145 : 80;
  const payer = revision === 2 ? 32 : 0;
  const policyLength = randomInt(0, 3) === 0 ? 0 : randomInt(1, 60);
  const length = keyEnd + payer + policyLength + (randomInt(0, 4) === 0 ? -randomInt(1, 40) : 0);
  const d = new Uint8Array(randomBytes(Math.max(length, 0)));
  if (d.length > 0) d[0] = randomInt(0, 20) === 0 ? 0x23 : 0x22;
  if (d.length > 1) d[1] = type;
  if (d.length > 2) d[2] = randomInt(0, 4);
  if (d.length > 4) d[4] = revision;
  if (d.length > 13) new DataView(d.buffer).setUint16(12, randomInt(0, 8) === 0 ? policyLength + randomInt(1, 9) : policyLength, true);
  return d;
}

/** A random session: any revision 0-3, actions of any length, sometimes cut short. */
function randomSession(): Uint8Array {
  const revision = [1, 2, 2, 1, 0, 3][randomInt(0, 6)];
  const length = 80 + (revision === 2 ? 32 : 0) + randomInt(0, 80) - (randomInt(0, 4) === 0 ? randomInt(1, 60) : 0);
  const d = new Uint8Array(randomBytes(Math.max(length, 0)));
  if (d.length > 0) d[0] = randomInt(0, 20) === 0 ? 0x22 : 0x23;
  if (d.length > 2) d[2] = revision;
  return d;
}

test('5,000 random authorities: the portal and sdk-legacy decode the same, rent payer and policy included', { skip }, () => {
  let read = 0;
  let payers = 0;
  for (let i = 0; i < 5000; i++) {
    const data = randomAuthority();
    const portal = decodeAuthority('x', data);
    const theirs = sdk!.decodeAuthorityAccount(snap(data), PROGRAM);
    assert.equal(portal === null, theirs === null, `case ${i}: ${hex(data.subarray(0, 16))}… (${data.length} bytes)`);
    if (!portal || !theirs) continue;
    read++;
    if (portal.rentPayer) payers++;
    assert.equal(portal.wallet, theirs.wallet);
    assert.equal(portal.role, ROLE[theirs.role]);
    assert.equal(portal.counter, theirs.counter);
    assert.equal(portal.rentPayer, theirs.rentPayer);
    assert.equal(hex(portal.policy ?? new Uint8Array(0)), hex(theirs.policy));
    assert.equal(portal.key.type, theirs.type);
    if (portal.key.type === 'ed25519') assert.equal(portal.key.publicKey, bs58.encode(theirs.publicKey));
    else {
      assert.equal(portal.key.publicKey, hex(theirs.publicKey));
      assert.equal(portal.key.credentialIdHash, hex(theirs.credentialIdHash!));
      assert.equal(portal.key.rpIdHash, hex(theirs.rpIdHash!));
    }
  }
  assert.ok(read > 500 && payers > 200, `${read} read, ${payers} with a payer: the sample reaches both revisions`);
});

test('5,000 random sessions: the portal and sdk-legacy decode the same, rent payer and actions included', { skip }, () => {
  let payers = 0;
  for (let i = 0; i < 5000; i++) {
    const data = randomSession();
    const portal = decodeSession('s', data);
    const theirs = sdk!.decodeSessionAccount(snap(data), PROGRAM);
    assert.equal(portal === null, theirs === null, `case ${i}: ${hex(data.subarray(0, 4))}… (${data.length} bytes)`);
    if (!portal || !theirs) continue;
    if (portal.rentPayer) payers++;
    assert.equal(portal.wallet, theirs.wallet);
    assert.equal(portal.sessionKey, theirs.sessionKey);
    assert.equal(portal.expiresAt, theirs.expiresAt);
    assert.equal(portal.rentPayer, theirs.rentPayer);
    assert.equal(hex(portal.actions), hex(theirs.actions));
  }
  assert.ok(payers > 500, `${payers} with a payer`);
});

type Kind = 'revokeSession' | 'removeAuthority';

/** A revoke or remove request on a revision-1 or revision-2 account, its refund the recorded payer, the fee payer, or anyone. */
function randomCase(i: number): { w: World; kind: Kind; revision: 1 | 2; refundIs: 'recorded' | 'fee payer' | 'other' } {
  const kind: Kind = i % 2 ? 'revokeSession' : 'removeAuthority';
  const revision = randomInt(0, 2) ? 2 : 1;
  const refundIs = (['recorded', 'fee payer', 'other'] as const)[randomInt(0, 3)];
  const feePayer = addr();
  // In the sponsored case the fee payer is also the account that paid the rent.
  const recorded = randomInt(0, 2) ? feePayer : addr();
  const refund = refundIs === 'recorded' ? recorded : refundIs === 'fee payer' ? feePayer : addr();
  const account = addr();
  const w = world(kind, kind === 'revokeSession' ? { session: account, refund } : { target: account, refund }, { payer: feePayer, ownerCount: 2, signerRentPayer: randomInt(0, 2) ? addr() : undefined });
  const rentPayer = revision === 2 ? recorded : undefined;
  const policy = randomInt(0, 2) ? sample.solLimit(BigInt(randomInt(1, 1_000_000))) : new Uint8Array(0);
  w.chain.set(
    account,
    PROGRAM,
    kind === 'revokeSession'
      ? sessionData({ wallet: w.wallet, sessionKey: addr(), expiresAt: NOW + BigInt(randomInt(-3600, 86_400)), actions: policy, rentPayer })
      : ed25519Authority({ wallet: w.wallet, publicKey: addr(), role: 2, policy, rentPayer }),
  );
  return { w, kind, revision, refundIs };
}

test('400 random revoke and remove requests: the portal refuses a refund exactly when sdk-legacy says refund-not-rent-payer', { skip }, async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const { w, kind, revision, refundIs } = randomCase(i);
    const portal = await readTypedChain(w.chain.transport, w.req, { config: CONFIG, needsHoldings, sleep: async () => {}, retryDelaysMs: [1] });
    const req = sdk!.decodeApprovalRequest(Buffer.from(JSON.stringify(w.json)).toString('base64url'));
    const at = (k: string) => {
      const a = w.chain.accounts.get(k);
      return a ? { owner: a.owner, lamports: BigInt(a.lamports), data: a.data } : null;
    };
    const args = (w.req as Extract<ApprovalRequest, { kind: Kind }>).args as { session?: string; target?: string };
    const view = {
      clock: at('SysvarC1ock11111111111111111111111111111111'),
      wallet: at(w.wallet),
      authority: at(w.authority),
      ...(kind === 'revokeSession' ? { session: at(args.session!) } : { target: at(args.target!) }),
    };
    const theirs = sdk!.describeApproval(req, view, { features: CONFIG.features });
    const label = `case ${i}: ${kind}, revision ${revision}, refund to ${refundIs}`;
    assert.equal(portal.ok, theirs.ok, `${label}: portal ${portal.ok ? 'shows' : (portal as { reason: string }).reason}, sdk ${theirs.ok ? 'describes' : (theirs as { reason: string }).reason}`);
    if (!portal.ok && !theirs.ok) {
      assert.equal(portal.code, 'request-invalid', label);
      assert.equal(portal.reason === RENT_PAYER_ONLY, theirs.reason === 'refund-not-rent-payer', label);
      seen.add(`refused ${theirs.reason}`);
    } else {
      seen.add(`shown revision ${revision}`);
    }
  }
  assert.deepEqual([...seen].sort(), ['refused refund-not-rent-payer', 'shown revision 1', 'shown revision 2']);
});
