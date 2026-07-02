// The OUTER battle atmosphere — a full-viewport canvas BEHIND the GB stage (#app, z-index 0), painting
// the space AROUND the stage (the navy border). Deliberately SEPARATE from the 3D arena + the in-stage
// attack FX (those are untouched). Owns its own canvas + rAF loop; the orchestrator just calls flash().
//
// AT REST: flowing aurora ribbons + drifting glow orbs + a slow breathing pulse — obvious, alive motion,
// not a faint wash.
// ON ATTACK (flash): a big screen-wide color FLOOD, expanding SHOCKWAVE rings, and a dense storm of
// streaking sparks in the move's type color — an unmistakable, exciting hit.
export class AmbientFx {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private tick = 0;
  private disposed = false;

  private flashColor = '#7ec0ff';
  private flashLevel = 0;                 // 0..1, eased — drives the color flood + aurora tint
  private tintColor = '#7ec0ff';          // the last attack color the aurora leans toward while flashing
  private orbs: Orb[] = [];
  private sparks: Spark[] = [];           // streaking sparks flung out on a flash
  private rings: Ring[] = [];             // expanding shockwave rings on a flash

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
    // Big drifting glow orbs — index-seeded (stable, not random). A handful of large, colorful blobs
    // floating behind the aurora give obvious depth + motion.
    const w = window.innerWidth, h = window.innerHeight;
    const ORB_HUES = ['#2b6cff', '#8a3cff', '#1fb6c9', '#ff3a6a', '#2ee6a6'];
    this.orbs = Array.from({ length: 6 }, (_, i) => ({
      bx: (0.12 + (i * 0.16) % 0.8) * w,
      by: (0.15 + ((i * 0.27) % 0.7)) * h,
      r: Math.min(w, h) * (0.18 + (i % 3) * 0.06),
      sx: (i % 2 ? 1 : -1) * (0.02 + (i % 3) * 0.01),   // drift speeds
      sy: (i % 3 ? 1 : -1) * (0.015 + (i % 2) * 0.012),
      color: ORB_HUES[i % ORB_HUES.length]!,
    }));
  };

  /** ATTACK: flood the screen in `color`, fire shockwave rings + a spark storm from center. Bold. */
  flash(color: string): void {
    this.flashColor = color;
    this.tintColor = color;
    this.flashLevel = 1;
    const w = window.innerWidth, h = window.innerHeight;
    const cx = w / 2, cy = h / 2;
    // two shockwave rings, staggered
    this.rings.push({ x: cx, y: cy, r: 20, life: 1, color, delay: 0 });
    this.rings.push({ x: cx, y: cy, r: 20, life: 1, color, delay: 8 });
    // a dense spark storm bursting outward (bigger, faster than before, with variety)
    for (let i = 0; i < 46; i++) {
      const ang = (i / 46) * Math.PI * 2 + (this.tick % 12) * 0.05;
      const spd = 260 + (i % 7) * 70;
      this.sparks.push({
        x: cx, y: cy,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        life: 1, size: 3 + (i % 4), color,
      });
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.tick++;
    this.flashLevel = Math.max(0, this.flashLevel - 0.025);   // ~0.7s fade at 60fps
    this.render();
  };

  private render(): void {
    const ctx = this.ctx, w = window.innerWidth, h = window.innerHeight, t = this.tick;

    // ── base fill ──
    ctx.fillStyle = '#03060f';
    ctx.fillRect(0, 0, w, h);

    // ── drifting glow orbs (additive) — big soft colored blobs floating behind everything ──
    ctx.globalCompositeOperation = 'lighter';
    for (const o of this.orbs) {
      const x = o.bx + Math.sin(t * o.sx * 0.05) * w * 0.12;
      const y = o.by + Math.cos(t * o.sy * 0.05) * h * 0.12;
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.03 + o.bx);
      const g = ctx.createRadialGradient(x, y, 0, x, y, o.r * pulse);
      g.addColorStop(0, hexA(o.color, 0.34));
      g.addColorStop(0.5, hexA(o.color, 0.12));
      g.addColorStop(1, hexA(o.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // ── aurora ribbons: flowing sine bands sweeping across, leaning toward the attack tint on a flash ──
    const bands = 4;
    for (let b = 0; b < bands; b++) {
      const baseHue = ['#2f7bff', '#8a3cff', '#1fc9c9', '#5a3cff'][b % 4]!;
      const col = this.flashLevel > 0.05 ? mix(baseHue, this.tintColor, this.flashLevel * 0.7) : baseHue;
      const amp = h * (0.06 + b * 0.02);
      const yBase = h * (0.25 + b * 0.16);
      const phase = t * (0.012 + b * 0.004) + b * 1.7;
      ctx.beginPath();
      ctx.moveTo(0, yBase);
      for (let x = 0; x <= w; x += 24) {
        const y = yBase + Math.sin(x * 0.006 + phase) * amp + Math.sin(x * 0.013 + phase * 1.6) * amp * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, yBase - amp, 0, h);
      g.addColorStop(0, hexA(col, 0.16));
      g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // ── ATTACK: shockwave rings (expand + fade) ──
    for (const r of this.rings) {
      if (r.delay > 0) { r.delay--; continue; }
      r.r += 26; r.life -= 0.03;
      if (r.life <= 0) continue;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexA(r.color, r.life * 0.8);
      ctx.lineWidth = 6 * r.life + 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    this.rings = this.rings.filter(r => r.life > 0);

    // ── ATTACK: full-screen color FLOOD — bold, edges strongest, fades fast ──
    if (this.flashLevel > 0) {
      const a = this.flashLevel;
      ctx.globalCompositeOperation = 'lighter';
      const fg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.1, w / 2, h / 2, Math.max(w, h) * 0.72);
      fg.addColorStop(0, hexA(this.flashColor, a * 0.35));
      fg.addColorStop(1, hexA(this.flashColor, a * 0.9));
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── ATTACK: streaking spark storm ──
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.sparks) {
      s.x += s.vx / 60; s.y += s.vy / 60; s.vx *= 0.97; s.vy *= 0.97; s.life -= 0.018;
      if (s.life <= 0) continue;
      // draw a short streak along its velocity for a "racing" feel
      ctx.strokeStyle = hexA(s.color, s.life);
      ctx.lineWidth = s.size * s.life;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx / 60 * 3, s.y - s.vy / 60 * 3);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    this.sparks = this.sparks.filter(s => s.life > 0);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }
}

interface Orb { bx: number; by: number; r: number; sx: number; sy: number; color: string; }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; size: number; color: string; }
interface Ring { x: number; y: number; r: number; life: number; color: string; delay: number; }

/** A #rrggbb hex + alpha [0..1] → an rgba() string. Alpha clamped to [0,1]. Exported for testing. */
export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** Blend two #rrggbb hexes by t∈[0,1] (0 = a, 1 = b) → a #rrggbb hex. Exported for testing. */
export function mix(a: string, b: string, t: number): string {
  const pa = hexRgb(a), pb = hexRgb(b), k = Math.max(0, Math.min(1, t));
  const c = (i: number) => Math.round(pa[i]! + (pb[i]! - pa[i]!) * k);
  return `#${[c(0), c(1), c(2)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
