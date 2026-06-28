import { Rng } from './rng';
import {
  LANES, LAP_TARGET, TRACK_LEN, BASE_SPEED,
  ITEM_START, laneX,
} from './constants';
import { generateCourse } from './course-gen';
import type { Intent, Item, CarState, WorldSnapshot, Phase, GameEvent } from './types';

interface PlayerInit { id: string; name: string; color: string; }

const COUNTDOWN_SECONDS = 3.2;

export class RaceWorld {
  readonly items: Item[] = [];
  private cars: CarState[];
  private rng: Rng;
  private tick = 0;
  private t = 0;
  private countdown = COUNTDOWN_SECONDS;
  private _phase: Phase = 'countdown';
  private events: GameEvent[] = [];
  private leadId: string | null = null;
  /** Tracks which item ids have already been triggered per car. playerId -> Set<itemId> */
  private hits = new Map<string, Set<number>>();

  constructor(players: PlayerInit[], seed: number) {
    this.rng = new Rng(seed);
    this.cars = players.map((p, i) => ({
      id: p.id, name: p.name, color: p.color,
      lane: i % LANES, targetLane: i % LANES,
      x: laneX(i % LANES), z: -i * 3,
      speed: BASE_SPEED, boost: 0, power: 1, powerActive: 0, stunned: 0,
      lap: 1, finished: false, finishT: 0, place: i + 1,
    }));
    // Initialize hits map for each player
    for (const p of players) {
      this.hits.set(p.id, new Set<number>());
    }
    // Pre-generate a smart, fair gauntlet (deterministic via rng, so all clients agree;
    // VARIETY comes from the per-race seed chosen at Room.start()). See course-gen.ts:
    // every row is solvable, barriers are spaced for voice-reaction time, difficulty ramps.
    this.items.push(...generateCourse(this.rng, {
      lanes: LANES,
      startZ: ITEM_START,
      endZ: TRACK_LEN * LAP_TARGET,
    }));
  }

  get phase(): Phase { return this._phase; }
  get over(): boolean { return this._phase === 'finished'; }

  /** True if a car with this id already exists in the sim. */
  hasCar(id: string): boolean { return this.cars.some(c => c.id === id); }

  /**
   * Add a car to an already-running race (a player who joined after start — e.g. a
   * phone caller). The car spawns near the current pack so it's immediately visible
   * and in play. No-op if the id already exists.
   */
  addCar(p: PlayerInit): void {
    if (this.hasCar(p.id)) return;
    const lane = this.cars.length % LANES;
    // Spawn at the rear of the current pack so it appears on-screen, not at z=0.
    const rearZ = this.cars.length ? Math.min(...this.cars.map(c => c.z)) - 4 : 0;
    this.cars.push({
      id: p.id, name: p.name, color: p.color,
      lane, targetLane: lane, x: laneX(lane), z: rearZ,
      speed: BASE_SPEED, boost: 0, power: 1, powerActive: 0, stunned: 0,
      lap: 1, finished: false, finishT: 0, place: this.cars.length + 1,
    });
    this.hits.set(p.id, new Set<number>());
  }

  /** Drain queued announcer events (server polls this each broadcast). */
  drainEvents(): GameEvent[] { const e = this.events; this.events = []; return e; }

  applyIntent(playerId: string, intent: Intent): void {
    if (this._phase !== 'racing') return;
    const c = this.cars.find(x => x.id === playerId);
    if (!c || c.finished) return;
    switch (intent) {
      case 'MOVE_LEFT':  c.targetLane = clamp(c.targetLane - 1, 0, LANES - 1); break;
      case 'MOVE_RIGHT': c.targetLane = clamp(c.targetLane + 1, 0, LANES - 1); break;
      case 'BOOST':      c.boost = Math.min(c.boost + 1.4, 2.2); break;
      case 'BRAKE':      c.boost = Math.max(c.boost - 1.6, -1.4); break;
      case 'USE_POWER':  if (c.power > 0) { c.power--; c.powerActive = 2.2; } break;
    }
  }

