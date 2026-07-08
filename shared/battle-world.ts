// Voice Monsters — the turn-based battle engine. Pure sim (no I/O, no DOM), the analog of RaceWorld
// for the racer. Two combatants each CHOOSE a move; when both have chosen, the turn RESOLVES in
// SPEED order (faster monster strikes first), applies typed damage, and emits ordered events the
// renderer replays one at a time (so the attacker's animation plays, then the defender's). Faint →
// battle ends. Deterministic given a seed + the same choices, so the server stays authoritative.
import { Rng } from './rng';
import { monsterById, moveById, type Monster, type Move } from './monster-roster';
import { typeMultiplier, effectivenessLabel } from './monster-types';
import { moveAccuracy } from './move-stats';

export type Side = 'a' | 'b';
export type BattlePhase = 'choosing' | 'resolving' | 'finished';

// Critical hits: rare bonus damage. 1-in-16 (the classic feel) at 1.5× — enough to swing a turn but,
// because it's multiplied BEFORE the per-hit HP cap, it can never turn a hit into a one-shot.
const CRIT_CHANCE = 1 / 16;
const CRIT_MULT = 1.5;

// Non-attack actions. GUARD: halve the next hit + a small heal (bracing isn't a wasted turn). ITEM
// (Potion): heal a chunk, limited per battle. TAUNT: rattle the foe so its attack is less accurate
// this turn. Tuned to stay under the no-one-shot / no-stall balance the pacing tests pin.
const GUARD_DAMAGE_MULT = 0.5;      // incoming hit halved while braced
const GUARD_HEAL_FRAC = 0.08;       // + a small self-heal
const POTION_HEAL_FRAC = 0.33;      // a Potion restores a third of max HP
const POTIONS_PER_BATTLE = 2;
const TAUNT_ACCURACY_PENALTY = 0.25;   // taunted attacker's hit chance drops by this (absolute)

export interface Combatant { id: string; name: string; monsterId: string; }

/** A combatant's live state in the battle snapshot. */
export interface CombatantState {
  id: string; name: string;
  monsterId: string; monsterName: string; type: Monster['type'];
  hp: number; maxHp: number;
  moves: Move[];
  fainted: boolean;
}

export interface BattleSnapshot {
  phase: BattlePhase;
  turn: number;                 // completed turns
  a: CombatantState;
  b: CombatantState;
  winner: Side | null;          // set when phase === 'finished'
  /** Whose action each side has locked for the pending turn (for a "waiting on opponent" UI). */
  chosen: { a: boolean; b: boolean };
  /** Remaining Potions per side (so the ITEM menu can show/grey out the count). */
  potions: { a: number; b: number };
}

/** Ordered battle events (renderer animates these in sequence; commentator/voice speak the relevant
 *  ones). Emitted during turn resolution + on battle start/end. */
export type BattleEvent =
  | { kind: 'turn_start'; turn: number }
  | { kind: 'move_used'; by: Side; moveId: string; moveName: string }
  | { kind: 'miss'; by: Side; moveName: string }
  | { kind: 'damage'; on: Side; amount: number; hpLeft: number; crit: boolean }
  | { kind: 'effectiveness'; on: Side; multiplier: number; label: string }
  | { kind: 'guard'; by: Side; monsterName: string }               // braced: next hit halved
  | { kind: 'item'; by: Side; item: ItemId; itemName: string }     // used a bag item (Potion)
  | { kind: 'taunt'; by: Side; monsterName: string; targetName: string }  // rattled the foe (aim drops)
  | { kind: 'heal'; on: Side; amount: number; hpLeft: number }     // HP restored (guard/potion)
  | { kind: 'faint'; side: Side; monsterName: string }
  | { kind: 'battle_over'; winner: Side; winnerName: string };

/** Bag items (just one for now). */
export type ItemId = 'potion';

/** A turn action: attack with a move, GUARD (brace), use an ITEM, or TAUNT the foe. */
export type BattleAction =
  | { kind: 'fight'; moveId: string }
  | { kind: 'guard' }
  | { kind: 'item'; item: ItemId }
  | { kind: 'taunt' };

interface Fighter {
  id: string; name: string;
  mon: Monster;
  hp: number;
  action: BattleAction | null;   // the action locked for the pending turn (null = not yet chosen)
  committedAt: number | null;    // sequence # when this side locked its action (lower = committed first)
  guarding: boolean;             // braced this turn → incoming hit halved (set in the pre-pass)
  tauntedBy: boolean;            // foe taunted us this turn → our attack accuracy drops
  potions: number;               // remaining Potions this battle
}

