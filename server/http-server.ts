import http from 'http';
import path from 'node:path';
import zlib from 'node:zlib';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, rename, mkdir, stat } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { GameServer } from './game-server';
import { BattleServer } from './battle-server';
import { FighterServer } from './fighter-server';
import { ConversationRelayAdapter } from './conversation-relay';
import { twimlConnectRelay, twimlMessage, twimlEmpty } from './twiml';
import { validateTwilioSignature } from './twilio-signature';
import { ManifestStore } from './manifest-store';
import { parseManifest } from '../shared/asset-manifest';
import { mergeMapConfig } from '../shared/maps-store';
import { seedMapsPlan } from './maps-seed';
import { DEFAULT_ROOM } from '../shared/constants';
import { appendResults, parseLeaderboard, topEntries, type LeaderboardEntry } from '../shared/leaderboard-store';
import { speechSafeText } from '../shared/speech-text';
import { SmsConcierge, type ConciergeRoom } from './sms-concierge';
import { OpenAiClient, NullLlmClient, type LlmClient, type LlmTurn } from './llm';
import { hostTurn, matchChoice, clearSelectionIndex, type HostContext } from './game-host';
import { BattleVoiceSession, parseSpokenName, isAdvanceWord, type BattleVoiceSnapshot } from './battle-voice';
import { FighterVoiceSession, type FighterVoiceSnapshot } from './fighter-voice';
import { battleHostTurn, type BattleHostContext } from './battle-host';
import { monsterById, rosterEntries } from '../shared/monster-roster';
import type { Room } from './room';
import type { RaceResult } from '../shared/types';
import { FIGHTER_MAPS, FIGHTER_ROSTER, type FighterMapEntry } from '../shared/fighter-roster';
import { parseFighterMaps } from '../shared/fighter-maps';

const VOICE_RACER_CONTROLS_INTRO = 'Before you start, check the controls on the screen. Say left or right to steer. Say boost to speed up. Say brake to slow down. Say nitro to break through a wall.';
const BATTLE_VOICE_RECONNECT_GRACE_MS = 30_000;
const FIGHTER_VOICE_RECONNECT_GRACE_MS = 30_000;

interface BattleVoiceCallBinding {
  code: string;
  playerId: string;
  activeSession: BattleVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
interface FighterVoiceCallBinding {
  code: string; playerId: string; activeSession: FighterVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}

export class HttpServer {
  private server: http.Server;
  private game: GameServer;
  private battle: BattleServer;
  private fighter: FighterServer;
  private voiceWss: WebSocketServer;
  private readonly port: number;
  private readonly authToken?: string;
  private readonly publicBaseUrl: string;
  private readonly validateSignatures: boolean;
  private manifestStore: ManifestStore;
  private readonly mapsPath: string;
  /** Image-bundled default levels, copied into `mapsPath` ONCE on first boot (when the persistent
   *  file is absent/blank/corrupt). Unset in tests + local dev so no seeding happens there. */
  private readonly bundledMapsPath?: string;
  /** LIVE Voice Monsters arena config (transform/camera/spin); persistent-mount default. */
  private readonly arenaPath: string;
  private readonly bundledArenaPath?: string;
  private readonly leaderboardPath: string;
  private readonly editorToken?: string;
  /** The Vite-built client directory served in production (one-process container). */
  private readonly clientDir: string;
  /** Phone number players CALL to join (from GAME_PHONE_NUMBER). '' = unset → the lobby shows a
   *  placeholder. Exposed to the client via GET /api/config so the lobby QR + copy show the real number. */
  private readonly gamePhoneNumber: string;
  /** ElevenLabs voiceId for Conversation Relay talk-back (greeting/countdown/result). From the
   *  CR_TTS_VOICE env; empty → Relay's default voice (talk-back text still sends, just in the default
   *  voice). A high-energy announcer voiceId is the intended default set in deploy config. */
  private readonly crVoice: string;
  private readonly voiceRelayToken: string;
  /** Cached selectable cars/maps for the lobby (refreshed from manifest + maps.json periodically). */
  private roomConfigCache: { carCount: number; maps: string[]; carNames: string[] } = { carCount: 0, maps: [], carNames: [] };
  private roomConfigTimer: ReturnType<typeof setInterval> | null = null;
  /** Cached leaderboard rows. Host context filters this by the room's selected map, so the AI answers
   *  with the same track-specific board shown on screen instead of a stale/global record. */
  private leaderboardEntriesCache: LeaderboardEntry[] = [];
  /** Serializes leaderboard writes so two near-simultaneous race finishes can't clobber each other. */
  private leaderboardWrite: Promise<void> = Promise.resolve();
  /** SMS concierge (per-phone onboarding + car/map selection). */
  private concierge: SmsConcierge;
  /** Cached car display names (manifest order) for concierge confirmations; refreshed with config. */
  private carNamesCache: string[] = [];
  /** Per-phone reply lock so two rapid texts from one number serialize (read-modify-write safety). */
  private smsLocks = new Map<string, Promise<void>>();
  private smsSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Voice talk-back registry: roomCode → the live ConversationRelay adapters (callers) in that room.
   *  The game loop's per-room events (onRoomEvents) are fanned to these so callers hear countdown/
   *  go/their finish. Each adapter speaks the caller-relevant subset. */
  private voiceAdapters = new Map<string, Set<ConversationRelayAdapter>>();
  /** Voice Monsters talk-back registry: roomCode → live battle call sessions, fed battle events so
   *  callers hear commentary (super-effective/crit/faint/win). Parallel to voiceAdapters (the racer). */
  private battleVoice = new Map<string, Set<BattleVoiceSession>>();
  /** Conversation Relay may reconnect the WS for the same phone call. Keep callSid → player binding
   *  briefly so a transport reconnect resumes the active battle instead of re-running onboarding. */
  private battleVoiceCallBindings = new Map<string, BattleVoiceCallBinding>();
  private fighterVoice = new Map<string, Set<FighterVoiceSession>>();
  private fighterVoiceCallBindings = new Map<string, FighterVoiceCallBinding>();
  private lastGameWsAt = 0;
  private lastBattleWsAt = 0;
  private lastFighterWsAt = 0;
  private fighterMaps: FighterMapEntry[] = FIGHTER_MAPS;
  private readonly fighterMapsPath: string;
  private readonly bundledFighterMapsPath: string;
  private readonly fighterPreviewDir: string;
  /** The conversational AI host (OpenAI, or a null no-op when OPENAI_API_KEY is unset → scripted
   *  fallback). Turns a caller's natural-language menu utterances into spoken replies + game actions. */
  private llm: LlmClient;

