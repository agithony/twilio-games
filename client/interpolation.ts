import type { WorldSnapshot, CarState } from '../shared/types';

interface Stamped { recvT: number; snap: WorldSnapshot; }

export class InterpolationBuffer {
  private buf: Stamped[] = [];
  private delayMs: number;
  constructor(delayMs = 100) { this.delayMs = delayMs; }

  push(snap: WorldSnapshot, recvT: number): void {
    this.buf.push({ recvT, snap });
    while (this.buf.length > 60) this.buf.shift();
  }

  sample(renderT: number): WorldSnapshot | null {
    if (this.buf.length === 0) return null;
    const target = renderT - this.delayMs;
    const last = this.buf[this.buf.length - 1]!;
    // If render time has run PAST the newest snapshot (a packet was late/dropped), don't FREEZE —
    // briefly EXTRAPOLATE forward from the last two snapshots so cars keep gliding. Capped so a long
    // gap doesn't fling them off; clamped to the sim length elsewhere. This hides the ~64ms deployed
    // cadence + occasional jitter that otherwise reads as stutter.
    if (target >= last.recvT) {
      if (this.buf.length < 2) return last.snap;
      const prev = this.buf[this.buf.length - 2]!;
      const span = last.recvT - prev.recvT || 1;
      const over = Math.min(target - last.recvT, span);   // extrapolate at most one snapshot ahead
      const f = 1 + over / span;                          // f>1 → project past `last`
      return lerpSnapshot(prev.snap, last.snap, f);
    }
    // find the two snapshots straddling `target`
    let a = this.buf[0]!, b = last;
    for (let i = 0; i < this.buf.length - 1; i++) {
      if (this.buf[i]!.recvT <= target && this.buf[i + 1]!.recvT >= target) {
        a = this.buf[i]!; b = this.buf[i + 1]!; break;
      }
    }
    if (a === b) return a.snap;
    const span = b.recvT - a.recvT || 1;
    const f = Math.max(0, Math.min(1, (target - a.recvT) / span));
    return lerpSnapshot(a.snap, b.snap, f);
  }
}

function lerpSnapshot(a: WorldSnapshot, b: WorldSnapshot, f: number): WorldSnapshot {
  const byId = new Map(a.cars.map(c => [c.id, c]));
  const cars: CarState[] = b.cars.map(cb => {
    const ca = byId.get(cb.id) ?? cb;
    return { ...cb, x: lerp(ca.x, cb.x, f), z: lerp(ca.z, cb.z, f) };
  });
  return { ...b, cars };
}
function lerp(a: number, b: number, f: number) { return a + (b - a) * f; }
