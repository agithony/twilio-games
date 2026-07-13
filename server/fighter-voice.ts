import { parseCrMessage } from './conversation-relay';
import { parseSpokenName, isAdvanceWord } from './battle-voice';
import { matchFighterCommand } from '../shared/fighter-intent';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';
import { FIGHTER_INTRO_SECONDS, fighterIntroStage, type FighterIntroStage, type FighterPhase } from '../shared/fighter-protocol';

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
  snapshot(code: string, id: string): FighterVoiceSnapshot | null;
  say(text: string): void;
}

export class FighterVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  private callSid: string | null = null;
  private lastPhase: FighterPhase | null = null;
  private lastCountdown = -1;
  private lastFoeFighterId: string | null = null;
  private lastFoeName: string | null = null;
  private lastCombatCueAt = 0;
  private lastIntroStage: FighterIntroStage | null = null;
  private interimCandidate: FighterCommand | null = null;
  private interimCount = 0;
  private interimFired = false;
  constructor(private deps: FighterVoiceDeps) {}

  handleMessage(raw: string): void {
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      const code = message.customParameters['roomCode']?.trim().toUpperCase(); if (!code || this.playerId) return;
      const joined = this.deps.join(code, 'Caller', message.callSid);
      if (!joined) { this.deps.say('This Voice Fighter arena is full. Please wait for the next match.'); return; }
      this.code = code; this.playerId = joined.playerId; this.callSid = message.callSid;
      const snapshot = this.deps.snapshot(code, joined.playerId); this.lastPhase = snapshot?.phase ?? null;
      this.lastFoeFighterId = snapshot?.foeFighterId ?? null;
      this.lastFoeName = snapshot?.foeName ?? null;
      if (joined.resumed && snapshot) {
        this.deps.say(`You're back${snapshot.myName && snapshot.myName !== 'Caller' ? `, ${snapshot.myName}` : ''}.`);
        this.speakContext(snapshot);
      } else {
        this.deps.say('Welcome to Voice Fighter, powered by Twilio Conversation Relay. Reduce your rival to zero health. During the fight, say forward, back, jump, punch, kick, or block. First, what is your name?');
      }
      return;
    }
    if (message.type === 'prompt' && this.code && this.playerId) {
      const snapshot = this.deps.snapshot(this.code, this.playerId);
      if (!message.last) {
        if (snapshot?.phase !== 'fight') return;
        const command = matchFighterCommand(message.voicePrompt);
        if (!command) { this.interimCandidate = null; this.interimCount = 0; return; }
        if (command === this.interimCandidate) this.interimCount += 1;
        else { this.interimCandidate = command; this.interimCount = 1; }
        // Two matching interim frames provide low latency without acting on one unstable ASR guess.
        if (this.interimCount >= 2 && !this.interimFired && this.deps.command(this.code, this.playerId, command)) this.interimFired = true;
        return;
      }
      if (this.interimFired) { this.resetInterim(); return; }
      this.resetInterim(); this.handleUtterance(message.voicePrompt);
    }
  }

  private handleUtterance(spoken: string): void {
    const snapshot = this.deps.snapshot(this.code!, this.playerId!); if (!snapshot) return;
    const unnamed = !snapshot.myName || snapshot.myName === 'Caller';
    if (isHelpRequest(spoken)) { this.speakContext(snapshot); return; }
    if (unnamed && (snapshot.phase === 'lobby' || isExplicitName(spoken))) {
      const name = parseSpokenName(spoken);
      if (name && !isAdvanceWord(spoken)) {
        this.deps.setName(this.code!, this.playerId!, name);
        const next = this.deps.snapshot(this.code!, this.playerId!) ?? snapshot;
        if (next.phase === 'lobby') this.deps.say(`Welcome, ${name}. Say start when you are ready to choose fighters.`);
        else { this.deps.say(`Welcome, ${name}.`); this.speakContext(next); }
        return;
      }
    }
    if (snapshot.phase === 'fighter_select') {
      const fighter = matchChoice(spoken, snapshot.fighters);
      if (fighter) {
        if (!this.deps.selectFighter(this.code!, this.playerId!, fighter.id)) this.deps.say(`${fighter.name} is unavailable. Choose another fighter.`);
        else {
          const next = this.deps.snapshot(this.code!, this.playerId!) ?? snapshot;
          const namePrompt = unnamed ? ' Tell me your name by saying, my name is, followed by your name.' : '';
          if (!next.allFightersSelected) this.deps.say(`${fighter.name} locked in. Waiting for the other player.${namePrompt}`);
          else if (next.isController) this.deps.say(`${fighter.name} locked in. Say next to choose the arena.${namePrompt}`);
          else this.deps.say(`${fighter.name} locked in. Player one will choose the arena.${namePrompt}`);
        }
        return;
      }
      if (isAdvanceWord(spoken)) { this.advanceOrExplain(snapshot); return; }
      this.deps.say(`I didn't recognize that fighter. ${choicePrompt('fighter')}`); return;
    }
    if (snapshot.phase === 'map_select') {
      const map = matchChoice(spoken, snapshot.maps);
      if (map) {
        if (!snapshot.isController) this.deps.say('Player one controls the arena choice. Please wait for the match to start.');
        else this.deps.say(this.deps.selectMap(this.code!, this.playerId!, map.id) ? `${map.name} selected. Say fight to begin.` : `${map.name} is unavailable.`);
        return;
      }
      if (isAdvanceWord(spoken)) { this.advanceOrExplain(snapshot); return; }
      this.deps.say(`I didn't recognize that arena. ${choicePrompt('arena')}`); return;
    }
    if (snapshot.phase === 'fight') {
      const command = matchFighterCommand(spoken);
      if (command) this.deps.command(this.code!, this.playerId!, command);
      return;
    }
    if (isAdvanceWord(spoken)) { this.advanceOrExplain(snapshot); return; }
    this.speakContext(snapshot);
  }

  onStateChanged(): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId); if (!snapshot) return;
    if (snapshot.phase === 'countdown') {
      const count = Math.ceil(snapshot.countdown ?? 0);
      if (count > 0 && count <= 3 && count !== this.lastCountdown) { this.lastCountdown = count; this.deps.say(String(count)); }
    }
    if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS);
      if (stage !== this.lastIntroStage) { this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage); }
    } else this.lastIntroStage = null;
    if (snapshot.phase !== this.lastPhase) {
      if (snapshot.phase === 'map_select' && this.lastPhase === 'loading') this.deps.say('The arena failed to load. Choose another map.');
      else if (snapshot.phase === 'intro') { /* synchronized segment cue emitted above */ }
      else this.speakContext(snapshot);
    } else if (snapshot.foeName && snapshot.foeName !== 'Caller' && snapshot.foeName !== this.lastFoeName) {
      this.deps.say(`${snapshot.foeName} joined as your opponent${snapshot.foeFighterName ? ` and locked in ${snapshot.foeFighterName}` : ''}.`);
    } else if (snapshot.phase === 'fighter_select' && snapshot.foeName !== 'Caller' && snapshot.foeFighterId && snapshot.foeFighterId !== this.lastFoeFighterId) {
      this.deps.say(`${snapshot.foeName ?? 'Your opponent'} locked in ${snapshot.foeFighterName ?? 'a fighter'}.${snapshot.allFightersSelected && snapshot.isController ? ' Say next to choose the arena.' : ''}`);
    }
    this.lastFoeFighterId = snapshot.foeFighterId;
    this.lastFoeName = snapshot.foeName;
    this.lastPhase = snapshot.phase;
  }

  onFighterEvent(event: FighterEvent): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId); if (!snapshot) return;
    if (event.type === 'hit' && Date.now() - this.lastCombatCueAt > 1200) {
      this.lastCombatCueAt = Date.now();
      if (event.defender === snapshot.mySide) this.deps.say(event.blocked ? 'Blocked.' : `You took ${event.damage}.`);
      else if (event.attacker === snapshot.mySide) this.deps.say(event.blocked ? 'They blocked.' : `Hit for ${event.damage}.`);
    } else if (event.type === 'miss' && event.attacker === snapshot.mySide && Date.now() - this.lastCombatCueAt > 1200) {
      this.lastCombatCueAt = Date.now(); this.deps.say('Missed. Move closer.');
    }
  }

  private advanceOrExplain(snapshot: FighterVoiceSnapshot): void {
    if (!snapshot.isController) { this.deps.say('Player one controls the shared menu. Please wait for the next screen.'); return; }
    if ((!snapshot.myName || snapshot.myName === 'Caller') && snapshot.phase === 'lobby') { this.deps.say('Tell me your name before we start.'); return; }
    if (!this.deps.advance(this.code!, this.playerId!)) {
      this.deps.say(snapshot.phase === 'fighter_select' ? 'Waiting for every player to choose a fighter.'
        : snapshot.phase === 'map_select' ? 'Choose an arena before starting.'
          : snapshot.phase === 'victory' ? 'The victory celebration is still playing.' : 'The room is not ready yet.');
    }
  }

  private speakContext(snapshot: FighterVoiceSnapshot): void {
    if (snapshot.phase === 'lobby') {
      if (!snapshot.myName || snapshot.myName === 'Caller') this.deps.say('Tell me your name.');
      else if (snapshot.isController) this.deps.say('Say start to choose fighters.');
      else this.deps.say('Waiting for player one to start fighter selection.');
    } else if (snapshot.phase === 'fighter_select') {
      if (snapshot.myFighterName) this.deps.say(`${snapshot.myFighterName} is your fighter.${snapshot.allFightersSelected && snapshot.isController ? ' Say next to choose the arena.' : ' Waiting for the other player.'}`);
      else this.deps.say(choicePrompt('fighter'));
    } else if (snapshot.phase === 'map_select') {
      if (!snapshot.isController) this.deps.say('Player one is choosing the arena.');
      else if (snapshot.selectedMap) this.deps.say(`${choiceName(snapshot.selectedMap, snapshot.maps)} is selected. Say fight to begin.`);
      else this.deps.say(choicePrompt('arena'));
    } else if (snapshot.phase === 'loading') return;
    else if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS); this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage);
    }
    else if (snapshot.phase === 'countdown') this.deps.say('Get ready. The fight starts after the countdown.');
    else if (snapshot.phase === 'fight') this.deps.say(this.lastPhase === 'countdown' ? 'Fight!' : `Fight in progress. You have ${snapshot.myHealth ?? 100} health.`);
    else if (snapshot.phase === 'victory') {
      const outcome = snapshot.winnerSide === snapshot.mySide ? 'You win!' : `${snapshot.winnerName ?? 'The winner'} wins.`;
      this.deps.say(`${outcome} Victory!`);
    } else if (snapshot.phase === 'results') this.deps.say(snapshot.isController ? 'Say rematch to play again.' : 'Player one can start the rematch.');
  }

  private speakIntroCue(snapshot: FighterVoiceSnapshot, stage: FighterIntroStage): void {
    if (stage === 'p1') this.deps.say(`Player one, ${snapshot.playerOneName ?? 'Player one'}, as ${snapshot.playerOneFighterName ?? 'their fighter'}.`);
    else if (stage === 'versus') this.deps.say('Versus.');
    else if (stage === 'p2') this.deps.say(`Player two, ${snapshot.playerTwoName ?? 'the rival'}, as ${snapshot.playerTwoFighterName ?? 'their fighter'}.`);
    else this.deps.say('Fighters ready.');
  }

  private resetInterim(): void { this.interimCandidate = null; this.interimCount = 0; this.interimFired = false; }

  handleClose(): void { if (this.code && this.playerId) this.deps.leave(this.code, this.playerId, this.callSid ?? ''); this.clear(); }
  handleReplaced(): void { this.clear(); }
  private clear(): void { this.code = null; this.playerId = null; this.callSid = null; }
}

