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
    // find the two snapshots straddling `target`
    let a = this.buf[0]!, b = this.buf[this.buf.length - 1]!;
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
