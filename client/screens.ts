// Big-screen front-end for the shared display: the AAA, Twilio-branded menu flow — lobby (PRESS
// START), car-select GRID, map-select, and the post-race results scoreboard. One full-screen GLASS
// overlay that sits on top of the live attract-mode 3D behind it, re-rendered from the server's
// lobby / select_state / results messages. Players act by TEXTING (concierge/SMS) or, on the host
// display, keyboard. Presentation only — styling lives in racer.css; this builds the markup + wires
// host keys. See [[lobby-character-select-vision]].
import type { LobbyPlayer, RaceResult } from '../shared/types';
import { controlsLegendHtml } from './controls-legend';

/** One row of the persistent global leaderboard (best all-time times). */
export interface GlobalEntry { name: string; map: string; carIndex: number; finishT: number; at: number }

/** Live map-vote tally for the track-select screen: per-map counts + whether the current leader is a
 *  random-broken tie. */
export interface MapVotes { counts: Record<string, number>; tie: boolean }

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
  /** Rendered boost-orb thumbnail (data-URL) for the lobby "How to play" NITRO row; '' until it lands. */
  private boostThumb = '';
  /** The phone number players CALL to join (from /api/config); '' until it loads → lobby shows a
   *  "set GAME_PHONE_NUMBER" placeholder so a misconfigured deploy is obvious on screen. */
  private phoneNumber = '';
  private visible = false;
  private phase: 'lobby' | 'car_select' | 'map_select' | 'results' | null = null;
  private lastMapArgs: { maps: string[]; selectedMap: string | null; players: LobbyPlayer[]; votes: MapVotes } | null = null;
  /** Signature of the last rendered state. The server re-broadcasts the roster ~2x/s; rebuilding
   *  innerHTML each time replays the CSS entrance animations → the "flicker" the user saw. We skip
   *  the rebuild when nothing meaningful changed. */
  private lastKey = '';
  /** Shared-screen only: whether the operator opted to also play on this keyboard (P toggle). Shown
   *  in the lobby footer so the screen's state ("spectating" vs "you're racing") is never ambiguous. */
  private selfPlaying = false;

  constructor(host: HTMLElement, private cb: ScreensCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'screens';
    host.appendChild(this.root);
  }

  /** Supply the join phone number (from /api/config); re-render the lobby if it's up so the QR-flow
   *  copy shows the real number instead of the placeholder. */
  setPhoneNumber(num: string): void {
    if (num === this.phoneNumber) return;
    this.phoneNumber = num;
    if (this.visible && this.phase === 'lobby' && this.lastLobby) {
      this.lastKey = '';
      this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
    }
  }

  /** Supply the rendered boost-orb thumbnail; re-render the lobby if it's up so the NITRO row shows it. */
  setBoostThumb(url: string): void {
    if (!url || url === this.boostThumb) return;
    this.boostThumb = url;
    if (this.visible && this.phase === 'lobby' && this.lastLobby) {
      this.lastKey = '';   // force past the dedup
      this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
    }
  }

  /** Reflect the shared-screen "I'm playing" toggle in the lobby footer. */
  setSelfPlaying(on: boolean): void {
    this.selfPlaying = on;
    this.lastKey = '';   // force the next render past the dedup so the footer updates
    if (this.visible && this.phase === 'lobby') this.lastLobby && this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
  }
  private lastLobby: { roomCode: string; players: LobbyPlayer[] } | null = null;

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
    if (img instanceof HTMLImageElement) {
      img.src = url; img.style.opacity = '1';
      // Remove the "CAR N" + spinner placeholder — it's position:absolute; inset:0, so if left in
      // place it sits ON TOP of the finished portrait forever (the "stuck loading" overlay bug).
      this.root.querySelector(`span.ph[data-ph="${i}"]`)?.remove();
    } else if (this.visible && this.phase === 'car_select') {
      this.rerenderCarSelect(true);
    }
  }
  setMapPreviews(previews: Record<string, string>): void {
    this.mapPreviews = previews;
    // If the map-select screen is already showing, re-render so the previews replace the placeholders.
    if (this.visible && this.phase === 'map_select' && this.lastMapArgs) {
      const a = this.lastMapArgs;
      this.lastKey = '';   // force past the dedup
      this.renderMapSelect(a.maps, a.selectedMap, a.players, a.votes);
    }
  }

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
    this.lastLobby = { roomCode, players };
    void roomCode;   // no longer shown — calls bind straight to the single game (instant join)
    if (this.unchanged(`lobby:${this.selfPlaying ? 'P' : 'p'}:${this.phoneNumber}:${this.boostThumb ? 'orb' : 'noorb'}:${this.rosterKey(players)}`)) return;
    const n = players.length;
    const sub = n === 0 ? 'Scan, call in, and race' : `${n} ${n === 1 ? 'racer' : 'racers'} in the room`;
    // JOIN FLOW: scan the QR → it dials the number → you're IN the race (no room code to type — the
    // call binds straight to this game). The number comes from /api/config (placeholder if unset).
    const num = this.phoneNumber
      ? `<a class="num" href="tel:${esc(this.phoneNumber)}">${esc(this.phoneNumber)}</a>`
      : `<span class="num num-unset">set GAME_PHONE_NUMBER</span>`;
    const foot = n === 0
      ? `<span>Everyone can join — the more the merrier</span>`
      : `<span>Say <span class="say">“start”</span> when everyone's in</span>`;
    this.root.innerHTML = `
      ${this.head('Lobby', sub)}
      <div class="scr-center lobby-grid">
        <div class="lobby-main">
          <div class="join-flow">
            <div class="join-qr">
              <img src="/brand/join-qr.png?v=2" alt="Scan to call and join" onerror="this.style.display='none'">
              <div class="join-qr-cap">Scan to join</div>
            </div>
            <ol class="join-steps">
              <li><span class="step-n">1</span> <span class="step-t">Scan the code with your phone</span></li>
              <li><span class="step-n">2</span> <span class="step-t">Tap to call ${num}</span></li>
              <li><span class="step-n">3</span> <span class="step-t">You're in — shout to drive!</span></li>
            </ol>
          </div>
          ${this.chips(players)}
          <div class="scr-foot">${foot}</div>
        </div>
        ${controlsLegendHtml(this.boostThumb)}
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
    // Pick a column count that keeps the grid roughly landscape (≈16:9) so all cars fit on one
    // screen without scrolling — e.g. 19 cars → 7 cols × 3 rows. CSS rows are 1fr (fill the height).
    const n = this.carNames.length;
    const cols = Math.max(4, Math.min(8, Math.ceil(Math.sqrt(n * 1.9))));
    this.root.innerHTML = `
      ${this.head('Choose Your Ride', allReady ? 'All locked in — ready to roll' : 'Text a car number to lock in')}
      ${this.chips(players)}
      <div class="scr-body"><div class="grid" style="--cols:${cols}">${tiles}</div></div>
      <div class="scr-foot">
        <span>${allReady ? 'All locked in — say <span class="say">“next”</span> to pick the track' : 'Say a car name or number to lock in'}</span></div>`;
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
  renderMapSelect(maps: string[], selectedMap: string | null, players: LobbyPlayer[], votes: MapVotes = { counts: {}, tie: false }): void {
    this.show(); this.phase = 'map_select';
    this.lastMapArgs = { maps, selectedMap, players, votes };
    const counts = votes.counts;
    const totalVotes = Object.values(counts).reduce((s, n) => s + n, 0);
    // Dedup key includes the vote tally + tie so the UI live-updates as votes come in.
    const havePrev = maps.some(m => this.mapPreviews[m]) ? 'p' : 'n';
    const voteKey = maps.map(m => `${m}=${counts[m] ?? 0}`).join(',') + (votes.tie ? '|tie' : '');
    if (this.unchanged(`map:${selectedMap}:${maps.join(',')}:${havePrev}:${voteKey}:${this.rosterKey(players)}`)) return;
    const tiles = maps.map((m, i) => {
      const n = counts[m] ?? 0;
      const leading = m === selectedMap;   // the current vote winner
      const prev = this.mapPreviews[m];
      const thumb = prev
        ? `<img src="${esc(prev)}" alt="">`
        : `<span class="ph">TRACK ${i + 1}</span>`;
      // A vote badge (count + label) so it's clear this is a vote, and which track is winning.
      const voteBadge = `<div class="votes${n > 0 ? ' has' : ''}">${n} ${n === 1 ? 'vote' : 'votes'}</div>`;
      return `
        <div class="map${leading ? ' sel' : ''}">
          <div class="thumb">${thumb}<div class="num">${i + 1}</div>${voteBadge}</div>
          <div class="mname">${esc(m)}${leading ? ' <span class="check">▶ leading</span>' : ''}</div>
        </div>`;
    }).join('');
    // Headline messaging that makes the vote (and tie-break) explicit.
    const sub = totalVotes === 0 ? 'Say your track to vote — most votes wins!'
      : votes.tie ? `It's a TIE — a random track will be picked!`
      : `${totalVotes} vote${totalVotes === 1 ? '' : 's'} in · leading: ${selectedMap ?? '—'}`;
    this.root.innerHTML = `
      ${this.head('Vote Your Track', sub)}
      ${this.chips(players)}
      <div class="scr-center"><div class="maps">${tiles}</div></div>
      <div class="scr-foot">
        <span>${selectedMap ? `Say <span class="say">“start”</span> to race ${votes.tie ? '(random from the tie)' : 'the winner'}` : 'Say a track name or number to vote'}</span></div>`;
  }

  // ── Results — this race + all-time board ─────────────────────────────────────────────────────
  renderResults(results: RaceResult[], carNameFor: (i: number) => string,
                global?: { map: string | null; entries: GlobalEntry[] }): void {
    this.show(); this.phase = 'results';
    // Dedup: the server re-broadcasts results ~2x/s → rebuilding innerHTML replayed the title +
    // row entrance animations = flicker. Key on the standings + the global board so the only
    // legit re-render is when the all-time board folds in after its fetch.
    const key = 'res:' + results.map(r => `${r.place}:${r.name}:${r.finishT}:${r.finished?1:0}`).join('|')
      + '#' + (global ? `${global.map}:` + global.entries.map(e => `${e.name}:${e.finishT}`).join(',') : 'nob');
    if (this.unchanged(key)) return;
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
      <div class="scr-foot">Say <span class="say">“race again”</span> to run it back</div>`;
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
    const chips = players.map((p, i) => {
      const col = cssColor(p.color);
      // Only show a car label once the player has actually picked one. In the lobby nobody has
      // chosen yet, so showing a placeholder "…" on every pill looked broken.
      const carLabel = p.carIndex !== null
        ? `<span class="car">${esc(this.carNames[p.carIndex] ?? `Car ${p.carIndex + 1}`)}</span>` : '';
      // Two-line identity stack: a small "Player N" eyebrow over the player's NAME (the main text).
      return `
        <div class="chip${p.ready ? ' ready' : ''}"${p.ready ? ` style="border-color:${col}"` : ''}>
          <span class="dot" style="background:${col};color:${col}"></span>
          <span class="who">
            <span class="plabel">Player ${i + 1}</span>
            <span class="nm">${esc(p.name)}</span>
          </span>
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
