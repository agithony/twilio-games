// The Game Boy battle SCREEN for Voice Monsters. Renders the classic boxed layout on a canvas in the
// DMG 4-shade palette: the enemy monster up-right (front-facing), your monster down-left, an HP box
// per side (name · Lv · HP bar), and the bottom command window (FIGHT / MONSTER / ITEM / RUN + the
// 4-move list). Turn-based, so the monster whose turn it is faces the camera; here BOTH are always
// drawn (enemy front / you back) as in the originals, and we animate the attacker on each hit.
//
// Sprites: tries /assets/monsters/<id>_<view>.gif then .png (animated GIF wins when both exist);
// falls back to the procedural placeholder (monster-sprite.ts) so it's playable with zero art. Draws
// at an integer scale for crisp pixels.
import type { MonsterType } from '../../shared/monster-types';
import type { BattleSnapshot, BattleEvent } from '../../shared/battle-world';
import { GB_SHADES, drawMonsterSprite, typeColor } from './monster-sprite';
import { spriteCandidateUrls } from './sprite-sources';
import { ResolutionHp } from './resolution-hp';
import { powerPips } from './move-menu';
import { hpFraction, hpZone, hpColor } from './hp-bar';

// Logical GB resolution (160×144); we scale up to fill the element with nearest-neighbor crispness.
const GB_W = 160, GB_H = 144;
const [INK, DARK, LITE, PAPER] = GB_SHADES;   // darkest → lightest

