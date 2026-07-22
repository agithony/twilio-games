// Server-side game room for Voice Monsters: lobby → monster_select → battle → results. Wraps the pure
// BattleWorld and owns joining, per-player monster picks, single-player (1 human vs AI) vs 2-player,
// and the AI's auto-responses. Mirrors Room's public shape so the GameServer wiring is familiar. No
// ws/http here — fully unit-testable.
import { BattleWorld, type BattleSnapshot, type BattleEvent, type Side, type BattleAction } from '../shared/battle-world';
import { ROSTER, monsterById, type Monster } from '../shared/monster-roster';
import { pickAiAction } from '../shared/battle-ai';
import { Rng } from '../shared/rng';
import { dwellForEvent, HANDOFF_PAUSE_MS } from '../shared/battle-timing';

export type BattlePhase = 'lobby' | 'monster_select' | 'battle' | 'results';

interface Slot { id: string; name: string; monsterId: string | null; isAi: boolean; }

/** Roster row for the lobby / monster-select screens. */
export interface BattlePlayer { playerId: string; name: string; monsterId: string | null; isAi: boolean; }

export interface BattleResult { winner: Side; winnerName: string; }

const AI_ID = 'cpu';
const AI_NAME = 'Rival';

export class BattleRoom {
  readonly code: string;
  private seed: number;
  private _phase: BattlePhase = 'lobby';
  private slots: Slot[] = [];       // human players (max 2)
  private nextId = 1;
  private world: BattleWorld | null = null;
  private ai: { side: Side; monster: Monster } | null = null;   // set in single-player battles
  private _result: BattleResult | null = null;
  private events: BattleEvent[] = [];
  private aiRng: Rng;
  private menu: Record<Side, 'root' | 'fight'> = { a: 'root', b: 'root' };
  private active: Side | null = null;
  private battleGeneration = 0;
  private resultsReadyAt = 0;
  private presentationReadyAt = 0;
  private lastPresentedActionSide: Side | null = null;

  constructor(code: string, seed: number) {
    this.code = code;
    this.seed = seed >>> 0;
    this.aiRng = new Rng(this.seed ^ 0x5bd1e995);
  }

  get phase(): BattlePhase { return this._phase; }
  get playerCount(): number { return this.slots.length; }
  get isEmpty(): boolean { return this.slots.length === 0; }
  get generation(): number { return this.battleGeneration; }
  get canRematch(): boolean { return this._phase === 'results' && Date.now() >= this.resultsReadyAt; }
  get rematchReadyInMs(): number { return this._phase === 'results' ? Math.max(0, this.resultsReadyAt - Date.now()) : 0; }

  /** Roster for the shared-display lobby + monster-select screens. */
  lobbyPlayers(): BattlePlayer[] {
    return this.slots.map(s => ({ playerId: s.id, name: s.name, monsterId: s.monsterId, isAi: s.isAi }));
  }

  participantResults(): Array<{
    enginePlayerId: string;
    rank: number | null;
    completed: boolean;
    won: boolean | null;
    score: number | null;
    durationSeconds: number | null;
  }> {
    if (this._phase !== 'results' || !this._result) return [];
    const winnerIndex = this._result.winner === 'a' ? 0 : 1;
    return this.slots.map((slot, index) => ({
      enginePlayerId: slot.id,
      rank: index === winnerIndex ? 1 : 2,
      completed: true,
      won: index === winnerIndex,
      score: null,
      durationSeconds: null,
    }));
  }

  /** Add a human player. Battles are 1v1, so at most 2 humans. A late second player may join while
   *  results remain visible, but the finished battle stays intact until an explicit rematch. */
  addPlayer(name: string): { playerId: string } | { error: string } {
    if (this._phase === 'results' && this.slots.length >= 2) return { error: 'room_full' };
    if (this._phase === 'battle' && this.slots.length >= 2) return { error: 'battle_in_progress' };
    if (this.slots.length >= 2) return { error: 'room_full' };
    const id = `p${this.nextId++}`;
    this.slots.push({ id, name: name || `Player ${this.slots.length + 1}`, monsterId: null, isAi: false });
    return { playerId: id };
  }

  removePlayer(playerId: string): void {
    const wasInBattle = this.isBattleParticipant(playerId);
    this.slots = this.slots.filter(s => s.id !== playerId);
    if (this.slots.length === 0 && this._phase !== 'lobby') this.reset();
    else if (wasInBattle && this._phase === 'battle') this.interruptBattle();
  }

  setPlayerInfo(playerId: string, info: { name?: string }): void {
    const s = this.slots.find(x => x.id === playerId);
    if (s && info.name) s.name = info.name.slice(0, 20);
  }

