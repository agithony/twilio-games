import { Rng } from './rng';
import {
  LANES, LAP_TARGET, TRACK_LEN, RACE_LEN, BASE_SPEED, MAX_RACE_SECONDS,
  ITEM_START, laneX, BOOST_MAX, BOOST_MIN, BOOST_SPEED_PER,
  POWER_BOOST, POWER_ACTIVE_SECS, POWER_MAX, POWER_START, BARRIER_STUN_SECS,
} from './constants';
import { generateCourse } from './course-gen';
import type { Intent, Item, CarState, WorldSnapshot, Phase, GameEvent } from './types';

interface PlayerInit { id: string; name: string; color: string; carIndex?: number; }

const COUNTDOWN_SECONDS = 3.2;
const BOOST_RESPAWN = 0.5;   // seconds a collected boost stays gone before respawning for trailers

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
  /** Previous-frame place per car, so we can fire a one-shot "fell to last" callout on the edge. */
  private prevPlace = new Map<string, number>();
  /** Tracks which item ids have already been triggered per car. playerId -> Set<itemId> */
  private hits = new Map<string, Set<number>>();
  /** Boosts are SHARED consumables: the first car to touch one collects it, and it's hidden until
   *  this sim-time, then respawns for trailing players. boostItemId -> sim-time it reappears. */
  private consumedUntil = new Map<number, number>();

  constructor(players: PlayerInit[], seed: number) {
    this.rng = new Rng(seed);
    this.cars = players.map((p, i) => ({
      id: p.id, name: p.name, color: p.color, carIndex: p.carIndex ?? 0,
      lane: i % LANES, targetLane: i % LANES,
      x: laneX(i % LANES), z: -i * 3,
      speed: BASE_SPEED, boost: 0, power: POWER_START, powerActive: 0, invulnerable: false, stunned: 0,
      lap: 1, finished: false, finishT: 0, place: i + 1,
    }));
    // Initialize hits map for each player + seed prev-place from the STARTING GRID (place = i+1) so
    // the first real place change during the race is detected as an edge (a car that immediately
    // drops to last still fires fell_to_last, instead of the default masking the first transition).
    for (let i = 0; i < players.length; i++) {
      this.hits.set(players[i]!.id, new Set<number>());
      this.prevPlace.set(players[i]!.id, i + 1);
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
      id: p.id, name: p.name, color: p.color, carIndex: p.carIndex ?? 0,
      lane, targetLane: lane, x: laneX(lane), z: rearZ,
      speed: BASE_SPEED, boost: 0, power: POWER_START, powerActive: 0, invulnerable: false, stunned: 0,
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
      case 'BOOST':      c.boost = Math.min(c.boost + 1.4, BOOST_MAX); break;
      case 'BRAKE':      c.boost = Math.max(c.boost - 1.6, BOOST_MIN); break;
      case 'USE_POWER':  if (c.power > 0) { c.power--; c.powerActive = POWER_ACTIVE_SECS; } break;
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
      // A finished car coasts a LITTLE past the line for a natural stop, but is CLAMPED so it doesn't
      // glide off the end of the track into empty space (the "stuck at the end" look). It's done.
      if (c.finished) { c.z = Math.min(c.z + BASE_SPEED * dt, RACE_LEN + 60); continue; }
      // player boost decays toward cruise; AI handled by server-side controllers later
      c.boost = lerp(c.boost, 0, 0.6 * dt);
      const tx = laneX(c.targetLane);
      c.x = lerp(c.x, tx, 1 - Math.pow(0.0001, dt));
      c.lane = c.targetLane;
      if (c.powerActive > 0) c.powerActive -= dt;
      if (c.stunned > 0) c.stunned -= dt;
      const powerBoost = c.powerActive > 0 ? POWER_BOOST : 0;
      const stunPenalty = c.stunned > 0 ? -18 : 0;
      c.speed = Math.max(8, BASE_SPEED + c.boost * BOOST_SPEED_PER + powerBoost + stunPenalty);
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
    // SAFETY TIMEOUT: if the race runs past MAX_RACE_SECONDS (a car wedged/very slow/disconnected mid-
    // race), force-finish everyone still going so the race ALWAYS ends + shows results — no hang.
    // Stragglers are marked DNF (finishT=0) so the scoreboard renders them as such.
    if (this.t >= MAX_RACE_SECONDS) {
      for (const c of this.cars) if (!c.finished) { c.finished = true; c.finishT = 0; }
    }
    // Race ends when every remaining car has finished. An EMPTY world (all players left
    // mid-race) also ends — `every` is true for [] — so a fully-abandoned race transitions
    // to finished instead of ticking forever, letting the server reset/clean up the room.
    if (this.cars.every(c => c.finished)) {
      this._phase = 'finished';
      this.events.push({ kind: 'race_over' });
    }
  }

  /**
   * Remove a car from the live race (a player who left / a phone caller who hung up). Without this
   * a disconnected racer's unfinished car would keep `cars.every(finished)` false forever, so the
   * race could never end and the room would wedge. No-op if the id isn't present.
   */
  removeCar(id: string): void {
    const i = this.cars.findIndex(c => c.id === id);
    if (i === -1) return;
    this.cars.splice(i, 1);
    this.hits.delete(id);
    if (this.leadId === id) this.leadId = null;   // re-detect the leader next step
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
          if (it.kind === 'barrier') {
            // Barriers are hazards (not consumed) — edge-trigger once per car per item.
            if (set.has(it.id)) continue;
            set.add(it.id);
            // POWER DASH is INVULNERABLE: while active, the car smashes THROUGH the barrier unharmed
            // (no stun, no speed loss). This is what makes POWER a distinct ABILITY, not just "faster"
            // — save it to blast through a wall you can't dodge. Emit a distinct event for the crash-
            // through visual/audio (renderer keys the flame+shatter off it).
            if (c.powerActive > 0) {
              this.events.push({ kind: 'barrier_smashed', playerId: c.id, itemId: it.id });
              continue;
            }
            c.stunned = BARRIER_STUN_SECS; c.boost = -0.6;
            this.events.push({ kind: 'hit', playerId: c.id });
            // Milestone: every 3rd barrier this car has hit → a "barrier magnet" callout (set.size
            // is the running total of distinct barriers this car has clipped).
            if (set.size % 3 === 0) {
              this.events.push({ kind: 'hit_streak', playerId: c.id, name: c.name, count: set.size });
            }
          } else {
            // Orb = SHARED consumable: skip if currently picked-up (waiting to respawn). The FIRST
            // car to reach an available orb collects it; it vanishes for BOOST_RESPAWN seconds.
            const goneUntil = this.consumedUntil.get(it.id);
            if (goneUntil !== undefined && this.t < goneUntil) continue;
            // BANK a dash charge (capped) — do NOT auto-activate. The player spends it by saying
            // "power" (USE_POWER). This keeps the dash a deliberate, saved-up move.
            c.power = Math.min(c.power + 1, POWER_MAX);
            this.consumedUntil.set(it.id, this.t + BOOST_RESPAWN);
            this.events.push({ kind: 'boost_taken', playerId: c.id, itemId: it.id });
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
    // "Fell to last" callout: fire once on the EDGE when a car drops INTO last place (needs ≥3 cars
    // so it's a real setback, not a 2-player back-and-forth). prevPlace is seeded from the starting
    // grid, so a car that STARTS last (was===last) never false-fires; only a genuine drop does.
    const last = this.cars.length;
    if (last >= 3) {
      for (const c of this.cars) {
        const was = this.prevPlace.get(c.id) ?? c.place;
        if (c.place === last && was !== last && !c.finished) {
          this.events.push({ kind: 'fell_to_last', playerId: c.id, name: c.name });
        }
      }
    }
    for (const c of this.cars) this.prevPlace.set(c.id, c.place);
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
        id: c.id, name: c.name, color: c.color, carIndex: c.carIndex,
        lane: c.lane, targetLane: c.targetLane,
        x: c.x, z: c.z, speed: c.speed, boost: c.boost, power: c.power,
        powerActive: c.powerActive, invulnerable: c.powerActive > 0, stunned: c.stunned, lap: c.lap,
        finished: c.finished, finishT: c.finishT, place: c.place,
      })),
      items: this.items,
      // Boosts currently picked-up (t < respawn time) — clients hide + play the pickup pop.
      consumedItems: [...this.consumedUntil.entries()].filter(([, t]) => this.t < t).map(([id]) => id),
    };
  }
}

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
