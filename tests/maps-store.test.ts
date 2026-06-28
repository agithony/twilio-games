import { describe, it, expect } from 'vitest';
import { mergeMapConfig } from '../shared/maps-store';

describe('mergeMapConfig', () => {
  const valid = { map: 'silver_lake', file: 'silver_lake.glb',
    model: { pos: [0, 0, 1050], rotDeg: [0, 0, 0], scale: 200 },
    track: { pos: [0, 0, 1050], rotDeg: [0, 0, 0], scale: 1 } };

  it('adds a new map under its key without touching existing maps', () => {
    const existing = JSON.stringify({ desert: { map: 'desert', file: 'desert.glb' } });
    const r = mergeMapConfig(existing, valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.maps).sort()).toEqual(['desert', 'silver_lake']);
    expect(r.maps.silver_lake!.map).toBe('silver_lake');
  });

  it('overwrites only the posted map, preserving the rest', () => {
    const existing = JSON.stringify({
      silver_lake: { map: 'silver_lake', file: 'old.glb' },
      desert: { map: 'desert', file: 'desert.glb' },
    });
    const r = mergeMapConfig(existing, valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maps.silver_lake!.file).toBe('silver_lake.glb');   // updated
    expect(r.maps.desert!.file).toBe('desert.glb');             // untouched
  });

  it('rejects a config with no map name (does not corrupt the file)', () => {
    const r = mergeMapConfig('{}', { file: 'x.glb' });
    expect(r.ok).toBe(false);
  });

  it('rejects dangerous prototype keys', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const r = mergeMapConfig('{}', { ...valid, map: bad });
      expect(r.ok).toBe(false);
    }
  });

  it('CRITICAL: a corrupt existing file does NOT wipe everything — it is rejected', () => {
    // The old code did JSON.parse(corrupt) -> {} and then wrote, silently dropping every
    // other level. We must refuse rather than destroy.
    const r = mergeMapConfig('this is not json {{{', valid);
    expect(r.ok).toBe(false);
  });

  it('treats a missing/empty file as a fresh start (first save)', () => {
    const r = mergeMapConfig('', valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.maps)).toEqual(['silver_lake']);
  });

  it('normalizes the stored config through mergeLevel (no junk fields persisted)', () => {
    const r = mergeMapConfig('{}', { ...valid, junk: 'nope', evil: { a: 1 } } as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.maps.silver_lake as any).junk).toBeUndefined();
    expect((r.maps.silver_lake as any).evil).toBeUndefined();
  });

  it('round-trips: serialize the result, feed it back, and the maps are stable', () => {
    const first = mergeMapConfig('{}', valid);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const json = JSON.stringify(first.maps);
    const second = mergeMapConfig(json, { ...valid, file: 'silver_lake.glb' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.maps.silver_lake!.map).toBe('silver_lake');
  });
});