export function matchVoiceChoice(spoken: string, maps: { id: string; name: string }[]): { id: string; name: string } | null {
  const text = normalize(spoken);
  const numberWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
  const digit = text.match(/\b(1[0-2]|[1-9])\b/);
  const wordIndex = numberWords.findIndex(word => new RegExp(`\\b${word}\\b`).test(text));
  const ordinalIndex = ordinals.findIndex(word => new RegExp(`\\b${word}\\b`).test(text));
  const choiceIndex = digit ? Number(digit[1]) - 1 : ordinalIndex >= 0 ? ordinalIndex : wordIndex;
  if (choiceIndex >= 0 && maps[choiceIndex]) return maps[choiceIndex];
  return maps.find(map => text.includes(normalize(map.id)) || text.includes(normalize(map.name)))
    ?? (text.includes('neon') ? maps.find(map => map.id === 'foundry') : text.includes('circuit') ? maps.find(map => map.id === 'void') : null)
    ?? null;
}

const matchChoice = matchVoiceChoice;
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const isExplicitName = (spoken: string) => /^(?:my name is|i am|i'm|call me)\b/i.test(spoken.trim());
const isHelpRequest = (spoken: string) => /\b(?:help|instructions|what can i say|where am i|status)\b/i.test(spoken);
function choicePrompt(kind: string): string { return `Choose your ${kind}. Say the name or number shown on screen.`; }
function choiceName(id: string, choices: { id: string; name: string }[]): string { return choices.find(choice => choice.id === id)?.name ?? id; }
