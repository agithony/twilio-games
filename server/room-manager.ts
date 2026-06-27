import { Room } from './room';

export class RoomManager {
  private rooms = new Map<string, Room>();
  private seedCounter = 1;

  getOrCreate(code: string): Room {
    let room = this.rooms.get(code);
    if (!room) { room = new Room(code, this.seedCounter++); this.rooms.set(code, room); }
    return room;
  }
  find(code: string): Room | undefined { return this.rooms.get(code); }
  remove(code: string): void { this.rooms.delete(code); }
  get count(): number { return this.rooms.size; }
}
