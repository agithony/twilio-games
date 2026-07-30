import { applyFighterCommand, createFighterWorld, tickFighterWorld, type FighterCommand, type FighterEvent, type FighterId, type FighterWorld } from '../shared/fighter-world';
import { FIGHTER_MAPS, FIGHTER_ROSTER, type FighterMapEntry } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS, type FighterLobbyPlayer, type FighterPhase, type FighterState } from '../shared/fighter-protocol';

interface Player { playerId: string; name: string; nameConfirmed: boolean; fighterId: string | null; side: FighterId; }

export const FIGHTER_LOADING_TIMEOUT_SECONDS = 115;
export const FIGHTER_VICTORY_SECONDS = 10.5;
const MAX_VOICE_COMMAND_QUEUE = 12;

export class FighterRoom {
  phase: FighterPhase = 'lobby';
  private players: Player[] = [];
  private world: FighterWorld | null = null;
  private events: FighterEvent[] = [];
  private selectedMap: string | null = null;
  private mapVotes=new Map<string,string>();
  private nextPlayer = 1;
  private aiNext = 0;
  private aiFighterId: string | null = null;
  private countdown = 0;
  private intro = 0;
  private loadingElapsed = 0;
  private loadingGeneration = 0;
  private victory = 0;
  private voiceCommands = new Map<string, FighterCommand[]>();
  private expectedHumanPlayers = 1;
  private automaticSetup=false;
  private fixedExpectedHumanPlayers=false;
  private rng: number;

  constructor(readonly code: string, seed = 0x12345678, private maps: FighterMapEntry[] = FIGHTER_MAPS) { this.rng = seed >>> 0; }
  setMaps(maps: FighterMapEntry[]): void { if (maps.length) this.maps = maps; }

