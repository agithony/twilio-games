import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../client/arcade/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../client/arcade/arcade.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/arcade/arcade.css', import.meta.url), 'utf8');
const home = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
const racerMain = readFileSync(new URL('../client/main.ts', import.meta.url), 'utf8');
const racerScreens = readFileSync(new URL('../client/screens.ts', import.meta.url), 'utf8');

describe('Arcade browser UI', () => {
  it('exposes discoverable player, wallet, challenge, queue, and operator controls', () => {
    expect(home).toContain('href="/arcade/"');
    for (const id of [
      'registration-form', 'wallet-panel', 'challenge-panel', 'join-form',
      'queue-actions', 'mode-form', 'operator-queue',
      'start-selected', 'complete-selected',
    ]) expect(html).toContain(`id="${id}"`);
    for (const endpoint of [
      '/api/arcade/session', '/api/arcade/register', '/api/arcade/wallet',
      '/api/arcade/challenges', '/api/arcade/queue/join', '/api/admin/arcade/queue',
      '/api/admin/arcade/matches/start',
    ]) expect(script).toContain(endpoint);
  });

  it('keeps local browser traffic same-origin through Vite', () => {
    expect(vite).toContain("'/api':");
    expect(vite).toContain("'/auth':");
    expect(vite).toContain("arcade: resolve(__dirname, 'arcade/index.html')");
    expect(vite).toContain("url === '/arcade'");
  });

  it('uses Twilio typography, theme tokens, and a persistent theme toggle', () => {
    expect(css).toContain("font-family:'Twilio Sans Display'");
    expect(css).toContain('--th-bg:#000D25');
    expect(css).toContain('--red:#EF223A');
    expect(html).toContain("localStorage.getItem('twilio-theme')");
    expect(script).toContain("localStorage.setItem('twilio-theme'");
    expect(css).not.toMatch(/purple|amber|emerald|green|orange|yellow/i);
    expect(script).toContain('selectedOperatorEntries');
    expect(script).toContain('entry.approachingConfirmedAt');
    expect(script).toContain("['localhost','127.0.0.1']");
  });

  it('separates player/operator views and renders the persistent cabinet QR', () => {
    expect(script).toContain("get('operator') === '1'");
    expect(script).toContain("new URL('/arcade/',location.origin)");
    expect(html).toContain('id="player-qr"');
    expect(html).toContain('SMS / WhatsApp</b> Not connected yet');
    expect(racerMain).toContain("new URL('/arcade/', location.origin)");
    expect(racerScreens).toContain('screen.lobby.coinQrCaption');
  });

  it('does not wire browser speech synthesis into the Voice Racer display', () => {
    expect(racerMain).toContain('new Announcer({ sink: null');
    expect(racerMain).not.toContain('browserSpeechSink');
  });
});
