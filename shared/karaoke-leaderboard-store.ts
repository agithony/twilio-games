import { isSafeKaraokeId } from './karaoke';
import { KARAOKE_MAX_SCORE, type KaraokeResult } from './karaoke-protocol';

export interface KaraokeLeaderboardEntry {
  name: string;
  songId: string;
  score: number;
  bestCombo: number;
  at: number;
  enginePlayerId?: string;
}

export type AppendKaraokeResult =
  | { ok: true; entries: KaraokeLeaderboardEntry[] }
  | { ok: false; error: string };

export const MAX_KARAOKE_LEADERBOARD_HISTORY = 1000;

export function parseKaraokeLeaderboard(json: string): KaraokeLeaderboardEntry[] {
  return parseKaraokeLeaderboardStrict(json) ?? [];
}

export function parseKaraokeLeaderboardStrict(json: string): KaraokeLeaderboardEntry[] | null {
  const trimmed = (json ?? '').trim();
  if (!trimmed) return [];
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!Array.isArray(value)) return null;
  return value.every(isKaraokeLeaderboardEntry) ? value : null;
}

export function appendKaraokeResult(
  existingJson: string,
  result: KaraokeResult,
  identityNamespace?: string,
): AppendKaraokeResult {
  const existing = parseKaraokeLeaderboardStrict(existingJson);
  if (existing === null) return { ok: false, error: 'existing Karaoke leaderboard is corrupt - refusing to overwrite' };
  if (!isSafeKaraokeId(result.songId) || !Number.isSafeInteger(result.score)
    || result.score < 0 || result.score > KARAOKE_MAX_SCORE
    || !Number.isSafeInteger(result.bestCombo) || result.bestCombo < 0
    || !Number.isSafeInteger(result.completedAtMs) || result.completedAtMs < 0) {
    return { ok: false, error: 'invalid Karaoke result' };
  }
  const fresh: KaraokeLeaderboardEntry = {
    name: cleanName(result.name),
    songId: result.songId,
    score: result.score,
    bestCombo: result.bestCombo,
    at: result.completedAtMs,
    ...(identityNamespace ? { enginePlayerId: `${identityNamespace}:${result.playerId}` } : {}),
  };
  const grouped = new Map<string, KaraokeLeaderboardEntry[]>();
  for (const entry of [fresh, ...existing]) {
    const song = grouped.get(entry.songId) ?? [];
    song.push(entry);
    grouped.set(entry.songId, song);
  }
  return {
    ok: true,
    entries: [...grouped.values()].flatMap(song => rankedKaraokeEntries(song).slice(0, MAX_KARAOKE_LEADERBOARD_HISTORY)),
  };
}

export function topKaraokeEntries(
  entries: readonly KaraokeLeaderboardEntry[],
  options: { songId?: string; limit?: number } = {},
): KaraokeLeaderboardEntry[] {
  return entries
    .filter(entry => !options.songId || entry.songId === options.songId)
    .sort(compareKaraokeEntries)
    .slice(0, options.limit ?? 10);
}

function rankedKaraokeEntries(entries: readonly KaraokeLeaderboardEntry[]): KaraokeLeaderboardEntry[] {
  return entries.slice().sort(compareKaraokeEntries);
}

function compareKaraokeEntries(a: KaraokeLeaderboardEntry, b: KaraokeLeaderboardEntry): number {
  return b.score - a.score || b.bestCombo - a.bestCombo || a.at - b.at;
}

function isKaraokeLeaderboardEntry(value: unknown): value is KaraokeLeaderboardEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === 'string' && entry.name.length <= 40
    && typeof entry.songId === 'string' && isSafeKaraokeId(entry.songId)
    && Number.isSafeInteger(entry.score) && (entry.score as number) >= 0 && (entry.score as number) <= KARAOKE_MAX_SCORE
    && Number.isSafeInteger(entry.bestCombo) && (entry.bestCombo as number) >= 0
    && Number.isSafeInteger(entry.at) && (entry.at as number) >= 0
    && (entry.enginePlayerId === undefined || typeof entry.enginePlayerId === 'string');
}

function cleanName(name: string): string {
  return name.normalize('NFC').trim().slice(0, 40) || 'Singer';
}
