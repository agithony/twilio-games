import { describe, expect, it } from 'vitest';
import {
  configuredGameServerOrigin,
  forwardedGameServerOrigin,
} from '../client/vite.config';

describe('Vite game server Origin forwarding', () => {
  it('forwards the explicitly configured Arcade server origin', () => {
    const expected = configuredGameServerOrigin('http://localhost:8081', 'http://localhost:5173');
    expect(forwardedGameServerOrigin('http://localhost:5173', 'localhost:5173', expected))
      .toBe('http://localhost:5173');
  });

  it('defaults to the backend origin for normal development', () => {
    const expected = configuredGameServerOrigin('http://localhost:8080');
    expect(forwardedGameServerOrigin('http://localhost:5173', 'localhost:5173', expected))
      .toBe('http://localhost:8080');
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
