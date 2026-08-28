// The Voice Monsters CALL session: binds ONE Conversation Relay caller to a battle room and drives it
// by voice. The battler's analog of ConversationRelayAdapter (the racer's), but turn-based:
//   • setup   → join the caller as a player + greet.
//   • prompt  → (final utterance) route by phase: monster-select name/number → pick; battle turn word
//               ("guard"/"Ember"/"2") → commit the action; else hand to the LLM host for chat/questions.
//   • events  → speak scripted commentary (super-effective/crit/faint/win) via battle-commentary.
// All game access is through injected deps (BattleVoiceDeps) + the LLM through `converse`, so it
// unit-tests with fakes and has no direct WS/BattleServer dependency.
import { parseCrMessage } from './conversation-relay';
import { matchBattleAction, parseMoveNumber } from '../shared/battle-intent';
import { commentaryForBattleEvent, battleIntro } from '../shared/battle-commentary';
import { dwellForEvent, HANDOFF_PAUSE_MS } from '../shared/battle-timing';
import type { BattleEvent, BattleAction } from '../shared/battle-world';
import { ROSTER } from '../shared/monster-roster';
import { localizedMonsterAliases } from '../shared/i18n/content';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { MONSTERS_MESSAGES, type MonstersMessageKey } from '../shared/i18n/monsters';
import { createTranslator, formatList, normalizeForMatching, type MessageValues } from '../shared/i18n/translate';
import { monsterTypeLabel, type MonsterType } from '../shared/monster-types';
import { isExplicitSpokenName, parseFirstName } from '../shared/spoken-name';

/** A snapshot of the caller's live battle state, flattened for voice routing + the LLM host context. */
export interface BattleVoiceSnapshot {
  phase: 'lobby' | 'monster_select' | 'battle' | 'results';
  mySide: 'a' | 'b';                       // the caller's ABSOLUTE side (for mapping event sides → names)
  monsterNames: string[];                 // selectable monsters (roster order) — for select + LLM
  myName: string | null;
  myMonsterId: string | null; myMonsterName: string | null;
  myMonsterType: string | null;
  canAdvanceLobby: boolean;
  canStartBattle: boolean;
  canRematch: boolean;
  foeName: string | null;
  foeMonsterName: string | null;
  foeMonsterType: string | null;
  myHp: number | null; myMaxHp: number | null;
  foeHp: number | null; foeMaxHp: number | null;
  myPotions: number;
  myGuarding?: boolean; myTaunted?: boolean;
  foeGuarding?: boolean; foeTaunted?: boolean;
  turn: number | null;
  activeSide: 'a' | 'b' | null;
  participating: boolean;
  activeMenu: 'root' | 'fight';
  whoseTurn: 'me' | 'foe' | null;
  myMoves: { id: string; name: string }[];   // the caller's 4 moves (battle)
  winnerName: string | null;
}

/** Everything the session needs from its host (the HTTP server wires these to the BattleServer + LLM). */
export interface BattleVoiceDeps {
  join(code: string, name: string, callSid: string, side?: 'a' | 'b', expectedPlayers?: number, nameConfirmed?: boolean): { playerId: string; resumed: boolean } | null;
  leave(code: string, playerId: string, callSid: string): void;
  setName(code: string, playerId: string, name: string): void;
  selectMonster(code: string, playerId: string, monsterId: string): void;
  openFight(code: string, playerId: string): void;
  backMenu(code: string, playerId: string): void;
  chooseAction(code: string, playerId: string, action: BattleAction): void;
  advance(code: string, playerId: string): boolean;
  say(text: string): void;                            // speak a line to THIS caller (Relay TTS)
  /** Schedule `fn` after `ms` (injected so tests can drive the paced-commentary clock synchronously). */
  setTimer(fn: () => void, ms: number): void;
  snapshot(code: string, playerId: string, locale?: SupportedLocale): BattleVoiceSnapshot | null;
  /** Conversational LLM turn (host brain). Returns what to say, or null → scripted fallback / silence. */
  converse(code: string, playerId: string, utterance: string, isCurrent: () => boolean, locale: SupportedLocale,nameLocked:boolean,stationManaged:boolean,authoritativeName:string|null): Promise<string | null>;
}