  /** Pick a monster during monster_select (validated against the roster). */
  selectMonster(playerId: string, monsterId: string): void {
    if (this._phase !== 'monster_select') return;
    if (!monsterById(monsterId)) return;
    const s = this.slots.find(x => x.id === playerId);
    if (s) s.monsterId = monsterId;
  }

  /** Host advances the flow: lobby → monster_select → battle. From results, "advance" = rematch
   *  (keep the roster, back to monster_select). Starting the battle fills an AI opponent when solo. */
  advance(): void {
    if (this._phase === 'results') {
      if (!this.canRematch) return;
      this.world = null; this.ai = null; this._result = null;
      this.resultsReadyAt = 0;
      this.presentationReadyAt = 0;
      this.lastPresentedActionSide = null;
      for (const s of this.slots) s.monsterId = null;
      this._phase = 'monster_select';
      return;
    }
    if (this._phase === 'lobby') {
      if (this.slots.length > 0) this._phase = 'monster_select';
      return;
    }
    if (this._phase === 'monster_select' && this.canStart()) this.start();
  }

  back(): void {
    if (this._phase === 'monster_select') this._phase = 'lobby';
  }

  /** Ready to battle when at least one human has picked a monster (the 2nd side is the other human
   *  if present + picked, else an AI). */
  private canStart(): boolean {
    const picked = this.slots.filter(s => s.monsterId);
    if (this.slots.length >= 2) return this.slots.every(s => s.monsterId);   // 2P: both must pick
    return picked.length === 1;                                              // 1P: the human picked
  }

  private start(): void {
    const humans = this.slots.filter(s => s.monsterId);
    const a = humans[0]!;
    let bId: string, bName: string, bMonster: string;
    if (this.slots.length >= 2) {
      const b = this.slots[1]!.id === a.id ? this.slots[0]! : this.slots.find(s => s.id !== a.id)!;
      bId = b.id; bName = b.name; bMonster = b.monsterId!;
    } else {
      // Single-player: AI opponent gets a random DIFFERENT monster.
      bId = AI_ID; bName = AI_NAME; bMonster = this.pickAiMonster(a.monsterId!);
      this.ai = { side: 'b', monster: monsterById(bMonster)! };
    }
    this.world = new BattleWorld(
      { id: a.id, name: a.name, monsterId: a.monsterId! },
      { id: bId, name: bName, monsterId: bMonster },
      this.seed,
    );
    this.menu = { a: 'root', b: 'root' };
    this.active = this.ai?.side === 'a' ? 'b' : 'a';
    this.battleGeneration++;
    this.resultsReadyAt = 0;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    this._phase = 'battle';
    this.captureEvents();
  }

  private pickAiMonster(avoid: string): string {
    const pool = ROSTER.filter(m => m.id !== avoid);
    return pool[this.aiRng.int(pool.length)]!.id;
  }

  /** A player chooses a move. The active monster's action resolves immediately, then the room advances
   *  to the other side so the next phone prompt/screen menu is unambiguous. */
  chooseMove(playerId: string, moveId: string): boolean {
    if (this._phase !== 'battle' || !this.world) return false;
    if (!this.canChoose(playerId)) return false;
    if (!this.world.takeAction(playerId, { kind: 'fight', moveId })) return false;
    this.resetMenuFor(playerId);
    this.captureEvents();
    this.advanceActiveSide();
    return true;
  }

  /** A player commits a turn ACTION (fight/guard/item/taunt). Same resolution rules as chooseMove. */
  chooseAction(playerId: string, action: BattleAction): boolean {
    if (this._phase !== 'battle' || !this.world) return false;
    if (!this.canChoose(playerId)) return false;
    if (!this.world.takeAction(playerId, action)) return false;
    this.resetMenuFor(playerId);
    this.captureEvents();
    this.advanceActiveSide();
    return true;
  }

  /** The side whose command we are currently waiting for. In 2P this makes the phone UX sequential:
   *  side A opens the turn, then side B responds, alternating who starts each new turn. In single-player
   *  the human always opens the battle so the deferred AI beat can answer after the human acts. */
  activeSide(): Side | null {
    if (this._phase !== 'battle' || !this.world) return null;
    const s = this.world.snapshot();
    if (s.phase !== 'choosing') return null;
    return this.active;
  }

  activeMenu(): 'root' | 'fight' {
    const side = this.activeSide();
    return side ? this.menu[side] : 'root';
  }

  openFightMenu(playerId: string): void {
    const side = this.sideOfPlayer(playerId);
    if (side && this.activeSide() === side) this.menu[side] = 'fight';
  }

  backMenu(playerId: string): void {
    const side = this.sideOfPlayer(playerId);
    if (side && this.activeSide() === side) this.menu[side] = 'root';
  }

