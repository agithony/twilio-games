// Draws a Voice Monsters creature onto a canvas from a HAND-AUTHORED pixel grid (monster-art.ts) in
// the Game Boy 4-shade palette, tinted by the creature's element type (a fire drake reads red, an
// electric mouse yellow, …). Distinct on-model silhouettes — NOT the old procedural noise. Front +
// back views (back = the same body as a darker silhouette with the face removed, since your own
// monster is shown from behind).
//
// DROP-IN REAL SPRITES LATER: battle-renderer tries /assets/monsters/<id>_<view>.gif then .png first
// (animated GIF wins) and only falls back to this, so shipping real art is a pure asset drop.
import type { MonsterType } from '../../shared/monster-types';
import { MONSTER_ART, type ArtGrid } from './monster-art';

// Game Boy DMG 4-shade palette (darkest → lightest) — the neutral "ink" range.
export const GB_SHADES = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] as const;

// Per-type body tint (mid + light shade) so each creature reads as its element. Kept slightly muted
// so it still feels like the handheld. [mid, light] pairs.
const TYPE_TINT: Record<MonsterType, [string, string]> = {
  normal:   ['#8a8a5a', '#c8c89a'],
  fire:     ['#c0532b', '#f0a24e'],
  water:    ['#3a6ea5', '#79b0e0'],
  grass:    ['#4a7a2a', '#8fce5a'],
  electric: ['#c9a52b', '#f5e06a'],
  rock:     ['#7a6a4f', '#b8a888'],
  ground:   ['#9a7b4f', '#d0b483'],
  flying:   ['#5a7fb0', '#a8c8e8'],
  psychic:  ['#9b3fb0', '#e58fd0'],
};

const INK = GB_SHADES[0];                 // outline / darkest
const IVORY = '#f4f4e0';                  // teeth/tusks/belly highlight
const EYE = '#101820';                    // eye ink

export interface SpriteOpts { id: string; type: MonsterType; view: 'front' | 'back'; size?: number; }

/** Resolve one grid char → a fill color (or null = transparent), given the type tint + view. On the
 *  BACK view the face is dropped (eyes/accents become body) so the silhouette reads cleanly. */
function colorFor(ch: string, tint: [string, string], accent: string, back: boolean): string | null {
  const [mid, light] = tint;
  switch (ch) {
    case '.': case ' ': return null;         // transparent
    case 'X': return INK;                    // outline
    case '#': return mid;                    // body
    case 'o': return light;                  // body highlight
    case 'w': return back ? mid : IVORY;     // belly/teeth (front); merges into body on the back
    case 'e': return back ? mid : EYE;       // eyes vanish on the back view
    case '*': return back ? light : accent;  // type accent (bolt/leaf tips) → plain on the back
    default:  return mid;
  }
}

/** A slightly punchier accent than the light tint, for '*' detail cells (bolt tail, leaf tips, tusks). */
const TYPE_ACCENT: Record<MonsterType, string> = {
  normal: '#e8e8c0', fire: '#ffd23f', water: '#bfe3ff', grass: '#c6f06a',
  electric: '#fff27a', rock: '#d8c8a0', ground: '#e8cf9a', flying: '#d6ecff',
  psychic: '#f7b8ec',
};

/** Draw a creature to a fresh canvas. Uses the hand-authored grid for its id; falls back to a simple
 *  filled blob only for an unknown id (should never happen for the fixed roster). */
export function drawMonsterSprite(opts: SpriteOpts): HTMLCanvasElement {
  const grid: ArtGrid = MONSTER_ART[opts.id] ?? [];
  const rows = grid.length || 16;
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0) || 16;
  const dim = Math.max(rows, cols);         // square cell grid so proportions hold
  const size = opts.size ?? 96;
  const cell = Math.max(1, Math.floor(size / dim));
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tint = TYPE_TINT[opts.type];
  const accent = TYPE_ACCENT[opts.type];
  const back = opts.view === 'back';
  // Center the grid in the canvas.
  const ox = Math.floor((size - cols * cell) / 2);
  const oy = Math.floor((size - rows * cell) / 2);

  if (grid.length === 0) {                  // unknown id → plain tinted lozenge (never for the roster)
    ctx.fillStyle = tint[0];
    ctx.fillRect(size * 0.2, size * 0.2, size * 0.6, size * 0.6);
    return canvas;
  }

  for (let y = 0; y < rows; y++) {
    const row = grid[y]!;
    for (let x = 0; x < cols; x++) {
      const color = colorFor(row[x] ?? '.', tint, accent, back);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  return canvas;
}
