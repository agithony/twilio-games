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

/** The client-derived turn state that drives the bottom window (set by monsters.ts). */
export type UiPhase = 'idle' | 'awaiting-input' | 'command-locked' | 'resolving' | 'finished';
/** A move as shown in the command window (name + type + power for info). */
export interface MenuMove { name: string; type: string; power: number; }

export class BattleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 3;
  private sprites = new Map<string, LoadedSprite>();   // key: `${id}:${view}`
  private snap: BattleSnapshot | null = null;
  private menuMoves: MenuMove[] = [];                  // the local player's 4 moves (bottom window)
  private uiPhase: UiPhase = 'idle';                   // whose-turn state → what the window shows
  private statusLine = '';                             // persistent prompt ("What will X do?" / "Waiting…")
  private eventBanner = '';                            // transient event text ("It's super effective!")
  /** Transient per-side attack lunge (0..1 eased), keyed by side. Drives the "step forward" animation. */
  private lunge: { a: number; b: number } = { a: 0, b: 0 };
  private flash: { a: number; b: number } = { a: 0, b: 0 };   // hit-flash timer per side
  private raf = 0;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    // Layered ON TOP of the 3D arena canvas (which the host also holds). Transparent in the battle
    // area so the spinning arena shows through behind the monsters; the HP boxes + command window are
    // opaque panels drawn over it. z-index sits above the arena.
    this.canvas.style.cssText = 'image-rendering:pixelated;position:absolute;inset:0;margin:auto;z-index:2';
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

  /** Point the renderer at the current battle state, the local player's moves, the turn state, and
   *  the persistent status line. The bottom window branches on uiPhase (menu only when it's your
   *  turn; a "waiting" line when locked; just the event banner while resolving). */
  setState(snap: BattleSnapshot | null, myMoves: MenuMove[], uiPhase: UiPhase, statusLine: string): void {
    this.snap = snap;
    this.menuMoves = myMoves;
    this.uiPhase = uiPhase;
    this.statusLine = statusLine;
    if (snap) { this.ensureSprite(snap.a.monsterId, snap.a.type, 'back'); this.ensureSprite(snap.b.monsterId, snap.b.type, 'front'); }
  }

  /** Transient event text (move name / super-effective / faint); cleared when resolution settles. */
  setEventBanner(text: string): void { this.eventBanner = text; }

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
    // Clear to TRANSPARENT so the 3D arena canvas behind shows through the battle area (the monsters
    // + HP boxes + command window are drawn opaque on top). This is what puts the pixel creatures on
    // the spinning 3D arena instead of a flat paper card.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save(); ctx.scale(S, S);

    // ── Fixed battle layout on the 160×144 screen, designed so NOTHING overlaps ──
    //  scene area  : y 0..92  (monsters on platforms + HP boxes in opposite corners)
    //  command box : y 94..144
    // Enemy (b): front-facing, up-RIGHT on a platform; its HP box up-LEFT.
    // You (a):    back view,   down-LEFT on a platform; your HP box down-RIGHT (above the command box).
    if (this.snap) {
      this.drawMonster('b', 108, 42, 46, 'front');   // platform center (x, groundY), sprite size
      this.drawMonster('a', 44, 82, 52, 'back');
      this.drawHpBox(this.snap.b, 6, 8, false);       // enemy: top-left
      this.drawHpBox(this.snap.a, 84, 58, true);      // you: bottom-right (with HP numbers)
    }

    // Bottom command / text window — branches on the TURN STATE so the game reads as turn-based.
    this.drawWindow(4, 94, GB_W - 8, 46);
    const line = this.uiPhase === 'resolving'
      ? (this.eventBanner || this.statusLine)
      : (this.statusLine || (this.snap ? '' : 'Waiting…'));
    this.drawText(line, 11, 101);
    if (this.uiPhase === 'awaiting-input') {
      // 4 moves in two columns under the prompt: "1 Ember   fir·50"
      this.menuMoves.slice(0, 4).forEach((m, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        const x = 11 + col * 76, y = 116 + row * 12;
        this.drawText(`${i + 1} ${m.name}`, x, y, true);
        this.drawText(m.power > 0 ? `${m.type.slice(0, 3)}·${m.power}` : m.type.slice(0, 3), x + 54, y, true);
      });
    }
    ctx.restore();
  }

  /** Draw a monster centered horizontally on `cx`, standing ON the platform at `groundY` (its feet
   *  sit there). A small elliptical shadow anchors it to the arena so it doesn't float. */
  private drawMonster(side: 'a' | 'b', cx: number, groundY: number, size: number, view: 'front' | 'back'): void {
    const st = side === 'a' ? this.snap!.a : this.snap!.b;
    const spr = this.sprites.get(`${st.monsterId}:${view}`);
    if (!spr) return;
    const ctx = this.ctx;
    const lg = this.lunge[side];                       // attack lunge toward the opponent
    const dx = (side === 'a' ? 1 : -1) * lg * 6;
    const dy = (side === 'a' ? -1 : 1) * lg * 4;
    // shadow platform (drawn first, under the sprite) so the creature reads as standing on the arena.
    ctx.save();
    ctx.fillStyle = 'rgba(15,30,15,0.4)';
    ctx.beginPath(); ctx.ellipse(cx + dx, groundY + 2, size * 0.38, size * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    // hit flash: blink the defender while it's flashing.
    if (this.flash[side] > 0 && Math.floor(this.flash[side] * 10) % 2 === 0) { ctx.restore(); return; }
    // anchor the sprite's FEET on groundY, centered on cx.
    ctx.drawImage(spr.canvas, cx - size / 2 + dx, groundY - size + dy, size, size);
    ctx.restore();
  }

  private drawHpBox(st: BattleSnapshot['a'], x: number, y: number, showNumbers: boolean): void {
    const ctx = this.ctx;
    const w = 70, h = showNumbers ? 26 : 20;
    this.drawWindow(x, y, w, h);
    this.drawText(st.monsterName.slice(0, 11), x + 5, y + 4, true);
    // HP label + bar
    const frac = hpFraction(st.hp, st.maxHp);
    const barX = x + 5, barY = y + 13, barW = w - 10, barH = 4;
    ctx.fillStyle = DARK; ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);   // frame
    ctx.fillStyle = PAPER; ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = hpColor(hpZone(frac)); ctx.fillRect(barX, barY, Math.round(barW * frac), barH);
    if (showNumbers) this.drawText(`${st.hp}/${st.maxHp}`, x + 5, y + 19, true);
  }

  /** A GB-style window: light fill + a dark inner/outer border. */
  private drawWindow(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = INK;  ctx.fillRect(x, y, w, h);
    ctx.fillStyle = PAPER; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = DARK;
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
