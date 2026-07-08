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
import { commentaryForBattleEvent, battleIntro } from '../shared/battle-commentary';
import { dwellForEvent } from '../shared/battle-timing';
import type { BattleEvent, BattleAction } from '../shared/battle-world';

/** A snapshot of the caller's live battle state, flattened for voice routing + the LLM host context. */
export interface BattleVoiceSnapshot {
  phase: 'lobby' | 'monster_select' | 'battle' | 'results';
  mySide: 'a' | 'b';                       // the caller's ABSOLUTE side (for mapping event sides → names)
  monsterNames: string[];                 // selectable monsters (roster order) — for select + LLM
  myName: string | null;
  myMonsterId: string | null; myMonsterName: string | null;
  myMonsterType: string | null;
  canStartBattle: boolean;
  foeName: string | null;
  foeMonsterName: string | null;
  foeMonsterType: string | null;
  myHp: number | null; myMaxHp: number | null;
  foeHp: number | null; foeMaxHp: number | null;
  myPotions: number;
  turn: number | null;
  activeSide: 'a' | 'b' | null;
  activeMenu: 'root' | 'fight';
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
  openFight(code: string, playerId: string): void;
  backMenu(code: string, playerId: string): void;
  chooseAction(code: string, playerId: string, action: BattleAction): void;
  advance(code: string): void;
  say(text: string): void;                            // speak a line to THIS caller (Relay TTS)
  /** Schedule `fn` after `ms` (injected so tests can drive the paced-commentary clock synchronously). */
  setTimer(fn: () => void, ms: number): void;
  snapshot(code: string, playerId: string): BattleVoiceSnapshot | null;
  /** Conversational LLM turn (host brain). Returns what to say, or null → scripted fallback / silence. */
  converse(code: string, playerId: string, utterance: string): Promise<string | null>;
}

