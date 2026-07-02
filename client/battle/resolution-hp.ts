// Tracks the HP each battle bar should DISPLAY during a paced turn resolution, so the two bars drop
// one hit at a time instead of both snapping to the end-of-turn values at once.
//
// Why this exists: the server sends the turn's paced damage events, then the settled snapshot (final
// HP). The client animates the events on a timer, but the HP bars would otherwise read the settled
// snapshot directly — so both bars jump to final HP the moment it arrives, while the banners still
// narrate "X used Ember!… it's super effective!" hit by hit. This holds each side at its pre-turn HP
// until that side's own `damage` event actually plays, then steps it to that hit's hpLeft.
//
// Usage: begin(preA, preB) when resolution starts; hit(side, hpLeft) as each damage event plays;
// end() when resolution settles (bars go back to reading the authoritative snapshot).
export type Side = 'a' | 'b';

export class ResolutionHp {
  private active = false;
  private hp: { a: number; b: number } = { a: 0, b: 0 };

  /** Begin a paced resolution, seeding each side's pre-turn HP (so bars start where the turn began). */
  begin(preA: number, preB: number): void {
    this.active = true;
    this.hp = { a: preA, b: preB };
  }

  /** A side just took its hit → step its displayed HP to the post-hit value the event carries. */
  hit(side: Side, hpLeft: number): void {
    if (this.active) this.hp[side] = hpLeft;
  }

  /** Resolution settled → drop the overrides; the authoritative snapshot drives the bars again. */
  end(): void { this.active = false; }

  /** The HP to show for `side`: the paced value during resolution, else the snapshot fallback. */
  display(side: Side, snapshotHp: number): number {
    return this.active ? this.hp[side] : snapshotHp;
  }
}
