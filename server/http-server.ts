import http from 'http';
import path from 'node:path';
import { readFile, writeFile, readdir, rename, mkdir } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { GameServer } from './game-server';
import { ConversationRelayAdapter } from './conversation-relay';
import { twimlGatherRoomCode, twimlConnectRelay, twimlMessage, twimlEmpty } from './twiml';
import { validateTwilioSignature } from './twilio-signature';
import { ManifestStore } from './manifest-store';
import { parseManifest } from '../shared/asset-manifest';
import { mergeMapConfig } from '../shared/maps-store';
import { appendResults, parseLeaderboard, topEntries } from '../shared/leaderboard-store';
import { SmsConcierge, type ConciergeRoom } from './sms-concierge';

export class HttpServer {
  private server: http.Server;
  private game: GameServer;
  private voiceWss: WebSocketServer;
  private readonly port: number;
  private readonly authToken?: string;
  private readonly publicBaseUrl: string;
  private readonly validateSignatures: boolean;
  private manifestStore: ManifestStore;
  private readonly mapsPath: string;
  private readonly leaderboardPath: string;
  private readonly editorToken?: string;
  /** The Vite-built client directory served in production (one-process container). */
  private readonly clientDir: string;
  /** Cached selectable cars/maps for the lobby (refreshed from manifest + maps.json periodically). */
  private roomConfigCache: { carCount: number; maps: string[] } = { carCount: 0, maps: [] };
  private roomConfigTimer: ReturnType<typeof setInterval> | null = null;
  /** Serializes leaderboard writes so two near-simultaneous race finishes can't clobber each other. */
  private leaderboardWrite: Promise<void> = Promise.resolve();
  /** SMS concierge (per-phone onboarding + car/map selection). */
  private concierge: SmsConcierge;
  /** Cached car display names (manifest order) for concierge confirmations; refreshed with config. */
  private carNamesCache: string[] = [];
  /** Per-phone reply lock so two rapid texts from one number serialize (read-modify-write safety). */
  private smsLocks = new Map<string, Promise<void>>();
  private smsSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    port: number;
    authToken?: string;
    publicBaseUrl: string;
    broadcastHz?: number;
    validateSignatures?: boolean;
    manifestPath?: string;   // injectable so tests don't clobber the real assets/manifest.json
    mapsPath?: string;       // injectable so tests don't clobber the real assets/maps/maps.json
    leaderboardPath?: string;// injectable; persistent global leaderboard JSON (default data/leaderboard.json)
    editorToken?: string;    // when set, /api writes require ?token= or x-editor-token; open if unset
    clientDir?: string;      // the Vite-built client to serve (prod single-process); default client/dist
  }) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.validateSignatures = opts.validateSignatures ?? true;
    this.manifestStore = new ManifestStore(opts.manifestPath ?? 'assets/manifest.json');
    this.mapsPath = opts.mapsPath ?? 'assets/maps/maps.json';
    this.leaderboardPath = opts.leaderboardPath ?? 'data/leaderboard.json';
    this.editorToken = opts.editorToken;
    this.clientDir = opts.clientDir ?? 'client/dist';
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        console.error('request handler error:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      });
    });
    this.game = new GameServer({ server: this.server, broadcastHz: opts.broadcastHz });
    // Feed newly-created rooms the selectable cars (manifest) + maps (maps.json). Reads are async
    // and the provider is sync, so keep a cache refreshed at startup + on an interval; rooms read
    // the cache. Empty until the first refresh resolves (rooms then reconfigure on next create).
    this.game.setRoomConfigProvider(() => this.roomConfigCache);
    void this.refreshRoomConfig();
    this.roomConfigTimer = setInterval(() => void this.refreshRoomConfig(), 5000);
    // Persist each finished race onto the global leaderboard (serialized, atomic).
    this.game.setOnRaceFinished((room) => this.persistRaceResults(room.selectedMap, room.results()));
    // SMS concierge: resolves a room code to a live Room wrapped as a ConciergeRoom (adds car names).
    this.concierge = new SmsConcierge({ findRoom: (code) => this.conciergeRoom(code) });
    this.smsSweepTimer = setInterval(() => this.concierge.sweep(), 5 * 60 * 1000);
    this.voiceWss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/voice') {
        this.voiceWss.handleUpgrade(req, socket, head, (ws) => this.onVoiceConnection(ws));
      } else if (path === '/game') {
        this.game.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  /** Refresh the cached lobby choices: car count + names from the manifest, map keys from maps.json. */
  private async refreshRoomConfig(): Promise<void> {
    let carCount = 0, maps: string[] = [], carNames: string[] = [];
    try {
      const m = await this.manifestStore.read();
      carCount = m.cars.length;
      carNames = m.cars.map(r => r.name?.trim() || r.file.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim());
    } catch { /* keep prior */ }
    try {
      const all = JSON.parse(await readFile(this.mapsPath, 'utf8'));
      if (all && typeof all === 'object') maps = Object.keys(all);
    } catch { /* keep prior */ }
    this.roomConfigCache = { carCount: carCount || this.roomConfigCache.carCount, maps: maps.length ? maps : this.roomConfigCache.maps };
    if (carNames.length) this.carNamesCache = carNames;
  }

  /** Wrap a live game Room as a ConciergeRoom (adds car names/count from the cached manifest). */
  private conciergeRoom(code: string): ConciergeRoom | null {
    const room = this.game.findRoom(code) ?? this.game.getOrCreateRoom(code);
    if (!room) return null;
    const carNames = this.carNamesCache;
    return {
      get phase() { return room.phase; },
      get mapChoices() { return room.mapChoices; },
      carNames,
      carCount: this.roomConfigCache.carCount || carNames.length,
      addPlayer: (name) => room.addPlayer(name),
      setPlayerInfo: (id, info) => room.setPlayerInfo(id, info),
      selectCar: (id, idx) => room.selectCar(id, idx),
      selectMap: (m) => room.selectMap(m),
      removePlayer: (id) => room.removePlayer(id),
    };
  }

  /** Append one finished race's standings to the persistent global leaderboard (serialized + atomic).
   *  Best-effort: a write failure is logged, never thrown (a race result is not worth crashing over). */
  private persistRaceResults(map: string | null, results: import('../shared/types').RaceResult[]): void {
    if (!map || results.length === 0) return;
    const at = Date.now();
    // Chain onto the previous write so concurrent finishes serialize (read-modify-write safety).
    this.leaderboardWrite = this.leaderboardWrite.then(async () => {
      let existing = '';
      try { existing = await readFile(this.leaderboardPath, 'utf8'); } catch { existing = ''; }
      const out = appendResults(existing, { map, results, at });
      if (!out.ok) { console.error('leaderboard append refused:', out.error); return; }
      try { await this.writeFileAtomic(this.leaderboardPath, JSON.stringify(out.entries)); }
      catch (e) { console.error('leaderboard write failed:', (e as Error).message); }
    }).catch((e) => console.error('leaderboard persist error:', e));
  }

  /** Run an SMS handler serialized per phone number (chained promises keyed by `from`). */
  private async runSmsSerialized(from: string, fn: () => string): Promise<string> {
    const prior = this.smsLocks.get(from) ?? Promise.resolve();
    let result = '';
    const run = prior.then(() => { result = fn(); });
    this.smsLocks.set(from, run.catch(() => {}));
    await run;
    return result;
  }

  private onVoiceConnection(ws: WebSocket): void {
    console.log('[CR] voice WebSocket connected (Conversation Relay)');
    const adapter = new ConversationRelayAdapter({
      findOrCreateRoom: (code) => this.game.getOrCreateRoom(code),
    });
    ws.on('message', (d) => adapter.handleMessage(d.toString()));
    ws.on('close', () => { console.log('[CR] voice WebSocket closed'); adapter.handleClose(); });
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    // Unauthenticated liveness probe for the ACA deploy smoke + container health checks.
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'ok', rooms: this.game.roomCount }));
      return;
    }
    if (req.method === 'POST' && (path === '/voice/incoming' || path === '/voice/join')) {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      const fullUrl = `${this.publicBaseUrl}${path}`;
      if (this.validateSignatures) {
        if (!this.authToken) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const sig = req.headers['x-twilio-signature'];
        const ok = validateTwilioSignature({
          authToken: this.authToken,
          signature: Array.isArray(sig) ? sig[0] : sig,
          url: fullUrl,
          params,
        });
        if (!ok) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      const xml = path === '/voice/incoming'
        ? twimlGatherRoomCode({ actionUrl: `${this.publicBaseUrl}/voice/join` })
        : twimlConnectRelay({
            wsUrl: `${this.publicBaseUrl.replace(/^http/, 'ws')}/voice`,
            sessionEndedUrl: `${this.publicBaseUrl}/voice/session-ended`,
            roomCode: (params['Digits'] ?? '').trim() || '0000',
          });
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(xml);
      return;
    }
    if (req.method === 'POST' && path === '/voice/session-ended') {
      res.writeHead(204).end();
      return;
    }
    // ---- SMS concierge: onboarding + car/map selection by text ----
    if (req.method === 'POST' && path === '/sms') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authToken) { res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured'); return; }
        const sig = req.headers['x-twilio-signature'];
        const ok = validateTwilioSignature({ authToken: this.authToken,
          signature: Array.isArray(sig) ? sig[0] : sig, url: `${this.publicBaseUrl}/sms`, params });
        if (!ok) { res.writeHead(403).end('invalid signature'); return; }
      }
      const from = (params['From'] ?? '').trim();
      const smsBody = params['Body'] ?? '';
      const messageSid = params['MessageSid'] ?? '';
      // Media (MMS) isn't supported — reply politely without invoking the state machine.
      if ((parseInt(params['NumMedia'] ?? '0', 10) || 0) > 0) {
        res.writeHead(200, { 'Content-Type': 'text/xml' }).end(
          twimlMessage('Images are not supported. Reply with the car or map number from the screen.'));
        return;
      }
      if (!from) { res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twimlEmpty()); return; }
      // Serialize per-phone so two rapid texts can't race on the same session/room mutation.
      const reply = await this.runSmsSerialized(from, () => this.concierge.handle({ from, body: smsBody, messageSid }));
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twimlMessage(reply));
      return;
    }
    // ---- manifest API ----
    if (path === '/api/manifest' && req.method === 'GET') {
      const m = await this.manifestStore.read();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(m));
      return;
    }
    if (path === '/api/manifest' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const body = await readBody(req);
      const m = parseManifest(body);            // tolerant: validates + drops bad parts
      await this.manifestStore.write(m);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(m));
      return;
    }
    // ---- list available top-level GLB files (for the editor's role dropdowns) ----
    if (path === '/api/assets' && req.method === 'GET') {
      let files: string[] = [];
      try {
        const entries = await readdir('assets', { withFileTypes: true });
        files = entries
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.glb'))
          .map((e) => e.name)
          .sort();
      } catch { files = []; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(files));
      return;
    }
    // ---- list available MAP GLB files (for the New-level map picker) ----
    if (path === '/api/map-files' && req.method === 'GET') {
      let files: string[] = [];
      try {
        const entries = await readdir('assets/maps', { withFileTypes: true });
        files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.glb'))
          .map((e) => e.name).sort();
      } catch { files = []; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(files));
      return;
    }
    // ---- delete OR rename a level ----
    if (path === '/api/maps' && req.method === 'DELETE') {
      if (!this.authorizeWrite(req, res)) return;
      const url = new URL(req.url ?? '', 'http://localhost');
      const key = url.searchParams.get('map');
      if (!key) { res.writeHead(400).end('missing map'); return; }
      let all: Record<string, unknown> = {};
      try { all = JSON.parse(await readFile(this.mapsPath, 'utf8')); }
      catch { res.writeHead(409).end('maps file unreadable — refusing to modify'); return; }
      delete all[key];
      await this.writeFileAtomic(this.mapsPath, JSON.stringify(all, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(all));
      return;
    }
    // ---- global leaderboard (best finish times, all-time) ----
    if (path === '/api/leaderboard' && req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://localhost');
      const map = url.searchParams.get('map') ?? undefined;
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '10', 10) || 10));
      let entries = [] as ReturnType<typeof parseLeaderboard>;
      try { entries = parseLeaderboard(await readFile(this.leaderboardPath, 'utf8')); } catch { entries = []; }
      const top = topEntries(entries, { map, limit });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ entries: top }));
      return;
    }
    // ---- map configs (level layouts authored in /editor) ----
    if (path === '/api/maps' && req.method === 'GET') {
      let body = '{}';
      try { body = await readFile(this.mapsPath, 'utf8'); } catch { body = '{}'; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    if (path === '/api/maps' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const raw = await readBody(req);
      let cfg: unknown;
      try { cfg = JSON.parse(raw); } catch { res.writeHead(400).end('bad json'); return; }
      // Read the CURRENT file and merge SAFELY: validate the posted config, refuse to proceed if
      // the existing file is corrupt (so we never silently wipe other levels), reject unsafe keys.
      let existing = '';
      try { existing = await readFile(this.mapsPath, 'utf8'); } catch { /* first save → empty */ }
      const merged = mergeMapConfig(existing, cfg);
      if (!merged.ok) { res.writeHead(400).end(merged.error); return; }
      await this.writeFileAtomic(this.mapsPath, JSON.stringify(merged.maps, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(merged.maps));
      return;
    }
    // ---- static assets (built JS bundles AND GLB models, both under /assets/) ----
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      return this.serveAsset(path, res);
    }
    // ---- the built client (HTML pages, /brand, /fonts, etc.) ----
    if (req.method === 'GET') {
      return this.serveClient(path, res);
    }
    res.writeHead(404).end('not found');
  }

  /**
   * Gate a disk-writing /api endpoint. When editorToken is set (production/public deploy) the
   * request must present it via ?token= or the x-editor-token header; on mismatch we 401 and
   * return false. When no token is configured (local dev) writes are open. Sends the response on
   * failure so callers can early-return.
   */
  private authorizeWrite(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.editorToken) return true;   // dev: no token configured → open
    const header = req.headers['x-editor-token'];
    const headerTok = Array.isArray(header) ? header[0] : header;
    const url = new URL(req.url ?? '', 'http://localhost');
    const tok = headerTok ?? url.searchParams.get('token') ?? '';
    if (tok === this.editorToken) return true;
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end('unauthorized');
    return false;
  }

  /** Write a file atomically (temp file + rename) so a crash mid-write can't truncate/corrupt it.
   *  Ensures the parent directory exists (e.g. data/ for the leaderboard on first run). */
  private async writeFileAtomic(file: string, contents: string): Promise<void> {
    const dir = path.dirname(file);
    if (dir && dir !== '.') await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, contents);
    await rename(tmp, file);   // rename is atomic on the same filesystem
  }

  /**
   * Serve a /assets/<rel> request. TWO things live under /assets/ in production: the Vite-built JS
   * bundles (client/dist/assets/, hashed names) and the GLB models (repo-root assets/, named files).
   * In dev Vite owned the JS and proxied the rest; in the single-process container the Node server
   * serves both. Try the built client first (hashed JS), then fall back to the repo models — the
   * filenames never collide (hashed vs. named), so first-match-wins is safe.
   */
  private async serveAsset(urlPath: string, res: http.ServerResponse): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath.replace(/^\/assets\//, '')); }
    catch { res.writeHead(400).end('bad request'); return; }   // malformed %-escape
    if (rel.includes('..') || rel.startsWith('/')) { res.writeHead(403).end('forbidden'); return; }
    for (const base of [path.join(this.clientDir, 'assets'), 'assets']) {
      try {
        const data = await readFile(path.join(base, rel));
        res.writeHead(200, { 'Content-Type': contentType(rel), 'Access-Control-Allow-Origin': '*' });
        res.end(data); return;
      } catch { /* try next base */ }
    }
    res.writeHead(404).end('not found');
  }

  /**
   * Serve the built client: the home page at `/`, `/play.html`, the folder-index pages `/editor` and
   * `/garage` (bare path → <dir>/index.html, matching the dev redirect), and any other static file
   * (/brand, /fonts, etc.). Path-traversal guarded to clientDir. Unknown paths 404 (this is a game
   * server, not an SPA — no catch-all index fallback).
   */
  private async serveClient(urlPath: string, res: http.ServerResponse): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath); } catch { res.writeHead(400).end('bad request'); return; }
    if (rel.includes('..')) { res.writeHead(403).end('forbidden'); return; }
    // Map bare paths to files: '/' and '/editor' → index.html; '/garage' → garage/index.html.
    let file: string;
    if (rel === '/' || rel === '') file = 'index.html';
    else if (rel === '/editor' || rel === '/editor/') file = 'editor/index.html';
    else if (rel === '/garage' || rel === '/garage/') file = 'garage/index.html';
    else file = rel.replace(/^\/+/, '');
    try {
      const data = await readFile(path.join(this.clientDir, file));
      res.writeHead(200, { 'Content-Type': contentType(file) });
      res.end(data);
    } catch { res.writeHead(404).end('not found'); }
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.roomConfigTimer) { clearInterval(this.roomConfigTimer); this.roomConfigTimer = null; }
      if (this.smsSweepTimer) { clearInterval(this.smsSweepTimer); this.smsSweepTimer = null; }
      this.game.stopLoopOnly();
      this.server.close(() => resolve());
    });
  }
}

/** Map a filename to a Content-Type for the static server (covers the built client + GLB models). */
function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.woff2': return 'font/woff2';
    case '.woff': return 'font/woff';
    case '.ttf': return 'font/ttf';
    case '.glb': return 'model/gltf-binary';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const MAX = 64 * 1024;
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