  constructor(opts: {
    port: number;
    authToken?: string;
    publicBaseUrl: string;
    broadcastHz?: number;
    validateSignatures?: boolean;
    manifestPath?: string;   // injectable so tests don't clobber the real assets/manifest.json
    mapsPath?: string;       // injectable; LIVE level configs (default data/maps.json on the persistent mount)
    bundledMapsPath?: string;// image-bundled default levels; seeded into mapsPath once on first boot
    arenaPath?: string;      // injectable; LIVE Voice Monsters arena config (default data/arena.json)
    bundledArenaPath?: string;// image-bundled default arena config; seeds arenaPath on first boot
    leaderboardPath?: string;// injectable; persistent global leaderboard JSON (default data/leaderboard.json)
    editorToken?: string;    // when set, /api writes require ?token= or x-editor-token; open if unset
    clientDir?: string;      // the Vite-built client to serve (prod single-process); default client/dist
    gamePhoneNumber?: string;// the number players CALL to join (shown + QR-encoded in the lobby)
    fighterMapsPath?: string;
    bundledFighterMapsPath?: string;
    fighterPreviewDir?: string;
  }) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.validateSignatures = opts.validateSignatures ?? true;
    this.manifestStore = new ManifestStore(opts.manifestPath ?? 'assets/manifest.json');
    // LIVE levels default to the persistent mount (data/) — same fate as the leaderboard — so
    // editor-authored levels survive redeploys. The image's committed levels are the SEED source.
    this.mapsPath = opts.mapsPath ?? 'data/maps.json';
    this.bundledMapsPath = opts.bundledMapsPath;
    this.arenaPath = opts.arenaPath ?? 'data/arena.json';
    this.bundledArenaPath = opts.bundledArenaPath;
    this.leaderboardPath = opts.leaderboardPath ?? 'data/leaderboard.json';
    this.editorToken = opts.editorToken;
    if (process.env.NODE_ENV === 'production' && !this.editorToken) console.warn('[security] EDITOR_TOKEN is unset; editor writes remain open');
    this.clientDir = opts.clientDir ?? 'client/dist';
    this.gamePhoneNumber = (opts.gamePhoneNumber ?? '').trim();
    this.fighterMapsPath = opts.fighterMapsPath ?? 'data/fighter-maps.json';
    this.bundledFighterMapsPath = opts.bundledFighterMapsPath ?? 'assets/fighters/maps/maps.json';
    this.fighterPreviewDir = opts.fighterPreviewDir ?? 'data/fighter-previews';
    this.crVoice = (process.env.CR_TTS_VOICE ?? '').trim();
    this.voiceRelayToken = (process.env.VOICE_RELAY_TOKEN ?? this.authToken ?? '').trim();
    // Conversational AI host: OpenAI when OPENAI_API_KEY is set (model via OPENAI_MODEL), else a
    // null client so the game degrades gracefully to the scripted phrase-bank lines.
    const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
    this.llm = openaiKey
      ? new OpenAiClient({ apiKey: openaiKey, model: (process.env.OPENAI_MODEL ?? '').trim() || undefined })
      : new NullLlmClient();
    if (this.llm.enabled) console.log(`[LLM] conversational host ENABLED (model=${process.env.OPENAI_MODEL || 'default'})`);
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        console.error('request handler error:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      });
    });
    this.game = new GameServer({ server: this.server, broadcastHz: opts.broadcastHz });
    // Voice Monsters lives on its own /battle WebSocket (turn-based, event-driven — separate from the
    // racer's continuous-sim GameServer). Mounted on the same HTTP host so one number serves both.
    this.battle = new BattleServer({ server: this.server });
    this.fighter = new FighterServer({ server: this.server, displayToken: process.env.FIGHTER_DISPLAY_TOKEN });
    // Feed newly-created rooms the selectable cars (manifest) + maps (maps.json). Reads are async
    // and the provider is sync, so keep a cache refreshed at startup + on an interval; rooms read
    // the cache. Empty until the first refresh resolves (rooms then reconfigure on next create).
    this.game.setRoomConfigProvider(() => this.roomConfigCache);
    void this.refreshRoomConfig();
    this.roomConfigTimer = setInterval(() => void this.refreshRoomConfig(), 5000);
    // Persist each finished race onto the global leaderboard (serialized, atomic).
    this.game.setOnRaceFinished((room) => this.persistRaceResults(room.selectedMap, room.results()));
    // Fan a room's game events out to any voice callers in it (greeting/countdown/go/finish talk-back).
    this.game.setOnRoomEvents((roomCode, events) => {
      const set = this.voiceAdapters.get(roomCode);
      if (!set) return;
      for (const ev of events) for (const a of set) a.onGameEvent(ev);
    });
    // Fan Voice Monsters battle events to any voice callers in that room (commentary talk-back).
    this.battle.setOnRoomEvents((roomCode, events) => {
      const set = this.battleVoice.get(roomCode);
      if (!set) return;
      for (const ev of events) for (const s of set) s.onBattleEvent(ev);
    });
    this.battle.setOnRoomState((roomCode) => {
      const set = this.battleVoice.get(roomCode);
      if (!set) return;
      for (const s of set) s.onBattleStateChanged();
    });
    this.fighter.setOnRoomEvents((roomCode, events) => {
      const set = this.fighterVoice.get(roomCode); if (!set) return;
      for (const event of events) for (const session of set) session.onFighterEvent(event);
    });
    this.fighter.setOnRoomState(roomCode => {
      const set = this.fighterVoice.get(roomCode); if (!set) return;
      for (const session of set) session.onStateChanged();
    });
    // SMS concierge: resolves a room code to a live Room wrapped as a ConciergeRoom (adds car names).
    this.concierge = new SmsConcierge({ findRoom: (code) => this.conciergeRoom(code) });
    this.smsSweepTimer = setInterval(() => this.concierge.sweep(), 5 * 60 * 1000);
    this.voiceWss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/voice') {
        this.voiceWss.handleUpgrade(req, socket, head, (ws) => this.onVoiceConnection(ws));
      } else if (path === '/game') {
        this.lastGameWsAt = Date.now();
        this.game.handleUpgrade(req, socket, head);
      } else if (path === '/battle') {
        this.lastBattleWsAt = Date.now();
        this.battle.handleUpgrade(req, socket, head);
      } else if (path === '/fighter') {
        this.lastFighterWsAt = Date.now();
        this.fighter.handleUpgrade(req, socket, head);
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
    this.roomConfigCache = {
      carCount: carCount || this.roomConfigCache.carCount,
      maps: maps.length ? maps : this.roomConfigCache.maps,
      carNames: carNames.length ? carNames : this.roomConfigCache.carNames,
    };
    if (carNames.length) this.carNamesCache = carNames;
    // Refresh leaderboard rows for the AI host. Best-effort: a read failure keeps prior rows.
    try {
      this.leaderboardEntriesCache = parseLeaderboard(await readFile(this.leaderboardPath, 'utf8'));
    } catch { /* keep prior rows */ }
  }

  private async refreshFighterMaps(): Promise<void> {
    let liveValid = false;
    try {
      this.fighterMaps = parseFighterMaps(JSON.parse(await readFile(this.fighterMapsPath, 'utf8'))); liveValid = true;
    } catch { /* seed/fallback below */ }
    if (!liveValid) {
      try {
        this.fighterMaps = parseFighterMaps(JSON.parse(await readFile(this.bundledFighterMapsPath, 'utf8')));
        await this.writeFileAtomic(this.fighterMapsPath, JSON.stringify(this.fighterMaps, null, 2));
        console.log(`[fighter-maps] seeded ${this.fighterMapsPath} from ${this.bundledFighterMapsPath}`);
      } catch (error) { console.error('[fighter-maps] using built-in fallback:', (error as Error).message); }
    }
    this.fighter.setMaps(this.fighterMaps);
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
      this.leaderboardEntriesCache = out.entries;
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
    // Per-CALLER conversation history (this WS only), so the AI host has context across turns.
    const history: LlmTurn[] = [];
    const adapter = new ConversationRelayAdapter({
      findOrCreateRoom: (code) => this.game.getOrCreateRoom(code),
      // SPEAK to the caller: Conversation Relay TTS-synthesizes {type:'text'} tokens onto the call.
      // `last:true` marks a complete utterance so Relay flushes it promptly.
      say: (text) => sendRelayText(ws, text),
      register: (roomCode, a) => {
        let set = this.voiceAdapters.get(roomCode);
        if (!set) { set = new Set(); this.voiceAdapters.set(roomCode, set); }
        set.add(a);
      },
      unregister: (a) => {
        for (const [code, set] of this.voiceAdapters) {
          if (set.delete(a) && set.size === 0) this.voiceAdapters.delete(code);
        }
      },
      // Drop the caller's slot + reap the room if empty (a phone caller never hits the WS reap paths).
      leaveRoom: (roomCode, playerId) => this.game.voiceLeave(roomCode, playerId),
      phaseOf: (roomCode) => this.game.findRoom(roomCode)?.phase ?? 'lobby',
      // Conversational AI turn: build the host context from the live room, run the LLM (with history),
      // return what to say. Null when the LLM is disabled → adapter stays quiet (scripted fallback).
      converse: async (roomCode, playerId, utterance) => {
        const room = this.game.findRoom(roomCode);
        if (!room) return null;
        // DETERMINISTIC fast-path: in car/map select, if the caller CLEARLY picked one (a number or a
        // strong name match, not a question), act on it immediately — no LLM round-trip, and it works
        // even with the LLM disabled. This is what makes "two" / "the second one" reliably select.
        const direct = this.directSelection(room, playerId, utterance);
        if (direct) return direct;
        if (!this.llm.enabled) return null;
        history.push({ role: 'user', content: utterance });
        const reply = await hostTurn(this.llm, this.hostContext(room, playerId), history);
        if (reply) history.push({ role: 'assistant', content: reply });
        // Bound history so a long call doesn't grow unbounded (keep the last ~12 turns).
        if (history.length > 12) history.splice(0, history.length - 12);
        return reply;
      },
    });

    // MULTI-GAME ROUTING: one number serves both games. We don't know which the caller is joining until
    // the `setup` frame. Peek it: route to Voice Monsters when the call targets the battler (an explicit
    // `game=monsters` Relay parameter, or — with none — auto-detect the battler as the game with a live
    // display and the racer idle). Otherwise the racer adapter (default, unchanged). Decided once, on
    // the first message; thereafter all frames go to the chosen handler.
    let route: 'racer' | 'battle' | 'fighter' | null = null;
    let battle: BattleVoiceSession | null = null;
    let fighter: FighterVoiceSession | null = null;
    const say = (text: string) => sendRelayText(ws, text);
    ws.on('message', (d) => {
      const raw = d.toString();
      if (route === null && this.voiceRelayToken) {
        try {
          if (String(JSON.parse(raw)?.customParameters?.relayToken ?? '') !== this.voiceRelayToken) { ws.close(1008, 'unauthorized relay'); return; }
        } catch { ws.close(1008, 'unauthorized relay'); return; }
      }
      try {
        const type = JSON.parse(raw)?.type;
        if (type === 'prompt' || type === 'interrupt') clearRelayTextQueue(ws);
      } catch { /* adapter will ignore bad frames */ }
      if (route === null) route = this.pickVoiceGame(raw);
      if (route === 'battle') {
        if (!battle) battle = this.makeBattleSession(say);
        battle.handleMessage(raw);
      } else if (route === 'fighter') {
        if (!fighter) fighter = this.makeFighterSession(say);
        fighter.handleMessage(raw);
      } else {
        adapter.handleMessage(raw);
      }
    });
    ws.on('close', () => {
      console.log('[CR] voice WebSocket closed');
      if (battle) battle.handleClose(); else if (fighter) fighter.handleClose(); else adapter.handleClose();
    });
  }

  /** Decide which game a voice call joins, from its first frame. Explicit `game=monsters|racer` Relay
   *  parameter wins; otherwise auto-detect: the battler if ITS display is open and the racer's isn't
   *  (so whichever game is on the shared screen is the one the caller joins). Default: the racer. */
  private pickVoiceGame(firstFrame: string): 'racer' | 'battle' | 'fighter' {
    try {
      const o = JSON.parse(firstFrame);
      const g = String(o?.customParameters?.game ?? '').toLowerCase();
      if (g === 'monsters' || g === 'battle') return 'battle';
      if (g === 'fighter' || g === 'fight') return 'fighter';
      if (g === 'racer' || g === 'race') return 'racer';
    } catch { /* fall through to auto-detect */ }
    // Auto-detect: route to the game whose screen most recently opened. This avoids a stale tab for one
    // game stealing calls while the other game is currently on the projector.
    return this.recentVoiceGame();
  }

  private recentVoiceGame(): 'racer' | 'battle' | 'fighter' {
    const live: { game: 'racer' | 'battle' | 'fighter'; at: number }[] = [];
    if (this.game.connectionCount > 0) live.push({ game: 'racer', at: this.lastGameWsAt });
    if (this.battle.connectionCount > 0) live.push({ game: 'battle', at: this.lastBattleWsAt });
    if (this.fighter.connectionCount > 0) live.push({ game: 'fighter', at: this.lastFighterWsAt });
    live.sort((a, b) => b.at - a.at);
    return live[0]?.game ?? 'racer';
  }

  private makeFighterSession(say: (text: string) => void): FighterVoiceSession {
    let session: FighterVoiceSession;
    session = new FighterVoiceSession({
      say,
      join: (code, name, callSid) => {
        code = code.trim().toUpperCase();
        const resumed = this.resumeFighterVoiceCall(code, callSid, session);
        if (resumed) return { playerId: resumed, resumed: true };
        const playerId = this.fighter.voiceJoin(code, name); if (!playerId) return null;
        this.rememberFighterVoiceCall(callSid, code, playerId, session); this.registerFighterVoiceSession(code, session);
        return { playerId, resumed: false };
      },
      leave: (code, id, callSid) => { this.unregisterFighterVoiceSession(session); this.scheduleFighterVoiceLeave(code, id, callSid, session); },
      setName: (code, id, name) => this.fighter.voiceSetName(code, id, name),
      selectFighter: (code, id, fighterId) => this.fighter.voiceSelectFighter(code, id, fighterId),
      selectMap: (code, id, mapId) => this.fighter.voiceSelectMap(code, id, mapId),
      advance: (code, id) => this.fighter.voiceAdvance(code, id),
      command: (code, id, command) => this.fighter.voiceCommand(code, id, command),
      snapshot: (code, id) => this.fighterVoiceSnapshot(code, id),
    });
    return session;
  }

  private fighterVoiceSnapshot(code: string, playerId: string): FighterVoiceSnapshot | null {
    const room = this.fighter.findRoom(code); if (!room || !room.hasPlayer(playerId)) return null;
    const state = room.state(); const me = state.players.find(player => player.playerId === playerId);
    const mySide = me?.side === 'p2' ? 'p2' : 'p1'; const foeSide = mySide === 'p1' ? 'p2' : 'p1';
    const foe = state.players.find(player => player.side === foeSide);
    const playerOne = state.players.find(player => player.side === 'p1'), playerTwo = state.players.find(player => player.side === 'p2');
    const fighterName = (id: string | null | undefined) => FIGHTER_ROSTER.find(fighter => fighter.id === id)?.name ?? null;
    return { phase: state.phase, myName: me?.name ?? null, myFighterId: me?.fighterId ?? null, myFighterName: fighterName(me?.fighterId),
      foeName: foe?.name ?? null, foeFighterId: foe?.fighterId ?? null, foeFighterName: fighterName(foe?.fighterId), selectedMap: state.selectedMap,
      mySide, myHealth: state.world?.[mySide].health ?? null, foeHealth: state.world?.[foeSide].health ?? null,
      countdown: state.countdown, winnerName: state.result?.winnerName ?? null,
      winnerSide: state.result?.winner ?? null,
      playerOneName: playerOne?.name ?? null, playerOneFighterName: fighterName(playerOne?.fighterId),
      playerTwoName: playerTwo?.name ?? null, playerTwoFighterName: fighterName(playerTwo?.fighterId),
      playerCount: state.players.filter(player => !player.isAi).length,
      allFightersSelected: state.players.filter(player => !player.isAi).length > 0 && state.players.filter(player => !player.isAi).every(player => player.fighterId),
      isController: room.canControlSetup(playerId),
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: fighter.name })),
      maps: this.fighterMaps.map(map => ({ id: map.id, name: map.name })) };
  }

  private registerFighterVoiceSession(code: string, session: FighterVoiceSession): void {
    let set = this.fighterVoice.get(code); if (!set) { set = new Set(); this.fighterVoice.set(code, set); } set.add(session);
  }
  private unregisterFighterVoiceSession(session: FighterVoiceSession): void {
    for (const [code, set] of this.fighterVoice) if (set.delete(session) && set.size === 0) this.fighterVoice.delete(code);
  }
  private rememberFighterVoiceCall(callSid: string, code: string, playerId: string, session: FighterVoiceSession): void {
    const sid = callSid.trim(); if (!sid) return;
    const prior = this.fighterVoiceCallBindings.get(sid); if (prior?.leaveTimer) clearTimeout(prior.leaveTimer);
    if (prior?.activeSession && prior.activeSession !== session) { this.unregisterFighterVoiceSession(prior.activeSession); prior.activeSession.handleReplaced(); }
    if (prior && (prior.code !== code || prior.playerId !== playerId)) this.fighter.voiceLeave(prior.code, prior.playerId);
    this.fighterVoiceCallBindings.set(sid, { code, playerId, activeSession: session, leaveTimer: null });
  }
  private resumeFighterVoiceCall(code: string, callSid: string, session: FighterVoiceSession): string | null {
    const sid = callSid.trim(); if (!sid) return null;
    const binding = this.fighterVoiceCallBindings.get(sid);
    if (!binding || binding.code !== code || !this.fighter.findRoom(code)?.hasPlayer(binding.playerId)) return null;
    if (binding.leaveTimer) { clearTimeout(binding.leaveTimer); binding.leaveTimer = null; }
    if (binding.activeSession && binding.activeSession !== session) { this.unregisterFighterVoiceSession(binding.activeSession); binding.activeSession.handleReplaced(); }
    binding.activeSession = session; this.registerFighterVoiceSession(code, session); return binding.playerId;
  }
  private scheduleFighterVoiceLeave(code: string, playerId: string, callSid: string, session: FighterVoiceSession): void {
    const sid = callSid.trim(); if (!sid) { this.fighter.voiceLeave(code, playerId); return; }
    const binding = this.fighterVoiceCallBindings.get(sid);
    if (binding?.activeSession && binding.activeSession !== session) return;
    if (binding?.leaveTimer) clearTimeout(binding.leaveTimer);
    const leaveTimer = setTimeout(() => {
      const current = this.fighterVoiceCallBindings.get(sid); if (!current || current.playerId !== playerId || current.code !== code) return;
      this.fighterVoiceCallBindings.delete(sid); this.fighter.voiceLeave(code, playerId);
    }, FIGHTER_VOICE_RECONNECT_GRACE_MS);
    (leaveTimer as { unref?: () => void }).unref?.();
    this.fighterVoiceCallBindings.set(sid, { code, playerId, activeSession: null, leaveTimer });
  }
  private endFighterVoiceCall(callSid: string): void {
    const sid = callSid.trim(), binding = this.fighterVoiceCallBindings.get(sid); if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) { this.unregisterFighterVoiceSession(binding.activeSession); binding.activeSession.handleReplaced(); }
    this.fighterVoiceCallBindings.delete(sid); this.fighter.voiceLeave(binding.code, binding.playerId);
  }

  /** Build a Voice Monsters call session wired to the live BattleServer + the battle LLM host. The
   *  session registers itself in `battleVoice` on join (so it hears battle-event commentary) and
   *  unregisters on leave. */
  private makeBattleSession(say: (t: string) => void): BattleVoiceSession {
    const history: LlmTurn[] = [];
    let session: BattleVoiceSession;   // captured so join/leave can (un)register it for events
    const deps = {
      say,
      join: (code: string, name: string, callSid: string) => {
        this.battle.getOrCreateRoom(code);
        const resumed = this.resumeBattleVoiceCall(code, callSid, session);
        if (resumed) return { playerId: resumed, resumed: true };
        const id = this.battle.voiceJoin(code, name);
        if (id) {
          this.rememberBattleVoiceCall(callSid, code, id, session);
          this.registerBattleVoiceSession(code, session);
        }
        return id ? { playerId: id, resumed: false } : null;
      },
      leave: (code: string, id: string, callSid: string) => {
        this.unregisterBattleVoiceSession(session);
        this.scheduleBattleVoiceLeave(code, id, callSid, session);
      },
      setName: (code: string, id: string, n: string) => this.battle.voiceSetName(code, id, n),
      selectMonster: (code: string, id: string, m: string) => this.battle.voiceSelectMonster(code, id, m),
      openFight: (code: string, id: string) => this.battle.voiceOpenFight(code, id),
      backMenu: (code: string, id: string) => this.battle.voiceBackMenu(code, id),
      chooseAction: (code: string, id: string, a: import('../shared/battle-world').BattleAction) => this.battle.voiceChooseAction(code, id, a),
      advance: (code: string) => this.battle.voiceAdvance(code),
      setTimer: (fn: () => void, ms: number) => { setTimeout(fn, ms); },
      snapshot: (code: string, id: string) => this.battleVoiceSnapshot(code, id),
      converse: async (code: string, id: string, utterance: string, isCurrent: () => boolean) => {
        if (!this.llm.enabled) return null;
        const ctx = this.battleHostContext(code, id, isCurrent);
        if (!ctx) return null;
        history.push({ role: 'user', content: utterance });
        const reply = await battleHostTurn(this.llm, ctx, history);
        if (!isCurrent()) return null;
        if (reply) history.push({ role: 'assistant', content: reply });
        if (history.length > 12) history.splice(0, history.length - 12);
        return reply;
      },
    };
    session = new BattleVoiceSession(deps);
    return session;
  }

  private registerBattleVoiceSession(code: string, session: BattleVoiceSession): void {
    let set = this.battleVoice.get(code);
    if (!set) { set = new Set(); this.battleVoice.set(code, set); }
    set.add(session);
  }

  private unregisterBattleVoiceSession(session: BattleVoiceSession): void {
    for (const [code, set] of this.battleVoice) {
      if (set.delete(session) && set.size === 0) this.battleVoice.delete(code);
    }
  }

  private rememberBattleVoiceCall(callSid: string, code: string, playerId: string, session: BattleVoiceSession): void {
    const sid = callSid.trim();
    if (!sid) return;
    const prev = this.battleVoiceCallBindings.get(sid);
    if (prev?.leaveTimer) clearTimeout(prev.leaveTimer);
    if (prev?.activeSession && prev.activeSession !== session) {
      this.unregisterBattleVoiceSession(prev.activeSession);
      prev.activeSession.handleReplaced();
    }
    if (prev && (prev.code !== code || prev.playerId !== playerId)) this.battle.voiceLeave(prev.code, prev.playerId);
    this.battleVoiceCallBindings.set(sid, { code, playerId, activeSession: session, leaveTimer: null });
  }

  private resumeBattleVoiceCall(code: string, callSid: string, session: BattleVoiceSession): string | null {
    const sid = callSid.trim();
    if (!sid) return null;
    const binding = this.battleVoiceCallBindings.get(sid);
    if (!binding || binding.code !== code) return null;
    if (!this.battleRoomHasPlayer(code, binding.playerId)) {
      if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      this.battleVoiceCallBindings.delete(sid);
      return null;
    }
    if (binding.leaveTimer) {
      clearTimeout(binding.leaveTimer);
      binding.leaveTimer = null;
    }
    if (binding.activeSession && binding.activeSession !== session) this.unregisterBattleVoiceSession(binding.activeSession);
    if (binding.activeSession && binding.activeSession !== session) binding.activeSession.handleReplaced();
    binding.activeSession = session;
    this.registerBattleVoiceSession(code, session);
    return binding.playerId;
  }

  private scheduleBattleVoiceLeave(code: string, playerId: string, callSid: string, session: BattleVoiceSession): void {
    const sid = callSid.trim();
    if (!sid) { this.battle.voiceLeave(code, playerId); return; }
    const prev = this.battleVoiceCallBindings.get(sid);
    if (!prev && !this.battleRoomHasPlayer(code, playerId)) return;
    if (prev?.activeSession && prev.activeSession !== session) return;
    if (prev?.leaveTimer) clearTimeout(prev.leaveTimer);
    if (prev) prev.activeSession = null;
    const leaveTimer = setTimeout(() => {
      const binding = this.battleVoiceCallBindings.get(sid);
      if (!binding || binding.code !== code || binding.playerId !== playerId) return;
      this.battleVoiceCallBindings.delete(sid);
      this.battle.voiceLeave(code, playerId);
    }, BATTLE_VOICE_RECONNECT_GRACE_MS);
    (leaveTimer as { unref?: () => void }).unref?.();
    this.battleVoiceCallBindings.set(sid, { code, playerId, activeSession: null, leaveTimer });
  }

  private endBattleVoiceCall(callSid: string): void {
    const sid = callSid.trim();
    if (!sid) return;
    const binding = this.battleVoiceCallBindings.get(sid);
    if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) {
      this.unregisterBattleVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    this.battleVoiceCallBindings.delete(sid);
    this.battle.voiceLeave(binding.code, binding.playerId);
  }

  private battleRoomHasPlayer(code: string, playerId: string): boolean {
    const room = this.battle.findRoom(code);
    return !!room?.lobbyPlayers().some(p => p.playerId === playerId);
  }

  /** Deterministic selection fast-path for the conversational layer: in car/map select, if the caller
   *  CLEARLY picked one (a number or strong name, not a question), do it now + return the confirmation.
   *  Returns null when it's not a clear pick (a question, chit-chat, or wrong phase) → the LLM handles
   *  it. Makes numeric/name picks reliable regardless of the model, and works with the LLM disabled. */
  private directSelection(room: Room, playerId: string, utterance: string): string | null {
    // Internal prompts are wrapped in parentheses by the voice adapter. They are instructions to the
    // host brain, not caller commands, so they must never drive room state (for example race-over
    // recap prompts mentioning a rematch must not advance results back to car select).
    if (utterance.trim().startsWith('(')) return null;

    // NAME CAPTURE (deterministic, LLM-independent): the FIRST thing we ask is the caller's name, so in
    // the LOBBY, while they still have the auto placeholder name, treat a name-like reply as their name
    // + confirm and guide forward. Without this, giving your name relied entirely on the LLM (dead air
    // if it's off/slow). Only in the lobby — in car_select a car pick must win over a name guess.
    if (room.phase === 'lobby') {
      const me = room.lobbyPlayers().find(p => p.playerId === playerId);
      const hasRealName = me && !/^Racer(\s|$)/.test(me.name);
      if (!hasRealName) {
        const name = parseSpokenName(utterance);
        if (name) {
          this.game.voiceSetName(room.code, playerId, name);
          return `Nice to meet you, ${name}! ${VOICE_RACER_CONTROLS_INTRO} Say "start" when you're ready to pick your car.`;
        }
      }
    }
    if (room.phase === 'car_select') {
      const i = clearSelectionIndex(utterance, this.roomConfigCache.carNames);
      if (i !== null) {
        this.game.voiceSelectCar(room.code, playerId, i);
        return `Locked in — the ${room.carName(i)}! Say "next" when you're ready for the track.`;
      }
      // "next"/"start" advances to the track — but only once they've actually picked a car.
      if (isAdvanceWord(utterance)) {
        const me = room.lobbyPlayers().find(p => p.playerId === playerId);
        if ((me?.carIndex ?? null) === null) return 'Pick your car first — say a car name or number.';
        return this.game.voiceAdvance(room.code) ? 'On to the track — say a track name or number!' : null;
      }
      return null;
    }
    if (room.phase === 'map_select') {
      const i = clearSelectionIndex(utterance, room.mapChoices);
      if (i === null) {
        if (!isAdvanceWord(utterance)) return null;
        const ok = this.game.voiceAdvance(room.code);
        return ok ? "Here we go — let's race!" : 'Pick a track first — say a track name or number.';
      }
      this.game.voiceSelectMap(room.code, room.mapChoices[i]!, playerId);
      return `Your vote's in for ${room.mapChoices[i]}! Say "start" when you're ready to race.`;
    }
    // ADVANCE / REMATCH (deterministic, LLM-independent): "start"/"go"/"next"/"race"/"rematch" moves the
    // flow forward — this was previously LLM-only, so "start" did nothing when the model was off/slow.
    if (isAdvanceWord(utterance)) {
      const me = room.lobbyPlayers().find(p => p.playerId === playerId);
      // (car_select is handled by its own branch above; reaching here means lobby/map_select/results.)
      const ok = this.game.voiceAdvance(room.code);
      if (!ok) return null;
      // room.phase is now the NEW phase we advanced INTO — describe that screen.
      const landed = String(room.phase);
      void me;
      return landed === 'car_select' ? 'Choose your car — say a name or number!'
        : landed === 'map_select' ? 'On to the track — say a track name or number!'
        : "Here we go — let's race!";
    }
    return null;
  }

  /** Test seam for deterministic voice routing without opening a WebSocket. */
  directSelectionForTest(room: Room, playerId: string, utterance: string): string | null {
    return this.directSelection(room, playerId, utterance);
  }

  /** Build the AI host's view of a live room for one caller: what it can see + the actions it can take
   *  (pick a car/map by fuzzy name, start the race). Actions delegate to the same Room methods + the
   *  game-server broadcast, so a voice-driven pick shows up on the screen exactly like a texted one. */
  private hostContext(room: Room, playerId: string): HostContext {
    const cars = this.roomConfigCache.carNames;
    const me = room.lobbyPlayers().find(p => p.playerId === playerId);
    const myCarIdx = me?.carIndex ?? null;
    // A caller starts with an auto placeholder name ("Racer 1234" from their number). Treat that as
    // "no real name yet" so the host asks for one and displays what they actually say.
    const rawName = me?.name ?? '';
    const realName = /^Racer(\s|$)/.test(rawName) ? null : rawName || null;
    const board = this.leaderboardSummaryForMap(room.selectedMap, room.results());
    const myResult = room.results().find(r => r.playerId === playerId) ?? null;
    return {
      phase: room.phase as HostContext['phase'],
      cars, maps: room.mapChoices, selectedMap: room.selectedMap,
      myName: realName,
      myCar: myCarIdx !== null ? room.carName(myCarIdx) : null,
      myPlace: myResult?.place ?? null,
      myFinishTime: myResult && myResult.finished && myResult.finishT > 0 ? myResult.finishT : null,
      racerCount: room.playerCount,
      raceStandings: room.results().map(r => ({ name: r.name, place: r.place, time: r.finished && r.finishT > 0 ? r.finishT : null, finished: r.finished })),
      leaderboardTop: board.top,
      allTimeTop: board.topNames,
      allTimeBest: board.bestName !== null && board.bestTime !== null
        ? { name: board.bestName, time: board.bestTime } : null,
      setName: (name) => {
        const clean = name.trim().slice(0, 20);
        if (!clean) return null;
        this.game.voiceSetName(room.code, playerId, clean);
        // Always chain into the NEXT step so a bare tool call never leaves dead air (the "it just said
        // 'nice to meet you' and stopped" issue). In the lobby, point them at getting into the race.
        return room.phase === 'lobby'
          ? `Nice to meet you, ${clean}! ${VOICE_RACER_CONTROLS_INTRO} Others can still call in — say "start" whenever you're ready to pick your car.`
          : `Nice to meet you, ${clean}!`;
      },
      selectCarByName: (name) => {
        const i = matchChoice(name, cars);
        // No match → the model likely invented a name; DON'T act, and tell it (so it re-asks with the
        // real list) rather than confirming a car that doesn't exist.
        if (i < 0) return null;
        if (room.phase !== 'car_select') return null;
        this.game.voiceSelectCar(room.code, playerId, i);
        // Confirm using the ACTUAL matched car name — never the caller's/model's raw words.
        return `Locked in — the ${room.carName(i)}!`;
      },
      selectMapByName: (name) => {
        const i = matchChoice(name, room.mapChoices);
        if (i < 0) return null;   // invented/unknown track → do nothing (no hallucinated confirmation)
        if (room.phase !== 'map_select') return null;
        this.game.voiceSelectMap(room.code, room.mapChoices[i]!, playerId);   // vote
        return `Your vote's in for ${room.mapChoices[i]}!`;
      },
      startRace: () => {
        // Guard against SKIPPING a step: don't leave car_select until THIS caller has actually picked
        // a car (the "it jumped to track select while I was still choosing" bug). The LLM is also told
        // this in the prompt; this is the hard backstop.
        const meNow = room.lobbyPlayers().find(p => p.playerId === playerId);
        if (room.phase === 'car_select' && (meNow?.carIndex ?? null) === null) {
          return "Pick your car first — say a car name or number.";
        }
        const ok = this.game.voiceAdvance(room.code);
        return ok ? "Here we go — let's race!" : null;
      },
    };
  }

  private leaderboardSummaryForMap(map: string | null, currentResults: RaceResult[] = []): { top: { name: string; time: number }[]; topNames: string[]; bestName: string | null; bestTime: number | null } {
    if (!map) return { top: [], topNames: [], bestName: null, bestTime: null };
    const currentEntries: LeaderboardEntry[] = currentResults
      .filter(r => r.finished && r.finishT > 0)
      .map(r => ({ name: r.name, map, carIndex: r.carIndex, finishT: r.finishT, at: Number.MAX_SAFE_INTEGER }));
    const ranked = topEntries([...currentEntries, ...this.leaderboardEntriesCache], { map, limit: 20 });
    const seen = new Set<string>();
    const top: LeaderboardEntry[] = [];
    for (const entry of ranked) {
      const key = `${entry.name}|${entry.finishT}`;
      if (seen.has(key)) continue;
      seen.add(key); top.push(entry);
      if (top.length >= 5) break;
    }
    return {
      top: top.map(e => ({ name: e.name, time: e.finishT })),
      topNames: top.map(e => e.name),
      bestName: top[0]?.name ?? null,
      bestTime: top[0]?.finishT ?? null,
    };
  }

  /** Test seam for verifying voice host context. */
  hostContextForTest(room: Room, playerId: string): HostContext {
    return this.hostContext(room, playerId);
  }

  // ── Voice Monsters voice helpers: flatten a battle room for one caller ────────────────────────────
  /** Which side (a/b) the caller's playerId is, or null (spectator / not in this battle). */
  private battleSideOf(room: import('./battle-room').BattleRoom, playerId: string): 'a' | 'b' | null {
    const snap = room.snapshot();
    if (!snap) return null;
    if (snap.a.id === playerId) return 'a';
    if (snap.b.id === playerId) return 'b';
    return null;
  }

  /** Flatten a battle room into the voice session's snapshot (for deterministic routing). */
  private battleVoiceSnapshot(code: string, playerId: string): BattleVoiceSnapshot | null {
    const room = this.battle.findRoom(code);
    if (!room) return null;
    const monsterNames = rosterEntries().map(m => m.name);
    const players = room.lobbyPlayers();
    const player = players.find(p => p.playerId === playerId);
    const pickedCount = players.filter(p => p.monsterId).length;
    const canStartBattle = room.phase === 'monster_select'
      ? (players.length >= 2 ? players.every(p => !!p.monsterId) : pickedCount === 1)
      : false;
    const rawName = player?.name ?? '';
    const myName = /^(Challenger|Player)(\s|$)/.test(rawName) ? null : (rawName || null);
    const snap = room.snapshot();
    const res = room.result();
    const battleSide = this.battleSideOf(room, playerId);
    const side = battleSide ?? 'a';
    if (!snap || !battleSide) {
      const mon = player?.monsterId ? monsterById(player.monsterId) : null;
      return {
        phase: room.phase, mySide: side, monsterNames, myName,
        myMonsterId: player?.monsterId ?? null,
        myMonsterName: mon?.name ?? null,
        myMonsterType: mon?.type ?? null,
        canStartBattle,
        canRematch: room.canRematch,
        foeName: null, foeMonsterName: null, foeMonsterType: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
        myPotions: 2, turn: null, activeSide: null, activeMenu: 'root', whoseTurn: null, myMoves: [], winnerName: res?.winnerName ?? null,
      };
    }
    const me = side === 'a' ? snap.a : snap.b;
    const foe = side === 'a' ? snap.b : snap.a;
    const activeSide = room.activeSide();
    return {
      phase: room.phase, mySide: side, monsterNames, myName,
      myMonsterId: me.monsterId, myMonsterName: me.monsterName,
      myMonsterType: me.type,
      canStartBattle,
      canRematch: room.canRematch,
      foeName: foe.name,
      foeMonsterName: foe.monsterName,
      foeMonsterType: foe.type,
      myHp: me.hp, myMaxHp: me.maxHp, foeHp: foe.hp, foeMaxHp: foe.maxHp,
      myPotions: side === 'a' ? snap.potions.a : snap.potions.b,
      turn: snap.turn,
      activeSide,
      activeMenu: room.activeMenu(),
      whoseTurn: room.phase === 'battle' && activeSide ? (activeSide === side ? 'me' : 'foe') : null,
      myMoves: me.moves.map(m => ({ id: m.id, name: m.name })),
      winnerName: res?.winnerName ?? null,
    };
  }

  /** Build the battle LLM host's context for one caller (delegating actions to the BattleServer). */
  private battleHostContext(code: string, playerId: string, isCurrent: () => boolean = () => true): BattleHostContext | null {
    const room = this.battle.findRoom(code);
    if (!room) return null;
    const s = this.battleVoiceSnapshot(code, playerId);
    if (!s) return null;
    return {
      phase: s.phase, monsters: s.monsterNames, myName: s.myName,
      myMonster: s.myMonsterName, foeMonster: s.foeMonsterName,
      myHp: s.myHp, myMaxHp: s.myMaxHp, foeHp: s.foeHp, foeMaxHp: s.foeMaxHp,
      myPotions: s.myPotions, whoseTurn: s.whoseTurn, moves: s.myMoves.map(m => m.name),
      winnerName: s.winnerName,
      setName: (name) => {
        if (!isCurrent() || (room.phase !== 'lobby' && room.phase !== 'monster_select')) return null;
        const c = name.trim().slice(0, 20); if (!c) return null;
        this.battle.voiceSetName(code, playerId, c); return `Nice to meet you, ${c}!`;
      },
      selectMonster: (name) => {
        if (!isCurrent()) return null;
        const i = matchChoice(name, s.monsterNames);
        if (i < 0 || room.phase !== 'monster_select') return null;
        const id = s.monsterNames[i]!.toLowerCase().replace(/\s+/g, '');
        this.battle.voiceSelectMonster(code, playerId, id);
        return `Locked in — ${s.monsterNames[i]}!`;
      },
      chooseAction: (action) => {
        // Gate on the caller's TURN, not just the phase: after the caller acts, the room may still be
        // in battle while the other side/AI is active. Do not let the LLM act out of turn.
        if (!isCurrent()) return null;
        const current = this.battleVoiceSnapshot(code, playerId);
        if (room.phase !== 'battle' || current?.whoseTurn !== 'me' || current.turn !== s.turn) return null;
        const parsed = this.parseVoiceHostAction(action, current.myMoves);
        if (!parsed) return null;
        this.battle.voiceChooseAction(code, playerId, parsed);
        return null;   // the model's own words carry the reply; avoid double-speak
      },
      advance: () => {
        if (!isCurrent() || room.phase !== s.phase) return null;
        this.battle.voiceAdvance(code); return null;
      },
    };
  }

  /** Parse the LLM's `choose_action` string ('guard'|'item'|'taunt'|'fight:<move>') into a BattleAction. */
  private parseVoiceHostAction(action: string, moves: { id: string; name: string }[]): import('../shared/battle-world').BattleAction | null {
    const a = action.trim().toLowerCase();
    if (a === 'guard') return { kind: 'guard' };
    if (a === 'item' || a === 'potion') return { kind: 'item', item: 'potion' };
    if (a === 'taunt') return { kind: 'taunt' };
    if (a.startsWith('fight')) {
      const moveName = action.split(':').slice(1).join(':').trim() || action.replace(/^fight\s*/i, '').trim();
      const i = matchChoice(moveName, moves.map(m => m.name));
      if (i >= 0) return { kind: 'fight', moveId: moves[i]!.id };
    }
    return null;
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
      // INSTANT JOIN: a call binds straight to the single shared game (DEFAULT_ROOM) — no room-code
      // keypad step (fewest taps: scan QR → call → you're racing). One display / one game at a time.
      // /voice/join is kept as an alias in case a legacy DTMF-gathered call still hits it (uses the
      // dialed Digits if present, else the default room).
      const roomCode = path === '/voice/join'
        ? ((params['Digits'] ?? '').trim() || DEFAULT_ROOM)
        : DEFAULT_ROOM;
      // MULTI-GAME: one number. Auto-route to whichever game's screen most recently opened.
      const voiceGame = this.recentVoiceGame();
      const xml = twimlConnectRelay({
        wsUrl: `${this.publicBaseUrl.replace(/^http/, 'ws')}/voice`,
        sessionEndedUrl: `${this.publicBaseUrl}/voice/session-ended`,
        roomCode,
        // ElevenLabs voice for the announcer talk-back; swap via the CR_TTS_VOICE env.
        ttsProvider: 'ElevenLabs',
        voice: this.crVoice,
        game: voiceGame === 'battle' ? 'monsters' : voiceGame,
        relayToken: this.voiceRelayToken || undefined,
        hints: voiceGame === 'battle'
          ? 'fight, guard, item, potion, taunt, attack, heal, sparkmouse, embertail, shellback, thornling, galecoil, voltcrest, dazeduck, psyclone, ember, thunder, jolt, water, vine, psystrike'
          : voiceGame === 'fighter'
            ? [...FIGHTER_ROSTER.map(fighter => fighter.name), ...this.fighterMaps.map(map => map.name),
                'forward', 'closer', 'back', 'backward', 'away', 'jump', 'leap', 'hop', 'punch', 'jab', 'strike',
                'kick', 'roundhouse', 'block', 'guard', 'defend', 'start', 'next', 'fight', 'rematch', 'help'].join(', ')
            : 'left, right, boost, go, brake, slow, stop, nitro, power',
        // NO welcomeGreeting here on purpose: the game's WS `setup` handler speaks the greeting (and
        // asks the caller's name) as its FIRST utterance. Setting it here too made the caller hear
        // "Welcome to Voice Monsters" TWICE (TwiML greeting + the WS greeting).
        welcomeGreeting: '',
      });
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(xml);
      return;
    }
    if (req.method === 'POST' && path === '/voice/session-ended') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authToken) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const sig = req.headers['x-twilio-signature'];
        const ok = validateTwilioSignature({
          authToken: this.authToken,
          signature: Array.isArray(sig) ? sig[0] : sig,
          url: `${this.publicBaseUrl}${path}`,
          params,
        });
        if (!ok) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      const callSid = (params['CallSid'] ?? params['callSid'] ?? '').trim();
      this.endBattleVoiceCall(callSid); this.endFighterVoiceCall(callSid);
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
    // ---- client bootstrap config (public, unauthenticated): the phone number to call to join, so
    //      the lobby can show it + encode the QR. Empty string when unset (lobby shows a placeholder).
    if (path === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ phoneNumber: this.gamePhoneNumber }));
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
    // ---- list organized Voice Racer GLBs (for Garage/editor role dropdowns) ----
    if (path === '/api/assets' && req.method === 'GET') {
      let files: string[] = [];
      try {
        for (const directory of ['racer/cars', 'racer/track']) {
          const entries = await readdir(`assets/${directory}`, { withFileTypes: true });
          files.push(...entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.glb')).map(entry => `${directory}/${entry.name}`));
        }
        files.sort();
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
    // ---- Voice Monsters arena config (transform/camera/spin), authored in the multi-game editor ----
    if (path === '/api/arena' && req.method === 'GET') {
      let body = '';
      // Prefer the LIVE (persistent) config; fall back to the bundled default so a fresh env works.
      for (const p of [this.arenaPath, this.bundledArenaPath ?? 'assets/arena/arena.json']) {
        try { body = await readFile(p, 'utf8'); if (body.trim()) break; } catch { /* try next */ }
      }
      if (!body.trim()) body = JSON.stringify({ file: 'arena.glb', pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1, spinSpeed: 0.18 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    if (path === '/api/arena' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      let cfg: unknown;
      try { cfg = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('invalid JSON'); return; }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { res.writeHead(400).end('arena config must be an object'); return; }
      await this.writeFileAtomic(this.arenaPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cfg));
      return;
    }
    // ---- Voice Fighter map catalog + GLB picker (authored in the unified editor) ----
    if (path === '/api/fighter-maps' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(this.fighterMaps));
      return;
    }
    if (path === '/api/fighter-maps' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      let maps: unknown;
      try { maps = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('invalid JSON'); return; }
      try { this.fighterMaps = parseFighterMaps(maps); }
      catch (error) { res.writeHead(400).end((error as Error).message); return; }
      await this.writeFileAtomic(this.fighterMapsPath, JSON.stringify(this.fighterMaps, null, 2));
      this.fighter.setMaps(this.fighterMaps);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(this.fighterMaps));
      return;
    }
    if (path === '/api/fighter-map-files' && req.method === 'GET') {
      let files: string[] = [];
      try {
        const entries = await readdir('assets/fighters/maps', { withFileTypes: true });
        files = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.glb')).map(entry => entry.name).sort();
      } catch { /* empty picker */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(files));
      return;
    }
    if (path === '/api/fighter/leave' && req.method === 'POST') {
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('invalid JSON'); return; }
      const value = body as { roomCode?: unknown; sessionId?: unknown };
      if (typeof value?.roomCode !== 'string' || typeof value?.sessionId !== 'string' || value.sessionId.length > 128) { res.writeHead(400).end('roomCode + sessionId required'); return; }
      this.fighter.releaseBrowserSession(value.roomCode, value.sessionId);
      res.writeHead(204).end(); return;
    }
    if (path === '/api/fighter-map-preview' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? '';
      if (!/^[a-z0-9-]{1,64}$/.test(id)) { res.writeHead(400).end('invalid map id'); return; }
      const image = await readBinaryBody(req, 5 * 1024 * 1024);
      if (image.length < 8 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { res.writeHead(400).end('preview must be PNG'); return; }
      await mkdir(this.fighterPreviewDir, { recursive: true });
      await this.writeFileAtomic(`${this.fighterPreviewDir}/${id}.png`, image);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ preview: `/fighter-previews/${id}.png` }));
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
    if (req.method === 'GET' && path.startsWith('/fighter-previews/')) {
      const name = path.slice('/fighter-previews/'.length);
      if (!/^[a-z0-9-]+\.png$/i.test(name)) { res.writeHead(403).end('forbidden'); return; }
      const file = `${this.fighterPreviewDir}/${name}`;
      try { await stat(file); } catch { res.writeHead(404).end('not found'); return; }
      return this.sendFile(file, res, req, { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    }
    // ---- static assets (built JS bundles AND GLB models, both under /assets/) ----
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      return this.serveAsset(path, res, req);
    }
    // ---- the built client (HTML pages, /brand, /fonts, etc.) ----
    if (req.method === 'GET') {
      return this.serveClient(path, res, req);
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
  private async writeFileAtomic(file: string, contents: string | Buffer): Promise<void> {
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
  private async serveAsset(urlPath: string, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath.replace(/^\/assets\//, '')); }
    catch { res.writeHead(400).end('bad request'); return; }   // malformed %-escape
    if (rel.includes('..') || rel.startsWith('/')) { res.writeHead(403).end('forbidden'); return; }
    const builtAssets = path.join(this.clientDir, 'assets');
    for (const base of [builtAssets, 'assets']) {
      const full = path.join(base, rel);
      try {
        await stat(full);   // existence check; throws → try next base / 404
        // Assets are content-addressed (hashed JS bundles) or stable models → cache HARD so a client
        // (and the CDN/edge) fetches each big GLB ONCE, not on every menu load. This is the main fix
        // for the slow deployed menu: the 7.8MB models were re-downloaded uncompressed every time.
        const cache = base === builtAssets ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, must-revalidate';
        return this.sendFile(full, res, req, { 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' });
      } catch { /* try next base */ }
    }
    res.writeHead(404).end('not found');
  }

  /**
   * Stream a file to the response (don't buffer the whole thing — a 7.8MB GLB buffered + sent in one
   * res.end() blocks the event loop and balloons memory on a 1-CPU container). gzip text-ish files
   * on the fly when the client accepts it (the 600KB JS bundle → ~150KB); GLBs are already Draco-
   * compressed, so we stream them as-is. Honors a small static header set (cache-control, CORS).
   */
  private async sendFile(full: string, res: http.ServerResponse, req: http.IncomingMessage,
                         extraHeaders: Record<string, string> = {}): Promise<void> {
    const type = contentType(full);
    const headers: Record<string, string> = { 'Content-Type': type, ...extraHeaders };
    // gzip only compressible text types; never re-compress GLB/PNG/fonts (already compact → wastes CPU).
    const compressible = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (compressible && acceptsGzip) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      createReadStream(full).pipe(zlib.createGzip()).pipe(res);
    } else {
      try { headers['Content-Length'] = String((await stat(full)).size); } catch { /* skip length */ }
      res.writeHead(200, headers);
      createReadStream(full).pipe(res);
    }
  }

  /**
   * Serve the built client: the home page at `/`, `/play.html`, the folder-index pages `/editor` and
   * `/garage` (bare path → <dir>/index.html, matching the dev redirect), and any other static file
   * (/brand, /fonts, etc.). Path-traversal guarded to clientDir. Unknown paths 404 (this is a game
   * server, not an SPA — no catch-all index fallback).
   */
  private async serveClient(urlPath: string, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath); } catch { res.writeHead(400).end('bad request'); return; }
    if (rel.includes('..')) { res.writeHead(403).end('forbidden'); return; }
    // Map bare paths to files: '/' and '/editor' → index.html; '/garage' → garage/index.html.
    let file: string;
    if (rel === '/' || rel === '') file = 'index.html';
    else if (rel === '/editor' || rel === '/editor/') file = 'editor/index.html';
    else if (rel === '/garage' || rel === '/garage/') file = 'garage/index.html';
    else file = rel.replace(/^\/+/, '');
    const full = path.join(this.clientDir, file);
    try { await stat(full); } catch { res.writeHead(404).end('not found'); return; }
    // HTML must NOT cache (so a redeploy is seen immediately); hashed /assets/* JS is handled by
    // serveAsset's immutable cache. Other static files (brand/fonts) get a short cache.
    const isHtml = file.endsWith('.html');
    const cache = isHtml ? 'no-cache' : 'public, max-age=3600';
    await this.sendFile(full, res, req, { 'Cache-Control': cache });
  }

  async start(): Promise<number> {
    await this.seedMapsFile();
    await this.refreshFighterMaps();
    // Re-read the (possibly just-seeded) maps into the lobby cache so map choices are correct on the
    // very first connection — the constructor's initial refresh may have run before the seed wrote.
    await this.refreshRoomConfig();
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.port);
      });
    });
  }

  /** Copy the image-bundled default levels into the LIVE (persistent) maps file ONCE, on first boot
   *  — only when the live file is missing/blank/corrupt. Never overwrites a valid live file, so
   *  editor-authored levels survive redeploys. No-op when no bundle path is configured (tests/dev). */
  private async seedMapsFile(): Promise<void> {
    if (!this.bundledMapsPath) return;
    let liveText: string | null = null, liveExists = false;
    try { liveText = await readFile(this.mapsPath, 'utf8'); liveExists = true; } catch { /* absent */ }
    let bundledText: string | null = null;
    try { bundledText = await readFile(this.bundledMapsPath, 'utf8'); } catch { /* no bundle */ }
    const plan = seedMapsPlan({ liveExists, liveText, bundledText });
    if (!plan.write) return;
    try {
      await this.writeFileAtomic(this.mapsPath, plan.contents);
      console.log(`[maps] seeded ${this.mapsPath} from bundled defaults (${this.bundledMapsPath})`);
    } catch (e) {
      console.error('[maps] seed write failed:', (e as Error).message);
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.roomConfigTimer) { clearInterval(this.roomConfigTimer); this.roomConfigTimer = null; }
      if (this.smsSweepTimer) { clearInterval(this.smsSweepTimer); this.smsSweepTimer = null; }
      for (const binding of this.battleVoiceCallBindings.values()) {
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      }
      this.battleVoiceCallBindings.clear();
      for (const binding of this.fighterVoiceCallBindings.values()) if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      this.fighterVoiceCallBindings.clear(); this.fighterVoice.clear();
      this.game.stopLoopOnly();
      this.battle.stopLoopOnly();
      this.fighter.stopLoopOnly();
      this.server.close(() => resolve());
    });
  }
}

