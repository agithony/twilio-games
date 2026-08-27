import { parseCrMessage } from './conversation-relay';
import { isAdvanceWord as isEnglishAdvanceWord } from './battle-voice';
import { matchFighterCommands } from '../shared/fighter-intent';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';
import { FIGHTER_INTRO_SECONDS, fighterIntroStage, type FighterIntroStage, type FighterPhase } from '../shared/fighter-protocol';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { FIGHTER_MESSAGES, type FighterMessageKey } from '../shared/i18n/fighter';
import { createTranslator, formatNumber, normalizeForMatching } from '../shared/i18n/translate';
import { isExplicitSpokenName, parseFirstName } from '../shared/spoken-name';

const FINAL_REPEAT_GUARD_MS = 5_000;
const SAME_CONTEXT_REPEAT_GUARD_MS = 600;

export interface FighterVoiceSnapshot {
  phase: FighterPhase;
  myName: string | null;
  nameConfirmed?: boolean;
  myFighterId: string | null;
  myFighterName: string | null;
  foeName: string | null;
  foeFighterId: string | null;
  foeFighterName: string | null;
  selectedMap: string | null;
  myMapVote:string|null;
  allMapVotes:boolean;
  mySide: 'p1' | 'p2';
  myHealth: number | null;
  foeHealth: number | null;
  countdown: number | null;
  intro: number | null;
  winnerName: string | null;
  winnerSide: 'p1' | 'p2' | null;
  playerOneName: string | null;
  playerOneFighterName: string | null;
  playerTwoName: string | null;
  playerTwoFighterName: string | null;
  playerCount: number;
  hasExpectedPlayers?: boolean;
  automaticSetup:boolean;
  allFightersSelected: boolean;
  isController: boolean;
  fighters: { id: string; name: string }[];
  maps: { id: string; name: string }[];
}
export interface FighterVoiceDeps {
  join(code: string, name: string, callSid: string, side?: 'p1' | 'p2', expectedPlayers?: number, nameConfirmed?: boolean): { playerId: string; resumed: boolean } | null;
  leave(code: string, id: string, callSid: string): void;
  setName(code: string, id: string, name: string): void;
  selectFighter(code: string, id: string, fighterId: string): boolean;
  selectMap(code: string, id: string, mapId: string): boolean;
  advance(code: string, id: string): boolean;
  command(code: string, id: string, command: FighterCommand): boolean;
  snapshot(code: string, id: string, locale?: SupportedLocale): FighterVoiceSnapshot | null;
  say(text: string, isCurrent?: () => boolean): void;
}

