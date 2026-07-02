// The Game Boy battle SCREEN for Voice Monsters. Renders the classic boxed layout on a canvas in the
// DMG 4-shade palette: the enemy monster up-right (front-facing), your monster down-left, an HP box
// per side (name · Lv · HP bar), and the bottom command window (FIGHT / MONSTER / ITEM / RUN + the
// 4-move list). Turn-based, so the monster whose turn it is faces the camera; here BOTH are always
// drawn (enemy front / you back) as in the originals, and we animate the attacker on each hit.
//
// Sprites: tries /assets/monsters/<id>_<view>.png first; falls back to the procedural placeholder
// (monster-sprite.ts) so it's playable with zero art. Draws at an integer scale for crisp pixels.
import type { MonsterType } from '../../shared/monster-types';
import type { BattleSnapshot, BattleEvent } from '../../shared/battle-world';
import { GB_SHADES, drawMonsterSprite } from './monster-sprite';
import { hpFraction, hpZone, hpColor } from './hp-bar';

// Logical GB resolution (160×144); we scale up to fill the element with nearest-neighbor crispness.
const GB_W = 160, GB_H = 144;
const [INK, DARK, LITE, PAPER] = GB_SHADES;   // darkest → lightest

interface LoadedSprite { canvas: CanvasImageSource; w: number; h: number; }

