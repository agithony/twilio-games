import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer } from './interpolation';
import { AssetLoader } from './asset-loader';
import { Announcer, browserSpeechSink } from './announcer';
import { fetchMaps, loadMapWorld, applyTrackTransform, CANONICAL_TRACK } from './map-world';
import { CurvedTrack } from './track-path';
import { surfaceOptsFromPath } from './track-surface';
import { mergeLevel, resolveCarScale } from '../shared/level';
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
const lobbyCodeEl = document.getElementById('lobbyCode')!;
const lobbyCountEl = document.getElementById('lobbyCount')!;
const lobbyPlayersEl = document.getElementById('lobbyPlayers')!;

const roomCode = new URLSearchParams(location.search).get('room') ?? '4821';
const name = new URLSearchParams(location.search).get('name') ?? 'You';
const isDisplay = new URLSearchParams(location.search).get('display') === '1';

let started = false;
let raceLive = false;

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
conn.onSnapshot((s) => { raceLive = true; lobbyEl.style.display = 'none'; started = true; buffer.push(s, performance.now()); });
conn.onLobby((m) => {
  if (raceLive) return;                       // race already running; ignore stale lobby
  lobbyEl.style.display = 'flex';
  big.textContent = '';                       // lobby overlay replaces the "waiting" text
  lobbyCodeEl.textContent = m.roomCode;
  const n = m.players.length;
  lobbyCountEl.textContent = n === 0 ? `Call ${m.roomCode} to join`
    : `${n} racer${n === 1 ? '' : 's'} in — call ${m.roomCode} to join more`;
  lobbyPlayersEl.innerHTML = '';
  for (const p of m.players) {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;gap:8px;background:rgba(35,43,69,.9);border:1px solid #38425e;border-radius:999px;padding:8px 14px;font-size:15px';
    const dot = document.createElement('span');
    dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${p.color};display:inline-block`;
    const nm = document.createElement('span'); nm.textContent = p.name;
    chip.append(dot, nm); lobbyPlayersEl.appendChild(chip);
  }
});
conn.onEvent((e) => {
  announcer.handle(e);
  if (e.kind === 'countdown') big.textContent = String(e.n);
  else if (e.kind === 'go') { big.textContent = 'GO!'; setTimeout(() => (big.textContent = ''), 900); }
  else if (e.kind === 'race_over') big.textContent = 'Finish';
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
        // Per-level car sizing: the game-side half. Overrides are keyed by the car INDEX STRING
        // ("0","1",…) — the SAME key the editor (cars panel) writes.
        renderer.setCarScale((i) => resolveCarScale(level, String(i)));
        gantryOffsets = { start: level.startLine, finish: level.finishLine };
      }
    } catch { /* keep the generated track */ }
  }

  // Bookend the track with the real start/finish gantry models. Called AFTER setPath so loadLine
  // auto-fits to the level's actual track width; per-level offsets pin a moved gantry (else auto).
  renderer.setStartFinishLines(GANTRY_FILES, gantryOffsets);

  if (isDisplay) {
    // Shared screen: frames the whole pack (spectator camera) AND drives its own
    // keyboard car. Joining as a player means (a) the keyboard works even when phone
    // callers are connected, and (b) the game is playable with ZERO callers — Enter
    // starts it because the screen itself is always a player.
    conn.onJoined((playerId) => { renderer.setMyId(playerId); });
    input.onIntent((i) => conn.sendIntent(i));
    renderer.setSpectator(true);
    addEventListener('keydown', (e) => {
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') { enableHost(); conn.ready(); }
    });
    conn.join(roomCode, 'Screen');
  } else {
    // Dev keyboard-player path: join as a player and drive with the keyboard.
    conn.onJoined((playerId) => { renderer.setMyId(playerId); });
    input.onIntent((i) => conn.sendIntent(i));
    addEventListener('keydown', (e) => {
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') { enableHost(); conn.ready(); }
    });
    conn.join(roomCode, name);
  }

  function frame() {
    requestAnimationFrame(frame);
    const snap = buffer.sample(performance.now());
    if (snap) renderer.render(snap);
    else if (!started) big.textContent = isDisplay
      ? `Call in + enter room ${roomCode}, then press ENTER`
      : 'Waiting… press ENTER to start';
  }
  requestAnimationFrame(frame);
}

void boot();
