// Headless render-capture for auditing car models in the REAL garage pipeline.
// Drives /garage (puppeteer-core + system Chrome, SwiftShader), selects each requested car by its
// dropdown index, waits for load, then captures:
//   - a screenshot (tools/.smoke/cars/<file>.png)
//   - structured metrics: glb status, post-fit bbox, wheel count, mesh count, leftover big-mesh
//     footprints (embedded-environment signal), material audit (white-no-map = spec-gloss symptom),
//     and a framebuffer sample (fraction of non-background pixels + mean color = blank/all-white).
// Writes a JSON report to tools/.smoke/cars/report.json and prints it.
//
// Usage: CARS="aston_martin_valkyrie.glb,cicada_-_retro_cartoon_car.glb" node tools/capture-cars.mjs
//        (no CARS => audits every car in the manifest)
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173';
const SHOT_DIR = process.env.SHOT_DIR || 'tools/.smoke/cars';
const wantFiles = (process.env.CARS || '').split(',').map(s => s.trim()).filter(Boolean);

const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swapchain', '--window-size=1100,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 800 });
const consoleErrors = [], glb = new Map();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('response', (r) => { if (r.url().endsWith('.glb')) glb.set(r.url().split('/').pop(), r.status()); });

await page.goto(`${CLIENT}/garage/`, { waitUntil: 'networkidle2', timeout: 30000 });
await wait(2500);

// Read the dropdown: option value=index, text="Car N: name". Map each entry to its car FILE via __garage.
const entries = await page.evaluate(() => {
  const sel = document.getElementById('model');
  return [...sel.options].map(o => ({ idx: Number(o.value), label: o.textContent }));
});

// Build index→file by walking entries and reading the file dropdown after selecting each. Simpler:
// the garage 'file' select shows the current ref.file. We'll capture file per selection below.
const targets = entries; // audit all dropdown entries (cars + barrier + boost)

// turn turntable OFF for consistent orientation shots
await page.evaluate(() => { const b = document.getElementById('turntable'); if (b && /on/i.test(b.textContent)) b.click(); });

