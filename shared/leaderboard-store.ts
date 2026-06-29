// Pure, testable logic for the persistent global leaderboard. Holds a flat history of finished-race
// entries (one per racer who crossed the line). Like maps-store.ts: validates input, REFUSES to
// proceed if the existing file is corrupt (so a bad append can't wipe history), caps the stored
// size so the file can't grow unbounded. No fs here — the http layer does the atomic write.
import type { RaceResult } from './types';

export interface LeaderboardEntry {
  name: string;
  map: string;
  carIndex: number;
  finishT: number;   // seconds from GO to the line (lower = better)
  at: number;        // epoch ms the race finished (passed in; this module never reads the clock)
}

export type AppendResult =
  | { ok: true; entries: LeaderboardEntry[] }
  | { ok: false; error: string };

/** Max history rows kept on disk. Display only ever shows a small top-N, so this is plenty. */
const MAX_HISTORY = 1000;

/** Parse a stored leaderboard JSON string into clean entries (drops anything malformed). */
export function parseLeaderboard(json: string): LeaderboardEntry[] {
  const trimmed = (json ?? '').trim();
  if (trimmed === '') return [];
  let o: unknown;
  try { o = JSON.parse(trimmed); } catch { return []; }
  if (!Array.isArray(o)) return [];
  return o.filter(isEntry);
}

function isEntry(v: unknown): v is LeaderboardEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.name === 'string' && typeof e.map === 'string'
    && typeof e.finishT === 'number' && Number.isFinite(e.finishT)
    && typeof e.carIndex === 'number' && typeof e.at === 'number';
}

/** Returns null (not []) when the existing file is corrupt, so callers can refuse to overwrite. */
function parseExistingStrict(json: string): LeaderboardEntry[] | null {
  const trimmed = (json ?? '').trim();
  if (trimmed === '') return [];
  let o: unknown;
  try { o = JSON.parse(trimmed); } catch { return null; }
  if (!Array.isArray(o)) return null;
  return o.filter(isEntry);   // tolerate junk rows inside a valid array, but a non-array is corrupt
}

/** Append one race's finished racers to the board. `at` is the timestamp (passed in, never read here). */
export function appendResults(existingJson: string,
  race: { map: string; results: RaceResult[]; at: number }): AppendResult {
  if (typeof race.map !== 'string' || race.map.trim() === '') return { ok: false, error: 'missing map' };
  const existing = parseExistingStrict(existingJson);
  if (existing === null) return { ok: false, error: 'existing leaderboard is corrupt — refusing to overwrite' };

  const fresh: LeaderboardEntry[] = race.results
    .filter(r => r.finished && Number.isFinite(r.finishT) && r.finishT > 0)
    .map(r => ({ name: r.name, map: race.map, carIndex: r.carIndex, finishT: r.finishT, at: race.at }));

  // Newest first, then cap. Keeping newest means the cap drops the oldest history.
  const entries = [...fresh, ...existing].slice(0, MAX_HISTORY);
  return { ok: true, entries };
}

/** Best times ascending, optionally filtered to a map, limited to `limit` (default 10). */
export function topEntries(entries: LeaderboardEntry[], opts: { map?: string; limit?: number } = {}): LeaderboardEntry[] {
  const limit = opts.limit ?? 10;
  return entries
    .filter(e => !opts.map || e.map === opts.map)
    .slice()
    .sort((a, b) => a.finishT - b.finishT)
    .slice(0, limit);
}
