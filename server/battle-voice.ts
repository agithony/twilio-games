// The Voice Monsters CALL session: binds ONE Conversation Relay caller to a battle room and drives it
// by voice. The battler's analog of ConversationRelayAdapter (the racer's), but turn-based:
//   • setup   → join the caller as a player + greet.
//   • prompt  → (final utterance) route by phase: monster-select name/number → pick; battle turn word
//               ("guard"/"Ember"/"2") → commit the action; else hand to the LLM host for chat/questions.
//   • events  → speak scripted commentary (super-effective/crit/faint/win) via battle-commentary.
// All game access is through injected deps (BattleVoiceDeps) + the LLM through `converse`, so it
// unit-tests with fakes and has no direct WS/BattleServer dependency.
import { parseCrMessage } from './conversation-relay';
import { matchBattleAction } from '../shared/battle-intent';
import { commentaryForBattleEvent } from '../shared/battle-commentary';
import type { BattleEvent, BattleAction } from '../shared/battle-world';

/** A snapshot of the caller's live battle state, flattened for voice routing + the LLM host context. */
export interface BattleVoiceSnapshot {
  phase: 'lobby' | 'monster_select' | 'battle' | 'results';
  mySide: 'a' | 'b';                       // the caller's ABSOLUTE side (for mapping event sides → names)
  monsterNames: string[];                 // selectable monsters (roster order) — for select + LLM
  myName: string | null;
  myMonsterId: string | null; myMonsterName: string | null;
  foeMonsterName: string | null;
  myHp: number | null; myMaxHp: number | null;
  foeHp: number | null; foeMaxHp: number | null;
  myPotions: number;
  whoseTurn: 'me' | 'foe' | null;
  myMoves: { id: string; name: string }[];   // the caller's 4 moves (battle)
  winnerName: string | null;
}

/** Everything the session needs from its host (the HTTP server wires these to the BattleServer + LLM). */
export interface BattleVoiceDeps {
  join(code: string, name: string): string | null;   // → playerId, or null if full
  leave(code: string, playerId: string): void;
  setName(code: string, playerId: string, name: string): void;
  selectMonster(code: string, playerId: string, monsterId: string): void;
  chooseAction(code: string, playerId: string, action: BattleAction): void;
  advance(code: string): void;
  say(text: string): void;                            // speak a line to THIS caller (Relay TTS)
  snapshot(code: string, playerId: string): BattleVoiceSnapshot | null;
  /** Conversational LLM turn (host brain). Returns what to say, or null → scripted fallback / silence. */
  converse(code: string, playerId: string, utterance: string): Promise<string | null>;
}

const GREETING = [
  'Welcome to Voice Monsters!',
  "What's your name, challenger?",
];

