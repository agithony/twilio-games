import { describe, expect, it } from 'vitest';
import { isExplicitSpokenName, parseFirstName, parseTypedFirstName } from '../shared/spoken-name';

describe('deterministic spoken first-name parsing', () => {
  it.each([
    ['Ana','Ana'],['Ana?','Ana'],['Meu nome é a Ana','Ana'],['Eu sou a Ana','Ana'],
    ['Eu me chamo Ana','Ana'],['O meu nome é Ana','Ana'],['É a Ana','Ana'],
    ['Oi, meu nome é Ana','Ana'],['Meu primeiro nome é Ana','Ana'],
    ['Meu nome é Ana, por favor','Ana'],['Maria Eduarda','Maria Eduarda'],
    ['Maria da Graça','Maria da Graça'],
  ])('parses Portuguese reply %s', (spoken, expected) => {
    expect(parseFirstName(spoken,'pt-BR')).toBe(expected);
  });

  it.each(['quero jogar','estou pronta','não entendi','qual lutador','ajuda','revanche'])
    ('rejects Portuguese non-name reply %s', spoken => {
      expect(parseFirstName(spoken,'pt-BR')).toBeNull();
    });

  it('recognizes explicit introductions and keeps English support', () => {
    expect(isExplicitSpokenName('Oi, meu nome é Ana','pt-BR')).toBe(true);
    expect(parseFirstName('chame me de Ana','pt-BR')).toBe('Ana');
    expect(parseFirstName('me chama de Ana','pt-BR')).toBe('Ana');
    expect(parseFirstName('pode chamar de Ana','pt-BR')).toBe('Ana');
    expect(parseFirstName("I'm Ada",'en-US')).toBe('Ada');
    expect(parseFirstName('which monster is best?','en-US')).toBeNull();
    for(const command of ['what?','go','item','potion','taunt','five'])expect(parseFirstName(command,'en-US')).toBeNull();
    for(const command of ['o que?','luta','batalhar','ataca'])expect(parseFirstName(command,'pt-BR')).toBeNull();
    expect(parseFirstName('Ana123','pt-BR')).toBeNull();
    expect(parseFirstName('McDonald','en-US')).toBe('McDonald');
    expect(parseFirstName('AJ','en-US')).toBe('AJ');
    expect(parseFirstName('Jose\u0301','pt-BR')).toBe('José');
  });

  it('keeps typed first names separate from spoken command filtering', () => {
    expect(parseTypedFirstName('Go','en-US')).toBe('Go');
    expect(parseTypedFirstName('J.','en-US')).toBe('J');
    expect(parseTypedFirstName('A','en-US')).toBe('A');
    expect(parseTypedFirstName('Meu nome é a Ana','pt-BR')).toBe('Ana');
    expect(parseTypedFirstName('Ana123','pt-BR')).toBeNull();
    expect(parseTypedFirstName('Meu nome é Ana e sobrenome Silva','pt-BR')).toBeNull();
  });
});
