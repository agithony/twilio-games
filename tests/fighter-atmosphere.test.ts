import { describe, expect, it } from 'vitest';
import { fighterAtmosphereSpec } from '../client/fighter/fighter-atmosphere';

describe('fighter map atmosphere', () => {
  it('gives every authored GLB stage a distinct lightweight treatment', () => {
    expect(fighterAtmosphereSpec('cyberpunk-city')).toMatchObject({ effect: 'neon', skyline: true });
    expect(fighterAtmosphereSpec('inakaya')).toMatchObject({ effect: 'motes' });
    expect(fighterAtmosphereSpec('rain')).toMatchObject({ effect: 'rain', platform: 'wet-stone' });
    for (const id of ['cyberpunk-city', 'inakaya', 'rain']) {
      const spec = fighterAtmosphereSpec(id)!;
      expect(spec.effectCount).toBeLessThanOrEqual(220);
      expect(spec.mountain).toHaveLength(3);
      expect(spec.keyIntensity).toBeGreaterThan(0);
    }
  });

  it('does not replace the existing procedural stage atmosphere', () => {
    expect(fighterAtmosphereSpec('foundry')).toBeNull();
    expect(fighterAtmosphereSpec('void')).toBeNull();
  });
});
