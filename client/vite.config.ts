import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';

// In dev the client is served by Vite while APIs, GLBs, and WebSockets come from the node game server.
// GAME_SERVER_URL selects that backend (default 8080); browser code remains same-origin in dev/prod.
//
// Multi-page build, served by clean paths:
//   /            → index.html        (branded home/lobby)
//   /play.html   → play.html         (the racer)
//   /editor      → editor/index.html (the unified Level Editor)
//   /garage      → garage/index.html (the model viewer + configurator)
// Dev server only: Vite resolves folder-index pages at the TRAILING-SLASH path
// (`/editor/` → editor/index.html) but lets bare `/editor` fall through to the root page. This
// middleware redirects the bare paths to their slashed form so `/editor` and `/garage`
// work as typed. (Production static hosts serve folder index.html for the bare path natively.)
const editorIndexRedirect = () => ({
  name: 'editor-index-redirect',
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { writeHead: (c: number, h: Record<string, string>) => void; end: () => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/editor' || url === '/garage') {
        res.writeHead(301, { Location: url + '/' }); res.end(); return;
      }
      next();
    });
  },
});

export default defineConfig(({ mode }) => {
  const gameServer = loadEnv(mode, __dirname, '').GAME_SERVER_URL || 'http://localhost:8080';
  return {
    root: __dirname,
    plugins: [editorIndexRedirect()],
    server: {
      proxy: {
        '/api': { target: gameServer, changeOrigin: true },
        '/game': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/battle': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/voice': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        // GLB models live in the repo-root assets/ served by the node server, so /assets is proxied.
        // EXCEPT monster sprites, which live in client/public/assets/monsters/ and are served by Vite.
        '/assets': {
          target: gameServer, changeOrigin: true,
          bypass: (req) => {
            const url = (req.url ?? '').split('?')[0] ?? '';
            return url.startsWith('/assets/monsters/') ? url : undefined;
          },
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          home: resolve(__dirname, 'index.html'),                  // branded landing/lobby
          play: resolve(__dirname, 'play.html'),                    // the racer
          monsters: resolve(__dirname, 'monsters.html'),           // Voice Monsters (the battler)
          editor: resolve(__dirname, 'editor/index.html'),          // unified Level Editor (/editor)
          garage: resolve(__dirname, 'garage/index.html'),          // model viewer + configurator (/garage)
        },
      },
    },
  };
});

function bypassNonWebSocket(req: { url?: string; headers: { upgrade?: string } }): string | undefined {
  return req.headers.upgrade?.toLowerCase() === 'websocket' ? undefined : req.url;
}