const GREETING = [
  'Welcome to Voice Monsters!',
  'This is powered by Twilio Conversation Relay, so your voice controls the battle live over this call.',
  'Quick rules: say start, then pick a monster.',
  'On your turn, say fight. Then say an attack. You can also say guard, item, or taunt.',
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
        if (!id) { this.deps.say('This Voice Monsters battle is already full or in progress. Please wait for the next round.'); return; }
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

    // Every REQUIRED step of the flow has a deterministic, LLM-INDEPENDENT path here, so the game is
    // fully playable by voice even with the LLM off/slow. The LLM is only a fallback for chat/questions.

    // NAME CAPTURE: the first thing we ask in the lobby. On the monster-picking screen, however, a
    // monster name must pick the monster, not get mistaken for the caller's missing name.
    if (!snap.myName && snap.phase === 'lobby' && !isAdvanceWord(text)) {
      if (this.captureName(text, snap.phase)) return;
    }

    // ADVANCE / REMATCH: an intent to move forward ("start"/"go"/"choose a monster"/"next"/"rematch")
    // advances the screen — so a spoken action drives the display. Deterministic (no LLM dependency).
    if (isAdvanceWord(text)) {
      if (snap.phase === 'lobby') { this.deps.advance(this.code!); this.deps.say('Off to monster select! Say a monster\'s name to pick your fighter.'); return; }
      if (snap.phase === 'monster_select') {
        if (!snap.myMonsterId) { this.deps.say('Pick a monster first — say a name from the screen, or a number.'); return; }
        if (!snap.canStartBattle) { this.deps.say('Your monster is locked in. Waiting for the other player to pick their monster, then we can battle.'); return; }
        this.deps.advance(this.code!); return;   // battle starts → the paced battle-intro handles the talking
      }
      if (snap.phase === 'results') { this.deps.advance(this.code!); this.deps.say('Rematch! Pick your monster.'); return; }
    }

    // MONSTER SELECT: a clear name/number picks a monster. Calm confirmation + a quick background on it,
    // then guidance about what's next (wait for players, or say "battle").
    if (snap.phase === 'monster_select') {
      const idx = matchNameOrNumber(text, snap.monsterNames);
      if (idx >= 0) {
        const name = snap.monsterNames[idx]!;
        this.deps.selectMonster(this.code!, this.playerId!, name.toLowerCase().replace(/\s+/g, ''));
        this.deps.say(`${name} — ${monsterBlurb(name)} If everyone has picked, say "battle" to begin.`);
        return;
      }
      if (!snap.myName && this.captureName(text, snap.phase)) return;
    }

    // BATTLE (caller's turn): FIGHT opens the move menu AND reads the moves aloud (so a phone-only caller
    // knows their options); then a move name/number commits the attack. GUARD/ITEM/TAUNT commit directly.
    if (snap.phase === 'battle' && (this.draining || this.evQ.length > 0) && this.looksLikeBattleCommand(text, snap)) {
      this.deps.say('Hold on, resolving the last move. I will call your turn in a moment.');
      return;
    }
    if (snap.phase === 'battle' && snap.whoseTurn === 'foe') {
      if (this.looksLikeBattleCommand(text, snap)) {
        const foe = snap.foeMonsterName ?? 'the other monster';
        this.deps.say(`It's ${foe}'s turn — wait for ${foe} to choose, then I'll call your turn.`);
        return;
      }
    }
    if (snap.phase === 'battle' && snap.whoseTurn === 'me') {
      const level = snap.activeMenu ?? this.menuLevel;
      const res = matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level });
      if (res) {
        if (res.kind === 'openFight') {
          this.menuLevel = 'fight';
          this.deps.openFight(this.code!, this.playerId!);
          const list = snap.myMoves.map((m, i) => `${i + 1}, ${m.name}`).join('; ');
          this.deps.say(`Your moves are: ${list}. Say a move name or its number.`);
          return;
        }
        if (res.kind === 'back') { this.menuLevel = 'root'; this.deps.backMenu(this.code!, this.playerId!); return; }
        this.menuLevel = 'root';
        this.deps.chooseAction(this.code!, this.playerId!, res);
        return;
      }
    }

    // Everything else (chat, questions, ambiguous, or the LLM should decide) → the host brain.
    void this.converse(text);
  }

  private looksLikeBattleCommand(text: string, snap: BattleVoiceSnapshot): boolean {
    return !!matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level: snap.activeMenu })
      || /\b(fight|attack|move|guard|item|potion|taunt|go|hit|strike)\b/i.test(text);
  }

  private captureName(text: string, phase: BattleVoiceSnapshot['phase']): boolean {
    const name = parseSpokenName(text);
    if (!name) return false;
    this.deps.setName(this.code!, this.playerId!, name);
    this.deps.say(phase === 'lobby'
      ? `Nice to meet you, ${name}! Other players can call in to join, or when you're ready, just say "start" and we'll head to monster select.`
      : `Nice to meet you, ${name}! Pick your monster, say a name from the screen.`);
    return true;
  }

  /** Fire the conversational host; speak its reply unless the caller has spoken again since (epoch). */
  private converse(text: string): void {
    const epoch = ++this.turnEpoch;
    void this.deps.converse(this.code!, this.playerId!, text)
      .then(reply => { if (reply && epoch === this.turnEpoch) this.deps.say(reply); })
      .catch(() => { /* LLM failure → stay quiet, never break the call */ });
  }

  private introDone = false;   // one dramatic "X vs Y" intro + how-to-play recap per battle
  private evQ: BattleEvent[] = [];   // events queued to narrate, drained on the SAME clock as the screen
  private draining = false;
  private pendingStateCue = false;
  private lastTurnCueKey = '';

  /** Receive a battle-state push. Used for proactive call guidance that is NOT part of the resolution
   *  event stream: battle intro, opening controls, whose turn it is, and who should wait. */
  onBattleStateChanged(): void {
    if (!this.code || !this.playerId) return;
    if (this.draining || this.evQ.length > 0) { this.pendingStateCue = true; return; }
    this.speakStateCue();
  }

  /** Receive a battle event. The server hands us a whole turn's events at once, but the SCREEN plays
   *  them one at a time on the dwellForEvent clock — so we QUEUE them and narrate on that same clock,
   *  keeping the spoken commentary in sync with the on-screen animation (not all dumped at once). */
  onBattleEvent(ev: BattleEvent): void {
    if (!this.code || !this.playerId) return;
    this.evQ.push(ev);
    if (!this.draining) { this.draining = true; this.drainEvents(); }
  }

  /** Narrate the next queued event, then schedule the following one after its on-screen dwell. */
  private drainEvents(): void {
    const ev = this.evQ.shift();
    if (!ev) {
      this.draining = false;
      if (this.pendingStateCue) { this.pendingStateCue = false; this.speakStateCue(); }
      return;
    }
    this.speakEvent(ev);
    // Match the screen: hold for this event's own dwell, then narrate the next event/state cue.
    this.deps.setTimer(() => this.drainEvents(), dwellForEvent(ev));
  }

  /** Speak the commentary for ONE event (intro on turn 1, else the scripted line). */
  private speakEvent(ev: BattleEvent): void {
    const snap = this.deps.snapshot(this.code!, this.playerId!);
    // Events carry ABSOLUTE sides; commentary maps 'a'→aName/'b'→bName. Map the caller-relative snapshot
    // back to absolute (a side-'b' caller's monster is side 'b').
    const mine = snap?.myMonsterName ?? 'Your monster';
    const foe = snap?.foeMonsterName ?? 'the rival';
    const [aName, bName] = snap?.mySide === 'b' ? [foe, mine] : [mine, foe];

    if (ev.kind === 'turn_start' && !this.introDone && snap) {
      // Dramatic scene-set on turn 1 + a quick how-to-act recap. Then normal commentary flows.
      this.introDone = true; this.menuLevel = 'root';
      this.deps.say(battleIntro(mine, foe));
      this.deps.say('On your turn, say fight to see your moves. Then say a move. Or say guard, item, or taunt.');
      return;
    }
    if (ev.kind === 'battle_over') {
      this.lineSeq++;
      this.deps.say(this.battleOverLine(ev, snap, aName, bName));
      this.introDone = false;
      return;
    }
    const line = commentaryForBattleEvent(ev, { aName, bName }, this.lineSeq);
    if (line) { this.lineSeq++; this.deps.say(line); }
    if (ev.kind === 'turn_start') this.menuLevel = 'root';
  }

  private battleOverLine(ev: Extract<BattleEvent, { kind: 'battle_over' }>, snap: BattleVoiceSnapshot | null, aName: string, bName: string): string {
    const winnerMonster = ev.winner === 'a' ? aName : bName;
    const loserMonster = ev.winner === 'a' ? bName : aName;
    const loserPlayer = snap
      ? (ev.winner === snap.mySide ? snap.foeName : snap.myName)
      : null;
    const loser = loserPlayer ? `${loserPlayer} loses as ${loserMonster} goes down` : `${loserMonster} goes down`;
    return `${ev.winnerName} wins with ${winnerMonster}! ${loser}. What a finish. Say rematch to battle again.`;
  }

  private speakStateCue(): void {
    const snap = this.deps.snapshot(this.code!, this.playerId!);
    if (!snap || snap.phase !== 'battle') {
      this.lastTurnCueKey = '';
      if (snap?.phase === 'monster_select' || snap?.phase === 'lobby') this.introDone = false;
      return;
    }
    if (!this.introDone) {
      this.introDone = true;
      this.menuLevel = 'root';
      this.deps.say(this.battleIntroFor(snap));
      this.deps.say('How to play: on your turn, say fight. Then pick one of the four attacks. You can also say guard, item, or taunt.');
    }
    const key = `${snap.turn ?? 0}:${snap.activeSide ?? 'none'}:${snap.whoseTurn ?? 'none'}`;
    if (key === this.lastTurnCueKey) return;
    this.lastTurnCueKey = key;
    if (snap.whoseTurn === 'me') {
      const first = (snap.turn ?? 0) === 0 ? 'You go first. ' : '';
      this.deps.say(`${first}It's your turn. Say fight to see your attacks. Or say guard, item, or taunt.`);
    } else if (snap.whoseTurn === 'foe') {
      const first = (snap.turn ?? 0) === 0 ? `${snap.foeMonsterName ?? 'The other monster'} goes first. ` : '';
      this.deps.say(`${first}Wait for ${snap.foeMonsterName ?? 'the other monster'} to choose, then I'll call your turn.`);
    }
  }

  private battleIntroFor(snap: BattleVoiceSnapshot): string {
    const mine = snap.myMonsterName ?? 'your monster';
    const foe = snap.foeMonsterName ?? 'the rival';
    const myType = snap.myMonsterType ? `${snap.myMonsterType} type` : 'unknown type';
    const foeType = snap.foeMonsterType ? `${snap.foeMonsterType} type` : 'unknown type';
    return `${mine} is battling ${foe}: ${myType} versus ${foeType}. The arena is set.`;
  }

  handleClose(): void {
    if (this.code && this.playerId) this.deps.leave(this.code, this.playerId);
    this.code = null; this.playerId = null;
  }
}

