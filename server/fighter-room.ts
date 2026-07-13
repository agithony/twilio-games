import { applyFighterCommand, createFighterWorld, tickFighterWorld, type FighterCommand, type FighterEvent, type FighterId, type FighterWorld } from '../shared/fighter-world';
import { FIGHTER_MAPS, FIGHTER_ROSTER, type FighterMapEntry } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS, type FighterLobbyPlayer, type FighterPhase, type FighterState } from '../shared/fighter-protocol';

interface Player { playerId: string; name: string; fighterId: string | null; side: FighterId; }

export const FIGHTER_LOADING_TIMEOUT_SECONDS = 15;
export const FIGHTER_VICTORY_SECONDS = 10.5;

export class FighterRoom {
  phase: FighterPhase = 'lobby';
  private players: Player[] = [];
  private world: FighterWorld | null = null;
  private events: FighterEvent[] = [];
  private selectedMap: string | null = null;
  private nextPlayer = 1;
  private aiNext = 0;
  private aiFighterId: string | null = null;
  private countdown = 0;
  private intro = 0;
  private loadingElapsed = 0;
  private loadingGeneration = 0;
  private victory = 0;
  private rng: number;

  constructor(readonly code: string, seed = 0x12345678, private maps: FighterMapEntry[] = FIGHTER_MAPS) { this.rng = seed >>> 0; }
  setMaps(maps: FighterMapEntry[]): void { if (maps.length) this.maps = maps; }