export class BattleWorld {
  private a: Fighter;
  private b: Fighter;
  private rng: Rng;
  private _phase: BattlePhase = 'choosing';
  private _turn = 0;
  private _winner: Side | null = null;
  private events: BattleEvent[] = [];
  private commitSeq = 0;   // increments each commit so we know who locked in FIRST this turn

  constructor(a: Combatant, b: Combatant, seed: number) {
    this.a = this.makeFighter(a);
    this.b = this.makeFighter(b);
    this.rng = new Rng(seed);
  }

  private makeFighter(c: Combatant): Fighter {
    const mon = monsterById(c.monsterId);
    if (!mon) throw new Error(`unknown monster: ${c.monsterId}`);
    return {
      id: c.id, name: c.name, mon, hp: mon.maxHp,
      action: null, committedAt: null, guarding: false, tauntedBy: false, potions: POTIONS_PER_BATTLE,
    };
  }

  get phase(): BattlePhase { return this._phase; }

  /** Lock in `side`'s ACTION for the pending turn (FIGHT a move / GUARD / ITEM / TAUNT). Only a VALID
   *  action counts (a move the fighter owns; a Potion it still has). When both sides have validly
   *  chosen, the turn resolves immediately. No-ops once finished. */
  chooseAction(playerId: string, action: BattleAction): void {
    if (this._phase !== 'choosing') return;
    const f = this.fighterOf(playerId);
    if (!f) return;
    if (!this.isValidAction(f, action)) return;
    if (f.committedAt === null) f.committedAt = this.commitSeq++;   // stamp FIRST commit → turn order
    f.action = action;
    if (this.a.action && this.b.action) this.resolveTurn();
  }

  /** FIGHT convenience/back-compat shim: choosing a move is choosing a fight action. */
  chooseMove(playerId: string, moveId: string): void {
    this.chooseAction(playerId, { kind: 'fight', moveId });
  }

  /** Resolve exactly ONE fighter's action immediately. This is the live Voice Monsters flow: the active
   *  caller picks an action, it plays on screen, then the next monster gets prompted. The older
   *  chooseAction path above is kept for pure-engine/back-compat tests that resolve paired choices. */
  takeAction(playerId: string, action: BattleAction): void {
    if (this._phase !== 'choosing') return;
    const f = this.fighterOf(playerId);
    if (!f || !this.isValidAction(f, action)) return;
    const foe = f === this.a ? this.b : this.a;
    this._phase = 'resolving';
    f.action = action;
    this.applySingleAction(f, foe);
    f.action = null; f.committedAt = null;
    this._turn++;
    this._phase = this._winner ? 'finished' : 'choosing';
  }

  private applySingleAction(f: Fighter, foe: Fighter): void {
    if (f.hp <= 0 || foe.hp <= 0) return;
    if (f.action?.kind === 'fight') {
      this.performMove(f, foe);
      if (foe.hp <= 0) this.faint(foe);
      return;
    }
    this.applyPreAction(f, foe);
  }

  private isValidAction(f: Fighter, a: BattleAction): boolean {
    switch (a.kind) {
      case 'fight': return f.mon.moves.some(m => m.id === a.moveId);   // must own the move
      case 'item':  return a.item === 'potion' && f.potions > 0;       // must have the item left
      case 'guard': case 'taunt': return true;
    }
  }

  private fighterOf(playerId: string): Fighter | null {
    if (this.a.id === playerId) return this.a;
    if (this.b.id === playerId) return this.b;
    return null;
  }

  private sideOf(f: Fighter): Side { return f === this.a ? 'a' : 'b'; }

