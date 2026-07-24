import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer } from './interpolation';
import { countdownDisplay, isCountdownSoundCue } from '../shared/countdown';
import { AssetLoader } from './asset-loader';
import { Screens } from './screens';
import type { GlobalEntry } from './screens';
import { renderCarThumbnailsAsync, renderMapThumbnail, renderBoostThumbnail } from './thumbnails';
import { AttractMode } from './attract';
import { Announcer } from './announcer';
import QRCode from 'qrcode';
import { fetchMaps, loadMapWorld, applyTrackTransform, CANONICAL_TRACK } from './map-world';
import { CurvedTrack } from './track-path';
import { surfaceOptsFromPath } from './track-surface';
import { mergeLevel, resolveCarScale, resolveItemScale, resolveCamera } from '../shared/level';
import type { GantryOffset } from '../shared/level';
import { hudStateFor } from './hud-state';
import { BOOST_MAX, BOOST_MIN, DEFAULT_ROOM } from '../shared/constants';
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';
import { getSoundEffectsManager } from './sound-effects';
import { commonText, locale } from './i18n';
import { RACER_MESSAGES, type RacerMessageKey } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';
import { carName as localizedCarName } from '../shared/i18n/content';
import { createStationDisplay } from './station-display';
import { stationJoinUrl, watchVoiceNumber } from './station-client';

const text = createTranslator(locale, RACER_MESSAGES);

function setText(id: string, key: RacerMessageKey): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text(key);
}

function localizeStaticPage(): void {
  document.title = text('game.title');
  document.querySelector('.game-home')?.setAttribute('aria-label', commonText('navigation.homeAria'));
  const homeLabel = document.querySelector('.game-home > span');
  if (homeLabel) homeLabel.textContent = commonText('navigation.home');
  setText('veil-title', 'game.title');
  setText('hud-title', 'game.title');
  setText('hint-shout', 'hud.shout');
  setText('hint-left', 'hud.command.left');
  setText('hint-right', 'hud.command.right');
  setText('hint-boost', 'hud.command.boost');
  setText('hint-brake', 'hud.command.brake');
  setText('hint-nitro', 'hud.command.nitro');
  setText('gPowerLabel', 'hud.power.readyInitial');
  document.getElementById('gBoost')?.setAttribute('title', text('hud.boostBrakeTitle'));
}

localizeStaticPage();
const stationDisplay = createStationDisplay();
// Game WebSocket URL. Production is same-origin; local Vite proxies /game to GAME_SERVER_URL.
// An explicit ?ws= override still wins for edge setups.
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsOverride = new URLSearchParams(location.search).get('ws');
const url = wsOverride ?? `${wsProto}://${location.host}/game`;
const conn = new GameConnection(url, locale);
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

// Inject music toggle button
injectMusicToggle('music-toggle-container');
const musicToggle = document.getElementById('music-toggle');
function localizeMusicToggle(): void {
  if (!musicToggle) return;
  musicToggle.title = commonText('music.toggleTitle');
  musicToggle.setAttribute('aria-label', commonText('music.toggleAria'));
  const label = musicToggle.querySelector<HTMLElement>('.music-toggle-label');
  if (label) label.textContent = commonText(musicToggle.getAttribute('aria-pressed') === 'true' ? 'music.on' : 'music.off');
}
localizeMusicToggle();
musicToggle?.addEventListener('click', localizeMusicToggle);

// ── Personal in-race gauge (power charge + boost/brake bar) ──────────────────────────────────────
// Painted each frame from the LOCAL player's car (hud-state.ts decides show/hide). On a shared
// spectator display there's no local car → hudStateFor returns {show:false} → the gauge stays hidden,
// so it's never an ambiguous "whose power?" distraction with several phone players watching.
const gaugeEl = document.getElementById('gauge')!;
const gPowerEl = document.getElementById('gPower')!;
const gPowerLabel = document.getElementById('gPowerLabel')!;
const gOrbEl = document.getElementById('gOrb') as HTMLElement;
const gBoostEl = document.getElementById('gBoost')!;
const gBoostFill = document.getElementById('gBoostFill') as HTMLElement;
/** Paint the rendered boost-orb model into the gauge's power chip (called once the thumbnail lands).
 *  Until then the chip has no icon and the label alone carries the meaning. */
