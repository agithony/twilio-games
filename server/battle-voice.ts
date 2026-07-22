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
import { dwellForEvent, HANDOFF_PAUSE_MS } from '../shared/battle-timing';
import type { BattleEvent, BattleAction } from '../shared/battle-world';
import { ROSTER } from '../shared/monster-roster';
import { localizedMonsterAliases } from '../shared/i18n/content';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { MONSTERS_MESSAGES, type MonstersMessageKey } from '../shared/i18n/monsters';
import { createTranslator, formatList, normalizeForMatching, type MessageValues } from '../shared/i18n/translate';
import { monsterTypeLabel, type MonsterType } from '../shared/monster-types';

/** A snapshot of the caller's live battle state, flattened for voice routing + the LLM host context. */
export interface BattleVoiceSnapshot {
  phase: 'lobby' | 'monster_select' | 'battle' | 'results';
  mySide: 'a' | 'b';                       // the caller's ABSOLUTE side (for mapping event sides → names)
  monsterNames: string[];                 // selectable monsters (roster order) — for select + LLM
  myName: string | null;
  myMonsterId: string | null; myMonsterName: string | null;
  myMonsterType: string | null;
  canStartBattle: boolean;
  canRematch: boolean;
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
  join(code: string, name: string, callSid: string): { playerId: string; resumed: boolean } | null;
  leave(code: string, playerId: string, callSid: string): void;
  setName(code: string, playerId: string, name: string): void;
  selectMonster(code: string, playerId: string, monsterId: string): void;
  openFight(code: string, playerId: string): void;
  backMenu(code: string, playerId: string): void;
  chooseAction(code: string, playerId: string, action: BattleAction): void;
  advance(code: string): void;
  say(text: string): void;                            // speak a line to THIS caller (Relay TTS)
  /** Schedule `fn` after `ms` (injected so tests can drive the paced-commentary clock synchronously). */
  setTimer(fn: () => void, ms: number): void;
  snapshot(code: string, playerId: string, locale?: SupportedLocale): BattleVoiceSnapshot | null;
  /** Conversational LLM turn (host brain). Returns what to say, or null → scripted fallback / silence. */
  converse(code: string, playerId: string, utterance: string, isCurrent: () => boolean, locale: SupportedLocale): Promise<string | null>;
}

const GREETING_KEYS = [
  'voice.greetingWelcome', 'voice.greetingRelay', 'voice.greetingRules',
  'voice.greetingActions', 'voice.askName',
] as const satisfies readonly MonstersMessageKey[];

