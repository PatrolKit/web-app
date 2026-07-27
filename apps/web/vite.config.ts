import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Serve landing.html for the root URL in dev, bypassing the SPA entry point
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
