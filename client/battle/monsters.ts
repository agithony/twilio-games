// Voice Monsters battle page orchestrator. Ties the /battle WebSocket → the Game Boy renderer + the
// lobby/monster-select/results overlays. Roles by URL (matching the racer):
//   ?display=1 → the shared SCREEN (spectator; can also "play on this screen"); else → play on device.
//
// TURN-BASED FEEL: the client derives an explicit uiPhase from the snapshot (phase + chosen) so the
// move menu ONLY shows on your turn, a "command locked — waiting" beat appears after you pick, and
// resolution plays as paced events. An overlay dedup guard stops the lobby/results modals from
// re-mounting on every ~state push (the "win modal keeps popping up" bug).
import { BattleConnection, type BattleStateMsg } from './battle-net';
import { BattleRenderer, type UiPhase, type MenuMove } from './battle-renderer';
import { ArenaBackground } from './arena-background';
import type { RosterEntry } from '../../shared/battle-protocol';
import type { BattleEvent } from '../../shared/battle-world';
import { effectivenessLabel } from '../../shared/monster-types';

const params = new URLSearchParams(location.search);
const isDisplay = params.get('display') === '1';
const roomCode = params.get('room') ?? '4821';
const name = params.get('name') ?? 'Player';

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const wsUrl = params.get('ws')
  ?? (isLocalDev ? `${wsProto}://${location.hostname}:8080/battle` : `${wsProto}://${location.host}/battle`);

const overlay = document.getElementById('overlay')!;
const stageEl = document.getElementById('stage')!;

const conn = new BattleConnection(wsUrl);
// The 3D spinning arena sits BEHIND the GB battle canvas (both live in #stage). Created first so its
// canvas is under the renderer's. Loaded lazily when a battle actually starts (no 3D cost in menus).
const arena = new ArenaBackground(stageEl);
let arenaLoaded = false;
const renderer = new BattleRenderer(stageEl);

let roster: RosterEntry[] = [];
let myId: string | null = null;
let state: BattleStateMsg | null = null;
let draining = false;                 // events currently animating
let lockedMoveName: string | null = null;   // the move I committed this turn (for the "locked" beat)

conn.onRoster((m) => { roster = m; renderOverlay(); });
conn.onJoined((id) => { myId = id; });
conn.onError((code, msg) => console.error(`[battle] ${code}: ${msg}`));
conn.onEvents((events) => queueEvents(events));

conn.onState((m) => {
  const prevPhase = state?.phase;
  state = m;
  // A fresh turn (back to choosing) clears the last locked move so the menu returns.
  if (m.snapshot?.phase === 'choosing' && !chosenForMe(m)) lockedMoveName = null;
  // First time we enter a battle, spin up the 3D arena behind the GB overlay (lazy — no 3D in menus).
  if (m.phase === 'battle' && !arenaLoaded) {
    arenaLoaded = true;
    arena.load({ file: 'arena.glb', spinSpeed: 0.18 });
  }
  paintBattle();
  renderOverlay();
  // Advancing OUT of battle (→ results) or into it clears stale banners.
  if (prevPhase !== m.phase) renderer.setEventBanner('');
});

// ── who am I + my moves ──────────────────────────────────────────────────────────────────────────
function mySide(m: BattleStateMsg): 'a' | 'b' | null {
  if (!m.snapshot) return null;
  if (m.snapshot.a.id === myId) return 'a';
  if (m.snapshot.b.id === myId) return 'b';
  return null;   // spectator/display
}
function mySideMoves(m: BattleStateMsg): MenuMove[] {
  const snap = m.snapshot; if (!snap) return [];
  const cs = mySide(m) === 'b' ? snap.b : snap.a;   // display shows A's moves for reference
  return cs.moves.map(mv => ({ name: mv.name, type: mv.type, power: mv.power }));
}
function chosenForMe(m: BattleStateMsg): boolean {
  const side = mySide(m); if (!side || !m.snapshot) return false;
  return m.snapshot.chosen[side];
}
const opponentName = (m: BattleStateMsg): string => {
  const snap = m.snapshot; if (!snap) return 'the rival';
  return mySide(m) === 'b' ? snap.a.name : snap.b.name;
};

