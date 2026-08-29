import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_KARAOKE_VENUE,
  cloneKaraokeVenueConfig,
  isSafeKaraokeGlbBasename,
  karaokeCameraMode,
  karaokeVenueModel,
  parseKaraokeVenueConfig,
} from '../shared/karaoke-venue';

describe('Karaoke venue config', () => {
  it('strictly parses a detached copy of the compiled versioned default', () => {
    const parsed = parseKaraokeVenueConfig(JSON.parse(JSON.stringify(DEFAULT_KARAOKE_VENUE)) as unknown);
    expect(parsed.version).toBe(1);
    expect(parsed.models.map(model => model.role)).toEqual([
      'stage', 'lead-singer', 'backup-singer', 'drummer', 'guitarist',
    ]);
    expect(karaokeVenueModel(parsed, 'stage').transform.rotation).toEqual([0, 180, 0]);
    expect(parsed).not.toBe(DEFAULT_KARAOKE_VENUE);
  });

  it('keeps the bundled image seed synchronized with the compiled fallback', () => {
    const bundled = JSON.parse(readFileSync(new URL('../assets/karaoke/venue.json', import.meta.url), 'utf8')) as unknown;
    expect(parseKaraokeVenueConfig(bundled)).toEqual(DEFAULT_KARAOKE_VENUE);
  });

  it('clones defaults without allowing their nested values to be mutated', () => {
    const clone = cloneKaraokeVenueConfig();
    clone.models[0]!.transform.position[0] = 9;
    expect(DEFAULT_KARAOKE_VENUE.models[0]!.transform.position[0]).toBe(0);
    expect(Object.isFrozen(DEFAULT_KARAOKE_VENUE.models[0]!.transform)).toBe(true);
  });

  it('rejects unknown or missing fields at every strict boundary', () => {
    const extra = cloneKaraokeVenueConfig() as KaraokeVenueConfigWithUnknown;
    extra.unknown = true;
    expect(() => parseKaraokeVenueConfig(extra)).toThrow(/unexpected or missing/);
    const nested = cloneKaraokeVenueConfig() as unknown as { models: Array<Record<string, unknown>> };
    nested.models[0]!.surprise = 1;
    expect(() => parseKaraokeVenueConfig(nested)).toThrow(/models\[0\].*unexpected or missing/);
  });

  it.each([
    ['non-finite position', (venue: ReturnType<typeof cloneKaraokeVenueConfig>) => { venue.models[0]!.transform.position[0] = Number.NaN; }],
    ['zero scale', (venue: ReturnType<typeof cloneKaraokeVenueConfig>) => { venue.highway.landscape.scale[1] = 0; }],
    ['unbounded rotation', (venue: ReturnType<typeof cloneKaraokeVenueConfig>) => { venue.models[1]!.transform.rotation[2] = 3601; }],
    ['bad FOV', (venue: ReturnType<typeof cloneKaraokeVenueConfig>) => { venue.cameras.portrait.fov = 121; }],
    ['bad color', (venue: ReturnType<typeof cloneKaraokeVenueConfig>) => { venue.lighting.ambient.skyColor = 'red'; }],
  ])('rejects %s', (_label, mutate) => {
    const venue = cloneKaraokeVenueConfig();
    mutate(venue);
    expect(() => parseKaraokeVenueConfig(venue)).toThrow();
  });

  it('requires every model role once and globally unique safe IDs', () => {
    const duplicateRole = cloneKaraokeVenueConfig();
    duplicateRole.models[1]!.role = 'stage';
    expect(() => parseKaraokeVenueConfig(duplicateRole)).toThrow(/every Karaoke role/);
    const duplicateId = cloneKaraokeVenueConfig();
    duplicateId.lighting.spotlights[0]!.id = 'stage';
    expect(() => parseKaraokeVenueConfig(duplicateId)).toThrow(/IDs must be unique/);
  });

  it.each(['../stage.glb', 'sub/stage.glb', '_raw.glb/secret.glb', '.hidden.glb', 'stage.gltf', 'stage.glb?x=1'])
    ('rejects unsafe GLB basename %s', file => {
      expect(isSafeKaraokeGlbBasename(file)).toBe(false);
      const venue = cloneKaraokeVenueConfig();
      venue.models[0]!.file = file;
      expect(() => parseKaraokeVenueConfig(venue)).toThrow(/safe \.glb basename/);
    });

  it('selects deterministic responsive camera classes', () => {
    expect(karaokeCameraMode(16 / 9)).toBe('landscape');
    expect(karaokeCameraMode(1)).toBe('compact');
    expect(karaokeCameraMode(.6)).toBe('portrait');
  });
});

type KaraokeVenueConfigWithUnknown = ReturnType<typeof cloneKaraokeVenueConfig> & { unknown?: boolean };
