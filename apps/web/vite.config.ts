import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
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
          const NON_SPA = /^\/(api|@|node_modules|__vite|\.)/;
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
    },
  },
  resolve: {
    alias: {
      '@patrolkit/contracts': path.resolve(__dirname, '../api/src/contracts'),
    },
  },
});
