import { describe, expect, it, vi } from 'vitest';
import { FighterVoiceSession, matchVoiceChoice, type FighterVoiceSnapshot } from '../server/fighter-voice';
import { FIGHTER_LOADING_TIMEOUT_SECONDS, FIGHTER_VICTORY_SECONDS, FighterRoom } from '../server/fighter-room';
import { FIGHTER_MAPS, FIGHTER_ROSTER } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';

describe('fighter voice session', () => {
  it('uses an authoritative station name without asking for it again', () => {
    const game=voiceGame();const ada=game.connect('CA-known','VOICE',undefined,'Ada');
    expect(game.room.state().players[0]?.name).toBe('Ada');
    expect(ada.spoken.slice(0, 5)).toEqual([
      'Welcome to Voice Fighter, Ada.',
      'This game is powered by Twilio Conversation Relay, so your voice controls the fight in real time over this call.',
      'Before you start, check the controls on the display.',
      'Reduce your rival to zero health. During the fight, say forward, back, jump, punch, kick, or block.',
      'Choose your fighter. Say the name or number shown on screen.',
    ]);
    const arrival=ada.spoken.join(' ').toLowerCase();
    expect(arrival).toContain('ada');
    expect(arrival).toMatch(/forward|back|punch|kick/);
    expect(arrival).toContain('choose your fighter');
    expect(arrival).not.toContain('what is your name');
  });

  it('captures a missing station profile name before fighter selection', () => {
    const game=voiceGame();
    const caller=game.connect('CA-station-no-name','VOICE',undefined,undefined,{index:0,count:1});
    expect(game.room.phase).toBe('lobby');
    const beforeName=caller.spoken.length;
    caller.prompt('Ada');
    expect(game.room.phase).toBe('fighter_select');
    expect(game.room.state().players[0]?.name).toBe('Ada');
    expect(caller.spoken.slice(beforeName).join(' ')).not.toMatch(/what is your name/i);
  });

  it('does not let a delayed duplicate fighter choice select the arena', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const game=voiceGame();const caller=game.connect('CA-duplicate-choice');
      caller.prompt('Ada');
      vi.advanceTimersByTime(1_000);
      caller.session.setStationManaged(false);
      caller.prompt('second');
      expect(game.room.phase).toBe('map_select');
      vi.advanceTimersByTime(3_000);
      caller.session.setStationManaged(false);
      caller.prompt('second');
      expect(game.room.phase).toBe('map_select');
      expect(game.room.state().mapVotesByPlayerId[caller.playerId]).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('accepts a repeated choice when the other caller caused the phase transition', () => {
    const game=voiceGame();const ada=game.connect('CA-boundary-a'),bob=game.connect('CA-boundary-b');
    ada.prompt('Ada');bob.prompt('Bob');
    ada.prompt('second');
    bob.prompt('first');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');
    expect(game.room.state().mapVotesByPlayerId[ada.playerId]).toBe('void');
  });

  it('drives the complete solo journey through intro, combat, victory, and rematch', () => {
    const game = voiceGame();
    const ada = game.connect('CA1', ' voice ');
    expect(ada.spoken).toEqual([
      'Welcome to Voice Fighter!',
      'This game is powered by Twilio Conversation Relay, so your voice controls the fight in real time over this call.',
      'First, what is your name?',
    ]);

    ada.prompt('Ada');
    expect(ada.spoken.slice(-4)).toEqual([
      'Welcome to Voice Fighter, Ada.',
      'Before you start, check the controls on the display.',
      'Reduce your rival to zero health. During the fight, say forward, back, jump, punch, kick, or block.',
      'Choose your fighter. Say the name or number shown on screen.',
    ]);
    ada.prompt('star');
    expect(ada.spoken.at(-1)).toContain('Choose your fighter. Say the name or number shown on screen.');
    ada.prompt('Nicks', false);
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBeNull();
    const afterInterimSelection = ada.spoken.length;
    ada.prompt('Nicks');
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBe('nyx');
    expect(ada.spoken.length).toBeGreaterThan(afterInterimSelection);
    ada.prompt('next');
    expect(ada.spoken.at(-1)).toBe('Choose your arena. Say the name or number shown on screen.');
    ada.prompt('second');
    ada.prompt('flight');
    expect(game.room.phase).toBe('loading');
    expect(ada.spoken.at(-1)).toMatch(/Get ready/i);

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
    expect(ada.spoken).toHaveLength(beforeUnknown+1);
    expect(ada.spoken.at(-1)).toMatch(/forward.*back.*jump.*punch.*kick.*block/i);
    ada.prompt('back', false); ada.prompt('back', false); ada.prompt('back');
    expect(game.commands.map(row => row.command)).toEqual(['back']);
    game.tick(0.7);

    const world = game.room.state().world!;
    ada.session.setStationManaged(true);
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
    expect(ada.spoken.join(' ')).toMatch(/results.*display.*thanks for playing.*check your messages/i);

    ada.session.setStationManaged(false);
    ada.prompt('rematch');
    expect(game.room.phase).toBe('fighter_select');
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBeNull();
  });

  it('keeps two-player identity and personal selections contextual with automatic progression', () => {
    const game = voiceGame();
    const ada = game.connect('CA1');
    ada.prompt('Ada');
    ada.prompt('start');

    const bob = game.connect('CA2');
    bob.prompt('my name is Bob');
    bob.prompt('Wraith');
    expect(game.room.state().players.find(player => player.playerId === bob.playerId)?.name).toBe('Bob');
    expect(game.room.state().players.find(player => player.playerId === bob.playerId)?.fighterId).toBe('wraith');
    ada.prompt('Nyx');

    expect(game.room.phase).toBe('map_select');
    bob.prompt('first');
    expect(game.room.state().mapVotesByPlayerId[bob.playerId]).toBe('foundry');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');
    expect(game.room.phase).toBe('loading');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    ada.prompt('forward'); bob.prompt('back');
    expect(game.commands.slice(-2)).toEqual([
      { playerId: ada.playerId, command: 'forward' },
      { playerId: bob.playerId, command: 'back' },
    ]);

    expect(bob.spoken.some(line => line.includes('arena vote'))).toBe(true);
    expect(bob.spoken).toContain('Player one, Ada, as Nyx.');
    expect(bob.spoken).toContain('Versus.');
    expect(bob.spoken).toContain('Player two, Bob, as Wraith.');
  });

  it('executes queued combat commands independently for both callers', () => {
    const game=voiceGame(),ada=game.connect('CA-A'),bob=game.connect('CA-B');
    ada.prompt('Ada');bob.prompt('Bob');ada.prompt('Nyx');bob.prompt('Wraith');ada.prompt('second');bob.prompt('second');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    ada.prompt('forward punch kick jump');
    bob.prompt('forward kick punch jump');
    for(let index=0;index<140;index++)game.tick(0.1);
    const actions=game.events.filter(event=>event.type==='action');
    expect(actions.filter(event=>event.fighter==='p1').map(event=>event.command)).toEqual(['forward','punch','kick','jump']);
    expect(actions.filter(event=>event.fighter==='p2').map(event=>event.command)).toEqual(['forward','kick','punch','jump']);
  });

  it('uses station participant order while both callers own their setup choices', () => {
    const game=voiceGame();
    const bob=game.connect('CA-B','VOICE',undefined,'Bob',{index:1,count:2});
    const ada=game.connect('CA-A','VOICE',undefined,'Ada',{index:0,count:2});
    expect(game.room.canControlSetup(ada.playerId)).toBe(true);
    expect(game.room.canControlSetup(bob.playerId)).toBe(true);
    ada.prompt('Nyx');
    expect(game.room.advance()).toBe(false);
    bob.prompt('Wraith');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');bob.prompt('second');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    ada.prompt('forward punch');bob.prompt('forward kick');
    for(let index=0;index<40;index++)game.tick(0.1);
    const actions=game.events.filter(event=>event.type==='action');
    expect(actions.filter(event=>event.fighter==='p1').map(event=>event.command)).toEqual(['forward','punch']);
    expect(actions.filter(event=>event.fighter==='p2').map(event=>event.command)).toEqual(['forward','kick']);
  });

  it('keeps a lone assigned player in context while waiting for Player Two', () => {
    const game=voiceGame();
    const ada=game.connect('CA-A','VOICE',undefined,'Ada',{index:0,count:2});
    ada.prompt('start');ada.prompt('Nyx');

    expect(game.room.state()).toMatchObject({ expectedPlayerCount: 2, hasExpectedPlayers: false });
    expect(game.room.phase).toBe('lobby');
    expect(ada.spoken.at(-1)).toMatch(/Waiting for Player Two/i);

    ada.prompt('next');
    expect(game.room.phase).toBe('lobby');
    expect(ada.spoken.at(-1)).toMatch(/Waiting for Player Two/i);
  });

  it('describes both fighter and arena loading when the extended deadline expires', () => {
    const game=voiceGame();const ada=game.connect('CA-LOAD','VOICE',undefined,'Ada');
    ada.prompt('start');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('fight');

    game.tick(15);
    expect(game.room.phase).toBe('loading');
    game.tick(FIGHTER_LOADING_TIMEOUT_SECONDS-15);

    expect(game.room.phase).toBe('map_select');
    expect(ada.spoken.at(-1)).toBe('The fighters or arena did not finish loading. Choose an arena and try again.');
  });

  it('narrates the same hit from each caller perspective', () => {
    const game=voiceGame(),{ada,bob}=startTwoCallerFight(game);
    ada.spoken.length=0;bob.spoken.length=0;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const hit: FighterEvent={type:'hit',attacker:'p1',defender:'p2',damage:9,blocked:false};
      ada.session.onFighterEvent(hit);bob.session.onFighterEvent(hit);
      expect(ada.spoken).toEqual(['Hit for 9.']);
      expect(bob.spoken).toEqual(['You took 9.']);

      vi.advanceTimersByTime(1_201);
      const blocked: FighterEvent={type:'hit',attacker:'p2',defender:'p1',damage:3,blocked:true};
      ada.session.onFighterEvent(blocked);bob.session.onFighterEvent(blocked);
      expect(ada.spoken.at(-1)).toBe('Blocked.');
      expect(bob.spoken.at(-1)).toBe('They blocked.');
    } finally { vi.useRealTimers(); }
  });

  it('throttles commentary per caller and narrates misses only to the attacker', () => {
    const game=voiceGame(),{ada,bob}=startTwoCallerFight(game);
    ada.spoken.length=0;bob.spoken.length=0;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const hit: FighterEvent={type:'hit',attacker:'p1',defender:'p2',damage:9,blocked:false};
      ada.session.onFighterEvent(hit);bob.session.onFighterEvent(hit);
      vi.advanceTimersByTime(1_200);
      const throttled: FighterEvent={type:'hit',attacker:'p2',defender:'p1',damage:15,blocked:false};
      ada.session.onFighterEvent(throttled);bob.session.onFighterEvent(throttled);
      expect(ada.spoken).toEqual(['Hit for 9.']);
      expect(bob.spoken).toEqual(['You took 9.']);

      vi.advanceTimersByTime(1);
      const miss: FighterEvent={type:'miss',attacker:'p1'};
      ada.session.onFighterEvent(miss);bob.session.onFighterEvent(miss);
      expect(ada.spoken).toEqual(['Hit for 9.','Missed. Move closer.']);
      expect(bob.spoken).toEqual(['You took 9.']);
    } finally { vi.useRealTimers(); }
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
    expect(matchVoiceChoice('Nicks', FIGHTER_ROSTER)?.id).toBe('nyx');
    expect(matchVoiceChoice('a segunda', choices, 'pt-BR')?.id).toBe('rain-temple');
    expect(matchVoiceChoice('número três', choices, 'pt-BR')?.id).toBe('void-circuit');
    const productionMaps=[...FIGHTER_MAPS,{id:'cyberpunk-city',name:'Cyberpunk City'},
      {id:'inakaya',name:'Inakaya Restaurant'},{id:'rain',name:'Rain'}];
    expect(matchVoiceChoice('option four',productionMaps)?.id).toBe('inakaya');
    expect(matchVoiceChoice('Ina Kaya',productionMaps)?.id).toBe('inakaya');
    expect(matchVoiceChoice('Inikaya',productionMaps)?.id).toBe('inakaya');
    expect(matchVoiceChoice('start training',productionMaps)).toBeNull();
    expect(matchVoiceChoice('brainstorm',productionMaps)).toBeNull();
  });

  it('accepts safe fight ASR variants only after an arena is selected', () => {
    const game = voiceGame(), ada = game.connect('CA-FLIGHT');
    ada.prompt('Ada'); ada.prompt('start'); ada.prompt('Nyx'); ada.prompt('next');
    ada.prompt('my flight is delayed');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');
    ada.prompt('he fights at night');
    expect(game.room.phase).toBe('loading');
  });

  it('uses the setup command locale for Portuguese menus, choices, commands, and speech', () => {
    const game = voiceGame();
    const ana = game.connect('CA-PT', 'VOICE', 'pt-BR');
    expect(ana.spoken).toEqual([
      'Boas-vindas à Luta por Voz!',
      'Este jogo usa o Twilio Conversation Relay, então sua voz controla a luta em tempo real por esta ligação.',
      'Diga apenas seu primeiro nome. Por exemplo: Ana.',
    ]);

    ana.prompt('quem são os lutadores');
    expect(game.room.hasConfirmedName(ana.playerId)).toBe(false);
    expect(game.room.phase).toBe('lobby');
    ana.prompt('pode me dizer quais lutadores existem');
    expect(game.room.hasConfirmedName(ana.playerId)).toBe(false);
    ana.prompt('meu nome é ana');
    expect(ana.spoken.slice(-4)).toEqual([
      'Boas-vindas à Luta por Voz, Ana.',
      'Antes de começar, veja os controles na tela.',
      'Reduza os pontos de vida do rival a zero. Durante a luta, diga avançar, recuar, pular, soco, chute ou bloquear.',
      'Escolha seu lutador. Diga o nome ou número exibido na tela.',
    ]);
    ana.prompt('começar');
    expect(ana.spoken.at(-1)).toBe('Escolha seu lutador. Diga o nome ou número exibido na tela.');
    ana.prompt('primeira');
    expect(game.room.state().players.find(player => player.playerId === ana.playerId)?.fighterId).toBe('nyx');
    ana.prompt('próximo');
    expect(ana.spoken.at(-1)).toBe('Escolha sua arena. Diga o nome ou número exibido na tela.');
    ana.prompt('segunda');
    expect(game.room.state().selectedMap).toBe('void');
    expect(ana.spoken.at(-1)).toMatch(/Prepare-se/i);
    ana.prompt('lutar');
    expect(game.room.phase).toBe('loading');

    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    ana.prompt('ajuda');
    expect(ana.spoken.at(-1)).toMatch(/avançar.*recuar.*pular.*soco.*chute.*bloquear/i);
    ana.prompt('frente');
    expect(game.commands.at(-1)).toEqual({ playerId: ana.playerId, command: 'forward' });
    expect(ana.spoken).toContain('Contra.');
    expect(ana.spoken).toContain('Lutadores prontos.');
  });

  it('captures a late Portuguese caller name without requiring an explicit prefix', () => {
    const game = voiceGame();
    const ana = game.connect('CA-PT-HOST', 'VOICE', 'pt-BR');
    ana.prompt('Ana'); ana.prompt('começar');
    const bia = game.connect('CA-PT-LATE', 'VOICE', 'pt-BR');

    bia.prompt('Bia');

    expect(game.room.state().players.find(player => player.playerId === bia.playerId)?.name).toBe('Bia');
    expect(bia.spoken.some(line => line.includes('Luta por Voz, Bia'))).toBe(true);
  });

  it('ignores combat interims and expands only finalized command bursts', () => {
    const commands: FighterCommand[] = [], spoken: string[] = [];
    const snapshot: FighterVoiceSnapshot = {
      phase: 'fight', myName: 'Ada', myFighterId: 'nyx', myFighterName: 'Nyx', foeName: 'Rival',
      foeFighterId:'wraith',foeFighterName:'Wraith',selectedMap:'void',myMapVote:'void',allMapVotes:true,mySide:'p1',myHealth:100,
      foeHealth: 100, countdown: null, intro: null, winnerName: null, winnerSide: null,
      playerOneName: 'Ada', playerOneFighterName: 'Nyx', playerTwoName: 'Rival', playerTwoFighterName: 'Wraith',
      playerCount:1,hasExpectedPlayers:true,automaticSetup:false,allFightersSelected:true,isController:true,
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: fighter.name })),
      maps: FIGHTER_MAPS.map(map => ({ id: map.id, name: map.name })),
    };
    const session = new FighterVoiceSession({
      say: text => spoken.push(text), join: () => ({ playerId: 'f1', resumed: true }), leave: () => {}, setName: () => {},
      selectFighter: () => false, selectMap: () => false, advance: () => false,
      command: (_code, _id, command) => { commands.push(command); return true; }, snapshot: () => snapshot,
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA1', customParameters: { roomCode: '4821' } }));
    const prompt = (voicePrompt: string, last: boolean) => session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt, last }));
    prompt('punch', false); prompt('punch', false); prompt('punch five times', true);
    expect(commands).toEqual(['punch', 'punch', 'punch', 'punch', 'punch']);
    prompt('kick', false); prompt('kick', false); prompt('kick punch', true);
    expect(commands.slice(5)).toEqual(['kick', 'punch']);
    prompt('kick', false);
    session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
    prompt('kick', false);
    expect(commands).toHaveLength(7);
    prompt('kick', true);
    expect(commands.at(-1)).toBe('kick');
    expect(spoken.join(' ')).not.toContain('Say forward');
  });

  it('maps Fighter DTMF choices and fight controls through the active phase', () => {
    const game=voiceGame(),ada=game.connect('CA-DTMF');
    ada.prompt('Ada');ada.prompt('start');
    ada.session.handleMessage(JSON.stringify({type:'dtmf',digit:'1'}));
    expect(game.room.state().players.find(player=>player.playerId===ada.playerId)?.fighterId).toBe(FIGHTER_ROSTER[0]!.id);
    ada.prompt('next');ada.session.handleMessage(JSON.stringify({type:'dtmf',digit:'2'}));ada.prompt('fight');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    const before=game.commands.length;
    ada.session.handleMessage(JSON.stringify({type:'dtmf',digit:'4'}));
    expect(game.commands.slice(before).map(entry=>entry.command)).toContain('punch');
  });

  it('invalidates queued intro and countdown speech when display readiness is lost', () => {
    const game = voiceGame(), ada = game.connect('CA-GUARDED-CUES');
    ada.prompt('Ada'); ada.prompt('Nyx'); ada.prompt('second');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    const introCue = ada.guardedSpeech.find(entry => /player one/i.test(entry.text));
    expect(introCue?.isCurrent?.()).toBe(true);
    game.room.invalidateDisplayReady(); game.stateChanged();
    expect(introCue?.isCurrent?.()).toBe(false);

    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game);
    game.tick(3.1);
    const countdownCue = [...ada.guardedSpeech].reverse().find(entry => entry.text === '3');
    expect(countdownCue?.isCurrent?.()).toBe(true);
    game.room.invalidateDisplayReady(); game.stateChanged();
    expect(countdownCue?.isCurrent?.()).toBe(false);
  });

  it.each([['0',9],['*',10],['#',11]] as const)('maps Fighter DTMF %s to roster option %s', (digit,index) => {
    const game=voiceGame(),ada=game.connect(`CA-DTMF-${digit}`);ada.prompt('Ada');ada.prompt('start');
    ada.session.handleMessage(JSON.stringify({type:'dtmf',digit}));
    expect(game.room.state().players.find(player=>player.playerId===ada.playerId)?.fighterId).toBe(FIGHTER_ROSTER[index]!.id);
  });

  it('lets a corrected character selection through after barge-in', () => {
    const game = voiceGame(), ada = game.connect('CA-INTERRUPT');
    ada.prompt('Ada'); ada.prompt('start');
    ada.prompt('Nicks', false);
    expect(game.room.state().players[0]?.fighterId).toBeNull();
    ada.interrupt();
    ada.prompt('Wraith');
    expect(game.room.state().players[0]?.fighterId).toBe('wraith');
  });
});

