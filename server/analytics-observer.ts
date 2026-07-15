import type { Room } from './room';
import type { BattleRoom } from './battle-room';
import type { FighterRoom } from './fighter-room';
import { AnalyticsStore } from './analytics-store';

interface ActiveMatch {
  key: string;
  startedAt: number;
  participants: string[];
  map?: string | null;
  characters: string[];
}

export class AnalyticsObserver {
  private racerActive = new Map<string, ActiveMatch>();
  private battleActive = new Map<string, ActiveMatch>();
  private fighterActive = new Map<string, ActiveMatch>();

  constructor(private readonly store: AnalyticsStore, private readonly now: () => number = Date.now) {}

  raceStarted(room: Room): void {
    this.racerActive.set(room.code, { key: String(this.now()), startedAt: this.now(),
      participants: room.lobbyPlayers().map(player => `racer:${room.code}:${player.playerId}`), map: room.selectedMap,
      characters: room.lobbyPlayers().map(player => room.carName(player.carIndex ?? 0)) });
  }

  raceFinished(room: Room): void {
    const results = room.results(); if (!results.length) return;
    const active = this.racerActive.get(room.code);
    const duration = active ? (this.now() - active.startedAt) / 1000 : Math.max(0, ...results.map(result => result.finishT));
    this.store.recordMatch({ game: 'racer', participantIds: active?.participants ?? results.map(result => `racer:${room.code}:${result.playerId}`),
      durationSeconds: duration, completed: results.some(result => result.finished), map: room.selectedMap,
      vehicles: results.map(result => room.carName(result.carIndex)), at: this.now() });
    this.racerActive.delete(room.code);
  }

  raceAbandoned(room: Room): void {
    const active = this.racerActive.get(room.code); if (!active) return;
    this.store.recordMatch({ game: 'racer', participantIds: active.participants,
      durationSeconds: (this.now() - active.startedAt) / 1000, completed: false, map: active.map,
      vehicles: active.characters, at: this.now() });
    this.racerActive.delete(room.code);
  }

  battleState(room: BattleRoom): void {
    const active = this.battleActive.get(room.code);
    if (room.phase === 'battle' && (!active || active.key !== String(room.generation))) {
      if (active) this.finish('monsters', room.code, active, false);
      const players = room.lobbyPlayers().filter(player => !player.isAi);
      const snapshot = room.snapshot();
      this.battleActive.set(room.code, { key: String(room.generation), startedAt: this.now(),
        participants: players.map(player => `monsters:${room.code}:${player.playerId}`),
        characters: [snapshot?.a.monsterId, snapshot?.b.monsterId].filter((id): id is string => Boolean(id)) });
      return;
    }
    if (!active || room.phase === 'battle') return;
    this.finish('monsters', room.code, active, room.phase === 'results');
  }

  fighterState(room: FighterRoom): void {
    const state = room.state(); const active = this.fighterActive.get(room.code);
    if (state.phase === 'fight' && (!active || active.key !== String(state.loadingGeneration))) {
      if (active) this.finish('fighter', room.code, active, false);
      const players = state.players.filter(player => !player.isAi);
      this.fighterActive.set(room.code, { key: String(state.loadingGeneration), startedAt: this.now(),
        participants: players.map(player => `fighter:${room.code}:${player.playerId}`), map: state.selectedMap,
        characters: state.players.map(player => player.fighterId).filter((id): id is string => Boolean(id)) });
      return;
    }
    if (!active || state.phase === 'fight') return;
    this.finish('fighter', room.code, active, state.phase === 'victory' || state.phase === 'results');
  }

  voiceCommand(game: 'racer' | 'monsters' | 'fighter'): void { this.store.recordVoiceCommand(game, this.now()); }

  private finish(game: 'monsters' | 'fighter', roomCode: string, match: ActiveMatch, completed: boolean): void {
    this.store.recordMatch({ game, participantIds: match.participants, durationSeconds: (this.now() - match.startedAt) / 1000,
      completed, map: match.map, characters: match.characters, at: this.now() });
    (game === 'monsters' ? this.battleActive : this.fighterActive).delete(roomCode);
  }
}