export class BattleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 3;
  private sprites = new Map<string, LoadedSprite>();   // key: `${id}:${view}`
  private snap: BattleSnapshot | null = null;
  private menuMoves: string[] = [];                    // the local player's 4 move names (bottom window)
  private banner = '';                                 // one-line message ("It's super effective!")
  /** Transient per-side attack lunge (0..1 eased), keyed by side. Drives the "step forward" animation. */
  private lunge: { a: number; b: number } = { a: 0, b: 0 };
  private flash: { a: number; b: number } = { a: 0, b: 0 };   // hit-flash timer per side
  private raf = 0;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'image-rendering:pixelated;display:block;margin:0 auto';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop();
  }

  /** Fit an integer scale of the 160×144 GB screen into the host, keeping pixels crisp. */
  private resize(): void {
    const maxW = this.host.clientWidth || 640, maxH = this.host.clientHeight || 576;
    this.scale = Math.max(2, Math.floor(Math.min(maxW / GB_W, maxH / GB_H)));
    this.canvas.width = GB_W * this.scale;
    this.canvas.height = GB_H * this.scale;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Point the renderer at the current battle state + the local player's move names for the menu. */
  setState(snap: BattleSnapshot | null, myMoveNames: string[]): void {
    this.snap = snap;
    this.menuMoves = myMoveNames;
    if (snap) { this.ensureSprite(snap.a.monsterId, snap.a.type, 'back'); this.ensureSprite(snap.b.monsterId, snap.b.type, 'front'); }
  }

  /** Show a one-line battle banner (super-effective / a move name / faint). */
  setBanner(text: string): void { this.banner = text; }

  /** Play an event's animation cue: attacker lunges, defender flashes on damage. */
  playEvent(ev: BattleEvent): void {
    if (ev.kind === 'move_used') this.lunge[ev.by] = 1;
    else if (ev.kind === 'damage') this.flash[ev.on] = 1;
  }

  /** Load a real sprite if present, else synthesize the placeholder. Cached per id+view. */
  private ensureSprite(id: string, type: MonsterType, view: 'front' | 'back'): void {
    const key = `${id}:${view}`;
    if (this.sprites.has(key)) return;
    // Placeholder immediately (so there's never a blank), then upgrade if a real PNG loads.
    const placeholder = drawMonsterSprite({ id, type, view, size: 96 });
    this.sprites.set(key, { canvas: placeholder, w: 96, h: 96 });
    const img = new Image();
    img.onload = () => this.sprites.set(key, { canvas: img, w: img.width, h: img.height });
    img.onerror = () => { /* keep the placeholder */ };
    img.src = `/assets/monsters/${id}_${view}.png`;
  }

  // ── draw loop ────────────────────────────────────────────────────────────────────────────────
  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    // ease the transient anims toward 0
    for (const s of ['a', 'b'] as const) {
      this.lunge[s] = Math.max(0, this.lunge[s] - 0.06);
      this.flash[s] = Math.max(0, this.flash[s] - 0.08);
    }
    this.render();
  };

  private render(): void {
    const ctx = this.ctx, S = this.scale;
    ctx.save(); ctx.scale(S, S);
    // paper background
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, GB_W, GB_H);

    if (this.snap) {
      // Enemy (b): front-facing, upper-right. You (a): back view, lower-left.
      this.drawMonster('b', 100, 20, 'front');
      this.drawMonster('a', 20, 66, 'back');
      // HP boxes: enemy top-left, you bottom-right (classic placement).
      this.drawHpBox(this.snap.b, 8, 12, false);
      this.drawHpBox(this.snap.a, 84, 58, true);
    }

    // bottom command / text window (double border, like the GB dialog box)
    this.drawWindow(4, 96, GB_W - 8, GB_H - 100);
    this.drawText(this.banner || (this.snap ? 'What will you do?' : 'Waiting…'), 12, 108);
    // the 4 moves, two columns, when we have them
    this.menuMoves.slice(0, 4).forEach((m, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      this.drawText(`${i + 1}. ${m}`, 12 + col * 74, 120 + row * 12, true);
    });
    ctx.restore();
  }

  private drawMonster(side: 'a' | 'b', x: number, y: number, view: 'front' | 'back'): void {
    const st = side === 'a' ? this.snap!.a : this.snap!.b;
    const spr = this.sprites.get(`${st.monsterId}:${view}`);
    if (!spr) return;
    const ctx = this.ctx;
    const size = 48;
    // lunge: shove toward the opponent (enemy lunges down-left, you lunge up-right)
    const lg = this.lunge[side];
    const dx = (side === 'a' ? 1 : -1) * lg * 6;
    const dy = (side === 'a' ? -1 : 1) * lg * 6;
    ctx.save();
    // hit flash: blink the defender by skipping the draw on alternating frames while flashing
    if (this.flash[side] > 0 && Math.floor(this.flash[side] * 10) % 2 === 0) { ctx.restore(); return; }
    ctx.drawImage(spr.canvas, x + dx, y + dy, size, size);
    ctx.restore();
  }

  private drawHpBox(st: BattleSnapshot['a'], x: number, y: number, showNumbers: boolean): void {
    const ctx = this.ctx;
    this.drawWindow(x, y, 68, 26);
    this.drawText(st.monsterName.slice(0, 9), x + 4, y + 4, true);
    // HP bar
    const frac = hpFraction(st.hp, st.maxHp);
    const barX = x + 4, barY = y + 15, barW = 52, barH = 4;
    ctx.fillStyle = DARK; ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);   // frame
    ctx.fillStyle = PAPER; ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = hpColor(hpZone(frac)); ctx.fillRect(barX, barY, Math.round(barW * frac), barH);
    if (showNumbers) this.drawText(`${st.hp}/${st.maxHp}`, x + 30, y + 4, true);
  }

  /** A GB-style window: light fill + a dark inner/outer border. */
  private drawWindow(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = INK;  ctx.fillRect(x, y, w, h);
    ctx.fillStyle = PAPER; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = DARK; ctx.strokeStyle = DARK;
    ctx.fillRect(x + 3, y + 3, w - 6, 1);   // top inner rule (decorative)
  }

  /** Draw a short line of chunky text in ink. `small` shrinks it for the HP boxes / move list. */
  private drawText(text: string, x: number, y: number, small = false): void {
    const ctx = this.ctx;
    ctx.fillStyle = INK;
    ctx.font = `${small ? 6 : 8}px monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
  }

  dispose(): void { cancelAnimationFrame(this.raf); this.canvas.remove(); }
}
