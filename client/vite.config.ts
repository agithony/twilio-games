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
const cleanIndexRoutes = () => ({
  name: 'clean-index-routes',
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { writeHead: (c: number, h: Record<string, string>) => void; end: () => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const requestUrl = req.url ?? '';
      const url = requestUrl.split('?')[0];
      if (url === '/operator' || url === '/operator/' || url === '/player' || url === '/player/') {
        req.url = `/arcade/${requestUrl.slice(url.length)}`;
        next(); return;
      }
      if (url === '/arcade' || url === '/arcade/' || url === '/arcade/index.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });res.end();return;
      }
      if (url === '/editor' || url === '/garage' || url === '/analytics' || url === '/join') {
        res.writeHead(301, { Location: `${url}/${requestUrl.slice(url.length)}` }); res.end(); return;
      }
      next();
    });
  },
});

export default defineConfig(({ mode }) => {
  const gameServer = loadEnv(mode, __dirname, '').GAME_SERVER_URL || 'http://localhost:8080';
  return {
    root: __dirname,
    plugins: [cleanIndexRoutes()],
    server: {
      proxy: {
        '/api': { target: gameServer, changeOrigin: true },
        '/auth': { target: gameServer, changeOrigin: true },
        '/game': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/battle': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/fighter': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
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
          fighter: resolve(__dirname, 'fighter.html'),              // Voice Fighter gameplay prototype
          editor: resolve(__dirname, 'editor/index.html'),          // unified Level Editor (/editor)
          garage: resolve(__dirname, 'garage/index.html'),          // model viewer + configurator (/garage)
          analytics: resolve(__dirname, 'analytics/index.html'),    // private activation analytics (/analytics)
          arcade: resolve(__dirname, 'arcade/index.html'),          // Twilio Games player and operator pages
          join: resolve(__dirname, 'join/index.html'),              // localized SMS / WhatsApp chooser
        },
      },
    },
  };
});

function bypassNonWebSocket(req: { url?: string; headers: { upgrade?: string } }): string | undefined {
  return req.headers.upgrade?.toLowerCase() === 'websocket' ? undefined : req.url;
}