function voiceGame() {
  const room = new FighterRoom('VOICE', 1234);
  const sessions: FighterVoiceSession[] = [];
  const commands: { playerId: string; command: FighterCommand }[] = [];
  const events: FighterEvent[] = [];

  const stateChanged = () => sessions.forEach(session => session.onStateChanged());
  const publishEvents = (events: FighterEvent[]) => {
    if (!events.length) return;
    for (const event of events) { for (const session of sessions) session.onFighterEvent(event); }
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
      nameConfirmed: room.hasConfirmedName(playerId),
      myFighterId: me.fighterId,
      myFighterName: fighterName(me.fighterId),
      foeName: foe?.name ?? null,
      foeFighterId: foe?.fighterId ?? null,
      foeFighterName: fighterName(foe?.fighterId),
      selectedMap: state.selectedMap,
      myMapVote:state.mapVotesByPlayerId[playerId]??null,
      allMapVotes:humans.every(player=>Boolean(state.mapVotesByPlayerId[player.playerId])),
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
      hasExpectedPlayers: state.hasExpectedPlayers,
      automaticSetup:state.automaticSetup,
      allFightersSelected: humans.length > 0 && humans.every(player => player.fighterId),
      isController: room.canControlSetup(playerId),
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: fighter.name })),
      maps: FIGHTER_MAPS.map(map => ({ id: map.id, name: map.name })),
    };
  };

  const connect = (callSid: string, roomCode = 'VOICE', commandLocale?: string, authoritativeName?: string,
    stationAssignment?:{index:number;count:number}) => {
    const spoken: string[] = [];
    const guardedSpeech: { text: string; isCurrent?: () => boolean }[] = [];
    let playerId = '';
    const session = new FighterVoiceSession({
      say: (text, isCurrent) => { spoken.push(text); guardedSpeech.push({ text, ...(isCurrent ? { isCurrent } : {}) }); },
      join: (_code,name,_callSid,side,expectedPlayers,nameConfirmed) => {
        if(expectedPlayers!==undefined)room.expectHumanPlayers(expectedPlayers,side!==undefined);
        else if(room.playerCount>=1)room.expectHumanPlayers(2,false);
        const joined = room.addPlayer(name,side,nameConfirmed);
        if ('error' in joined) return null;
        playerId = joined.playerId; stateChanged(); return { playerId, resumed: false };
      },
      leave: (_code, id) => { room.removePlayer(id); stateChanged(); },
      setName:(_code,id,name)=>{room.setName(id,name);room.expectHumanPlayers(Math.max(1,room.playerCount),false);stateChanged();},
      selectFighter: (_code, id, fighterId) => { const ok = room.selectFighter(id, fighterId); stateChanged(); return ok; },
      selectMap: (_code,id,mapId)=>{const ok=room.selectMap(id,mapId);stateChanged();return ok;},
      advance: (_code, id) => { const ok = room.canControlSetup(id) && room.advance(); stateChanged(); return ok; },
      command: (_code, id, command) => {
        const accepted = room.voiceCommand(id, command); if (accepted) commands.push({ playerId: id, command });
        const emitted=room.drainEvents();events.push(...emitted);publishEvents(emitted);stateChanged();return accepted;
      },
      snapshot: (_code, id) => snapshot(id),
    });
    session.setAuthoritativeName(authoritativeName??null);
    session.setStationManaged(authoritativeName!==undefined||stationAssignment!==undefined);
    if(stationAssignment)session.setStationAssignment(stationAssignment.index,stationAssignment.count);
    sessions.push(session);
    session.handleMessage(JSON.stringify({ type: 'setup', callSid, customParameters: { roomCode, ...(commandLocale ? { commandLocale } : {}) } }));
    return {
      session,
      spoken,
      guardedSpeech,
      get playerId() { return playerId; },
      prompt(text: string, last = true) { session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: text, last })); },
      interrupt() { session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 })); },
    };
  };

  const tick = (seconds: number) => { room.tick(seconds);const emitted=room.drainEvents();events.push(...emitted);publishEvents(emitted);stateChanged(); };
  return { room, commands, events, connect, tick, stateChanged };
}

function startTwoCallerFight(game: ReturnType<typeof voiceGame>) {
  const ada=game.connect('CA-COMMENTARY-A','VOICE',undefined,'Ada');
  const bob=game.connect('CA-COMMENTARY-B','VOICE',undefined,'Bob');
  ada.prompt('Nyx');bob.prompt('Wraith');ada.prompt('second');bob.prompt('second');
  game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
  return {ada,bob};
}

function advanceIntro(game: ReturnType<typeof voiceGame>): void {
  expect(game.room.state().intro).toBe(FIGHTER_INTRO_SECONDS);
  game.tick(4.1); // Player one -> versus
  game.tick(2);   // Versus -> player two
  game.tick(4);   // Player two -> faceoff
  game.tick(4);   // Faceoff -> countdown
}
