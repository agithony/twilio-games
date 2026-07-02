// Voice Monsters battle page orchestrator. Ties the /battle WebSocket → the Game Boy renderer + the
// lobby/monster-select overlays. Mirrors the racer's play page split (net + renderer + screen
// overlay). Roles by URL, matching the racer:
//   ?display=1   → the shared SCREEN (spectator; drives the flow by keyboard; players join by phone)
//   (else)       → play on THIS device (keyboard fallback for testing / online play)
import { BattleConnection, type BattleStateMsg } from './battle-net';
import { BattleRenderer } from './battle-renderer';
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

const app = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;   // lobby / monster-select / results UI
const stageEl = document.getElementById('stage')!;     // the GB battle canvas host

const conn = new BattleConnection(wsUrl);
const renderer = new BattleRenderer(stageEl);

let roster: RosterEntry[] = [];
let myId: string | null = null;
let state: BattleStateMsg | null = null;

conn.onRoster((m) => { roster = m; render(); });
conn.onJoined((id) => { myId = id; });
conn.onError((code, msg) => console.error(`[battle] ${code}: ${msg}`));

// Ordered events: play the animation cue + surface the effectiveness/faint banner, spaced out so the
// hit lands visibly before the next line (turn-based pacing).
conn.onEvents((events) => queueEvents(events));

conn.onState((m) => {
  state = m;
  // Feed the renderer the current snapshot + the LOCAL player's move names for the bottom menu.
  const myMoves = mySideMoves(m);
  renderer.setState(m.snapshot, myMoves);
  render();
});

/** Which side am I (a/b) in this battle, and my move names for the command window. */
function mySide(m: BattleStateMsg): 'a' | 'b' | null {
  if (!m.snapshot) return null;
  if (m.snapshot.a.id === myId) return 'a';
  if (m.snapshot.b.id === myId) return 'b';
  return null;   // spectator/display
}
function mySideMoves(m: BattleStateMsg): string[] {
  const side = mySide(m);
  const snap = m.snapshot;
  if (!snap) return [];
  // The display (no side) shows player A's moves for reference; a player shows their own.
  const cs = side === 'b' ? snap.b : snap.a;
  return cs.moves.map(mv => mv.name);
}

// ── event queue (paced) ─────────────────────────────────────────────────────────────────────────
let eventQ: BattleEvent[] = [];
let draining = false;
function queueEvents(events: BattleEvent[]): void { eventQ.push(...events); if (!draining) drainNext(); }
function drainNext(): void {
  const ev = eventQ.shift();
  if (!ev) { draining = false; return; }
  draining = true;
  renderer.playEvent(ev);
  const banner = bannerFor(ev);
  if (banner) renderer.setBanner(banner);
  // pacing: effectiveness/faint linger; a plain move/damage is quick.
  const delay = ev.kind === 'effectiveness' || ev.kind === 'faint' || ev.kind === 'battle_over' ? 1100 : 500;
  setTimeout(drainNext, delay);
}
function bannerFor(ev: BattleEvent): string | null {
  switch (ev.kind) {
    case 'move_used': return `${ev.moveName}!`;
    case 'effectiveness': return effectivenessLabel(ev.multiplier);
    case 'faint': return `${ev.monsterName} fainted!`;
    case 'battle_over': return `${ev.winnerName} wins!`;
    default: return null;
  }
}

// ── overlay UI (lobby / monster-select / results) ────────────────────────────────────────────────
function render(): void {
  const phase = state?.phase ?? 'connecting';
  app.classList.toggle('in-battle', phase === 'battle');
  if (phase === 'battle' || phase === 'connecting') { overlay.innerHTML = ''; overlay.style.display = 'none'; return; }
  overlay.style.display = 'flex';
  if (phase === 'lobby') overlay.innerHTML = lobbyHtml();
  else if (phase === 'monster_select') overlay.innerHTML = monsterSelectHtml();
  else if (phase === 'results') overlay.innerHTML = resultsHtml();
  wireOverlay();
}

function lobbyHtml(): string {
  const players = state?.players ?? [];
  const chips = players.map(p => `<span class="vm-chip">${esc(p.name)}${p.monsterId ? ' ✓' : ''}</span>`).join('') || '<span class="vm-dim">Waiting for challengers…</span>';
  return `<div class="vm-card">
    <div class="vm-title">VOICE MONSTERS</div>
    <div class="vm-sub">Call in to battle — or play on this device</div>
    <div class="vm-chips">${chips}</div>
    ${isDisplay ? `<button class="vm-btn" data-act="advance">Choose your monster ▶</button>` : '<div class="vm-dim">Waiting for the host to start…</div>'}
  </div>`;
}

function monsterSelectHtml(): string {
  const mine = state ? (state.players.find(p => p.playerId === myId)?.monsterId ?? null) : null;
  const cards = roster.map(m => `
    <button class="vm-mon${mine === m.id ? ' sel' : ''}" data-mon="${m.id}">
      <div class="vm-mon-name">${esc(m.name)}</div>
      <div class="vm-mon-type t-${m.type}">${m.type}</div>
      <div class="vm-mon-stats">HP ${m.maxHp} · ATK ${m.attack} · DEF ${m.defense} · SPD ${m.speed}</div>
      <div class="vm-mon-blurb">${esc(m.blurb)}</div>
    </button>`).join('');
  return `<div class="vm-card wide">
    <div class="vm-title">CHOOSE YOUR MONSTER</div>
    <div class="vm-grid">${cards}</div>
    ${isDisplay ? '<button class="vm-btn" data-act="advance">Battle ▶</button>' : '<div class="vm-dim">Pick a monster — say its name or tap it.</div>'}
  </div>`;
}

function resultsHtml(): string {
  const w = state?.result?.winnerName ?? '';
  return `<div class="vm-card">
    <div class="vm-title">${esc(w)} WINS!</div>
    ${isDisplay ? '<button class="vm-btn" data-act="advance">Rematch ▶</button>' : '<div class="vm-dim">Good battle!</div>'}
  </div>`;
}

function wireOverlay(): void {
  overlay.querySelectorAll<HTMLElement>('[data-mon]').forEach(el =>
    el.onclick = () => conn.selectMonster(el.dataset.mon!));
  overlay.querySelectorAll<HTMLElement>('[data-act="advance"]').forEach(el =>
    el.onclick = () => conn.advance());
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ── connect: display spectates, device joins ─────────────────────────────────────────────────────
if (isDisplay) conn.spectate(roomCode);
else conn.join(roomCode, name);

// Keyboard fallback (testing / device play): 1–4 choose a move during battle; Enter advances (host).
addEventListener('keydown', (e) => {
  if (state?.phase === 'battle' && /^[1-4]$/.test(e.key)) {
    const snap = state.snapshot; const side = state ? mySide(state) : null;
    if (snap && side) {
      const moves = (side === 'b' ? snap.b : snap.a).moves;
      const mv = moves[parseInt(e.key, 10) - 1];
      if (mv) conn.chooseMove(mv.id);
    }
  } else if (e.key === 'Enter' && isDisplay) {
    conn.advance();
  }
});

render();