  addPlayer(name: string): { playerId: string } | { error: string } {
    if (this.players.length >= 2 || !['lobby', 'fighter_select'].includes(this.phase)) return { error: 'room_full' };
    const side: FighterId = this.players.some(player => player.side === 'p1') ? 'p2' : 'p1';
    const player = { playerId: `f${this.nextPlayer++}`, name: cleanName(name), fighterId: null, side };
    this.players.push(player);
    return { playerId: player.playerId };
  }
  removePlayer(id: string): void {
    this.players = this.players.filter((player) => player.playerId !== id);
    if (!this.players.length) { this.phase = 'lobby'; this.world = null; this.selectedMap = null; this.aiFighterId = null; }
    else if (this.phase === 'loading' || this.phase === 'intro' || this.phase === 'fight' || this.phase === 'countdown' || this.phase === 'victory' || this.phase === 'results') {
      this.phase = 'fighter_select'; this.world = null; this.selectedMap = null; this.aiFighterId = null;
    }
  }
  setName(id: string, name: string): void { const player = this.players.find(p => p.playerId === id); if (player) player.name = cleanName(name); }
  selectFighter(id: string, fighterId: string): boolean {
    if (this.phase !== 'fighter_select' || !FIGHTER_ROSTER.some(f => f.id === fighterId)) return false;
    const player = this.players.find(p => p.playerId === id);
    if (!player || this.players.some(p => p !== player && p.fighterId === fighterId)) return false;
    player.fighterId = fighterId; return true;
  }
  nextUnselectedPlayerId(): string | null { return this.players.find(player => !player.fighterId)?.playerId ?? null; }
  selectMap(mapId: string): boolean {
    if (this.phase !== 'map_select' || !this.maps.some(map => map.id === mapId)) return false;
    this.selectedMap = mapId; return true;
  }
  advance(): boolean {
    if (this.phase === 'lobby' && this.players.length) { this.phase = 'fighter_select'; return true; }
    if (this.phase === 'fighter_select' && this.players.every(p => p.fighterId)) { this.phase = 'map_select'; return true; }
    if (this.phase === 'map_select' && this.selectedMap) {
      const bounds = this.maps.find(map => map.id === this.selectedMap)?.bounds ?? [-9, 9];
      if (this.players.length === 1) {
        const choices = FIGHTER_ROSTER.filter(fighter => fighter.id !== this.players[0]!.fighterId);
        this.aiFighterId = choices[Math.floor(this.random() * choices.length)]?.id ?? 'wraith';
      } else this.aiFighterId = null;
      this.phase = 'loading'; this.world = createFighterWorld(bounds); this.countdown = 0; this.aiNext = 0.8;
      this.loadingElapsed = 0; this.loadingGeneration++; return true;
    }
    if (this.phase === 'results') {
      this.phase = 'fighter_select'; this.world = null; this.selectedMap = null;
      this.aiFighterId = null;
      for (const player of this.players) player.fighterId = null;
      return true;
    }
    return false;
  }
  back(): boolean {
    if (this.phase === 'fighter_select') { this.phase = 'lobby'; return true; }
    if (this.phase === 'map_select') { this.phase = 'fighter_select'; this.selectedMap = null; return true; }
    if (this.phase === 'loading') { this.phase = 'map_select'; this.world = null; this.countdown = 0; this.loadingElapsed = 0; return true; }
    return false;
  }
  ready(generation?: number): boolean {
    if (this.phase !== 'loading' || (generation !== undefined && generation !== this.loadingGeneration)) return false;
    this.phase = 'intro'; this.intro = FIGHTER_INTRO_SECONDS; return true;
  }
  command(playerId: string, command: FighterCommand): FighterEvent[] {
    if (this.phase !== 'fight' || !this.world) return [];
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return [];
    const events = applyFighterCommand(this.world, player.side, command);
    this.events.push(...events); return events;
  }
  tick(delta: number): void {
    if (this.phase === 'loading') {
      this.loadingElapsed += delta;
      if (this.loadingElapsed >= FIGHTER_LOADING_TIMEOUT_SECONDS) {
        this.phase = 'map_select'; this.world = null; this.countdown = 0; this.loadingElapsed = 0;
      }
      return;
    }
    if (this.phase === 'intro') {
      this.intro = Math.max(0, this.intro - delta);
      if (this.intro === 0) { this.phase = 'countdown'; this.countdown = 6; }
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown = Math.max(0, this.countdown - delta);
      if (this.countdown === 0) this.phase = 'fight';
      return;
    }
    if (this.phase === 'victory') {
      this.victory = Math.max(0, this.victory - delta);
      if (this.victory === 0) this.phase = 'results';
      return;
    }
    if (this.phase !== 'fight' || !this.world) return;
    if (this.players.length === 1 && this.world.now >= this.aiNext) {
      const command = this.aiCommand();
      this.events.push(...applyFighterCommand(this.world, this.players[0]!.side === 'p1' ? 'p2' : 'p1', command));
      this.aiNext = this.world.now + 0.5 + this.random() * 0.55;
    }
    const resolved = tickFighterWorld(this.world, delta);
    this.events.push(...resolved);
    if (this.world.status === 'finished') { this.phase = 'victory'; this.victory = FIGHTER_VICTORY_SECONDS; }
  }
  drainEvents(): FighterEvent[] { const events = this.events; this.events = []; return events; }
  lobbyPlayers(): FighterLobbyPlayer[] {
    const rows = this.players.map((player): FighterLobbyPlayer => ({ ...player, isAi: false }));
    if (this.players.length === 1 && (this.phase === 'loading' || this.phase === 'intro' || this.phase === 'countdown' || this.phase === 'fight' || this.phase === 'victory' || this.phase === 'results')) {
      const chosen = this.players[0]!.fighterId;
      rows.push({ playerId: 'ai', name: 'Rival', fighterId: this.aiFighterId ?? FIGHTER_ROSTER.find(f => f.id !== chosen)?.id ?? 'wraith', side: this.players[0]!.side === 'p1' ? 'p2' : 'p1', isAi: true });
    }
    return rows;
  }
  state(): FighterState {
    const winner = this.world?.winner ?? null;
    return { roomCode: this.code, phase: this.phase, players: this.lobbyPlayers(), selectedMap: this.selectedMap,
      world: this.world, loadingGeneration: this.loadingGeneration, intro: this.phase === 'intro' ? this.intro : null,
      countdown: this.phase === 'countdown' ? this.countdown : null,
      result: winner ? { winner, winnerName: this.nameForSide(winner) } : null };
  }
  hasPlayer(id: string): boolean { return this.players.some(player => player.playerId === id); }
  canControlSetup(id: string): boolean { return this.players.find(player => player.playerId === id)?.side === 'p1'; }
  get isEmpty(): boolean { return this.players.length === 0; }

  private nameForSide(side: FighterId): string { return this.lobbyPlayers().find(p => p.side === side)?.name ?? 'Rival'; }
  private aiCommand(): FighterCommand {
    const world = this.world!;
    const distance = Math.abs(world.p1.x - world.p2.x);
    const roll = this.random();
    if (distance > 1.75) return 'forward';
    if (roll < 0.12) return 'jump';
    if (roll < 0.28) return 'block';
    if (roll < 0.65) return 'punch';
    if (roll < 0.92) return 'kick';
    return 'back';
  }
  private random(): number { this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0; return this.rng / 0x100000000; }
}

function cleanName(name: string): string { return name.trim().slice(0, 20) || 'Fighter'; }
