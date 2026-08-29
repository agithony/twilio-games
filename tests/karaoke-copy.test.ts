import { describe, expect, it } from 'vitest';
import { karaokeCopy, karaokeSongCredit } from '../client/karaoke/karaoke-copy';
import {
  NEVER_GONNA_GIVE_YOU_UP,
  PT_BR_ORIGINAL_DEVELOPMENT_SONG,
} from '../shared/karaoke-songs';
import { KARAOKE_MESSAGES } from '../shared/i18n/karaoke';

describe('Karaoke song display credits', () => {
  it('shows only the artist for the production song', () => {
    expect(karaokeSongCredit(NEVER_GONNA_GIVE_YOU_UP)).toBe('Rick Astley');
  });

  it('shows only the artist for development songs', () => {
    expect(karaokeSongCredit(PT_BR_ORIGINAL_DEVELOPMENT_SONG)).toBe('Voice Karaoke');
  });

  it.each([
    ['en-US', /confirm your name.*number or title.*say Start.*watch the display.*each word.*target/i],
    ['pt-BR', /confirme seu nome.*número ou título.*diga Começar.*olhe para a tela.*cada palavra.*alvo/i],
  ] as const)('keeps %s browser and voice setup concise and implementation-free', (locale, expectedFlow) => {
    const copy = karaokeCopy(locale);
    const browserSetup = [copy.tagline, copy.stationBody, copy.songBody, copy.loadingBody, copy.countdown].join(' ');
    const messages = KARAOKE_MESSAGES[locale];
    const voiceSetup = [
      messages['voice.askName'], messages['voice.gameplay'], messages['voice.catalog'],
      messages['voice.songSelected'], messages['voice.startRequired'],
    ].join(' ');
    const forbidden = /Guitar Hero|Deepgram|Conversation Relay|handoff|pitch|percent|scor(?:e|ing)|weight|pontua|porcent|\btom\b/i;
    expect(copy.tagline).toMatch(expectedFlow);
    expect(voiceSetup).toMatch(locale === 'en-US'
      ? /first name.*number or title.*say Start.*watch the display.*each word.*target/i
      : /primeiro nome.*número ou título.*diga Começar.*olhe para a tela.*cada palavra.*alvo/i);
    expect(`${browserSetup} ${voiceSetup}`).not.toMatch(forbidden);
  });

  it('defines objective guide-vocal calibration directions and positive-delay semantics', () => {
    const copy = karaokeCopy('en-US');
    expect(copy.guideMode).toMatch(/guide vocal/i);
    expect(copy.guideInstructions).toMatch(/first consonant/i);
    expect(copy.guideInstructions).toMatch(/tile arrives first.*later/i);
    expect(copy.guideInstructions).toMatch(/voice arrives first.*earlier/i);
    expect(copy.visualOffsetHelp).toMatch(/positive.*delay.*lyrics.*later/i);
  });
});