  /** Resolve the pending turn: both fighters act in speed order (ties broken by rng), each dealing
   *  typed damage; a faint ends the battle immediately (a fainted fighter doesn't get its swing). */
  private resolveTurn(): void {
    this._phase = 'resolving';
    this.events.push({ kind: 'turn_start', turn: this._turn + 1 });

    const order = this.turnOrder();   // [first, second] — commit order

    // PRE-PASS: apply the non-attack actions (guard/item/taunt) in commit order, BEFORE any swing, so
    // a guard is up when the attack lands and a taunt is felt this same turn.
    this.a.guarding = false; this.b.guarding = false;
    this.a.tauntedBy = false; this.b.tauntedBy = false;
    for (const f of order) this.applyPreAction(f, f === this.a ? this.b : this.a);

    // ATTACK PASS: only FIGHT actions swing (in the same commit order); a faint ends it immediately.
    for (const attacker of order) {
      const defender = attacker === this.a ? this.b : this.a;
      if (attacker.hp <= 0 || defender.hp <= 0) continue;   // fainted mid-turn → skip its swing
      if (attacker.action?.kind === 'fight') this.performMove(attacker, defender);
      if (defender.hp <= 0) this.faint(defender);
    }

    // clear per-turn state for the next turn (incl. commit stamps, so next turn's order is fresh)
    for (const f of [this.a, this.b]) { f.action = null; f.committedAt = null; f.guarding = false; f.tauntedBy = false; }
    this._turn++;

    this._phase = this._winner ? 'finished' : 'choosing';
  }

  /** Apply a fighter's non-attack action (guard/item/taunt) in the pre-pass. FIGHT is a no-op here. */
  private applyPreAction(f: Fighter, foe: Fighter): void {
    const side = this.sideOf(f);
    switch (f.action?.kind) {
      case 'guard': {
        f.guarding = true;
        this.events.push({ kind: 'guard', by: side, monsterName: f.mon.name });
        this.heal(f, GUARD_HEAL_FRAC);   // bracing also mends a little → not a wasted turn
        break;
      }
      case 'item': {
        if (f.action.item === 'potion' && f.potions > 0) {
          f.potions--;
          this.events.push({ kind: 'item', by: side, item: 'potion', itemName: 'Potion' });
          this.heal(f, POTION_HEAL_FRAC);
        }
        break;
      }
      case 'taunt': {
        foe.tauntedBy = true;   // the FOE's attack this turn is less accurate
        this.events.push({ kind: 'taunt', by: side, monsterName: f.mon.name, targetName: foe.mon.name });
        break;
      }
      default: break;   // fight → handled in the attack pass
    }
  }

  /** Restore `frac` of max HP (capped at full), emitting a heal event. */
  private heal(f: Fighter, frac: number): void {
    const amount = Math.min(f.mon.maxHp - f.hp, Math.round(f.mon.maxHp * frac));
    if (amount <= 0) return;
    f.hp += amount;
    this.events.push({ kind: 'heal', on: this.sideOf(f), amount, hpLeft: f.hp });
  }

  /** Who acts first this turn: whoever COMMITTED their move first (lower committedAt). This makes
   *  turn order "whoever attacks first goes first" — so single-player's human (who commits before the
   *  deferred AI beat) always leads, and in 2P whoever taps first leads. Speed is now flavor. Ties
   *  (shouldn't happen — commits are sequenced) fall back to speed, then rng, for determinism. */
  private turnOrder(): [Fighter, Fighter] {
    const ca = this.a.committedAt, cb = this.b.committedAt;
    if (ca !== null && cb !== null && ca !== cb) return ca < cb ? [this.a, this.b] : [this.b, this.a];
    const sa = this.a.mon.speed, sb = this.b.mon.speed;
    if (sa !== sb) return sa > sb ? [this.a, this.b] : [this.b, this.a];
    return this.rng.next() < 0.5 ? [this.a, this.b] : [this.b, this.a];
  }

  /** Which side committed its move first this turn (for the UI's "who goes first" cue). null until
   *  at least one side has committed. */
  firstMover(): Side | null {
    const ca = this.a.committedAt, cb = this.b.committedAt;
    if (ca === null && cb === null) return null;
    if (ca === null) return 'b';
    if (cb === null) return 'a';
    return ca <= cb ? 'a' : 'b';
  }

