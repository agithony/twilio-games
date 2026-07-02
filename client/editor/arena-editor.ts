// Voice Monsters ARENA editor (a view of the multi-game editor hub). Live-previews the 3D arena the
// same way the battle screen renders it (ArenaBackground) and exposes controls for the arena's
// transform, turntable spin, and camera framing — saved to /api/arena (the same config the battle
// reads). Reuses the editor token/auth infra so a gated deploy stays authorized.
import { ArenaBackground, type ArenaConfig } from '../battle/arena-background';
import { authHeaders, promptForToken } from './editor-auth';

const DEFAULT: Required<Pick<ArenaConfig, 'file' | 'pos' | 'rotDeg' | 'scale' | 'spinSpeed'>> & { cam?: ArenaConfig['cam'] } = {
  file: 'arena.glb', pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1, spinSpeed: 0.18,
};

export class ArenaEditor {
  private cfg: ArenaConfig = { ...DEFAULT };
  private arena: ArenaBackground;
  private stage: HTMLElement;
  private status: HTMLElement;

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="ae">
        <div class="ae-topbar">
          <strong>Voice Monsters — Arena Editor</strong>
          <a class="ae-link" href="/editor">◂ All editors</a>
          <span style="flex:1"></span>
          <span id="aeStatus" class="ae-status"></span>
          <button class="ae-save" id="aeSave">Save arena</button>
        </div>
        <div id="aeStage" class="ae-stage"></div>
        <div id="aePanel" class="ae-panel"></div>
      </div>`;
    this.stage = root.querySelector('#aeStage')!;
    this.status = root.querySelector('#aeStatus')!;
    this.injectStyles();
    this.arena = new ArenaBackground(this.stage);
    root.querySelector<HTMLButtonElement>('#aeSave')!.onclick = () => void this.save();
    void this.load();
  }

  /** Load the saved config, reflect it into the live preview + controls. */
  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/arena');
      if (res.ok) { const c = await res.json(); if (c && typeof c === 'object') this.cfg = { ...DEFAULT, ...c }; }
    } catch { /* keep defaults */ }
    this.apply();
    this.renderPanel();
  }

  /** Reload the arena model + spin into the preview with the current config. */
  private apply(): void { this.arena.load(this.cfg); }

  private renderPanel(): void {
    const panel = this.root.querySelector('#aePanel')!;
    panel.innerHTML = `<h4>Arena transform</h4>`;
    const num = (label: string, val: number, min: number, max: number, step: number, set: (v: number) => void) => {
      const row = document.createElement('label'); row.className = 'ae-row';
      row.innerHTML = `<span>${label}</span>`;
      const input = document.createElement('input');
      input.type = 'number'; input.value = String(val); input.min = String(min); input.max = String(max); input.step = String(step);
      input.oninput = () => { const v = parseFloat(input.value); if (Number.isFinite(v)) { set(v); this.apply(); } };
      row.appendChild(input); panel.appendChild(row);
    };
    const p = this.cfg.pos ?? [0, 0, 0], r = this.cfg.rotDeg ?? [0, 0, 0];
    num('Pos X', p[0], -50, 50, 0.5, v => (this.cfg.pos = [v, p[1], p[2]]));
    num('Pos Y', p[1], -50, 50, 0.5, v => (this.cfg.pos = [p[0], v, p[2]]));
    num('Pos Z', p[2], -50, 50, 0.5, v => (this.cfg.pos = [p[0], p[1], v]));
    num('Rot Y°', r[1], -180, 180, 1, v => (this.cfg.rotDeg = [r[0], v, r[2]]));
    num('Scale', this.cfg.scale ?? 1, 0.05, 20, 0.05, v => (this.cfg.scale = v));
    num('Spin speed', this.cfg.spinSpeed ?? 0.18, 0, 2, 0.02, v => (this.cfg.spinSpeed = v));
    const note = document.createElement('p'); note.className = 'ae-note';
    note.textContent = 'Live preview above spins like the battle. Camera auto-frames; Save writes the config the battle screen reads.';
    panel.appendChild(note);
  }

  private async save(): Promise<void> {
    const post = () => fetch('/api/arena', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(this.cfg) });
    try {
      let res = await post();
      if (res.status === 401 && promptForToken()) res = await post();
      this.flash(res.ok ? 'Saved!' : `Save failed (${res.status})`);
    } catch { this.flash('Save failed'); }
  }
  private flash(msg: string): void { this.status.textContent = msg; setTimeout(() => (this.status.textContent = ''), 2500); }

  private injectStyles(): void {
    if (document.getElementById('ae-styles')) return;
    const s = document.createElement('style'); s.id = 'ae-styles';
    s.textContent = `
      .ae{position:fixed;inset:0;display:flex;flex-direction:column;background:#0b1020;color:#e8ecf6;font:13px system-ui,sans-serif}
      .ae-topbar{height:48px;display:flex;align-items:center;gap:12px;padding:0 14px;background:rgba(16,22,40,.95);border-bottom:1px solid rgba(255,255,255,.12)}
      .ae-link{color:#8bac0f;text-decoration:none;font-size:12px}
      .ae-save{background:#8bac0f;color:#06110a;font-weight:800;border:0;border-radius:8px;padding:8px 16px;cursor:pointer}
      .ae-status{color:#36e08a;font-size:12px}
      .ae-stage{position:absolute;top:48px;left:0;right:280px;bottom:0;background:radial-gradient(circle at 50% 40%,#223b1c,#0b1a0c 70%)}
      .ae-panel{position:absolute;top:48px;right:0;width:280px;bottom:0;overflow:auto;padding:14px;background:rgba(16,22,40,.95);border-left:1px solid rgba(255,255,255,.12)}
      .ae-panel h4{margin:8px 0 6px;font-size:12px;color:#9aa0b4;text-transform:uppercase;letter-spacing:.04em}
      .ae-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:6px 0}
      .ae-row input{width:90px;background:#232b45;color:#fff;border:1px solid #4d5777;border-radius:6px;padding:4px 7px}
      .ae-note{font-size:11px;color:#9aa0b4;margin-top:14px;line-height:1.4}`;
    document.head.appendChild(s);
  }
}