/** True when the caller is asking to move the flow FORWARD (start / pick a monster / rematch / continue).
 *  Includes intent phrasings like "I want to choose a monster" / "let's play" so a spoken ACTION moves
 *  the on-screen flow, not just the bare keyword "start". */
export function isAdvanceWord(spoken: string): boolean {
  const q = spoken.trim().toLowerCase();
  if (/\b(start|begin|go|battle|fight|fight now|ready|next|continue|rematch|again|play again|run it back|let'?s (go|play|battle|fight)|i'?m ready)\b/.test(q)) return true;
  // "choose/pick a monster", "let me pick", "choose my fighter" → advance to monster select.
  if (/\b(choose|pick|select|show me)\b/.test(q) && /\b(monster|fighter|creature|character)\b/.test(q)) return true;
  return false;
}

/** A one-line background blurb for a monster (spoken after a pick), keyed by roster id → its flavor. */
function monsterBlurb(name: string): string {
  const key = name.toLowerCase().replace(/\s+/g, '');
  return MONSTER_BLURBS[key] ?? 'a fierce contender!';
}
const MONSTER_BLURBS: Record<string, string> = {
  sparkmouse: 'a lightning-fast electric rodent — quick and shocking!',
  embertail: 'a hot-headed fire drake with a blazing temper!',
  shellback: 'a sturdy water turtle — soaks up hits and strikes back!',
  thornling: 'a vine-wrapped grass sprout that drains and lashes!',
  galecoil: 'a raging water serpent — a leviathan when provoked!',
  voltcrest: 'a crackling electric thunderbird — a storm on the wing!',
  dazeduck: 'a dazed water fowl — clumsy, but weirdly powerful!',
  psyclone: 'a lab-born psychic powerhouse — immense and unblinking!',
};

/** Match a spoken phrase to a choice index by NAME (fuzzy) or NUMBER ("two", "monster 3"), or -1. */
function matchNameOrNumber(spoken: string, choices: string[]): number {
  const q = spoken.toLowerCase().trim();
  // number words / digits first. Ordinals must beat cardinals so "second one" is 2, not 1.
  const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };
  const digit = q.match(/\b(\d)(?:st|nd|rd|th)?\b/);
  if (digit) { const n = parseInt(digit[1]!, 10); if (n >= 1 && n <= choices.length) return n - 1; }
  for (const [w, n] of Object.entries(ORD)) if (new RegExp(`\\b${w}\\b`).test(q) && n <= choices.length) return n - 1;
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
