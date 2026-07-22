import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, isLoopbackUrl } from '../server/arcade-dev-auth';

describe('Arcade development authorization', () => {
  it('accepts only IPv4 and IPv6 loopback peers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.2')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('requires a loopback public URL for the development bypass', () => {
    expect(isLoopbackUrl('http://localhost:5173')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopbackUrl('https://arcade.example')).toBe(false);
    expect(isLoopbackUrl('not a URL')).toBe(false);
  });
});
