import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { FIGHTER_ROSTER } from '../shared/fighter-roster';
import { ANIMATION_POOLS, FIGHTER_ANIMATIONS } from '../client/fighter/fighter-assets';

describe('fighter assets', () => {
  it('has unique roster IDs with models and previews', () => {
    expect(new Set(FIGHTER_ROSTER.map(fighter => fighter.id)).size).toBe(FIGHTER_ROSTER.length);
    expect(FIGHTER_ROSTER).toHaveLength(12);
    for (const fighter of FIGHTER_ROSTER) {
      expect(existsSync(`assets/fighters/source/${fighter.file}`), fighter.file).toBe(true);
      expect(existsSync(fighter.preview.split('?')[0]!.replace('/assets/', 'assets/')), fighter.preview).toBe(true);
    }
  });

  it('only references existing clips from randomized pools', () => {
    const ids = new Set(FIGHTER_ANIMATIONS.map(animation => animation.id));
    for (const pool of Object.values(ANIMATION_POOLS)) for (const id of pool) expect(ids.has(id), id).toBe(true);
    expect(ANIMATION_POOLS.punch).toHaveLength(3);
    expect(ANIMATION_POOLS.kick).toHaveLength(4);
    expect(ANIMATION_POOLS.reaction).toEqual(['reaction-01', 'reaction-02', 'reaction-04', 'reaction-05']);
    expect(ANIMATION_POOLS.fall).toEqual(['fall-01', 'fall-02']);
    const filesById = new Map(FIGHTER_ANIMATIONS.map(animation => [animation.id, animation.file]));
    expect(ANIMATION_POOLS.reaction!.map(id => filesById.get(id))).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/fall|knock|stumble/i),
    ]));
    expect(ANIMATION_POOLS.celebration).toHaveLength(6);
    expect(FIGHTER_ANIMATIONS.find(animation => animation.id === 'walk')?.file).toBe('run-forward.fbx');
    expect(FIGHTER_ANIMATIONS.find(animation => animation.id === 'walk-back')?.file).toBe('run-backward.fbx');
    for (const animation of FIGHTER_ANIMATIONS) expect(existsSync(`assets/fighters/source/${animation.file}`), animation.file).toBe(true);
  });
});