export class BattleVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  get boundPlayerId(): string | null { return this.playerId; }
  private callSid: string | null = null;
  private menuLevel: 'root' | 'fight' = 'root';
  private lineSeq = 0;
  private turnEpoch = 0;   // barge-in guard for in-flight LLM replies (mirrors the racer adapter)
  private lastPhase: BattleVoiceSnapshot['phase'] | null = null;
  private lastCanRematch = false;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private text: (key: MonstersMessageKey, values?: MessageValues) => string = createTranslator(DEFAULT_LOCALE, MONSTERS_MESSAGES);

  constructor(private deps: BattleVoiceDeps) {}

  get boundRoom(): string | null { return this.code; }
  get boundPlayer(): string | null { return this.playerId; }
  get locale(): SupportedLocale { return this.commandLocale; }

  handleMessage(raw: string): void {
    const msg = parseCrMessage(raw);
    switch (msg.type) {
      case 'setup': {
        this.commandLocale = resolveLocale(msg.customParameters['commandLocale'] ?? msg.customParameters['locale']);
        this.text = createTranslator(this.commandLocale, MONSTERS_MESSAGES);
        const code = msg.customParameters['roomCode'];
        if (!code) return;
        if (this.code && this.playerId) {
          if (this.code === code) return;
          this.deps.leave(this.code, this.playerId, this.callSid ?? '');
          this.code = null; this.playerId = null; this.callSid = null;
        }
        const joined = this.deps.join(code, playerName(msg.from, this.commandLocale), msg.callSid);
        if (!joined) { this.deps.say(this.text('voice.roomUnavailable')); return; }
        this.code = code; this.playerId = joined.playerId; this.callSid = msg.callSid;
        if (joined.resumed) this.speakResumeCue();
        else {
          const snap = this.deps.snapshot(code, joined.playerId, this.commandLocale);
          this.lastPhase = snap?.phase ?? null;
          this.lastCanRematch = snap?.canRematch ?? false;
          if (snap?.phase === 'battle' && !snap.myMonsterId) {
            this.deps.say(this.text('voice.lateBattle'));
            this.deps.say(snap.myName ? this.text('voice.welcomeNextNamed', { name: snap.myName }) : this.text('voice.askName'));
          } else if (snap?.phase === 'results') {
            this.deps.say(this.text('voice.lateResults'));
            this.deps.say(snap.myName ? this.text('voice.welcomeRematchNamed', { name: snap.myName }) : this.text('voice.askName'));
          } else {
            for (const key of GREETING_KEYS) this.deps.say(this.text(key));
          }
        }
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
    const snap = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale);
    if (!snap) { void this.converse(text); return; }
    if (isBattleHelpRequest(text, this.commandLocale)) {
      const key = snap.phase === 'lobby' ? 'voice.helpLobby'
        : snap.phase === 'monster_select' ? 'voice.helpSelect'
          : snap.phase === 'results' ? 'voice.helpResults' : 'voice.howTo';
      this.deps.say(this.text(key));
      return;
    }

    // Every REQUIRED step of the flow has a deterministic, LLM-INDEPENDENT path here, so the game is
    // fully playable by voice even with the LLM off/slow. The LLM is only a fallback for chat/questions.

    if (snap.phase === 'results' && (!snap.canRematch || this.draining || this.evQ.length > 0) && isAdvanceWord(text, this.commandLocale)) {
      this.deps.say(this.text('voice.holdFinal'));
      return;
    }

    // NAME CAPTURE: the first thing we ask in the lobby. On the monster-picking screen, however, a
    // monster name must pick the monster, not get mistaken for the caller's missing name.
    if (!snap.myName && (snap.phase === 'lobby' || snap.phase === 'results' || (snap.phase === 'battle' && !snap.myMonsterId)) && !isAdvanceWord(text, this.commandLocale)) {
      if (this.captureName(text, snap.phase)) return;
    }

    if (snap.phase === 'battle' && !snap.myMonsterId) {
      this.deps.say(this.text('voice.currentBattle'));
      return;
    }

    // ADVANCE / REMATCH: an intent to move forward ("start"/"go"/"choose a monster"/"next"/"rematch")
    // advances the screen — so a spoken action drives the display. Deterministic (no LLM dependency).
    if (isAdvanceWord(text, this.commandLocale)) {
      if (snap.phase === 'lobby') { this.deps.advance(this.code!); this.deps.say(this.text('voice.toSelect')); return; }
      if (snap.phase === 'monster_select') {
        if (!snap.myMonsterId) { this.deps.say(this.text('voice.pickFirst')); return; }
        if (!snap.canStartBattle) { this.deps.say(this.text('voice.pickWaiting')); return; }
        this.deps.advance(this.code!); return;   // battle starts → the paced battle-intro handles the talking
      }
      if (snap.phase === 'results') { this.deps.advance(this.code!); this.deps.say(this.text('voice.rematch')); return; }
    }

    // MONSTER SELECT: a clear name/number picks a monster. Calm confirmation + a quick background on it,
    // then guidance about what's next (wait for players, or say "battle").
    if (snap.phase === 'monster_select') {
      const idx = matchNameOrNumber(text, snap.monsterNames, this.commandLocale);
      if (idx >= 0) {
        const name = snap.monsterNames[idx]!;
        this.deps.selectMonster(this.code!, this.playerId!, ROSTER[idx]!.id);
        this.deps.say(this.text('voice.pickConfirmation', { name, blurb: monsterBlurb(ROSTER[idx]!.id, this.commandLocale) }));
        return;
      }
      if (!snap.myName && this.captureName(text, snap.phase)) return;
    }

    // BATTLE (caller's turn): FIGHT opens the move menu AND reads the moves aloud (so a phone-only caller
    // knows their options); then a move name/number commits the attack. GUARD/ITEM/TAUNT commit directly.
    if (snap.phase === 'battle' && (this.draining || this.evQ.length > 0) && this.looksLikeBattleCommand(text, snap)) {
      this.deps.say(this.text('voice.resolving'));
      return;
    }
    if (snap.phase === 'battle' && snap.whoseTurn === 'foe') {
      if (this.looksLikeBattleCommand(text, snap)) {
        const foe = snap.foeMonsterName ?? this.text('voice.otherMonster');
        this.deps.say(this.text('voice.foeTurn', { monster: foe }));
        return;
      }
    }
    if (snap.phase === 'battle' && snap.whoseTurn === 'me') {
      const level = snap.activeMenu ?? this.menuLevel;
      const res = matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level }, this.commandLocale);
      if (res) {
        if (res.kind === 'openFight') {
          this.menuLevel = 'fight';
          this.deps.openFight(this.code!, this.playerId!);
          const list = formatList(this.commandLocale, snap.myMoves.map((m, i) => `${i + 1}, ${m.name}`));
          this.deps.say(this.text('voice.moves', { moves: list }));
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
    if (matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level: snap.activeMenu }, this.commandLocale)) return true;
    const normalized = normalizeForMatching(text, this.commandLocale);
    return this.commandLocale === 'pt-BR'
      ? /\b(lutar|atacar|golpe|defender|bloquear|proteger|item|pocao|curar|provocar|zombar|voltar|cancelar)\b/.test(normalized)
      : /\b(fight|attack|move|guard|item|potion|taunt|go|hit|strike)\b/.test(normalized);
  }

  private captureName(text: string, phase: BattleVoiceSnapshot['phase']): boolean {
    const name = phase === 'monster_select'
      ? parseExplicitSpokenName(text, this.commandLocale)
      : parseSpokenName(text, this.commandLocale);
    if (!name) return false;
    this.deps.setName(this.code!, this.playerId!, name);
    this.deps.say(this.text(
      phase === 'lobby' ? 'voice.nameLobby'
        : phase === 'results' ? 'voice.nameResults'
          : phase === 'battle' ? 'voice.nameBattle' : 'voice.nameSelect',
      { name },
    ));
    return true;
  }

  /** Fire the conversational host; speak its reply unless the caller has spoken again since (epoch). */
  private converse(text: string): void {
    const epoch = ++this.turnEpoch;
    void this.deps.converse(this.code!, this.playerId!, text, () => epoch === this.turnEpoch && !this.isPresentingResults(), this.commandLocale)
      .then(reply => { if (reply && epoch === this.turnEpoch) this.deps.say(reply); })
      .catch(() => { /* LLM failure → stay quiet, never break the call */ });
  }

  private introDone = false;   // one dramatic "X vs Y" intro + how-to-play recap per battle
  private evQ: BattleEvent[] = [];   // events queued to narrate, drained on the SAME clock as the screen
  private draining = false;
  private pendingStateCue = false;
  private lastTurnCueKey = '';
  private lastActionSide: 'a' | 'b' | null = null;

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
    const actionSide = sideForActionEvent(ev);
    if (actionSide && this.lastActionSide && this.lastActionSide !== actionSide) {
      this.lastActionSide = actionSide;
      this.evQ.unshift(ev);
      this.deps.setTimer(() => this.drainEvents(), HANDOFF_PAUSE_MS);
      return;
    }
    if (actionSide) this.lastActionSide = actionSide;
    this.speakEvent(ev);
    // Match the screen: hold for this event's own dwell, then narrate the next event/state cue.
    this.deps.setTimer(() => this.drainEvents(), dwellForEvent(ev));
  }

  /** Speak the commentary for ONE event (intro on turn 1, else the scripted line). */
  private speakEvent(ev: BattleEvent): void {
    const snap = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale);
    // Events carry ABSOLUTE sides; commentary maps 'a'→aName/'b'→bName. Map the caller-relative snapshot
    // back to absolute (a side-'b' caller's monster is side 'b').
    const mine = snap?.myMonsterName ?? this.text('voice.yourMonster');
    const foe = snap?.foeMonsterName ?? this.text('voice.rival');
    const [aName, bName] = snap?.mySide === 'b' ? [foe, mine] : [mine, foe];

    if (ev.kind === 'turn_start' && !this.introDone && snap) {
      // Dramatic scene-set on turn 1 + a quick how-to-act recap. Then normal commentary flows.
      this.introDone = true; this.menuLevel = 'root';
      this.deps.say(battleIntro(mine, foe, 0, this.commandLocale));
      this.deps.say(this.text('voice.introActions'));
      return;
    }
    if (ev.kind === 'battle_over') {
      this.lineSeq++;
      this.deps.say(this.battleOverLine(ev, snap, aName, bName));
      this.introDone = false;
      return;
    }
    const line = commentaryForBattleEvent(ev, { aName, bName }, this.lineSeq, this.commandLocale);
    if (line) { this.lineSeq++; this.deps.say(line); }
    if (ev.kind === 'turn_start') this.menuLevel = 'root';
  }

  private battleOverLine(ev: Extract<BattleEvent, { kind: 'battle_over' }>, snap: BattleVoiceSnapshot | null, aName: string, bName: string): string {
    const winnerMonster = ev.winner === 'a' ? aName : bName;
    const loserMonster = ev.winner === 'a' ? bName : aName;
    const loserPlayer = snap
      ? (ev.winner === snap.mySide ? snap.foeName : snap.myName)
      : null;
    return loserPlayer
      ? this.text('voice.overWithPlayer', {
          winner: ev.winnerName, winnerMonster, loserPlayer, loserMonster,
        })
      : this.text('voice.overWithoutPlayer', { winner: ev.winnerName, winnerMonster, loserMonster });
  }

  private speakStateCue(): void {
    const snap = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale);
    if (!snap || snap.phase !== 'battle') {
      this.lastTurnCueKey = '';
      const previous = this.lastPhase;
      this.lastPhase = snap?.phase ?? null;
      const rematchBecameReady = previous === 'results' && snap?.phase === 'results' && snap.canRematch && !this.lastCanRematch;
      this.lastCanRematch = snap?.phase === 'results' ? snap.canRematch : false;
      if (rematchBecameReady) this.deps.say(this.text('voice.rematchReady'));
      if (previous === 'battle' && snap?.phase === 'monster_select') {
        const pick = snap.myMonsterName ? this.text('voice.pickLocked', { monster: snap.myMonsterName }) : '';
        this.deps.say(this.text('voice.playerLeft', { pick }));
      }
      if (snap?.phase === 'monster_select' || snap?.phase === 'lobby') {
        this.introDone = false;
        this.lastActionSide = null;
      }
      return;
    }
    this.lastPhase = 'battle';
    if (!this.introDone) {
      this.introDone = true;
      this.menuLevel = 'root';
      this.deps.say(this.battleIntroFor(snap));
      this.deps.say(this.text('voice.howTo'));
    }
    this.speakTurnCue(snap);
  }

  private isPresentingResults(): boolean {
    if (!this.code || !this.playerId || (!this.draining && this.evQ.length === 0)) return false;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    return snap?.phase === 'results' && (!snap.canRematch || this.draining || this.evQ.length > 0);
  }

  private speakResumeCue(): void {
    if (!this.code || !this.playerId) return;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    if (!snap) return;
    this.lastPhase = snap.phase;
    this.lastCanRematch = snap.canRematch;
    if (snap.phase === 'battle') {
      this.introDone = true;
      this.menuLevel = snap.activeMenu;
      this.deps.say(this.text('voice.resumeBattle'));
      this.speakTurnCue(snap);
      return;
    }
    if (snap.phase === 'monster_select') {
      if (snap.myMonsterName) this.deps.say(this.text(
        snap.canStartBattle ? 'voice.resumeSelectReady' : 'voice.resumeSelectWaiting',
        { monster: snap.myMonsterName },
      ));
      else this.deps.say(this.text('voice.resumeSelect'));
      return;
    }
    if (snap.phase === 'results') {
      this.deps.say(snap.canRematch
        ? this.text('voice.resumeResultsReady')
        : this.text('voice.resumeResultsWaiting'));
      return;
    }
    this.deps.say(snap.myName
      ? this.text('voice.resumeLobbyNamed', { name: snap.myName })
      : this.text('voice.resumeLobby'));
  }

  private speakTurnCue(snap: BattleVoiceSnapshot): void {
    const key = `${snap.turn ?? 0}:${snap.activeSide ?? 'none'}:${snap.whoseTurn ?? 'none'}`;
    if (key === this.lastTurnCueKey) return;
    this.lastTurnCueKey = key;
    if (snap.whoseTurn === 'me') {
      this.deps.say(this.text((snap.turn ?? 0) === 0 ? 'voice.turnMineFirst' : 'voice.turnMine'));
    } else if (snap.whoseTurn === 'foe') {
      const monster = snap.foeMonsterName ?? this.text('voice.otherMonster');
      this.deps.say(this.text((snap.turn ?? 0) === 0 ? 'voice.turnFoeFirst' : 'voice.turnFoe', { monster }));
    }
  }

  private battleIntroFor(snap: BattleVoiceSnapshot): string {
    const mine = snap.myMonsterName ?? this.text('voice.yourMonsterLower');
    const foe = snap.foeMonsterName ?? this.text('voice.rival');
    const myType = this.spokenType(snap.myMonsterType);
    const foeType = this.spokenType(snap.foeMonsterType);
    return this.text('voice.typedIntro', { mine, foe, myType, foeType });
  }

  private spokenType(type: string | null): string {
    if (!type) return this.text('voice.unknownType');
    const localized = monsterTypeLabel(type as MonsterType, this.commandLocale);
    return this.text('voice.type', { type: localized });
  }

  handleClose(): void {
    this.turnEpoch++;
    if (this.code && this.playerId) this.deps.leave(this.code, this.playerId, this.callSid ?? '');
    this.code = null; this.playerId = null; this.callSid = null;
  }

  handleReplaced(): void {
    this.turnEpoch++;
    this.evQ = [];
    this.draining = false;
    this.pendingStateCue = false;
    this.code = null; this.playerId = null; this.callSid = null;
  }
}

