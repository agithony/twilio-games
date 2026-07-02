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
import { AmbientFx } from './ambient-fx';
import { battleControlsLegendHtml } from './battle-controls-legend';
import { drawMonsterSprite, typeColor } from './monster-sprite';
import { moveById } from '../../shared/monster-roster';
import { spriteCandidateUrls } from './sprite-sources';
import type { RosterEntry } from '../../shared/battle-protocol';
import type { BattleEvent, BattleAction } from '../../shared/battle-world';
import { effectivenessLabel } from '../../shared/monster-types';
import { matchBattleAction } from '../../shared/battle-intent';

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
const appEl = document.getElementById('app')!;

// The OUTER background FX layer: fills #app AROUND the stage + flashes the attack's color across the
// whole screen. Separate from the 3D arena/stage (those are untouched).
const ambient = new AmbientFx(appEl);

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
let menuLevel: 'root' | 'fight' = 'root';   // two-level command menu: root actions → FIGHT's moves

conn.onRoster((m) => { roster = m; renderOverlay(); });
conn.onJoined((id) => { myId = id; });
conn.onError((code, msg) => console.error(`[battle] ${code}: ${msg}`));
conn.onEvents((events) => queueEvents(events));

conn.onState((m) => {
  const prevPhase = state?.phase;
  state = m;
  // A fresh turn (back to choosing) clears the last locked move + resets the menu to the root actions.
  if (m.snapshot?.phase === 'choosing' && !chosenForMe(m)) { lockedMoveName = null; menuLevel = 'root'; }
  // Leaving results (rematch / reset) drops any pending continue-hold so it can't strand the stage.
  if (m.phase !== 'results') awaitingContinue = false;
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
    if (uiPhase === 'awaiting-input') status = menuLevel === 'fight' ? `${myMon}'s moves:` : `What will ${myMon} do?`;
    else if (uiPhase === 'command-locked') status = `${lockedMoveName ? lockedMoveName + '! ' : ''}Waiting for ${opponentName(state)}…`;
    else if (uiPhase === 'finished') status = state.result ? `${state.result.winnerName} wins!` : '';
  }
  // The foe's type → the renderer shows move pips as effectiveness vs THIS opponent.
  const foeType = state.snapshot ? (mySide(state) === 'b' ? state.snapshot.a.type : state.snapshot.b.type) : null;
  renderer.setMenu(menuLevel, mySide(state) ?? 'a');
  renderer.setState(state.snapshot, mySideMoves(state), uiPhase, status, foeType ?? null);
}