export class FighterVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  get boundPlayerId(): string | null { return this.playerId; }
  get boundRoomCode(): string | null { return this.code; }
  private callSid: string | null = null;
  private lastPhase: FighterPhase | null = null;
  private lastCountdown = -1;
  private lastFoeFighterId: string | null = null;
  private lastFoeName: string | null = null;
  private lastCombatCueAt = 0;
  private lastIntroStage: FighterIntroStage | null = null;
  private interimCandidate: FighterCommand | null = null;
  private interimCount = 0;
  private interimFiredCommand: FighterCommand | null = null;
  private lastWaitCue = '';
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged=false;
  private stationAssignment: { side: 'p1' | 'p2'; expectedPlayers: number } | null = null;
  private applyingSelection=false;
  private applyingName=false;
  private awaitingName=false;
  private lastLobbyReady=false;
  private lastFinalText:{text:string;beforeContext:string;afterContext:string;at:number}|null=null;
  private t = createTranslator(this.commandLocale, FIGHTER_MESSAGES);
  constructor(private deps: FighterVoiceDeps) {}
  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 50) || null;
  }
  setStationManaged(active:boolean):void{
    if(this.stationManaged!==active)this.lastFinalText=null;
    this.stationManaged=active;
  }
  setStationAssignment(index: number, count: number): void {
    this.stationAssignment = { side: index === 1 ? 'p2' : 'p1', expectedPlayers: count >= 2 ? 2 : 1 };
  }
  get locale(): SupportedLocale { return this.commandLocale; }

  handleMessage(raw: string): void {
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      const code = message.customParameters['roomCode']?.trim().toUpperCase(); if (!code || this.playerId) return;
      this.commandLocale = resolveLocale(message.customParameters['commandLocale'] ?? message.customParameters['locale']);
      this.t = createTranslator(this.commandLocale, FIGHTER_MESSAGES);
      const joined=this.deps.join(code,this.authoritativeName??this.t('voice.callerPlaceholder'),message.callSid,
        this.stationAssignment?.side,this.stationAssignment?.expectedPlayers??(this.authoritativeName?1:undefined),
        this.authoritativeName!==null);
      if (!joined) { this.deps.say(this.t('voice.arenaFull')); return; }
      this.code = code; this.playerId = joined.playerId; this.callSid = message.callSid;
      const snapshot = this.deps.snapshot(code, joined.playerId, this.commandLocale); this.lastPhase = snapshot?.phase ?? null;
      this.awaitingName=!this.authoritativeName&&!(snapshot?.nameConfirmed??!this.isPlaceholderName(snapshot?.myName??null));
      this.lastLobbyReady=snapshot?this.isLobbyReady(snapshot):false;
      this.lastFoeFighterId = snapshot?.foeFighterId ?? null;
      this.lastFoeName = snapshot?.foeName ?? null;
      if (joined.resumed && snapshot) {
        this.deps.say(!this.isPlaceholderName(snapshot.myName)
          ? this.t('voice.returnedName', { name: snapshot.myName ?? '' }) : this.t('voice.returned'));
        this.speakContext(snapshot);
      } else {
        if(this.authoritativeName&&snapshot){
          this.deps.say(this.t('voice.welcomeName',{name:this.authoritativeName}));
          this.deps.say(this.t('voice.greetingRelay'));
          this.deps.say(this.t('voice.controlsIntro'));
          this.deps.say(this.t('voice.fightHelp'));
          this.speakContext(snapshot);
        }else{
          this.deps.say(this.t('voice.welcome'));
          this.deps.say(this.t('voice.greetingRelay'));
          this.deps.say(this.t('voice.tellName'));
        }
      }
      return;
    }
    if (message.type === 'dtmf' && this.code && this.playerId) {
      const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
      if (!snapshot || !/^[0-9*#]$/.test(message.digit)) return;
      const fightCommands = ['forward', 'back', 'jump', 'punch', 'kick', 'block'];
      const spoken = snapshot.phase === 'fight'
        ? fightCommands[Number(message.digit) - 1]
        : message.digit === '0' ? '10' : message.digit === '*' ? '11' : message.digit === '#' ? '12' : message.digit;
      if (spoken) this.handleUtterance(spoken);
      return;
    }
    if (message.type === 'interrupt') { this.resetInterim(); this.lastFinalText=null; return; }
    if (message.type === 'prompt' && this.code && this.playerId) {
      const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
      if (!message.last) {
        // Interim hypotheses can be revised. Never mutate fighter state until the final transcript.
        this.resetInterim();
        return;
      }
      this.resetInterim();
      const normalized=normalizeForMatching(message.voicePrompt,this.commandLocale),now=Date.now();
      const beforeContext=this.finalContext(snapshot);
      const previousCrossedBoundary=this.lastFinalText
        ?this.crossedSelectionBoundary(this.lastFinalText.beforeContext,this.lastFinalText.afterContext):false;
      const repeatedTransition=previousCrossedBoundary&&this.lastFinalText?.afterContext===beforeContext;
      const repeatedSameContext=this.lastFinalText?.beforeContext===beforeContext
        &&this.lastFinalText.afterContext===beforeContext;
      const repeatWindow=repeatedTransition?FINAL_REPEAT_GUARD_MS:SAME_CONTEXT_REPEAT_GUARD_MS;
      if(this.lastFinalText?.text===normalized&&now-this.lastFinalText.at<repeatWindow
        &&(repeatedTransition||repeatedSameContext))return;
      this.handleUtterance(message.voicePrompt);
      this.lastFinalText={text:normalized,beforeContext,
        afterContext:this.finalContext(this.deps.snapshot(this.code,this.playerId,this.commandLocale)),at:now};
    }
  }

  private handleUtterance(spoken: string): void {
    const snapshot = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale); if (!snapshot) return;
    const unnamed = !this.authoritativeName&&!(snapshot.nameConfirmed??!this.isPlaceholderName(snapshot.myName));
    if(this.awaitingName){
      const name=parseFighterSpokenName(spoken,this.commandLocale);
      if(name&&!isFighterAdvanceWord(spoken,this.commandLocale)&&!isFighterStarAlias(spoken,this.commandLocale)){
        this.awaitingName=false;this.applyingName=true;this.deps.setName(this.code!,this.playerId!,name);this.applyingName=false;
        const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)??snapshot;
        this.deps.say(this.t('voice.welcomeName',{name}));
        this.deps.say(this.t('voice.controlsIntro'));this.deps.say(this.t('voice.fightHelp'));
        this.speakContext(next);return;
      }
      this.deps.say(this.t('voice.tellName'));return;
    }
    if (isHelpRequest(spoken, this.commandLocale)) {
      if (snapshot.phase === 'fight') this.deps.say(this.t('voice.fightHelp'));
      else this.speakContext(snapshot);
      return;
    }
    const phaseChoices = snapshot.phase === 'fighter_select' ? snapshot.fighters : snapshot.phase === 'map_select' ? snapshot.maps : [];
    const looksLikeChoice = phaseChoices.length > 0 && !!matchChoice(spoken, phaseChoices, this.commandLocale);
    if (unnamed && (snapshot.phase === 'lobby' || isExplicitName(spoken, this.commandLocale) || !looksLikeChoice)) {
      const name = parseFighterSpokenName(spoken, this.commandLocale);
      if (name && !isFighterAdvanceWord(spoken, this.commandLocale) && !isFighterStarAlias(spoken, this.commandLocale)) {
        if(snapshot.phase==='lobby'){
          this.deps.say(this.t('voice.welcomeName',{name}));
          this.deps.say(this.t('voice.controlsIntro'));
          this.deps.say(this.t('voice.fightHelp'));
          this.applyingName=true;this.deps.setName(this.code!,this.playerId!,name);this.applyingName=false;
          const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)??snapshot;
          this.speakContext(next);return;
        }
        this.applyingName=true;this.deps.setName(this.code!, this.playerId!, name);this.applyingName=false;
        const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale) ?? snapshot;
        this.deps.say(this.t('voice.welcomeName',{name}));this.speakContext(next);
        return;
      }
    }
    if (snapshot.phase === 'fighter_select') {
      const fighter = matchChoice(spoken, snapshot.fighters, this.commandLocale);
      if (fighter) {
        this.applyingSelection=true;
        const selected=this.deps.selectFighter(this.code!,this.playerId!,fighter.id);
        this.applyingSelection=false;
        if(!selected)this.deps.say(this.t('voice.fighterUnavailable',{name:fighter.name}));
        else {
          const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale) ?? snapshot;
          const namePrompt = unnamed ? this.t('voice.namePromptSuffix') : '';
          const values = { name: fighter.name, namePrompt };
          if (!this.hasExpectedPlayers(next)) this.deps.say(this.t('voice.fighterLockedWaitingPlayerTwo', values));
           else if(next.phase==='map_select')this.deps.say(this.t('voice.fighterLockedNext',values));
           else this.deps.say(this.t('voice.fighterLockedWaiting',values));
          if(next.phase!==snapshot.phase)this.speakContext(next);
        }
        return;
      }
      if (isFighterAdvanceWord(spoken, this.commandLocale)) { this.advanceOrExplain(snapshot); return; }
      this.deps.say(this.t('voice.fighterUnknown', { prompt: this.t('voice.choiceFighter') })); return;
    }
    if (snapshot.phase === 'map_select') {
      if(!snapshot.automaticSetup&&!snapshot.isController){this.sayWaitOnce(this.t('voice.playerOneChoosingArena'));return;}
      const map = matchChoice(spoken, snapshot.maps, this.commandLocale);
      if (map) {
        this.applyingSelection=true;const selected=this.deps.selectMap(this.code!,this.playerId!,map.id);this.applyingSelection=false;
        this.deps.say(selected
          ? this.t(snapshot.automaticSetup?'voice.mapVote':'voice.mapSelected',{name:this.localizedMapName(map)})
          :this.t('voice.mapUnavailable',{name:this.localizedMapName(map)}));
        const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale);
        if(selected&&next&&next.phase!==snapshot.phase)this.speakContext(next);
        return;
      }
      if(isFighterAdvanceWord(spoken,this.commandLocale)||isFighterFightAlias(spoken,this.commandLocale)||isFighterStarAlias(spoken,this.commandLocale)){
        if(snapshot.automaticSetup)this.speakContext(snapshot);else this.advanceOrExplain(snapshot);return;
      }
      this.deps.say(this.t('voice.arenaUnknown', { prompt: this.t('voice.choiceArena') })); return;
    }
    if (snapshot.phase === 'fight') {
      const commands=matchFighterCommands(spoken,this.commandLocale);
      if(!commands.length)this.deps.say(this.t('voice.fightHelp'));
      for (const command of commands) this.deps.command(this.code!, this.playerId!, command);
      return;
    }
    if (isFighterAdvanceWord(spoken, this.commandLocale) || isFighterStarAlias(spoken, this.commandLocale)) {
      if(snapshot.phase==='results'&&this.stationManaged)this.deps.say(this.t('voice.waitOperator'));
      else this.advanceOrExplain(snapshot);
      return;
    }
    this.speakContext(snapshot);
  }

  onStateChanged(): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale); if (!snapshot) return;
    const lobbyReady=this.isLobbyReady(snapshot);
    if(this.applyingSelection||this.applyingName){
      this.lastPhase=snapshot.phase;this.lastFoeFighterId=snapshot.foeFighterId;this.lastFoeName=snapshot.foeName;
      this.lastLobbyReady=lobbyReady;return;
    }
    if (snapshot.phase === 'countdown') {
      const count = Math.ceil(snapshot.countdown ?? 0);
      if (count > 0 && count <= 3 && count !== this.lastCountdown) { this.lastCountdown = count; this.deps.say(String(count), this.phaseGuard('countdown')); }
    }
    if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS);
      if (stage !== this.lastIntroStage) { this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage); }
    } else this.lastIntroStage = null;
    if (snapshot.phase !== this.lastPhase) {
      this.lastWaitCue = '';
      if (snapshot.phase === 'map_select' && this.lastPhase === 'loading') this.deps.say(this.t('voice.arenaLoadFailed'));
      else if (snapshot.phase === 'intro') { /* synchronized segment cue emitted above */ }
      else this.speakContext(snapshot);
    } else if (snapshot.foeName && !this.isPlaceholderName(snapshot.foeName) && snapshot.foeName !== this.lastFoeName) {
      this.deps.say(snapshot.foeFighterName
        ? this.t('voice.opponentJoinedFighter', { name: snapshot.foeName, fighter: snapshot.foeFighterName })
        : this.t('voice.opponentJoined', { name: snapshot.foeName }));
    } else if (snapshot.phase === 'fighter_select' && !this.isPlaceholderName(snapshot.foeName) && snapshot.foeFighterId && snapshot.foeFighterId !== this.lastFoeFighterId) {
      const values = {
        name: snapshot.foeName ?? this.t('voice.opponentFallback'),
        fighter: snapshot.foeFighterName ?? this.t('voice.fighterFallback'),
      };
      this.deps.say(this.t('voice.opponentLocked',values));
    }
    if(snapshot.phase==='lobby'&&lobbyReady&&!this.lastLobbyReady)this.deps.say(this.t('voice.sayStart'));
    this.lastFoeFighterId = snapshot.foeFighterId;
    this.lastFoeName = snapshot.foeName;
    this.lastPhase = snapshot.phase;
    this.lastLobbyReady=lobbyReady;
  }

  onFighterEvent(event: FighterEvent): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale); if (!snapshot) return;
    if (event.type === 'hit' && Date.now() - this.lastCombatCueAt > 1200) {
      this.lastCombatCueAt = Date.now();
      const damage = formatNumber(this.commandLocale, event.damage);
      if (event.defender === snapshot.mySide) this.deps.say(event.blocked ? this.t('voice.selfBlocked') : this.t('voice.tookDamage', { damage }));
      else if (event.attacker === snapshot.mySide) this.deps.say(event.blocked ? this.t('voice.theyBlocked') : this.t('voice.hitDamage', { damage }));
    } else if (event.type === 'miss' && event.attacker === snapshot.mySide && Date.now() - this.lastCombatCueAt > 1200) {
      this.lastCombatCueAt = Date.now(); this.deps.say(this.t('voice.missed'));
    }
  }

  private finalContext(snapshot: FighterVoiceSnapshot | null): string {
    return `${snapshot?.phase??'unavailable'}:${snapshot?.myFighterId??''}:${snapshot?.myMapVote??''}`;
  }

  private crossedSelectionBoundary(before:string,after:string):boolean{
    return before.startsWith('lobby:')&&after.startsWith('fighter_select:')
      ||before.startsWith('fighter_select:')&&after.startsWith('map_select:')
      ||before.startsWith('map_select:')&&after.startsWith('loading:');
  }

  private advanceOrExplain(snapshot: FighterVoiceSnapshot): void {
    if(snapshot.automaticSetup&&['fighter_select','map_select'].includes(snapshot.phase)){this.speakContext(snapshot);return;}
    if (!this.authoritativeName&&this.isPlaceholderName(snapshot.myName) && snapshot.phase === 'lobby') { this.deps.say(this.t('voice.nameBeforeStart')); return; }
    if(snapshot.phase==='lobby'&&!this.hasExpectedPlayers(snapshot)){this.sayWaitOnce(this.t('voice.waitingLobbyPlayers'));return;}
    if (snapshot.phase === 'fighter_select' && !this.hasExpectedPlayers(snapshot)) { this.sayWaitOnce(this.t('voice.waitingPlayerTwo')); return; }
    if (!this.deps.advance(this.code!, this.playerId!)) {
      this.deps.say(this.t(snapshot.phase === 'fighter_select' ? 'voice.waitingFighterChoices'
        : snapshot.phase === 'map_select' ? 'voice.chooseArenaFirst'
          : snapshot.phase === 'victory' ? 'voice.victoryPlaying' : 'voice.roomNotReady'));
    }
  }

  private speakContext(snapshot: FighterVoiceSnapshot): void {
    const say=(text:string)=>this.deps.say(text,this.phaseGuard(snapshot.phase));
    if(this.awaitingName||(!this.authoritativeName&&!(snapshot.nameConfirmed??!this.isPlaceholderName(snapshot.myName)))){say(this.t('voice.tellName'));return;}
    if (snapshot.phase === 'lobby') {
      if (!this.authoritativeName&&this.isPlaceholderName(snapshot.myName)) say(this.t('voice.tellName'));
      else if(snapshot.automaticSetup&&!this.hasExpectedPlayers(snapshot))say(this.t('voice.waitingLobbyPlayers'));
      else say(this.t('voice.sayStart'));
    } else if (snapshot.phase === 'fighter_select') {
      if (snapshot.myFighterName) say(!this.hasExpectedPlayers(snapshot) ? this.t('voice.waitingPlayerTwo')
        :this.t(snapshot.automaticSetup?'voice.yourFighterWaiting':'voice.yourFighterNext',{name:snapshot.myFighterName}));
      else say(this.t('voice.choiceFighter'));
    } else if (snapshot.phase === 'map_select') {
      if(snapshot.automaticSetup&&snapshot.myMapVote){
        const choice=snapshot.maps.find(map=>map.id===snapshot.myMapVote);
        say(this.t('voice.mapVote',{name:choice?this.localizedMapName(choice):snapshot.myMapVote}));
      }else if(!snapshot.automaticSetup&&snapshot.selectedMap){
        const choice=snapshot.maps.find(map=>map.id===snapshot.selectedMap);
        say(this.t('voice.mapIsSelected',{name:choice?this.localizedMapName(choice):snapshot.selectedMap}));
      }else say(this.t('voice.choiceArena'));
    } else if (snapshot.phase === 'loading') say(this.t('voice.getReady'));
    else if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS); this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage);
    }
    else if (snapshot.phase === 'countdown') say(this.t('voice.getReady'));
    else if (snapshot.phase === 'fight') say(this.lastPhase === 'countdown' ? this.t('voice.fight')
      : this.t('voice.fightProgress', { health: formatNumber(this.commandLocale, snapshot.myHealth ?? 100) }));
    else if (snapshot.phase === 'victory') {
      say(snapshot.winnerSide === snapshot.mySide ? this.t('voice.youWin')
        : this.t('voice.winnerWins', { name: snapshot.winnerName ?? this.t('voice.winnerFallback') }));
    } else if (snapshot.phase === 'results') say(this.stationManaged
      ? this.t('voice.waitOperator')
      : this.t(snapshot.isController ? 'voice.controllerRematch' : 'voice.playerOneRematch'));
  }

  private speakIntroCue(snapshot: FighterVoiceSnapshot, stage: FighterIntroStage): void {
    const say = (text: string) => this.deps.say(text, this.phaseGuard('intro'));
    if (stage === 'p1') say(this.t('voice.introPlayerOne', {
      name: snapshot.playerOneName ?? this.t('voice.playerOneFallback'), fighter: snapshot.playerOneFighterName ?? this.t('voice.theirFighter'),
    }));
    else if (stage === 'versus') say(this.t('voice.versus'));
    else if (stage === 'p2') say(this.t('voice.introPlayerTwo', {
      name: snapshot.playerTwoName ?? this.t('voice.rivalFallback'), fighter: snapshot.playerTwoFighterName ?? this.t('voice.theirFighter'),
    }));
    else say(this.t('voice.fightersReady'));
  }

  private localizedMapName(map: { id: string; name: string }): string {
    const key = FIGHTER_MAP_NAME_KEYS[map.id];
    return key ? this.t(key) : map.name;
  }

  private isPlaceholderName(name: string | null): boolean {
    return !name || name === 'Caller' || name === 'Jogador';
  }

  private hasExpectedPlayers(snapshot: FighterVoiceSnapshot): boolean {
    return snapshot.hasExpectedPlayers ?? (this.stationAssignment
      ? snapshot.playerCount >= this.stationAssignment.expectedPlayers
      : true);
  }

  private isLobbyReady(snapshot:FighterVoiceSnapshot):boolean{
    return snapshot.phase==='lobby'&&this.hasExpectedPlayers(snapshot)
      &&(snapshot.nameConfirmed??!this.isPlaceholderName(snapshot.myName))
      &&(snapshot.playerCount<2||!this.isPlaceholderName(snapshot.foeName));
  }

  private resetInterim(): void { this.interimCandidate = null; this.interimCount = 0; this.interimFiredCommand = null; }
  private sayWaitOnce(message:string):void{if(message===this.lastWaitCue)return;this.lastWaitCue=message;this.deps.say(message);}
  private phaseGuard(expected:FighterPhase):()=>boolean{return()=>Boolean(this.code&&this.playerId)
    &&this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)?.phase===expected;}

  handleClose(): void {
    const preserve=this.stationManaged&&this.code&&this.playerId
      &&['victory','results'].includes(this.deps.snapshot(this.code,this.playerId,this.commandLocale)?.phase??'');
    if(this.code&&this.playerId&&!preserve)this.deps.leave(this.code,this.playerId,this.callSid??'');
    this.clear();
  }
  handleReplaced(): void { this.clear(); }
  private clear(): void { this.code = null; this.playerId = null; this.callSid = null; }
}

