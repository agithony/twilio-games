import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer } from './interpolation';
import { AssetLoader } from './asset-loader';
import { Screens } from './screens';
import type { GlobalEntry } from './screens';
import { renderCarThumbnailsAsync, renderMapThumbnail } from './thumbnails';
import { AttractMode } from './attract';
import { Announcer, browserSpeechSink } from './announcer';
import { fetchMaps, loadMapWorld, applyTrackTransform, CANONICAL_TRACK } from './map-world';
import { CurvedTrack } from './track-path';
import { surfaceOptsFromPath } from './track-surface';
import { mergeLevel, resolveCarScale, resolveItemScale, resolveCamera } from '../shared/level';
import type { GantryOffset } from '../shared/level';

// Game WebSocket URL. In production the page is served by the same origin as the game server
// (behind one HTTPS tunnel), so use the page's protocol+host — wss:// over https avoids a
// mixed-content block. In local dev the page is on Vite (5173/5174) while the server is on 8080,
// so fall back to :8080 only for localhost. An explicit ?ws= override wins for edge setups.
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsOverride = new URLSearchParams(location.search).get('ws');
const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const url = wsOverride
  ?? (isLocalDev ? `${wsProto}://${location.hostname}:8080/game`
                 : `${wsProto}://${location.host}/game`);
const conn = new GameConnection(url);
const input = new KeyboardAdapter();
const assets = new AssetLoader();
const renderer = new Renderer(document.getElementById('app')!, assets);
// Dev-only: expose the renderer for in-browser debugging / headless smoke introspection.
// Guarded to localhost so it never leaks onto a deployed display.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  (window as unknown as { __renderer?: unknown }).__renderer = renderer;
}
// 150ms interpolation delay (was 100): the deployed server broadcasts at ~64ms/snapshot (not the
// ideal 50ms) with some jitter, so 100ms left barely one snapshot of runway → one late packet
// stalled motion. 150ms keeps ~2+ snapshots buffered so playback stays smooth; the buffer also
// extrapolates briefly past the newest snapshot instead of freezing. Small cost: +50ms input-to-
// screen latency, imperceptible vs. the smoothness win.
const buffer = new InterpolationBuffer(150);
const big = document.getElementById('big')!;
const lobbyEl = document.getElementById('lobby')!;
lobbyEl.style.display = 'none';   // legacy overlay retired; the Screens overlay handles pre/post-race
// SSB-style front-end (lobby → car grid → map select → results). Host actions go back to the server.
const screens = new Screens(document.getElementById('app')!, {
  onAdvance: () => { enableHost(); conn.advance(); },
  onBack: () => conn.back(),
});

const roomCode = new URLSearchParams(location.search).get('room') ?? '4821';
const name = new URLSearchParams(location.search).get('name') ?? 'You';
const urlMap = new URLSearchParams(location.search).get('map');   // legacy/manual override (?map=)
const isDisplay = new URLSearchParams(location.search).get('display') === '1';
// Garage / car viewer: ?garage=1 shows one car at a time (← → to cycle models) at its real
// per-level size, so you can inspect/test cars without starting a race. No server needed.
const isGarage = new URLSearchParams(location.search).get('garage') === '1';

let started = false;
let raceLive = false;
// Shared screen only: whether the operator has opted IN to also play on this keyboard (P toggle).
// Default false = pure spectator display.
let displayIsPlaying = false;
// Current pre-race phase + map choices, tracked from server messages so number-key input knows
// whether a typed digit means "pick car N" or "pick map N".
let flowPhase: 'lobby' | 'car_select' | 'map_select' | 'other' = 'lobby';
let flowMaps: string[] = [];
let typedDigits = '';
let typedPhase: 'car_select' | 'map_select' | null = null;   // the phase when accumulation STARTED
let typedTimer: ReturnType<typeof setTimeout> | null = null;

/** Keyboard digit input → select_car / select_map by number (stands in for SMS car/map picks).
 *  Multi-digit aware (e.g. "15"): accumulates briefly, then commits on a short pause. The pick is
 *  bound to the phase that was active when typing started — so a digit typed during car_select can't
 *  misfire as a map pick if the phase flips before the 450ms commit. */
