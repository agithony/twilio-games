import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { HttpServer } from '../server/http-server';

let srv: HttpServer;
afterEach(async () => { await srv?.stop(); });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const closeWs = (ws: WebSocket) => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(); };

describe('voice integration (fake Conversation Relay client)', () => {
  it('inherits Twilio STT and TTS locale from the active display room', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const display = new WebSocket(`ws://127.0.0.1:${port}/game`);
    await new Promise<void>(resolve => display.on('open', resolve));
    display.send(JSON.stringify({ type: 'spectate', roomCode: '8552', locale: 'pt-BR' }));
    await wait(30);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/voice/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Digits=8552',
      });
      const xml = await response.text();
      expect(xml).toContain('transcriptionLanguage="pt-BR"');
      expect(xml).toContain('ttsLanguage="pt-BR"');
      expect(xml).toContain('<Parameter name="commandLocale" value="pt-BR"');
      expect(xml).toContain('hints="esquerda, direita, acelerar');
    } finally {
      closeWs(display);
    }
  });

  it('a CR socket joins a room by code and a spoken command moves the car', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();

    // a browser spectator watches the same room over /game
    const spec = new WebSocket(`ws://127.0.0.1:${port}/game`);
    const inbox: any[] = [];
    spec.on('message', d => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>(r => spec.on('open', () => r()));
    spec.send(JSON.stringify({ type: 'spectate', roomCode: '4821' }));

    // the "phone" connects over /voice as Conversation Relay would
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    await new Promise<void>(r => voice.on('open', () => r()));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA1', from: '+15551239999',
      customParameters: { roomCode: '4821' },
    }));
    await wait(50);

    // The voice player is now in room 4821. The spectator/operator console starts
    // the race: restart() calls room.start() with no playerId required on the conn.
    spec.send(JSON.stringify({ type: 'restart' }));
    await wait(100);

    // a spoken command should move the single phone player's car
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'right', last: true }));
    await wait(300);

    const snap = [...inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(snap).toBeDefined();
    expect(snap.snapshot.cars.length).toBe(1);   // exactly the phone player
    voice.close();
    spec.close();
  });

  it('voice setup flows name → car → track vote → start without asking for the name again', async () => {
    srv = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json',
    });
    const port = await srv.start();

    const spec = new WebSocket(`ws://127.0.0.1:${port}/game`);
    const inbox: any[] = [];
    spec.on('message', d => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>(r => spec.on('open', () => r()));
    spec.send(JSON.stringify({ type: 'spectate', roomCode: '7331' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: string[] = [];
    voice.on('message', d => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'text') spoken.push(String(msg.token));
    });
    await new Promise<void>(r => voice.on('open', () => r()));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA2', from: '+15551230001',
      customParameters: { roomCode: '7331' },
    }));
    try {
      await wait(50);

      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
      await wait(900);
      expect(spoken.join(' ').toLowerCase()).toMatch(/controls on the screen|say left|nitro/);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true }));
      await wait(50);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'one', last: true }));
      await wait(50);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'next', last: true }));
      await wait(50);
      spoken.length = 0;
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'one', last: true }));
      await wait(300);

      expect(spoken.join(' ').toLowerCase()).toContain("vote's in");
      expect(spoken.join(' ').toLowerCase()).not.toMatch(/what'?s your name|first up.*name/);
      expect(inbox.some(m => m.type === 'items')).toBe(false);

      spoken.length = 0;
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true }));
      await wait(300);

      expect(spoken.join(' ').toLowerCase()).toContain('here we go');
      expect(spoken.join(' ').toLowerCase()).not.toMatch(/what'?s your name|first up.*name/);
      expect(inbox.some(m => m.type === 'items')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(spec);
    }
  });

  it('runs the deterministic Racer setup flow in Brazilian Portuguese', async () => {
    srv = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json',
    });
    const port = await srv.start();
    const roomCode = '7441';
    const spec = new WebSocket(`ws://127.0.0.1:${port}/game`);
    const inbox: any[] = [];
    spec.on('message', data => inbox.push(JSON.parse(data.toString())));
    await new Promise<void>(resolve => spec.on('open', resolve));
    spec.send(JSON.stringify({ type: 'spectate', roomCode, locale: 'pt-BR' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: { token: string; lang?: string }[] = [];
    voice.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'text') spoken.push(message);
    });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA-PT-RACER', from: '+5511999999999',
      customParameters: { roomCode, game: 'racer', locale: 'pt-BR', commandLocale: 'pt-BR' },
    }));

    try {
      await wait(50);
      for (const command of ['Meu nome é Ana', 'começar', 'um', 'próximo']) {
        voice.send(JSON.stringify({ type: 'prompt', voicePrompt: command, last: true }));
        await wait(80);
      }
      expect(spoken.map(message => message.token).join(' ')).toContain('Batmóvel');
      spoken.length = 0;
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'um', last: true }));
      await wait(300);
      expect(spoken.map(message => message.token).join(' ').toLowerCase()).toContain('seu voto');
      expect(spoken.map(message => message.token).join(' ')).toContain('Lago Prateado');
      expect(spoken.every(message => message.lang === 'pt-BR')).toBe(true);

      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'começar', last: true }));
      await wait(300);
      expect(inbox.some(message => message.type === 'items')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(spec);
    }
  });

  it('runs Portuguese Voice Monsters with localized names and deterministic name capture', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const roomCode = '8663';
    const display = new WebSocket(`ws://127.0.0.1:${port}/battle`);
    const states: any[] = [], events: any[] = [];
    display.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'battle_state') states.push(message);
      if (message.type === 'battle_events') events.push(...message.events);
    });
    await new Promise<void>(resolve => display.on('open', resolve));
    display.send(JSON.stringify({ type: 'spectate', roomCode, locale: 'pt-BR' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: { token: string; lang?: string }[] = [];
    voice.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'text') spoken.push(message); });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA-PT-MONSTERS', from: '+5511888888888',
      customParameters: { roomCode, game: 'monsters', locale: 'pt-BR', commandLocale: 'pt-BR' },
    }));

    try {
      await wait(80);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Meu nome é Ana', last: true }));
      await wait(80);
      expect(states.at(-1)?.players.some((player: any) => player.name === 'Ana')).toBe(true);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'começar', last: true }));
      await wait(80);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Rato-Faísca', last: true }));
      await wait(80);
      expect(states.at(-1)?.players.some((player: any) => player.monsterId === 'sparkmouse')).toBe(true);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'batalhar', last: true }));
      await wait(100);
      expect(states.at(-1)?.phase).toBe('battle');
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'lutar dois', last: true }));
      await wait(250);
      expect(events.some(event => event.kind === 'move_used' && event.moveId === 'sparkmouse.zap')).toBe(true);
      expect(spoken.some(message => message.token.includes('Monstros por Voz'))).toBe(true);
      expect(spoken.every(message => message.lang === 'pt-BR')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(display);
    }
  });

  it('Voice Monsters resumes the same caller mid-battle without asking for name or monster again', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const roomCode = '6442';
    const callSid = 'CA-MONSTERS-RECONNECT';

    const spec = new WebSocket(`ws://127.0.0.1:${port}/battle`);
    const states: any[] = [];
    spec.on('message', d => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'battle_state') states.push(msg);
    });
    await new Promise<void>(r => spec.on('open', () => r()));
    spec.send(JSON.stringify({ type: 'spectate', roomCode }));

    const connectVoice = async (spoken: string[]) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
      ws.on('message', d => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'text') spoken.push(String(msg.token));
      });
      await new Promise<void>(r => ws.on('open', () => r()));
      ws.send(JSON.stringify({
        type: 'setup', callSid, from: '+15551234567',
        customParameters: { roomCode, game: 'monsters' },
      }));
      return ws;
    };

    const firstSpeech: string[] = [];
    const first = await connectVoice(firstSpeech);
    try {
      await wait(40);
      for (const text of ['Ada', 'start', 'Sparkmouse', 'battle']) {
        first.send(JSON.stringify({ type: 'prompt', voicePrompt: text, last: true }));
        await wait(40);
      }
      const before = states.at(-1);
      expect(before?.phase).toBe('battle');
      expect(before?.players?.[0]?.name).toBe('Ada');
      expect(before?.players?.[0]?.monsterId).toBe('sparkmouse');

      first.close();
      await new Promise<void>(r => first.once('close', () => r()));
      await wait(40);

      const resumedSpeech: string[] = [];
      const resumed = await connectVoice(resumedSpeech);
      try {
        await wait(900);
        const after = states.at(-1);
        expect(after?.phase).toBe('battle');
        expect(after?.players?.[0]?.name).toBe('Ada');
        expect(after?.players?.[0]?.monsterId).toBe('sparkmouse');
        expect(after?.players).toHaveLength(1);
        expect(resumedSpeech.join(' ')).toMatch(/back in the battle/i);
        expect(resumedSpeech.join(' ')).not.toMatch(/what'?s your name|pick a monster/i);
      } finally {
        closeWs(resumed);
      }
    } finally {
      closeWs(first);
      closeWs(spec);
    }
  });

  it('runs Portuguese Voice Fighter setup with localized fighters and arenas', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const roomCode = '8774';
    const display = new WebSocket(`ws://127.0.0.1:${port}/fighter`);
    const states: any[] = [];
    display.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'fighter_state') states.push(message); });
    await new Promise<void>(resolve => display.on('open', resolve));
    display.send(JSON.stringify({ type: 'spectate', roomCode, locale: 'pt-BR' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: { token: string; lang?: string }[] = [];
    voice.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'text') spoken.push(message); });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA-PT-FIGHTER', from: '+5511777777777',
      customParameters: { roomCode, game: 'fighter', locale: 'pt-BR', commandLocale: 'pt-BR' },
    }));

    try {
      await wait(60);
      for (const command of ['Ana', 'começar', 'Nix']) {
        voice.send(JSON.stringify({ type: 'prompt', voicePrompt: command, last: true }));
        await wait(command === 'Nix' ? 500 : 90);
      }
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'próximo', last: true })); await wait(90);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Circuito do Vazio', last: true })); await wait(500);
      const latest = states.at(-1);
      expect(latest?.players.some((player: any) => player.name === 'Ana' && player.fighterId === 'nyx')).toBe(true);
      expect(latest?.selectedMap).toBe('void');
      const output = spoken.map(message => message.token).join(' ');
      expect(output).toContain('Luta por Voz');
      expect(output).toContain('Nix');
      expect(output).toContain('Circuito do Vazio');
      expect(output).not.toContain('Voice Fighter');
      expect(spoken.every(message => message.lang === 'pt-BR')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(display);
    }
  });

  it('Voice Fighter resumes the same CallSid without duplicating the player', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start(), roomCode = 'VF42', callSid = 'CA-FIGHTER-RECONNECT';
    const display = new WebSocket(`ws://127.0.0.1:${port}/fighter`), states: any[] = [];
    display.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'fighter_state') states.push(message); });
    await new Promise<void>(resolve => display.on('open', resolve)); display.send(JSON.stringify({ type: 'spectate', roomCode }));
    const connect = async (spoken: string[]) => {
      const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
      voice.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'text') spoken.push(String(message.token)); });
      await new Promise<void>(resolve => voice.on('open', resolve));
      voice.send(JSON.stringify({ type: 'setup', callSid, from: '+15550001111', customParameters: { roomCode: ` ${roomCode.toLowerCase()} `, game: 'fighter' } }));
      return voice;
    };
    const firstSpeech: string[] = [], first = await connect(firstSpeech);
    try {
      await wait(50); first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true })); await wait(40);
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true })); await wait(40);
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Iron Oni', last: false })); await wait(80);
      expect(states.at(-1)?.players?.[0]).toMatchObject({ name: 'Ada', fighterId: null });
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Iron Oni', last: true })); await wait(40);
      expect(states.at(-1)?.players?.[0]).toMatchObject({ name: 'Ada', fighterId: 'iron-oni' });
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'next', last: true })); await wait(40);
      expect(states.at(-1)?.phase).toBe('map_select');
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'first', last: true })); await wait(40);
      expect(states.at(-1)?.selectedMap).toBeTruthy();
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'fight', last: true })); await wait(80);
      expect(states.at(-1)?.phase).toBe('loading');
      display.send(JSON.stringify({ type: 'ready', loadingGeneration: states.at(-1)?.loadingGeneration })); await wait(80);
      expect(states.at(-1)?.phase).toBe('intro');
      first.close(); await new Promise<void>(resolve => first.once('close', resolve)); await wait(40);
      const resumedSpeech: string[] = [], resumed = await connect(resumedSpeech);
      try {
        await wait(900);
        expect(states.at(-1)?.players?.filter((player: any) => !player.isAi)).toHaveLength(1);
        expect(states.at(-1)?.players?.find((player: any) => !player.isAi)).toMatchObject({ name: 'Ada', fighterId: 'iron-oni' });
        expect(states.at(-1)?.players?.find((player: any) => player.isAi)).toBeTruthy();
        expect(resumedSpeech.join(' ')).toMatch(/back/i);
        expect(resumedSpeech.join(' ')).toMatch(/player one, Ada, as Iron Oni/i);
        expect(resumedSpeech.join(' ')).not.toMatch(/what is your name/i);
      } finally { closeWs(resumed); }
    } finally { closeWs(first); closeWs(display); }
  });
});
