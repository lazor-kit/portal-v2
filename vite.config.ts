import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import Mkcert from 'vite-plugin-mkcert'
import tailwindcss from '@tailwindcss/vite'
import path from "path"

/**
 * Serves the functions in api/ during `vite dev`, the way the host serves
 * them in production. The dev server's own origin is the allowed caller.
 */
function localApi(): Plugin {
  return {
    name: 'portal-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const route = /^\/api\/([a-z-]+)(?:\?|$)/.exec(req.url ?? '')?.[1];
        if (!route) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${route}.ts`);
          const handler = mod[req.method ?? 'GET'];
          if (typeof handler !== 'function') {
            res.statusCode = 405;
            return res.end();
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const origin = `${server.config.server.https ? 'https' : 'http'}://${req.headers.host}`;
          process.env.PORTAL_ORIGIN ??= origin;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          const request = new Request(new URL(req.url ?? '/', origin), {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          });
          const response: Response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(),
  Mkcert({
    hosts: ['localhost'],
  }),
  tailwindcss(),
  localApi(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer']
  },
  server: {
    port: 3000,
    host: true,
  }
});
