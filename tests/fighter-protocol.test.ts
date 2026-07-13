import { describe, expect, it } from 'vitest';
import { parseFighterClientMessage } from '../shared/fighter-protocol';

describe('fighter protocol', () => {
  it('parses every combat command', () => {
    for (const command of ['forward', 'back', 'jump', 'punch', 'kick', 'block']) {
      expect(parseFighterClientMessage(JSON.stringify({ type: 'command', command }))).toEqual({ type: 'command', command });
    }
  });
  it('rejects arbitrary commands and sides', () => {
    expect(parseFighterClientMessage(JSON.stringify({ type: 'command', command: 'win', fighter: 'p2' }))).toMatchObject({ type: 'error' });
  });
  it('parses selection and navigation messages', () => {
    expect(parseFighterClientMessage('{"type":"select_fighter","fighterId":"nyx"}')).toEqual({ type: 'select_fighter', fighterId: 'nyx' });
    expect(parseFighterClientMessage('{"type":"select_map","mapId":"void"}')).toEqual({ type: 'select_map', mapId: 'void' });
    expect(parseFighterClientMessage('{"type":"advance"}')).toEqual({ type: 'advance' });
    expect(parseFighterClientMessage('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseFighterClientMessage('{"type":"display_auth","roomCode":"4821","token":"secret"}')).toEqual({ type: 'display_auth', roomCode: '4821', token: 'secret' });
    expect(parseFighterClientMessage('{"type":"ready","loadingGeneration":2}')).toEqual({ type: 'ready', loadingGeneration: 2 });
    expect(parseFighterClientMessage('{"type":"ready","loadingGeneration":0}')).toMatchObject({ type: 'error', code: 'bad_ready' });
  });
});
