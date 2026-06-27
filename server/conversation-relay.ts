import type { Intent } from '../shared/types';
import { mapTranscriptToIntent } from './voice-intent';

export type CrMessage =
  | { type:'setup'; callSid:string; from?:string; customParameters: Record<string,string> }
  | { type:'prompt'; voicePrompt:string; last:boolean }
  | { type:'dtmf'; digit:string }
  | { type:'error'; description:string }
  | { type:'unknown' };

export function parseCrMessage(raw: string): CrMessage {
  let o: any;
  try { o = JSON.parse(raw); } catch { return { type:'unknown' }; }
  if (!o || typeof o.type !== 'string') return { type:'unknown' };
  switch (o.type) {
    case 'setup':
      return { type:'setup', callSid: String(o.callSid ?? ''),
        ...(typeof o.from === 'string' ? { from: o.from } : {}),
        customParameters: (o.customParameters && typeof o.customParameters === 'object')
          ? o.customParameters : {} };
    case 'prompt':
      if (typeof o.voicePrompt !== 'string') return { type:'unknown' };
      return { type:'prompt', voicePrompt: o.voicePrompt, last: o.last === true };
    case 'dtmf':
      return { type:'dtmf', digit: String(o.digit ?? '') };
    case 'error':
      return { type:'error', description: String(o.description ?? '') };
    default:
      return { type:'unknown' };
  }
}

export type RoomLike = {
  addPlayer(name: string): { playerId: string; lane: number } | { error: string };
  applyIntent(id: string, intent: Intent): void;
  removePlayer(id: string): void;
};

const DTMF_TO_INTENT: Record<string, Intent> = {
  '1': 'MOVE_LEFT', '2': 'BOOST', '3': 'MOVE_RIGHT', '4': 'BRAKE', '5': 'USE_POWER',
};

export class ConversationRelayAdapter {
  private room: RoomLike | null = null;
  private playerId: string | null = null;
  private lastFired: Intent | null = null;   // debounce within one utterance
  constructor(private deps: { findOrCreateRoom: (code: string) => RoomLike | null }) {}

  handleMessage(raw: string): void {
    const msg = parseCrMessage(raw);
    switch (msg.type) {
      case 'setup': {
        const code = msg.customParameters['roomCode'];
        if (!code) return;
        const room = this.deps.findOrCreateRoom(code);
        if (!room) return;
        const res = room.addPlayer(playerName(msg.from));
        if ('error' in res) return;          // room full / in progress: stay unbound
        this.room = room; this.playerId = res.playerId;
        break;
      }
      case 'prompt': {
        if (!this.room || !this.playerId) return;
        const intent = mapTranscriptToIntent(msg.voicePrompt);
        if (intent && intent !== this.lastFired) {
          this.room.applyIntent(this.playerId, intent);
          this.lastFired = intent;
        }
        if (msg.last) this.lastFired = null;  // reset for next utterance
        break;
      }
      case 'dtmf': {
        if (!this.room || !this.playerId) return;
        const intent = DTMF_TO_INTENT[msg.digit];
        if (intent) this.room.applyIntent(this.playerId, intent);
        break;
      }
      case 'error':
      case 'unknown':
        return;
    }
  }

  handleClose(): void {
    if (this.room && this.playerId) this.room.removePlayer(this.playerId);
    this.room = null; this.playerId = null;
  }
}

function playerName(from?: string): string {
  if (from && from.length >= 4) return `Racer ${from.slice(-4)}`;
  return 'Racer';
}
