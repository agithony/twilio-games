import { describe, expect, it } from 'vitest';
import { effectivePublicVisitorBaseUrl, stationJoinUrl, stationLaunchUrl, voiceNumberForLocale } from '../client/station-client';

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
    }, 'ARCADE-01', 'en-US', 'https://public.example/path');
    expect(new URL(target!).searchParams.get('joinBaseUrl')).toBe('https://public.example');
  });
});
