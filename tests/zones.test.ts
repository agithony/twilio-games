import { describe, it, expect } from 'vitest';
import { themeAtZ, lerpHexColor, DEFAULT_ZONES } from '../shared/zones';
import { TRACK_LEN } from '../shared/constants';

describe('lerpHexColor', () => {
  it('returns endpoints at t=0 and t=1', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpHexColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
  it('blends to the midpoint', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0.5)).toBe('#808080'); // 127.5→128 rounded
  });
});

describe('themeAtZ', () => {
  it('returns a stable theme shape with all fields', () => {
    const t = themeAtZ(0);
    expect(typeof t.sky).toBe('string');
    expect(t.sky).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof t.fogDensity).toBe('number');
    expect(typeof t.sunIntensity).toBe('number');
  });
  it('is cyclic: z=0 equals z=TRACK_LEN equals z=2*TRACK_LEN', () => {
    expect(themeAtZ(0)).toEqual(themeAtZ(TRACK_LEN));
    expect(themeAtZ(50)).toEqual(themeAtZ(TRACK_LEN + 50));
  });
  it('at a zone start, matches that zone theme exactly', () => {
    const z0 = DEFAULT_ZONES[0]!;
    expect(themeAtZ(z0.startZ).sky).toBe(z0.theme.sky);
  });
  it('between two zones, sky is a blend of the two (not equal to either endpoint)', () => {
    // midpoint between zone 0 and zone 1 starts
    const a = DEFAULT_ZONES[0]!, b = DEFAULT_ZONES[1]!;
    const mid = (a.startZ + b.startZ) / 2;
    const sky = themeAtZ(mid).sky;
    expect(sky).not.toBe(a.theme.sky);
    expect(sky).not.toBe(b.theme.sky);
  });
  it('a single-zone list yields that zone everywhere (constant)', () => {
    const one = [{ startZ: 0, theme: DEFAULT_ZONES[0]!.theme }];
    expect(themeAtZ(10, one)).toEqual(themeAtZ(300, one));
  });
});
