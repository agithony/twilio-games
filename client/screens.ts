// Big-screen front-end for the shared display: the AAA, Twilio-branded menu flow — lobby (PRESS
// START), car-select GRID, map-select, and the post-race results scoreboard. One full-screen GLASS
// overlay that sits on top of the live attract-mode 3D behind it, re-rendered from the server's
// lobby / select_state / results messages. Players act by TEXTING (concierge/SMS) or, on the host
// display, keyboard. Presentation only — styling lives in racer.css; this builds the markup + wires
// host keys. See [[lobby-character-select-vision]].
import type { LobbyPlayer, RaceResult } from '../shared/types';

/** One row of the persistent global leaderboard (best all-time times). */
export interface GlobalEntry { name: string; map: string; carIndex: number; finishT: number; at: number }

export interface ScreensCallbacks {
  onAdvance(): void;   // host Enter / → : advance a phase or start the race
  onBack(): void;      // host ← : step a phase backward
}

const BUG = '/brand/Twilio_Logo_Bug_White.svg';
const PLACE_LABEL = (p: number) => p === 1 ? '1st' : p === 2 ? '2nd' : p === 3 ? '3rd' : `${p}th`;
const PLACE_COLOR = ['var(--gold)', 'var(--silver)', 'var(--bronze)'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** Defense-in-depth: only let an obvious CSS color literal into a style attribute (server also
 *  sanitizes; never trust a single layer for values that land in style="..."). */
const cssColor = (c: string, fallback = '#888') =>
  /^(#[0-9a-fA-F]{3,8}|rgb\([\d,\s]+\)|hsl\([\d,%\s]+\))$/.test(c?.trim?.() ?? '') ? c.trim() : fallback;

export class Screens {
  private root: HTMLElement;
  private carNames: string[] = [];
  private carThumbs: string[] = [];
  private mapPreviews: Record<string, string> = {};
  private visible = false;
  private phase: 'lobby' | 'car_select' | 'map_select' | 'results' | null = null;
  /** Signature of the last rendered state. The server re-broadcasts the roster ~2x/s; rebuilding
   *  innerHTML each time replays the CSS entrance animations → the "flicker" the user saw. We skip
   *  the rebuild when nothing meaningful changed. */
  private lastKey = '';

  constructor(host: HTMLElement, private cb: ScreensCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'screens';
    host.appendChild(this.root);
  }

  /** Stable, order-sensitive fingerprint of the roster for the dedup guard. */
  private rosterKey(players: LobbyPlayer[]): string {
    return players.map(p => `${p.playerId}:${p.name}:${p.color}:${p.carIndex}:${p.ready ? 1 : 0}`).join('|');
  }
  /** True if this exact view was already rendered (skip the rebuild). Stores the new key otherwise. */
  private unchanged(key: string): boolean {
    if (key === this.lastKey) return true;
    this.lastKey = key;
    return false;
  }

  setCarCatalog(names: string[], thumbs: string[]): void {
    this.carNames = names; this.carThumbs = thumbs.length ? thumbs : this.carThumbs;
    if (this.visible && this.phase === 'car_select') this.rerenderCarSelect(true);   // names changed
  }
  /** Progressive thumbnails: a portrait finished — store it and live-swap that tile's <img> (no
   *  rebuild, so no animation replay). Only rebuilds if the tile isn't in the DOM yet. */
  setCarThumb(i: number, url: string): void {
    if (!url) return;
    this.carThumbs[i] = url;
    const img = this.root.querySelector(`img[data-car-thumb="${i}"]`);
    if (img instanceof HTMLImageElement) { img.src = url; img.style.opacity = '1'; }
    else if (this.visible && this.phase === 'car_select') this.rerenderCarSelect(true);
  }
  setMapPreviews(previews: Record<string, string>): void { this.mapPreviews = previews; }

  show(): void {
    this.visible = true; this.root.style.display = 'flex';
    document.body.classList.add('in-menu');
    this.root.classList.remove('is-race');
  }
  hide(): void {
    this.visible = false; this.root.style.display = 'none'; this.phase = null;
    this.lastKey = '';   // re-entering a screen later should render fresh
    document.body.classList.remove('in-menu');
  }
  get isVisible(): boolean { return this.visible; }

  // ── Lobby ──────────────────────────────────────────────────────────────────────────────────────
  renderLobby(roomCode: string, players: LobbyPlayer[]): void {
    this.show(); this.phase = 'lobby';
    if (this.unchanged(`lobby:${roomCode}:${this.rosterKey(players)}`)) return;
    const n = players.length;
    this.root.innerHTML = `
      ${this.head('Lobby', `${n} ${n === 1 ? 'racer' : 'racers'} in the room`)}
      <div class="scr-center">
        <div class="lobby-code">${esc(roomCode)}</div>
        <div class="lobby-join">Text <span class="num">${esc(roomCode)}</span> to join the race</div>
        ${this.chips(players)}
        <div class="scr-foot"><span class="key">ENTER</span> to choose cars</div>
      </div>`;
  }

  // ── Car select — the SSB grid ────────────────────────────────────────────────────────────────
  renderCarSelect(players: LobbyPlayer[]): void {
    this.show(); this.phase = 'car_select'; this.lastPlayers = players;
    this.rerenderCarSelect();
  }
  private lastPlayers: LobbyPlayer[] = [];
  private rerenderCarSelect(force = false): void {
    const players = this.lastPlayers;
    // Dedup on roster + car-name count (names arrive after first paint). Thumbnails stream in via
    // setCarThumb's in-place <img> swap, so they don't need a full rebuild. force=true bypasses
    // (used when the catalog/names change and the grid must be rebuilt).
    if (!force && this.unchanged(`cars:${this.carNames.length}:${this.rosterKey(players)}`)) return;
    const claims = new Map<number, LobbyPlayer[]>();
    for (const p of players) if (p.carIndex !== null) {
      const a = claims.get(p.carIndex) ?? []; a.push(p); claims.set(p.carIndex, a);
    }
    const allReady = players.length > 0 && players.every(p => p.ready);
    const tiles = this.carNames.map((nm, i) => this.carTile(i, nm, claims.get(i) ?? [])).join('');
    this.root.innerHTML = `
      ${this.head('Choose Your Ride', allReady ? 'All locked in — ready to roll' : 'Text a car number to lock in')}
      ${this.chips(players)}
      <div class="scr-body"><div class="grid">${tiles}</div></div>
      <div class="scr-foot"><span class="key">←</span> back ·
        <span>${allReady ? '<span class="key">ENTER</span> pick the track' : 'waiting for all players to lock in'}</span></div>`;
  }

  private carTile(i: number, name: string, claimedBy: LobbyPlayer[]): string {
    const claimed = claimedBy.length > 0;
    const claim = claimed ? cssColor(claimedBy[0]!.color) : '';
    const url = this.carThumbs[i];
    const portrait = url
      ? `<div class="portrait"><img data-car-thumb="${i}" src="${url}" alt="" style="opacity:1"></div>`
      : `<div class="portrait"><img data-car-thumb="${i}" alt="" style="opacity:0"><span class="ph" data-ph="${i}">CAR ${i + 1}</span></div>`;
    const badges = claimedBy.map(p =>
      `<span class="badge" style="background:${cssColor(p.color)}">${esc(p.name)}</span>`).join('');
    return `
      <div class="tile${claimed ? ' claimed' : ''}"${claimed ? ` style="--claim:${claim}"` : ''}>
        <div class="num">${i + 1}</div>
        ${portrait}
        <div class="cname">${esc(name)}</div>
        <div class="badges">${badges}</div>
      </div>`;
  }

  // ── Map select ───────────────────────────────────────────────────────────────────────────────
  renderMapSelect(maps: string[], selectedMap: string | null, players: LobbyPlayer[]): void {
    this.show(); this.phase = 'map_select';
    if (this.unchanged(`map:${selectedMap}:${maps.join(',')}:${this.rosterKey(players)}`)) return;
    const tiles = maps.map((m, i) => {
      const sel = m === selectedMap;
      const prev = this.mapPreviews[m];
      const thumb = prev
        ? `<img src="${esc(prev)}" alt="">`
        : `<span class="ph">TRACK ${i + 1}</span>`;
      return `
        <div class="map${sel ? ' sel' : ''}">
          <div class="thumb">${thumb}<div class="num">${i + 1}</div></div>
          <div class="mname">${esc(m)}${sel ? ' <span class="check">✓</span>' : ''}</div>
        </div>`;
    }).join('');
    this.root.innerHTML = `
      ${this.head('Pick The Track', 'Text a track number to choose')}
      ${this.chips(players)}
      <div class="scr-center"><div class="maps">${tiles}</div></div>
      <div class="scr-foot"><span class="key">←</span> back ·
        <span>${selectedMap ? '<span class="key">ENTER</span> to RACE' : 'choose a track'}</span></div>`;
  }

  // ── Results — this race + all-time board ─────────────────────────────────────────────────────
  renderResults(results: RaceResult[], carNameFor: (i: number) => string,
                global?: { map: string | null; entries: GlobalEntry[] }): void {
    this.show(); this.phase = 'results';
    const rows = results.map((r) => {
      const win = r.place === 1;
      const accent = PLACE_COLOR[r.place - 1] ?? 'var(--cyan)';
      const time = r.finished ? `${r.finishT.toFixed(2)}s` : 'DNF';
      return `
        <div class="res-row${win ? ' win' : ''}">
          <div class="place" style="color:${accent};font-size:${win ? '30px' : '22px'}">${PLACE_LABEL(r.place)}</div>
          <div class="rname" style="font-size:${win ? '26px' : '19px'}">${esc(r.name)}</div>
          <div class="rcar">${esc(carNameFor(r.carIndex))}</div>
          <div class="rtime" style="font-size:${win ? '24px' : '19px'}">${time}</div>
        </div>`;
    }).join('');
    const board = global ? this.boardHtml(global.map, global.entries, carNameFor) : '';
    this.root.innerHTML = `
      ${this.head('Results', '')}
      <div class="results-wrap">
        <div class="res-list"><div class="col-label">This race</div>${rows}</div>
        ${board}
      </div>
      <div class="scr-foot"><span class="key">ENTER</span> to play again</div>`;
  }

  private boardHtml(map: string | null, entries: GlobalEntry[], carNameFor: (i: number) => string): string {
    const rows = entries.length ? entries.map((e, i) => `
      <div class="board-row">
        <div class="bn">${i + 1}</div>
        <div class="rname">${esc(e.name)}</div>
        <div class="rcar">${esc(carNameFor(e.carIndex))}</div>
        <div class="rtime">${e.finishT.toFixed(2)}s</div>
      </div>`).join('')
      : `<div class="board-empty">No records yet — set the first time!</div>`;
    return `<div class="board"><div class="col-label">All-time best${map ? ' · ' + esc(map) : ''}</div>${rows}</div>`;
  }

  // ── shared bits ──────────────────────────────────────────────────────────────────────────────
  // Header brand stack: "Twilio" eyebrow (line 1) → red "VOICE RACER" wordmark (the game name) →
  // the current screen state ("Press Start", "Choose Your Ride", …) as a smaller caption, then the
  // dynamic subtitle line. `state` is the per-screen label; `sub` is the contextual hint.
  private head(state: string, sub: string): string {
    return `
      <div class="scr-head">
        <div class="scr-eyebrow"><img src="${BUG}" alt="">Twilio</div>
        <div class="scr-title">Voice Racer</div>
        <div class="scr-state">${esc(state)}</div>
        ${sub ? `<div class="scr-sub">${sub}</div>` : ''}
      </div>`;
  }

  private chips(players: LobbyPlayer[]): string {
    if (players.length === 0)
      return `<div class="chips"><div class="chip-empty">Waiting for players…</div></div>`;
    const chips = players.map(p => {
      const col = cssColor(p.color);
      // Only show a car label once the player has actually picked one. In the lobby nobody has
      // chosen yet, so showing a placeholder "…" on every pill looked broken.
      const carLabel = p.carIndex !== null
        ? `<span class="car">${esc(this.carNames[p.carIndex] ?? `Car ${p.carIndex + 1}`)}</span>` : '';
      return `
        <div class="chip${p.ready ? ' ready' : ''}"${p.ready ? ` style="border-color:${col}"` : ''}>
          <span class="dot" style="background:${col};color:${col}"></span>
          <span class="nm">${esc(p.name)}</span>
          ${carLabel}
        </div>`;
    }).join('');
    return `<div class="chips">${chips}</div>`;
  }

  /** Wire host keyboard: ← back, → / Enter advance. Returns a disposer. */
  bindHostKeys(): () => void {
    const handler = (e: KeyboardEvent) => {
      if (!this.visible) return;
      if (e.key === 'ArrowLeft') this.cb.onBack();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') this.cb.onAdvance();
    };
    addEventListener('keydown', handler);
    return () => removeEventListener('keydown', handler);
  }
}
