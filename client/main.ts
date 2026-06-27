import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer } from './interpolation';
import { AssetLoader } from './asset-loader';

const url = `ws://${location.hostname}:8080/game`;
const conn = new GameConnection(url);
const input = new KeyboardAdapter();
const assets = new AssetLoader();
const renderer = new Renderer(document.getElementById('app')!, assets);
const buffer = new InterpolationBuffer(100);
const big = document.getElementById('big')!;

const roomCode = new URLSearchParams(location.search).get('room') ?? '4821';
const name = new URLSearchParams(location.search).get('name') ?? 'You';
const isDisplay = new URLSearchParams(location.search).get('display') === '1';

let started = false;

conn.onItems((items) => renderer.buildItems(items));
conn.onSnapshot((s) => { started = true; buffer.push(s, performance.now()); });
conn.onEvent((e) => {
  if (e.kind === 'countdown') big.textContent = String(e.n);
  else if (e.kind === 'go') { big.textContent = 'GO!'; setTimeout(() => (big.textContent = ''), 900); }
  else if (e.kind === 'race_over') big.textContent = '🏁';
});
conn.onError((code, message) => {
  console.error(`Server error [${code}]: ${message}`);
  big.textContent = `⚠ ${message}`;
});

async function boot() {
  // Load GLB templates before the first render; primitives if the manifest is
  // missing or any model fails (loadManifest swallows errors), so the game
  // always starts.
  try { await assets.loadManifest(); } catch { /* primitives */ }

  if (isDisplay) {
    // Spectator + operator console: watch the room (occupy no player slot),
    // render all phone players' cars, and start the race on Enter.
    conn.spectate(roomCode);
    addEventListener('keydown', (e) => {
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') conn.ready();
    });
  } else {
    // Dev keyboard-player path: join as a player and drive with the keyboard.
    conn.onJoined((playerId) => { renderer.setMyId(playerId); });
    input.onIntent((i) => conn.sendIntent(i));
    addEventListener('keydown', (e) => {
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') conn.ready();
    });
    conn.join(roomCode, name);
  }

  function frame() {
    requestAnimationFrame(frame);
    const snap = buffer.sample(performance.now());
    if (snap) renderer.render(snap);
    else if (!started) big.textContent = 'Waiting for players… press ENTER to start';
  }
  requestAnimationFrame(frame);
}

void boot();