  step(dt: number): void {
    if (this._phase === 'countdown') {
      const prev = Math.ceil(this.countdown);
      this.countdown -= dt;
      const now = Math.ceil(this.countdown);
      if (now !== prev && now >= 1) this.events.push({ kind: 'countdown', n: now });
      if (this.countdown <= 0) { this._phase = 'racing'; this.events.push({ kind: 'go' }); }
      return;
    }
    if (this._phase !== 'racing') return;

    this.tick++; this.t += dt;
    for (const c of this.cars) {
      if (c.finished) { c.z += BASE_SPEED * dt; continue; }
      // player boost decays toward cruise; AI handled by server-side controllers later
      c.boost = lerp(c.boost, 0, 0.6 * dt);
      const tx = laneX(c.targetLane);
      c.x = lerp(c.x, tx, 1 - Math.pow(0.0001, dt));
      c.lane = c.targetLane;
      if (c.powerActive > 0) c.powerActive -= dt;
      if (c.stunned > 0) c.stunned -= dt;
      const powerBoost = c.powerActive > 0 ? 16 : 0;
      const stunPenalty = c.stunned > 0 ? -18 : 0;
      c.speed = Math.max(8, BASE_SPEED + c.boost * 12 + powerBoost + stunPenalty);
      c.z += c.speed * dt;
      if (c.z >= TRACK_LEN * c.lap) {
        c.lap++;
        if (c.lap > LAP_TARGET) {
          c.finished = true; c.finishT = this.t;
          this.events.push({ kind: 'finish', playerId: c.id, name: c.name, place: 0 });
        }
      }
    }
    this.resolveItems();
    this.resolveCollisions(dt);
    this.updatePlaces();
    this.detectLeadChange();
    if (this.cars.every(c => c.finished)) {
      this._phase = 'finished';
      this.events.push({ kind: 'race_over' });
    }
  }

  private resolveItems(): void {
    for (const c of this.cars) {
      if (c.finished) continue;
      let set = this.hits.get(c.id);
      if (!set) {
        set = new Set<number>();
        this.hits.set(c.id, set);
      }
      for (const it of this.items) {
        if (Math.abs(it.z - c.z) < 2.2 && it.lane === c.lane) {
          // edge-trigger: only fire once per car per item
          if (set.has(it.id)) continue;
          set.add(it.id);
          if (it.kind === 'barrier') {
            c.stunned = 0.8; c.boost = -0.6;
            this.events.push({ kind: 'hit', playerId: c.id });
          } else {
            c.powerActive = Math.max(c.powerActive, 1.4);
          }
        }
      }
    }
  }

  private resolveCollisions(dt: number): void {
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i]!, b = this.cars[j]!;
        if (Math.abs(a.z - b.z) < 3.4 && Math.abs(a.x - b.x) < 2.0) {
          const push = a.x <= b.x ? -1 : 1;
          a.x += push * 1.2 * dt * 8; b.x -= push * 1.2 * dt * 8;
          a.boost *= 0.9; b.boost *= 0.9;
          a.x = clamp(a.x, laneX(0), laneX(LANES - 1));
          b.x = clamp(b.x, laneX(0), laneX(LANES - 1));
        }
      }
    }
  }

  private updatePlaces(): void {
    const order = [...this.cars].sort((p, q) => {
      if (p.finished && q.finished) return p.finishT - q.finishT;
      if (p.finished) return -1; if (q.finished) return 1;
      return q.z - p.z;
    });
    order.forEach((c, i) => { c.place = i + 1; });
    // backfill finish-event places (they were pushed with place 0)
    for (const e of this.events) {
      if (e.kind === 'finish' && e.place === 0) {
        const c = this.cars.find(x => x.id === e.playerId);
        if (c) e.place = c.place;
      }
    }
  }

  private detectLeadChange(): void {
    const leader = this.cars.find(c => c.place === 1);
    if (leader && leader.id !== this.leadId) {
      this.leadId = leader.id;
      if (this.t > 0.5) this.events.push({ kind: 'lead_change', playerId: leader.id, name: leader.name });
    }
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick, t: this.t, phase: this._phase,
      countdown: Math.max(0, this.countdown),
      cars: this.cars.map(c => ({
        id: c.id, name: c.name, color: c.color, lane: c.lane, targetLane: c.targetLane,
        x: c.x, z: c.z, speed: c.speed, boost: c.boost, power: c.power,
        powerActive: c.powerActive, stunned: c.stunned, lap: c.lap,
        finished: c.finished, finishT: c.finishT, place: c.place,
      })),
      items: this.items,
    };
  }
}

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
