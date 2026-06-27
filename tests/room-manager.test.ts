import { describe, it, expect } from 'vitest';
import { RoomManager } from '../server/room-manager';

describe('RoomManager', () => {
  it('creates a room on first request and reuses it after', () => {
    const m = new RoomManager();
    const a = m.getOrCreate('4821');
    const b = m.getOrCreate('4821');
    expect(a).toBe(b);
    expect(m.count).toBe(1);
  });
  it('find returns undefined for unknown codes', () => {
    const m = new RoomManager();
    expect(m.find('0000')).toBeUndefined();
  });
  it('remove deletes a room', () => {
    const m = new RoomManager();
    m.getOrCreate('1234'); m.remove('1234');
    expect(m.find('1234')).toBeUndefined();
    expect(m.count).toBe(0);
  });
  it('different codes are different rooms with the same code stored', () => {
    const m = new RoomManager();
    const a = m.getOrCreate('1111');
    const b = m.getOrCreate('2222');
    expect(a).not.toBe(b);
    expect(a.code).toBe('1111');
    expect(b.code).toBe('2222');
  });
});