  /** True when it's single-player, we're mid-battle, and the active side is the AI. The server polls
   *  this after a human action to schedule the deferred AI beat. */
  aiPending(): boolean {
    if (!this.ai || this._phase !== 'battle' || !this.world) return false;
    if (this.world.phase !== 'choosing') return false;
    const s = this.world.snapshot();
    return this.activeSide() === this.ai.side;
  }

  /** Commit the AI's ACTION (type-aware: mostly FIGHT, but ITEM/GUARD/TAUNT when the situation calls
   *  for it) → resolves the turn. Called by the server after a short delay so the CPU takes a visible,
   *  separate turn. No-op if the AI doesn't owe a move. */
  resolveAiTurn(): void {
    if (!this.aiPending() || !this.ai || !this.world) return;
    const s = this.world.snapshot();
    const self = this.ai.side === 'b' ? s.b : s.a;         // the AI's own live state (hp / potions)
    const oppState = this.ai.side === 'b' ? s.a : s.b;
    const potionsLeft = this.ai.side === 'b' ? s.potions.b : s.potions.a;
    const action = pickAiAction(
      this.ai.monster, self.hp, self.maxHp,
      monsterById(oppState.monsterId)!, potionsLeft, this.aiRng,
    );
    this.world.takeAction(self.id, action);
    this.menu = { a: 'root', b: 'root' };
    this.captureEvents();
    this.advanceActiveSide();
  }

  /** Pull resolution events out of the world into the room's queue + detect battle end. */
  private captureEvents(): void {
    if (!this.world) return;
    const fresh = this.world.drainEvents();
    this.events.push(...fresh);
    if (fresh.length) {
      let firstActionSide: Side | null = null;
      let lastActionSide: Side | null = null;
      for (const ev of fresh) {
        const side = sideForActionEvent(ev);
        if (side) { firstActionSide ??= side; lastActionSide = side; }
      }
      const handoff = firstActionSide && this.lastPresentedActionSide && firstActionSide !== this.lastPresentedActionSide
        ? HANDOFF_PAUSE_MS : 0;
      this.presentationReadyAt = Math.max(Date.now(), this.presentationReadyAt)
        + handoff + fresh.reduce((ms, ev) => ms + dwellForEvent(ev), 0);
      if (lastActionSide) this.lastPresentedActionSide = lastActionSide;
    }
    const snap = this.world.snapshot();
    if (this.world.phase === 'finished' && this._phase === 'battle') {
      const winnerSide = snap.winner!;
      const winnerName = winnerSide === 'a' ? snap.a.name : snap.b.name;
      this._result = { winner: winnerSide, winnerName };
      this.active = null;
      this._phase = 'results';
      this.resultsReadyAt = this.presentationReadyAt;
    }
  }

  reset(): void {
    this.world = null; this.ai = null; this._result = null; this.events = [];
    this.menu = { a: 'root', b: 'root' };
    this.active = null;
    this.resultsReadyAt = 0;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    for (const s of this.slots) s.monsterId = null;
    this._phase = 'lobby';
  }

  snapshot(): BattleSnapshot | null { return this.world ? this.world.snapshot() : null; }
  result(): BattleResult | null { return this._result; }

  /** Drain queued battle events (renderer + commentator consume them; drained once). */
  drainEvents(): BattleEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private sideOfPlayer(playerId: string): Side | null {
    const snap = this.world?.snapshot();
    if (!snap) return null;
    if (snap.a.id === playerId) return 'a';
    if (snap.b.id === playerId) return 'b';
    return null;
  }

  private isBattleParticipant(playerId: string): boolean {
    const snap = this.world?.snapshot();
    return !!snap && (snap.a.id === playerId || snap.b.id === playerId);
  }

  private interruptBattle(): void {
    this.world = null; this.ai = null; this._result = null; this.events = [];
    this.menu = { a: 'root', b: 'root' };
    this.active = null;
    this.resultsReadyAt = 0;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    this._phase = this.slots.length > 0 ? 'monster_select' : 'lobby';
  }

  private canChoose(playerId: string): boolean {
    const side = this.sideOfPlayer(playerId);
    return !!side && this.activeSide() === side;
  }

  private resetMenuFor(playerId: string): void {
    const side = this.sideOfPlayer(playerId);
    if (side) this.menu[side] = 'root';
  }

  private advanceActiveSide(): void {
    if (this._phase !== 'battle' || !this.world) return;
    const snap = this.world.snapshot();
    if (snap.phase !== 'choosing') { this.active = null; return; }
    this.active = this.active === 'a' ? 'b' : 'a';
    this.menu = { a: 'root', b: 'root' };
  }
}

function sideForActionEvent(ev: BattleEvent): Side | null {
  return ev.kind === 'move_used' || ev.kind === 'guard' || ev.kind === 'item' || ev.kind === 'taunt'
    ? ev.by : null;
}