function bindFlowDigits(): void {
  addEventListener('keydown', (e) => {
    if (flowPhase !== 'car_select' && flowPhase !== 'map_select') return;
    if (!/^[0-9]$/.test(e.key)) return;
    if (typedPhase !== flowPhase) { typedDigits = ''; typedPhase = flowPhase; }   // phase changed → reset
    typedDigits += e.key;
    if (typedTimer) clearTimeout(typedTimer);
    typedTimer = setTimeout(commitTypedDigits, 450);
  });
}
function commitTypedDigits(): void {
  const n = parseInt(typedDigits, 10); const phase = typedPhase;
  typedDigits = ''; typedPhase = null;
  if (!Number.isFinite(n) || n < 1) return;
  if (phase !== flowPhase) return;                                // phase moved on — drop the stale pick
  if (phase === 'car_select') conn.selectCar(n - 1);             // tiles are 1-based on screen
  else if (phase === 'map_select') { const m = flowMaps[n - 1]; if (m) conn.selectMap(m); }
}

// AI announcer: speaks commentary (host audio) and feeds the ticker HUD.
const tickerEl = document.getElementById('ticker')!;
function pushLine(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  div.style.cssText = 'background:rgba(16,22,40,.85);color:#e8ecf6;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;font-size:13px';
  tickerEl.prepend(div);
  while (tickerEl.children.length > 5) tickerEl.lastChild!.remove();
  setTimeout(() => div.remove(), 6000);
}
const announcer = new Announcer({ sink: browserSpeechSink(), onLine: pushLine });
// Start muted-safe; unlock audio on the first user gesture (Enter-to-start counts).
announcer.setMuted(true);
let hostOn = false;
function enableHost() { if (!hostOn) { hostOn = true; announcer.setMuted(false); } }
const muteBtn = document.getElementById('mute') as HTMLButtonElement;
muteBtn.addEventListener('click', () => {
  hostOn = !hostOn; announcer.setMuted(!hostOn);
  muteBtn.textContent = hostOn ? 'Host: on' : 'Host: off';
});

// Bumped on every phase change so an in-flight async (e.g. the leaderboard fetch) can tell whether
// the flow has moved on before it resolves — preventing a stale render from resurrecting a screen.
let flowEpoch = 0;

// Boot veil: an opaque branded cover over the 3D scene ASSEMBLING (map load → camera settle → first
// attract frames), so the user never sees the connecting→world→top-down→cars cut sequence. We lift
// it only after attract has painted a few stable frames (scene + camera settled), with a safety
// timeout so it can never hang. Once lifted it stays gone.
const veilEl = document.getElementById('veil')!;
let veilLifted = false;
let assetsReady = false;    // manifest (car GLBs) + backdrop map applied (set by loadAssetsInBackground)
let wantAttract = false;    // a menu screen wants the demo running (gated until assetsReady)
let attractFrames = 0;
function liftVeil() { if (veilLifted) return; veilLifted = true; veilEl.classList.add('hide'); }
setTimeout(liftVeil, 8000);   // safety: never trap the user behind the veil

// Attract mode: live autopilot gameplay behind the glass menu. Runs whenever a menu screen is up
// and no real race is live; the renderer's spectator/field camera frames the AI pack automatically.
// Lift the veil only after attract has painted a few settled frames — by which point models + map
// are loaded (attract doesn't START until assetsReady), so the reveal shows REAL cars on the neon
// track, never primitive boxes mid-assembly.
const attract = new AttractMode((snap) => {
  renderer.render(snap);
  // Keep the veil up through the renderer's stuttery warmup (shader compile, shadow-map init, first
  // dt spikes). ~30 smooth frames behind the veil → the reveal is a steady scene, not the jank.
  if (!veilLifted && ++attractFrames >= 30) liftVeil();
});
function startAttract() {
  if (raceLive) return;
  wantAttract = true;
  // Don't show the demo until car MODELS + map are loaded — otherwise ensureCar caches primitive
  // BOXES for the demo ids and they never upgrade. The boot veil covers this wait. Once assets are
  // ready, maybeStartAttract() kicks it off.
  if (assetsReady) reallyStartAttract();
}
function reallyStartAttract() {
  if (raceLive || attract.isRunning) return;
  renderer.clearCars();          // drop any leftover real-race cars before the demo populates its own
  renderer.setSpectator(true);   // the demo has no "my car" → use the pack/field camera
  attract.start();
}
function stopAttract() {
  wantAttract = false;
  if (attract.isRunning) { attract.stop(); renderer.clearCars(); }   // remove the demo cars so they
                                                                     // don't sit frozen during the race
  renderer.setSpectator(isDisplay);   // back to the player's chase cam (or stay spectator on a display)
}

