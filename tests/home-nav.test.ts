import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildPlayUrl,
  calculatePageCount,
  clampPageIndex,
  orderByConfiguredIds,
  sanitizeRoomCode,
  sanitizeName,
} from '../client/home-nav';
import { HOME_MESSAGES } from '../shared/i18n/home';

describe('standalone game pagination', () => {
  it('describes Trivia scoring independently for every correct caller', () => {
    expect(HOME_MESSAGES['en-US']['games.trivia.blurb']).toContain('Every correct caller scores independently.');
    expect(HOME_MESSAGES['pt-BR']['games.trivia.blurb']).toContain('Cada jogador que acerta marca pontos de forma independente.');
  });

  it('uses the configured order and appends any newly introduced game safely', () => {
    const games = [{ id: 'racer' }, { id: 'monsters' }, { id: 'fighter' }, { id: 'karaoke' }, { id: 'trivia' }];
    expect(orderByConfiguredIds(games, ['trivia', 'karaoke', 'fighter', 'racer', 'monsters']).map(game => game.id))
      .toEqual(['trivia', 'karaoke', 'fighter', 'racer', 'monsters']);
    expect(orderByConfiguredIds(games, ['fighter']).map(game => game.id))
      .toEqual(['fighter', 'racer', 'monsters', 'karaoke', 'trivia']);
  });

  it('calculates pages in groups of three', () => {
    expect([0, 1, 3, 4, 6, 7].map(count => calculatePageCount(count))).toEqual([0, 1, 1, 2, 2, 3]);
    expect(calculatePageCount(5)).toBe(2);
  });

  it('clamps both navigation boundaries and a page after the catalog shrinks', () => {
    expect(clampPageIndex(-1, 4)).toBe(0);
    expect(clampPageIndex(1, 4)).toBe(1);
    expect(clampPageIndex(2, 4)).toBe(1);
    expect(clampPageIndex(1, 3)).toBe(0);
    expect(clampPageIndex(4, 0)).toBe(0);
  });
});

describe('sanitizeRoomCode', () => {
  it('keeps a valid 4-digit code', () => {
    expect(sanitizeRoomCode('4821')).toBe('4821');
  });
  it('strips non-digits and caps at 4', () => {
    expect(sanitizeRoomCode('ab12-34xx')).toBe('1234');
  });
  it('defaults when fewer than 4 digits', () => {
    expect(sanitizeRoomCode('12')).toBe('4821');
    expect(sanitizeRoomCode('')).toBe('4821');
  });
});

describe('sanitizeName', () => {
  it('trims and caps length', () => {
    expect(sanitizeName('  Ada  ')).toBe('Ada');
    expect(sanitizeName('x'.repeat(40)).length).toBe(20);
  });
  it('defaults empty to Racer', () => {
    expect(sanitizeName('   ')).toBe('Racer');
    expect(sanitizeName('')).toBe('Racer');
  });
});

describe('buildPlayUrl', () => {
  it('screen mode → display + room, no name', () => {
    expect(buildPlayUrl({ mode: 'screen', roomCode: '4821' }))
      .toBe('play.html?display=1&room=4821');
  });
  it('device mode → room + encoded name', () => {
    expect(buildPlayUrl({ mode: 'device', roomCode: '4821', name: 'Ada' }))
      .toBe('play.html?room=4821&name=Ada');
  });
  it('device mode URL-encodes special characters in the name', () => {
    expect(buildPlayUrl({ mode: 'device', roomCode: '4821', name: 'A B&C' }))
      .toBe('play.html?room=4821&name=A%20B%26C');
  });
  it('sanitizes a bad room code into the URL', () => {
    expect(buildPlayUrl({ mode: 'screen', roomCode: 'xx' }))
      .toBe('play.html?display=1&room=4821');
  });
  it('device mode with empty name defaults to Racer', () => {
    expect(buildPlayUrl({ mode: 'device', roomCode: '1234', name: '' }))
      .toBe('play.html?room=1234&name=Racer');
  });
});

describe('in-game home navigation', () => {
  for (const page of ['play.html', 'monsters.html', 'fighter.html', 'karaoke.html']) {
    it(`${page} keeps an accessible persistent Home link`, () => {
      const html = readFileSync(new URL(`../client/${page}`, import.meta.url), 'utf8');
      expect(html).toContain('class="game-home"');
      expect(html).toContain('href="/"');
      expect(html).toContain('aria-label="Return to Twilio Games home"');
      expect(html).toMatch(/<span(?:\s+id="[^"]+")?>Home<\/span>/);
    });
  }

  it('Voice Fighter exposes the shared music toggle container', () => {
    const html = readFileSync(new URL('../client/fighter.html', import.meta.url), 'utf8');
    expect(html).toContain('id="music-toggle-container"');
  });

  it('shows Magician attribution only on non-game entry surfaces', () => {
    const home = readFileSync(new URL('../client/home.ts', import.meta.url), 'utf8');
    const editor = readFileSync(new URL('../client/editor/hub.ts', import.meta.url), 'utf8');
    expect(home).toContain('injectMagicHat()');
    expect(editor).toContain('injectMagicHat()');
    for (const file of ['main.ts', 'battle/monsters.ts', 'fighter/fighter.ts']) {
      expect(readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8')).not.toContain('injectMagicHat');
    }
  });

  it('orders standalone cards from the persisted station game order', () => {
    const home = readFileSync(new URL('../client/home.ts', import.meta.url), 'utf8');
    expect(home).toContain('standaloneGameOrder=[...config.station.automaticSelection.order]');
    expect(home).toContain('orderByConfiguredIds(PLAYABLE_ARCADE_GAMES,standaloneGameOrder)');
  });
});
