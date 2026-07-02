// The OUTER battle atmosphere — a full-viewport canvas BEHIND the GB stage (#app, z-index 0), painting
// the space AROUND the stage (the formerly-blank navy border). Two jobs:
//   • at rest: a slow, subtle living background (a drifting dark nebula + floating motes) so the whole
//     screen breathes instead of sitting as flat navy,
//   • on an attack: a FLASH of the move's TYPE COLOR washed across the ENTIRE background + a burst of
//     colored motes racing outward — so a Thunder Jolt lights the room yellow, an Ember bathes it
//     orange, etc.
// This is deliberately SEPARATE from the 3D arena + the in-stage attack FX (those stay as-is). It owns
// its own canvas + rAF loop (like ArenaBackground) so the orchestrator just calls flash(color).
export class AmbientFx {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private tick = 0;
  private disposed = false;

  private flashColor = '#000000';
  private flashLevel = 0;                 // 0..1, eased down each frame — drives the full-screen wash
  private motes: Mote[] = [];
  private burst: Spark[] = [];            // transient colored sparks flung out on a flash

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    // Fixed, full-viewport, BEHIND the stage/overlay, non-interactive.
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;display:block';
    host.insertBefore(this.canvas, host.firstChild);   // first child → lowest sibling in #app
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  private resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // (Re)seed ambient motes proportional to the viewport — index-based so it's stable, not random.
    const w = window.innerWidth, h = window.innerHeight;
    const n = Math.round((w * h) / 26000);
    this.motes = Array.from({ length: n }, (_, i) => ({
      x: ((i * 97) % 100) / 100 * w,
      y: ((i * 61) % 100) / 100 * h,
      speed: 4 + (i % 5) * 3,           // px/sec upward drift
      drift: ((i % 7) - 3) * 2,         // gentle horizontal sway amplitude
      size: 1 + (i % 3),
      base: 0.05 + (i % 4) * 0.03,      // faint base alpha
    }));
  };

  /** Flash the whole background in `color` (a move's type color) — a wash that fades + a mote burst. */
  flash(color: string): void {
    this.flashColor = color;
    this.flashLevel = 1;
    // fling ~18 colored sparks from around center outward
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = 0; i < 18; i++) {
      const ang = (i / 18) * Math.PI * 2 + (this.tick % 6) * 0.1;
      const spd = 180 + (i % 5) * 60;
      this.burst.push({
        x: w / 2 + Math.cos(ang) * 40, y: h / 2 + Math.sin(ang) * 40,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        life: 1, size: 2 + (i % 3), color,
      });
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.tick++;
    this.flashLevel = Math.max(0, this.flashLevel - 0.035);   // ~0.6s fade at 60fps
    this.render();
  };

  private render(): void {
    const ctx = this.ctx, w = window.innerWidth, h = window.innerHeight, t = this.tick;
    // ── base: a slow-shifting dark nebula so the border is alive, not flat navy ──
    const cx = w * (0.5 + Math.sin(t * 0.004) * 0.06);
    const cy = h * (0.38 + Math.cos(t * 0.005) * 0.05);
    const g = ctx.createRadialGradient(cx, cy, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, '#0c1738');
    g.addColorStop(0.6, '#050d24');
    g.addColorStop(1, '#00060f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ── ambient motes drifting up ──
    for (const m of this.motes) {
      const y = h - ((h - m.y + t * m.speed / 60 * 6) % (h + 20));
      const x = m.x + Math.sin(t * 0.02 + m.y) * m.drift;
      ctx.fillStyle = `rgba(150,180,230,${m.base})`;
      ctx.fillRect(x, y, m.size, m.size);
    }

    // ── attack FLASH: wash the whole screen in the type color, strongest at the edges (the border) ──
    if (this.flashLevel > 0) {
      const a = this.flashLevel * this.flashLevel;   // ease-in fade
      // a vignette-style wash: transparent-ish center, saturated toward the frame edges
      const fg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.7);
      fg.addColorStop(0, hexA(this.flashColor, a * 0.12));
      fg.addColorStop(1, hexA(this.flashColor, a * 0.5));
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, w, h);
    }

    // ── flash sparks ──
    for (const s of this.burst) {
      s.x += s.vx / 60; s.y += s.vy / 60; s.vy += 60 / 60; s.life -= 0.02;
      if (s.life <= 0) continue;
      ctx.fillStyle = hexA(s.color, s.life);
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }
    this.burst = this.burst.filter(s => s.life > 0);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }
}

interface Mote { x: number; y: number; speed: number; drift: number; size: number; base: number; }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; size: number; color: string; }

/** A #rrggbb hex + alpha [0..1] → an rgba() string. Alpha clamped to [0,1]. Exported for testing. */
export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