  /** Apply one attacker's chosen move to the defender: typed damage + effectiveness event. Honors the
   *  defender's GUARD (halved hit) and a TAUNT on the attacker (lowered accuracy). */
  private performMove(attacker: Fighter, defender: Fighter): void {
    const move = moveById((attacker.action as { moveId: string }).moveId)!;   // validated in chooseAction
    this.events.push({ kind: 'move_used', by: this.sideOf(attacker), moveId: move.id, moveName: move.name });

    if (move.power <= 0) return;   // status/no-damage move (future: buffs); no damage this pass

    // ACCURACY: a high-power move can MISS (weak moves always land) — the risk/reward that gives a
    // weaker move a reason to exist. A TAUNT on the attacker lowers its accuracy this turn. Roll BEFORE
    // damage so a miss short-circuits cleanly + keeps the rng stream stable per swing.
    const acc = moveAccuracy(move.power) - (attacker.tauntedBy ? TAUNT_ACCURACY_PENALTY : 0);
    if (this.rng.next() > acc) {
      this.events.push({ kind: 'miss', by: this.sideOf(attacker), moveName: move.name });
      attacker.tauntedBy = false;
      return;
    }

    const mult = typeMultiplier(move.type, defender.mon.type);
    const { amount, crit } = this.damage(attacker.mon, defender.mon, move, mult, defender.guarding);
    defender.hp = Math.max(0, defender.hp - amount);
    if (defender.guarding) defender.guarding = false;
    attacker.tauntedBy = false;

    const onSide = this.sideOf(defender);
    this.events.push({ kind: 'damage', on: onSide, amount, hpLeft: defender.hp, crit });
    const label = effectivenessLabel(mult);
    if (label) this.events.push({ kind: 'effectiveness', on: onSide, multiplier: mult, label });
  }

  /** Damage formula (Pokémon-STYLE, original + TUNED for pacing). Goal: battles feel PUNCHY — usually
   *  2–3 hits, up to 5 even when a human taps sub-optimal moves — but a single hit can NEVER be a
   *  one-shot. Tuned by sweeping the whole roster in the real engine (scripts/battle-tune.ts) against
   *  the actual asymmetry the player feels: a human picking a somewhat-random move while the AI
   *  damage-maximizes (that asymmetry is what made the old, too-cautious numbers feel "spongy").
   *   - bounded ATK/DEF ratio [0.5,1.7] so glass-cannon-vs-tank can't explode OR fizzle,
   *   - coefficient 0.26 + flat 4 so even a NEUTRAL hit lands for a meaningful chunk (~1/3 a bar),
   *   - STAB 1.5, so playing to your type matters,
   *   - a HARD CAP at HALF the defender's max HP per hit → one-shots are impossible (≥2 hits always),
   *     yet a strong super-effective combo can close a battle in 2 — lethal, not grindy. */
  private damage(atkMon: Monster, defMon: Monster, move: Move, typeMult: number, guarded = false): { amount: number; crit: boolean } {
    const stab = move.type === atkMon.type ? 1.5 : 1;
    const ratio = Math.min(1.7, Math.max(0.5, atkMon.attack / defMon.defense));   // bounded
    const base = move.power * ratio * 0.26 + 4;        // tuned (roster sim): punchy 2–3-hit battles
    const variance = 0.85 + this.rng.next() * 0.30;   // 0.85–1.15
    // CRIT: a RARE roll multiplies the hit — applied BEFORE the cap, so a crit pushes toward the
    // half-HP ceiling but still can NEVER one-shot. Returns the flag so the UI/commentator can react.
    const crit = this.rng.next() < CRIT_CHANCE;
    const guard = guarded ? GUARD_DAMAGE_MULT : 1;     // a braced defender takes half
    const raw = base * stab * typeMult * variance * (crit ? CRIT_MULT : 1) * guard;
    const cap = Math.ceil(defMon.maxHp * 0.5);         // never > half a bar → one-shots impossible (even crits)
    return { amount: Math.max(1, Math.min(cap, Math.round(raw))), crit };
  }

  private faint(f: Fighter): void {
    this.events.push({ kind: 'faint', side: this.sideOf(f), monsterName: f.mon.name });
    const winner = f === this.a ? this.b : this.a;
    this._winner = this.sideOf(winner);
    this.events.push({ kind: 'battle_over', winner: this._winner, winnerName: winner.name });
  }

  /** Drain the queued events (renderer/adapter consume once per resolution). */
  drainEvents(): BattleEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  snapshot(): BattleSnapshot {
    const cs = (f: Fighter): CombatantState => ({
      id: f.id, name: f.name,
      monsterId: f.mon.id, monsterName: f.mon.name, type: f.mon.type,
      hp: f.hp, maxHp: f.mon.maxHp,
      moves: f.mon.moves.map(m => ({ ...m })),
      fainted: f.hp <= 0,
    });
    return {
      phase: this._phase, turn: this._turn,
      a: cs(this.a), b: cs(this.b),
      winner: this._winner,
      chosen: { a: this.a.action !== null, b: this.b.action !== null },
      potions: { a: this.a.potions, b: this.b.potions },
    };
  }
}
