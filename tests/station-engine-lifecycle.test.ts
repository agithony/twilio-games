import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArcadeApi } from '../server/arcade-api';
import { BattleServer } from '../server/battle-server';
import { FighterServer } from '../server/fighter-server';
import { FIGHTER_VICTORY_SECONDS } from '../server/fighter-room';
import { HttpServer } from '../server/http-server';
import { KaraokeServer } from '../server/karaoke-server';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';
import { NEVER_GONNA_GIVE_YOU_UP } from '../shared/karaoke-songs';
import { KARAOKE_COUNTDOWN_MS } from '../shared/karaoke-protocol';

let server: HttpServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function harness() {
  directory = await mkdtemp(path.join(tmpdir(), 'station-engine-lifecycle-'));
  const started = vi.fn();
  const completed = vi.fn();
  const abandoned = vi.fn();
  const arcadeApi = {
    start: vi.fn(async () => {}),
    activateMessagingDelivery: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isStationEngineRoom: vi.fn(() => false),
    stationEngineStarted: started,
    stationEngineCompleted: completed,
    stationEngineAbandoned: abandoned,
  } as unknown as ArcadeApi;
  server = new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    validateSignatures: false,
    arcadeApi,
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
  });
  await server.start();
  const games = server as unknown as { battle: BattleServer; fighter: FighterServer; karaoke: KaraokeServer };
  return { ...games, started, completed, abandoned };
}

