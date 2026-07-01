import type { Intent, GameEvent } from '../shared/types';
import { intentsFromTranscript } from './voice-intent';
import { greetingLine, lineForEvent, isChattyEvent } from './voice-lines';

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

/** Min gap between mid-race "arcade" voice lines to a caller, so they stay fun (not spammy) and don't
 *  talk over the caller's spoken commands. 2s → snappy, reactive, still not a constant stream. */
const CHATTY_GAP_MS = 2000;

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
  // The intents already fired for the CURRENT utterance (reset on last:true). We compare each new
  // partial's intents against this by longest-common-prefix and fire only the new tail — robust to
  // ASR revising a word mid-utterance (see the prompt handler).
  private firedIntents: Intent[] = [];
  constructor(private deps: AdapterDeps) {}

  /** The caller's bound player id (null until setup binds them) — for event targeting. */
  get boundPlayerId(): string | null { return this.playerId; }
  /** The caller's room code (null until bound) — so the registry can route events. */
  get boundRoomCode(): string | null { return this.roomCode; }

  /** Called by the voice registry when THIS caller's room emits a game event. Speaks the caller-
   *  relevant lines. Key moments (countdown/go/finish) always speak; mid-race "arcade" lines
   *  (hit-streak/fell-to-last/took-lead) are THROTTLED — at most one every CHATTY_GAP ms — so spoken
   *  audio never buries the caller's own left/right/boost. Safe no-op if no `say` sink. */
  private lineSeq = 0;
  private lastChattyAt = -1e9;
  private clockMs = 0;   // advanced from event cadence; monotonic enough for throttling
  onGameEvent(ev: GameEvent): void {
    this.clockMs += 50;   // events arrive on the ~20Hz broadcast; approx a wall clock for throttling
    if (isChattyEvent(ev.kind)) {
      if (this.clockMs - this.lastChattyAt < CHATTY_GAP_MS) return;   // too soon → stay quiet
      const line = lineForEvent(ev, this.playerId, this.lineSeq);
      if (line) { this.lastChattyAt = this.clockMs; this.lineSeq++; this.deps.say?.(line); }
      return;
    }
    const line = lineForEvent(ev, this.playerId, this.lineSeq);
    if (line) { this.lineSeq++; this.deps.say?.(line); }
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
        // Conversation Relay sends ACCUMULATING partial transcripts within an utterance — but ASR
        // also REVISES them ("left" → corrected to "right"). Position-slicing (the old approach)
        // silently dropped a command whenever a word changed instead of appended, which is exactly
        // why "left"/"right" sometimes didn't move the car. Instead: dedup by CONTENT via the longest
        // common prefix between what we've already fired this utterance and the current transcript's
        // intents — fire only the genuinely-new tail. This recovers from corrections (the corrected
        // word DOES fire) while still deduping true appends + repeats.
        const cur = intentsFromTranscript(msg.voicePrompt);
        const p = commonPrefixLen(this.firedIntents, cur);
        const fresh = cur.slice(p);
        console.log(`[CR] prompt last=${msg.last} text="${msg.voicePrompt}" → fired ${fresh.length} new: [${fresh.join(',')}]${this.playerId ? '' : ' (NOT BOUND — dropped)'}`);
        if (this.room && this.playerId) {
          for (const intent of fresh) this.room.applyIntent(this.playerId, intent);
        }
        this.firedIntents = cur;
        if (msg.last) this.firedIntents = [];   // utterance over; next starts fresh
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

/** Length of the shared leading run of two intent arrays (how many already-fired intents the new
 *  transcript still agrees with). Everything past this in the new array is genuinely new → fire it. */
function commonPrefixLen(a: Intent[], b: Intent[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