/** True when the caller is asking to move the flow FORWARD (start / pick a monster / rematch / continue).
 *  Includes intent phrasings like "I want to choose a monster" / "let's play" so a spoken ACTION moves
 *  the on-screen flow, not just the bare keyword "start". */
export function isAdvanceWord(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): boolean {
  const q = normalizeForMatching(spoken, locale);
  if (locale === 'pt-BR') {
    if (/\b(comecar|iniciar|ir|batalha|batalhar|lutar|pronto|pronta|proximo|proxima|continuar|revanche|novamente|sim)\b/.test(q)) return true;
    if (/\b(de novo|jogar de novo|vamos (jogar|batalhar|lutar|comecar)|estou pront[oa])\b/.test(q)) return true;
    if (/\b(escolher|escolha|selecionar|selecione)\b/.test(q) && /\b(monstro|lutador|criatura|personagem)\b/.test(q)) return true;
    return false;
  }
  if (/\b(start|begin|go|battle|fight|fight now|ready|next|continue|rematch|again|play again|run it back|let'?s (go|play|battle|fight)|i'?m ready)\b/.test(q)) return true;
  if (/\b(choose|pick|select|show me)\b/.test(q) && /\b(monster|fighter|creature|character)\b/.test(q)) return true;
  return false;
}