/** Derive the client turn state from the wire snapshot + local draining/lock. */
function currentUiPhase(): UiPhase {
  if (!state?.snapshot) return 'idle';
  if (draining) return 'resolving';
  if (state.snapshot.phase === 'finished') return 'finished';
  if (state.snapshot.phase === 'choosing') return chosenForMe(state) ? 'command-locked' : 'awaiting-input';
  return 'resolving';
}

/** Push the current battle view to the renderer (snapshot + my moves + turn state + status line). */
function paintBattle(): void {
  if (!state) return;
  const uiPhase = currentUiPhase();
  let status = '';
  if (state.snapshot) {
    const myMon = (mySide(state) === 'b' ? state.snapshot.b : state.snapshot.a).monsterName;
    if (uiPhase === 'awaiting-input') status = `What will ${myMon} do?`;
    else if (uiPhase === 'command-locked') status = `${lockedMoveName ? lockedMoveName + '! ' : ''}Waiting for ${opponentName(state)}…`;
    else if (uiPhase === 'finished') status = state.result ? `${state.result.winnerName} wins!` : '';
  }
  renderer.setState(state.snapshot, mySideMoves(state), uiPhase, status);
}

// ── paced event playback ──────────────────────────────────────────────────────────────────────────
let eventQ: BattleEvent[] = [];
function queueEvents(events: BattleEvent[]): void {
  eventQ.push(...events);
  if (!draining) { draining = true; paintBattle(); drainNext(); }
}
function drainNext(): void {
  const ev = eventQ.shift();
  if (!ev) { draining = false; paintBattle(); renderOverlay(); return; }   // resolution done → settle
  renderer.playEvent(ev);
  const banner = bannerFor(ev);
  if (banner) renderer.setEventBanner(banner);
  const slow = ev.kind === 'effectiveness' || ev.kind === 'faint' || ev.kind === 'battle_over';
  setTimeout(drainNext, slow ? 1100 : 550);
}
function bannerFor(ev: BattleEvent): string | null {
  switch (ev.kind) {
    case 'turn_start': return `Turn ${ev.turn}`;
    case 'move_used': return `${ev.moveName}!`;
    case 'effectiveness': return effectivenessLabel(ev.multiplier);
    case 'faint': return `${ev.monsterName} fainted!`;
    case 'battle_over': return `${ev.winnerName} wins!`;
    default: return null;
  }
}

// ── overlays (lobby / monster-select / results) — DEDUP-GUARDED so they don't re-mount every push ──
let lastOverlayKey = '';
function renderOverlay(): void {
  const phase = state?.phase ?? 'connecting';
  // During battle (incl. resolving), the GB canvas owns the screen — no overlay.
  if (phase === 'battle' || phase === 'connecting' || draining) {
    if (lastOverlayKey !== 'hidden') { overlay.innerHTML = ''; overlay.style.display = 'none'; lastOverlayKey = 'hidden'; }
    return;
  }
  const key = overlayKey(phase);
  if (key === lastOverlayKey) return;   // nothing meaningful changed → don't rebuild (kills modal spam)
  lastOverlayKey = key;
  overlay.style.display = 'flex';
  if (phase === 'lobby') overlay.innerHTML = lobbyHtml();
  else if (phase === 'monster_select') overlay.innerHTML = monsterSelectHtml();
  else if (phase === 'results') overlay.innerHTML = resultsHtml();
  wireOverlay();
}
/** A stable fingerprint of the overlay's meaningful inputs — only a change here rebuilds the DOM. */
function overlayKey(phase: string): string {
  const players = state?.players ?? [];
  const roster3 = roster.length;
  const roster3k = players.map(p => `${p.playerId}:${p.name}:${p.monsterId ?? ''}`).join('|');
  const win = state?.result?.winnerName ?? '';
  return `${phase}|${isDisplay ? 'D' : 'P'}|${joinedHere ? 'J' : 'j'}|r${roster3}|${roster3k}|${win}`;
}

function lobbyHtml(): string {
  const players = state?.players ?? [];
  const chips = players.map(p => `<span class="vm-chip">${esc(p.name)}${p.monsterId ? ' ✓' : ''}</span>`).join('') || '<span class="vm-dim">Waiting for challengers…</span>';
  const havePlayers = players.length > 0;
  let action: string;
  if (isDisplay && !joinedHere && !havePlayers) {
    action = `<button class="vm-btn" data-act="play-here">Play on this screen ▶</button>
      <div class="vm-dim">…or have players call in to join</div>`;
  } else if (isDisplay) {
    action = `<button class="vm-btn" data-act="advance">Choose your monster ▶</button>
      ${!joinedHere ? '<button class="vm-btn vm-btn-ghost" data-act="play-here">＋ Play on this screen</button>' : ''}`;
  } else {
    action = '<div class="vm-dim">Waiting for the host to start…</div>';
  }
  return `<div class="vm-card">
    <div class="vm-title">VOICE MONSTERS</div>
    <div class="vm-sub">Call in to battle — or play on this device</div>
    <div class="vm-chips">${chips}</div>
    ${action}
  </div>`;
}

