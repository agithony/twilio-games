// Placeholder creature "sprites" for Voice Monsters, drawn procedurally on a canvas so the game is
// fully playable BEFORE any real art exists. Each monster gets a deterministic blocky pixel-critter
// (seeded by its id) in the Game Boy 4-shade palette, tinted by its element type. Front + back views.
//
// DROP-IN REAL SPRITES LATER: the renderer first tries to load /assets/monsters/<id>_<front|back>.png;
// only if that 404s does it fall back to these placeholders. So shipping real art is a pure asset
// drop — no code change (the QR/music pattern).
import type { MonsterType } from '../../shared/monster-types';

// Game Boy DMG 4-shade palette (darkest → lightest), the base "ink" of every sprite.
export const GB_SHADES = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] as const;

// A per-type accent so an electric critter reads yellow, a fire drake red, etc. — kept within a
// GB-ish muted range so it still feels like the handheld, not modern hi-color.
const TYPE_TINT: Record<MonsterType, string> = {
  normal:   '#8bac0f',
  fire:     '#c0532b',
  water:    '#3a6ea5',
  grass:    '#4a7a2a',
  electric: '#c9b02b',
  rock:     '#7a6a4f',
  ground:   '#9a7b4f',
  flying:   '#6a8fb0',
};

/** Tiny deterministic PRNG seeded from a string — so a monster's placeholder is stable across loads. */
function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpriteOpts { id: string; type: MonsterType; view: 'front' | 'back'; size?: number; }

/**
 * Draw a placeholder creature into a fresh canvas + return it. A symmetric blocky body on a coarse
 * grid (GB pixel feel), tinted by type, with simple eyes on the FRONT view (the back view is a
 * plainer silhouette, like the originals). Deterministic per id so it doesn't shimmer between frames.
 */
export function drawMonsterSprite(opts: SpriteOpts): HTMLCanvasElement {
  const px = 8;                              // logical grid cells across (chunky GB pixels)
  const size = opts.size ?? 96;
  const cell = Math.floor(size / px);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;         // crisp pixels, no blur

  const rng = seededRng(`${opts.id}:${opts.view}`);
  const tint = TYPE_TINT[opts.type];
  const outline = GB_SHADES[0];

  // Build a symmetric occupancy grid: fill the left half at random density, mirror to the right, so
  // the critter always looks intentional (bilateral) rather than noise.
  const half = Math.ceil(px / 2);
  const grid: boolean[][] = [];
  for (let y = 0; y < px; y++) {
    grid[y] = [];
    for (let x = 0; x < half; x++) {
      // denser in the middle rows/cols → a rounded body; sparse at the corners.
      const edge = (y === 0 || y === px - 1) ? 0.35 : 0.8;
      grid[y]![x] = rng() < edge;
    }
    for (let x = half; x < px; x++) grid[y]![x] = grid[y]![px - 1 - x]!;   // mirror
  }

  // Paint filled cells: body in the type tint, a darker outline ring for depth.
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      if (!grid[y]![x]) continue;
      ctx.fillStyle = tint;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // Outline pass: any filled cell bordering an empty cell gets a dark edge (cheap 1-cell stroke).
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      if (!grid[y]![x]) continue;
      const empty = (yy: number, xx: number) => yy < 0 || yy >= px || xx < 0 || xx >= px || !grid[yy]![xx];
      ctx.fillStyle = outline;
      if (empty(y - 1, x)) ctx.fillRect(x * cell, y * cell, cell, 2);
      if (empty(y + 1, x)) ctx.fillRect(x * cell, (y + 1) * cell - 2, cell, 2);
      if (empty(y, x - 1)) ctx.fillRect(x * cell, y * cell, 2, cell);
      if (empty(y, x + 1)) ctx.fillRect((x + 1) * cell - 2, y * cell, 2, cell);
    }
  }
  // FRONT view gets a face: two eyes in the upper-middle band (the back view stays a silhouette).
  if (opts.view === 'front') {
    const eyeY = Math.floor(px * 0.35) * cell;
    ctx.fillStyle = outline;
    ctx.fillRect(Math.floor(px * 0.3) * cell, eyeY, cell, cell);
    ctx.fillRect(Math.floor(px * 0.6) * cell, eyeY, cell, cell);
  }
  return canvas;
}
