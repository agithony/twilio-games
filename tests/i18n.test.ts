import { describe, expect, it } from 'vitest';
import { resolveLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';
import { buildSystemPrompt, clearSelectionIndex, parseSelectionNumber } from '../server/game-host';
import { buildBattleSystemPrompt, type BattleHostContext } from '../server/battle-host';
import {
  gameTitle, carName, trackName, monsterName, moveName, fighterName, fighterMapName,
  localizedMonsterAliases, localizedMoveAliases,
} from '../shared/i18n/content';
import { COMMON_MESSAGES } from '../shared/i18n/common';

describe('locale foundations', () => {
  it('resolves exact, underscore, and language-only locale values', () => {
    expect(resolveLocale('pt-BR')).toBe('pt-BR');
    expect(resolveLocale('pt_BR')).toBe('pt-BR');
    expect(resolveLocale('pt')).toBe('pt-BR');
    expect(resolveLocale('fr-FR')).toBe('en-US');
  });

  it('normalizes accented Unicode without losing words', () => {
    expect(normalizeForMatching('  PRÓXIMO, então! ', 'pt-BR')).toBe('proximo entao');
  });

  it('parses Portuguese cardinals, ordinals, and clear selections', () => {
    expect(parseSelectionNumber('a terceira opção', 'pt-BR')).toBe(3);
    expect(clearSelectionIndex('quero o número dois', ['A', 'B', 'C'], 'pt-BR')).toBe(1);
    expect(clearSelectionIndex('qual é o mais rápido?', ['A', 'B'], 'pt-BR')).toBeNull();
  });

  it('keeps Portuguese LLM prompts Portuguese-only', () => {
    const racer = buildSystemPrompt({
      phase: 'lobby', cars: [], maps: [], selectedMap: null, myName: null, myCar: null,
      myPlace: null, racerCount: 1, setName: () => null, selectCarByName: () => null,
      selectMapByName: () => null, startRace: () => null,
    }, 'pt-BR');
    expect(racer).toContain('responda SOMENTE em português');

    const battleContext: BattleHostContext = {
      phase: 'lobby', monsters: [], myName: null, myMonster: null, foeMonster: null,
      myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null, myPotions: 2,
      whoseTurn: null, moves: [], winnerName: null, setName: () => null,
      selectMonster: () => null, chooseAction: () => null, advance: () => null,
    };
    const battle = buildBattleSystemPrompt(battleContext, 'pt-BR');
    expect(battle).toContain('responda SOMENTE em português');
    expect(battle).not.toContain('say only natural spoken English');
  });

  it('localizes titles, attribution, and invented game content', () => {
    expect(gameTitle('pt-BR', 'racer')).toBe('Corrida por Voz');
    expect(gameTitle('pt-BR', 'monsters')).toBe('Monstros por Voz');
    expect(gameTitle('pt-BR', 'fighter')).toBe('Luta por Voz');
    expect(gameTitle('pt-BR', 'trivia')).toBe('Quiz por Voz');
    expect(gameTitle('pt-BR', 'karaoke')).toBe('Karaokê por Voz');
    expect(COMMON_MESSAGES['pt-BR']['attribution.builtBy']).toBe('Criado pelo Mago da Twilio');
    expect(carName('pt-BR', 'Batmobile')).toBe('Batmóvel');
    expect(trackName('pt-BR', 'Silver Lake')).toBe('Lago Prateado');
    expect(monsterName('pt-BR', 'sparkmouse')).toBe('Rato-Faísca');
    expect(moveName('pt-BR', 'sparkmouse.jolt')).toBe('Choque Trovejante');
    expect(fighterName('pt-BR', 'wraith', 'Wraith')).toBe('Espectro');
    expect(fighterMapName('pt-BR', 'void', 'Void Circuit')).toBe('Circuito do Vazio');
  });

  it('retains English and Portuguese aliases for localized battle content', () => {
    expect(localizedMonsterAliases('sparkmouse', 'Rato-Faísca')).toEqual(['Sparkmouse', 'Rato-Faísca']);
    expect(localizedMoveAliases('sparkmouse.jolt', 'Choque Trovejante')).toEqual(['Thunder Jolt', 'Choque Trovejante']);
  });
});