function setOrbThumb(url: string): void {
  gOrbEl.style.backgroundImage = `url("${url}")`;
  gOrbEl.classList.add('has-orb');
}
function paintGauge(snap: import('../shared/types').WorldSnapshot | null): void {
  const h = hudStateFor(snap, renderer.myPlayerId());
  gaugeEl.classList.toggle('show', h.show);
  if (!h.show) return;
  // Power chip: READY (gold, armed) → ACTIVE (cyan, firing) → spent ("grab a pad"). The icon is the
  // real orb model (setOrbThumb), so the label doesn't need to describe it.
  gPowerEl.classList.toggle('ready', !!h.powerReady);
  gPowerEl.classList.toggle('active', !!h.powerActive);
  // ACTIVE = the invulnerable dash is firing ("SMASH!"); READY = one or more banked charges (show the
  // count + prompt to say "power"); else empty → go grab an orb.
  const charges = h.charges ?? 0;
  gPowerLabel.textContent = h.powerActive
    ? text('hud.power.active')
    : h.powerReady
      ? text('hud.power.ready', { charges })
      : text('hud.power.empty');
  // Boost bar: fill from center — right/green when boosting, left/red when braking. Normalize the
  // boost modifier against its sim bounds so the bar caps out exactly when the sim does.
  const b = h.boost ?? 0;
  const braking = b < 0;
  const frac = Math.min(1, Math.abs(b) / (braking ? Math.abs(BOOST_MIN) : BOOST_MAX));
  gBoostEl.classList.toggle('braking', braking);
  gBoostFill.style.width = `${(frac * 50).toFixed(1)}%`;   // half-width max (fills its side of center)
  gBoostFill.style.left = braking ? `${(50 - frac * 50).toFixed(1)}%` : '50%';
  if (h.stunned) { gaugeEl.classList.remove('stun'); void gaugeEl.offsetWidth; gaugeEl.classList.add('stun'); }
}
lobbyEl.style.display = 'none';   // legacy overlay retired; the Screens overlay handles pre/post-race
// SSB-style front-end (lobby → car grid → map select → results). Host actions go back to the server.
const screens = new Screens(document.getElementById('app')!, {
  onAdvance: () => { if (!stationDisplay.active || flowPhase !== 'results') conn.advance(); },
  onBack: () => conn.back(),
}, locale);

const roomCode = new URLSearchParams(location.search).get('room') ?? DEFAULT_ROOM;
const name = new URLSearchParams(location.search).get('name') ?? text('player.you');
const urlMap = new URLSearchParams(location.search).get('map');   // legacy/manual override (?map=)
const isDisplay = new URLSearchParams(location.search).get('display') === '1';
// Garage / car viewer: ?garage=1 shows one car at a time (← → to cycle models) at its real
// per-level size, so you can inspect/test cars without starting a race. No server needed.
const isGarage = new URLSearchParams(location.search).get('garage') === '1';

let started = false;
let raceLive = false;
let countdownSoundPlayed = false;  // Track if countdown sound has been played this race
let lastLobbyPlayerCount = 0;     // Track player count to detect new joins
// Shared screen only: whether the operator has opted IN to also play on this keyboard (P toggle).
// Default false = pure spectator display.
let displayIsPlaying = false;
// Current pre-race phase + map choices, tracked from server messages so number-key input knows
// whether a typed digit means "pick car N" or "pick map N".
let flowPhase: 'lobby' | 'car_select' | 'map_select' | 'results' | 'other' = 'lobby';
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

