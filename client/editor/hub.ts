// Multi-game editor HUB. /editor is now a game picker → each game has its OWN editor view:
//   ?game=racer   → the existing Voice Racer level editor (client/level.ts, UNCHANGED — dynamically
//                   imported so its module-level boot runs against the racer chrome already in the DOM)
//   ?game=battler → the Voice Monsters arena editor (client/editor/arena-editor.ts)
//   (no ?game)    → the picker
// The editor token (?token=) is preserved across navigation so a gated deploy stays authorized.
const params = new URLSearchParams(location.search);
const game = params.get('game');
const token = params.get('token') ?? '';
const tokenQ = token ? `&token=${encodeURIComponent(token)}` : '';

// The racer editor's chrome (topbar/tree/panel) lives statically in index.html. Show it only for the
// racer view; hide it for the picker + the battler editor (which build their own UI).
const racerChrome = ['topbar', 'tree', 'panel', 'treeTab', 'panelTab'];
function setRacerChrome(visible: boolean): void {
  for (const id of racerChrome) { const el = document.getElementById(id); if (el) el.style.display = visible ? '' : 'none'; }
}

function showPicker(): void {
  setRacerChrome(false);
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="hub">
      <div class="hub-title">Twilio Games — Editors</div>
      <div class="hub-sub">Pick a game to edit its content</div>
      <div class="hub-cards">
        <a class="hub-card" href="?game=racer${tokenQ}">
          <div class="hub-card-name">Voice Racer</div>
          <div class="hub-card-desc">Level editor — tracks, maps, props, lighting, camera</div>
        </a>
        <a class="hub-card" href="?game=battler${tokenQ}">
          <div class="hub-card-name">Voice Monsters</div>
          <div class="hub-card-desc">Arena editor — 3D arena transform, camera framing, spin speed</div>
        </a>
      </div>
    </div>`;
}

async function boot(): Promise<void> {
  if (game === 'racer') {
    setRacerChrome(true);
    document.title = 'Voice Racer — Level Editor';
    await import('../level');               // self-boots the racer editor against the existing DOM
  } else if (game === 'battler') {
    setRacerChrome(false);
    document.title = 'Voice Monsters — Arena Editor';
    const { ArenaEditor } = await import('./arena-editor');
    new ArenaEditor(document.getElementById('app')!);
  } else {
    document.title = 'Twilio Games — Editors';
    showPicker();
  }
}
void boot();
