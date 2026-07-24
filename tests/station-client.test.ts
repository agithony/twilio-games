import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDisplayToken, displayTokenWasRejected, effectivePublicVisitorBaseUrl, fetchPublicStation, readDisplayToken, rejectDisplayToken, stationJoinUrl, stationLaunchUrl, storeDisplayToken, voiceNumberForLocale } from '../client/station-client';

afterEach(() => vi.unstubAllGlobals());

describe('station voice number selection', () => {
  it('uses the requested locale without borrowing the other locale number', () => {
    const config = {
      phoneNumber: '+18555993809',
      voiceNumbers: { 'en-US': '+18555993809', 'pt-BR': null },
    };
    expect(voiceNumberForLocale(config, 'en-US')).toBe('+18555993809');
    expect(voiceNumberForLocale(config, 'pt-BR')).toBe('');
  });

  it('uses the legacy fallback only when no locale map is present', () => {
    expect(voiceNumberForLocale({ phoneNumber: '+18555993809' }, 'pt-BR')).toBe('+18555993809');
  });
});

describe('public visitor URLs', () => {
  it('prefers the configured public base and falls back to the propagated launch base', () => {
    expect(effectivePublicVisitorBaseUrl('https://public.example/path', 'http://display.local/?joinBaseUrl=https%3A%2F%2Flaunch.example')).toBe('https://public.example');
    expect(effectivePublicVisitorBaseUrl(undefined, 'http://display.local/?joinBaseUrl=https%3A%2F%2Flaunch.example')).toBe('https://launch.example');
  });

  it('rejects non-web bases and builds a normalized visitor join URL', () => {
    expect(effectivePublicVisitorBaseUrl('javascript:alert(1)', 'https://display.example/home')).toBe('https://display.example');
    expect(stationJoinUrl('ARCADE-01', 'pt-BR', 'https://public.example/base')).toBe('https://public.example/join?station=ARCADE-01&locale=pt-BR');
  });

  it('propagates the effective visitor base to launched game pages', () => {
    const target = stationLaunchUrl({
      phase: 'LAUNCHING', revision: 1, activeGame: 'fighter', deadline: null,
      currentReadyCount: 2, nextReadyCount: 0, roster: [], games: [],
      launch: { game: 'fighter', route: '/fighter.html', roomCode: 'ROOM', matchId: 'MATCH', generation: 3 },
      results: [],
      resultSource: null,
    }, 'ARCADE-01', 'en-US', 'https://public.example/path');
    const url = new URL(target!);
    expect(url.searchParams.get('joinBaseUrl')).toBe('https://public.example');
    expect(url.searchParams.has('displayToken')).toBe(false);
    expect(url.searchParams.has('hostToken')).toBe(false);
    expect(url.hash).toBe('');
  });
});

describe('display token session storage', () => {
  it('stores and reads a display token in same-tab session storage', () => {
    const values = new Map<string,string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key:string,value:string) => values.set(key,value),
      getItem: (key:string) => values.get(key) ?? null,
      removeItem: (key:string) => values.delete(key),
    });
    vi.stubGlobal('location', { href: 'https://games.example/' });
    expect(storeDisplayToken('display-secret')).toBe(true);
    expect(readDisplayToken()).toBe('display-secret');
    expect(captureDisplayToken()).toBe('display-secret');
  });

  it('does not ingest display credentials from the page URL', () => {
    const values = new Map<string,string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key:string,value:string) => values.set(key,value),
      getItem: (key:string) => values.get(key) ?? null,
      removeItem: (key:string) => values.delete(key),
    });
    vi.stubGlobal('location', { href: 'https://games.example/#displayToken=url-secret' });
    const replaceState = vi.fn();
    vi.stubGlobal('history', { state: null, replaceState });
    expect(captureDisplayToken()).toBeNull();
    expect(values.size).toBe(0);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('removes a partially stored token when storage setup fails', () => {
    const values = new Map<string,string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key:string,value:string) => values.set(key,value),
      getItem: (key:string) => values.get(key) ?? null,
      removeItem: (key:string) => {
        if (key.endsWith('-rejected')) throw new Error('partial storage failure');
        values.delete(key);
      },
    });
    expect(storeDisplayToken('partial-secret')).toBe(false);
    expect([...values.values()]).not.toContain('partial-secret');
  });

  it('fails safely when session storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => { throw new Error('blocked'); },
      getItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(storeDisplayToken('display-secret')).toBe(false);
    expect(readDisplayToken()).toBeNull();
  });

  it('quarantines a rejected token so a reload cannot restore or retry it', () => {
    const values = new Map<string,string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key:string,value:string) => values.set(key,value),
      getItem: (key:string) => values.get(key) ?? null,
      removeItem: (key:string) => values.delete(key),
    });
    expect(storeDisplayToken('bad-display-token')).toBe(true);
    expect(rejectDisplayToken('bad-display-token')).toBe(true);
    expect(readDisplayToken()).toBeNull();
    expect(displayTokenWasRejected()).toBe(true);
    expect(storeDisplayToken('replacement-token')).toBe(true);
    expect(displayTokenWasRejected()).toBe(false);
  });

  it('exposes station response status as a typed fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    await expect(fetchPublicStation('bad-display-token')).rejects.toMatchObject({ status: 401 });
  });
});
