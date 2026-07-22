import { parseCrMessage } from './conversation-relay';
import { parseSpokenName as parseEnglishSpokenName, isAdvanceWord as isEnglishAdvanceWord } from './battle-voice';
import { matchFighterCommand, matchFighterCommands } from '../shared/fighter-intent';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';
import { FIGHTER_INTRO_SECONDS, fighterIntroStage, type FighterIntroStage, type FighterPhase } from '../shared/fighter-protocol';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { FIGHTER_MESSAGES, type FighterMessageKey } from '../shared/i18n/fighter';
import { createTranslator, formatNumber, normalizeForMatching } from '../shared/i18n/translate';

export interface FighterVoiceSnapshot {
  phase: FighterPhase;
  myName: string | null;
  myFighterId: string | null;
  myFighterName: string | null;
  foeName: string | null;
  foeFighterId: string | null;
  foeFighterName: string | null;
  selectedMap: string | null;
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
  allFightersSelected: boolean;
  isController: boolean;
  fighters: { id: string; name: string }[];
  maps: { id: string; name: string }[];
}
export interface FighterVoiceDeps {
  join(code: string, name: string, callSid: string): { playerId: string; resumed: boolean } | null;
  leave(code: string, id: string, callSid: string): void;
  setName(code: string, id: string, name: string): void;
  selectFighter(code: string, id: string, fighterId: string): boolean;
  selectMap(code: string, id: string, mapId: string): boolean;
  advance(code: string, id: string): boolean;
  command(code: string, id: string, command: FighterCommand): boolean;
  snapshot(code: string, id: string, locale?: SupportedLocale): FighterVoiceSnapshot | null;
  say(text: string): void;
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
  private interimSelectionId: string | null = null;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private t = createTranslator(this.commandLocale, FIGHTER_MESSAGES);
  constructor(private deps: FighterVoiceDeps) {}
  get locale(): SupportedLocale { return this.commandLocale; }

