// Big-screen front-end for the shared display: the Super-Smash-Bros-style flow — lobby roster,
// car-select GRID, map-select, and the post-race results scoreboard. One full-screen overlay,
// re-rendered from the server's lobby / select_state / results messages. Players act by TEXTING
// (concierge/SMS) or, on the host display, keyboard; this module is presentation only — it calls
// back to the caller for host actions (advance/back/start). See [[lobby-character-select-vision]].
import type { LobbyPlayer, RaceResult } from '../shared/types';

/** One row of the persistent global leaderboard (best all-time times). */
export interface GlobalEntry { name: string; map: string; carIndex: number; finishT: number; at: number }

export interface ScreensCallbacks {
  /** Host pressed advance (Enter / →): move the flow forward a phase or start the race. */
  onAdvance(): void;
  /** Host pressed back (←): step a phase backward. */
  onBack(): void;
}

const PLACE_LABEL = (p: number) => p === 1 ? '1st' : p === 2 ? '2nd' : p === 3 ? '3rd' : `${p}th`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** Defense-in-depth: only let an obvious CSS color literal into a style attribute (the server also
 *  sanitizes, but never trust a single layer for values that land in `style="..."`). */
const cssColor = (c: string, fallback = '#888') =>
  /^(#[0-9a-fA-F]{3,8}|rgb\([\d,\s]+\)|hsl\([\d,%\s]+\))$/.test(c?.trim?.() ?? '') ? c.trim() : fallback;

export class Screens {
  private root: HTMLElement;
  private carNames: string[] = [];
  private carThumbs: string[] = [];
  private mapPreviews: Record<string, string> = {};
  private visible = false;

  constructor(host: HTMLElement, private cb: ScreensCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'screens';
    this.root.style.cssText = [
      'position:absolute', 'inset:0', 'display:none', 'flex-direction:column',
      'background:radial-gradient(120% 90% at 50% 0%, #131a33 0%, #070b18 70%, #05070f 100%)',
      'color:#eef2fb', 'font-family:Inter, system-ui, sans-serif', 'overflow:hidden', 'z-index:50',
    ].join(';');
    host.appendChild(this.root);
  }

  setCarCatalog(names: string[], thumbs: string[]): void {
    this.carNames = names; this.carThumbs = thumbs;
  }
  setMapPreviews(previews: Record<string, string>): void { this.mapPreviews = previews; }

  show(): void { this.visible = true; this.root.style.display = 'flex'; }
  hide(): void { this.visible = false; this.root.style.display = 'none'; }
  get isVisible(): boolean { return this.visible; }

  // ── Lobby (waiting for players) ────────────────────────────────────────────────────────────────
  renderLobby(roomCode: string, players: LobbyPlayer[]): void {
    this.show();
    this.root.innerHTML = `
      ${this.header('PRESS START', `Text <b>${esc(roomCode)}</b> to join · ${players.length} in`)}
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px">
        <div style="font-size:120px;font-weight:900;letter-spacing:4px;color:#ff2d4b;text-shadow:0 0 40px rgba(255,45,75,.5)">${esc(roomCode)}</div>
        ${this.playerStrip(players)}
        <div style="opacity:.7;font-size:18px">Host: press <b>ENTER</b> to choose cars</div>
      </div>`;
  }

  // ── Car select (the SSB grid) ──────────────────────────────────────────────────────────────────
  renderCarSelect(players: LobbyPlayer[]): void {
    this.show();
    const claims = new Map<number, LobbyPlayer[]>();   // carIndex -> players who picked it
    for (const p of players) if (p.carIndex !== null) {
      const arr = claims.get(p.carIndex) ?? []; arr.push(p); claims.set(p.carIndex, arr);
    }
    const tiles = this.carNames.map((name, i) => this.carTile(i, name, claims.get(i) ?? [])).join('');
    const allReady = players.length > 0 && players.every(p => p.ready);
    this.root.innerHTML = `
      ${this.header('CHOOSE YOUR RIDE', `Text a car <b>number</b> to lock in${allReady ? ' · all set!' : ''}`)}
      ${this.playerStrip(players)}
      <div style="flex:1;overflow:auto;padding:18px 28px 28px">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;max-width:1500px;margin:0 auto">
          ${tiles}
        </div>
      </div>
      <div style="text-align:center;padding:12px;font-size:17px;opacity:.85">
        ← back · <b>${allReady ? 'ENTER to pick the track' : 'waiting for all players to lock in'}</b></div>`;
  }

  private carTile(i: number, name: string, claimedBy: LobbyPlayer[]): string {
    const claimed = claimedBy.length > 0;
    const ring = claimed ? cssColor(claimedBy[0]!.color) : 'transparent';
    const portrait = this.carThumbs[i]
      ? `<img src="${this.carThumbs[i]}" alt="" style="width:100%;height:120px;object-fit:contain;filter:drop-shadow(0 6px 10px rgba(0,0,0,.5))">`
      : `<div style="height:120px;display:flex;align-items:center;justify-content:center;font-size:15px;letter-spacing:2px;opacity:.3">CAR ${i + 1}</div>`;
    const badges = claimedBy.map(p =>
      `<span style="display:inline-flex;align-items:center;gap:4px;background:${cssColor(p.color)};color:#06101f;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700">${esc(p.name)}</span>`
    ).join(' ');
    return `
      <div style="position:relative;background:rgba(20,28,52,.85);border:3px solid ${ring};border-radius:16px;
                  padding:12px;transition:transform .15s;${claimed ? 'box-shadow:0 0 22px ' + ring + '66' : ''}">
        <div style="position:absolute;top:8px;left:10px;font-size:22px;font-weight:900;opacity:.65">${i + 1}</div>
        ${portrait}
        <div style="text-align:center;font-size:14px;font-weight:600;margin-top:6px;min-height:34px;display:flex;align-items:center;justify-content:center">${esc(name)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;min-height:22px">${badges}</div>
      </div>`;
  }

  // ── Map select ───────────────────────────────────────────────────────────────────────────────
  renderMapSelect(maps: string[], selectedMap: string | null, players: LobbyPlayer[]): void {
    this.show();
    const tiles = maps.map((m, i) => {
      const sel = m === selectedMap;
      const prev = this.mapPreviews[m];
      const thumb = prev
        ? `<img src="${esc(prev)}" alt="" style="width:100%;height:160px;object-fit:cover;border-radius:10px">`
        : `<div style="height:160px;border-radius:10px;background:linear-gradient(135deg,#1c2848,#0c1428 90%);display:flex;align-items:center;justify-content:center;font-size:15px;letter-spacing:2px;opacity:.35">TRACK ${i + 1}</div>`;
      return `
        <div style="background:rgba(20,28,52,.85);border:3px solid ${sel ? '#36e08a' : 'transparent'};
                    border-radius:16px;padding:12px;${sel ? 'box-shadow:0 0 26px #36e08a66' : ''}">
          <div style="position:relative">${thumb}
            <div style="position:absolute;top:8px;left:10px;font-size:22px;font-weight:900;text-shadow:0 1px 4px #000">${i + 1}</div></div>
          <div style="text-align:center;font-size:18px;font-weight:700;margin-top:8px">${esc(m)}${sel ? ' ✓' : ''}</div>
        </div>`;
    }).join('');
    this.root.innerHTML = `
      ${this.header('PICK THE TRACK', 'Text a track <b>number</b> to choose')}
      ${this.playerStrip(players)}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:20px">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;max-width:1100px;width:100%">
          ${tiles}
        </div>
      </div>
      <div style="text-align:center;padding:12px;font-size:17px;opacity:.85">
        ← back · <b>${selectedMap ? 'ENTER to RACE' : 'choose a track'}</b></div>`;
  }

  // ── Results scoreboard (this race) + global all-time board ─────────────────────────────────────
  renderResults(results: RaceResult[], carNameFor: (i: number) => string,
                global?: { map: string | null; entries: GlobalEntry[] }): void {
    this.show();
    const PLACE_COLOR = ['#ffd23f', '#c8d4e6', '#d9914e'];   // gold / silver / bronze for 1-3
    const rows = results.map((r) => {
      const time = r.finished ? `${r.finishT.toFixed(2)}s` : 'DNF';
      const big = r.place === 1;
      const accent = PLACE_COLOR[r.place - 1] ?? '#5c8aff';
      return `
        <div style="display:flex;align-items:center;gap:16px;background:rgba(20,28,52,${big ? '.95' : '.7'});
                    border-radius:14px;padding:${big ? '16px' : '11px'} 22px;${big ? 'border:2px solid #ffd23f;box-shadow:0 0 26px #ffd23f44' : ''}">
          <div style="font-size:${big ? '32px' : '22px'};font-weight:900;width:66px;color:${accent}">${PLACE_LABEL(r.place)}</div>
          <div style="flex:1;font-size:${big ? '26px' : '19px'};font-weight:700">${esc(r.name)}</div>
          <div style="opacity:.7;font-size:15px">${esc(carNameFor(r.carIndex))}</div>
          <div style="font-variant-numeric:tabular-nums;font-size:${big ? '24px' : '19px'};font-weight:700;width:110px;text-align:right">${time}</div>
        </div>`;
    }).join('');

    const globalBoard = global ? this.globalBoardHtml(global.map, global.entries, carNameFor) : '';
    this.root.innerHTML = `
      ${this.header('RESULTS', '')}
      <div style="flex:1;display:flex;gap:28px;max-width:1180px;width:100%;margin:0 auto;justify-content:center;align-items:center;padding:16px 24px">
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;max-width:680px">
          <div style="font-size:14px;letter-spacing:2px;opacity:.6;margin-bottom:2px">THIS RACE</div>
          ${rows}
        </div>
        ${globalBoard}
      </div>
      <div style="text-align:center;padding:16px;font-size:18px;opacity:.85"><b>ENTER</b> to play again</div>`;
  }

  private globalBoardHtml(map: string | null, entries: GlobalEntry[], carNameFor: (i: number) => string): string {
    const rows = entries.length ? entries.map((e, i) => `
        <div style="display:flex;align-items:center;gap:12px;background:rgba(16,22,40,.7);border-radius:10px;padding:9px 14px">
          <div style="width:30px;font-weight:800;opacity:.6">${i + 1}</div>
          <div style="flex:1;font-weight:600">${esc(e.name)}</div>
          <div style="opacity:.55;font-size:13px">${esc(carNameFor(e.carIndex))}</div>
          <div style="font-variant-numeric:tabular-nums;font-weight:700;width:90px;text-align:right">${e.finishT.toFixed(2)}s</div>
        </div>`).join('')
      : `<div style="opacity:.5;padding:16px;text-align:center">No records yet — set the first time!</div>`;
    return `
      <div style="width:420px;display:flex;flex-direction:column;gap:8px">
        <div style="font-size:14px;letter-spacing:2px;opacity:.6;margin-bottom:2px">ALL-TIME BEST${map ? ' · ' + esc(map).toUpperCase() : ''}</div>
        ${rows}
      </div>`;
  }

  // ── shared bits ──────────────────────────────────────────────────────────────────────────────
  private header(title: string, sub: string): string {
    return `
      <div style="text-align:center;padding:26px 0 10px">
        <div style="font-size:40px;font-weight:900;letter-spacing:6px;background:linear-gradient(90deg,#ff2d4b,#ff8a5c);-webkit-background-clip:text;background-clip:text;color:transparent">${title}</div>
        ${sub ? `<div style="opacity:.8;font-size:16px;margin-top:4px">${sub}</div>` : ''}
      </div>`;
  }

  private playerStrip(players: LobbyPlayer[]): string {
    if (players.length === 0)
      return `<div style="text-align:center;opacity:.5;font-size:16px;min-height:64px;display:flex;align-items:center;justify-content:center">No players yet</div>`;
    const chips = players.map(p => {
      const carTxt = p.carIndex !== null ? esc(this.carNames[p.carIndex] ?? `Car ${p.carIndex + 1}`) : '…';
      const col = cssColor(p.color);
      return `
        <div style="display:flex;align-items:center;gap:9px;background:rgba(35,43,69,.92);border:2px solid ${p.ready ? col : '#38425e'};
                    border-radius:999px;padding:7px 16px;font-size:16px">
          <span style="width:13px;height:13px;border-radius:50%;background:${col};display:inline-block"></span>
          <b>${esc(p.name)}</b>
          <span style="opacity:.65;font-size:13px">${carTxt}</span>
        </div>`;
    }).join('');
    return `<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:6px 20px 14px">${chips}</div>`;
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
