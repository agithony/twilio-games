// The in-race personal HUD (power charge + boost bar) must only appear for a REAL local player.
// On a shared/spectator display (no myId) it must stay hidden so it isn't an ambiguous distraction
// with several phone players on one screen. hudStateFor() encodes that gate + the charge/boost read.
import { describe, it, expect } from 'vitest';
import { hudStateFor } from '../client/hud-state';
import type { WorldSnapshot, CarState } from '../shared/types';

function car(over: Partial<CarState> = {}): CarState {
  return {
    id: 'p1', name: 'Me', color: '#0af', carIndex: 0, lane: 1, targetLane: 1, x: 0, z: 100,
    speed: 38, boost: 0, power: 1, powerActive: 0, invulnerable: false, stunned: 0, lap: 1, finished: false, finishT: 0, place: 1,
    ...over,
  };
}
function snap(cars: CarState[]): WorldSnapshot {
  return { tick: 1, t: 1, phase: 'racing', countdown: 0, cars, items: [], consumedItems: [] };
}

describe('hudStateFor', () => {
  it('HIDES the HUD on a shared/spectator display (no myId) — avoids ambiguity with many players', () => {
    expect(hudStateFor(snap([car({ id: 'p1' }), car({ id: 'p2' })]), null)).toEqual({ show: false });
  });

  it('HIDES when my car is not in the race (spectating someone else / not spawned)', () => {
    expect(hudStateFor(snap([car({ id: 'p2' })]), 'p1')).toEqual({ show: false });
  });

  it('HIDES when there is no snapshot yet', () => {
    expect(hudStateFor(null, 'p1')).toEqual({ show: false });
  });

  it('HIDES once my car has finished (race HUD is irrelevant post-finish)', () => {
    expect(hudStateFor(snap([car({ id: 'p1', finished: true })]), 'p1')).toEqual({ show: false });
  });

  it('shows power READY when I have a charge and it is not firing', () => {
    const h = hudStateFor(snap([car({ id: 'p1', power: 1, powerActive: 0 })]), 'p1');
    expect(h.show).toBe(true);
    expect(h.powerReady).toBe(true);
    expect(h.powerActive).toBe(false);
    expect(h.charges).toBe(1);
  });

  it('shows power ACTIVE (and not ready) while the nitro burst is firing with no charge left', () => {
    const h = hudStateFor(snap([car({ id: 'p1', power: 0, powerActive: 1.5 })]), 'p1');
    expect(h.powerReady).toBe(false);      // spent
    expect(h.powerActive).toBe(true);      // burst in progress
    expect(h.charges).toBe(0);
  });

  it('reports spent power (no charge, not firing) as neither ready nor active', () => {
    const h = hudStateFor(snap([car({ id: 'p1', power: 0, powerActive: 0 })]), 'p1');
    expect(h.powerReady).toBe(false);
    expect(h.powerActive).toBe(false);
  });

  it('passes through the boost modifier and stun flag for the bar', () => {
    const h = hudStateFor(snap([car({ id: 'p1', boost: 1.8, stunned: 0.5 })]), 'p1');
    expect(h.boost).toBeCloseTo(1.8, 5);
    expect(h.stunned).toBe(true);
  });
});
