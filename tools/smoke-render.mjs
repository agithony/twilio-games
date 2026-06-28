// Headless render smoke for the racer. Drives a real Chrome (puppeteer-core + system Chrome,
// SwiftShader/ANGLE for WebGL), starts a race, and asserts:
//   - the start (z=0) and finish (z=RACE_LEN) gantry MODELS load + sit at the track ends
//   - the barrier + every car GLB serve 200 through the real loader path
//   - no console errors / page errors
// Also writes screenshots for eyeballing. This is the renderer's only automated coverage
// (the GL view code has no unit tests), so run it after touching renderer/asset wiring.
//
// Usage (dev servers must be up — npm run dev:server & npm run dev:client):
//   CLIENT_URL=http://localhost:5173 node tools/smoke-render.mjs
//   npm run smoke         (uses CLIENT_URL or the 5173 default)
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173';
const RACE_LEN = 2100;   // TRACK_LEN(700) * LAP_TARGET(3) — keep in sync with shared/constants.ts
const SHOT_DIR = process.env.SHOT_DIR || 'tools/.smoke';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swapchain', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const consoleErrors = [], pageErrors = [], glb = new Map();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('response', (r) => { if (r.url().endsWith('.glb')) glb.set(r.url().split('/').pop(), r.status()); });

await page.goto(`${CLIENT}/play.html?display=1&room=SMOKE`, { waitUntil: 'networkidle2', timeout: 30000 });
await wait(3500);                       // Draco decode + GLTF parse
await page.keyboard.press('Enter');     // start the race
await wait(5000);
await fs_mkdir(SHOT_DIR);
await page.screenshot({ path: `${SHOT_DIR}/start.png` });
await wait(6000);
await page.screenshot({ path: `${SHOT_DIR}/mid.png` });

const lines = await page.evaluate(() => {
  const r = window.__renderer;
  if (!r || !r.getScene) return { error: 'no __renderer (is this a dev/localhost build?)' };
  const scene = r.getScene(); scene.updateMatrixWorld(true);
  const round = (n) => Math.round(n * 10) / 10;
  const wrappers = [];
  scene.traverse((o) => {
    if (o.userData && o.userData.lineZ !== undefined) {
      const e = o.matrixWorld.elements;
      wrappers.push({ lineZ: o.userData.lineZ, fallback: !!o.userData.fallback,
        worldZ: round(e[14]), visible: o.visible });
    }
  });
  return { wrappers };
});

const want = ['starting_line.glb', 'finish_line.glb', 'danger_barrier_proops.glb'];
const glbMissing = want.filter((w) => glb.get(w) !== 200);
const start = lines.wrappers?.find((w) => w.lineZ === 0 && !w.fallback);
const finish = lines.wrappers?.find((w) => w.lineZ === RACE_LEN && !w.fallback);

console.log('\n=== gantry models ===');
console.log(JSON.stringify(lines, null, 2));
console.log('\n=== key GLBs ===');
for (const w of want) console.log(`  ${w}: ${glb.get(w) ?? 'NOT REQUESTED'}`);
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : '(none)');
console.log('page errors:', pageErrors.length ? pageErrors : '(none)');

const ok = glbMissing.length === 0 && pageErrors.length === 0
  && !!start && Math.abs(start.worldZ) < 1 && start.visible
  && !!finish && Math.abs(finish.worldZ - RACE_LEN) < 1 && finish.visible;
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) {
  if (glbMissing.length) console.log('  missing/failed GLBs:', glbMissing.join(', '));
  if (!start) console.log('  start gantry model not found at z=0');
  if (!finish) console.log('  finish gantry model not found at z=RACE_LEN');
}
await browser.close();
process.exit(ok ? 0 : 1);

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fs_mkdir(d) { const { mkdir } = await import('node:fs/promises'); await mkdir(d, { recursive: true }); }