describe('station engine room lifecycle', () => {
  it('does not start Karaoke on display readiness alone and abandons one dual-ready performance once', async () => {
    const { karaoke, started, completed, abandoned } = await harness();
    const roomCode = 'KARAOKE-LIFECYCLE';
    const playerId = karaoke.voiceJoin(roomCode, 'Ada', 1)!;
    karaoke.voiceAdvance(roomCode, playerId);
    karaoke.voiceSelectSong(roomCode, playerId, NEVER_GONNA_GIVE_YOU_UP.id);
    karaoke.voiceAdvance(roomCode, playerId);
    const generation = karaoke.findRoom(roomCode)!.state().loadingGeneration;

    expect(karaoke.findRoom(roomCode)!.ready(generation)).toBe(true);
    karaoke.voiceAdvance(roomCode, playerId);
    expect(karaoke.findRoom(roomCode)?.state().phase).toBe('loading');
    expect(started).not.toHaveBeenCalled();
    expect(karaoke.markMediaReady(
      roomCode, playerId, NEVER_GONNA_GIVE_YOU_UP.id, generation, KARAOKE_COUNTDOWN_MS,
    )).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith('karaoke', roomCode);

    karaoke.voiceLeave(roomCode, playerId);
    karaoke.voiceLeave(roomCode, playerId);
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(abandoned).toHaveBeenCalledWith('karaoke', roomCode);
    expect(completed).not.toHaveBeenCalled();
  });

  it('keeps Monsters setup inert and abandons a started battle exactly once', async () => {
    const { battle, started, completed, abandoned } = await harness();
    const roomCode = 'MONSTER-LIFECYCLE';
    const playerId = battle.voiceJoin(roomCode, 'Ada')!;

    battle.voiceAdvance(roomCode,playerId);
    battle.voiceSelectMonster(roomCode, playerId, 'sparkmouse');
    battle.voiceSelectMonster(roomCode, playerId, 'sparkmouse');
    expect(battle.findRoom(roomCode)?.phase).toBe('monster_select');
    expect(started).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(abandoned).not.toHaveBeenCalled();

    battle.voiceAdvance(roomCode,playerId);
    battle.voiceOpenFight(roomCode, playerId);
    battle.voiceOpenFight(roomCode, playerId);
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith('monsters', roomCode);

    battle.voiceLeave(roomCode, playerId);
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(abandoned).toHaveBeenCalledWith('monsters', roomCode);
    expect(completed).not.toHaveBeenCalled();

    battle.voiceJoin(roomCode, 'Grace');
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it('keeps Fighter setup inert, then distinguishes abandonment from completion', async () => {
    const { fighter, started, completed, abandoned } = await harness();
    const roomCode = 'FIGHTER-ABANDON';
    const playerId = fighter.voiceJoin(roomCode, 'Ada')!;

    expect(fighter.voiceAdvance(roomCode, playerId)).toBe(true);
    expect(fighter.voiceSelectFighter(roomCode, playerId, 'nyx')).toBe(true);
    expect(fighter.voiceAdvance(roomCode, playerId)).toBe(true);
    expect(fighter.voiceSelectMap(roomCode, playerId, 'void')).toBe(true);
    expect(fighter.voiceAdvance(roomCode, playerId)).toBe(true);
    const room = fighter.findRoom(roomCode)!;
    expect(room.phase).toBe('loading');
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    fighter.voiceCommand(roomCode, playerId, 'forward');
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith('fighter', roomCode);
    room.tick(FIGHTER_INTRO_SECONDS);
    expect(room.phase).toBe('countdown');
    fighter.voiceCommand(roomCode, playerId, 'forward');
    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect(abandoned).not.toHaveBeenCalled();

    expect(room.invalidateDisplayReady()).toBe(true);
    fighter.voiceCommand(roomCode, playerId, 'forward');
    expect(room.phase).toBe('loading');
    expect(abandoned).not.toHaveBeenCalled();
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    fighter.voiceCommand(roomCode, playerId, 'forward');
    expect(started).toHaveBeenCalledTimes(1);

    room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    expect(room.phase).toBe('fight');
    fighter.voiceCommand(roomCode, playerId, 'forward');
    fighter.voiceCommand(roomCode, playerId, 'back');
    expect(started).toHaveBeenCalledTimes(1);
    fighter.voiceLeave(roomCode, playerId);
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(abandoned).toHaveBeenCalledWith('fighter', roomCode);

    const completeCode = 'FIGHTER-COMPLETE';
    const completePlayer = fighter.voiceJoin(completeCode, 'Grace')!;
    fighter.voiceAdvance(completeCode, completePlayer);
    fighter.voiceSelectFighter(completeCode, completePlayer, 'nyx');
    fighter.voiceAdvance(completeCode, completePlayer);
    fighter.voiceSelectMap(completeCode, completePlayer, 'void');
    fighter.voiceAdvance(completeCode, completePlayer);
    const completeRoom = fighter.findRoom(completeCode)!;
    completeRoom.ready(completeRoom.state().loadingGeneration);
    completeRoom.tick(FIGHTER_INTRO_SECONDS);
    completeRoom.tick(6);
    fighter.voiceCommand(completeCode, completePlayer, 'forward');
    expect(started).toHaveBeenCalledTimes(2);

    completeRoom.tick(1);
    const world = completeRoom.state().world!;
    world.p1.x = 0; world.p2.x = 1; world.p2.health = 10;
    completeRoom.command(completePlayer, 'kick');
    completeRoom.tick(0.6);
    fighter.voiceCommand(completeCode, completePlayer, 'forward');
    expect(completeRoom.phase).toBe('victory');
    expect(completed).not.toHaveBeenCalled();
    completeRoom.tick(FIGHTER_VICTORY_SECONDS - 0.1);
    fighter.voiceCommand(completeCode, completePlayer, 'forward');
    expect(completed).not.toHaveBeenCalled();
    completeRoom.tick(0.1);
    fighter.voiceCommand(completeCode, completePlayer, 'forward');
    fighter.voiceCommand(completeCode, completePlayer, 'forward');
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith('fighter', completeCode, expect.any(Array));
    fighter.voiceLeave(completeCode, completePlayer);
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it('completes a started Monsters battle once across duplicate result callbacks', async () => {
    const { battle, started, completed, abandoned } = await harness();
    vi.useFakeTimers();
    const roomCode = 'MONSTER-COMPLETE';
    const ada = battle.voiceJoin(roomCode, 'Ada')!;
    const grace = battle.voiceJoin(roomCode, 'Grace')!;
    battle.voiceAdvance(roomCode,ada);
    battle.voiceSelectMonster(roomCode, ada, 'sparkmouse');
    battle.voiceSelectMonster(roomCode, grace, 'embertail');
    battle.voiceAdvance(roomCode,grace);
    const room = battle.findRoom(roomCode)!;

    for (let actions = 0; room.phase === 'battle' && actions < 40; actions++) {
      const side = room.activeSide()!;
      const combatant = room.snapshot()![side];
      const move = combatant.moves.reduce((best, candidate) => (
        candidate.power > best.power ? candidate : best
      ));
      expect(battle.voiceChooseAction(roomCode, combatant.id, { kind: 'fight', moveId: move.id })).toBe(true);
    }

    expect(room.phase).toBe('results');
    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(room.rematchReadyInMs + 5);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith('monsters', roomCode, expect.any(Array));
    battle.voiceOpenFight(roomCode, ada);
    battle.voiceOpenFight(roomCode, grace);
    expect(completed).toHaveBeenCalledTimes(1);

    battle.voiceLeave(roomCode, ada);
    battle.voiceLeave(roomCode, grace);
    expect(abandoned).not.toHaveBeenCalled();
  });
});
