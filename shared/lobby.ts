// Pure lobby / character-select / map-select state machine — the front-end flow before a race,
// modeled on Super Smash Bros. Phases: lobby (players join) → car_select (each picks a car from the
// grid) → map_select (pick the level) → (race starts). It owns ONLY selection state; the actual
// race lives in RaceWorld. Kept pure (no I/O, no THREE, no ws) so it's fully unit-testable and the
// server's Room just delegates to it. See [[lobby-character-select-vision]].

/** Where the room is in the pre-race flow. ('countdown'/'racing'/'finished' belong to RaceWorld.) */
export type LobbyPhase = 'lobby' | 'car_select' | 'map_select';

export interface LobbySlot {
  id: string;
  name: string;
  color: string;
  /** Index into the car manifest the player claimed, or null until they pick. */
  carIndex: number | null;
  /** True once the player has locked a car in (car_select). */
  ready: boolean;
}

/** What RaceWorld needs per player, plus the chosen car model index for the renderer. */
export interface RaceInit { id: string; name: string; color: string; carIndex: number; }

export interface LobbyOptions {
  /** Number of selectable cars (manifest car count) — bounds valid carIndex. */
  carCount: number;
  /** Valid map keys for map_select. */
  maps: string[];
}

const ORDER: LobbyPhase[] = ['lobby', 'car_select', 'map_select'];

export class Lobby {
  private _phase: LobbyPhase = 'lobby';
  private slots: LobbySlot[] = [];
  private _map: string | null = null;
  /** Per-player map VOTES (playerId → map name). The winning map is the most-voted; ties are broken
   *  deterministically (seeded by the vote set) so all clients agree. Multiple players → a vote. */
  private _mapVotes = new Map<string, string>();
  private readonly carCount: number;
  private readonly maps: string[];

  constructor(opts: LobbyOptions) {
    this.carCount = Math.max(0, Math.floor(opts.carCount));
    this.maps = [...opts.maps];
  }

  get phase(): LobbyPhase { return this._phase; }
  get selectedMap(): string | null { return this._map; }
  get mapChoices(): string[] { return [...this.maps]; }
  players(): LobbySlot[] { return this.slots.map(s => ({ ...s })); }
  get playerCount(): number { return this.slots.length; }

  addPlayer(id: string, name: string, color: string, preferredIndex?: number): void {
    if (this.slots.some(s => s.id === id)) return;
    const slot = { id, name, color, carIndex: null, ready: false };
    if (preferredIndex === undefined) this.slots.push(slot);
    else this.slots.splice(Math.max(0, Math.min(this.slots.length, preferredIndex)), 0, slot);
  }

  removePlayer(id: string): void {
    this.slots = this.slots.filter(s => s.id !== id);
  }

  /** Rename / recolor an existing slot (e.g. concierge fills in the name after a bare join). */
  setPlayerInfo(id: string, info: { name?: string; color?: string }): void {
    const s = this.slots.find(x => x.id === id); if (!s) return;
    if (info.name !== undefined) s.name = info.name;
    if (info.color !== undefined) s.color = info.color;
  }

  /** A player claims a car by manifest index. Valid during car_select AND map_select (so a player
   *  who joined late — after the host advanced — can still lock in, instead of wedging canStart()).
   *  In range only. Locks ready. */
  selectCar(id: string, carIndex: number): void {
    if (this._phase !== 'car_select' && this._phase !== 'map_select') return;
    if (!Number.isInteger(carIndex) || carIndex < 0 || carIndex >= this.carCount) return;
    const s = this.slots.find(x => x.id === id); if (!s) return;
    s.carIndex = carIndex; s.ready = true;
  }

