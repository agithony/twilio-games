export type FighterId = 'p1' | 'p2';
export type FighterCommand = 'forward' | 'back' | 'jump' | 'punch' | 'kick' | 'block';
export type FighterStatus = 'fighting' | 'finished';

export interface CombatantState {
  health: number;
  x: number;
  busyUntil: number;
  blockingUntil: number;
  airborneUntil: number;
}

interface PendingAttack {
  attacker: FighterId;
  command: 'punch' | 'kick';
  impactAt: number;
}

export interface FighterWorld {
  now: number;
  status: FighterStatus;
  winner: FighterId | null;
  p1: CombatantState;
  p2: CombatantState;
  pending: PendingAttack[];
  arenaMin: number;
  arenaMax: number;
}

export type FighterEvent =
  | { type: 'action'; fighter: FighterId; command: FighterCommand }
  | { type: 'move'; fighter: FighterId; from: number; to: number; jump?: boolean }
  | { type: 'hit'; attacker: FighterId; defender: FighterId; damage: number; blocked: boolean }
  | { type: 'miss'; attacker: FighterId }
  | { type: 'ko'; winner: FighterId; loser: FighterId };

export const FIGHTER_ACTION_TIMINGS = {
  punch: { impact: 0.27, recovery: 0.7 },
  kick: { impact: 0.46, recovery: 0.95 },
  block: 0.8,
  jumpAirborne: 0.64,
  jumpRecovery: 0.8,
  hitStun: 0.4,
} as const;
export const FIGHTER_ACTION_PLAYBACK_SPEED:Partial<Record<FighterCommand,number>>={
  punch:1.2,kick:1.2,block:1.2,jump:1.125,
};
export const FIGHTER_JUMP_TWEEN_SECONDS=0.73;
export const FIGHTER_REACTION_PLAYBACK_SPEED=1.4375;

const ATTACKS = {
  punch: { damage: 9, range: 1.6, ...FIGHTER_ACTION_TIMINGS.punch },
  kick: { damage: 15, range: 1.9, ...FIGHTER_ACTION_TIMINGS.kick },
} as const;

// Measured from the normalized root travel and duration of run-forward.fbx/run-backward.fbx.
export const FIGHTER_RUN_FORWARD_DISTANCE = 3.82;
export const FIGHTER_RUN_BACKWARD_DISTANCE = 2.37;
export const FIGHTER_RUN_FORWARD_DURATION = 0.7333333492279053;
export const FIGHTER_RUN_BACKWARD_DURATION = 0.6333333253860474;
export const FIGHTER_MIN_SEPARATION = 0.82;

export function createFighterWorld(bounds: [number, number] = [-9, 9]): FighterWorld {
  const arenaMin = Math.min(bounds[0], bounds[1]), arenaMax = Math.max(bounds[0], bounds[1]);
  const width = arenaMax - arenaMin;
  const center = (arenaMin + arenaMax) / 2;
  const openingSeparation = Math.min(5, width, Math.max(FIGHTER_MIN_SEPARATION, width - 2));
  return {
    now: 0,
    status: 'fighting',
    winner: null,
    p1: { health: 100, x: center - openingSeparation / 2, busyUntil: 0, blockingUntil: 0, airborneUntil: 0 },
    p2: { health: 100, x: center + openingSeparation / 2, busyUntil: 0, blockingUntil: 0, airborneUntil: 0 },
    pending: [],
    arenaMin,
    arenaMax,
  };
}