// Visual commentary ticker only. Browser speechSynthesis sounded robotic on the shared display;
// caller audio remains owned by Conversation Relay.
const tickerEl = document.getElementById('ticker')!;
function pushLine(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  div.style.cssText = 'background:rgba(16,22,40,.85);color:#e8ecf6;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;font-size:13px';
  tickerEl.prepend(div);
  while (tickerEl.children.length > 5) tickerEl.lastChild!.remove();
  setTimeout(() => div.remove(), 6000);
}
const announcer = new Announcer({ sink: null, onLine: pushLine, locale });

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
let stationEngineStateReady = false;
function maybeMarkStationReady(): void {
  if (assetsReady && stationEngineStateReady) stationDisplay.markEngineReady();
}
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
  stationEngineStateReady = true; maybeMarkStationReady();
  raceLive = true; flowPhase = 'other'; flowEpoch++; stopAttract();   // real race takes over the canvas
  if (s.phase === 'racing' && !started) {
    getMusicManager().switchContext('racer');
  }
  started = true; buffer.push(s, performance.now());
  // The moment the game STARTS (countdown or racing), drop the menu overlay entirely so the 3-2-1
  // plays full-screen and unobstructed. The controls legend lives in the LOBBY (pre-start) only —
  // by the time the countdown runs, players have already read it; covering the countdown with it
  // was wrong. The big number is painted from the snapshot in the frame loop.
  screens.hide(); if (s.phase !== 'countdown') big.textContent = '';
});
conn.onLobby((m) => {
  stationEngineStateReady = true; maybeMarkStationReady();
  if (raceLive) return;                       // race already running; ignore stale lobby
  flowPhase = 'lobby'; flowEpoch++; big.textContent = '';
  getMusicManager().switchContext('lobby');
  // Play select sound when a new player joins
  if (m.players.length > lastLobbyPlayerCount && lastLobbyPlayerCount > 0) {
    getSoundEffectsManager().playSelect();
  }
  lastLobbyPlayerCount = m.players.length;
  screens.renderLobby(m.roomCode, m.players); startAttract();
});
conn.onSelectState((m) => {
  stationEngineStateReady = true; maybeMarkStationReady();
  raceLive = false; flowEpoch++; big.textContent = '';
  if (m.phase === 'car_select') { flowPhase = 'car_select'; screens.renderCarSelect(m.players); }
  else if (m.phase === 'map_select') { flowPhase = 'map_select'; flowMaps = m.maps; screens.renderMapSelect(m.maps, m.selectedMap, m.players, { counts: m.mapVotes ?? {}, tie: m.mapTie ?? false }); }
  startAttract();
});
// Cache the last-fetched all-time board (keyed by map) so REPEAT results broadcasts (~2x/s) re-render
// WITH the board already in place. Without this, each broadcast rendered first WITHOUT the board, then
// the async fetch re-rendered WITH it — so the dedup key flip-flopped twice a second and the whole
// scoreboard rebuilt (animations replayed) = the flicker. With the cache, once the board is known the
// screen renders the same (board-included) view every broadcast → the dedup guard holds → no flicker.
let lastBoard: { map: string | null; entries: GlobalEntry[] } | null = null;
conn.onResults((m) => {
  stationDisplay.markEngineResultsReady();
  stationEngineStateReady = true; maybeMarkStationReady();
  raceLive = false; flowPhase = 'results'; const epoch = ++flowEpoch; big.textContent = '';
  getMusicManager().switchContext('leaderboard');
  startAttract();
  // Render with the cached board if it's for THIS map (so a repeat broadcast doesn't strip it back to
  // the race-only view); otherwise show race-only until the fetch lands the board (one fold-in).
  const cached = lastBoard && lastBoard.map === m.map ? lastBoard : undefined;
  screens.renderResults(m.results, (i) => localizedCarName(locale, assets.carName(i)), cached);
  const q = m.map ? `?map=${encodeURIComponent(m.map)}&limit=10` : '?limit=10';
  fetch(`/api/leaderboard${q}`)
    .then(r => r.ok ? r.json() : { entries: [] })
    .then((data) => {
      lastBoard = { map: m.map, entries: data.entries ?? [] };
      if (epoch === flowEpoch) screens.renderResults(m.results, (i) => localizedCarName(locale, assets.carName(i)), lastBoard);
    })
    .catch(() => { /* keep whatever view is up */ });
});
conn.onEvent((e) => {
  announcer.handle(e);
  const sfx = getSoundEffectsManager();

  if (e.kind === 'countdown') {
    big.textContent = countdownDisplay(e.n, locale);
    // The audio clip says "3, 2, 1, go", so start it on the visible numeric 3 beat,
    // not during the staged "On your mark / Get ready / Get set" lead-in.
    if (locale === 'en-US' && isCountdownSoundCue(e.n) && !countdownSoundPlayed) {
      countdownSoundPlayed = true;
      sfx.playCountdown();
    }
  } else if (e.kind === 'go') {
    big.textContent = text('hud.go');
    setTimeout(() => (big.textContent = ''), 900);
  } else if (e.kind === 'hit') {
    sfx.playCrash();
  } else if (e.kind === 'boost_taken') {
    sfx.playPowerUp();
  } else if (e.kind === 'car_picked' || e.kind === 'map_picked') {
    sfx.playSelect();
  } else if (e.kind === 'race_over') {
    big.textContent = isDisplay ? '' : '';
    countdownSoundPlayed = false;  // Reset for next race
  }
});
conn.onError((code, message) => {
  console.error(`Server error [${code}]: ${message}`);
  big.textContent = text(code === 'room_full' ? 'error.roomFull' : 'error.generic');
});