  /** Cast a player's VOTE for a track (voterId identifies who — defaults to a shared 'host' bucket for
   *  the display/keyboard path). Only valid during map_select + a known map. The selected map is
   *  recomputed as the vote winner. A voter changing their mind replaces their prior vote. */
  selectMap(map: string, voterId = 'host'): void {
    if (this._phase !== 'map_select') return;
    if (!this.maps.includes(map)) return;
    this._mapVotes.set(voterId, map);
    this._map = this.computeVoteWinner();
  }

  /** Vote tally per map (only maps with ≥1 vote), for the UI to show live vote counts. */
  mapVoteCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const m of this._mapVotes.values()) counts[m] = (counts[m] ?? 0) + 1;
    return counts;
  }
  /** True when the current winner is a TIE resolved by random pick (UI surfaces this to players). */
  get mapWinnerIsTie(): boolean {
    const counts = this.mapVoteCounts();
    const vals = Object.values(counts);
    if (vals.length < 2) return false;
    const max = Math.max(...vals);
    return vals.filter(v => v === max).length > 1;
  }

  /** The most-voted map. Tie → a deterministic pick among the leaders (seeded by the sorted tied
   *  names so every client computes the SAME winner without shared RNG). Null if no votes. */
  private computeVoteWinner(): string | null {
    const counts = this.mapVoteCounts();
    const entries = Object.entries(counts);
    if (entries.length === 0) return null;
    const max = Math.max(...entries.map(([, c]) => c));
    const leaders = entries.filter(([, c]) => c === max).map(([m]) => m).sort();
    if (leaders.length === 1) return leaders[0]!;
    // Deterministic tie-break: hash the tied names (order-independent via sort) → index into leaders.
    let h = 0; for (const ch of leaders.join('|')) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return leaders[Math.abs(h) % leaders.length]!;
  }

  /** Every joined player has locked a car. */
  allPicked(): boolean {
    return this.slots.length > 0 && this.slots.every(s => s.carIndex !== null);
  }

  /** At least one player has locked a car — enough to leave car_select (idle players get the
   *  toRaceInits() join-index fallback, so a single AFK player can't wedge the room forever). */
  anyPicked(): boolean {
    return this.slots.some(s => s.carIndex !== null);
  }

  /** Advance one phase if its gate is satisfied; otherwise no-op (stays put). */
  advance(): void {
    if (this._phase === 'lobby') {
      if (this.slots.length > 0) this._phase = 'car_select';
    } else if (this._phase === 'car_select') {
      // Progress once SOMEONE has picked — unpicked players fall back in toRaceInits(). Requiring
      // EVERY player would let one idle phone caller wedge car_select indefinitely.
      if (this.anyPicked()) this._phase = 'map_select';
    }
    // map_select is the last pre-race phase; starting the race is the server's job (canStart()).
  }

  /** Step the phase backward (host "back" button); clamps at lobby. Leaving map_select DE-ARMS the
   *  map so a re-pick of cars can't silently start on a stale map. */
  back(): void {
    const i = ORDER.indexOf(this._phase);
    if (i > 0) {
      if (this._phase === 'map_select') { this._map = null; this._mapVotes.clear(); }
      this._phase = ORDER[i - 1]!;
    }
  }

  /** Ready to kick off the race: in map_select, at least one car picked (rest fall back), map chosen.
   *  Uses anyPicked (not allPicked) for the same reason advance() does — no AFK-player wedge. */
  canStart(): boolean {
    return this._phase === 'map_select' && this.anyPicked() && this._map !== null;
  }

  /** Build the per-player race inits; an unpicked car falls back to join-index (mod carCount). */
  toRaceInits(): RaceInit[] {
    return this.slots.map((s, i) => ({
      id: s.id, name: s.name, color: s.color,
      carIndex: s.carIndex ?? (this.carCount > 0 ? i % this.carCount : 0),
    }));
  }

  /** Return to a fresh lobby for the same players (clear cars/ready/map). */
  reset(): void {
    this._phase = 'lobby';
    this._map = null;
    this._mapVotes.clear();
    for (const s of this.slots) { s.carIndex = null; s.ready = false; }
  }
}
