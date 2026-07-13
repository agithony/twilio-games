// Compress organized Racer GLBs in place (Draco geometry + WebP textures + 1024 resize).
// Raw originals are preserved beside each role directory in _raw/ (gitignored).
import { readdir, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const DIRS = ['assets/racer/cars', 'assets/racer/track'];

async function main() {
  for (const dir of DIRS) {
    const rawDir = join(dir, '_raw'); await mkdir(rawDir, { recursive: true });
    const files = (await readdir(dir)).filter(f => f.toLowerCase().endsWith('.glb'));
    for (const file of files) {
    const src = join(dir, file);
    const raw = join(rawDir, file);
    // skip if already optimized (raw backup exists)
    try { await stat(raw); console.log(`skip (already optimized): ${file}`); continue; } catch {}
    const before = (await stat(src)).size;
    await rename(src, raw);  // move original out of the way
    try {
      await run('npx', ['--yes', '@gltf-transform/cli', 'optimize', raw, src,
        '--compress', 'draco', '--texture-compress', 'webp', '--texture-size', '1024']);
      const after = (await stat(src)).size;
      console.log(`${file}: ${(before/1048576).toFixed(1)}MB → ${(after/1048576).toFixed(1)}MB`);
    } catch (e) {
      await rename(raw, src);  // restore original on failure
      console.error(`FAILED ${file}: ${(e as Error).message}`);
    }
    }
  }
}
main();
