import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MIB = 1024 * 1024;
const WARNING_BYTES = 32 * MIB;
const HARD_LIMIT_BYTES = 128 * MIB;
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

function idsIn(block: string): string[] {
  return [...block.matchAll(/\bid:\s*'([^']+)'/g)].map(match => match[1]!);
}

function runtimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '_raw') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? runtimeFiles(path) : [path];
  });
}

function lfsPointerSize(file: string): number | null {
  const contents = readFileSync(file).subarray(0, 256).toString('utf8');
  if (!contents.startsWith(LFS_POINTER_HEADER)) return null;
  const oid = /^oid sha256:[0-9a-f]{64}$/m.test(contents);
  const size = Number(/^size ([1-9][0-9]*)$/m.exec(contents)?.[1]);
  expect(oid, `invalid Git LFS object ID: ${file}`).toBe(true);
  expect(Number.isSafeInteger(size), `invalid Git LFS size: ${file}`).toBe(true);
  return size;
}

function runtimeAssetSize(file: string): number {
  return lfsPointerSize(file) ?? statSync(file).size;
}

function creditsRow(credits: string, id: string): string | undefined {
  return credits.split('\n').find(line => line.startsWith(`| \`${id}\` |`));
}

describe('fighter asset governance', () => {
  it('parses roster, animation, and map references without importing application modules', () => {
    const rosterSource = source('shared/fighter-roster.ts');
    const rosterBlock = rosterSource.match(/FIGHTER_ROSTER[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1];
    const animationSource = source('client/fighter/fighter-assets.ts');
    const animationBlock = animationSource.match(/FIGHTER_ANIMATIONS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1];
    expect(rosterBlock, 'could not parse FIGHTER_ROSTER').toBeTruthy();
    expect(animationBlock, 'could not parse FIGHTER_ANIMATIONS').toBeTruthy();

    const rosterFiles = [...rosterBlock!.matchAll(/\bfile:\s*'([^']+)'/g)].map(match => `assets/fighters/source/${match[1]}`);
    const rosterPreviews = [...rosterBlock!.matchAll(/\bpreview:\s*'\/assets\/([^']+)'/g)].map(match => `assets/${match[1]}`.replace(/\?.*$/, ''));
    const animationFiles = [...animationBlock!.matchAll(/\bfile:\s*'([^']+)'/g)].map(match => `assets/fighters/source/${match[1]}`);
    const maps = JSON.parse(source('assets/fighters/maps/maps.json')) as { file?: string; preview?: string }[];
    const mapFiles = maps.flatMap(map => map.file ? [`assets/fighters/maps/${map.file}`] : []);
    const mapPreviews = maps.flatMap(map => map.preview ? [map.preview.replace(/^\/assets\//, 'assets/').replace(/\?.*$/, '')] : []);

    expect(rosterFiles).toHaveLength(12);
    expect(animationFiles.length).toBeGreaterThan(0);
    for (const file of [...rosterFiles, ...rosterPreviews, ...animationFiles, ...mapFiles, ...mapPreviews]) {
      expect(existsSync(file), `missing Fighter runtime asset: ${file}`).toBe(true);
    }
  });

  it('keeps every current fighter, animation group, and map in the provenance ledger', () => {
    const rosterSource = source('shared/fighter-roster.ts');
    const rosterBlock = rosterSource.match(/FIGHTER_ROSTER[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1];
    const animationSource = source('client/fighter/fighter-assets.ts');
    const poolBlock = animationSource.match(/ANIMATION_POOLS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1];
    expect(rosterBlock, 'could not parse FIGHTER_ROSTER').toBeTruthy();
    expect(poolBlock, 'could not parse ANIMATION_POOLS').toBeTruthy();

    const fighters = idsIn(rosterBlock!);
    const groups = [...poolBlock!.matchAll(/(?:^|,)\s*(?:'([^']+)'|([a-z][\w-]*))\s*:/g)]
      .map(match => match[1] ?? match[2]!);
    const maps = (JSON.parse(source('assets/fighters/maps/maps.json')) as { id: string }[]).map(map => map.id);
    const credits = source('assets/CREDITS.md');

    expect(fighters).toHaveLength(12);
    expect(maps.length).toBeGreaterThan(0);
    for (const id of [...fighters, ...groups, ...maps]) {
      const row = creditsRow(credits, id);
      expect(row, `missing Fighter provenance row for ${id}`).toBeTruthy();
      expect(row!.match(/UNKNOWN - verification required/g), `${id} must clearly flag unknown source and license`).toHaveLength(2);
    }
  });

  it('keeps individual runtime assets below warning and hard ceilings', () => {
    const files = runtimeFiles('assets/fighters');
    const oversized = files.filter(file => runtimeAssetSize(file) > HARD_LIMIT_BYTES);
    expect(oversized.map(file => relative('.', file)), `hard asset limit is ${HARD_LIMIT_BYTES / MIB} MiB`).toEqual([]);

    const warnings = files
      .filter(file => runtimeAssetSize(file) > WARNING_BYTES)
      .map(file => `${relative('.', file)} (${(runtimeAssetSize(file) / MIB).toFixed(1)} MiB)`);
    if (warnings.length) console.warn(`Fighter assets above the ${WARNING_BYTES / MIB} MiB warning budget:\n${warnings.join('\n')}`);
  });

  it('keeps every model materialized or represented by a valid Git LFS pointer', () => {
    const models = runtimeFiles('assets/fighters').filter(file => /\.(?:fbx|glb)$/i.test(file));
    expect(models.length).toBeGreaterThan(0);
    for (const file of models) expect(runtimeAssetSize(file)).toBeGreaterThan(0);
  });

  it('excludes raw Fighter map originals from the Docker context', () => {
    const rules = source('.dockerignore').split(/\r?\n/).map(line => line.trim());
    expect(rules).toContain('assets/fighters/maps/_raw');
  });
});
