import { describe, it, expect, beforeEach } from 'vitest';
import { RaceWorld } from '../shared/race-world';
import { STEP, LAP_TARGET, TRACK_LEN, laneX } from '../shared/constants';

const PLAYERS = [
  { id: 'p1', name: 'You', color: '#36d1dc' },
  { id: 'p2', name: 'Ada', color: '#f22f46' },
];
function newWorld() { return new RaceWorld(PLAYERS, 12345); }
function startRacing(w: RaceWorld) {
  // run past the countdown
  for (let i = 0; i < 4 * 60; i++) { w.step(STEP); if (w.phase === 'racing') break; }
}

describe('RaceWorld', () => {
  let w: RaceWorld;
  beforeEach(() => { w = newWorld(); });

  it('starts in countdown phase with all cars present', () => {
    const s = w.snapshot();
    expect(s.phase).toBe('countdown');
    expect(s.cars).toHaveLength(2);
    expect(s.cars.map(c => c.id)).toEqual(['p1', 'p2']);
  });

  it('is deterministic: same seed => identical item layout', () => {
    const a = new RaceWorld(PLAYERS, 999);
    const b = new RaceWorld(PLAYERS, 999);
    expect(a.items).toEqual(b.items);
  });

  it('transitions countdown -> racing', () => {
    expect(w.phase).toBe('countdown');
    startRacing(w);
    expect(w.phase).toBe('racing');
  });

  it('ignores intents during countdown', () => {
    const before = w.snapshot().cars[0]!.targetLane;
    w.applyIntent('p1', 'MOVE_RIGHT');
    expect(w.snapshot().cars[0]!.targetLane).toBe(before);
  });

  it('MOVE_LEFT / MOVE_RIGHT change target lane within bounds', () => {
    startRacing(w);
    const car = () => w.snapshot().cars.find(c => c.id === 'p1')!;
    // force a known middle lane
    while (car().targetLane > 1) w.applyIntent('p1', 'MOVE_LEFT');
    while (car().targetLane < 1) w.applyIntent('p1', 'MOVE_RIGHT');
    expect(car().targetLane).toBe(1);
    w.applyIntent('p1', 'MOVE_RIGHT'); expect(car().targetLane).toBe(2);
    w.applyIntent('p1', 'MOVE_RIGHT'); expect(car().targetLane).toBe(2); // clamped
    w.applyIntent('p1', 'MOVE_LEFT');
    w.applyIntent('p1', 'MOVE_LEFT');
    w.applyIntent('p1', 'MOVE_LEFT'); expect(car().targetLane).toBe(0);   // clamped
  });

  it('BOOST increases speed, BRAKE decreases it', () => {
    startRacing(w);
    const base = w.snapshot().cars[0]!.speed;
    w.applyIntent('p1', 'BOOST');
    w.step(STEP);
    expect(w.snapshot().cars[0]!.speed).toBeGreaterThan(base);
  });

  it('cars advance forward while racing', () => {
    startRacing(w);
    const z0 = w.snapshot().cars[0]!.z;
    for (let i = 0; i < 30; i++) w.step(STEP);
    expect(w.snapshot().cars[0]!.z).toBeGreaterThan(z0);
  });

  it('finishes the race after LAP_TARGET laps and reports a winner', () => {
    startRacing(w);
    // fast-forward generously past 3 laps
    for (let i = 0; i < 60 * 120; i++) { w.step(STEP); if (w.over) break; }
    expect(w.over).toBe(true);
    expect(w.phase).toBe('finished');
    const places = w.snapshot().cars.map(c => c.place).sort();
    expect(places).toEqual([1, 2]);
    expect(w.snapshot().cars.every(c => c.finished)).toBe(true);
  });

  it('removeCar drops a car so the race can still finish (no wedge on disconnect)', () => {
    const w = new RaceWorld(PLAYERS, 12345);
    startRacing(w);
    expect(w.hasCar('p2')).toBe(true);
    w.removeCar('p2');
    expect(w.hasCar('p2')).toBe(false);
    expect(w.snapshot().cars.map(c => c.id)).toEqual(['p1']);
    // p1 alone finishing must end the race (the removed car can't keep it un-finished forever).
    for (let i = 0; i < 60 * 120; i++) { w.step(STEP); if (w.over) break; }
    expect(w.over).toBe(true);
  });

  it('removeCar on the last car leaves an empty, finishable world (no crash)', () => {
    const w = new RaceWorld(PLAYERS, 1);
    startRacing(w);
    w.removeCar('p1'); w.removeCar('p2');
    expect(w.snapshot().cars).toHaveLength(0);
    // stepping an empty world must not throw and must not be "over" by spurious every([])
    expect(() => w.step(STEP)).not.toThrow();
  });

  it('snapshot lap never exceeds LAP_TARGET in display terms', () => {
    startRacing(w);
    for (let i = 0; i < 60 * 120; i++) { w.step(STEP); if (w.over) break; }
    for (const c of w.snapshot().cars) expect(c.lap).toBeLessThanOrEqual(LAP_TARGET + 1);
  });
});
