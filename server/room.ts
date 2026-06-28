import { RaceWorld } from '../shared/race-world';
import { MAX_PLAYERS, LANES } from '../shared/constants';
import type { Intent, WorldSnapshot, Phase, GameEvent } from '../shared/types';

interface RoomPlayer { id: string; name: string; color: string; lane: number; }

const COLORS = ['#36d1dc','#f22f46','#ffcf5c','#36e08a','#a06bff','#ff8a5c','#5c8aff','#ff5ca8'];

export class Room {
  readonly code: string;
  private seed: number;
  private players: RoomPlayer[] = [];
  private world: RaceWorld | null = null;
  private _phase: Phase = 'lobby';
  private nextId = 1;
  private eventsThisBroadcast: GameEvent[] = [];

  constructor(code: string, seed: number) { this.code = code; this.seed = seed; }

  get phase(): Phase { return this._phase; }
  get playerCount(): number { return this.players.length; }

  addPlayer(name: string, color?: string): { playerId: string; lane: number } | { error: string } {
    // A finished race is reusable: a new joiner reopens the room to a fresh lobby
    // (the previous result is over, and rooms are long-lived across an event).
    if (this._phase === 'finished') this.reset();
    if (this.players.length >= MAX_PLAYERS) return { error: 'room_full' };
    const lane = this.players.length % LANES;
    const id = `p${this.nextId++}`;
    const color2 = color ?? COLORS[this.players.length % COLORS.length]!;
    this.players.push({ id, name, color: color2, lane });
    // If a race is already running (countdown/racing), slot this player into the live
    // world so they get a visible, controllable car — no need to wait for a lobby.
    if (this.world && this._phase !== 'lobby') {
      this.world.addCar({ id, name, color: color2 });
    }
    return { playerId: id, lane };
  }

  removePlayer(playerId: string): void {
    this.players = this.players.filter(p => p.id !== playerId);
    // An abandoned race (everyone disconnected) must not lock the room forever —
    // reset it to a fresh lobby so the code is immediately reusable.
    if (this.players.length === 0 && this._phase !== 'lobby') this.reset();
  }

  /** Return the room to a fresh lobby (keeps the joined players, drops the world). */
  reset(): void {
    this.world = null;
    this._phase = 'lobby';
  }

  start(): void {
    if (this.players.length === 0) return;
    // Restartable: starting from any phase rebuilds a fresh race for the current players.
    this.world = new RaceWorld(
      this.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
      this.seed,
    );
    this._phase = this.world.phase;
  }

  applyIntent(playerId: string, intent: Intent): void {
    this.world?.applyIntent(playerId, intent);
  }

  tick(dt: number): void {
    if (!this.world) return;
    this.world.step(dt);
    this._phase = this.world.phase;
  }

  snapshot(): WorldSnapshot | null { return this.world ? this.world.snapshot() : null; }
  drainEvents(): GameEvent[] { return this.world ? this.world.drainEvents() : []; }
  /** Cache events once per broadcast so every connection in the room sees them. */
  cacheEventsForBroadcast(): void { this.eventsThisBroadcast = this.drainEvents(); }
  drainEventsOnce(): GameEvent[] { return this.eventsThisBroadcast; }
}
