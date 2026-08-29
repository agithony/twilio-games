import { describe, expect, it } from 'vitest';
import {
  MAX_KARAOKE_LEADERBOARD_HISTORY,
  appendKaraokeResult,
  parseKaraokeLeaderboard,
  parseKaraokeLeaderboardStrict,
  topKaraokeEntries,
} from '../shared/karaoke-leaderboard-store';

const result = {
  generation: 1,
  playerId: 'p1',
  name: 'Ada',
  songId: 'never-gonna-give-you-up',
  score: 91_000,
  bestCombo: 42,
  completedAtMs: 1_000,
};

describe('Karaoke leaderboard store', () => {
  it('appends bounded attributed results without overwriting corrupt storage', () => {
    expect(appendKaraokeResult('{', result)).toEqual({
      ok: false,
      error: 'existing Karaoke leaderboard is corrupt - refusing to overwrite',
    });
    const existing = Array.from({ length: MAX_KARAOKE_LEADERBOARD_HISTORY }, (_, index) => ({
      name: `Singer ${index}`,
      songId: 'never-gonna-give-you-up',
      score: index,
      bestCombo: index,
      at: index,
    }));
    const appended = appendKaraokeResult(JSON.stringify(existing), result, 'ROOM');
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.entries).toHaveLength(MAX_KARAOKE_LEADERBOARD_HISTORY);
    expect(appended.entries[0]).toEqual({
      name: 'Ada', songId: result.songId, score: 91_000, bestCombo: 42, at: 1_000,
      enginePlayerId: 'ROOM:p1',
    });
  });

  it('ranks by score, combo, then the earliest achievement and filters by song', () => {
    const entries = [
      { name: 'Later', songId: 'song-a', score: 90_000, bestCombo: 20, at: 3 },
      { name: 'Combo', songId: 'song-a', score: 90_000, bestCombo: 30, at: 4 },
      { name: 'First', songId: 'song-a', score: 90_000, bestCombo: 20, at: 2 },
      { name: 'Other', songId: 'song-b', score: 100_000, bestCombo: 50, at: 1 },
    ];
    expect(topKaraokeEntries(entries, { songId: 'song-a' }).map(entry => entry.name))
      .toEqual(['Combo', 'First', 'Later']);
  });

  it('treats any malformed row as corrupt instead of silently deleting history', () => {
    expect(parseKaraokeLeaderboardStrict('not json')).toBeNull();
    expect(parseKaraokeLeaderboard(JSON.stringify([result, { score: 'bad' }]))).toEqual([]);
    const stored = { name: 'Ada', songId: result.songId, score: 10, bestCombo: 2, at: 1 };
    expect(parseKaraokeLeaderboardStrict(JSON.stringify([stored, { score: 'bad' }]))).toBeNull();
    expect(parseKaraokeLeaderboard(JSON.stringify([stored]))).toEqual([stored]);
  });
});
