import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { karaokeCopy } from '../client/karaoke/karaoke-copy';

describe('Karaoke leaderboard UI', () => {
  it('loads a per-song top ten into the localized results screen', async () => {
    const [script, styles] = await Promise.all([
      readFile('client/karaoke/karaoke.ts', 'utf8'),
      readFile('client/karaoke/karaoke.css', 'utf8'),
    ]);
    expect(script).toContain('/api/karaoke/leaderboard?song=');
    expect(script).toContain("state.phase === 'finalizing'");
    expect(script).toContain('class="flow-card karaoke-board"');
    expect(script).toContain('escapeHtml(entry.name)');
    expect(styles).toContain('.karaoke-board-row');
    expect(styles).toContain('container-type:inline-size');
    expect(styles).toContain('clamp(52px,20cqi,104px)');
    expect(karaokeCopy('en-US').leaderboard).toMatch(/all-time leaderboard/i);
    expect(karaokeCopy('pt-BR').leaderboard).toMatch(/ranking/i);
    expect(karaokeCopy('en-US').finalizing).toMatch(/scoring/i);
  });
});
