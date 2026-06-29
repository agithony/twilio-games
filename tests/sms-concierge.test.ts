import { describe, it, expect, beforeEach } from 'vitest';
import { SmsConcierge, type ConciergeRoom } from '../server/sms-concierge';

// A fake room implementing just what the concierge needs, so the state machine is tested in isolation.
class FakeRoom implements ConciergeRoom {
  phase: 'lobby' | 'car_select' | 'map_select' | 'countdown' | 'racing' | 'finished' | 'results' = 'lobby';
  players: { id: string; name: string }[] = [];
  full = false;
  mapChoices = ['Silver Lake', 'Neon City'];
  carNames = ['Batmobile', 'McLaren', 'Lotus', 'Bronco'];
  carCount = 4;
  lastCar: Record<string, number> = {};
  lastMap: string | null = null;
  private n = 1;
  addPlayer(name: string) {
    if (this.full) return { error: 'room_full' };
    const id = `p${this.n++}`; this.players.push({ id, name }); return { playerId: id, lane: 0 };
  }
  setPlayerInfo() {}
  selectCar(id: string, idx: number) { if (idx >= 0 && idx < this.carCount) this.lastCar[id] = idx; }
  selectMap(m: string) { if (this.mapChoices.includes(m)) this.lastMap = m; }
  removePlayer(id: string) { this.players = this.players.filter(p => p.id !== id); }
}

describe('SmsConcierge', () => {
  let rooms: Map<string, FakeRoom>;
  let c: SmsConcierge;
  let now = 1000;
  beforeEach(() => {
    rooms = new Map();
    rooms.set('4821', new FakeRoom());
    c = new SmsConcierge({ findRoom: (code) => rooms.get(code) ?? null, now: () => now });
  });
  const send = (from: string, body: string, sid = `S${Math.random()}`) => c.handle({ from, body, messageSid: sid });

  it('greets a new sender and asks for a room code', () => {
    const r = send('+15551230001', 'hi');
    expect(r).toMatch(/room code/i);
  });

  it('rejects an unknown room code', () => {
    const r = send('+15551230001', '9999');
    expect(r).toMatch(/couldn't find|could not find/i);
  });

  it('accepts a 4-digit code then asks for a name (JOIN prefix or bare digits)', () => {
    expect(send('+1a', 'JOIN 4821')).toMatch(/name/i);
    expect(send('+1b', '4821')).toMatch(/name/i);
  });

  it('joins the room once the name is given and appears in the roster', () => {
    send('+1c', '4821');
    const r = send('+1c', 'Ada');
    expect(r).toMatch(/you're in|youre in|in room/i);
    expect(rooms.get('4821')!.players.map(p => p.name)).toContain('Ada');
  });

  it('during car_select, a texted number selects that car (1-based on screen)', () => {
    send('+1d', '4821'); send('+1d', 'Rex');
    rooms.get('4821')!.phase = 'car_select';
    const r = send('+1d', '2');
    expect(rooms.get('4821')!.lastCar['p1']).toBe(1);   // "2" → index 1 (McLaren)
    expect(r).toMatch(/McLaren/);
  });

  it('rejects an out-of-range car number with a re-prompt', () => {
    send('+1e', '4821'); send('+1e', 'Rex');
    rooms.get('4821')!.phase = 'car_select';
    const r = send('+1e', '99');
    expect(rooms.get('4821')!.lastCar['p1']).toBeUndefined();
    expect(r).toMatch(/not a car|number/i);
  });

  it('during map_select, a texted number picks the map', () => {
    send('+1f', '4821'); send('+1f', 'Rex');
    rooms.get('4821')!.phase = 'map_select';
    const r = send('+1f', '2');
    expect(rooms.get('4821')!.lastMap).toBe('Neon City');
    expect(r).toMatch(/Neon City/);
  });

  it('is idempotent on a duplicate MessageSid (no double-join)', () => {
    send('+1g', '4821');
    send('+1g', 'Ada', 'DUP');
    send('+1g', 'Ada', 'DUP');   // retry — same sid
    expect(rooms.get('4821')!.players.filter(p => p.name === 'Ada')).toHaveLength(1);
  });

  it('LEAVE removes the player and resets the session', () => {
    send('+1h', '4821'); send('+1h', 'Ada');
    expect(rooms.get('4821')!.players).toHaveLength(1);
    const r = send('+1h', 'LEAVE');
    expect(rooms.get('4821')!.players).toHaveLength(0);
    expect(r).toMatch(/left/i);
    // after leaving, a new message greets again
    expect(send('+1h', 'hello')).toMatch(/room code/i);
  });

  it('handles a room-full rejection gracefully', () => {
    rooms.get('4821')!.full = true;
    send('+1i', '4821');
    const r = send('+1i', 'Ada');
    expect(r).toMatch(/full/i);
  });

  it('re-greets after an idle timeout', () => {
    send('+1j', '4821');                 // now AWAITING_NAME
    now += 31 * 60 * 1000;               // 31 minutes later
    const r = send('+1j', 'Ada');        // stale — should re-greet, not treat as a name
    expect(r).toMatch(/room code/i);
  });
});
