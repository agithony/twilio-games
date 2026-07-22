import { describe, expect, it } from 'vitest';
import { ArcadeRateLimiter } from '../server/arcade-rate-limiter';

describe('ArcadeRateLimiter', () => {
  it('enforces and resets fixed windows', () => {
    let now = 1_000;
    const limiter = new ArcadeRateLimiter(() => now);
    expect(limiter.consume('player:one', 2, 10_000).allowed).toBe(true);
    expect(limiter.consume('player:one', 2, 10_000).allowed).toBe(true);
    expect(limiter.consume('player:one', 2, 10_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    now = 11_000;
    expect(limiter.consume('player:one', 2, 10_000).allowed).toBe(true);
  });

  it('bounds key cardinality without failing open', () => {
    const limiter = new ArcadeRateLimiter(() => 1_000, 2);
    limiter.consume('one', 1, 10_000);
    limiter.consume('two', 1, 10_000);
    expect(limiter.consume('three', 1, 10_000).allowed).toBe(true);
    expect(limiter.consume('two', 1, 10_000).allowed).toBe(false);
  });
});
