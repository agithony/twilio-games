import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { AnalyticsStore, dateRange, validDate } from '../server/analytics-store';
import { analyticsPdf } from '../server/analytics-pdf';

const files: string[] = [];
afterEach(async () => { await Promise.all(files.splice(0).map(file => rm(file, { force: true }))); });

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
    expect(report.selections.maps.map(item => item.name)).toEqual(['neon-city', 'rain']);
    expect(JSON.stringify(await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')))).not.toContain('room:p1');
  });

  it('validates bounded UTC date ranges', () => {
    expect(validDate('2026-07-14')).toBe('2026-07-14');
    expect(validDate('2026-02-30')).toBeNull();
    expect(validDate('nope')).toBeNull();
    expect(dateRange('2026-07-13', '2026-07-15')).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
    expect(() => dateRange('2026-07-15', '2026-07-13')).toThrow();
  });

  it('creates a downloadable PDF from the same report model', () => {
    const store = new AnalyticsStore('unused.json', 'secret');
    const pdf = analyticsPdf(store.report('2026-07-14', '2026-07-14'));
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.toString()).toContain('TWILIO GAMES');
    expect(pdf.toString()).toContain('%%EOF');
  });
});