const report = [];
for (const t of targets) {
  await page.evaluate((i) => {
    const sel = document.getElementById('model');
    sel.value = String(i);
    sel.dispatchEvent(new Event('change'));
  }, t.idx);
  // wait for load: status text settles to "N clips..." or "load failed"/"no model"
  await page.waitForFunction(() => {
    const s = document.getElementById('status')?.textContent || '';
    return /clip|load failed|no model/i.test(s);
  }, { timeout: 20000 }).catch(() => {});
  await wait(900); // settle a frame for framebuffer sample

  const m = await page.evaluate(() => {
    const g = window.__garage; const cur = g?.current;
    const file = document.getElementById('file')?.value || null;
    const status = document.getElementById('status')?.textContent || '';
    if (!cur || !cur.model) return { file, status, loaded: false };
    const THREE = window.THREE || null;
    // bbox via the model's own geometry (three is bundled; use cur.model.traverse + manual bounds)
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const meshFoot = []; const mats = [];
    cur.model.updateMatrixWorld(true);
    cur.model.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox?.();
      const bb = o.geometry.boundingBox; if (!bb) return;
      // world-space corners
      const pts = [[bb.min.x,bb.min.y,bb.min.z],[bb.max.x,bb.max.y,bb.max.z],
                   [bb.min.x,bb.min.y,bb.max.z],[bb.max.x,bb.max.y,bb.min.z],
                   [bb.min.x,bb.max.y,bb.min.z],[bb.max.x,bb.min.y,bb.max.z]];
      let lmin=[Infinity,Infinity,Infinity], lmax=[-Infinity,-Infinity,-Infinity];
      for (const p of pts) {
        const v = new o.matrixWorld.constructor ? null : null;
      }
      // use object3D world bbox via setFromObject-like manual transform of geom bbox corners
      const e = o.matrixWorld.elements;
      const tf = (x,y,z)=>[e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]];
      const corners = [[bb.min.x,bb.min.y,bb.min.z],[bb.max.x,bb.max.y,bb.max.z],[bb.min.x,bb.max.y,bb.max.z],
        [bb.max.x,bb.min.y,bb.min.z],[bb.min.x,bb.min.y,bb.max.z],[bb.max.x,bb.max.y,bb.min.z],
        [bb.min.x,bb.max.y,bb.min.z],[bb.max.x,bb.min.y,bb.max.z]];
      for (const [x,y,z] of corners) { const w = tf(x,y,z);
        for (let k=0;k<3;k++){ min[k]=Math.min(min[k],w[k]); max[k]=Math.max(max[k],w[k]);
          lmin[k]=Math.min(lmin[k],w[k]); lmax[k]=Math.max(lmax[k],w[k]); } }
      meshFoot.push(Math.max(lmax[0]-lmin[0], lmax[2]-lmin[2]));
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of list) { if (!mat) continue;
        const hasMap = !!mat.map; const c = mat.color;
        mats.push({ hasMap, hex: c ? '#'+c.getHexString() : null,
          metal: mat.metalness, rough: mat.roughness, type: mat.type }); }
    });
    const size = [max[0]-min[0], max[1]-min[1], max[2]-min[2]].map(n => Number.isFinite(n)?+n.toFixed(2):0);
    meshFoot.sort((a,b)=>a-b); const medFoot = meshFoot.length?meshFoot[Math.floor(meshFoot.length/2)]:0;
    const bigMeshes = meshFoot.filter(f => medFoot>0 && f >= medFoot*6).length;
    const whiteNoMap = mats.filter(x => !x.hasMap && (x.hex==='ffffff' || x.hex==='#ffffff')).length;
    const withMap = mats.filter(x => x.hasMap).length;
    return { file, status, loaded: true, size, wheels: cur.wheels?.length ?? 0,
      meshes: meshFoot.length, materials: mats.length, withMap, whiteNoMap,
      maxFoot: +(meshFoot[meshFoot.length-1]||0).toFixed(2), medFoot: +medFoot.toFixed(2), bigMeshes,
      clips: cur.clips?.length ?? 0 };
  });

  // framebuffer sample: fraction of non-bg pixels + mean color of the model region
  const px = await page.evaluate(() => {
    const cv = document.querySelector('canvas'); if (!cv) return null;
    const t = document.createElement('canvas'); t.width=180; t.height=130;
    const ctx = t.getContext('2d'); ctx.drawImage(cv,0,0,t.width,t.height);
    const d = ctx.getImageData(0,0,t.width,t.height).data;
    // bg is ~ (11,16,32). Count pixels clearly different from bg.
    let nonbg=0, r=0,g=0,b=0, n=0;
    for (let i=0;i<d.length;i+=4){ const dr=d[i]-11,dg=d[i+1]-16,db=d[i+2]-32;
      if (dr*dr+dg*dg+db*db > 1600){ nonbg++; r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; } }
    const tot=d.length/4;
    return { nonbgFrac:+(nonbg/tot).toFixed(3), meanColor: n? [Math.round(r/n),Math.round(g/n),Math.round(b/n)]:null };
  });

  const safe = (m.file || `entry${t.idx}`).replace(/[^a-z0-9._-]/gi,'_');
  await page.screenshot({ path: `${SHOT_DIR}/${safe}.png` });
  report.push({ label: t.label, ...m, glbStatus: m.file ? (glb.get(m.file) ?? null) : null, pixels: px, shot: `${SHOT_DIR}/${safe}.png` });
  console.log(`captured ${t.label}  size=${JSON.stringify(m.size)} wheels=${m.wheels} meshes=${m.meshes} bigMeshes=${m.bigMeshes} whiteNoMap=${m.whiteNoMap} nonbg=${px?.nonbgFrac}`);
}

await writeFile(`${SHOT_DIR}/report.json`, JSON.stringify({ consoleErrors, cars: report }, null, 2));
console.log(`\nconsole errors: ${consoleErrors.length ? consoleErrors.slice(0,5).join(' | ') : '(none)'}`);
console.log(`report: ${SHOT_DIR}/report.json`);
await browser.close();

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
