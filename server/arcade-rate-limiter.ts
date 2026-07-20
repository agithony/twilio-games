export type ArcadeRateLimitResult = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

type RateWindow = { count: number; expiresAt: number };

/** Bounded fixed-window limiter for the mandated single-replica deployment. */
export class ArcadeRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maximumEntries = 10_000,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError('maximumEntries must be a positive integer');
    }
  }

  consume(key: string, limit: number, windowMs: number): ArcadeRateLimitResult {
    if (!key || !Number.isSafeInteger(limit) || limit < 1
      || !Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new TypeError('rate limit key, limit, and window must be valid');
    }
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new TypeError('rate limit clock must be finite');
    let window = this.windows.get(key);
    if (!window || window.expiresAt <= now) {
      this.ensureCapacity(now, key);
      window = { count: 0, expiresAt: now + windowMs };
      this.windows.set(key, window);
    }
    if (window.count >= limit) {
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.expiresAt - now) / 1000)),
      });
    }
    window.count++;
    return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
  }

  private ensureCapacity(now: number, incomingKey: string): void {
    if (this.windows.has(incomingKey) || this.windows.size < this.maximumEntries) return;
    for (const [key, value] of this.windows) {
      if (value.expiresAt <= now) this.windows.delete(key);
    }
    while (this.windows.size >= this.maximumEntries) {
      const oldest = this.windows.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