  handleMessage(raw: string): void {
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      const code = message.customParameters['roomCode']?.trim().toUpperCase(); if (!code || this.playerId) return;
      this.commandLocale = resolveLocale(message.customParameters['commandLocale'] ?? message.customParameters['locale']);
      this.t = createTranslator(this.commandLocale, FIGHTER_MESSAGES);
      const joined = this.deps.join(code, this.t('voice.callerPlaceholder'), message.callSid);
      if (!joined) { this.deps.say(this.t('voice.arenaFull')); return; }
      this.code = code; this.playerId = joined.playerId; this.callSid = message.callSid;
      const snapshot = this.deps.snapshot(code, joined.playerId, this.commandLocale); this.lastPhase = snapshot?.phase ?? null;
      this.lastFoeFighterId = snapshot?.foeFighterId ?? null;
      this.lastFoeName = snapshot?.foeName ?? null;
      if (joined.resumed && snapshot) {
        this.deps.say(!this.isPlaceholderName(snapshot.myName)
          ? this.t('voice.returnedName', { name: snapshot.myName ?? '' }) : this.t('voice.returned'));
        this.speakContext(snapshot);
      } else {
        this.deps.say(this.t('voice.welcome'));
      }
      return;
    }
    if (message.type === 'interrupt') { this.resetInterim(); return; }
    if (message.type === 'prompt' && this.code && this.playerId) {
      const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
      if (!message.last) {
        if (snapshot?.phase === 'fighter_select' || snapshot?.phase === 'map_select') {
          const choices = snapshot.phase === 'fighter_select' ? snapshot.fighters : snapshot.maps;
          const choice = matchChoice(message.voicePrompt, choices, this.commandLocale);
          if (choice && choice.id !== this.interimSelectionId) { this.interimSelectionId = choice.id; this.handleUtterance(message.voicePrompt); }
          return;
        }
        if (snapshot?.phase !== 'fight') return;
        const command = matchFighterCommand(message.voicePrompt, this.commandLocale);
        if (!command) { this.interimCandidate = null; this.interimCount = 0; return; }
        if (command === this.interimCandidate) this.interimCount += 1;
        else { this.interimCandidate = command; this.interimCount = 1; }
        // Two matching interim frames provide low latency without acting on one unstable ASR guess.
        if (this.interimCount >= 2 && !this.interimFiredCommand && this.deps.command(this.code, this.playerId, command)) this.interimFiredCommand = command;
        return;
      }
      if (this.interimSelectionId) {
        const choices = snapshot?.phase === 'fighter_select' ? snapshot.fighters : snapshot?.phase === 'map_select' ? snapshot.maps : [];
        const finalChoice = matchChoice(message.voicePrompt, choices, this.commandLocale);
        if (finalChoice?.id === this.interimSelectionId) { this.resetInterim(); return; }
      }
      if (this.interimFiredCommand) {
        const commands = matchFighterCommands(message.voicePrompt, this.commandLocale);
        if (commands[0] === this.interimFiredCommand) commands.shift();
        const correctedSingle = commands.length === 1 && commands[0] !== this.interimFiredCommand;
        this.resetInterim();
        if (!correctedSingle) for (const command of commands) this.deps.command(this.code, this.playerId, command);
        return;
      }
      this.resetInterim(); this.handleUtterance(message.voicePrompt);
    }
  }

  private handleUtterance(spoken: string): void {
    const snapshot = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale); if (!snapshot) return;
    const unnamed = this.isPlaceholderName(snapshot.myName);
    if (isHelpRequest(spoken, this.commandLocale)) {
      if (snapshot.phase === 'fight') this.deps.say(this.t('voice.fightHelp'));
      else this.speakContext(snapshot);
      return;
    }
    const phaseChoices = snapshot.phase === 'fighter_select' ? snapshot.fighters : snapshot.phase === 'map_select' ? snapshot.maps : [];
    const looksLikeChoice = phaseChoices.length > 0 && !!matchChoice(spoken, phaseChoices, this.commandLocale);
    if (unnamed && (snapshot.phase === 'lobby' || isExplicitName(spoken, this.commandLocale) || !looksLikeChoice)) {
      const name = parseFighterSpokenName(spoken, this.commandLocale);
      if (name && !isFighterAdvanceWord(spoken, this.commandLocale)) {
        this.deps.setName(this.code!, this.playerId!, name);
        const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale) ?? snapshot;
        if (next.phase === 'lobby') this.deps.say(this.t('voice.welcomeStart', { name }));
        else { this.deps.say(this.t('voice.welcomeName', { name })); this.speakContext(next); }
        return;
      }
    }
    if (snapshot.phase === 'fighter_select') {
      const fighter = matchChoice(spoken, snapshot.fighters, this.commandLocale);
      if (fighter) {
        if (!this.deps.selectFighter(this.code!, this.playerId!, fighter.id)) this.deps.say(this.t('voice.fighterUnavailable', { name: fighter.name }));
        else {
          const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale) ?? snapshot;
          const namePrompt = unnamed ? this.t('voice.namePromptSuffix') : '';
          const values = { name: fighter.name, namePrompt };
          if (!next.allFightersSelected) this.deps.say(this.t('voice.fighterLockedWaiting', values));
          else if (next.isController) this.deps.say(this.t('voice.fighterLockedNext', values));
          else this.deps.say(this.t('voice.fighterLockedPlayerOne', values));
        }
        return;
      }
      if (isFighterAdvanceWord(spoken, this.commandLocale)) { this.advanceOrExplain(snapshot); return; }
      this.deps.say(this.t('voice.fighterUnknown', { prompt: this.t('voice.choiceFighter') })); return;
    }
    if (snapshot.phase === 'map_select') {
      const map = matchChoice(spoken, snapshot.maps, this.commandLocale);
      if (map) {
        if (!snapshot.isController) this.deps.say(this.t('voice.playerOneArenaControl'));
        else this.deps.say(this.deps.selectMap(this.code!, this.playerId!, map.id)
          ? this.t('voice.mapSelected', { name: this.localizedMapName(map) }) : this.t('voice.mapUnavailable', { name: this.localizedMapName(map) }));
        return;
      }
      if (isFighterAdvanceWord(spoken, this.commandLocale)) { this.advanceOrExplain(snapshot); return; }
      this.deps.say(this.t('voice.arenaUnknown', { prompt: this.t('voice.choiceArena') })); return;
    }
    if (snapshot.phase === 'fight') {
      for (const command of matchFighterCommands(spoken, this.commandLocale)) this.deps.command(this.code!, this.playerId!, command);
      return;
    }
    if (isFighterAdvanceWord(spoken, this.commandLocale)) { this.advanceOrExplain(snapshot); return; }
    this.speakContext(snapshot);
  }

  onStateChanged(): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale); if (!snapshot) return;
    if (snapshot.phase === 'countdown') {
      const count = Math.ceil(snapshot.countdown ?? 0);
      if (count > 0 && count <= 3 && count !== this.lastCountdown) { this.lastCountdown = count; this.deps.say(String(count)); }
    }
    if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS);
      if (stage !== this.lastIntroStage) { this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage); }
    } else this.lastIntroStage = null;
    if (snapshot.phase !== this.lastPhase) {
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
      this.deps.say(this.t(snapshot.allFightersSelected && snapshot.isController ? 'voice.opponentLockedNext' : 'voice.opponentLocked', values));
    }
    this.lastFoeFighterId = snapshot.foeFighterId;
    this.lastFoeName = snapshot.foeName;
    this.lastPhase = snapshot.phase;
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

  private advanceOrExplain(snapshot: FighterVoiceSnapshot): void {
    if (!snapshot.isController) { this.deps.say(this.t('voice.sharedMenuControl')); return; }
    if (this.isPlaceholderName(snapshot.myName) && snapshot.phase === 'lobby') { this.deps.say(this.t('voice.nameBeforeStart')); return; }
    if (!this.deps.advance(this.code!, this.playerId!)) {
      this.deps.say(this.t(snapshot.phase === 'fighter_select' ? 'voice.waitingFighterChoices'
        : snapshot.phase === 'map_select' ? 'voice.chooseArenaFirst'
          : snapshot.phase === 'victory' ? 'voice.victoryPlaying' : 'voice.roomNotReady'));
    }
  }

  private speakContext(snapshot: FighterVoiceSnapshot): void {
    if (snapshot.phase === 'lobby') {
      if (this.isPlaceholderName(snapshot.myName)) this.deps.say(this.t('voice.tellName'));
      else if (snapshot.isController) this.deps.say(this.t('voice.sayStart'));
      else this.deps.say(this.t('voice.waitingPlayerOneStart'));
    } else if (snapshot.phase === 'fighter_select') {
      if (snapshot.myFighterName) this.deps.say(this.t(snapshot.allFightersSelected && snapshot.isController
        ? 'voice.yourFighterNext' : 'voice.yourFighterWaiting', { name: snapshot.myFighterName }));
      else this.deps.say(this.t('voice.choiceFighter'));
    } else if (snapshot.phase === 'map_select') {
      if (!snapshot.isController) this.deps.say(this.t('voice.playerOneChoosingArena'));
      else if (snapshot.selectedMap) {
        const choice = snapshot.maps.find(map => map.id === snapshot.selectedMap);
        this.deps.say(this.t('voice.mapIsSelected', { name: choice ? this.localizedMapName(choice) : snapshot.selectedMap }));
      }
      else this.deps.say(this.t('voice.choiceArena'));
    } else if (snapshot.phase === 'loading') return;
    else if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS); this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage);
    }
    else if (snapshot.phase === 'countdown') this.deps.say(this.t('voice.getReady'));
    else if (snapshot.phase === 'fight') this.deps.say(this.lastPhase === 'countdown' ? this.t('voice.fight')
      : this.t('voice.fightProgress', { health: formatNumber(this.commandLocale, snapshot.myHealth ?? 100) }));
    else if (snapshot.phase === 'victory') {
      this.deps.say(snapshot.winnerSide === snapshot.mySide ? this.t('voice.youWin')
        : this.t('voice.winnerWins', { name: snapshot.winnerName ?? this.t('voice.winnerFallback') }));
    } else if (snapshot.phase === 'results') this.deps.say(this.t(snapshot.isController ? 'voice.controllerRematch' : 'voice.playerOneRematch'));
  }

  private speakIntroCue(snapshot: FighterVoiceSnapshot, stage: FighterIntroStage): void {
    if (stage === 'p1') this.deps.say(this.t('voice.introPlayerOne', {
      name: snapshot.playerOneName ?? this.t('voice.playerOneFallback'), fighter: snapshot.playerOneFighterName ?? this.t('voice.theirFighter'),
    }));
    else if (stage === 'versus') this.deps.say(this.t('voice.versus'));
    else if (stage === 'p2') this.deps.say(this.t('voice.introPlayerTwo', {
      name: snapshot.playerTwoName ?? this.t('voice.rivalFallback'), fighter: snapshot.playerTwoFighterName ?? this.t('voice.theirFighter'),
    }));
    else this.deps.say(this.t('voice.fightersReady'));
  }

  private localizedMapName(map: { id: string; name: string }): string {
    const key = FIGHTER_MAP_NAME_KEYS[map.id];
    return key ? this.t(key) : map.name;
  }

  private isPlaceholderName(name: string | null): boolean {
    return !name || name === 'Caller' || name === 'Jogador';
  }

  private resetInterim(): void { this.interimCandidate = null; this.interimCount = 0; this.interimFiredCommand = null; this.interimSelectionId = null; }

  handleClose(): void { if (this.code && this.playerId) this.deps.leave(this.code, this.playerId, this.callSid ?? ''); this.clear(); }
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
  return maps.find(map => text.includes(normalizeForMatching(map.id, locale)) || text.includes(normalizeForMatching(map.name, locale)))
    ?? maps.find(map => (VOICE_CHOICE_ALIASES[map.id] ?? []).some(alias => text.includes(normalizeForMatching(alias, locale))))
    ?? maps.find(map => {
      const first = normalizeForMatching(map.name, locale).split(' ')[0];
      return first && text === first && maps.filter(candidate => normalizeForMatching(candidate.name, locale).split(' ')[0] === first).length === 1;
    })
    ?? (text.includes('neon') ? maps.find(map => map.id === 'foundry') : text.includes('circuit') ? maps.find(map => map.id === 'void') : null)
    ?? null;
}

