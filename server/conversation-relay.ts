import type { Intent, GameEvent } from '../shared/types';
import { intentsFromTranscript } from './voice-intent';
import { greetingLines, lineForEvent, isChattyEvent } from './voice-lines';

export type CrMessage =
  | { type:'setup'; callSid:string; from?:string; customParameters: Record<string,string> }
  | { type:'prompt'; voicePrompt:string; last:boolean }
  | { type:'dtmf'; digit:string }
  | { type:'interrupt'; utteranceUntilInterrupt:string; durationUntilInterruptMs:number }
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
    case 'interrupt':
      // Sent when the caller's speech (barge-in) cuts the TTS. utteranceUntilInterrupt = the part of
      // our reply that actually played; durationUntilInterruptMs = how long it played.
      return { type:'interrupt',
        utteranceUntilInterrupt: String(o.utteranceUntilInterrupt ?? ''),
        durationUntilInterruptMs: Number(o.durationUntilInterruptMs ?? 0) || 0 };
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
  /** Drop the caller's player slot AND reap the room if now empty (a phone caller never hits the WS
   *  close/leave reap paths, so this avoids a voice-only room leaking). Falls back to plain
   *  removePlayer when absent (keeps existing tests/callers working). */
  leaveRoom?: (roomCode: string, playerId: string) => void;
  /** Run a conversational AI turn for this caller: given their utterance, return what the host should
   *  SAY back (having also executed any game actions), or null to fall back to scripted behavior.
   *  Wired to the LLM game-host. Absent → no conversational AI (scripted-only, current behavior).
   *  `phase` lets the caller decide command-vs-chat routing. */
  converse?: (roomCode: string, playerId: string, utterance: string) => Promise<string | null>;
  /** The room's current phase, so the adapter routes: race → fast commands; else → conversation. */
  phaseOf?: (roomCode: string) => string;
}

