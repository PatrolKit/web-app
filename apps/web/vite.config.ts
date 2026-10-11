import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

/**
 * This build's id: when it was built, and from which commit. Baked into the
 * bundle as `__BUILD_ID__` and written beside it as `version.json`, so an open
 * page can tell when the server has a newer build (the "new version" banner).
 * `dev` under `vite` serve, where hot reload already keeps the page current.
 */
function buildId(): string {
  let sha = 'nogit';
  try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }
  return `${new Date().toISOString()}-${sha}`;
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const BUILD_ID = command === 'build' ? buildId() : 'dev';
  return {
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    {
      name: 'version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) });
      },
    },
    {
      name: 'root-landing-page',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '') {
            const landingPath = path.resolve(__dirname, 'public/landing.html');
            const content = fs.readFileSync(landingPath, 'utf-8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.statusCode = 200;
            res.end(content);
            return;
          }
          // SPA fallback: rewrite known SPA paths so Vite's pipeline processes
          // index.html (injects HMR preamble) rather than returning a 404.
          const url = req.url ?? '';
          // `healthz`/`readyz` are named because they are the one pair of
          // server routes that deliberately sits outside `/api` — this rewrite
          // runs before the proxy, so without them the dev server answers a
          // health probe with index.html, and a 200 of HTML reads as a healthy
          // server to curl and as a broken one to anything parsing JSON.
          const NON_SPA = /^\/(api|healthz|readyz|@|node_modules|__vite|\.)/;
          if (!url.includes('.') && !NON_SPA.test(url)) {
            req.url = '/index.html';
          }
          next();
        });
      },
    },
  ],
  server: {
    host: true, // bind to 0.0.0.0 so LAN devices (e.g. iOS) can reach the dev server
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // Health probes deliberately sit outside the /api prefix, so they need
      // naming here or the dev server answers them with index.html — which is
      // a 200, and would make the "server unreachable" banner never fire.
      '/healthz': { target: 'http://localhost:4000', changeOrigin: true },
      '/readyz': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@patrolkit/contracts': path.resolve(__dirname, '../api/src/contracts'),
    },
  },
  };
});
