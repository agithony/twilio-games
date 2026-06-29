import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer } from './interpolation';
import { AssetLoader } from './asset-loader';
import { Screens } from './screens';
import { renderCarThumbnails } from './thumbnails';
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
const buffer = new InterpolationBuffer(100);
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
const isDisplay = new URLSearchParams(location.search).get('display') === '1';
// Garage / car viewer: ?garage=1 shows one car at a time (← → to cycle models) at its real
// per-level size, so you can inspect/test cars without starting a race. No server needed.
const isGarage = new URLSearchParams(location.search).get('garage') === '1';

let started = false;
let raceLive = false;
// Current pre-race phase + map choices, tracked from server messages so number-key input knows
// whether a typed digit means "pick car N" or "pick map N".
let flowPhase: 'lobby' | 'car_select' | 'map_select' | 'other' = 'lobby';
let flowMaps: string[] = [];
let typedDigits = '';
let typedTimer: ReturnType<typeof setTimeout> | null = null;

/** Keyboard digit input → select_car / select_map by number (stands in for SMS car/map picks).
 *  Multi-digit aware (e.g. "15"): accumulates briefly, then commits on a short pause or Enter. */
function bindFlowDigits(): void {
  addEventListener('keydown', (e) => {
    if (flowPhase !== 'car_select' && flowPhase !== 'map_select') return;
    if (!/^[0-9]$/.test(e.key)) return;
    typedDigits += e.key;
    if (typedTimer) clearTimeout(typedTimer);
    typedTimer = setTimeout(commitTypedDigits, 450);
  });
}
function commitTypedDigits(): void {
  const n = parseInt(typedDigits, 10); typedDigits = '';
  if (!Number.isFinite(n) || n < 1) return;
  if (flowPhase === 'car_select') conn.selectCar(n - 1);          // tiles are 1-based on screen
  else if (flowPhase === 'map_select') {
    const m = flowMaps[n - 1]; if (m) conn.selectMap(m);
  }
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

conn.onItems((items) => renderer.buildItems(items));
conn.onSnapshot((s) => { raceLive = true; flowPhase = 'other'; screens.hide(); big.textContent = ''; started = true; buffer.push(s, performance.now()); });
conn.onLobby((m) => {
  if (raceLive) return;                       // race already running; ignore stale lobby
  flowPhase = 'lobby'; big.textContent = '';
  screens.renderLobby(m.roomCode, m.players);
});
conn.onSelectState((m) => {
  raceLive = false; big.textContent = '';
  if (m.phase === 'car_select') { flowPhase = 'car_select'; screens.renderCarSelect(m.players); }
  else if (m.phase === 'map_select') { flowPhase = 'map_select'; flowMaps = m.maps; screens.renderMapSelect(m.maps, m.selectedMap, m.players); }
});
conn.onResults((m) => {
  raceLive = false; flowPhase = 'other'; big.textContent = '';
  // Show this race immediately, then fold in the all-time board for this map once it fetches.
  screens.renderResults(m.results, (i) => assets.carName(i));
  const q = m.map ? `?map=${encodeURIComponent(m.map)}&limit=10` : '?limit=10';
  fetch(`/api/leaderboard${q}`)
    .then(r => r.ok ? r.json() : { entries: [] })
    .then((data) => screens.renderResults(m.results, (i) => assets.carName(i), { map: m.map, entries: data.entries ?? [] }))
    .catch(() => { /* keep the race-only view */ });
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

async function boot() {
  // Load GLB templates before the first render; primitives if the manifest is
  // missing or any model fails (loadManifest swallows errors), so the game
  // always starts.
  try { await assets.loadManifest(); } catch { /* primitives */ }

  // Build the car-select grid catalog: friendly names + rendered portrait thumbnails (best-effort).
  const carNames = assets.carNames();
  let carThumbs: string[] = [];
  try { carThumbs = renderCarThumbnails(assets); } catch { carThumbs = []; }
  screens.setCarCatalog(carNames, carThumbs);

  const GANTRY_FILES = { start: 'starting_line.glb', finish: 'finish_line.glb' };
  // Per-level gantry offsets (filled when a map level loads); empty = auto-place at the track ends.
  let gantryOffsets: { start?: GantryOffset; finish?: GantryOffset } = {};

  // Optional track-model "map": ?map=silver_lake loads the layout authored in /editor
  // and renders that model as the world (instead of the generated track). Falls back silently.
  const mapName = new URLSearchParams(location.search).get('map');
  if (mapName) {
    try {
      const maps = await fetchMaps();
      const cfg = maps[mapName];
      if (cfg) {
        // Normalize the saved config into a full level (fills defaults; surfaces optional
        // lighting/effects/props). A level WITHOUT lighting (e.g. silver_lake today) leaves
        // setLighting(null) a no-op, so zones keep cycling — full back-compat.
        const level = mergeLevel(cfg);
        const world = await loadMapWorld(cfg);
        if (world) renderer.setMapWorld(world);
        // The race STAYS in canonical sim space (cars at z 0..TRACK_LEN, scale 1) so the camera,
        // fog, shadows, and physics — all of which assume sim coords — keep working. The map's
        // saved `model` transform (applied in loadMapWorld) already places the scenery relative to
        // this canonical race. We do NOT move the car/track group.
        applyTrackTransform(renderer.getTrackGroup(), CANONICAL_TRACK);
        // Render-only curved path (Option B): cars/items/camera follow the curve visually while
        // the sim stays straight. No path saved → straight track (setPath(null)). Width opts make
        // the in-game track match the editor.
        renderer.setPath(level.path ? new CurvedTrack(level.path) : null, surfaceOptsFromPath(level.path));
        // Per-level look: lock lighting (zones stop cycling) + apply effects + place props. Each is
        // a safe no-op when the level didn't author it.
        renderer.setLighting(level.lighting ?? null);
        renderer.setEffects(level.effects ?? null);
        renderer.setProps(level.props);
        // Per-level car sizing: overrides are keyed by the car MODEL FILENAME (so each model can be
        // sized per level), the SAME key the editor's Cars panel writes. Falls back to index string
        // if the manifest isn't loaded yet (keeps masterScale working).
        renderer.setCarScale((i) => resolveCarScale(level, assets.carFile(i) ?? String(i)));
        renderer.setItemScale((kind) => resolveItemScale(level, kind));
        renderer.setCamera(resolveCamera(level));
        gantryOffsets = { start: level.startLine, finish: level.finishLine };
      }
    } catch { /* keep the generated track */ }
  }

  // Bookend the track with the real start/finish gantry models. Called AFTER setPath so loadLine
  // auto-fits to the level's actual track width; per-level offsets pin a moved gantry (else auto).
  renderer.setStartFinishLines(GANTRY_FILES, gantryOffsets);

  if (isGarage) {
    // The car/model viewer moved to its own page (/garage) — redirect old ?garage=1 links there.
    location.href = '/garage';
    return;
  }

  if (isDisplay) {
    // Shared screen: frames the whole pack (spectator camera) AND drives its own keyboard car.
    // The host navigates the SSB-style flow with ← (back) and → / Enter (advance / start / play
    // again). During selection those keys move the flow; during a race the keyboard drives the car.
    conn.onJoined((playerId) => { renderer.setMyId(playerId); });
    input.onIntent((i) => { if (!screens.isVisible) conn.sendIntent(i); });
    renderer.setSpectator(true);
    screens.bindHostKeys();   // ← back · → / Enter advance (only while a screen is visible)
    addEventListener('keydown', (e) => {
      if (screens.isVisible) return;             // flow keys handled by screens.bindHostKeys
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') { enableHost(); conn.ready(); }
    });
    bindFlowDigits();   // 1-9 select a car/map by number on the keyboard (stands in for SMS)
    conn.join(roomCode, 'Screen');
  } else {
    // Dev keyboard-player path: join as a player and drive with the keyboard. The same flow keys
    // work so a solo tester can pick a car/map by number and advance with Enter.
    conn.onJoined((playerId) => { renderer.setMyId(playerId); });
    input.onIntent((i) => { if (!screens.isVisible) conn.sendIntent(i); });
    screens.bindHostKeys();
    bindFlowDigits();
    addEventListener('keydown', (e) => {
      if (screens.isVisible) return;
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') { enableHost(); conn.ready(); }
    });
    conn.join(roomCode, name);
  }

  function frame() {
    requestAnimationFrame(frame);
    const snap = buffer.sample(performance.now());
    if (snap) renderer.render(snap);
    // The Screens overlay (lobby/car/map/results) is the front-end now; only show the bare
    // "waiting" text when NO screen is up (e.g. before the first server message arrives).
    else if (!started && !screens.isVisible) big.textContent = 'Connecting…';
    else if (screens.isVisible) big.textContent = '';
  }
  requestAnimationFrame(frame);
}

void boot();