conn.onItems((items, map) => {
  // The server tells us which level THIS race uses (chosen in the lobby). Load it before building
  // items so the map world, curve path, per-car/per-item scales, camera, lighting all apply. The
  // host display has no ?map= URL param, so without this the level + scales were never applied.
  void applyLevel(map ?? urlMap).then(() => renderer.buildItems(items));
});
conn.onSnapshot((s) => {
  raceLive = true; flowPhase = 'other'; flowEpoch++; stopAttract();   // real race takes over the canvas
  screens.hide(); big.textContent = ''; started = true; buffer.push(s, performance.now());
});
conn.onLobby((m) => {
  if (raceLive) return;                       // race already running; ignore stale lobby
  flowPhase = 'lobby'; flowEpoch++; big.textContent = '';
  screens.renderLobby(m.roomCode, m.players); startAttract();
});
conn.onSelectState((m) => {
  raceLive = false; flowEpoch++; big.textContent = '';
  if (m.phase === 'car_select') { flowPhase = 'car_select'; screens.renderCarSelect(m.players); }
  else if (m.phase === 'map_select') { flowPhase = 'map_select'; flowMaps = m.maps; screens.renderMapSelect(m.maps, m.selectedMap, m.players); }
  startAttract();
});
// Cache the last-fetched all-time board (keyed by map) so REPEAT results broadcasts (~2x/s) re-render
// WITH the board already in place. Without this, each broadcast rendered first WITHOUT the board, then
// the async fetch re-rendered WITH it — so the dedup key flip-flopped twice a second and the whole
// scoreboard rebuilt (animations replayed) = the flicker. With the cache, once the board is known the
// screen renders the same (board-included) view every broadcast → the dedup guard holds → no flicker.
let lastBoard: { map: string | null; entries: GlobalEntry[] } | null = null;
conn.onResults((m) => {
  raceLive = false; flowPhase = 'other'; const epoch = ++flowEpoch; big.textContent = '';
  startAttract();
  // Render with the cached board if it's for THIS map (so a repeat broadcast doesn't strip it back to
  // the race-only view); otherwise show race-only until the fetch lands the board (one fold-in).
  const cached = lastBoard && lastBoard.map === m.map ? lastBoard : undefined;
  screens.renderResults(m.results, (i) => assets.carName(i), cached);
  const q = m.map ? `?map=${encodeURIComponent(m.map)}&limit=10` : '?limit=10';
  fetch(`/api/leaderboard${q}`)
    .then(r => r.ok ? r.json() : { entries: [] })
    .then((data) => {
      lastBoard = { map: m.map, entries: data.entries ?? [] };
      if (epoch === flowEpoch) screens.renderResults(m.results, (i) => assets.carName(i), lastBoard);
    })
    .catch(() => { /* keep whatever view is up */ });
});
conn.onEvent((e) => {
  announcer.handle(e);
  if (e.kind === 'countdown') big.textContent = String(e.n);
  else if (e.kind === 'go') { big.textContent = 'GO!'; setTimeout(() => (big.textContent = ''), 900); }
  // On the host display, tell the operator how to start a FRESH race (a new procedural course).
  // Enter and R both reroll the per-race seed; mid-race those are ignored by the server.
  else if (e.kind === 'race_over') big.textContent = isDisplay ? 'Finish — press ENTER for a new course' : 'Finish';
});
conn.onError((code, message) => {
  console.error(`Server error [${code}]: ${message}`);
  big.textContent = message;
});

const GANTRY_FILES = { start: 'starting_line.glb', finish: 'finish_line.glb' };
/** The map currently loaded into the renderer, so applyLevel() can skip redundant reloads. */
let loadedMap: string | null = null;

