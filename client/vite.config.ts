import { defineConfig } from 'vite';
import { resolve } from 'path';

// In dev the client is served by vite (5173) but the manifest API and GLB
// assets are served by the node game server (default 8080). Proxy the
// relative paths the client fetches so the same code works in dev and when
// the node server serves the built bundle in prod.
//
// Multi-page build: the branded home/lobby (index.html), the racer
// (play.html), and the model editor (editor/editor.html) are all rollup
// inputs so `vite build` emits each.
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
        home: resolve(__dirname, 'index.html'),       // branded landing/lobby
        play: resolve(__dirname, 'play.html'),         // the racer (was index.html)
        editor: resolve(__dirname, 'editor/editor.html'),
        maptest: resolve(__dirname, 'maptest.html'),   // map/track GLB inspector
        align: resolve(__dirname, 'align.html'),        // in-game-space map align tool
      },
    },
  },
});