export function matchVoiceChoice(spoken: string, maps: { id: string; name: string }[], locale: SupportedLocale = DEFAULT_LOCALE): { id: string; name: string } | null {
  const text = normalizeForMatching(spoken, locale);
  const numberWords = locale === 'pt-BR'
    ? ['(?:um|uma)', '(?:dois|duas)', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze']
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const ordinals = locale === 'pt-BR'
    ? ['primeir[oa]', 'segund[oa]', 'terceir[oa]', 'quart[oa]', 'quint[oa]', 'sext[oa]', 'setim[oa]', 'oitav[oa]', 'non[oa]', 'decim[oa]']
    : ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
  const digit = text.match(/\b(1[0-2]|[1-9])\b/);
  const wordIndex = numberWords.findIndex(word => new RegExp(`\\b${word}\\b`).test(text));
  const compoundOrdinal = locale === 'pt-BR' ? text.match(/\bdecim[oa] (primeir[oa]|segund[oa])\b/) : null;
  const ordinalIndex = compoundOrdinal ? (compoundOrdinal[1]!.startsWith('primeir') ? 10 : 11)
    : ordinals.findIndex(word => new RegExp(`\\b${word}\\b`).test(text));
  const choiceIndex = digit ? Number(digit[1]) - 1 : ordinalIndex >= 0 ? ordinalIndex : wordIndex;
  if (choiceIndex >= 0 && maps[choiceIndex]) return maps[choiceIndex];
  return maps.find(map => containsChoicePhrase(text,normalizeForMatching(map.id,locale)) || containsChoicePhrase(text,normalizeForMatching(map.name,locale)))
    ?? maps.find(map => (VOICE_CHOICE_ALIASES[map.id] ?? []).some(alias => containsChoicePhrase(text,normalizeForMatching(alias,locale))))
    ?? maps.find(map => {
      const first = normalizeForMatching(map.name, locale).split(' ')[0];
      return first && text === first && maps.filter(candidate => normalizeForMatching(candidate.name, locale).split(' ')[0] === first).length === 1;
    })
    ?? (text.includes('neon') ? maps.find(map => map.id === 'foundry') : text.includes('circuit') ? maps.find(map => map.id === 'void') : null)
    ?? null;
}

const matchChoice = matchVoiceChoice;
function containsChoicePhrase(text:string,phrase:string):boolean{
  if(!phrase)return false;
  const escaped=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  return new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`).test(text);
}
const VOICE_CHOICE_ALIASES: Record<string, string[]> = {
  nyx: ['nix', 'nicks', 'nick'], wraith: ['wreath', 'raith', 'espectro'], 'remy-riot': ['remy', 'remi riot', 'remy revolta'],
  'cinder-capone': ['cinder', 'brasa capone'], 'rune-warden': ['rune', 'guardiao runico'], 'shroom-boom': ['shroom', 'mushroom', 'cogumelo bomba'],
  'gran-slam': ['grand slam', 'gran', 'vo pancada'], 'bass-nova': ['bass', 'grave nova'], 'velvet-thunder': ['velvet', 'trovao de veludo'],
  'iron-oni': ['iron', 'oni de ferro'], bulkhead: ['bulk head', 'blindado'], 'sir-knockout': ['knockout', 'sir nocaute'],
  foundry: ['fundição neon', 'fundicao neon'], void: ['circuito do vazio'],
  'cyberpunk-city': ['cidade cyberpunk'],
  inakaya: ['restaurante inakaya', 'inakaya restaurant', 'ina kaya', 'in a kaya', 'in akaya', 'innakaya', 'inikaya', 'izakaya'],
  rain: ['chuva'],
};
const FIGHTER_MAP_NAME_KEYS: Record<string, FighterMessageKey> = {
  foundry: 'content.mapName.foundry', void: 'content.mapName.void', 'cyberpunk-city': 'content.mapName.cyberpunk-city',
  inakaya: 'content.mapName.inakaya', rain: 'content.mapName.rain',
};

function isFighterAdvanceWord(spoken: string, locale: SupportedLocale): boolean {
  if (locale === 'en-US') return isEnglishAdvanceWord(spoken);
  const text = normalizeForMatching(spoken, locale);
  if (/\b(?:comecar|iniciar|avancar|proxim[oa]|continuar|lutar|luta|combater|pront[oa]|revanche|jogar de novo|jogar novamente|mais uma vez|sim)\b/.test(text)) return true;
  return /\b(?:escolher|escolha|selecionar|selecione)\b/.test(text) && /\b(?:lutador|personagem|campeao)\b/.test(text);
}

function isFighterFightAlias(spoken: string, locale: SupportedLocale): boolean {
  return locale === 'en-US' && /^(?:flight|fights)$/.test(normalizeForMatching(spoken, locale));
}

function isFighterStarAlias(spoken:string,locale:SupportedLocale):boolean{
  return locale==='en-US'&&normalizeForMatching(spoken,locale)==='star';
}

function parseFighterSpokenName(spoken: string, locale: SupportedLocale): string | null {
  return parseFirstName(spoken, locale);
}

function isExplicitName(spoken: string, locale: SupportedLocale): boolean {
  return isExplicitSpokenName(spoken, locale);
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:ajuda|instrucoes|o que posso dizer|onde estou|status)\b/.test(text)
    : /\b(?:help|instructions|what can i say|where am i|status)\b/.test(text);
}