/**
 * Load a level (map world + curve + per-level car/item scale + camera + lighting/effects + gantries)
 * into the renderer. Called at boot for a ?map= override AND on every race start with the map the
 * lobby chose (the server sends it on the `items` message) — the host display has no ?map= param, so
 * this is the ONLY way its chosen level + per-car scales get applied. Idempotent per map name.
 */
async function applyLevel(mapName: string | null | undefined): Promise<void> {
  // No map (or unchanged): just (re)place gantries on whatever track is current and bail.
  if (!mapName) { renderer.setStartFinishLines(GANTRY_FILES, {}); return; }
  if (mapName === loadedMap) return;
  let gantryOffsets: { start?: GantryOffset; finish?: GantryOffset } = {};
  try {
    const maps = await fetchMaps();
    const cfg = maps[mapName];
    if (cfg) {
      // Normalize the saved config into a full level (fills defaults; optional lighting/effects/props).
      const level = mergeLevel(cfg);
      const world = await loadMapWorld(cfg);
      if (world) renderer.setMapWorld(world);
      // Race stays in canonical sim space; the map's saved transform places the scenery.
      applyTrackTransform(renderer.getTrackGroup(), CANONICAL_TRACK);
      // Render-only curved path: cars/items/camera follow the curve; the sim stays straight.
      renderer.setPath(level.path ? new CurvedTrack(level.path) : null, surfaceOptsFromPath(level.path));
      renderer.setLighting(level.lighting ?? null);
      renderer.setEffects(level.effects ?? null);
      renderer.setProps(level.props);
      // Per-level car sizing keyed by MODEL FILENAME (the editor Cars panel's key); per-item scale.
      renderer.setCarScale((i) => resolveCarScale(level, assets.carFile(i) ?? String(i)));
      renderer.setItemScale((kind) => resolveItemScale(level, kind));
      renderer.setCamera(resolveCamera(level));
      gantryOffsets = { start: level.startLine, finish: level.finishLine };
      loadedMap = mapName;
    }
  } catch { /* keep the generated track */ }
  // Bookend the track AFTER setPath so the gantry auto-fits the level's track width.
  renderer.setStartFinishLines(GANTRY_FILES, gantryOffsets);
}

/** Load GLB templates + per-level config + car-grid thumbnails OFF the critical path, so the menu
 *  is interactive immediately. Names appear at once; portraits stream in one per frame. */
async function loadAssetsInBackground(): Promise<void> {
  try { await assets.loadManifest(); } catch { /* primitives — game still runs */ }
  // Friendly names are cheap → publish them now so the car grid has labels right away.
  try { screens.setCarCatalog(assets.carNames(), []); } catch { /* no manifest */ }
  // Load a map for the backdrop: an explicit ?map= wins; otherwise grab the first authored map so
  // the attract-mode demo races a real neon track (not the bare generated straight). The race itself
  // re-applies the lobby's chosen map on start (via onItems), so this is just the menu backdrop.
  try {
    let bg = urlMap;
    if (!bg) { try { bg = Object.keys(await fetchMaps())[0] ?? null; } catch { bg = null; } }
    await applyLevel(bg);
  } catch { /* keep generated track */ }
  // Models + map are loaded → NOW the attract demo can show real cars on the real track. If a menu
  // already asked for it (wantAttract), kick it off; otherwise startAttract() will once a screen needs it.
  assetsReady = true;
  if (wantAttract) reallyStartAttract();

  // Portraits: render after the attract reveal has SETTLED (its first ~1.5s of frames are the
  // stuttery warmup — shader compile, shadow-map init), so the heavy per-car renders don't fight the
  // demo's opening animation. WAIT for the car GLBs to finish streaming in first (loadManifest now
  // resolves before they're all loaded, so the menu/background show fast) — snapshotting a half-
  // loaded template would render a primitive. renderCarThumbnailsAsync paces to main-thread idle.
  await new Promise(r => setTimeout(r, 1500));
  try { await assets.carsReady; } catch { /* some cars may stay primitive */ }
  try {
    await renderCarThumbnailsAsync(assets, (i, url) => screens.setCarThumb(i, url));
  } catch { /* placeholders remain */ }

  // Map previews LAST (heaviest — full scenery GLBs): render each authored map's 3D world to a tile
  // image so the map-select screen shows what the track looks like, not a blank card. Pace each one
  // to main-thread idle so a big scenery render can't hitch the attract demo.
  try {
    const maps = await fetchMaps();
    const previews: Record<string, string> = {};
    for (const [name, cfg] of Object.entries(maps)) {
      await whenIdle();
      const url = await renderMapThumbnail(cfg);
      if (url) previews[name] = url;
    }
    screens.setMapPreviews(previews);
  } catch { /* tiles fall back to the placeholder */ }
}