export class BattleVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  private menuLevel: 'root' | 'fight' = 'root';
  private lineSeq = 0;
  private turnEpoch = 0;   // barge-in guard for in-flight LLM replies (mirrors the racer adapter)

  constructor(private deps: BattleVoiceDeps) {}

  get boundRoom(): string | null { return this.code; }
  get boundPlayer(): string | null { return this.playerId; }

  handleMessage(raw: string): void {
    const msg = parseCrMessage(raw);
    switch (msg.type) {
      case 'setup': {
        const code = msg.customParameters['roomCode'];
        if (!code) return;
        const id = this.deps.join(code, playerName(msg.from));
        if (!id) return;   // room full → unbound (caller can still spectate audio-only, silently)
        this.code = code; this.playerId = id;
        for (const line of GREETING) this.deps.say(line);
        break;
      }
      case 'prompt': {
        if (!msg.last || !this.code || !this.playerId) return;   // only act on the FINAL transcript
        const text = msg.voicePrompt.trim();
        if (text) this.handleUtterance(text);
        break;
      }
      case 'interrupt':
        this.turnEpoch++;   // caller barged in → drop any in-flight LLM reply
        break;
      case 'dtmf':
      case 'error':
      case 'unknown':
        return;
    }
  }

  /** Route one final utterance: try a deterministic game action first (fast, LLM-independent), else
   *  hand to the conversational host for chat/questions/ambiguous input. */
  private handleUtterance(text: string): void {
    // A NEW final utterance advances the barge-in epoch so any in-flight LLM reply from a PRIOR
    // utterance is dropped (not spoken over/after a fresh deterministic pick/action). converse() bumps
    // it again for the LLM path; bumping here covers the deterministic early-returns too.
    this.turnEpoch++;
    const snap = this.deps.snapshot(this.code!, this.playerId!);
    if (!snap) { void this.converse(text); return; }

    // NAME CAPTURE (deterministic, LLM-independent): while the caller still has no real name — which is
    // the very first thing we ask — treat a short reply as their name, set it, and confirm + guide to
    // the next step. This must NOT rely on the LLM (the "I gave my name but nothing happened" bug).
    if (!snap.myName && snap.phase !== 'battle') {
      const name = parseSpokenName(text);
      if (name) {
        this.deps.setName(this.code!, this.playerId!, name);
        this.deps.say(`Nice to meet you, ${name}! Others can still call in — say "start" when you're ready to pick your monster.`);
        return;
      }
    }

    // MONSTER SELECT: a clear name/number picks a monster immediately (no LLM latency).
    if (snap.phase === 'monster_select') {
      const idx = matchNameOrNumber(text, snap.monsterNames);
      if (idx >= 0) {
        // Map display-name index → the roster id the sim expects (lowercased, spaces→''): the ids are
        // the lowercased single-word names (sparkmouse, embertail…), so derive from the name.
        this.deps.selectMonster(this.code!, this.playerId!, snap.monsterNames[idx]!.toLowerCase().replace(/\s+/g, ''));
        return;
      }
    }

    // BATTLE (caller's turn): a clear action word/number/move commits it.
    if (snap.phase === 'battle' && snap.whoseTurn === 'me') {
      const res = matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level: this.menuLevel });
      if (res) {
        if (res.kind === 'openFight') { this.menuLevel = 'fight'; return; }
        if (res.kind === 'back') { this.menuLevel = 'root'; return; }
        this.menuLevel = 'root';
        this.deps.chooseAction(this.code!, this.playerId!, res);
        return;
      }
    }

    // Everything else (chat, questions, ambiguous, or the LLM should decide) → the host brain.
    void this.converse(text);
  }

  /** Fire the conversational host; speak its reply unless the caller has spoken again since (epoch). */
  private converse(text: string): void {
    const epoch = ++this.turnEpoch;
    void this.deps.converse(this.code!, this.playerId!, text)
      .then(reply => { if (reply && epoch === this.turnEpoch) this.deps.say(reply); })
      .catch(() => { /* LLM failure → stay quiet, never break the call */ });
  }

  /** Speak scripted commentary for a battle event (super-effective/crit/miss/faint/win, etc.). */
  onBattleEvent(ev: BattleEvent): void {
    if (!this.code || !this.playerId) return;
    const snap = this.deps.snapshot(this.code, this.playerId);
    // Battle events carry ABSOLUTE sides (a/b); commentary maps side 'a'→aName, 'b'→bName. But the
    // snapshot's my/foe are RELATIVE to the caller, so map back to absolute: if the caller is side 'b',
    // THEY are 'b' and their foe is 'a'. Without this, a 2nd caller (side 'b') hears every line naming
    // the wrong monster.
    const mine = snap?.myMonsterName ?? 'Your monster';
    const foe = snap?.foeMonsterName ?? 'the rival';
    const [aName, bName] = snap?.mySide === 'b' ? [foe, mine] : [mine, foe];
    const line = commentaryForBattleEvent(ev, { aName, bName }, this.lineSeq);
    if (line) { this.lineSeq++; this.deps.say(line); }
    // A new turn resets the caller's voice menu level so "one/two…" re-map to root actions.
    if (ev.kind === 'turn_start') this.menuLevel = 'root';
  }

  handleClose(): void {
    if (this.code && this.playerId) this.deps.leave(this.code, this.playerId);
    this.code = null; this.playerId = null;
  }
}

/** Match a spoken phrase to a choice index by NAME (fuzzy) or NUMBER ("two", "monster 3"), or -1. */
function matchNameOrNumber(spoken: string, choices: string[]): number {
  const q = spoken.toLowerCase().trim();
  // number words / digits first
  const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const digit = q.match(/\b(\d)\b/);
  if (digit) { const n = parseInt(digit[1]!, 10); if (n >= 1 && n <= choices.length) return n - 1; }
  for (const [w, n] of Object.entries(NUM)) if (new RegExp(`\\b${w}\\b`).test(q) && n <= choices.length) return n - 1;
  // name: exact, then substring either way
  let i = choices.findIndex(c => c.toLowerCase() === q);
  if (i >= 0) return i;
  i = choices.findIndex(c => c.toLowerCase().includes(q) || q.includes(c.toLowerCase()));
  return i;
}

function playerName(from?: string): string {
  if (from && from.length >= 4) return `Player ${from.slice(-4)}`;
  return 'Challenger';
}

/** Extract a caller's NAME from a spoken reply, or null if it doesn't look like a name (a question, a
 *  command, or empty). Handles "I'm Ada" / "my name is Rex" / "this is Bo" / bare "Ada". Kept simple +
 *  deterministic so name capture never depends on the LLM. */
export function parseSpokenName(spoken: string): string | null {
  let q = spoken.trim().replace(/[.!?,]+$/, '');
  if (!q) return null;
  const low = q.toLowerCase();
  // Not a name: obvious questions or game commands (so "start"/"which one?" don't become the name).
  if (/[?]/.test(spoken)) return null;
  if (/^(start|go|next|fight|guard|item|potion|taunt|yes|no|ready|help|what|which|who|how|why|when|where)\b/.test(low)) return null;
  // Strip a lead-in ("my name is", "i'm", "i am", "this is", "it's", "call me").
  const m = low.match(/^(?:my name is|i am|i'm|im|this is|it's|its|call me|the name's|name's)\s+(.*)$/);
  if (m && m[1]) q = q.slice(q.length - m[1].length);
  // Take the first 1-2 words, letters/hyphen/apostrophe only; reject if nothing name-like remains.
  const words = q.split(/\s+/).filter(w => /^[A-Za-z][A-Za-z'’-]*$/.test(w)).slice(0, 2);
  if (!words.length) return null;
  const name = words.join(' ');
  if (name.length < 2 || name.length > 20) return null;
  // Title-case for display.
  return name.replace(/\b[a-z]/g, c => c.toUpperCase());
}
