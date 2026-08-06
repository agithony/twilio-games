import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

const POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

function parsePointer(contents, file) {
  const lines = contents.trim().split(/\r?\n/);
  const oid = /^oid sha256:([0-9a-f]{64})$/.exec(lines[1] ?? '')?.[1];
  const size = /^size ([1-9][0-9]*)$/.exec(lines[2] ?? '')?.[1];
  if (lines[0] !== POINTER_HEADER || !oid || !size) {
    throw new Error(`${file}: committed Git LFS pointer is malformed`);
  }
  return { oid, size: Number(size) };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const assetRootFlag = process.argv.indexOf('--asset-root');
const assetRoot = resolve(assetRootFlag >= 0 ? process.argv[assetRootFlag + 1] ?? '' : '.');
const files = execFileSync('git', [
  'ls-files',
  ':(glob)assets/fighters/source/*.fbx',
  ':(glob)assets/fighters/maps/*.glb',
], { encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(Boolean);

if (files.length === 0) throw new Error('No Git LFS assets are tracked');
const assets = files.sort().map(file => ({
  file,
  pointer: parsePointer(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' }), file),
}));
const bundleId = createHash('sha256');
for (const { file, pointer } of assets) bundleId.update(`${file}\0${pointer.oid}\0${pointer.size}\n`);
const bundle = bundleId.digest('hex');
if (process.argv.includes('--print-bundle-id')) {
  console.log(bundle);
  process.exit(0);
}
if (process.argv.includes('--print-files')) {
  console.log(assets.map(asset => asset.file).join('\n'));
  process.exit(0);
}
if (process.argv.includes('--pointers-only')) {
  console.log(`Validated ${assets.length} committed Git LFS pointers in bundle ${bundle}.`);
  process.exit(0);
}

if (process.argv.includes('--exact')) {
  const expected = new Set(assets.map(asset => asset.file));
  const fighterRoot = resolve(assetRoot, 'assets/fighters');
  const actual = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else actual.push(relative(assetRoot, path).split(sep).join('/'));
    }
  };
  walk(fighterRoot);
  const unexpected = actual.filter(file => !expected.has(file));
  const missing = [...expected].filter(file => !actual.includes(file));
  if (unexpected.length || missing.length) {
    throw new Error(`Asset bundle is not closed (unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
  }
}

for (const { file, pointer } of assets) {
  const hydrated = resolve(assetRoot, file);
  const prefix = readFileSync(hydrated).subarray(0, POINTER_HEADER.length).toString('utf8');
  if (prefix === POINTER_HEADER) throw new Error(`${file}: asset is still a Git LFS pointer`);
  const actualSize = statSync(hydrated).size;
  if (actualSize !== pointer.size) throw new Error(`${file}: expected ${pointer.size} bytes, found ${actualSize}`);
  const actualOid = await sha256(hydrated);
  if (actualOid !== pointer.oid) throw new Error(`${file}: SHA-256 does not match the committed Git LFS pointer`);
}

console.log(`Verified ${assets.length} hydrated Git LFS assets against committed SHA-256 pointers.`);