/** Resolve when the main thread is idle (so heavy background renders yield to the live attract demo).
 *  requestIdleCallback where available (timeout-bounded so we never starve), else a double-rAF. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 300 });
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function boot() {
  if (isGarage) {
    // The car/model viewer moved to its own page (/garage) — redirect old ?garage=1 links there.
    location.href = '/garage';
    return;
  }
  // Hide the in-game HUD until a real race starts — the menu (or the connecting beat) is the focus.
  document.body.classList.add('in-menu');

  // CONNECT FIRST. The menu must appear the instant the server replies to join — so we wire the
  // listeners + join NOW, BEFORE the heavy asset work below. Previously join() ran only AFTER
  // awaiting loadManifest() (19 GLBs + Draco) and a synchronous 19-car thumbnail render, which is
  // why the screen sat blank (with just the static HUD) for a second or more.
  conn.onJoined((playerId) => { renderer.setMyId(playerId); });
  input.onIntent((i) => { if (!screens.isVisible) conn.sendIntent(i); });
  if (isDisplay) renderer.setSpectator(true);
  screens.bindHostKeys();   // ← back · → / Enter advance (only while a screen is visible)
  bindFlowDigits();          // 1-9 select a car/map by number (stands in for SMS)
  addEventListener('keydown', (e) => {
    if (screens.isVisible) return;             // flow keys handled by screens.bindHostKeys
    if (e.key === 'r') conn.restart();
    else if (e.key === 'Enter') { enableHost(); conn.ready(); }
  });
  // The shared screen SPECTATES by default (occupies no roster slot, gets no car) — it's the display,
  // not a player. It can still drive the whole flow (ready/advance/back/restart/select_map key off the
  // connection's room, not a playerId), so the game starts with ZERO players and fills up as people
  // call in. A device player join()s with their own name + gets a car.
  if (isDisplay) conn.spectate(roomCode);
  else conn.join(roomCode, name);

  // SHARED-SCREEN "I'm playing" TOGGLE (P): the screen defaults to spectator, but the operator can
  // opt IN to also play on this keyboard (joins as a real player + car), and opt back OUT (drops the
  // slot, stays the display). Keeps the screen unambiguous — it's a spectator unless you say otherwise.
  if (isDisplay) {
    addEventListener('keydown', (e) => {
      if (e.key !== 'p' && e.key !== 'P') return;
      if (displayIsPlaying) { conn.leave(); renderer.setMyId(''); renderer.setSpectator(true); displayIsPlaying = false; }
      else { conn.join(roomCode, name); displayIsPlaying = true; }   // onJoined sets myId → chase cam
      screens.setSelfPlaying(displayIsPlaying);
    });
  }

  // Heavy asset work happens in the BACKGROUND (off the critical path). The lobby is already up;
  // the race only needs these once someone starts, and the car grid fills in progressively.
  void loadAssetsInBackground();

  function frame() {
    requestAnimationFrame(frame);
    // Attract mode owns the canvas while it runs (its own rAF renders the demo) — don't double-render.
    if (attract.isRunning) { big.textContent = ''; return; }
    const snap = buffer.sample(performance.now());
    if (snap) renderer.render(snap);
    // Before the first server message (and before attract starts), show a branded waiting beat.
    else if (!started && !screens.isVisible) big.textContent = 'Connecting…';
    else if (screens.isVisible) big.textContent = '';
  }
  requestAnimationFrame(frame);
}

void boot();
