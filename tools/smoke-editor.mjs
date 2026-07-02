// Headless smoke for the LEVEL EDITOR (/editor). Confirms the editor preview now shows the
// start (z=0) and finish (z=RACE_LEN) gantry MODELS — same parity check as smoke-render.mjs.
// Requires dev servers up. Usage:
//   CLIENT_URL=http://localhost:5173 node tools/smoke-editor.mjs
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173';
const RACE_LEN = 2100;
const SHOT_DIR = process.env.SHOT_DIR || 'tools/.smoke';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swapchain', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const consoleErrors = [], pageErrors = [], glb = new Map();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('response', (r) => { if (r.url().endsWith('.glb')) glb.set(r.url().split('/').pop(), r.status()); });

// /editor is now a multi-game hub (picker); the racer level editor is at ?game=racer.
await page.goto(`${CLIENT}/editor/index.html?game=racer`, { waitUntil: 'networkidle2', timeout: 30000 });
// Wait for the scene tree to actually populate (map + gantry GLB load + Draco decode) instead of a
// fixed sleep — the big map GLB can take >5s under SwiftShader, which flaked the old fixed wait.
await page.waitForFunction(
  () => [...document.querySelectorAll('#tree .row')].some((d) => /Start line/.test(d.textContent)),
  { timeout: 25000 },
).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));   // settle a frame after the tree appears
await (await import('node:fs/promises')).mkdir(SHOT_DIR, { recursive: true });
await page.screenshot({ path: `${SHOT_DIR}/editor.png` });

const lines = await page.evaluate(() => {
  const s = window.__levelScene;
  if (!s || !s.getScene) return { error: 'no __levelScene' };
  const scene = s.getScene(); scene.updateMatrixWorld(true);
  const round = (n) => Math.round(n * 10) / 10;
  const wrappers = [];
  scene.traverse((o) => {
    if (o.userData && o.userData.lineZ !== undefined) {
      const e = o.matrixWorld.elements;
      wrappers.push({ lineZ: o.userData.lineZ, worldZ: round(e[14]), visible: o.visible, childCount: o.children.length });
    }
  });
  return { wrappers };
});

// Confirm the scene TREE (left panel) lists the gantry rows and they select.
const tree = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree .row')].map((d) => d.textContent.trim());
  // click the "Start line" row, then read what the scene reports as selected
  const startRow = [...document.querySelectorAll('#tree .row')].find((d) => /Start line/.test(d.textContent));
  startRow?.click();
  const selectedAfterStartClick = window.__levelScene?.selectedKey?.();
  return { rows, hasStart: !!startRow, selectedAfterStartClick };
});

console.log('\n=== left-panel scene tree rows ===');
console.log(JSON.stringify(tree, null, 2));
console.log('\n=== editor gantry wrappers ===');
console.log(JSON.stringify(lines, null, 2));
console.log('\nstarting_line.glb:', glb.get('starting_line.glb') ?? 'NOT REQUESTED');
console.log('finish_line.glb:', glb.get('finish_line.glb') ?? 'NOT REQUESTED');
console.log('console errors:', consoleErrors.length ? consoleErrors : '(none)');
console.log('page errors:', pageErrors.length ? pageErrors : '(none)');

await page.screenshot({ path: `${SHOT_DIR}/editor-start-selected.png` });

const start = lines.wrappers?.find((w) => w.lineZ === 0);
const finish = lines.wrappers?.find((w) => w.lineZ === RACE_LEN);
const treeHasBoth = tree.rows?.some((r) => /Start line/.test(r)) && tree.rows?.some((r) => /Finish line/.test(r));
const ok = !!start && start.visible && start.childCount > 0
  && !!finish && finish.visible && finish.childCount > 0
  && glb.get('starting_line.glb') === 200 && glb.get('finish_line.glb') === 200
  && treeHasBoth && tree.selectedAfterStartClick === 'startLine'
  && pageErrors.length === 0;
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) {
  if (!treeHasBoth) console.log('  tree missing Start/Finish line rows');
  if (tree.selectedAfterStartClick !== 'startLine') console.log('  clicking Start line did not select startLine, got:', tree.selectedAfterStartClick);
}
await browser.close();
process.exit(ok ? 0 : 1);
