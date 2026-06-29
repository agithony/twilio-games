import { RaceWorld } from '../shared/race-world';
import { Lobby } from '../shared/lobby';
import { MAX_PLAYERS, LANES } from '../shared/constants';
import type { Intent, WorldSnapshot, Phase, GameEvent, LobbyPlayer, RaceResult } from '../shared/types';

const COLORS = ['#36d1dc','#f22f46','#ffcf5c','#36e08a','#a06bff','#ff8a5c','#5c8aff','#ff5ca8'];

/** Accept only a safe CSS color (hex or simple rgb/hsl), else fall back. Colors are interpolated
 *  into style="..." on the display, so an unvalidated value is a stored-XSS vector — reject anything
 *  that isn't an obvious color literal. */
function safeColor(color: string | undefined, fallback: string): string {
  if (typeof color !== 'string') return fallback;
  const c = color.trim();
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c)) return c;            // #rgb / #rrggbb
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(c)) return c;
  if (/^hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)$/.test(c)) return c;
  return fallback;
}

export interface RoomConfig { carCount: number; maps: string[]; }

/**
 * A game room. Owns the pre-race flow (Lobby: lobby → car_select → map_select) and, once started,
 * a RaceWorld (countdown → racing → finished). After a race it holds the standings in 'results'
 * until someone advances back to the lobby. The server (GameServer) drives transitions via the
 * public methods; broadcasting/persistence live in the server.
 */
export class Room {
  readonly code: string;
  private seed: number;
  private lobby: Lobby;
  private world: RaceWorld | null = null;
  private _phase: Phase = 'lobby';
  private nextId = 1;
  private eventsThisBroadcast: GameEvent[] = [];
  private lastResults: RaceResult[] = [];
  private raceMap: string | null = null;

  constructor(code: string, seed: number, config?: RoomConfig) {
    this.code = code;
    this.seed = seed;
    this.lobby = new Lobby({ carCount: config?.carCount ?? 0, maps: config?.maps ?? [] });
  }

  /** Late-bind the selectable cars/maps once the server has loaded the manifest + map list. */
  configure(config: RoomConfig): void {
    // Rebuild the lobby with the real choices, preserving the current roster.
    const roster = this.lobby.players();
    this.lobby = new Lobby(config);
    for (const p of roster) this.lobby.addPlayer(p.id, p.name, p.color);
  }

  get phase(): Phase { return this._phase; }
  get playerCount(): number { return this.lobby.playerCount; }
  get isEmpty(): boolean { return this.lobby.playerCount === 0; }
  get selectedMap(): string | null { return this.raceMap ?? this.lobby.selectedMap; }
  get mapChoices(): string[] { return this.lobby.mapChoices; }

  /** True while the room is in a pre-race selection phase (lobby/car_select/map_select). */
  private get inPreRace(): boolean {
    return this._phase === 'lobby' || this._phase === 'car_select' || this._phase === 'map_select';
  }

  /** Roster for the shared-display lobby + selection screens (includes car/ready state). */
  lobbyPlayers(): LobbyPlayer[] {
    // Lane is assigned by join order (mod LANES) for the sim; surface it for color/positioning.
    return this.lobby.players().map((p, i) => ({
      playerId: p.id, name: p.name, color: p.color, lane: i % LANES,
      carIndex: p.carIndex, ready: p.ready,
    }));
  }

  addPlayer(name: string, color?: string): { playerId: string; lane: number } | { error: string } {
    // A finished/results race is reusable: a new joiner reopens the room to a fresh lobby.
    if (this._phase === 'finished' || this._phase === 'results') this.reset();
    if (this.lobby.playerCount >= MAX_PLAYERS) return { error: 'room_full' };
    const lane = this.lobby.playerCount % LANES;
    const id = `p${this.nextId++}`;
    const palette = COLORS[this.lobby.playerCount % COLORS.length]!;
    const color2 = safeColor(color, palette);   // reject unsafe colors (stored-XSS guard)
    this.lobby.addPlayer(id, name, color2);
    // If a race is already running, slot this player into the live world so they get a car.
    if (this.world && (this._phase === 'countdown' || this._phase === 'racing')) {
      this.world.addCar({ id, name, color: color2 });
    }
    return { playerId: id, lane };
  }