/** A one-line background blurb for a monster (spoken after a pick), keyed by roster id → its flavor. */
function monsterBlurb(name: string, locale: SupportedLocale): string {
  const key = name.toLowerCase().replace(/\s+/g, '');
  const messageKey = MONSTER_BLURBS[key] ?? 'voice.blurbFallback';
  return createTranslator(locale, MONSTERS_MESSAGES)(messageKey);
}
const MONSTER_BLURBS: Record<string, MonstersMessageKey> = {
  sparkmouse: 'voice.blurbSparkmouse',
  embertail: 'voice.blurbEmbertail',
  shellback: 'voice.blurbShellback',
  thornling: 'voice.blurbThornling',
  galecoil: 'voice.blurbGalecoil',
  voltcrest: 'voice.blurbVoltcrest',
  dazeduck: 'voice.blurbDazeduck',
  psyclone: 'voice.blurbPsyclone',
};

/** Match a spoken phrase to a choice index by NAME (fuzzy) or NUMBER ("two", "monster 3"), or -1. */
function matchNameOrNumber(spoken: string, choices: string[], locale: SupportedLocale): number {
  const q = normalizeForMatching(spoken, locale);
  // number words / digits first. Ordinals must beat cardinals so "second one" is 2, not 1.
  const NUM: Record<string, number> = locale === 'pt-BR'
    ? { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8 }
    : { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const ORD: Record<string, number> = locale === 'pt-BR'
    ? {
        primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3, quarto: 4, quarta: 4,
        quinto: 5, quinta: 5, sexto: 6, sexta: 6, setimo: 7, setima: 7, oitavo: 8, oitava: 8,
      }
    : { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };
  const digit = q.match(/\b(\d)(?:st|nd|rd|th)?\b/);
  if (digit) { const n = parseInt(digit[1]!, 10); if (n >= 1 && n <= choices.length) return n - 1; }
  for (const [w, n] of Object.entries(ORD)) {
    const pattern = locale === 'pt-BR'
      ? new RegExp(`^(?:(?:eu )?(?:quero|escolho|prefiro) )?(?:(?:o|a) )?${w}(?: monstro| opcao)?$`)
      : new RegExp(`^(?:i(?:'d| would)? (?:like|take|pick) )?(?:the )?${w}(?: one| monster| option)?$`);
    if (pattern.test(q) && n <= choices.length) return n - 1;
  }
  for (const [w, n] of Object.entries(NUM)) {
    const pattern = locale === 'pt-BR'
      ? new RegExp(`^(?:(?:eu )?(?:quero|escolho|prefiro) )?(?:(?:numero|monstro|opcao) )?${w}$`)
      : new RegExp(`^(?:i(?:'d| would)? (?:like|take|pick) )?(?:(?:number|monster|option) )?${w}$`);
    if (pattern.test(q) && n <= choices.length) return n - 1;
  }
  // name: exact, then substring either way
  const normalizedChoices = choices.map((choice, index) =>
    localizedMonsterAliases(ROSTER[index]?.id ?? '', choice).map(alias => normalizeForMatching(alias, locale)).join(' '));
  let i = normalizedChoices.findIndex(choice => choice === q);
  if (i >= 0) return i;
  i = normalizedChoices.findIndex(choice => choice.includes(q) || q.includes(choice));
  return i;
}

function playerName(from: string | undefined, locale: SupportedLocale): string {
  const text = createTranslator(locale, MONSTERS_MESSAGES);
  if (from && from.length >= 4) return text('voice.playerNumber', { number: from.slice(-4) });
  return text('voice.challenger');
}

function isBattleHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(ajuda|instrucoes|comandos|como jogar|o que posso dizer)\b/.test(text)
    : /\b(help|instructions|commands|how do i play|what can i say)\b/.test(text);
}