const GREETING_KEYS = [
  'voice.greetingWelcome', 'voice.greetingRelay', 'voice.askName',
] as const satisfies readonly MonstersMessageKey[];
const FINAL_REPEAT_GUARD_MS = 5_000;
const SAME_CONTEXT_REPEAT_GUARD_MS = 400;

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
  private authoritativeName: string | null = null;
  private stationManaged=false;
  private stationAssignment: { side: 'a' | 'b'; expectedPlayers: number } | null = null;
  private lastFinalCommand: { text: string; beforeContext: string; afterContext: string; at: number; inputSignal:number } | null = null;
  private inputSignal=0;
  private awaitingName = false;
  private applyingSetupChange=false;
  private lastCanAdvanceLobby=false;
  private lastCanStartBattle=false;
  private text: (key: MonstersMessageKey, values?: MessageValues) => string = createTranslator(DEFAULT_LOCALE, MONSTERS_MESSAGES);

  constructor(private deps: BattleVoiceDeps) {}

  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 50) || null;
  }
  setStationManaged(active:boolean):void{this.stationManaged=active;}
  setStationAssignment(index: number, count: number): void {
    this.stationAssignment = { side: index === 1 ? 'b' : 'a', expectedPlayers: count >= 2 ? 2 : 1 };
  }

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
        const joined=this.deps.join(code,this.authoritativeName??playerName(msg.from,this.commandLocale),msg.callSid,
          this.stationAssignment?.side,this.stationAssignment?.expectedPlayers??(this.authoritativeName?1:undefined),
          this.authoritativeName !== null);
        if (!joined) { this.deps.say(this.text('voice.roomUnavailable')); return; }
        this.code = code; this.playerId = joined.playerId; this.callSid = msg.callSid;
        const current = this.deps.snapshot(code, joined.playerId, this.commandLocale);
        const snap = current&&this.authoritativeName?{...current,myName:this.authoritativeName}:current;
        this.awaitingName = !this.authoritativeName && !snap?.myName;
        if (joined.resumed) this.speakResumeCue();
        else {
           this.lastPhase = snap?.phase ?? null;
           this.lastCanRematch = snap?.canRematch ?? false;
           this.lastCanAdvanceLobby=snap?.canAdvanceLobby??false;
           this.lastCanStartBattle=snap?.canStartBattle??false;
          if (snap?.phase === 'battle' && !snap.myMonsterId) {
            this.deps.say(this.text('voice.lateBattle'));
            if(snap.myName){this.deps.say(this.text('voice.welcomeNamed',{name:snap.myName}));this.deps.say(this.text('voice.greetingActions'));}
            else this.deps.say(this.text('voice.askName'));
          } else if (snap?.phase === 'results') {
            this.deps.say(this.text('voice.lateResults'));
            this.deps.say(snap.myName?(this.stationManaged?this.text('voice.welcomeNamed',{name:snap.myName}):this.text('voice.welcomeRematchNamed',{name:snap.myName})):this.text('voice.askName'));
            if(snap.myName&&this.stationManaged)this.deps.say(this.text('voice.waitOperator'));
          } else if(this.authoritativeName&&snap){
            this.deps.say(this.text('voice.welcomeNamed',{name:this.authoritativeName}));
            this.deps.say(this.text('voice.greetingRelay'));
            if(snap.phase==='lobby'){
              this.deps.say(this.text('voice.greetingRules'));
              this.deps.say(this.text('voice.greetingActions'));
              this.deps.say(this.text('voice.helpLobbyNamed'));
            }else{
              this.deps.say(this.text('voice.greetingActions'));
              this.deps.say(this.text(snap.phase==='monster_select'?'voice.helpSelect':'voice.howTo'));
            }
          } else {
            for (const key of this.authoritativeName ? GREETING_KEYS.slice(0, -1) : GREETING_KEYS) this.deps.say(this.text(key));
          }
        }
        break;
      }
      case 'prompt': {
        if (!this.code || !this.playerId) return;
        this.cancelNarration();
        const text = msg.voicePrompt.trim();
        if (!msg.last) { this.inputSignal++;this.turnEpoch++; return; }
        if (text) {
          const normalized = normalizeForMatching(text, this.commandLocale);
          const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
          const beforeContext = this.finalCommandContext(snap);
          const now = Date.now();
          const previousCrossedBoundary = this.lastFinalCommand
            ? this.crossedFinalCommandBoundary(this.lastFinalCommand.beforeContext, this.lastFinalCommand.afterContext)
            : false;
          const repeatedTransition = previousCrossedBoundary && this.lastFinalCommand?.afterContext === beforeContext;
          const repeatedSameContext = this.lastFinalCommand?.beforeContext === beforeContext
            && this.lastFinalCommand.afterContext === beforeContext;
          const repeatWindow = repeatedTransition ? FINAL_REPEAT_GUARD_MS : SAME_CONTEXT_REPEAT_GUARD_MS;
          const signaledNewUtterance=this.lastFinalCommand?.inputSignal!==this.inputSignal;
          const reusableTransition=this.lastFinalCommand
            ?this.isReusableTransition(normalized,this.lastFinalCommand.beforeContext,this.lastFinalCommand.afterContext):false;
          if (this.lastFinalCommand?.text === normalized && now - this.lastFinalCommand.at < repeatWindow
            && (repeatedTransition || repeatedSameContext)&&!signaledNewUtterance&&!reusableTransition){this.speakReprompt();return;}
          this.handleUtterance(text);
          const afterContext = this.finalCommandContext(this.deps.snapshot(this.code, this.playerId, this.commandLocale));
          this.lastFinalCommand = { text: normalized, beforeContext, afterContext, at: now,inputSignal:this.inputSignal };
        }else this.speakReprompt();
        break;
      }
      case 'interrupt':
        this.cancelNarration();
        this.inputSignal++;
        this.turnEpoch++;   // caller barged in → drop any in-flight LLM reply
        this.lastFinalCommand = null;
        break;
      case 'dtmf': {
        if (!this.code || !this.playerId) return;
        this.cancelNarration();this.inputSignal++;
        const digit = msg.digit.trim();
        if (/^[0-9*#]$/.test(digit)) {
          this.handleUtterance(digit === '0' ? this.backCommand() : digit);
        }
        break;
      }
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
    const current = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale);
    const snap = current&&this.authoritativeName?{...current,myName:this.authoritativeName}:current;
    if (!snap) { void this.converse(text); return; }
    if (this.awaitingName) {
      if (this.captureName(text, snap.phase, true)) { this.awaitingName = false; return; }
      this.deps.say(this.text('voice.askName'));
      return;
    }
    if (isBattleHelpRequest(text, this.commandLocale)) {
      const key = snap.phase === 'lobby' ? (this.authoritativeName || snap.myName ? 'voice.helpLobbyNamed' : 'voice.helpLobby')
        : snap.phase === 'monster_select' ? 'voice.helpSelect'
          : snap.phase === 'results' ? this.stationManaged?'voice.waitOperator':'voice.helpResults' : 'voice.howTo';
      this.deps.say(this.text(key));
      return;
    }

    // Every REQUIRED step of the flow has a deterministic, LLM-INDEPENDENT path here, so the game is
    // fully playable by voice even with the LLM off/slow. The LLM is only a fallback for chat/questions.

    if(snap.phase==='results'&&this.stationManaged){
      this.deps.say(this.text('voice.waitOperator'));return;
    }
    if (snap.phase === 'results' && (!snap.canRematch || this.draining || this.evQ.length > 0)) {
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
      if (snap.phase === 'lobby') {
        if (!snap.canAdvanceLobby) { this.deps.say(this.text('voice.helpLobbyNamed'));return; }
        if (!this.deps.advance(this.code!,this.playerId!)) { this.deps.say(this.text('voice.sharedMenuControl'));return; }
        this.deps.say(this.text('voice.toSelect'));
        return;
      }
      if (snap.phase === 'monster_select') {
        if (!snap.myMonsterId) { this.deps.say(this.text('voice.pickFirst')); return; }
        if (!snap.canStartBattle) { this.deps.say(this.text('voice.pickWaiting')); return; }
        if (!this.deps.advance(this.code!,this.playerId!)) this.deps.say(this.text('voice.sharedMenuControl'));
        return;   // battle starts → the paced battle-intro handles the talking
      }
      if (snap.phase === 'results') {
        if (!this.deps.advance(this.code!, this.playerId!)) this.deps.say(this.text('voice.sharedMenuControl'));
        else {
          const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale);
          this.deps.say(this.text(next?.phase==='lobby'
            ?next.myName?'voice.helpLobbyNamed':'voice.askName':'voice.rematch'));
        }
        return;
      }
    }

    // MONSTER SELECT: a clear name/number picks a monster. Calm confirmation + a quick background on it,
    // then guidance about what's next (wait for players, or say "battle").
    if (snap.phase === 'monster_select') {
      const idx = matchNameOrNumber(text, snap.monsterNames, this.commandLocale);
      if (idx >= 0) {
        const name = snap.monsterNames[idx]!;
        this.applyingSetupChange=true;
        this.deps.selectMonster(this.code!, this.playerId!, ROSTER[idx]!.id);
        this.applyingSetupChange=false;
        const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale);
        this.deps.say(this.text('voice.lockedMonster',{name}));
        this.deps.say(this.text(next?.canStartBattle?'voice.pickReady':'voice.pickWaiting'));
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
      if (snap.myPotions <= 0 && isItemRequest(text, level, this.commandLocale)) {
        this.deps.say(this.text('voice.noPotions'));
        return;
      }
      const res = matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level }, this.commandLocale);
      if (res) {
        if (res.kind === 'openFight') {
          this.menuLevel = 'fight';
          if(snap.activeMenu!=='fight')this.deps.openFight(this.code!, this.playerId!);
          this.speakMoveChoices(snap);
          return;
        }
        if (res.kind === 'back') { this.menuLevel = 'root'; this.deps.backMenu(this.code!, this.playerId!); return; }
        this.menuLevel = 'root';
        this.deps.chooseAction(this.code!, this.playerId!, res);
        return;
      }
    }

    if(snap.phase==='lobby'||snap.phase==='monster_select'){
      this.speakReprompt();
      return;
    }
    // Everything else (chat, questions, ambiguous, or the LLM should decide) → the host brain.
    void this.converse(text);
  }

  private speakMoveChoices(snap: BattleVoiceSnapshot): void {
    const list = formatList(this.commandLocale, snap.myMoves.map((move, index) => `${index + 1}, ${move.name}`));
    this.deps.say(this.text('voice.moves', { moves: list }));
  }

  private finalCommandContext(snap: BattleVoiceSnapshot | null): string {
    return snap
      ? `${snap.phase}:${snap.myMonsterId??''}:${snap.canAdvanceLobby?1:0}:${snap.canStartBattle?1:0}:${snap.turn ?? ''}:${snap.activeSide ?? ''}:${snap.activeMenu}:${snap.whoseTurn ?? ''}:${this.draining ? 1 : 0}:${this.evQ.length}`
      : 'unavailable';
  }

  private crossedFinalCommandBoundary(before: string, after: string): boolean {
    return before.startsWith('lobby:') && after.startsWith('monster_select:')
      || before.startsWith('monster_select:') && after.startsWith('battle:')
      || before.includes(':root:') && after.includes(':fight:');
  }

  private isReusableTransition(text:string,before:string,after:string):boolean{
    if(before.startsWith('monster_select:')&&after.startsWith('battle:'))return isAdvanceWord(text,this.commandLocale);
    return parseMoveNumber(text,this.commandLocale)===null&&before.includes(':root:')&&after.includes(':fight:')
      &&matchBattleAction(text,{moves:[],potions:0,level:'root'},this.commandLocale)?.kind==='openFight';
  }

  private looksLikeBattleCommand(text: string, snap: BattleVoiceSnapshot): boolean {
    if (matchBattleAction(text, { moves: snap.myMoves, potions: snap.myPotions, level: snap.activeMenu }, this.commandLocale)) return true;
    const normalized = normalizeForMatching(text, this.commandLocale);
    if (/^[0-4]$/.test(normalized) || isItemRequest(text, snap.activeMenu, this.commandLocale)) return true;
    return this.commandLocale === 'pt-BR'
      ? /\b(lutar|luta|lute|batalhar|combater|atacar|ataque|ataca|golpe|defender|bloquear|proteger|item|pocao|curar|provocar|zombar|voltar|cancelar)\b/.test(normalized)
      : /\b(fight|fights|flight|five|attack|move|guard|item|potion|taunt|go|hit|strike|back|cancel|return)\b/.test(normalized);
  }

  private backCommand(): string { return this.commandLocale === 'pt-BR' ? 'voltar' : 'back'; }

  private captureName(text: string, phase: BattleVoiceSnapshot['phase'], allowBare = false): boolean {
    const name = phase === 'monster_select' && !allowBare
      ? parseExplicitSpokenName(text, this.commandLocale)
      : parseSpokenName(text, this.commandLocale);
    if (!name) return false;
    this.applyingSetupChange=true;
    this.deps.setName(this.code!, this.playerId!, name);
    this.applyingSetupChange=false;
    const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale);
    const currentPhase = next?.phase ?? phase;
    this.deps.say(this.text(
      currentPhase === 'lobby' ? 'voice.nameLobby'
        : currentPhase === 'results' ? 'voice.nameResults'
          : currentPhase === 'battle' ? 'voice.nameBattle' : 'voice.nameSelect',
      { name },
    ));
    if (currentPhase === 'lobby') {
      this.deps.say(this.text('voice.greetingRules'));
      this.deps.say(this.text('voice.greetingActions'));
      this.deps.say(this.text('voice.helpLobbyNamed'));
    } else if (currentPhase === 'monster_select') this.deps.say(this.text('voice.helpSelect'));
    return true;
  }

  /** Fire the conversational host; speak its reply unless the caller has spoken again since (epoch). */
  private converse(text: string): void {
    const epoch = ++this.turnEpoch;
    const before = this.repromptState();
    const isCurrent = () => epoch === this.turnEpoch && !this.isPresentingResults();
    void this.deps.converse(this.code!, this.playerId!, text, isCurrent, this.commandLocale,this.authoritativeName!==null,this.stationManaged,this.authoritativeName)
      .then(reply => {
        if (!isCurrent()) return;
        if (reply) this.deps.say(reply);
        else if (before === this.repromptState()) this.speakReprompt();
      })
      .catch(() => {
        if (isCurrent() && before === this.repromptState()) this.speakReprompt();
      });
  }

  private repromptState(): string | null {
    if (!this.code || !this.playerId) return null;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    if (!snap) return null;
    return JSON.stringify([
      snap.phase, snap.myName, snap.myMonsterId, snap.canStartBattle, snap.canRematch,
      snap.canAdvanceLobby,
      snap.turn, snap.activeSide, snap.activeMenu, snap.whoseTurn, snap.myPotions, snap.participating,
    ]);
  }

  private speakReprompt(): void {
    if (!this.code || !this.playerId) return;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    if (!snap) return;
    if (snap.phase === 'lobby') {
      this.deps.say(this.text(snap.myName || this.authoritativeName ? 'voice.helpLobbyNamed' : 'voice.helpLobby'));
    } else if (snap.phase === 'monster_select') {
      this.deps.say(this.text(!snap.myMonsterId?'voice.helpSelect':snap.canStartBattle?'voice.pickReady':'voice.pickWaiting'));
    } else if (snap.phase === 'results') {
      this.deps.say(this.text(this.stationManaged ? 'voice.waitOperator' : 'voice.helpResults'));
    } else if (!snap.participating) {
      this.deps.say(this.text('voice.currentBattle'));
    } else if (this.draining || this.evQ.length > 0) {
      this.deps.say(this.text('voice.resolving'));
    } else if (snap.whoseTurn === 'foe') {
      this.deps.say(this.text('voice.foeTurn', { monster: snap.foeMonsterName ?? this.text('voice.otherMonster') }));
    } else if (snap.activeMenu === 'fight') {
      this.speakMoveChoices(snap);
    } else {
      this.deps.say(this.text('voice.battlePrompt'));
    }
  }

  private introDone = false;   // one dramatic "X vs Y" intro + how-to-play recap per battle
  private evQ: BattleEvent[] = [];   // events queued to narrate, drained on the SAME clock as the screen
  private draining = false;
  private narrationGeneration=0;
  private settleWaiters: (() => void)[] = [];
  private pendingStateCue = false;
  private lastTurnCueKey = '';
  private lastActionSide: 'a' | 'b' | null = null;

  /** Receive a battle-state push. Used for proactive call guidance that is NOT part of the resolution
   *  event stream: battle intro, opening controls, whose turn it is, and who should wait. */
  onBattleStateChanged(): void {
    if (!this.code || !this.playerId) return;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    if (snap?.phase === 'battle' && !snap.participating) return;
    if(this.applyingSetupChange){
      this.lastPhase=snap?.phase??null;this.lastCanAdvanceLobby=snap?.canAdvanceLobby??false;
      this.lastCanStartBattle=snap?.canStartBattle??false;return;
    }
    const lobbyBecameReady=snap?.phase==='lobby'&&snap.canAdvanceLobby&&!this.lastCanAdvanceLobby;
    const selectionBecameReady=snap?.phase==='monster_select'&&snap.canStartBattle&&!this.lastCanStartBattle;
    if (snap && this.lastPhase !== null && snap.phase !== this.lastPhase) this.turnEpoch++;
    if (this.draining || this.evQ.length > 0) { this.pendingStateCue = true; return; }
    this.speakStateCue();
    if(lobbyBecameReady)this.deps.say(this.text('voice.helpLobbyNamed'));
    if(selectionBecameReady)this.deps.say(this.text('voice.pickReady'));
    this.lastCanAdvanceLobby=snap?.canAdvanceLobby??false;
    this.lastCanStartBattle=snap?.canStartBattle??false;
  }

  /** Receive a battle event. The server hands us a whole turn's events at once, but the SCREEN plays
   *  them one at a time on the dwellForEvent clock — so we QUEUE them and narrate on that same clock,
   *  keeping the spoken commentary in sync with the on-screen animation (not all dumped at once). */
  onBattleEvent(ev: BattleEvent): void {
    if (!this.code || !this.playerId) return;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    if (snap?.phase === 'battle' && !snap.participating) return;
    this.evQ.push(ev);
    if (!this.draining) { this.draining = true; this.drainEvents(); }
  }

  /** Narrate the next queued event, then schedule the following one after its on-screen dwell. */
  private drainEvents(): void {
    const ev = this.evQ.shift();
    if (!ev) {
      this.draining = false;
      if (this.pendingStateCue) { this.pendingStateCue = false; this.speakStateCue(); }
      for (const resolve of this.settleWaiters.splice(0)) resolve();
      return;
    }
    const actionSide = sideForActionEvent(ev);
    if (actionSide && this.lastActionSide && this.lastActionSide !== actionSide) {
      this.lastActionSide = actionSide;
      this.evQ.unshift(ev);
      this.scheduleNarrationDrain(HANDOFF_PAUSE_MS);
      return;
    }
    if (actionSide) this.lastActionSide = actionSide;
    this.speakEvent(ev);
    // Match the screen: hold for this event's own dwell, then narrate the next event/state cue.
    this.scheduleNarrationDrain(dwellForEvent(ev));
  }

  private scheduleNarrationDrain(delay:number):void{
    const generation=this.narrationGeneration;
    this.deps.setTimer(()=>{if(generation===this.narrationGeneration)this.drainEvents();},delay);
  }

  private cancelNarration():void{
    this.narrationGeneration++;
    this.evQ=[];
    this.draining=false;
    this.pendingStateCue=false;
    this.lastActionSide=null;
    for(const resolve of this.settleWaiters.splice(0))resolve();
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
    if(this.stationManaged)return this.text('voice.overStation',{winner:ev.winnerName,winnerMonster});
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
      if (rematchBecameReady&&!this.stationManaged) this.deps.say(this.text('voice.rematchReady'));
      if (previous === 'battle' && snap?.phase === 'monster_select') {
        const pick = snap.myMonsterName ? this.text('voice.pickLocked', { monster: snap.myMonsterName }) : '';
        this.deps.say(this.text('voice.playerLeft', { pick }));
        if (!snap.myMonsterId) this.deps.say(this.text('voice.helpSelect'));
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
    }
    this.speakTurnCue(snap);
  }

  private isPresentingResults(): boolean {
    if (!this.code || !this.playerId || (!this.draining && this.evQ.length === 0)) return false;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    return snap?.phase === 'results' && (!snap.canRematch || this.draining || this.evQ.length > 0);
  }

  whenSpeechSettled(): Promise<void> {
    if (!this.draining && this.evQ.length === 0) return Promise.resolve();
    return new Promise(resolve => this.settleWaiters.push(resolve));
  }

  private speakResumeCue(): void {
    if (!this.code || !this.playerId) return;
    const snap = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
    if (!snap) return;
    this.lastPhase = snap.phase;
    this.lastCanRematch = snap.canRematch;
    this.lastCanAdvanceLobby=snap.canAdvanceLobby;
    this.lastCanStartBattle=snap.canStartBattle;
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
      if(this.stationManaged){this.deps.say(this.text('voice.waitOperator'));return;}
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
      this.deps.say(this.text((snap.turn ?? 0) === 0 ? 'voice.turnMineFirst' : 'voice.turnMine', {
        player: snap.myName ?? '', monster: snap.myMonsterName ?? this.text('voice.yourMonsterLower'),
      }));
    } else if (snap.whoseTurn === 'foe') {
      const monster = snap.foeMonsterName ?? this.text('voice.otherMonster');
      this.deps.say(this.text((snap.turn ?? 0) === 0 ? 'voice.turnFoeFirst' : 'voice.turnFoe', {
        monster, player: snap.foeName ?? this.text('voice.otherPlayer'),
      }));
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
    this.turnEpoch++;this.cancelNarration();
    const preserve=this.stationManaged&&this.code&&this.playerId
      &&this.deps.snapshot(this.code,this.playerId,this.commandLocale)?.phase==='results';
    if (this.code && this.playerId&&!preserve) this.deps.leave(this.code, this.playerId, this.callSid ?? '');
    this.code = null; this.playerId = null; this.callSid = null;
  }

  handleReplaced(): void {
    this.turnEpoch++;
    this.cancelNarration();
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

function isItemRequest(spoken: string, level: BattleVoiceSnapshot['activeMenu'], locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  const itemWords = locale === 'pt-BR' ? ['item', 'pocao', 'curar', 'cura'] : ['item', 'potion', 'heal', 'bag', 'medicine'];
  if (itemWords.some(word => new RegExp(`\\b${word}\\b`).test(text))) return true;
  return level === 'root' && parseMoveNumber(spoken, locale) === 3;
}

function sideForActionEvent(ev: BattleEvent): 'a' | 'b' | null {
  return ev.kind === 'move_used' || ev.kind === 'guard' || ev.kind === 'item' || ev.kind === 'taunt'
    ? ev.by : null;
}

/** Extract a caller's NAME from a spoken reply, or null if it doesn't look like a name (a question, a
 *  command, or empty). Handles "I'm Ada" / "my name is Rex" / "this is Bo" / bare "Ada". Kept simple +
 *  deterministic so name capture never depends on the LLM. */
export function parseSpokenName(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  return parseFirstName(spoken, locale);
}

function parseExplicitSpokenName(spoken: string, locale: SupportedLocale): string | null {
  if (!isExplicitSpokenName(spoken, locale)) return null;
  return parseSpokenName(spoken, locale);
}