const GANTRY_FILES = { start: 'racer/track/starting_line.glb', finish: 'racer/track/finish_line.glb' };
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
  try { screens.setCarCatalog(assets.carNames().map(name => localizedCarName(locale, name)), []); } catch { /* no manifest */ }
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
  maybeMarkStationReady();
  if (wantAttract) reallyStartAttract();

  // Portraits: render after the attract reveal has SETTLED (its first ~1.5s of frames are the
  // stuttery warmup — shader compile, shadow-map init), so the heavy per-car renders don't fight the
  // demo's opening animation. WAIT for the car GLBs to finish streaming in first (loadManifest now
  // resolves before they're all loaded, so the menu/background show fast) — snapshotting a half-
  // loaded template would render a primitive. renderCarThumbnailsAsync paces to main-thread idle.
  await new Promise(r => setTimeout(r, 1500));
  try { await assets.carsReady; } catch { /* some cars may stay primitive */ }
  // Boost-orb image: shoot the real pad model once, then show it in the HUD gauge + lobby legend so
  // players learn what the glowing orbs on the track actually are (was a generic ⚡ emoji). '' → the
  // gauge/legend keep a plain text label (no broken image).
  try {
    const orb = renderBoostThumbnail(assets);
    if (orb) { setOrbThumb(orb); screens.setBoostThumb(orb); }
  } catch { /* keep text-only nitro label */ }
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
    else if (e.key === 'Enter') { conn.ready(); }
  });
  // The shared screen SPECTATES by default (occupies no roster slot, gets no car) — it's the display,
  // not a player. It can still drive the whole flow (ready/advance/back/restart/select_map key off the
  // connection's room, not a playerId), so the game starts with ZERO players and fills up as people
  // call in. A device player join()s with their own name + gets a car.
  if (isDisplay) conn.spectate(roomCode, stationDisplay.displayToken ?? undefined);
  else conn.join(roomCode, name);

  // SHARED-SCREEN "I'm playing" TOGGLE (P): the screen defaults to spectator, but the operator can
  // opt IN to also play on this keyboard (joins as a real player + car), and opt back OUT (drops the
  // slot, stays the display). Keeps the screen unambiguous — it's a spectator unless you say otherwise.
  if (isDisplay && !stationDisplay.active) {
    addEventListener('keydown', (e) => {
      if (e.key !== 'p' && e.key !== 'P') return;
      if (displayIsPlaying) { conn.leave(); renderer.setMyId(''); renderer.setSpectator(true); displayIsPlaying = false; }
      else { conn.join(roomCode, name); displayIsPlaying = true; }   // onJoined sets myId → chase cam
      screens.setSelfPlaying(displayIsPlaying);
    });
  }

  // Fetch the join phone number (server config) so the lobby QR + copy show the real number. Fire-
  // and-forget: the lobby renders immediately with a placeholder and re-renders when this lands.
  let phoneQrGeneration = 0;
  const stopVoiceNumberUpdates = watchVoiceNumber(locale, async number => {
    const generation = ++phoneQrGeneration;
    if (!number) { screens.setPhoneNumber('', '/brand/join-qr.png?v=2'); return; }
    try {
      const qr = await QRCode.toDataURL(`tel:${number}`, {
        width: 520, margin: 1, color: { dark: '#000D25', light: '#FFFFFF' }, errorCorrectionLevel: 'M',
      });
      if (generation === phoneQrGeneration) screens.setPhoneNumber(number, qr);
    } catch {
      if (generation === phoneQrGeneration) screens.setPhoneNumber(number, '/brand/join-qr.png?v=2');
    }
  });
  addEventListener('pagehide', stopVoiceNumberUpdates, { once: true });
  void fetch('/api/arcade/config/public').then(r => r.ok ? r.json() : null).then(async cfg => {
    if (!cfg || stationDisplay.active || cfg.arcade?.mode === 'off' || typeof cfg.arcade?.cabinetId !== 'string') return;
    const qr = await QRCode.toDataURL(stationJoinUrl(cfg.arcade.cabinetId, locale), {
      width: 520, margin: 1, color: { dark: '#000D25', light: '#FFFFFF' }, errorCorrectionLevel: 'M',
    });
    screens.setArcadeQr(qr);
  }).catch(() => { /* Station mode stays optional. */ });

  // Heavy asset work happens in the BACKGROUND (off the critical path). The lobby is already up;
  // the race only needs these once someone starts, and the car grid fills in progressively.
  void loadAssetsInBackground();

  let lastPowerActive: Set<string> = new Set();  // Track which cars have active power for SFX

  function frame() {
    requestAnimationFrame(frame);
    // Attract mode owns the canvas while it runs (its own rAF renders the demo) — don't double-render.
    if (attract.isRunning) { big.textContent = ''; paintGauge(null); return; }
    const snap = buffer.sample(performance.now());
    if (snap) {
      renderer.render(snap);
      // Keep the big countdown number visible even though the "Get Ready" overlay is up; clear it
      // once racing starts (GO! is set by the event handler and self-clears).
      if (snap.phase === 'countdown') big.textContent = countdownDisplay(snap.countdown, locale);

      // Detect power/nitro activation for SFX — play turbo sound for any car that just activated
      for (const car of snap.cars) {
        if (car.powerActive > 0 && !lastPowerActive.has(car.id)) {
          getSoundEffectsManager().playTurbo();
          break; // One sound per frame is enough
        }
      }
      const nowActive = new Set<string>();
      for (const car of snap.cars) {
        if (car.powerActive > 0) nowActive.add(car.id);
      }
      lastPowerActive = nowActive;
    }
    // Before the first server message (and before attract starts), show a branded waiting beat.
    else if (!started && !screens.isVisible) big.textContent = `${commonText('connection.connecting')}…`;
    else if (screens.isVisible) big.textContent = '';
    paintGauge(snap);
  }
  requestAnimationFrame(frame);
}

void boot();