  removePlayer(playerId: string): void {
    this.lobby.removePlayer(playerId);
    this.world?.removeCar(playerId);
    // An abandoned race (everyone disconnected) must not lock the room forever.
    if (this.lobby.playerCount === 0 && this._phase !== 'lobby') this.reset();
  }

  /** Concierge / client can fill in a player's display name + color after a bare join. */
  setPlayerInfo(playerId: string, info: { name?: string; color?: string }): void {
    const clean = { ...info, ...(info.color !== undefined ? { color: safeColor(info.color, '#36d1dc') } : {}) };
    this.lobby.setPlayerInfo(playerId, clean);
  }

  // ── Pre-race flow (delegates to Lobby) ─────────────────────────────────────────────────────────
  selectCar(playerId: string, carIndex: number): void { this.lobby.selectCar(playerId, carIndex); }
  selectMap(map: string): void { this.lobby.selectMap(map); }

  /** Host advances the flow. lobby→car_select→map_select, then map_select→start the race.
   *  From a finished race (results/finished), "advance" means PLAY AGAIN: keep the roster, clear
   *  their picks, and jump straight to car-select so they just re-choose. */
  advance(): void {
    if (this._phase === 'results' || this._phase === 'finished') {
      this.world = null; this.lastResults = []; this.raceMap = null;
      this.lobby.reset();           // back to lobby with cleared cars/map, same players
      this.lobby.advance();         // → car_select (roster is non-empty)
      this._phase = this.lobby.phase;
      return;
    }
    if (this._phase === 'map_select' && this.lobby.canStart()) { this.start(); return; }
    if (this.inPreRace) { this.lobby.advance(); this._phase = this.lobby.phase; }
  }

  /** Host steps back one selection phase (no-op once racing). */
  back(): void {
    if (this.inPreRace) { this.lobby.back(); this._phase = this.lobby.phase; }
  }

  reset(): void {
    this.world = null;
    this.lobby.reset();
    this.lastResults = [];
    this.raceMap = null;
    this._phase = 'lobby';
  }

  start(): void {
    if (this.lobby.playerCount === 0) return;
    // Evolve the seed each start so every race gets a NEW (deterministic-per-race) course.
    this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    this.raceMap = this.lobby.selectedMap;
    this.world = new RaceWorld(this.lobby.toRaceInits(), this.seed);
    this._phase = this.world.phase;
  }

  applyIntent(playerId: string, intent: Intent): void {
    this.world?.applyIntent(playerId, intent);
  }

  tick(dt: number): void {
    if (!this.world) return;
    this.world.step(dt);
    const wp = this.world.phase;
    // When the race finishes, capture standings and move to the results screen (held until reset).
    if (wp === 'finished' && this._phase === 'racing') {
      this.lastResults = this.captureResults();
      this._phase = 'results';
    } else if (this._phase === 'racing' || this._phase === 'countdown') {
      this._phase = wp;
    }
  }

  /** Final standings from the finished world (placement order). */
  private captureResults(): RaceResult[] {
    const snap = this.world?.snapshot();
    if (!snap) return [];
    return [...snap.cars]
      .sort((a, b) => a.place - b.place)
      .map(c => ({ playerId: c.id, name: c.name, carIndex: c.carIndex,
        place: c.place, finishT: c.finishT, finished: c.finished }));
  }

  results(): RaceResult[] { return this.lastResults; }

  snapshot(): WorldSnapshot | null { return this.world ? this.world.snapshot() : null; }
  drainEvents(): GameEvent[] { return this.world ? this.world.drainEvents() : []; }
  cacheEventsForBroadcast(): void { this.eventsThisBroadcast = this.drainEvents(); }
  drainEventsOnce(): GameEvent[] { return this.eventsThisBroadcast; }
}
