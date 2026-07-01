// Attract mode: a self-driving demo loop behind the menu. When no real race is live, we synthesize
// WorldSnapshots of a few AI cars cruising the neon track and feed them straight to renderer.render()
// — so the menu sits as a glass overlay over actual moving gameplay (AAA "attract screen"). No
// server involved; purely client-side. Cars weave lanes gently and the field camera frames the pack.
import { BASE_SPEED, LANES, laneX, RACE_LEN } from '../shared/constants';
import type { WorldSnapshot, CarState } from '../shared/types';

const DEMO_COLORS = ['#36d1dc', '#ff5a4d', '#ffd23f', '#36e08a', '#a06bff', '#5c8aff'];

interface DemoCar {
  id: string; color: string; carIndex: number;
  base: number;       // base speed (units/s)
  lanePhase: number;  // phase offset for lane weaving
  laneRate: number;   // how often it changes lanes
  z: number;          // cumulative distance (wraps)
}

/**
 * Drives the renderer with a looping autopilot demo. start() kicks the rAF loop; stop() halts it
 * (call when a real race begins). render(snap) is injected so this stays decoupled from the Renderer
 * type and trivially testable; nextSnapshot(t) is pure.
 */
export class AttractMode {
  private cars: DemoCar[];
  private raf = 0;
  private running = false;
  // PRIME the clock so the FIRST rendered frame already has cars spread out mid-track (not clustered
  // at the start line) and the field camera frames them in place — no spawn-pop, no camera snap when
  // the veil lifts. ~6s of simulated motion before frame one.
  private t = 6;
  private last = 0;

  constructor(private render: (snap: WorldSnapshot) => void, carCount = 5) {
    const n = Math.max(2, Math.min(carCount, DEMO_COLORS.length));
    this.cars = Array.from({ length: n }, (_, i) => ({
      id: `demo${i}`, color: DEMO_COLORS[i % DEMO_COLORS.length]!,
      carIndex: i,                                  // vary the models on show
      base: BASE_SPEED * (0.82 + 0.1 * i),          // staggered speeds so they jostle
      lanePhase: i * 1.7, laneRate: 0.18 + 0.05 * i,
      z: i * 40,                                    // spaced down-track (further apart for a cleaner pack)
    }));
  }

  /** Pure: the demo snapshot at absolute time `t` (seconds). Lanes weave via a sine; z wraps RACE_LEN
   *  so the loop never ends. Exposed for tests. */
  nextSnapshot(t: number): WorldSnapshot {
    const cars: CarState[] = this.cars.map((c) => {
      const z = ((c.z + c.base * t) % RACE_LEN + RACE_LEN) % RACE_LEN;
      // CONTINUOUS lane weave: glide x smoothly across the full lane span via the sine — never snap
      // to discrete lane centers (that teleported the cars). laneF ∈ [0, LANES-1] as a float; x is
      // its lane-center interpolation, so the car drifts fluidly between lanes.
      const laneF = (Math.sin(t * c.laneRate + c.lanePhase) * 0.5 + 0.5) * (LANES - 1);
      const x = laneX(0) + (laneX(LANES - 1) - laneX(0)) * (laneF / (LANES - 1));
      const lane = Math.round(laneF);   // integer lane kept for any consumer; rendering uses x
      return {
        id: c.id, name: '', color: c.color, carIndex: c.carIndex,
        lane, targetLane: lane, x, z,
        speed: c.base, boost: 0, power: 0, powerActive: 0, invulnerable: false, stunned: 0,
        lap: 1, finished: false, finishT: 0, place: 1,
      };
    });
    return { tick: Math.floor(t * 60), t, phase: 'racing', countdown: 0, cars, items: [], consumedItems: [] };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      this.t += Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.render(this.nextSnapshot(this.t));
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isRunning(): boolean { return this.running; }
}
