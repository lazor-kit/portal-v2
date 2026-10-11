/**
 * Records the devnet answers the chain-read tests replay
 * (`test/fixtures/chain/*.json`). Read-only; run it when the layouts or the
 * RPC's answers change:
 *
 *   node scripts/record-chain-fixtures.ts
 *
 * It reads from the public devnet RPC, or from RECORD_RPC_URL when set. The
 * URL is never written to a fixture or printed: a keyed URL stays local.
 *
 * Each fixture holds, for one devnet wallet: its authority, session and
 * deferred accounts, its vault's balance and token accounts, the vault's
 * newest signatures, and every transaction among them (`jsonParsed`, any
 * version), failed ones included so the tests can show they never count.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { DISCRIMINATOR, LAZORKIT_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, vaultAddress, WALLET_OFFSET } from '../src/chain/layout.ts';

const RPC = process.env.RECORD_RPC_URL?.trim() || 'https://api.devnet.solana.com';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'chain');

/** Devnet wallets chosen for what their history shows. */
const SUBJECTS = [
  { name: 'devnet-wallet', wallet: 'AajjXDFYTGE4f5nkHbrYQNbrwDBx8oRXqtWGbMFpAQwK', note: 'an Admin key and a passkey Owner; two sessions, one with limits; zero-value transfers out and one transfer in' },
  { name: 'devnet-payments', wallet: 'DDkMMY3VxvBSdzBSsCkQjWfpN83MgUJGCvHAB2P71RDt', note: 'SOL and SPL token payments out, and failed transactions that carried transfers' },
  { name: 'devnet-repeat', wallet: '4FpvpQFakXSZ9GcsUAeZtaJTFPLemxFZ1khm5F2j61Sb', note: 'SOL payments to several addresses, one of them paid twice, and failed transactions' },
] as const;

async function call(method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  throw new Error(`${method}: rate limited`);
}

for (const subject of SUBJECTS) {
  const program = LAZORKIT_PROGRAM.devnet;
  const vault = vaultAddress('devnet', subject.wallet);
  const listing = async (kind: keyof typeof WALLET_OFFSET) =>
    call('getProgramAccounts', [
      program,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        withContext: true,
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(DISCRIMINATOR[kind])) } }, { memcmp: { offset: WALLET_OFFSET[kind], bytes: subject.wallet } }],
      },
    ]);
  const tokens = (programId: string) => call('getTokenAccountsByOwner', [vault, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const signatures = (await call('getSignaturesForAddress', [vault, { commitment: 'confirmed', limit: 1000 }])) as { signature: string }[];
  const transactions: Record<string, unknown> = {};
  for (const { signature } of signatures) {
    transactions[signature] = await call('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
  }
  const fixture = {
    recorded: new Date().toISOString().slice(0, 10),
    cluster: 'devnet',
    note: subject.note,
    wallet: subject.wallet,
    vault,
    accounts: { authority: await listing('authority'), session: await listing('session'), deferred: await listing('deferred') },
    balance: await call('getBalance', [vault, { commitment: 'confirmed' }]),
    tokenAccounts: { [TOKEN_PROGRAM]: await tokens(TOKEN_PROGRAM), [TOKEN_2022_PROGRAM]: await tokens(TOKEN_2022_PROGRAM) },
    signatures,
    transactions,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${subject.name}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${subject.name}: ${signatures.length} signatures, ${Object.keys(transactions).length} transactions`);
}