const RELAY_CHUNK_GAP_MS = 420;
const relayQueues = new WeakMap<WebSocket, { tail: Promise<void>; lastAt: number; generation: number }>();

function sendRelayText(ws: WebSocket, text: string): void {
  const chunks = relayTextChunks(text);
  if (!chunks.length || ws.readyState !== ws.OPEN) return;
  let queue = relayQueues.get(ws);
  if (!queue) {
    queue = { tail: Promise.resolve(), lastAt: 0, generation: 0 };
    relayQueues.set(ws, queue);
  }
  const generation = queue.generation;
  queue.tail = queue.tail.then(async () => {
    for (const token of chunks) {
      if (generation !== queue.generation) return;
      const elapsed = queue.lastAt > 0 ? Date.now() - queue.lastAt : RELAY_CHUNK_GAP_MS;
      if (elapsed < RELAY_CHUNK_GAP_MS) await sleep(RELAY_CHUNK_GAP_MS - elapsed);
      if (generation !== queue.generation) return;
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'text', token, last: true }));
      queue.lastAt = Date.now();
    }
  }).catch(() => {
    // TTS pacing must never break the game loop.
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function clearRelayTextQueue(ws: WebSocket): void {
  const queue = relayQueues.get(ws);
  if (!queue) return;
  queue.generation++;
  queue.tail = Promise.resolve();
  queue.lastAt = 0;
}

export function relayTextChunks(text: string): string[] {
  const token = speechSafeText(text);
  if (!token) return [];
  const controls = splitControlText(token);
  return controls.length > 1 ? controls : [token];
}

function splitControlText(text: string): string[] {
  const lower = text.toLowerCase();
  const isInstruction = lower.includes('say ') || lower.includes('voice controls') || lower.includes('quick rules') || lower.includes('how to play') || lower.includes('controls on the screen');
  if (!isInstruction || text.length < 90) return [];
  return text
    .replace(/:\s+/g, '. ')
    .replace(/;\s+/g, '. ')
    .replace(/\s+or\s+say\s+/gi, '. Or say ')
    .replace(/\s+and\s+nitro\s+/gi, '. And nitro ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Map a filename to a Content-Type for the static server (covers the built client + GLB models). */
export function contentType(name: string): string {
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
    // .otf served as octet-stream → some browsers refuse to apply the @font-face, silently falling
    // back to a system font (why the branded Twilio Sans numbers looked different in prod vs. dev,
    // where Vite sent the right type). The Twilio Sans faces are all .otf.
    case '.otf': return 'font/otf';
    case '.glb': return 'model/gltf-binary';
    case '.wasm': return 'application/wasm';
    case '.ico': return 'image/x-icon';
    // Audio (shared-screen background music) — a decodable Content-Type so the browser's Web Audio
    // API will fetch + decode them (application/octet-stream is refused by some decoders).
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.m4a': case '.aac': return 'audio/mp4';
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

function readBinaryBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > max) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
