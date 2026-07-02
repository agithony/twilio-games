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
import { drawMonsterSprite } from './monster-sprite';
import { spriteCandidateUrls } from './sprite-sources';
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
  // Pull the editor-authored config from /api/arena; fall back to sensible defaults on any failure.
  if (m.phase === 'battle' && !arenaLoaded) {
    arenaLoaded = true;
    fetch('/api/arena').then(r => r.ok ? r.json() : null).then((cfg) => {
      arena.load(cfg && typeof cfg === 'object' ? cfg : { file: 'arena.glb', spinSpeed: 0.18 });
    }).catch(() => arena.load({ file: 'arena.glb', spinSpeed: 0.18 }));
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
let movesSeenThisTurn = 0;      // how many attacks played so far this turn (resets on turn_start)
let pendingHandoff: 'a' | 'b' | null = null;   // a synthetic "▶ X'S TURN" card to show before next move

function drainNext(): void {
  // A queued handoff card takes priority: show it as its own slow beat, THEN continue to the attack.
  if (pendingHandoff) {
    const who = pendingHandoff; pendingHandoff = null;
    renderer.setEventBanner(handoffText(who));
    renderer.setActiveSide(who);
    setTimeout(drainNext, 1900);   // hold the "their turn" card so the ping-pong is unmistakable
    return;
  }
  const ev = eventQ.shift();
  if (!ev) { draining = false; movesSeenThisTurn = 0; renderer.setActiveSide(null); paintBattle(); renderOverlay(); return; }

  if (ev.kind === 'turn_start') movesSeenThisTurn = 0;
  // Before the SECOND attack of a turn, inject a handoff card announcing the other side's turn.
  if (ev.kind === 'move_used') {
    movesSeenThisTurn++;
    if (movesSeenThisTurn === 2) { pendingHandoff = ev.by; eventQ.unshift(ev); setTimeout(drainNext, 0); return; }
    renderer.setActiveSide(ev.by);
  }

  renderer.playEvent(ev);
  const banner = bannerFor(ev);
  if (banner) renderer.setEventBanner(banner);
  setTimeout(drainNext, dwellFor(ev));
}

/** "▶ YOUR TURN" when it's the local player's monster, else "▶ RIVAL'S TURN" (names the foe). */
function handoffText(side: 'a' | 'b'): string {
  const me = state ? mySide(state) : null;
  if (me && side === me) return '▶ YOUR TURN';
  return `▶ ${actorName(side).toUpperCase()}'S TURN`;
}

/** How long to hold on `ev` before playing the next one — slow, so each beat reads as its own step:
 *  "X used Move!" sits on screen BEFORE its hit lands, and hits/outcomes linger. The between-attack
 *  handoff is a separate injected card (see drainNext), so we don't pad here for it. */
function dwellFor(ev: BattleEvent): number {
  switch (ev.kind) {
    case 'turn_start':   return 1400;                    // "— Turn N —" title card
    case 'move_used':    return 1800;                    // announce the move, THEN it hits
    case 'damage':       return ev.crit ? 2200 : 1650;   // the hit + HP drop registers
    case 'effectiveness':return 2100;                    // "It's super effective!" lands
    case 'faint':        return 2300;
    case 'battle_over':  return 2400;
    default:             return 1500;
  }
}
/** The monster name for a side, from the current snapshot (for "X used Move!" banners). */
function actorName(side: 'a' | 'b'): string {
  const snap = state?.snapshot; if (!snap) return side === 'a' ? 'You' : 'Foe';
  return (side === 'a' ? snap.a : snap.b).monsterName;
}
function bannerFor(ev: BattleEvent): string | null {
  switch (ev.kind) {
    case 'turn_start': return `— Turn ${ev.turn} —`;
    // Name the attacker so it's unmistakable WHOSE turn it is ("Sparkmouse used Thunder Jolt!").
    case 'move_used': return `${actorName(ev.by)} used ${ev.moveName}!`;
    case 'damage': return ev.crit ? 'A critical hit!' : null;   // a normal hit shows no banner
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
  // The battle STAGE (GB canvas + 3D arena) must only show during an actual battle. Otherwise its
  // "Waiting…" canvas rendered ON TOP of the lobby/select overlays (covering the buttons — the bug).
  const inBattle = phase === 'battle' || draining;
  stageEl.style.display = inBattle ? '' : 'none';
  // During battle (incl. resolving), the GB canvas owns the screen — no overlay.
  if (inBattle || phase === 'connecting') {
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
  if (phase === 'monster_select') upgradeSelectPortraits();   // swap placeholders → real GIF/PNG
}
/** A stable fingerprint of the overlay's meaningful inputs — only a change here rebuilds the DOM. */
function overlayKey(phase: string): string {
  const players = state?.players ?? [];
  const roster3 = roster.length;
  const roster3k = players.map(p => `${p.playerId}:${p.name}:${p.monsterId ?? ''}`).join('|');
  const win = state?.result?.winnerName ?? '';
  return `${phase}|${isDisplay ? 'D' : 'P'}|${joinedHere ? 'J' : 'j'}|r${roster3}|${roster3k}|${win}`;
}

/** Can THIS client drive the flow (advance / start)? A device player (auto-joined) can drive their
 *  own game vs AI; the shared screen drives once it has a player or has opted to play on-screen. */
function canDrive(): boolean {
  const havePlayers = (state?.players?.length ?? 0) > 0;
  return joinedHere || (isDisplay && havePlayers);
}

function lobbyHtml(): string {
  const players = state?.players ?? [];
  const chips = players.map(p => `<span class="vm-chip">${esc(p.name)}${p.monsterId ? ' ✓' : ''}</span>`).join('') || '<span class="vm-dim">Waiting for challengers…</span>';
  const havePlayers = players.length > 0;
  let action: string;
  if (canDrive()) {
    // A joined player (device, or the screen after "play here") advances to monster select.
    action = `<button class="vm-btn" data-act="advance">Choose your monster ▶</button>
      ${isDisplay && !joinedHere ? '<button class="vm-btn vm-btn-ghost" data-act="play-here">＋ Play on this screen</button>' : ''}`;
  } else if (isDisplay && !havePlayers) {
    // Pure shared screen with nobody yet: offer to play on-screen, or wait for callers.
    action = `<button class="vm-btn" data-act="play-here">Play on this screen ▶</button>
      <div class="vm-dim">…or have players call in to join</div>`;
  } else {
    action = '<div class="vm-dim">Waiting for the host to start…</div>';
  }
  return `<div class="vm-card">
    ${brandHead('VOICE MONSTERS', 'Call in to battle')}
    <div class="vm-chips">${chips}</div>
    ${action}
  </div>`;
}

/** The Twilio brand header used across the menus: logo eyebrow → red wordmark → subtitle. Matches
 *  Voice Racer's scr-head so the two games look like one product. */
function brandHead(title: string, sub: string): string {
  return `<div class="vm-head">
    <div class="vm-eyebrow"><img src="/brand/Twilio_Logo_Bug_White.svg" alt="">Twilio</div>
    <div class="vm-title">${esc(title)}</div>
    <div class="vm-sub">${esc(sub)}</div>
  </div>`;
}

/** The procedural placeholder portrait as a data-URL, cached per monster id. Used as the <img> src
 *  fallback when no real sprite file exists. */
const portraitCache = new Map<string, string>();
function placeholderPortrait(id: string, type: string): string {
  let url = portraitCache.get(id);
  if (!url) {
    try { url = drawMonsterSprite({ id, type: type as never, view: 'front', size: 128 }).toDataURL(); }
    catch { url = ''; }
    portraitCache.set(id, url);
  }
  return url;
}

/** After the select grid mounts, upgrade each portrait <img> to the REAL sprite if one exists: try
 *  the animated GIF, then the static PNG, and leave the procedural placeholder in place if neither
 *  loads. Loading the file directly into an <img> means an animated GIF ANIMATES on the card (unlike
 *  a canvas snapshot). */
function upgradeSelectPortraits(): void {
  overlay.querySelectorAll<HTMLImageElement>('img[data-mon-portrait]').forEach((img) => {
    const id = img.dataset.monPortrait!;
    const urls = spriteCandidateUrls(id, 'front');
    const tryNext = (i: number): void => {
      if (i >= urls.length) return;   // exhausted → keep the placeholder already in src
      const probe = new Image();
      probe.onload = () => { img.src = urls[i]!; };   // real file exists → show it (animates if GIF)
      probe.onerror = () => tryNext(i + 1);
      probe.src = urls[i]!;
    };
    tryNext(0);
  });
}

function monsterSelectHtml(): string {
  const mine = state ? (state.players.find(p => p.playerId === myId)?.monsterId ?? null) : null;
  // MINIMAL cards: portrait + name + type only. (Stats/moves were too much info crammed on a tile.)
  // Portrait starts as the placeholder; upgradeSelectPortraits() swaps in a real GIF/PNG post-mount.
  const cards = roster.map(m => `
    <button class="vm-mon t-${m.type}${mine === m.id ? ' sel' : ''}" data-mon="${m.id}">
      <div class="portrait"><img data-mon-portrait="${m.id}" src="${placeholderPortrait(m.id, m.type)}" alt=""></div>
      <div class="vm-mon-name">${esc(m.name)}</div>
      <div class="vm-type t-${m.type}">${m.type}</div>
    </button>`).join('');
  return `<div class="vm-card wide">
    ${brandHead('CHOOSE YOUR MONSTER', 'Pick your fighter — say its name or tap it')}
    <div class="vm-grid">${cards}</div>
    ${canDrive()
      ? `<button class="vm-btn" data-act="advance">Battle ▶</button>${mine ? '' : '<div class="vm-dim">Pick a monster first (say its name or tap it)</div>'}`
      : '<div class="vm-dim">Say a monster\'s name or tap it.</div>'}
  </div>`;
}

function resultsHtml(): string {
  const w = state?.result?.winnerName ?? 'Nobody';
  return `<div class="vm-card">
    ${brandHead('VOICE MONSTERS', 'Battle complete')}
    <div class="vm-title vm-win" style="font-size:36px">${esc(w)} WINS!</div>
    ${isDisplay || joinedHere ? '<button class="vm-btn" data-act="advance">Rematch ▶</button>' : '<div class="vm-dim">Good battle!</div>'}
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