function sideForActionEvent(ev: BattleEvent): 'a' | 'b' | null {
  return ev.kind === 'move_used' || ev.kind === 'guard' || ev.kind === 'item' || ev.kind === 'taunt'
    ? ev.by : null;
}

/** Extract a caller's NAME from a spoken reply, or null if it doesn't look like a name (a question, a
 *  command, or empty). Handles "I'm Ada" / "my name is Rex" / "this is Bo" / bare "Ada". Kept simple +
 *  deterministic so name capture never depends on the LLM. */
export function parseSpokenName(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  let q = spoken.trim().replace(/[.!?,]+$/, '');
  if (!q) return null;
  const low = normalizeForMatching(q, locale);
  // Not a name: obvious questions or game commands (so "start"/"which one?" don't become the name).
  if (/[?]/.test(spoken)) return null;
  const command = locale === 'pt-BR'
    ? /^(comecar|iniciar|ir|proximo|lutar|atacar|defender|bloquear|proteger|item|pocao|curar|provocar|zombar|sim|nao|pronto|pronta|ajuda|qual|quem|como|por que|quando|onde)\b/
    : /^(start|go|next|fight|guard|item|potion|taunt|yes|no|ready|help|what|which|who|how|why|when|where)\b/;
  if (command.test(low)) return null;
  // Strip a lead-in ("my name is", "i'm", "i am", "this is", "it's", "call me").
  const leadIn = locale === 'pt-BR'
    ? /^(?:meu nome [ée]|eu sou|sou|me chamo|pode me chamar de|aqui [ée])\s+/iu
    : /^(?:my name is|i am|i'm|im|this is|it's|its|call me|the name's|name's)\s+/i;
  q = q.replace(leadIn, '');
  // Take the first 1-2 words, letters/hyphen/apostrophe only; reject if nothing name-like remains.
  const words = q.split(/\s+/).filter(w => /^\p{L}[\p{L}'’-]*$/u.test(w)).slice(0, 2);
  if (!words.length) return null;
  const name = words.join(' ');
  if (name.length < 2 || name.length > 20) return null;
  // Title-case for display.
  return name.replace(/(^|[\s'-])(\p{L})/gu, (_match, prefix: string, letter: string) =>
    prefix + letter.toLocaleUpperCase(locale));
}

function parseExplicitSpokenName(spoken: string, locale: SupportedLocale): string | null {
  const explicit = locale === 'pt-BR'
    ? /^(?:meu nome [ée]|eu sou|sou|me chamo|pode me chamar de|aqui [ée])\s+/iu
    : /^(?:my name is|i am|i'm|im|this is|it's|its|call me|the name's|name's)\s+/i;
  if (!explicit.test(spoken.trim())) return null;
  return parseSpokenName(spoken, locale);
}
