import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPlayUrl, sanitizeRoomCode, sanitizeName } from '../client/home-nav';

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
  for (const page of ['play.html', 'monsters.html']) {
    it(`${page} keeps an accessible persistent Home link`, () => {
      const html = readFileSync(new URL(`../client/${page}`, import.meta.url), 'utf8');
      expect(html).toContain('class="game-home"');
      expect(html).toContain('href="/"');
      expect(html).toContain('aria-label="Return to Twilio Games home"');
      expect(html).toContain('<span>Home</span>');
    });
  }
});