// ── paced event playback ──────────────────────────────────────────────────────────────────────────
let eventQ: BattleEvent[] = [];
function queueEvents(events: BattleEvent[]): void {
  eventQ.push(...events);
  if (!draining) { draining = true; paintBattle(); drainNext(); }
}
let movesSeenThisTurn = 0;      // how many attacks played so far this turn (resets on turn_start)
let pendingHandoff: 'a' | 'b' | null = null;   // a synthetic "▶ X'S TURN" card to show before next move
let awaitingContinue = false;   // battle ended → holding on the arena until the player acknowledges

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
  if (!ev) {
    draining = false; movesSeenThisTurn = 0; renderer.setActiveSide(null);
    // Battle just ended? Don't jump straight to the results modal — hold on the arena with a
    // "▶ Continue" prompt so the win lands, and wait for the player to acknowledge.
    if (state?.phase === 'results') { awaitingContinue = true; renderer.setEventBanner(`${state.result?.winnerName ?? 'Winner'} wins!  ▶ Press Enter / tap`); renderOverlay(); return; }
    paintBattle(); renderOverlay(); return;
  }

  if (ev.kind === 'turn_start') movesSeenThisTurn = 0;
  // Before the SECOND attack of a turn, inject a handoff card announcing the other side's turn.
  if (ev.kind === 'move_used') {
    movesSeenThisTurn++;
    if (movesSeenThisTurn === 2) { pendingHandoff = ev.by; eventQ.unshift(ev); setTimeout(drainNext, 0); return; }
    renderer.setActiveSide(ev.by);
    // Flash the OUTER background in the move's element color (leaves the 3D stage untouched).
    ambient.flash(typeColor(moveById(ev.moveId)?.type ?? 'normal'));
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
    case 'miss':         return 1700;                    // "But it missed!" lands
    case 'damage':       return ev.crit ? 2200 : 1650;   // the hit + HP drop registers
    case 'effectiveness':return 2100;                    // "It's super effective!" lands
    case 'guard':        return 1600;                    // "braced for impact!"
    case 'item':         return 1700;                    // "used a Potion!"
    case 'taunt':        return 1800;                    // "taunts X!"
    case 'heal':         return 1100;                    // HP bar rises (no banner)
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
    case 'miss': return 'But it missed!';
    case 'guard': return `${ev.monsterName} braced for impact!`;
    case 'item': return `${actorName(ev.by)} used a ${ev.itemName}!`;
    case 'taunt': return `${ev.monsterName} taunts ${ev.targetName}!`;
    case 'heal': return null;   // the HP bar rising tells the story; no separate banner
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
  // Also keep it up while AWAITING CONTINUE (battle ended, holding on the win before the results modal).
  const inBattle = phase === 'battle' || draining || awaitingContinue;
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
  // ONE lobby screen, matching Voice Racer: callers dial in and appear as chips; the shared screen can
  // add a KEYBOARD tester with P. Advance ("Choose your monster") once at least one player is in — no
  // separate "play on this screen" step.
  const players = state?.players ?? [];
  const chips = players.map(p => `<span class="vm-chip">${esc(p.name)}${p.monsterId ? ' ✓' : ''}</span>`).join('') || '<span class="vm-dim">Waiting for challengers…</span>';
  const havePlayers = players.length > 0;
  let action: string;
  if (havePlayers && canDrive()) {
    action = `<button class="vm-btn" data-act="advance">Choose your monster ▶</button>`;
  } else if (isDisplay) {
    // Shared screen, nobody in yet: wait for callers, or press P to add a keyboard tester player.
    action = `<div class="vm-dim">Have players call in to join — or press <b>P</b> to play on this screen</div>`;
  } else {
    action = '<div class="vm-dim">Waiting for the host to start…</div>';
  }
  return `<div class="vm-card">
    ${brandHead('VOICE MONSTERS', 'Call in to battle')}
    <div class="vm-chips">${chips}</div>
    ${action}
    ${battleControlsLegendHtml()}
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
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ── connect: display spectates, device joins ─────────────────────────────────────────────────────
// Matches Voice Racer's lobby model: the shared SCREEN defaults to a spectator (callers dial in as
// players), and the operator presses P to add/drop a KEYBOARD TESTER player on this screen. A device
// (phone browser) auto-joins as its own player. `joinedHere` = this client holds a player slot.
let joinedHere = false;
if (isDisplay) conn.spectate(roomCode);
else { conn.join(roomCode, name); joinedHere = true; }

/** Shared-screen P-toggle: opt IN as a keyboard tester player (adds a slot), or opt back OUT (drops it,
 *  stays the display). No-op on a device (already a player). */
function toggleSelfPlaying(): void {
  if (!isDisplay) return;
  if (joinedHere) { conn.leave(roomCode); joinedHere = false; }
  else { conn.join(roomCode, name); joinedHere = true; }
  lastOverlayKey = ''; renderOverlay();
}

// Keyboard: during MY choosing turn the command menu is two levels —
//   root: 1 FIGHT (→ opens the moves) · 2 GUARD · 3 ITEM (Potion) · 4 TAUNT
//   fight: 1–4 pick a move, 0 goes back to root.
// Lobby/select/results: P adds/drops a keyboard tester (shared screen); Enter advances the flow.
addEventListener('keydown', (e) => {
  if (awaitingContinue) { dismissContinue(); return; }   // battle-end hold → any key continues
  if (state?.phase === 'battle' && currentUiPhase() === 'awaiting-input') {
    handleMenuKey(e.key);
  } else if ((e.key === 'p' || e.key === 'P') && isDisplay && state?.phase !== 'battle') {
    toggleSelfPlaying();
  } else if (e.key === 'Enter' && isDisplay && state?.phase !== 'battle') {
    conn.advance();
  }
});
// Tap/click the stage to continue past the battle-end hold (phone-friendly, no keyboard needed).
stageEl.addEventListener('click', () => { if (awaitingContinue) dismissContinue(); });

/** Player acknowledged the win → drop the hold + clear the banner so the results modal appears. */
function dismissContinue(): void {
  awaitingContinue = false;
  renderer.setEventBanner('');
  lastOverlayKey = '';   // force the results overlay to (re)build now that the stage is hidden
  renderOverlay();
}

/** Drive the two-level command menu from a keypress. Thin: it maps keys → the SAME menu-action shape
 *  voice produces (openFight/back/guard/item/taunt/fight-move), then hands off to applyMenuAction so
 *  keyboard + voice share one nav/commit path. */
function handleMenuKey(key: string): void {
  if (!state?.snapshot) return;
  if (menuLevel === 'root') {
    if (key === '1') applyMenuAction({ kind: 'openFight' });
    else if (key === '2') applyMenuAction({ kind: 'guard' });
    else if (key === '3') applyMenuAction({ kind: 'item', item: 'potion' });
    else if (key === '4') applyMenuAction({ kind: 'taunt' });
    return;
  }
  // fight submenu
  if (key === '0' || key === 'Escape') { applyMenuAction({ kind: 'back' }); return; }
  if (/^[1-4]$/.test(key)) {
    const mv = mySnapMoves()[parseInt(key, 10) - 1];
    if (mv) applyMenuAction({ kind: 'fight', moveId: mv.id });
  }
}

/** Drive the same two-level menu from a SPOKEN utterance (Conversation Relay transcript). Voice reuses
 *  the SAME nav/commit path as the keyboard: we run the pure `matchBattleAction` matcher against the
 *  live snapshot (my 4 moves + potions + current level), then hand its result to applyMenuAction.
 *
 *  ── WIRING SEAM ──────────────────────────────────────────────────────────────────────────────────
 *  This is EXPORTED as the client's voice entry point. Twilio ConversationRelay is NOT yet routed to
 *  the /battle rooms (the `/voice` WS in server/http-server.ts binds callers to the RACER game only —
 *  `findOrCreateRoom: (code) => this.game.getOrCreateRoom(code)`). To finish live voice, the server
 *  needs a battle-side transcript path that ultimately reaches THIS function for the shared-screen /
 *  device client. Two follow-up options (either is a small change, both out of scope here — and
 *  server/battle-room.ts must NOT be touched per the current task split):
 *    (a) Client-side speech: feed the browser's SpeechRecognition final transcript here directly, OR
 *    (b) Server relay: add a battle branch to the ConversationRelay adapter that forwards the caller's
 *        transcript over the /battle socket to the room's client(s), which then call this. That needs a
 *        new client→server "voice_utterance"/server→client passthrough message in battle-protocol.ts +
 *        battle-server.ts (NOT battle-room.ts). Until then, this hook is exercised by the pure tests +
 *        can be driven from the console (window.__battleVoice('guard')) for manual verification. */
export function handleVoiceUtterance(text: string): boolean {
  if (state?.phase !== 'battle' || currentUiPhase() !== 'awaiting-input') return false;
  if (!state.snapshot) return false;
  const action = matchBattleAction(text, {
    moves: mySnapMoves().map(m => ({ id: m.id, name: m.name })),
    potions: myPotions(),
    level: menuLevel,
  });
  if (!action) return false;   // unrecognized → caller stays put (server/relay may re-prompt)
  applyMenuAction(action);
  return true;
}
// Expose the voice hook for manual testing + the eventual relay wiring (see the seam note above).
(window as unknown as { __battleVoice?: (t: string) => boolean }).__battleVoice = handleVoiceUtterance;

/** The single nav/commit dispatcher SHARED by keyboard + voice. Nav results (openFight/back) just move
 *  the menu level; the four real actions commit the turn. ITEM is guarded on the potion count here too,
 *  so neither input path can spend a potion the player doesn't have. */
function applyMenuAction(action: BattleAction | { kind: 'openFight' } | { kind: 'back' }): void {
  switch (action.kind) {
    case 'openFight': menuLevel = 'fight'; paintBattle(); return;
    case 'back':      menuLevel = 'root';  paintBattle(); return;
    case 'guard':     commitAction({ kind: 'guard' }, 'Guard!'); return;
    case 'taunt':     commitAction({ kind: 'taunt' }, 'Taunt!'); return;
    case 'item':      if (myPotions() > 0) commitAction({ kind: 'item', item: 'potion' }, 'Potion!'); return;
    case 'fight': {
      const mv = mySnapMoves().find(m => m.id === action.moveId);
      if (mv) commitAction({ kind: 'fight', moveId: mv.id }, mv.name);
      return;
    }
  }
}

/** My monster's current move list from the live snapshot (display/spectator falls back to A's moves,
 *  matching mySideMoves). Shared by the keyboard + voice menu logic. */
function mySnapMoves(): { id: string; name: string }[] {
  const snap = state?.snapshot; if (!snap) return [];
  return (mySide(state!) === 'b' ? snap.b : snap.a).moves.map(m => ({ id: m.id, name: m.name }));
}

/** How many Potions the local player has left (greys out ITEM at 0). */
function myPotions(): number {
  const snap = state?.snapshot; if (!snap) return 0;
  return mySide(state!) === 'b' ? snap.potions.b : snap.potions.a;
}

/** Commit a turn action + show the "locked, waiting…" beat. */
function commitAction(action: BattleAction, lockedLabel: string): void {
  lockedMoveName = lockedLabel;
  conn.chooseAction(action);
  paintBattle();
}

renderOverlay();
