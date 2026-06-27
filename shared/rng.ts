// Mulberry32: tiny, fast, deterministic PRNG. Replaces Math.random in the sim
// so races are reproducible (required for server-authoritative determinism).
export class Rng {
  private state: number;
  constructor(seed: number) {
    // ensure a non-zero 32-bit state
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}
