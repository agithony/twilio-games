import http from 'http';
import path from 'node:path';
import { readFile, writeFile, readdir, rename, mkdir } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { GameServer } from './game-server';
import { ConversationRelayAdapter } from './conversation-relay';
import { twimlGatherRoomCode, twimlConnectRelay } from './twiml';
import { validateTwilioSignature } from './twilio-signature';
import { ManifestStore } from './manifest-store';
import { parseManifest } from '../shared/asset-manifest';
import { mergeMapConfig } from '../shared/maps-store';
import { appendResults, parseLeaderboard, topEntries } from '../shared/leaderboard-store';

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
  /** Cached selectable cars/maps for the lobby (refreshed from manifest + maps.json periodically). */
  private roomConfigCache: { carCount: number; maps: string[] } = { carCount: 0, maps: [] };
  private roomConfigTimer: ReturnType<typeof setInterval> | null = null;
  /** Serializes leaderboard writes so two near-simultaneous race finishes can't clobber each other. */
  private leaderboardWrite: Promise<void> = Promise.resolve();

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
  }) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.validateSignatures = opts.validateSignatures ?? true;
    this.manifestStore = new ManifestStore(opts.manifestPath ?? 'assets/manifest.json');
    this.mapsPath = opts.mapsPath ?? 'assets/maps/maps.json';
    this.leaderboardPath = opts.leaderboardPath ?? 'data/leaderboard.json';
    this.editorToken = opts.editorToken;
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

  /** Refresh the cached lobby choices: car count from the manifest, map keys from maps.json. */
  private async refreshRoomConfig(): Promise<void> {
    let carCount = 0, maps: string[] = [];
    try { carCount = (await this.manifestStore.read()).cars.length; } catch { /* keep prior */ }
    try {
      const all = JSON.parse(await readFile(this.mapsPath, 'utf8'));
      if (all && typeof all === 'object') maps = Object.keys(all);
    } catch { /* keep prior */ }
    this.roomConfigCache = { carCount: carCount || this.roomConfigCache.carCount, maps: maps.length ? maps : this.roomConfigCache.maps };
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
    // ---- static assets (GLB etc.) ----
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      return this.serveAsset(path, res);
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

  private async serveAsset(urlPath: string, res: http.ServerResponse): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath.replace(/^\/assets\//, '')); }
    catch { res.writeHead(400).end('bad request'); return; }   // malformed %-escape
    if (rel.includes('..') || rel.startsWith('/')) { res.writeHead(403).end('forbidden'); return; }
    const full = path.join('assets', rel);
    try {
      const data = await readFile(full);
      const type = rel.endsWith('.glb') ? 'model/gltf-binary'
                 : rel.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
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
      this.game.stopLoopOnly();
      this.server.close(() => resolve());
    });
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
