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
          // SPA fallback: rewrite /app/* to /index.html so Vite's pipeline
          // processes the file (injects HMR preamble, etc.) rather than us
          // serving raw bytes that bypass plugin transforms.
          const url = req.url ?? '';
          if (url.startsWith('/app') && !url.includes('.')) {
            req.url = '/index.html';
          }
          next();
        });
      },
    },
  ],
  server: {
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