const matchChoice = matchVoiceChoice;
const VOICE_CHOICE_ALIASES: Record<string, string[]> = {
  nyx: ['nix', 'nicks', 'nick'], wraith: ['wreath', 'raith', 'espectro'], 'remy-riot': ['remy', 'remi riot', 'remy revolta'],
  'cinder-capone': ['cinder', 'brasa capone'], 'rune-warden': ['rune', 'guardiao runico'], 'shroom-boom': ['shroom', 'mushroom', 'cogumelo bomba'],
  'gran-slam': ['grand slam', 'gran', 'vo pancada'], 'bass-nova': ['bass', 'grave nova'], 'velvet-thunder': ['velvet', 'trovao de veludo'],
  'iron-oni': ['iron', 'oni de ferro'], bulkhead: ['bulk head', 'blindado'], 'sir-knockout': ['knockout', 'sir nocaute'],
  foundry: ['fundição neon', 'fundicao neon'], void: ['circuito do vazio'],
  'cyberpunk-city': ['cidade cyberpunk'], inakaya: ['restaurante inakaya'], rain: ['chuva'],
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

function parseFighterSpokenName(spoken: string, locale: SupportedLocale): string | null {
  if (locale === 'en-US') return parseEnglishSpokenName(spoken);
  let text = spoken.trim().replace(/[.!?,]+$/u, '');
  if (!text || /[?]/.test(spoken) || isFighterAdvanceWord(text, locale) || isHelpRequest(text, locale)) return null;
  text = text.replace(/^(?:meu nome (?:é|e)|eu sou|sou|me chamo|chame-me de|pode me chamar de)\s+/iu, '');
  const words = text.match(/\p{L}[\p{L}'’-]*/gu)?.slice(0, 2) ?? [];
  if (!words.length) return null;
  const name = words.map(word => word[0]!.toLocaleUpperCase(locale) + word.slice(1).toLocaleLowerCase(locale)).join(' ');
  return name.length >= 2 && name.length <= 20 ? name : null;
}

function isExplicitName(spoken: string, locale: SupportedLocale): boolean {
  return locale === 'pt-BR'
    ? /^(?:meu nome (?:é|e)|eu sou|sou|me chamo|chame-me de|pode me chamar de)(?:\s|$)/iu.test(spoken.trim())
    : /^(?:my name is|i am|i'm|call me)\b/i.test(spoken.trim());
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:ajuda|instrucoes|o que posso dizer|onde estou|status)\b/.test(text)
    : /\b(?:help|instructions|what can i say|where am i|status)\b/.test(text);
}
