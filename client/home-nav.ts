// Pure URL-building + input sanitation for the home/lobby page.
// Kept DOM-free so it can be unit-tested under node.
//
// TWO entry roles (the only distinction that matters):
//   'screen' = the shared TV/projector — spectator pack-cam, drives the lobby by keyboard, shows the
//              room code for phone players. The primary way to run a session (1 screen + phones).
//   'device' = play a car in THIS browser — for distributed online players, or keyboard testing.
// Both share the same room code; the level is chosen in-game (map-select), not on the home page.

export type PlayMode = 'screen' | 'device';

export interface PlayParams {
  mode: PlayMode;
  roomCode: string;
  name?: string;
}

/** A room code is exactly 4 digits. Sanitize arbitrary input to that, or default. */
export function sanitizeRoomCode(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? digits : '4821'; // sensible default room
}

/** Trim + length-cap a player name; empty becomes a friendly default. */
export function sanitizeName(raw: string): string {
  const n = (raw ?? '').trim().slice(0, 20);
  return n.length > 0 ? n : 'Racer';
}

/**
 * Build the racer page URL for a launch action.
 * screen → play.html?display=1&room=CODE   (shared spectator/operator screen; phones join by code)
 * device → play.html?room=CODE&name=ENCODED (drive a car here — online player or keyboard testing)
 */
export function buildPlayUrl(params: PlayParams): string {
  const room = sanitizeRoomCode(params.roomCode);
  if (params.mode === 'screen') {
    return `play.html?display=1&room=${room}`;
  }
  const name = encodeURIComponent(sanitizeName(params.name ?? ''));
  return `play.html?room=${room}&name=${name}`;
}
