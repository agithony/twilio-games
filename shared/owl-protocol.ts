import type { SupportedLocale } from './i18n/locales';
import { isSupportedLocale } from './i18n/locales';

/** These IDs are the public contract between the phone, the room, and the 3D rig. */
export const OWL_ACTIONS = [
  'call', 'listen', 'talk', 'hangup',
  'newspaper', 'poke', 'tickle', 'eat', 'sip', 'burp', 'portrait', 'lamp',
  'lab', 'study', 'mix',
  'yes', 'no', 'laugh', 'wave', 'ponder', 'gasp', 'dance', 'snooze',
  'sing', 'wink', 'shrug', 'salute', 'scratch', 'yawn', 'hush',
  'cheer', 'shiver', 'bow', 'sneeze',
] as const;
export type OwlAction = typeof OWL_ACTIONS[number];
export const OWL_REAGENTS = ['berry', 'mint', 'amber'] as const;
export type OwlReagent = typeof OWL_REAGENTS[number];
export type OwlPhase = 'waiting' | 'playing' | 'finished';
export type OwlRoomMode = 'study' | 'lab';
export type OwlEndReason = 'timeout' | 'hangup' | 'goodbye' | 'station_stop';

export interface OwlCaller {
  playerId: string;
  name: string;
  nameConfirmed: boolean;
  connected: boolean;
}

export interface OwlResult {
  reason: OwlEndReason;
  playerId: string;
  name: string;
  interactionCount: number;
  durationSeconds: number;
  completedAtMs: number;
}

export interface OwlActionEvent {
  type: 'action';
  sequence: number;
  action: OwlAction;
  line: string;
  atMs: number;
  reagents?: readonly [OwlReagent, OwlReagent];
}

export interface OwlFinishedEvent {
  type: 'finished';
  sequence: number;
  reason: OwlEndReason;
  atMs: number;
}

export type OwlEvent = OwlActionEvent | OwlFinishedEvent;

export interface OwlState {
  roomCode: string;
  phase: OwlPhase;
  generation: number;
  caller: OwlCaller | null;
  roomMode: OwlRoomMode;
  stationManaged: boolean;
  startedAtMs: number | null;
  endsAtMs: number | null;
  interactionCount: number;
  result: OwlResult | null;
  /** Historical on subscription; use the sequence as a baseline, not an animation trigger. */
  lastEvent: OwlEvent | null;
  serverNowMs: number;
}

export type OwlClientMessage =
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale }
  | { type: 'display_auth'; roomCode: string; token: string }
  | { type: 'clock_sync'; clientSentAtMs: number }
  | { type: 'leave' };

export type OwlServerMessage =
  | { type: 'owl_capabilities'; displayAuth: boolean }
  | ({ type: 'owl_state' } & OwlState)
  | { type: 'owl_events'; events: readonly OwlEvent[] }
  | { type: 'clock_sync'; clientSentAtMs: number; serverNowMs: number }
  | { type: 'error'; code: string; message: string };

export const OWL_PROTOCOL_MAX_JSON_LENGTH = 8 * 1024;

/** A display may subscribe and sync its clock; all game actions come from a trusted voice binding. */
export function parseOwlClientMessage(raw: string): OwlClientMessage | Extract<OwlServerMessage, { type: 'error' }> {
  if (typeof raw !== 'string' || raw.length > OWL_PROTOCOL_MAX_JSON_LENGTH) {
    return error('bad_json', 'Display message is too large.');
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return error('bad_json', 'Invalid display JSON.'); }
  if (!record(value)) return error('bad_message', 'Display message must be an object.');
  switch (value.type) {
    case 'spectate':
      if (!onlyKeys(value, ['type', 'roomCode', 'locale']) || !roomCode(value.roomCode)
        || (value.locale !== undefined && !isSupportedLocale(value.locale))) {
        return error('bad_spectate', 'Valid roomCode and locale required.');
      }
      return { type: 'spectate', roomCode: value.roomCode,
        ...(isSupportedLocale(value.locale) ? { locale: value.locale } : {}) };
    case 'display_auth':
      if (!onlyKeys(value, ['type', 'roomCode', 'token']) || !roomCode(value.roomCode)
        || typeof value.token !== 'string' || !value.token.trim() || value.token.length > 256) {
        return error('bad_display_auth', 'Valid roomCode and display token required.');
      }
      return { type: 'display_auth', roomCode: value.roomCode, token: value.token };
    case 'clock_sync':
      if (!onlyKeys(value, ['type', 'clientSentAtMs']) || !Number.isSafeInteger(value.clientSentAtMs)
        || (value.clientSentAtMs as number) < 0) {
        return error('bad_clock_sync', 'clientSentAtMs must be a nonnegative safe integer.');
      }
      return { type: 'clock_sync', clientSentAtMs: value.clientSentAtMs as number };
    case 'leave':
      return onlyKeys(value, ['type']) ? { type: 'leave' }
        : error('bad_leave', 'Unsupported leave fields.');
    default:
      return error('unknown_type', 'Unknown display message type.');
  }
}

export function isOwlAction(value: unknown): value is OwlAction {
  return typeof value === 'string' && (OWL_ACTIONS as readonly string[]).includes(value);
}

export function isOwlReagent(value: unknown): value is OwlReagent {
  return typeof value === 'string' && (OWL_REAGENTS as readonly string[]).includes(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function roomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value);
}

function error(code: string, message: string): Extract<OwlServerMessage, { type: 'error' }> {
  return { type: 'error', code, message };
}