function monsterSelectHtml(): string {
  const mine = state ? (state.players.find(p => p.playerId === myId)?.monsterId ?? null) : null;
  const cards = roster.map(m => {
    const moves = m.moves.map(mv => `<span class="vm-move t-${mv.type}">${esc(mv.name)}<b>${mv.power || '—'}</b></span>`).join('');
    return `<button class="vm-mon${mine === m.id ? ' sel' : ''}" data-mon="${m.id}">
      <div class="vm-mon-head"><span class="vm-mon-name">${esc(m.name)}</span><span class="vm-type t-${m.type}">${m.type}</span></div>
      <div class="vm-mon-blurb">${esc(m.blurb)}</div>
      <div class="vm-bars">
        ${statBar('HP', m.maxHp, 120)}${statBar('ATK', m.attack, 120)}${statBar('DEF', m.defense, 120)}${statBar('SPD', m.speed, 120)}
      </div>
      <div class="vm-moves">${moves}</div>
    </button>`;
  }).join('');
  return `<div class="vm-card wide">
    <div class="vm-title">CHOOSE YOUR MONSTER</div>
    <div class="vm-sub">Each has a type, stats, and 4 moves — pick your fighter</div>
    <div class="vm-grid">${cards}</div>
    ${isDisplay ? '<button class="vm-btn" data-act="advance">Battle ▶</button>' : '<div class="vm-dim">Say a monster\'s name or tap it.</div>'}
  </div>`;
}
/** A labeled stat bar (0..max normalized). */
function statBar(label: string, val: number, max: number): string {
  const pct = Math.round(Math.min(1, val / max) * 100);
  return `<div class="vm-bar"><span class="vm-bar-l">${label}</span><span class="vm-bar-track"><span class="vm-bar-fill" style="width:${pct}%"></span></span><span class="vm-bar-v">${val}</span></div>`;
}

function resultsHtml(): string {
  const w = state?.result?.winnerName ?? 'Nobody';
  return `<div class="vm-card">
    <div class="vm-title vm-win">🏆 ${esc(w)} WINS!</div>
    ${isDisplay ? '<button class="vm-btn" data-act="advance">Rematch ▶</button>' : '<div class="vm-dim">Good battle!</div>'}
  </div>`;
}

function wireOverlay(): void {
  overlay.querySelectorAll<HTMLElement>('[data-mon]').forEach(el =>
    el.onclick = () => conn.selectMonster(el.dataset.mon!));
  overlay.querySelectorAll<HTMLElement>('[data-act="advance"]').forEach(el =>
    el.onclick = () => conn.advance());
  overlay.querySelectorAll<HTMLElement>('[data-act="play-here"]').forEach(el =>
    el.onclick = () => { joinAsPlayer(); lastOverlayKey = ''; renderOverlay(); });
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ── connect: display spectates, device joins ─────────────────────────────────────────────────────
let joinedHere = false;
function joinAsPlayer(): void { if (joinedHere) return; joinedHere = true; conn.join(roomCode, name); }
if (isDisplay) conn.spectate(roomCode);
else { conn.join(roomCode, name); joinedHere = true; }

// Keyboard: during battle 1–4 pick a move (only when it's actually MY turn to choose); Enter advances.
addEventListener('keydown', (e) => {
  if (state?.phase === 'battle' && currentUiPhase() === 'awaiting-input' && /^[1-4]$/.test(e.key)) {
    const snap = state.snapshot; const side = state ? mySide(state) : null;
    if (snap && side) {
      const mv = (side === 'b' ? snap.b : snap.a).moves[parseInt(e.key, 10) - 1];
      if (mv) { lockedMoveName = mv.name; conn.chooseMove(mv.id); paintBattle(); }
    }
  } else if (e.key === 'Enter' && isDisplay && state?.phase !== 'battle') {
    conn.advance();
  }
});

renderOverlay();
