export type Intent = 'MOVE_LEFT' | 'MOVE_RIGHT' | 'BOOST' | 'BRAKE' | 'USE_POWER';
export const INTENTS: readonly Intent[] = ['MOVE_LEFT','MOVE_RIGHT','BOOST','BRAKE','USE_POWER'];

export type ItemKind = 'barrier' | 'boost';
export interface Item { id: number; kind: ItemKind; lane: number; z: number; }

export interface CarState {
  id: string;            // playerId
  name: string;
  color: string;
  lane: number;          // current logical lane
  targetLane: number;    // lane the car is easing toward
  x: number;             // interpolated lateral position
  z: number;             // cumulative forward distance
  speed: number;
  boost: number;         // -1..+2-ish modifier
  power: number;         // remaining one-shot power-ups
  powerActive: number;   // seconds of active power remaining
  stunned: number;       // seconds of stun remaining
  lap: number;
  finished: boolean;
  finishT: number;
  place: number;
}

export type Phase = 'lobby' | 'countdown' | 'racing' | 'finished';

export interface WorldSnapshot {
  tick: number;
  t: number;             // sim seconds since race start
  phase: Phase;
  countdown: number;     // seconds remaining in countdown (>=0)
  cars: CarState[];
  items: Item[];         // static for a race; sent once at start, omitted after (see protocol)
}

// ---- Protocol: client -> server ----
export type ClientMessage =
  | { type: 'join'; roomCode: string; name: string; color?: string }
  | { type: 'intent'; intent: Intent }
  | { type: 'ready' }
  | { type: 'restart' };

// ---- Protocol: server -> client ----
export type ServerMessage =
  | { type: 'joined'; playerId: string; lane: number; roomCode: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'items'; items: Item[] }              // sent once when a race starts
  | { type: 'snapshot'; snapshot: WorldSnapshot } // sent ~20-30/s during a race
  | { type: 'event'; event: GameEvent };          // announcer cues (lead change, finish, ...)

export type GameEvent =
  | { kind: 'countdown'; n: number }
  | { kind: 'go' }
  | { kind: 'lead_change'; playerId: string; name: string }
  | { kind: 'hit'; playerId: string }
  | { kind: 'finish'; playerId: string; name: string; place: number }
  | { kind: 'race_over' };
