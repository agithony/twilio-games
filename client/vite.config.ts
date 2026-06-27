import { defineConfig } from 'vite';
import { resolve } from 'path';

// In dev the client is served by vite (5173) but the manifest API and GLB
// assets are served by the node game server (default 8080). Proxy the
// relative paths the client fetches so the same code works in dev and when
// the node server serves the built bundle in prod.
//
// Multi-page build: the game (index.html) and the model editor
// (editor/editor.html) are both rollup inputs so `vite build` emits both.
export default defineConfig({
  root: __dirname,
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/assets': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor/editor.html'),
      },
    },
  },
});
