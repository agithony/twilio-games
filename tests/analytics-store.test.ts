import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { AnalyticsStore, dateRange, validDate } from '../server/analytics-store';
import { AnalyticsObserver } from '../server/analytics-observer';
import { KaraokeRoom } from '../server/karaoke-room';
import { analyticsPdf } from '../server/analytics-pdf';
import { ANALYTICS_GAMES } from '../shared/analytics';
import { EN_US_ORIGINAL_DEVELOPMENT_SONG } from '../shared/karaoke-songs';
import type { KaraokeSong } from '../shared/karaoke';

const files: string[] = [];
afterEach(async () => { await Promise.all(files.splice(0).map(file => rm(file, { force: true }))); });
const finalHits = (song: KaraokeSong, score: number) => song.chart.words.map((word, index) => ({
  wordId: word.id, judgment: index === 0 ? 'perfect' as const : 'miss' as const, points: index === 0 ? score : 0,
}));

describe('activation analytics', () => {
  it('persists anonymous daily rollups and aggregates a range', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}.json`; files.push(file);
    const store = new AnalyticsStore(file, 'secret');
    const today = new Date().toISOString().slice(0, 10), at = Date.parse(`${today}T12:00:00Z`);
    store.recordMatch({ game: 'racer', participantIds: ['room:p1', 'room:p2'], durationSeconds: 91.4,
      completed: true, map: 'neon-city', vehicles: ['Roadster', 'Truck'], at });
    store.recordMatch({ game: 'fighter', participantIds: ['fight:f1'], durationSeconds: 45,
      completed: false, map: 'rain', characters: ['nyx', 'wraith'], at });
    store.recordVoiceCommand('fighter', at); await store.flush();

    const reloaded = new AnalyticsStore(file, 'secret'); await reloaded.load();
    const report = reloaded.report(today, today);
    expect(report.summary).toMatchObject({ participants: 3, sessions: 2, completed: 1, abandoned: 1, playSeconds: 136, voiceCommands: 1 });
    expect(report.games.racer.completionRate).toBe(1);
    expect(report.games.karaoke.sessions).toBe(0);
    expect(ANALYTICS_GAMES).toEqual(['racer', 'monsters', 'fighter', 'karaoke']);
    expect(report.selections.maps.map(item => item.name)).toEqual(['neon-city', 'rain']);
    expect(JSON.stringify(await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')))).not.toContain('room:p1');
  });

  it('adds Karaoke buckets to existing version-1 days without losing old metrics', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-legacy.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    const empty = { participants: [], sessions: 0, completed: 0, abandoned: 0, playSeconds: 0,
      voiceCommands: 0, maps: {}, characters: {}, vehicles: {} };
    await writeFile(file, JSON.stringify({ version: 1, days: {
      [today]: { games: { racer: { ...empty, sessions: 2 }, monsters: empty, fighter: empty } },
    } }));
    const store = new AnalyticsStore(file, 'secret');
    await store.load();
    store.recordVoiceCommand('karaoke', Date.parse(`${today}T12:00:00Z`));
    await store.flush();

    const report = store.report(today, today);
    expect(report.games.racer.sessions).toBe(2);
    expect(report.games.karaoke.voiceCommands).toBe(1);
  });

  it('records Karaoke generations, song selection, completion, abandonment, and semantic setup actions', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-karaoke.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T12:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new KaraokeRoom('SING', {
      now: () => now,
      songs: [EN_US_ORIGINAL_DEVELOPMENT_SONG],
      countdownMs: 3_000,
    });
    const singer = room.addPlayer('Ada');
    if ('error' in singer) throw new Error(singer.error);
    expect(room.advance(singer.playerId)).toBe(true);
    expect(room.selectSong(singer.playerId, EN_US_ORIGINAL_DEVELOPMENT_SONG.id)).toBe(true);
    observer.karaokeSetupAction('select_song');
    expect(room.advance(singer.playerId)).toBe(true);
    observer.karaokeSetupAction('start_song');
    observer.karaokeSetupAction('raw lyric transcript' as never);
    observer.karaokeState(room);
    now += 12_000;
    const firstGeneration = room.state().loadingGeneration;
    expect(room.retryLoading(firstGeneration)).toBe(true);
    observer.karaokeState(room);
    now += 8_000;
    expect(store.report(today, today).games.karaoke).toMatchObject({ sessions: 0, abandoned: 0, playSeconds: 0 });
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    observer.karaokeState(room);
    expect(store.report(today, today).games.karaoke.sessions).toBe(0);
    now += 3_000;
    room.tick();
    now += 7_000;
    observer.karaokeState(room);
    now += EN_US_ORIGINAL_DEVELOPMENT_SONG.durationMs - 7_000;
    room.tick();
    observer.karaokeState(room);
    expect(room.finalizeMediaScore(singer.playerId, 42_000, finalHits(room.state().selectedSong!, 42_000))).toBe(true);
    observer.karaokeState(room);

    expect(room.advance(singer.playerId)).toBe(true);
    expect(room.selectSong(singer.playerId, EN_US_ORIGINAL_DEVELOPMENT_SONG.id)).toBe(true);
    expect(room.advance(singer.playerId)).toBe(true);
    observer.karaokeState(room);
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    observer.karaokeState(room);
    now += 3_000;
    room.tick();
    observer.karaokeState(room);
    now += 45_000;
    room.removePlayer(singer.playerId);
    observer.karaokeState(room);
    await store.flush();

    const report = store.report(today, today);
    expect(report.games.karaoke).toMatchObject({
      participants: 1, sessions: 2, completed: 1, abandoned: 1,
      playSeconds: EN_US_ORIGINAL_DEVELOPMENT_SONG.durationMs / 1_000 + 45, voiceCommands: 2,
    });
    expect(report.selections.songs).toEqual([{ name: EN_US_ORIGINAL_DEVELOPMENT_SONG.id, count: 2 }]);
    const persisted = await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'));
    expect(persisted).toContain(EN_US_ORIGINAL_DEVELOPMENT_SONG.id);
    expect(persisted).not.toMatch(/Ada|Neon Hello|audioUrl|chart|word_judgment|lyrics/i);
  });

  it('ignores pre-performance hard aborts and finalizes an active Karaoke performance once', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-abort.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T15:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new KaraokeRoom('ABORT', {
      now: () => now, songs: [EN_US_ORIGINAL_DEVELOPMENT_SONG], countdownMs: 3_000,
    });
    const singer = room.addPlayer('Ada');
    if ('error' in singer) throw new Error(singer.error);
    room.advance(singer.playerId);
    room.selectSong(singer.playerId, EN_US_ORIGINAL_DEVELOPMENT_SONG.id);
    room.advance(singer.playerId);
    observer.karaokeState(room);
    observer.karaokeAborted(room.code);
    expect(store.report(today, today).games.karaoke.sessions).toBe(0);

    room.ready(room.state().loadingGeneration);
    now += 3_000;
    room.tick();
    observer.karaokeState(room);
    now += 45_000;
    observer.karaokeAborted(room.code);
    observer.karaokeAborted(room.code);
    await store.flush();

    expect(store.report(today, today).games.karaoke).toMatchObject({
      participants: 1, sessions: 1, completed: 0, abandoned: 1, playSeconds: 45,
    });
  });

  it('validates bounded UTC date ranges', () => {
    expect(validDate('2026-07-14')).toBe('2026-07-14');
    expect(validDate('2026-02-30')).toBeNull();
    expect(validDate('nope')).toBeNull();
    expect(dateRange('2026-07-13', '2026-07-15')).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
    expect(() => dateRange('2026-07-15', '2026-07-13')).toThrow();
  });

  it('creates a downloadable PDF with visible abandonment and sub-minute play time', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-pdf.json`; files.push(file);
    const store = new AnalyticsStore(file, 'secret');
    store.recordMatch({ game: 'karaoke', participantIds: ['karaoke:room:p1'], durationSeconds: 45,
      completed: false, song: 'short-song', at: Date.parse('2026-07-14T12:00:00Z') });
    await store.flush();
    const report = store.report('2026-07-14', '2026-07-14');
    const pdf = analyticsPdf(report);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.toString()).toContain('TWILIO GAMES');
    expect(pdf.toString()).toContain('Abandoned: 1');
    expect(pdf.toString()).toContain('Active play time: 45s');
    expect(pdf.toString()).toContain('%%EOF');
    expect(report.insights).toContain('1 session was abandoned before completion.');
  });

  it('offers Karaoke in the private analytics dashboard', () => {
    const html = readFileSync(new URL('../client/analytics/index.html', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../client/analytics/analytics.ts', import.meta.url), 'utf8');
    expect(html).toContain('<option value="karaoke">Voice Karaoke</option>');
    expect(client).toContain("karaoke:'Karaoke'");
    expect(client).toContain("'Abandoned sessions'");
    expect(client).toContain('return `${total}s`');
  });
});