export function applyFighterCommand(
  world: FighterWorld,
  fighter: FighterId,
  command: FighterCommand,
): FighterEvent[] {
  if (world.status !== 'fighting') return [];
  const self = world[fighter];
  if (world.now < self.busyUntil) return [];
  const events: FighterEvent[] = [{ type: 'action', fighter, command }];

  if (command === 'forward' || command === 'back') {
    const opponent = world[other(fighter)];
    const toward = Math.sign(opponent.x - self.x) || (fighter === 'p1' ? 1 : -1);
    const forward = command === 'forward';
    const delta = toward * (forward ? FIGHTER_RUN_FORWARD_DISTANCE : -FIGHTER_RUN_BACKWARD_DISTANCE);
    const from = self.x;
    let to = clamp(from + delta, world.arenaMin, world.arenaMax);
    if (command === 'forward') {
      if (toward > 0) to = Math.min(to, opponent.x - FIGHTER_MIN_SEPARATION);
      else to = Math.max(to, opponent.x + FIGHTER_MIN_SEPARATION);
    }
    to = separatedPosition(to, opponent.x, -toward, world.arenaMin, world.arenaMax);
    self.x = to;
    self.busyUntil = world.now + (forward ? FIGHTER_RUN_FORWARD_DURATION : FIGHTER_RUN_BACKWARD_DURATION);
    events.push({ type: 'move', fighter, from, to });
    return events;
  }

  if (command === 'block') {
    self.blockingUntil = world.now + FIGHTER_ACTION_TIMINGS.block;
    self.busyUntil = world.now + FIGHTER_ACTION_TIMINGS.block;
    return events;
  }

  if (command === 'jump') {
    self.airborneUntil = world.now + FIGHTER_ACTION_TIMINGS.jumpAirborne;
    self.busyUntil = world.now + FIGHTER_ACTION_TIMINGS.jumpRecovery;
    const opponent = world[other(fighter)];
    const toward = Math.sign(opponent.x - self.x) || (fighter === 'p1' ? 1 : -1);
    const from = self.x;
    self.x = separatedPosition(opponent.x + toward * 1.25, opponent.x, toward, world.arenaMin, world.arenaMax);
    events.push({ type: 'move', fighter, from, to: self.x, jump: true });
    return events;
  }

  const attack = ATTACKS[command];
  self.busyUntil = world.now + attack.recovery;
  world.pending.push({ attacker: fighter, command, impactAt: world.now + attack.impact });
  return events;
}

export function tickFighterWorld(world: FighterWorld, delta: number): FighterEvent[] {
  if (delta <= 0 || world.status !== 'fighting') return [];
  world.now += delta;
  const events: FighterEvent[] = [];
  const due = world.pending.filter((attack) => attack.impactAt <= world.now);
  world.pending = world.pending.filter((attack) => attack.impactAt > world.now);

  for (const pending of due) {
    if (world.status !== 'fighting') break;
    const defenderId = other(pending.attacker);
    const attacker = world[pending.attacker];
    const defender = world[defenderId];
    const attack = ATTACKS[pending.command];
    if (defender.airborneUntil >= pending.impactAt) {
      events.push({ type: 'miss', attacker: pending.attacker });
      continue;
    }
    if (Math.abs(attacker.x - defender.x) > attack.range) {
      events.push({ type: 'miss', attacker: pending.attacker });
      continue;
    }
    const blocked = defender.blockingUntil >= pending.impactAt;
    const damage = blocked ? Math.max(1, Math.round(attack.damage * 0.2)) : attack.damage;
    defender.health = Math.max(0, defender.health - damage);
    if (!blocked) defender.busyUntil = Math.max(defender.busyUntil, world.now + FIGHTER_ACTION_TIMINGS.hitStun);
    events.push({ type: 'hit', attacker: pending.attacker, defender: defenderId, damage, blocked });
    if (defender.health === 0) {
      world.status = 'finished';
      world.winner = pending.attacker;
      world.pending = [];
      events.push({ type: 'ko', winner: pending.attacker, loser: defenderId });
    }
  }
  return events;
}

function other(fighter: FighterId): FighterId {
  return fighter === 'p1' ? 'p2' : 'p1';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function separatedPosition(position: number, opponent: number, preferredSide: number, min: number, max: number): number {
  const bounded = clamp(position, min, max);
  const separation = Math.min(FIGHTER_MIN_SEPARATION, max - min);
  if (Math.abs(bounded - opponent) >= separation) return bounded;
  const direction = preferredSide < 0 ? -1 : 1;
  const preferred = opponent + direction * separation;
  if (preferred >= min && preferred <= max) return preferred;
  return clamp(opponent - direction * separation, min, max);
}
