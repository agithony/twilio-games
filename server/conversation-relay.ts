import type { Intent, GameEvent } from '../shared/types';
import { intentsFromTranscript } from './voice-intent';
import { greetingLine, lineForEvent } from './voice-lines';

export type CrMessage =
  | { type:'setup'; callSid:string; from?:string; customParameters: Record<string,string> }
  | { type:'prompt'; voicePrompt:string; last:boolean }
  | { type:'dtmf'; digit:string }
  | { type:'error'; description:string }
  | { type:'unknown' };

export function parseCrMessage(raw: string): CrMessage {
  let o: any;
  try { o = JSON.parse(raw); } catch { return { type:'unknown' }; }
  if (!o || typeof o.type !== 'string') return { type:'unknown' };
  switch (o.type) {
    case 'setup':
      return { type:'setup', callSid: String(o.callSid ?? ''),
        ...(typeof o.from === 'string' ? { from: o.from } : {}),
        customParameters: (o.customParameters && typeof o.customParameters === 'object')
          ? o.customParameters : {} };
    case 'prompt':
      if (typeof o.voicePrompt !== 'string') return { type:'unknown' };
      return { type:'prompt', voicePrompt: o.voicePrompt, last: o.last === true };
    case 'dtmf':
      return { type:'dtmf', digit: String(o.digit ?? '') };
    case 'error':
      return { type:'error', description: String(o.description ?? '') };
    default:
      return { type:'unknown' };
  }
}

export type RoomLike = {
  addPlayer(name: string): { playerId: string; lane: number } | { error: string };
  applyIntent(id: string, intent: Intent): void;
  removePlayer(id: string): void;
};

const DTMF_TO_INTENT: Record<string, Intent> = {
  '1': 'MOVE_LEFT', '2': 'BOOST', '3': 'MOVE_RIGHT', '4': 'BRAKE', '5': 'USE_POWER',
};

/** Everything the adapter needs from its host to TALK BACK to the caller + hook game events. All
 *  optional so existing callers/tests that only drive intents keep working unchanged. */
export interface AdapterDeps {
  findOrCreateRoom: (code: string) => RoomLike | null;
  /** Speak a line to the caller (host wires this to a Relay `{type:'text'}` WS send). */
  say?: (text: string) => void;
  /** Register/unregister this adapter to receive its room's game events (greeting/countdown/result). */
  register?: (roomCode: string, adapter: ConversationRelayAdapter) => void;
  unregister?: (adapter: ConversationRelayAdapter) => void;
}

export class ConversationRelayAdapter {
  private room: RoomLike | null = null;
  private playerId: string | null = null;
  private roomCode: string | null = null;
  // Conversation Relay sends ACCUMULATING partial transcripts ("left" → "left right"
  // → "left right boost"). We count how many command-words we've already fired this
  // utterance and only act on newly-appended ones, so each spoken command fires once.
  private firedThisUtterance = 0;
  constructor(private deps: AdapterDeps) {}

  /** The caller's bound player id (null until setup binds them) — for event targeting. */
  get boundPlayerId(): string | null { return this.playerId; }
  /** The caller's room code (null until bound) — so the registry can route events. */
  get boundRoomCode(): string | null { return this.roomCode; }

  /** Called by the voice registry when THIS caller's room emits a game event. Speaks the caller-
   *  relevant ones (their countdown/go/finish); ignores mid-race cues. Safe no-op if no `say` sink. */
  onGameEvent(ev: GameEvent): void {
    const line = lineForEvent(ev, this.playerId);
    if (line) this.deps.say?.(line);
  }

  handleMessage(raw: string): void {
    const msg = parseCrMessage(raw);
    switch (msg.type) {
      case 'setup': {
        const code = msg.customParameters['roomCode'];
        console.log(`[CR] setup callSid=${msg.callSid} roomCode=${code ?? '(none)'}`);
        if (!code) { console.log('[CR] no roomCode → unbound'); return; }
        const room = this.deps.findOrCreateRoom(code);
        if (!room) { console.log(`[CR] room ${code} not found → unbound`); return; }
        const res = room.addPlayer(playerName(msg.from));
        if ('error' in res) { console.log(`[CR] addPlayer rejected: ${res.error} → unbound (caller cannot drive)`); return; }
        this.room = room; this.playerId = res.playerId; this.roomCode = code;
        console.log(`[CR] bound caller to player ${res.playerId} lane ${res.lane} in room ${code}`);
        // Register for this room's game events (countdown/go/finish) + greet the caller.
        this.deps.register?.(code, this);
        this.deps.say?.(greetingLine());
        break;
      }
      case 'prompt': {
        const intents = intentsFromTranscript(msg.voicePrompt);
        // Fire only command-words newly appended since the last partial of this utterance.
        const fresh = intents.slice(this.firedThisUtterance);
        console.log(`[CR] prompt last=${msg.last} text="${msg.voicePrompt}" → fired ${fresh.length} new: [${fresh.join(',')}]${this.playerId ? '' : ' (NOT BOUND — dropped)'}`);
        if (this.room && this.playerId) {
          for (const intent of fresh) this.room.applyIntent(this.playerId, intent);
        }
        this.firedThisUtterance = intents.length;
        if (msg.last) this.firedThisUtterance = 0;  // utterance over; next starts fresh
        break;
      }
      case 'dtmf': {
        console.log(`[CR] dtmf digit=${msg.digit}${this.playerId ? '' : ' (NOT BOUND)'}`);
        if (!this.room || !this.playerId) return;
        const intent = DTMF_TO_INTENT[msg.digit];
        if (intent) this.room.applyIntent(this.playerId, intent);
        break;
      }
      case 'error':
        console.log(`[CR] error: ${msg.description}`);
        return;
      case 'unknown':
        return;
    }
  }

  handleClose(): void {
    this.deps.unregister?.(this);
    if (this.room && this.playerId) this.room.removePlayer(this.playerId);
    this.room = null; this.playerId = null; this.roomCode = null;
  }
}

function playerName(from?: string): string {
  if (from && from.length >= 4) return `Racer ${from.slice(-4)}`;
  return 'Racer';
}
