/** Loopback development server for a Protocol cutover rehearsal. */
import fs from 'node:fs';
import { defineConfig, type PluginOption, type UserConfig } from 'vite';
import upstream from './vite.config';

const rpc = new URL(process.env.LAZORKIT_PROTOCOL_LOCAL_RPC ?? 'http://127.0.0.1:8899');
if (rpc.protocol !== 'http:' || rpc.hostname !== '127.0.0.1' || !rpc.port
    || rpc.username || rpc.password || rpc.pathname !== '/' || rpc.search || rpc.hash) {
  throw new Error('LAZORKIT_PROTOCOL_LOCAL_RPC must be an HTTP loopback RPC URL with a port');
}
// Both network labels resolve to the rehearsal validator.
process.env.RPC_MAINNET_URL = rpc.origin;
process.env.RPC_DEVNET_URL = rpc.origin;

const base = upstream as UserConfig;

function withoutMkcert(plugins: PluginOption[] | undefined): PluginOption[] {
  return (plugins ?? []).flat(Infinity as 1).filter((plugin) => {
    const name = plugin && typeof plugin === 'object' && 'name' in plugin ? String(plugin.name) : '';
    return !name.includes('mkcert');
  }) as PluginOption[];
}

const port = Number(process.env.PORTAL_PORT ?? 5310);
const cert = process.env.LK_HTTPS_CERT;
const key = process.env.LK_HTTPS_KEY;

export default defineConfig({
  ...base,
  plugins: withoutMkcert(base.plugins),
  cacheDir: 'node_modules/.vite-local-stack',
  optimizeDeps: { ...base.optimizeDeps, entries: ['index.html'] },
  // In dev, vite swaps `buffer` for its node-builtin stub unless the npm
  // package is named explicitly ("Module "buffer" has been externalized"), and
  // @solana/web3.js then finds no Buffer. The production build bundles the
  // npm package, so this keeps dev the same as what portal.lazor.sh serves.
  resolve: { ...base.resolve, alias: { ...(base.resolve?.alias as Record<string, string>), buffer: 'buffer/' } },
  server: {
    ...base.server,
    host: '127.0.0.1',
    port,
    strictPort: true,
    https: cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : undefined,
  },
});