// A sprite is either a procedural placeholder (drawn to the canvas) or a real loaded file (an <img>,
// which may be an animated GIF — shown as a live DOM element on the sprite layer, not canvas-drawn).
interface LoadedSprite { canvas: CanvasImageSource; w: number; h: number; img?: HTMLImageElement; }

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
  private shake = 0;   // screen-shake intensity (0..1, eased) — spiked by a crit hit
  private activeSide: 'a' | 'b' | null = null;   // whose turn it is → bobbing arrow over that monster
  private tick = 0;   // frame counter for cheap time-based bob/pulse animations
  /** Per-side displayed HP during a paced resolution (so the two bars drop one hit at a time instead
   *  of both snapping to the settled snapshot at once). */
  private resHp = new ResolutionHp();
  private wasResolving = false;   // detects the idle↔resolving transition to begin/end the tracker
  private raf = 0;
  /** A DOM layer overlaid EXACTLY on the GB canvas that holds the real sprite <img> elements. Animated
   *  GIFs only advance their frames while the browser composits them as a VISIBLE <img> — drawing one
   *  to a canvas freezes it on frame 1. So real sprites live here as live <img>s positioned to match
   *  the canvas layout; only procedural placeholders take the canvas path. Sits above the canvas
   *  (z-index 3); sprites never overlap the HP boxes/command window, so no occlusion is lost. */
  private spriteLayer: HTMLElement;
  /** The <img> currently shown on screen per side (so we can reposition/replace it each frame). */
  private shownImg: { a: HTMLImageElement | null; b: HTMLImageElement | null } = { a: null, b: null };

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    // Layered ON TOP of the 3D arena canvas (which the host also holds). Transparent in the battle
    // area so the spinning arena shows through behind the monsters; the HP boxes + command window are
    // opaque panels drawn over it. z-index sits above the arena.
    this.canvas.style.cssText = 'image-rendering:pixelated;position:absolute;inset:0;margin:auto;z-index:2';
    host.appendChild(this.canvas);
    // Sprite layer: same absolute-centering as the canvas so device-pixel coords line up 1:1.
    this.spriteLayer = document.createElement('div');
    this.spriteLayer.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:3;pointer-events:none;overflow:visible';
    host.appendChild(this.spriteLayer);
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
    // Match the sprite layer to the canvas's on-screen box so GB-logical coords map 1:1 to CSS px.
    this.spriteLayer.style.width = `${GB_W * this.scale}px`;
    this.spriteLayer.style.height = `${GB_H * this.scale}px`;
  }

  /** Point the renderer at the current battle state, the local player's moves, the turn state, and
   *  the persistent status line. The bottom window branches on uiPhase (menu only when it's your
   *  turn; a "waiting" line when locked; just the event banner while resolving). */
  setState(snap: BattleSnapshot | null, myMoves: MenuMove[], uiPhase: UiPhase, statusLine: string): void {
    // Begin/end the paced-HP tracker on the resolving transition. Seed pre-turn HP from the CURRENT
    // snapshot (still pre-turn: events arrive before the settled state), so bars start where the turn
    // began and step down per damage event instead of snapping to the settled HP together.
    const resolving = uiPhase === 'resolving';
    if (resolving && !this.wasResolving && this.snap) this.resHp.begin(this.snap.a.hp, this.snap.b.hp);
    else if (!resolving && this.wasResolving) this.resHp.end();
    this.wasResolving = resolving;

    this.snap = snap;
    this.menuMoves = myMoves;
    this.uiPhase = uiPhase;
    this.statusLine = statusLine;
    if (snap) { this.ensureSprite(snap.a.monsterId, snap.a.type, 'back'); this.ensureSprite(snap.b.monsterId, snap.b.type, 'front'); }
  }

  /** Transient event text (move name / super-effective / faint); cleared when resolution settles. */
  setEventBanner(text: string): void { this.eventBanner = text; }

  /** Which side is currently acting (drives a turn-indicator arrow over the active monster). null in
   *  menus / when settled. */
  setActiveSide(side: 'a' | 'b' | null): void { this.activeSide = side; }

  /** Play an event's animation cue: attacker lunges, defender flashes + its HP bar steps down to this
   *  hit's remaining HP (so the two bars drop one hit at a time during resolution). A crit shakes the
   *  screen and flashes harder. */
  playEvent(ev: BattleEvent): void {
    if (ev.kind === 'move_used') this.lunge[ev.by] = 1;
    else if (ev.kind === 'damage') {
      this.flash[ev.on] = 1; this.resHp.hit(ev.on, ev.hpLeft);
      if (ev.crit) this.shake = 1;   // extra punch on a critical hit
    }
  }

  /** Load a real sprite if present, else keep the synthesized placeholder. Cached per id+view. Tries
   *  an animated GIF first, then a static PNG (spriteCandidateUrls order); the first that loads wins.
   *  A loaded GIF animates because render() redraws it every frame (drawImage grabs the current
   *  frame) — but a detached <img> is paused in some browsers, so we park it offscreen in the DOM to
   *  keep its animation clock running. */
  private ensureSprite(id: string, type: MonsterType, view: 'front' | 'back'): void {
    const key = `${id}:${view}`;
    if (this.sprites.has(key)) return;
    // Placeholder immediately (so there's never a blank), then upgrade if a real file loads.
    const placeholder = drawMonsterSprite({ id, type, view, size: 96 });
    this.sprites.set(key, { canvas: placeholder, w: 96, h: 96 });
    this.tryLoadCandidates(key, spriteCandidateUrls(id, view), 0);
  }

  /** Walk the candidate URLs in order: on load, adopt the <img> as the real sprite (rendered as a live
   *  DOM element on the sprite layer so an animated GIF actually animates); on error, try the next; if
   *  none load, the canvas placeholder stays. */
  private tryLoadCandidates(key: string, urls: string[], i: number): void {
    if (i >= urls.length) return;   // exhausted → keep the placeholder
    const img = new Image();
    img.onload = () => {
      img.style.cssText = 'position:absolute;image-rendering:pixelated;pointer-events:none';
      this.sprites.set(key, { canvas: img, w: img.width, h: img.height, img });
    };
    img.onerror = () => this.tryLoadCandidates(key, urls, i + 1);   // 404 → next candidate
    img.src = urls[i]!;
  }

  // ── draw loop ────────────────────────────────────────────────────────────────────────────────
  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    // ease the transient anims toward 0
    for (const s of ['a', 'b'] as const) {
      this.lunge[s] = Math.max(0, this.lunge[s] - 0.06);
      this.flash[s] = Math.max(0, this.flash[s] - 0.08);
    }
    this.shake = Math.max(0, this.shake - 0.05);
    this.tick++;
    this.render();
  };

  private render(): void {
    const ctx = this.ctx, S = this.scale;
    // Clear to TRANSPARENT so the 3D arena canvas behind shows through the battle area (the monsters
    // + HP boxes + command window are drawn opaque on top). This is what puts the pixel creatures on
    // the spinning 3D arena instead of a flat paper card.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save(); ctx.scale(S, S);
    // Screen-shake (crit): jitter the whole scene a couple GB-pixels, decaying. Deterministic-ish via
    // a cheap time-independent oscillation on the eased intensity (no reliance on Math.random timing).
    if (this.shake > 0) {
      const k = this.shake * this.shake * 3;
      ctx.translate(Math.round(Math.sin(this.shake * 40) * k), Math.round(Math.cos(this.shake * 37) * k));
    }

    // ── Fixed battle layout on the 160×144 screen, designed so NOTHING overlaps ──
    //  scene area  : y 0..92  (monsters on platforms + HP boxes in opposite corners)
    //  command box : y 94..144
    // Enemy (b): front-facing, up-RIGHT on a platform; its HP box up-LEFT.
    // You (a):    back view,   down-LEFT on a platform; your HP box down-RIGHT (above the command box).
    if (this.snap) {
      this.drawMonster('b', 108, 42, 46, 'front');   // platform center (x, groundY), sprite size
      this.drawMonster('a', 44, 82, 52, 'back');
      this.drawHpBox('b', this.snap.b, 6, 8, false);   // enemy: top-left
      this.drawHpBox('a', this.snap.a, 84, 58, true);  // you: bottom-right (with HP numbers)
      // Turn indicator: a bobbing arrow floating ABOVE whoever is acting, so the ping-pong is visible.
      // (Sits just above each sprite's box top — a: 82-52=30, b near the screen top — not on the head.)
      if (this.activeSide === 'b') this.drawTurnArrow(108, 0);
      else if (this.activeSide === 'a') this.drawTurnArrow(44, 22);
    } else {
      this.hideSpriteImg('a'); this.hideSpriteImg('b');   // no battle → clear any lingering sprite <img>
    }

    // Bottom command / text window — branches on the TURN STATE so the game reads as turn-based.
    this.drawWindow(4, 94, GB_W - 8, 46);
    const line = this.uiPhase === 'resolving'
      ? (this.eventBanner || this.statusLine)
      : (this.statusLine || (this.snap ? '' : 'Waiting…'));
    this.drawText(line, 11, 101);
    if (this.uiPhase === 'awaiting-input') {
      // 4 moves in two columns under the prompt. Each cell: the FULL move name on one row, then a 5-pip
      // power rating on the row below (little squares in the type color — NOT the meaningless raw
      // base-power number). Pips sit UNDER the name (not beside it) so the whole 73px column width is
      // free for the name — every roster name (≤12 chars) fits without abbreviating. Window x 4..156.
      this.menuMoves.slice(0, 4).forEach((m, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        const x = 11 + col * 73, y = 116 + row * 13;
        this.drawText(`${i + 1} ${m.name}`, x, y, true);
        this.drawPips(x + 6, y + 6, powerPips(m.power), typeColor(m.type));   // rating row under the name
      });
    }
    ctx.restore();
  }

  /** Draw a monster centered horizontally on `cx`, standing ON the platform at `groundY` (its feet
   *  sit there). A small elliptical shadow anchors it to the arena so it doesn't float. A REAL sprite
   *  (loaded <img>, possibly an animated GIF) is placed on the DOM sprite layer so it animates; a
   *  procedural placeholder is drawn straight to the canvas as before. */
  private drawMonster(side: 'a' | 'b', cx: number, groundY: number, size: number, view: 'front' | 'back'): void {
    const st = side === 'a' ? this.snap!.a : this.snap!.b;
    const spr = this.sprites.get(`${st.monsterId}:${view}`);
    if (!spr) { this.hideSpriteImg(side); return; }
    const ctx = this.ctx;
    const lg = this.lunge[side];                       // attack lunge toward the opponent
    const dx = (side === 'a' ? 1 : -1) * lg * 6;
    const dy = (side === 'a' ? -1 : 1) * lg * 4;
    // shadow platform (drawn first, under the sprite) so the creature reads as standing on the arena.
    ctx.save();
    ctx.fillStyle = 'rgba(15,30,15,0.4)';
    ctx.beginPath(); ctx.ellipse(cx + dx, groundY + 2, size * 0.38, size * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // hit flash: blink the sprite (canvas OR DOM) while it's flashing.
    const blink = this.flash[side] > 0 && Math.floor(this.flash[side] * 10) % 2 === 0;
    if (spr.img) {
      // Real sprite → live DOM <img> on the sprite layer, positioned to match the canvas layout.
      this.hideSpriteImg(side, spr.img);   // swap element if the monster/view changed
      this.placeSpriteImg(side, spr.img, cx + dx, groundY + dy, size, blink);
    } else {
      // Placeholder → canvas draw (feet anchored on groundY, centered on cx).
      this.hideSpriteImg(side);            // ensure no stale <img> lingers
      if (!blink) ctx.drawImage(spr.canvas, cx - size / 2 + dx, groundY - size + dy, size, size);
    }
  }

  /** Position a real sprite <img> on the DOM layer using the SAME GB-logical layout the canvas uses
   *  (converted to device px via `scale`), feet anchored on groundY, centered on cx. */
  private placeSpriteImg(side: 'a' | 'b', img: HTMLImageElement, cx: number, groundY: number, size: number, blink: boolean): void {
    const S = this.scale;
    if (img.parentElement !== this.spriteLayer) this.spriteLayer.appendChild(img);
    this.shownImg[side] = img;
    img.style.left = `${(cx - size / 2) * S}px`;
    img.style.top = `${(groundY - size) * S}px`;
    img.style.width = `${size * S}px`;
    img.style.height = `${size * S}px`;
    img.style.visibility = blink ? 'hidden' : 'visible';
  }

  /** Remove the currently-shown <img> for a side (unless it's `keep`, the one we're about to place). */
  private hideSpriteImg(side: 'a' | 'b', keep?: HTMLImageElement): void {
    const cur = this.shownImg[side];
    if (cur && cur !== keep) { cur.remove(); this.shownImg[side] = null; }
  }

  private drawHpBox(side: 'a' | 'b', st: BattleSnapshot['a'], x: number, y: number, showNumbers: boolean): void {
    const ctx = this.ctx;
    const w = 70, h = showNumbers ? 26 : 20;
    this.drawWindow(x, y, w, h);
    this.drawText(st.monsterName.slice(0, 11), x + 5, y + 4, true);
    // HP: during a paced resolution show the tracker's value (drops one hit at a time); else snapshot.
    const hp = this.resHp.display(side, st.hp);
    const frac = hpFraction(hp, st.maxHp);
    const barX = x + 5, barY = y + 13, barW = w - 10, barH = 4;
    ctx.fillStyle = DARK; ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);   // frame
    ctx.fillStyle = PAPER; ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = hpColor(hpZone(frac)); ctx.fillRect(barX, barY, Math.round(barW * frac), barH);
    if (showNumbers) this.drawText(`${hp}/${st.maxHp}`, x + 5, y + 19, true);
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

  /** A bobbing down-arrow marking the monster whose turn it is (centered on cx, at row y). */
  private drawTurnArrow(cx: number, y: number): void {
    const ctx = this.ctx;
    const bob = Math.round(Math.sin(this.tick * 0.18) * 1.5);   // gentle vertical bob
    const ay = y + bob;
    ctx.fillStyle = '#ffd23f';   // bright, reads over any backdrop
    // a chunky 7px-wide triangle pointing down
    for (let row = 0; row < 4; row++) {
      const half = 3 - row;
      ctx.fillRect(cx - half, ay + row, half * 2 + 1, 1);
    }
    ctx.fillStyle = INK;   // 1px dark outline on top for contrast
    ctx.fillRect(cx - 4, ay - 1, 9, 1);
  }

  /** A move's power rating as up to 5 tiny squares: `filled` in the type color, the rest an empty
   *  outline. Reads as "how hard does this hit" without the misleading raw base-power number. */
  private drawPips(x: number, y: number, filled: number, color: string): void {
    const ctx = this.ctx;
    for (let i = 0; i < 5; i++) {
      const px = x + i * 4;
      if (i < filled) { ctx.fillStyle = color; ctx.fillRect(px, y, 3, 3); }
      else { ctx.fillStyle = DARK; ctx.fillRect(px, y, 3, 3); ctx.fillStyle = PAPER; ctx.fillRect(px + 1, y + 1, 1, 1); }
    }
  }

  dispose(): void { cancelAnimationFrame(this.raf); this.canvas.remove(); this.spriteLayer.remove(); }
}
