/**
 * A scripted Solana RPC: accounts that exist, the reads a connect makes
 * (program accounts by memcmp filter, accounts by address, token accounts,
 * the slot), and nothing else.
 */
import { createHash } from 'node:crypto';
import { Connection, Keypair } from '@solana/web3.js';
import { RPC } from './page.mjs';

const SLOT = 5000;
const sha256 = (data) => createHash('sha256').update(data).digest();

export function scriptedChain() {
  /** address → { owner, data, lamports } */
  const accounts = new Map();
  const calls = [];

  const encode = ({ owner, data, lamports = 2_000_000 }) => ({
    data: [data.toString('base64'), 'base64'],
    executable: false,
    lamports,
    owner,
    rentEpoch: 0,
    space: data.length,
  });
  const matches = (data, filters = []) =>
    filters.every((f) => {
      if (f.dataSize !== undefined) return data.length === f.dataSize;
      if (!f.memcmp) return true;
      const bytes = Buffer.from(f.memcmp.bytes, 'base64');
      return data.length >= f.memcmp.offset + bytes.length && data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length).equals(bytes);
    });

  async function rpc(init) {
    const { id, method, params } = JSON.parse(init.body);
    calls.push(method);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    const context = { slot: SLOT };
    switch (method) {
      case 'getSlot':
        return reply(SLOT);
      case 'getProgramAccounts': {
        const [programId, config = {}] = params;
        const value = [...accounts]
          .filter(([, a]) => a.owner === programId && matches(a.data, config.filters))
          .map(([pubkey, a]) => ({ pubkey, account: encode(a) }));
        return reply(config.withContext ? { context, value } : value);
      }
      case 'getAccountInfo': {
        const found = accounts.get(params[0]);
        return reply({ context, value: found ? encode(found) : null });
      }
      case 'getMultipleAccounts':
        return reply({ context, value: params[0].map((key) => (accounts.has(key) ? encode(accounts.get(key)) : null)) });
      case 'getTokenAccountsByOwner':
        return reply({ context, value: [] });
      default:
        throw new Error(`unscripted RPC ${method}`);
    }
  }

  const connection = new Connection(RPC, { commitment: 'confirmed', fetch: (_url, init) => rpc(init), disableRetryOnRateLimit: true });

  /**
   * A v2 wallet whose Owner is the passkey `credentialId` under `rpId`,
   * storing `key` (compressed), that has signed `counter` times: the account
   * layout sdk-legacy reads (wallet 0x21; authority 0x22, Secp256r1, role,
   * counter at 8, wallet at 16, credential hash at 48, key at 80, rpId hash
   * at 113).
   */
  function walletOf({ W, programId, credentialId, key, rpId, counter = 1 }) {
    const wallet = Keypair.generate().publicKey;
    const credentialIdHash = W.getCredentialHash(credentialId);
    const [authorityPda] = W.findAuthorityPda(wallet, credentialIdHash, programId);
    const data = Buffer.alloc(145);
    data[0] = 0x22;
    data[1] = 1;
    data[2] = 0;
    data.writeUInt32LE(counter, 8);
    wallet.toBuffer().copy(data, 16);
    Buffer.from(credentialIdHash).copy(data, 48);
    Buffer.from(key).copy(data, 80);
    sha256(rpId).copy(data, 113);
    accounts.set(authorityPda.toBase58(), { owner: programId.toBase58(), data });
    const walletData = Buffer.alloc(48);
    walletData[0] = 0x21;
    accounts.set(wallet.toBase58(), { owner: programId.toBase58(), data: walletData });
    return { wallet, vault: W.findVaultPda(wallet, programId)[0] };
  }

  return { connection, accounts, calls, walletOf };
}
