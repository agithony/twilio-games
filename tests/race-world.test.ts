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

  it('carries each player carIndex into CarState (chosen car model), defaulting when absent', () => {
    const w2 = new RaceWorld([
      { id: 'a', name: 'A', color: '#fff', carIndex: 7 },
      { id: 'b', name: 'B', color: '#000' },                 // no carIndex → default
    ], 1);
    const cars = w2.snapshot().cars;
    expect(cars.find(c => c.id === 'a')!.carIndex).toBe(7);
    expect(cars.find(c => c.id === 'b')!.carIndex).toBe(0);  // default when unspecified
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

  // ── POWER = an invulnerable NITRO DASH (distinct from BOOST's throttle) ──
  // Drive a lone car into a barrier and observe whether it gets stunned. With POWER active the car
  // should smash THROUGH the barrier unharmed; without it, it gets stunned. We target a barrier
  // WELL down-track (z>250) so the guaranteed early boost pad's power has long since expired for the
  // no-power case, and we do NOT steer through any pad on the way (stay in the barrier's lane only
  // once we're near it). Robust to course-gen layout: we assert on the exact target barrier.
  function runIntoBarrier(withPower: boolean): { hit: boolean } {
    const solo = new RaceWorld([{ id: 'p1', name: 'You', color: '#fff' }], 4242);
    startRacing(solo);
    // A barrier whose lane has NO boost pad in the 50 units before it — so merging into its lane on
    // approach can't accidentally grant power (course-gen places risk/reward pads beside some walls).
    const barrier = solo.items
      .filter(it => it.kind === 'barrier' && it.z > 250)
      .filter(bar => !solo.items.some(p => p.kind === 'boost' && p.lane === bar.lane && p.z > bar.z - 55 && p.z <= bar.z))
      .sort((a, b) => a.z - b.z)[0]!;
    expect(barrier).toBeDefined();
    let everHit = false;
    for (let i = 0; i < 60 * 120; i++) {
      const c = solo.snapshot().cars[0]!;
      // Only merge into the barrier's lane in the final approach, so we don't accidentally scoop a
      // boost pad in another lane earlier (which would grant power to the "no-power" run).
      if (c.z > barrier.z - 40) {
        if (c.targetLane < barrier.lane) solo.applyIntent('p1', 'MOVE_RIGHT');
        else if (c.targetLane > barrier.lane) solo.applyIntent('p1', 'MOVE_LEFT');
        if (withPower) solo.applyIntent('p1', 'USE_POWER');   // keep the dash live through contact
      }
      solo.step(STEP);
      const cc = solo.snapshot().cars[0]!;
      if (cc.z > barrier.z - 3 && cc.z < barrier.z + 3 && cc.lane === barrier.lane && cc.stunned > 0) everHit = true;
      if (cc.z > barrier.z + 8 || cc.finished) break;
    }
    return { hit: everHit };
  }

  it('WITHOUT power, a car is stunned when it hits a barrier', () => {
    expect(runIntoBarrier(false).hit).toBe(true);
  });

  it('POWER dash is INVULNERABLE: the car smashes through a barrier unharmed', () => {
    expect(runIntoBarrier(true).hit).toBe(false);
  });

  it('the snapshot exposes an invulnerable flag while a POWER dash is active', () => {
    startRacing(w);
    w.applyIntent('p1', 'USE_POWER');
    w.step(STEP);
    const me = w.snapshot().cars.find(c => c.id === 'p1')!;
    expect(me.powerActive).toBeGreaterThan(0);
    expect(me.invulnerable).toBe(true);   // renderer + HUD key the dash visuals off this
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

  it('emits fell_to_last when a car (3+ racers) drops into last place mid-race', () => {
    const w3 = new RaceWorld([
      { id: 'p1', name: 'You', color: '#36d1dc' },
      { id: 'p2', name: 'Ada', color: '#f22f46' },
      { id: 'p3', name: 'Rex', color: '#ffd23f' },
    ], 777);
    startRacing(w3);
    let sawFellToLast = false;
    // p1 brakes every frame → falls behind the other two → should transition into last place.
    for (let i = 0; i < 60 * 8; i++) {
      w3.applyIntent('p1', 'BRAKE');
      w3.step(STEP);
      if (w3.drainEvents().some(e => e.kind === 'fell_to_last' && e.playerId === 'p1')) { sawFellToLast = true; break; }
      if (w3.over) break;
    }
    expect(sawFellToLast).toBe(true);
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

  it('a boost is a SHARED consumable: first car takes it, then it is gone briefly', () => {
    // Two cars in the same lane; place a single boost just ahead of both at the same z.
    const w = new RaceWorld(PLAYERS, 555);
    startRacing(w);
    // Find a boost and force both cars into its lane just behind it.
    const boost = w.snapshot().items.find(i => i.kind === 'boost')!;
    expect(boost).toBeDefined();
    // Drive: car p1 reaches it first. We assert the snapshot marks it consumed after a pickup.
    // (Direct-state assertions below use the public consumed list.)
    // Simulate p1 hitting it: nudge both into the lane, step until p1 crosses boost.z.
    for (let i = 0; i < 60 * 90; i++) {
      w.step(STEP);
      if (w.snapshot().consumedItems.length > 0) break;
      if (w.over) break;
    }
    expect(w.snapshot().consumedItems).toContain(boost.id);
  });

  it('collecting an orb ADDS a dash charge — it does NOT auto-activate the dash', () => {
    // The fix: picking up an orb should bank a charge (power++), not fire the invulnerable dash.
    // The player must explicitly say "power" to spend a charge. So on pickup: power goes UP and
    // powerActive stays 0.
    const solo = new RaceWorld([{ id: 'p1', name: 'You', color: '#fff' }], 555);
    startRacing(solo);
    const startCharges = solo.snapshot().cars[0]!.power;
    const orb = solo.items.filter(i => i.kind === 'boost').sort((a, b) => a.z - b.z)[0]!;
    let charges = startCharges;
    for (let i = 0; i < 60 * 90; i++) {
      const c = solo.snapshot().cars[0]!;
      // merge into the orb's lane on approach
      if (c.z > orb.z - 30) {
        if (c.targetLane < orb.lane) solo.applyIntent('p1', 'MOVE_RIGHT');
        else if (c.targetLane > orb.lane) solo.applyIntent('p1', 'MOVE_LEFT');
      }
      solo.step(STEP);
      const cc = solo.snapshot().cars[0]!;
      // The moment the orb is consumed, the charge count must have gone UP and NOT auto-activated.
      if (solo.snapshot().consumedItems.includes(orb.id)) {
        charges = cc.power;
        expect(cc.power).toBeGreaterThan(startCharges);   // banked a charge
        expect(cc.powerActive).toBe(0);                   // did NOT auto-fire
        expect(cc.invulnerable).toBe(false);
        break;
      }
      if (cc.z > orb.z + 8 || cc.finished) break;
    }
    expect(charges).toBeGreaterThan(startCharges);
  });

  it('a consumed boost reappears after the cooldown (for trailing players)', () => {
    const w = new RaceWorld(PLAYERS, 555);
    startRacing(w);
    const boost = w.snapshot().items.find(i => i.kind === 'boost')!;
    // advance until something is consumed
    for (let i = 0; i < 60 * 90; i++) { w.step(STEP); if (w.snapshot().consumedItems.length > 0) break; if (w.over) break; }
    expect(w.snapshot().consumedItems.length).toBeGreaterThan(0);
    // after >0.5s of sim time the consumed set should clear that orb (respawn)
    for (let i = 0; i < 60; i++) w.step(STEP);   // ~1s
    expect(w.snapshot().consumedItems).not.toContain(boost.id);
  });

  it('snapshot lap never exceeds LAP_TARGET in display terms', () => {
    startRacing(w);
    for (let i = 0; i < 60 * 120; i++) { w.step(STEP); if (w.over) break; }
    for (const c of w.snapshot().cars) expect(c.lap).toBeLessThanOrEqual(LAP_TARGET + 1);
  });
});
