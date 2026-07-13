import { describe, expect, it } from 'vitest';
import { FighterVoiceSession, matchVoiceChoice, type FighterVoiceSnapshot } from '../server/fighter-voice';
import { FIGHTER_VICTORY_SECONDS, FighterRoom } from '../server/fighter-room';
import { FIGHTER_MAPS, FIGHTER_ROSTER } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';

describe('fighter voice session', () => {
  it('drives the complete solo journey through intro, combat, victory, and rematch', () => {
    const game = voiceGame();
    const ada = game.connect('CA1', ' voice ');

    ada.prompt('Ada');
    ada.prompt('start');
    expect(ada.spoken.at(-1)).toBe('Choose your fighter. Say the name or number shown on screen.');
    ada.prompt('first');
    ada.prompt('next');
    expect(ada.spoken.at(-1)).toBe('Choose your arena. Say the name or number shown on screen.');
    ada.prompt('second');
    ada.prompt('fight');
    expect(game.room.phase).toBe('loading');
    expect(ada.spoken.at(-1)).toBe('Void Circuit selected. Say fight to begin.');

    expect(game.room.ready(game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    expect(game.room.phase).toBe('intro');
    advanceIntro(game);
    game.tick(3.1);
    game.tick(1);
    game.tick(1);
    game.tick(1);
    expect(game.room.phase).toBe('fight');
    expect(ada.spoken.at(-1)).toBe('Fight!');

    const beforeUnknown = ada.spoken.length;
    ada.prompt('what was that');
    expect(ada.spoken).toHaveLength(beforeUnknown);
    ada.prompt('back', false); ada.prompt('back', false); ada.prompt('back');
    expect(game.commands.map(row => row.command)).toEqual(['back']);
    game.tick(0.7);

    const world = game.room.state().world!;
    world.p1.x = 0; world.p2.x = 1; world.p2.health = 10;
    ada.prompt('punch', false);
    ada.prompt('kick');
    expect(game.commands.map(row => row.command)).toEqual(['back', 'kick']);
    game.tick(0.6);
    expect(game.room.phase).toBe('victory');
    ada.prompt('rematch');
    expect(game.room.phase).toBe('victory');
    game.tick(FIGHTER_VICTORY_SECONDS);
    expect(game.room.phase).toBe('results');

    expect(ada.spoken.join(' ')).toContain('Reduce your rival to zero health');
    expect(ada.spoken.join(' ')).not.toContain('1, Nyx');
    expect(ada.spoken).toContain('Player one, Ada, as Nyx.');
    expect(ada.spoken).toContain('Versus.');
    expect(ada.spoken.some(line => line.startsWith('Player two, Rival, as '))).toBe(true);
    expect(ada.spoken).toContain('Fighters ready.');
    expect(ada.spoken).toContain('3');
    expect(ada.spoken).toContain('2');
    expect(ada.spoken).toContain('1');
    expect(ada.spoken.some(line => line.startsWith('Fight!'))).toBe(true);
    expect(ada.spoken.filter(line => line.includes('You win!'))).toHaveLength(1);

    ada.prompt('rematch');
    expect(game.room.phase).toBe('fighter_select');
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBeNull();
  });

  it('keeps two-player identity, selection, and shared-menu authority contextual', () => {
    const game = voiceGame();
    const ada = game.connect('CA1');
    ada.prompt('Ada');
    ada.prompt('start');

    const bob = game.connect('CA2');
    bob.prompt('Wraith');
    expect(game.room.state().players.find(player => player.playerId === bob.playerId)?.name).toBe('Caller');
    expect(game.room.state().players.find(player => player.playerId === bob.playerId)?.fighterId).toBe('wraith');
    bob.prompt('my name is Bob');
    ada.prompt('Nyx');

    bob.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
    expect(bob.spoken.some(line => line.includes('Player one controls'))).toBe(true);

    ada.prompt('next');
    expect(game.room.phase).toBe('map_select');
    bob.prompt('first');
    expect(game.room.state().selectedMap).toBeNull();
    ada.prompt('second');
    expect(game.room.state().selectedMap).toBe('void');
    bob.prompt('fight');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('fight');
    expect(game.room.phase).toBe('loading');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    ada.prompt('forward'); bob.prompt('back');
    expect(game.commands.slice(-2)).toEqual([
      { playerId: ada.playerId, command: 'forward' },
      { playerId: bob.playerId, command: 'back' },
    ]);

    expect(ada.spoken.some(line => line.includes('Bob joined as your opponent and locked in Wraith'))).toBe(true);
    expect(bob.spoken.some(line => line.includes('Player one is choosing the arena'))).toBe(true);
    expect(bob.spoken).toContain('Player one, Ada, as Nyx.');
    expect(bob.spoken).toContain('Versus.');
    expect(bob.spoken).toContain('Player two, Bob, as Wraith.');
  });

  it('matches screen numbers, ordinals, normalized IDs, and dynamic names', () => {
    const choices = [
      { id: 'neon-foundry', name: 'Neon Foundry' },
      { id: 'rain-temple', name: 'Rain Temple' },
      { id: 'void-circuit', name: 'Void Circuit' },
    ];
    expect(matchVoiceChoice('the second one', choices)?.id).toBe('rain-temple');
    expect(matchVoiceChoice('number 3', choices)?.id).toBe('void-circuit');
    expect(matchVoiceChoice('rain temple', choices)?.id).toBe('rain-temple');
    expect(matchVoiceChoice('neon foundry', choices)?.id).toBe('neon-foundry');
  });
});

function voiceGame() {
  const room = new FighterRoom('VOICE', 1234);
  const sessions: FighterVoiceSession[] = [];
  const commands: { playerId: string; command: FighterCommand }[] = [];

  const stateChanged = () => sessions.forEach(session => session.onStateChanged());
  const publishEvents = (events: FighterEvent[]) => {
    if (!events.length) return;
    for (const session of sessions) for (const event of events) session.onFighterEvent(event);
  };
  const snapshot = (playerId: string): FighterVoiceSnapshot | null => {
    const state = room.state();
    const me = state.players.find(player => player.playerId === playerId); if (!me?.side) return null;
    const foeSide = me.side === 'p1' ? 'p2' : 'p1';
    const foe = state.players.find(player => player.side === foeSide);
    const playerOne = state.players.find(player => player.side === 'p1'), playerTwo = state.players.find(player => player.side === 'p2');
    const fighterName = (id: string | null | undefined) => FIGHTER_ROSTER.find(fighter => fighter.id === id)?.name ?? null;
    const humans = state.players.filter(player => !player.isAi);
    return {
      phase: state.phase,
      myName: me.name,
      myFighterId: me.fighterId,
      myFighterName: fighterName(me.fighterId),
      foeName: foe?.name ?? null,
      foeFighterId: foe?.fighterId ?? null,
      foeFighterName: fighterName(foe?.fighterId),
      selectedMap: state.selectedMap,
      mySide: me.side,
      myHealth: state.world?.[me.side].health ?? null,
      foeHealth: state.world?.[foeSide].health ?? null,
      countdown: state.countdown,
      intro: state.intro,
      winnerName: state.result?.winnerName ?? null,
      winnerSide: state.result?.winner ?? null,
      playerOneName: playerOne?.name ?? null,
      playerOneFighterName: fighterName(playerOne?.fighterId),
      playerTwoName: playerTwo?.name ?? null,
      playerTwoFighterName: fighterName(playerTwo?.fighterId),
      playerCount: humans.length,
      allFightersSelected: humans.length > 0 && humans.every(player => player.fighterId),
      isController: room.canControlSetup(playerId),
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: fighter.name })),
      maps: FIGHTER_MAPS.map(map => ({ id: map.id, name: map.name })),
    };
  };

  const connect = (callSid: string, roomCode = 'VOICE') => {
    const spoken: string[] = [];
    let playerId = '';
    const session = new FighterVoiceSession({
      say: text => spoken.push(text),
      join: () => {
        const joined = room.addPlayer('Caller');
        if ('error' in joined) return null;
        playerId = joined.playerId; stateChanged(); return { playerId, resumed: false };
      },
      leave: (_code, id) => { room.removePlayer(id); stateChanged(); },
      setName: (_code, id, name) => { room.setName(id, name); stateChanged(); },
      selectFighter: (_code, id, fighterId) => { const ok = room.selectFighter(id, fighterId); stateChanged(); return ok; },
      selectMap: (_code, id, mapId) => { const ok = room.canControlSetup(id) && room.selectMap(mapId); stateChanged(); return ok; },
      advance: (_code, id) => { const ok = room.canControlSetup(id) && room.advance(); stateChanged(); return ok; },
      command: (_code, id, command) => {
        const events = room.command(id, command); if (events.length) commands.push({ playerId: id, command });
        publishEvents(room.drainEvents()); stateChanged(); return events.length > 0;
      },
      snapshot: (_code, id) => snapshot(id),
    });
    sessions.push(session);
    session.handleMessage(JSON.stringify({ type: 'setup', callSid, customParameters: { roomCode } }));
    return {
      session,
      spoken,
      get playerId() { return playerId; },
      prompt(text: string, last = true) { session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: text, last })); },
    };
  };

  const tick = (seconds: number) => { room.tick(seconds); publishEvents(room.drainEvents()); stateChanged(); };
  return { room, commands, connect, tick, stateChanged };
}

function advanceIntro(game: ReturnType<typeof voiceGame>): void {
  expect(game.room.state().intro).toBe(FIGHTER_INTRO_SECONDS);
  game.tick(4.1); // Player one -> versus
  game.tick(2);   // Versus -> player two
  game.tick(4);   // Player two -> faceoff
  game.tick(4);   // Faceoff -> countdown
}
