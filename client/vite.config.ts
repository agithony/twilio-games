import { defineConfig } from 'vite';

// In dev the client is served by vite (5173) but the manifest API and GLB
// assets are served by the node game server (default 8080). Proxy the
// relative paths the client fetches so the same code works in dev and when
// the node server serves the built bundle in prod.
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/assets': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
