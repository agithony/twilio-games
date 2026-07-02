// Wire protocol for Voice Monsters (the /battle WebSocket). Separate from the racer's protocol
// because the battler is a turn-based STATE MACHINE (push state on change) rather than a continuous
// 20Hz simulation. Kept in shared/ so client + server agree on the shapes; the parser validates
// untrusted client input on the server.
import type { BattleSnapshot, BattleEvent } from './battle-world';

/** Client → server. */
export type BattleClientMessage =
  | { type: 'join'; roomCode: string; name: string }        // become a player (max 2 humans)
  | { type: 'spectate'; roomCode: string }                  // the shared display (no slot)
  | { type: 'select_monster'; monsterId: string }           // during monster_select
  | { type: 'choose_move'; moveId: string }                 // during battle (a turn action)
  | { type: 'advance' }                                     // host: lobby→select→battle / rematch
  | { type: 'back' }                                        // host: step back a phase
  | { type: 'leave' };                                      // drop the player slot, keep watching

/** One selectable creature, flattened for the select screen (no logic, just display data). */
export interface RosterEntry {
  id: string; name: string; type: string; blurb: string;
  maxHp: number; attack: number; defense: number; speed: number;
  moves: { id: string; name: string; type: string; power: number }[];
}

/** A player row for the lobby / monster-select screens. */
export interface BattleLobbyPlayer { playerId: string; name: string; monsterId: string | null; isAi: boolean; }

/** Server → client. */
export type BattleServerMessage =
  | { type: 'joined'; playerId: string; roomCode: string }
  | { type: 'roster'; monsters: RosterEntry[] }             // sent on connect for the select screen
  | { type: 'battle_state'; roomCode: string; phase: string;
      players: BattleLobbyPlayer[]; snapshot: BattleSnapshot | null;
      result: { winner: string; winnerName: string } | null }
  | { type: 'battle_events'; events: BattleEvent[] }         // ordered — renderer/commentator replay
  | { type: 'error'; code: string; message: string };

type ParseResult = BattleClientMessage | { type: 'error'; code: string; message: string };

/** Validate + narrow an untrusted client frame. Returns an error message on anything malformed. */
export function parseBattleClientMessage(raw: string): ParseResult {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return err('bad_json', 'invalid JSON'); }
  if (!o || typeof o !== 'object') return err('bad_message', 'missing type');
  const m = o as Record<string, unknown>;
  switch (m.type) {
    case 'join':
      if (typeof m.roomCode !== 'string' || typeof m.name !== 'string') return err('bad_join', 'roomCode + name required');
      return { type: 'join', roomCode: m.roomCode, name: m.name };
    case 'spectate':
      if (typeof m.roomCode !== 'string') return err('bad_spectate', 'roomCode required');
      return { type: 'spectate', roomCode: m.roomCode };
    case 'select_monster':
      if (typeof m.monsterId !== 'string') return err('bad_select', 'monsterId required');
      return { type: 'select_monster', monsterId: m.monsterId };
    case 'choose_move':
      if (typeof m.moveId !== 'string') return err('bad_move', 'moveId required');
      return { type: 'choose_move', moveId: m.moveId };
    case 'advance': return { type: 'advance' };
    case 'back':    return { type: 'back' };
    case 'leave':   return { type: 'leave' };
    default:        return err('unknown_type', `unknown type ${String(m.type)}`);
  }
}
function err(code: string, message: string): { type: 'error'; code: string; message: string } {
  return { type: 'error', code, message };
}
