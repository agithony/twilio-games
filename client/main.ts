import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer } from './interpolation';
import { AssetLoader } from './asset-loader';
import { Announcer, browserSpeechSink } from './announcer';

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
  muteBtn.textContent = hostOn ? '🔊 Host' : '🔇 Host';
});

conn.onItems((items) => renderer.buildItems(items));
conn.onSnapshot((s) => { started = true; buffer.push(s, performance.now()); });
conn.onEvent((e) => {
  announcer.handle(e);
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
    // Operator console that also seats a drivable car, so a solo host can start
    // AND race (phone players join the same room as additional cars). Joining as
    // a player guarantees the room is non-empty, so Enter actually starts a race.
    conn.onJoined((playerId) => { renderer.setMyId(playerId); });
    input.onIntent((i) => conn.sendIntent(i));
    addEventListener('keydown', (e) => {
      if (e.key === 'r') conn.restart();
      else if (e.key === 'Enter') { enableHost(); conn.ready(); }
    });
    conn.join(roomCode, name === 'You' ? 'Host' : name);
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
    else if (!started) big.textContent = 'Waiting for players… press ENTER to start';
  }
  requestAnimationFrame(frame);
}

void boot();
