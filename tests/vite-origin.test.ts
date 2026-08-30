import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  configuredGameServerOrigin,
  forwardedGameServerOrigin,
} from '../client/vite.config';

describe('Vite game server Origin forwarding', () => {
  it('defaults the development server origin without replacing a caller override', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts['dev:server'])
      .toBe('PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:5173} tsx watch server/index.ts');
  });

  it('forwards an explicitly configured tunnel or Arcade public origin', () => {
    const expected = configuredGameServerOrigin('http://localhost:8081', 'https://games-tunnel.example/path');
    expect(forwardedGameServerOrigin('http://localhost:5173', 'localhost:5173', expected))
      .toBe('https://games-tunnel.example');
  });

  it('defaults normal API forwarding to the public Vite origin, not the backend origin', () => {
    const expected = configuredGameServerOrigin('http://localhost:8080');
    expect(forwardedGameServerOrigin('http://localhost:5173', 'localhost:5173', expected))
      .toBe('http://localhost:5173');
  });

  it('applies the same fail-closed origin forwarding to Trivia WebSocket upgrades', () => {
    const source = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
    const triviaProxy = /'\/trivia': \{[\s\S]*?\n        \},/.exec(source)?.[0] ?? '';
    expect(triviaProxy).toContain("proxy.on('proxyReqWs'");
    expect(triviaProxy).toContain('forwardedGameServerOrigin(');
    expect(forwardedGameServerOrigin('http://localhost:5173', 'localhost:5173', 'http://localhost:5173'))
      .toBe('http://localhost:5173');
  });

  it('preserves hostile external and malformed Origin headers', () => {
    expect(forwardedGameServerOrigin('https://evil.example', 'localhost:5173', 'http://localhost:5173'))
      .toBe('https://evil.example');
    expect(forwardedGameServerOrigin('not an origin', 'localhost:5173', 'http://localhost:5173'))
      .toBe('not an origin');
  });

  it('recognizes only explicit loopback aliases and still forwards the server policy origin', () => {
    const expected = 'https://games.example';
    expect(forwardedGameServerOrigin('http://localhost:5173', '127.0.0.1:5173', expected)).toBe(expected);
    expect(forwardedGameServerOrigin('http://[::1]:5173', 'localhost:5173', expected)).toBe(expected);
    expect(forwardedGameServerOrigin('http://127.0.0.2:5173', 'localhost:5173', expected))
      .toBe('http://127.0.0.2:5173');
  });
});