export class ConversationRelayAdapter {
  private room: RoomLike | null = null;
  private playerId: string | null = null;
  private roomCode: string | null = null;
  // The intents already fired for the CURRENT utterance (reset on last:true). We compare each new
  // partial's intents against this by longest-common-prefix and fire only the new tail — robust to
  // ASR revising a word mid-utterance (see the prompt handler).
  private firedIntents: Intent[] = [];
  // Turn epoch for barge-in: bumped on every new final utterance AND on every interrupt. An in-flight
  // conversational reply captures the epoch it was requested under; if the epoch has since moved
  // (caller interrupted or spoke again), the stale reply is DROPPED instead of spoken over them.
  private turnEpoch = 0;
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
  private recapDone = false;   // one proactive results recap per race (reset on a new countdown/go)
  private lastMenuPrompt: { kind: 'enter_car_select' | 'enter_map_select'; at: number } | null = null;
  onGameEvent(ev: GameEvent): void {
    this.clockMs += 50;   // events arrive on the ~20Hz broadcast; approx a wall clock for throttling
    if (ev.kind === 'go' || ev.kind === 'countdown') this.recapDone = false;   // fresh race → allow a new recap
    if (ev.kind === 'enter_car_select' || ev.kind === 'enter_map_select') {
      if (this.lastMenuPrompt?.kind === ev.kind && this.clockMs - this.lastMenuPrompt.at < 1000) return;
      this.lastMenuPrompt = { kind: ev.kind, at: this.clockMs };
    }
    if (isChattyEvent(ev.kind)) {
      if (this.clockMs - this.lastChattyAt < CHATTY_GAP_MS) return;   // too soon → stay quiet
      const line = lineForEvent(ev, this.playerId, this.lineSeq);
      if (line) { this.lastChattyAt = this.clockMs; this.lineSeq++; this.deps.say?.(line); }
      return;
    }
    // THE CALLER FINISHED: prefer a proactive LLM RECAP (celebration + race recap + leaderboard
    // overview) over the scripted one-liner, so the host actually TALKS over the scoreboard. Falls
    // back to the scripted placeLine when the LLM host isn't wired. Only once per race.
    if (ev.kind === 'finish' && this.playerId && ev.playerId === this.playerId && !this.recapDone) {
      this.recapDone = true;
      if (this.deps.converse && this.roomCode) {
        const epoch = ++this.turnEpoch;
        void this.deps.converse(this.roomCode, this.playerId, '(You just crossed the finish line — give a quick spoken recap of the race and a short overview of the all-time leaderboard, then invite a rematch.)')
          .then(reply => { if (reply && epoch === this.turnEpoch) this.deps.say?.(reply); })
          .catch(() => { const l = lineForEvent(ev, this.playerId, this.lineSeq); if (l) this.deps.say?.(l); });
        return;
      }
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
        // Register for this room's game events + greet the caller. Send each greeting SENTENCE as its
        // own utterance so Relay TTS pauses naturally between them (one long string read run-on).
        this.deps.register?.(code, this);
        for (const line of greetingLines()) this.deps.say?.(line);
        break;
      }
      case 'prompt': {
        // ROUTE by phase: during a live RACE, keep the fast local command path (no LLM latency in the
        // hot loop). In menus/results, route the FINAL utterance to the conversational AI host so the
        // caller can talk naturally ("which car is fastest?", "pick me a fast one", "start the race").
        const racing = this.deps.phaseOf && this.roomCode
          ? (this.deps.phaseOf(this.roomCode) === 'racing' || this.deps.phaseOf(this.roomCode) === 'countdown')
          : true;   // no phaseOf → behave as before (command path)

        if (racing || !this.deps.converse) {
          // Fast command path. CR sends ACCUMULATING partials that ASR also REVISES ("left" →
          // "right"); dedup by CONTENT (longest common prefix) so a corrected word still fires and
          // true appends/repeats don't double-fire.
          const cur = intentsFromTranscript(msg.voicePrompt);
          const p = commonPrefixLen(this.firedIntents, cur);
          const fresh = cur.slice(p);
          console.log(`[CR] prompt last=${msg.last} text="${msg.voicePrompt}" → fired ${fresh.length} new: [${fresh.join(',')}]${this.playerId ? '' : ' (NOT BOUND — dropped)'}`);
          if (this.room && this.playerId) for (const intent of fresh) this.room.applyIntent(this.playerId, intent);
          this.firedIntents = cur;
          if (msg.last) this.firedIntents = [];
        } else if (msg.last && this.roomCode && this.playerId) {
          // Conversational path — only on the FINAL transcript (partials would spam the LLM). Fire and
          // forget; the reply is spoken via deps.say when it resolves — UNLESS the caller has spoken
          // again or barged in since (epoch moved), in which case the stale reply is dropped.
          const text = msg.voicePrompt.trim();
          if (text) {
            const epoch = ++this.turnEpoch;
            void this.deps.converse(this.roomCode, this.playerId, text)
              .then(reply => { if (reply && epoch === this.turnEpoch) this.deps.say?.(reply); })
              .catch(() => { /* LLM failure → stay quiet, never break the call */ });
          }
        }
        break;
      }
      case 'dtmf': {
        console.log(`[CR] dtmf digit=${msg.digit}${this.playerId ? '' : ' (NOT BOUND)'}`);
        if (!this.room || !this.playerId) return;
        const intent = DTMF_TO_INTENT[msg.digit];
        if (intent) this.room.applyIntent(this.playerId, intent);
        break;
      }
      case 'interrupt': {
        // Barge-in: the caller talked over the host. Conversation Relay already stopped the TTS on its
        // side; we bump the epoch so any in-flight conversational reply is dropped (not spoken late),
        // and clear the current utterance's fired-intents so their next words are read fresh.
        console.log(`[CR] interrupt after ${msg.durationUntilInterruptMs}ms; played="${msg.utteranceUntilInterrupt}"`);
        this.turnEpoch++;
        this.firedIntents = [];
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
    // Prefer leaveRoom (drops the slot AND reaps an empty room); fall back to plain removePlayer.
    if (this.playerId) {
      if (this.roomCode && this.deps.leaveRoom) this.deps.leaveRoom(this.roomCode, this.playerId);
      else this.room?.removePlayer(this.playerId);
    }
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
