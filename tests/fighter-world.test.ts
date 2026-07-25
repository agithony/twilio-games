import { describe, expect, it } from 'vitest';
import { applyFighterCommand, createFighterWorld, FIGHTER_RUN_BACKWARD_DISTANCE,
  FIGHTER_RUN_BACKWARD_DURATION, FIGHTER_RUN_FORWARD_DISTANCE, FIGHTER_RUN_FORWARD_DURATION,
  FIGHTER_MIN_SEPARATION, tickFighterWorld, type FighterCommand, type FighterWorld } from '../shared/fighter-world';

describe('fighter world', () => {
  it('moves a meaningful distance with each forward and back command', () => {
    const world = createFighterWorld();
    const start = world.p1.x;
    applyFighterCommand(world, 'p1', 'back');
    expect(start - world.p1.x).toBeCloseTo(FIGHTER_RUN_BACKWARD_DISTANCE);
    expect(world.p1.busyUntil).toBeCloseTo(FIGHTER_RUN_BACKWARD_DURATION);
    tickFighterWorld(world, 1);
    const backed = world.p1.x;
    applyFighterCommand(world, 'p1', 'forward');
    expect(world.p1.x - backed).toBeCloseTo(FIGHTER_RUN_FORWARD_DISTANCE);
    expect(world.p1.busyUntil - world.now).toBeCloseTo(FIGHTER_RUN_FORWARD_DURATION);
  });
  it('moves fighters toward each other without crossing', () => {
    const world = createFighterWorld();
    for (let i = 0; i < 5; i++) {
      applyFighterCommand(world, 'p1', 'forward');
      tickFighterWorld(world, 1);
    }
    expect(world.p1.x).toBeLessThan(world.p2.x);
    expect(world.p2.x - world.p1.x).toBeCloseTo(0.82);
  });

  it('allows fighters to retreat across the wider arena', () => {
    const world = createFighterWorld();
    for (let i = 0; i < 10; i++) {
      applyFighterCommand(world, 'p1', 'back');
      tickFighterWorld(world, 1);
    }
    expect(world.p1.x).toBe(-9);
  });

  it('keeps edge jumps separated without pushing either fighter outside the arena', () => {
    const world = createFighterWorld([-1, 1]);
    world.p1.x = 1 - FIGHTER_MIN_SEPARATION; world.p2.x = 1;

    applyFighterCommand(world, 'p1', 'jump');

    expect(world.p1.x).toBeCloseTo(1 - FIGHTER_MIN_SEPARATION);
    expect(world.p2.x).toBe(1);
    expectWorldInvariant(world);
  });

  it('preserves bounds and the maximum feasible separation through varied command sequences', () => {
    const commands: FighterCommand[] = ['forward', 'back', 'jump', 'punch', 'kick', 'block'];
    for (let scenario = 1; scenario <= 48; scenario++) {
      let randomState = (scenario * 0x9e3779b9) >>> 0;
      const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; };
      const min = -12 + random() * 8, width = 0.2 + random() * 24;
      const world = createFighterWorld([min, min + width]);
      world.p1.health = 1_000_000; world.p2.health = 1_000_000;
      expectWorldInvariant(world);
      for (let step = 0; step < 200; step++) {
        const fighter = random() < 0.5 ? 'p1' : 'p2';
        applyFighterCommand(world, fighter, commands[Math.floor(random() * commands.length)]!);
        expectWorldInvariant(world);
        tickFighterWorld(world, 1.2);
        expectWorldInvariant(world);
      }
    }
  });

  it('only damages attacks that are in range', () => {
    const world = createFighterWorld();
    applyFighterCommand(world, 'p1', 'punch');
    expect(tickFighterWorld(world, 0.4)).toContainEqual({ type: 'miss', attacker: 'p1' });
    expect(world.p2.health).toBe(100);

    world.p1.x = 0;
    world.p2.x = 1;
    tickFighterWorld(world, 0.6);
    applyFighterCommand(world, 'p1', 'punch');
    tickFighterWorld(world, 0.4);
    expect(world.p2.health).toBe(91);
  });

  it('reduces damage while blocking', () => {
    const world = createFighterWorld();
    world.p1.x = 0;
    world.p2.x = 1;
    applyFighterCommand(world, 'p2', 'block');
    applyFighterCommand(world, 'p1', 'kick');
    const events = tickFighterWorld(world, 0.6);
    expect(events).toContainEqual({ type: 'hit', attacker: 'p1', defender: 'p2', damage: 3, blocked: true });
    expect(world.p2.health).toBe(97);
  });

  it('lets a jump evade an attack during its airborne window', () => {
    const world = createFighterWorld();
    world.p1.x = 0;
    world.p2.x = 1;
    applyFighterCommand(world, 'p2', 'jump');
    applyFighterCommand(world, 'p1', 'kick');
    expect(tickFighterWorld(world, 0.6)).toContainEqual({ type: 'miss', attacker: 'p1' });
    expect(world.p2.health).toBe(100);
    expect(world.p2.x).toBeLessThan(world.p1.x);
  });

  it('reverses relative forward and back after crossing over the opponent', () => {
    const world = createFighterWorld();
    world.p1.x = -1; world.p2.x = 1;
    applyFighterCommand(world, 'p1', 'jump');
    const landed = world.p1.x;
    expect(landed).toBeGreaterThan(world.p2.x);
    tickFighterWorld(world, 1);
    applyFighterCommand(world, 'p1', 'forward');
    expect(world.p1.x).toBeLessThan(landed);
    tickFighterWorld(world, 1);
    const approached = world.p1.x;
    applyFighterCommand(world, 'p1', 'back');
    expect(world.p1.x).toBeGreaterThan(approached);
  });

  it('finishes the fight at zero health', () => {
    const world = createFighterWorld();
    world.p1.x = 0;
    world.p2.x = 1;
    world.p2.health = 10;
    applyFighterCommand(world, 'p1', 'kick');
    const events = tickFighterWorld(world, 0.6);
    expect(events.at(-1)).toEqual({ type: 'ko', winner: 'p1', loser: 'p2' });
    expect(world.status).toBe('finished');
  });
});

function expectWorldInvariant(world: FighterWorld): void {
  expect(world.p1.x).toBeGreaterThanOrEqual(world.arenaMin);
  expect(world.p1.x).toBeLessThanOrEqual(world.arenaMax);
  expect(world.p2.x).toBeGreaterThanOrEqual(world.arenaMin);
  expect(world.p2.x).toBeLessThanOrEqual(world.arenaMax);
  expect(Math.abs(world.p1.x - world.p2.x) + 1e-10)
    .toBeGreaterThanOrEqual(Math.min(FIGHTER_MIN_SEPARATION, world.arenaMax - world.arenaMin));
}