  addPlayer(name: string, preferredSide?: FighterId, nameConfirmed = true): { playerId: string } | { error: string } {
    if (this.players.length >= 2 || !['lobby', 'fighter_select'].includes(this.phase)) return { error: 'room_full' };
    const side: FighterId = preferredSide ?? (this.players.some(player => player.side === 'p1') ? 'p2' : 'p1');
    if (this.players.some(player => player.side === side)) return { error: 'room_full' };
    const player = { playerId: `f${this.nextPlayer++}`, name: cleanName(name), nameConfirmed, fighterId: null, side };
    this.players.push(player);this.players.sort((left,right)=>left.side.localeCompare(right.side));this.reconcileSetup();
    if (!nameConfirmed && this.phase === 'fighter_select') this.phase = 'lobby';
    return { playerId: player.playerId };
  }
  expectHumanPlayers(count: number, fixed = true): void {
    this.expectedHumanPlayers = count >= 2 ? 2 : 1;
    if (fixed) this.fixedExpectedHumanPlayers = true;
    this.automaticSetup=true;
    if (this.expectedHumanPlayers === 1 && this.players.length === 1
      && (this.phase === 'lobby' || this.phase === 'fighter_select' || this.phase === 'map_select')) {
      this.players[0]!.side = 'p1';
    }
    this.reconcileSetup();
  }
  removePlayer(id: string): void {
    this.players = this.players.filter((player) => player.playerId !== id);
    this.mapVotes.delete(id);if(this.phase==='map_select')this.selectedMap=this.mapVoteWinner();
    this.voiceCommands.delete(id);
    if (!this.players.length) { this.phase = 'lobby'; this.world = null; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId = null;this.automaticSetup=false;this.expectedHumanPlayers=1;this.fixedExpectedHumanPlayers=false; }
    else {
      if(!this.fixedExpectedHumanPlayers)this.expectedHumanPlayers=this.players.length;
      if(this.phase==='map_select'&&this.players.length<this.expectedHumanPlayers){
        this.phase='fighter_select';this.selectedMap=null;
      }
      else if (this.phase === 'loading' || this.phase === 'intro' || this.phase === 'fight' || this.phase === 'countdown' || this.phase === 'victory') {
        this.phase = 'fighter_select'; this.world = null; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId = null;
      }
    }
    this.reconcileSetup();
  }
  setName(id: string, name: string): void { const player = this.players.find(p => p.playerId === id); if (player) { player.name = cleanName(name);player.nameConfirmed=true;this.reconcileSetup(); } }
  hasConfirmedName(id:string):boolean{return this.players.find(player=>player.playerId===id)?.nameConfirmed===true;}
  selectFighter(id: string, fighterId: string): boolean {
    if (this.phase !== 'fighter_select' || !FIGHTER_ROSTER.some(f => f.id === fighterId)) return false;
    const player = this.players.find(p => p.playerId === id);
    if (!player || this.players.some(p => p !== player && p.fighterId === fighterId)) return false;
    player.fighterId=fighterId;this.reconcileSetup();return true;
  }
  nextUnselectedPlayerId(): string | null { return this.players.find(player => !player.fighterId)?.playerId ?? null; }
  selectMap(playerId:string,mapId: string): boolean {
    if (this.phase !== 'map_select' || !this.maps.some(map => map.id === mapId)) return false;
    if(!this.players.some(player=>player.playerId===playerId))return false;
    this.mapVotes.set(playerId,mapId);this.selectedMap=this.mapVoteWinner();this.reconcileSetup();return true;
  }
  advance(): boolean {
    if(this.automaticSetup&&this.phase!=='results')return false;
    if (this.phase === 'lobby' && this.players.length && this.players.every(player=>player.nameConfirmed)) { this.phase = 'fighter_select'; return true; }
    if (this.phase === 'fighter_select' && this.players.length >= this.expectedHumanPlayers && this.players.every(p => p.fighterId)) { this.phase = 'map_select'; return true; }
    if (this.phase === 'map_select' && this.selectedMap && this.players.length >= this.expectedHumanPlayers)return this.beginLoading();
    if (this.phase === 'results') {
      this.phase = 'fighter_select'; this.world = null; this.selectedMap = null;this.mapVotes.clear();
      this.aiFighterId = null;
      for (const player of this.players) player.fighterId = null;
      return true;
    }
    return false;
  }
  back(): boolean {
    if(this.automaticSetup)return false;
    if (this.phase === 'fighter_select') { this.phase = 'lobby'; return true; }
    if (this.phase === 'map_select') { this.phase = 'fighter_select'; this.selectedMap = null;this.mapVotes.clear();return true; }
    if (this.phase === 'loading') { this.phase = 'map_select'; this.world = null; this.countdown = 0; this.loadingElapsed = 0; return true; }
    return false;
  }
  ready(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGeneration) return false;
    this.phase = 'intro'; this.intro = FIGHTER_INTRO_SECONDS; return true;
  }
  retryLoading(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGeneration) return false;
    this.loadingElapsed = 0;
    this.loadingGeneration += 1;
    return true;
  }
  command(playerId: string, command: FighterCommand): FighterEvent[] {
    if (this.phase !== 'fight' || !this.world) return [];
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return [];
    const events = applyFighterCommand(this.world, player.side, command);
    this.events.push(...events); return events;
  }
  voiceCommand(playerId: string, command: FighterCommand): boolean {
    const events = this.command(playerId, command); if (events.length) return true;
    if (this.phase !== 'fight' || !this.world || !this.hasPlayer(playerId)) return false;
    const queued = this.voiceCommands.get(playerId) ?? [];
    if (queued.length >= MAX_VOICE_COMMAND_QUEUE) return false;
    queued.push(command); this.voiceCommands.set(playerId, queued); return true;
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
    if (this.world.status === 'fighting') {
      for (const [playerId, queued] of this.voiceCommands) {
        const next = queued[0]; if (!next) { this.voiceCommands.delete(playerId); continue; }
        const events = this.command(playerId, next);
        if (events.length) queued.shift();
        if (!queued.length) this.voiceCommands.delete(playerId);
      }
    } else this.voiceCommands.clear();
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
      mapVotesByPlayerId:Object.fromEntries(this.mapVotes),
      world:this.world,expectedPlayerCount:this.expectedHumanPlayers,hasExpectedPlayers:this.hasExpectedPlayers,automaticSetup:this.automaticSetup,
      loadingGeneration: this.loadingGeneration, intro: this.phase === 'intro' ? this.intro : null,
      countdown: this.phase === 'countdown' ? this.countdown : null,
      result: winner ? { winner, winnerName: this.nameForSide(winner) } : null };
  }
  hasPlayer(id: string): boolean { return this.players.some(player => player.playerId === id); }
  canControlSetup(id: string): boolean { return this.hasPlayer(id); }
  get playerCount(): number { return this.players.length; }
  get expectedPlayerCount(): number { return this.expectedHumanPlayers; }
  get hasExpectedPlayers(): boolean { return this.players.length >= this.expectedHumanPlayers; }
  get isEmpty(): boolean { return this.players.length === 0; }

  private nameForSide(side: FighterId): string { return this.lobbyPlayers().find(p => p.side === side)?.name ?? 'Rival'; }
  private reconcileSetup():void {
    if(!this.automaticSetup||this.players.length<this.expectedHumanPlayers||!this.players.every(player=>player.nameConfirmed))return;
    if(this.phase==='lobby')this.phase='fighter_select';
    if(this.phase==='fighter_select'&&this.players.every(player=>player.fighterId)){
      this.phase='map_select';this.selectedMap=this.mapVoteWinner();
    }
    if(this.phase==='map_select'&&this.players.every(player=>this.mapVotes.has(player.playerId)))this.beginLoading();
  }
  private mapVoteWinner():string|null {
    const counts=new Map<string,number>();
    for(const mapId of this.mapVotes.values())counts.set(mapId,(counts.get(mapId)??0)+1);
    const ranked=[...counts].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]));
    return ranked[0]?.[0]??null;
  }
  private beginLoading():boolean {
    if(!this.selectedMap)return false;
    const bounds=this.maps.find(map=>map.id===this.selectedMap)?.bounds??[-9,9];
    if(this.players.length===1){
      const choices=FIGHTER_ROSTER.filter(fighter=>fighter.id!==this.players[0]!.fighterId);
      this.aiFighterId=choices[Math.floor(this.random()*choices.length)]?.id??'wraith';
    }else this.aiFighterId=null;
    this.phase='loading';this.world=createFighterWorld(bounds);this.voiceCommands.clear();this.countdown=0;this.aiNext=0.8;
    this.loadingElapsed=0;this.loadingGeneration++;return true;
  }
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
