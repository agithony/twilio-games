// Pure, testable logic for the /api/maps save endpoint. Merges one posted level config into the
// existing maps.json content WITHOUT the footguns the old inline handler had:
//   - validates the posted config through mergeLevel (no junk/unsafe fields persisted),
//   - refuses to proceed if the EXISTING file is corrupt (so a bad save can't silently wipe every
//     other level — the old code JSON.parse(corrupt) -> {} -> overwrite-all),
//   - rejects dangerous map keys (__proto__/constructor/prototype) and empty names.
// No fs/DOM here — the http layer does the atomic write; this just computes the new map set.
import { mergeLevel, type LevelConfig } from './level';

export type MergeResult =
  | { ok: true; maps: Record<string, LevelConfig> }
  | { ok: false; error: string };

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parse the existing maps.json text into a plain object, or null if it's corrupt (NOT {}). */
function parseExisting(existingJson: string): Record<string, unknown> | null {
  const trimmed = existingJson.trim();
  if (trimmed === '') return {};   // missing/empty file = a fresh start, not corruption
  let o: unknown;
  try { o = JSON.parse(trimmed); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return o as Record<string, unknown>;
}

export function mergeMapConfig(existingJson: string, posted: unknown): MergeResult {
  if (!posted || typeof posted !== 'object') return { ok: false, error: 'config must be an object' };
  const name = (posted as { map?: unknown }).map;
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: 'missing map name' };
  if (UNSAFE_KEYS.has(name)) return { ok: false, error: 'invalid map name' };

  const existing = parseExisting(existingJson);
  if (existing === null) return { ok: false, error: 'existing maps file is corrupt — refusing to overwrite' };

  // Re-validate every existing entry through mergeLevel too, so a normalize is idempotent and one
  // bad pre-existing entry can't crash the save. Skip unsafe keys defensively.
  const maps: Record<string, LevelConfig> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (UNSAFE_KEYS.has(k)) continue;
    maps[k] = mergeLevel(v);
  }
  // The posted config wins for its key, normalized through the same validator the game/loader use.
  maps[name] = mergeLevel(posted);
  return { ok: true, maps };
}
