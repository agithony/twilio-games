# Asset Pipeline + Model Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the game's primitive box/cylinder placeholders with the user's real Sketchfab GLB models, via a manifest-driven asset pipeline (CLI inspector + auto-fit loader + primitive fallback) and an interactive `/editor` to arrange and tune each model.

**Architecture:** A JSON manifest is the single source of truth mapping GLB files → game roles with per-model transform overrides. Raw Sketchfab GLBs are first **compressed** via the `@gltf-transform` CLI (Draco geometry + WebP textures + resize) — verified 69MB→~3MB on real models — so they're small enough to commit to git and fast to load. A CLI inspector reads GLBs **headlessly** with `@gltf-transform/core` (pure JS, no GL context) to report sizes + animation/wheel info and generate a starter manifest. The browser loads compressed GLBs with three.js `GLTFLoader` + `DRACOLoader`, auto-fits them, and animates them via (1) the model's built-in glTF animation clip if present, else (2) named wheel-node spin, else (3) whole-car motion — **falling back to the existing primitive on any failure**. The Node HTTP server owns all file I/O (serves the GLBs and a GET/POST manifest API); Vite bundles the editor page.

**Tech Stack:** Node 20+, TypeScript 5+ strict, three.js (`GLTFLoader` + `DRACOLoader`, browser), `@gltf-transform/core` (headless GLB inspection + fixture authoring) + `@gltf-transform/cli` (compression), Vitest, the existing `ws`/`http` server.

**Real models in `assets/` (19 CC-BY, already supplied; raw totals ~590MB pre-compression):** bronco_car_animation_red, drunk_monster_truck, lotus_elise, jurassic_park_1930_-_park_rover, impala_1964_lowrider, dirty_car_061220, batmobile-the_dark_knight_tumbler, forklift, pig_farm_car_trailer, monowheel_bot__vgdc, buggy__free_3d, climber, squadra_corse_lamborghini_huracan_-_sdc, 1955_american_sedan_packard_based_free, car, mazda_rx-7_car, hover_car, 18_mclaren_senna_crxw_widebody_kit_animated, animated_chevrolet_c8_model. (Quarantined in `assets/_quarantine_noncommercial/`, excluded for license reasons: the CC-BY-**NC** jeep, and vehicle_blue_train_bentley which arrived with **no attribution/license** — verify before any use.)

**Inspection of the real models (verified — these facts drive the design):**
- **ALL 19 have ≥1 baked animation clip.** The animation-first priority (clip > wheel-spin > static) is correct for every model, not just some. Many also have wheel-named nodes, but the clip typically drives them — play the clip.
- **Scale variance is ~2000×** (Lotus ≈ 5146 units = modeled in mm; Mclaren ≈ 2.5 units). Auto-fit normalization is MANDATORY, not optional.
- **Orientation varies** — longest axis is Z for some, X/Y for others; per-model rotation overrides + the editor matter.
- **`drunk_monster_truck.glb` needs `KHR_materials_specular`** — a Node-reader-only warning (the inspector should tolerate/skip it); the browser GLTFLoader handles it fine.

## Global Constraints

- **Runtime:** Node ≥ 20, TypeScript ≥ 5 strict, ES modules (`"type":"module"`).
- **Format:** GLB only (single-file binary glTF). No FBX/OBJ/USDZ.
- **Manifest is the single source of truth.** Inspector generates it, editor writes it, loader reads it. Shape:
  - `AssetRef = { file: string; scale?: number; rotation?: [number,number,number]; offset?: [number,number,number] }`
  - `Manifest = { cars: AssetRef[]; barrier: AssetRef | null; boostPad: AssetRef | null; props: AssetRef[] }`
- **Primitive fallback is mandatory and unbreakable.** Any missing/corrupt/unmapped role renders the existing primitive (today's renderer code). A bad manifest never crashes the game — it logs and falls back per-role.
- **Auto-fit then overrides.** Each model is scaled to a role target box and centered on its base; manifest overrides (scale/rotation/offset) apply on top and always win.
- **Animation priority (verified against real models):** (1) if the GLB has a built-in animation clip, play it (`THREE.AnimationMixer`); else (2) if it has nodes matching `/wheel|tire|rim/i`, spin those; else (3) subtle whole-car motion. Real Sketchfab cars often animate via a baked clip with NO wheel-named nodes — the clip path must come first.
- **Compression recipe (proven on real files):** `gltf-transform optimize <in> <out> --compress draco --texture-compress webp --texture-size 1024`. Textures dominate file size, so WebP+resize does the heavy lifting (69MB→~3MB); Draco compresses geometry. Browsers load WebP natively; Draco needs `DRACOLoader` wired in the browser. `--texture-size 1024` is the default; `512` for very large/secondary models, `2048` only if a hero model looks soft.
- **Headless GLB reading uses `@gltf-transform/core` only** (no GL context in Node). Browser rendering uses three.js `GLTFLoader` + `DRACOLoader`. Never import three.js loaders into Node tools/tests. Note: `@gltf-transform/core`'s NodeIO needs `@gltf-transform/extensions` + a Draco decoder to *re-read* compressed files in Node — so the inspector runs on the **pre-compression** originals (or registers extensions); the browser handles compressed files at runtime via DRACOLoader.
- **No new game logic.** The simulation (`shared/race-world.ts`) and server authority are untouched; this is purely how meshes are produced on the client.
- **Asset roles target sizes:** car target ≈ 4.0 (longest dim, world units), barrier ≈ lane width (`TRACK_W/LANES`), boost pad ≈ 2.6 diameter.
- **DRY, YAGNI, TDD, frequent commits.**

---

## File Structure

```
assets/
  manifest.json          single source of truth (created by inspector, edited by editor)
  *.glb                  user's Sketchfab models (user-supplied)
  CREDITS.md             attributions / licenses
  fixtures/              committed test GLBs (tiny, authored in Task 1)
    box.glb              a 1×1×1 box (no wheels)
    car4wheel.glb        a body + 4 named wheel nodes

shared/
  asset-manifest.ts      Manifest/AssetRef types + parse/validate/mergeOverrides (pure)
  asset-fit.ts           autoFitScale(), isWheelNode(), applyTransform math (pure)

tools/
  glb-read.ts            headless GLB read via @gltf-transform: nodes + bounds (Node-only)
  inspect-assets.ts      CLI: scan assets/, report dims + wheels, write starter manifest
  make-fixtures.ts       authors assets/fixtures/*.glb via @gltf-transform (run once)

client/
  asset-loader.ts        three.js GLTFLoader wrapper: load+cache+auto-fit+wheel-detect+fallback
  car-factory.ts         build a renderable car group from a loaded asset (or primitive)
  renderer.ts   (MOD)    consume loaded assets instead of inline primitives
  editor/
    editor.html          /editor page shell
    editor-main.ts       scene mirror + select + TransformControls + numeric fields + save
    manifest-client.ts   fetch GET/POST manifest from the Node server

server/
  manifest-store.ts      read/write assets/manifest.json on disk (pure-ish, injectable path)
  http-server.ts (MOD)   serve GET /assets/*, GET/POST /api/manifest (+ CORS for dev)

tests/
  asset-manifest.test.ts
  asset-fit.test.ts
  glb-read.test.ts          (against fixtures/box.glb + car4wheel.glb)
  inspect-assets.test.ts
  manifest-store.test.ts
  manifest-api.test.ts      (integration: POST then GET round-trip over http)
```

**Decomposition rationale:** all pure logic (manifest validate, auto-fit math, wheel-name
matching) lives in `shared/` and is fully unit-testable offline. The one external risk
(headless GLB decode) is isolated in `tools/glb-read.ts` and proven in Task 1. GL-dependent
code (`asset-loader.ts`, `renderer.ts`, `editor/`) is verified by build+typecheck+manual,
never unit-tested. File I/O is isolated in `server/manifest-store.ts` so the API is testable.

---

### Task 1: Headless GLB read + committed fixtures (the de-risk spike)

Prove we can read GLB structure (node names + bounding box) in Node with no GL context,
using `@gltf-transform/core`. Author two tiny committed fixture GLBs so every later task
has real GLB inputs to test against. **This is the riskiest unknown — do it first.**

**Files:**
- Create: `tools/glb-read.ts`, `tools/make-fixtures.ts`
- Create (generated, committed): `assets/fixtures/box.glb`, `assets/fixtures/car4wheel.glb`
- Test: `tests/glb-read.test.ts`
- Modify: `package.json` (add dep + scripts)

**Interfaces:**
- Produces: `readGlb(path: string): Promise<{ nodeNames: string[]; size: [number,number,number]; animationNames: string[] }>`
  where `size` is the world-space bounding-box dimensions (x,y,z) of all meshes, and
  `animationNames` lists any baked glTF animation clips (real Sketchfab cars often animate
  via a clip rather than wheel nodes).

- [ ] **Step 1: Install `@gltf-transform/core`**

Run: `npm install @gltf-transform/core`
Expected: added to dependencies.

- [ ] **Step 2: Write `tools/make-fixtures.ts`** (authors test GLBs with @gltf-transform)

```ts
// Authors two tiny GLB fixtures used by tests. Run once: `npx tsx tools/make-fixtures.ts`.
import { Document, NodeIO } from '@gltf-transform/core';
import { mkdirSync } from 'node:fs';

function boxPositions(sx: number, sy: number, sz: number): Float32Array {
  const x = sx/2, y = sy/2, z = sz/2;
  // 12 triangles (36 verts) of an axis-aligned box centered at origin
  const v = [
    [-x,-y,-z],[ x,-y,-z],[ x, y,-z],[-x, y,-z], // back
    [-x,-y, z],[ x,-y, z],[ x, y, z],[-x, y, z], // front
  ];
  const faces = [[0,1,2,0,2,3],[4,6,5,4,7,6],[0,4,5,0,5,1],[3,2,6,3,6,7],[1,5,6,1,6,2],[0,3,7,0,7,4]];
  const out: number[] = [];
  for (const f of faces) for (const i of f) out.push(...v[i]!);
  return new Float32Array(out);
}

async function makeBox(path: string, name: string, sx: number, sy: number, sz: number, childNames: string[] = []) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const mk = (nm: string, dims: [number,number,number], tx = 0) => {
    const arr = boxPositions(...dims);
    const pos = doc.createAccessor().setType('VEC3').setArray(arr).setBuffer(buffer);
    // glTF requires POSITION accessors to declare min/max; the headless reader uses them.
    const [hx, hy, hz] = [dims[0]/2, dims[1]/2, dims[2]/2];
    pos.setMin([-hx, -hy, -hz]); pos.setMax([hx, hy, hz]);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos);
    const mesh = doc.createMesh(nm + '_mesh').addPrimitive(prim);
    const node = doc.createNode(nm).setMesh(mesh).setTranslation([tx, 0, 0]);
    return node;
  };
  if (childNames.length === 0) {
    scene.addChild(mk(name, [sx, sy, sz]));
  } else {
    const root = doc.createNode(name);
    root.addChild(mk(name + '_body', [sx, sy, sz]));
    childNames.forEach((cn, i) => root.addChild(mk(cn, [0.4,0.4,0.4], -1.5 + i)));
    scene.addChild(root);
  }
  mkdirSync('assets/fixtures', { recursive: true });
  await new NodeIO().write(path, doc);
  console.log('wrote', path);
}

await makeBox('assets/fixtures/box.glb', 'Box', 1, 1, 1);
await makeBox('assets/fixtures/car4wheel.glb', 'Car', 2, 0.8, 4,
  ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']);
```

- [ ] **Step 3: Generate the fixtures**

Run: `npx tsx tools/make-fixtures.ts`
Expected: prints `wrote assets/fixtures/box.glb` and `wrote assets/fixtures/car4wheel.glb`; both files exist.

- [ ] **Step 4: Write the failing test** — `tests/glb-read.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readGlb } from '../tools/glb-read';

describe('readGlb', () => {
  it('reads a plain box: one node, ~1×1×1', async () => {
    const r = await readGlb('assets/fixtures/box.glb');
    expect(r.nodeNames).toContain('Box');
    expect(r.size[0]).toBeCloseTo(1, 1);
    expect(r.size[1]).toBeCloseTo(1, 1);
    expect(r.size[2]).toBeCloseTo(1, 1);
  });
  it('reads a car with four named wheel nodes', async () => {
    const r = await readGlb('assets/fixtures/car4wheel.glb');
    const wheels = r.nodeNames.filter(n => /wheel/i.test(n));
    expect(wheels).toHaveLength(4);
    expect(r.size[2]).toBeGreaterThan(r.size[0]); // longer than wide (z is length)
  });
  it('reports animationNames (empty for the static fixtures)', async () => {
    const r = await readGlb('assets/fixtures/box.glb');
    expect(Array.isArray(r.animationNames)).toBe(true);
    expect(r.animationNames).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test -- glb-read`
Expected: FAIL — cannot find module `../tools/glb-read`.

- [ ] **Step 6: Implement `tools/glb-read.ts`**

```ts
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

/** Read GLB structure headlessly (no GL context): node names + bbox size + animation clip names.
 *  Registers ALL_EXTENSIONS so real-world models (e.g. KHR_materials_specular, EXT_texture_webp)
 *  don't fail the read. Compressed (Draco) files additionally need a decoder; the inspector runs
 *  on PRE-compression originals, so plain ALL_EXTENSIONS registration is sufficient here. */
export async function readGlb(path: string): Promise<{ nodeNames: string[]; size: [number,number,number]; animationNames: string[] }> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(path);
  const root = doc.getRoot();
  const nodeNames = root.listNodes().map(n => n.getName()).filter(Boolean);
  const animationNames = root.listAnimations().map(a => a.getName()).filter(Boolean);
  // accumulate world-space bounds across every mesh primitive POSITION accessor
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const t = node.getWorldTranslation();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const a = pos.getMin([] as number[]) ?? [0,0,0];
      const b = pos.getMax([] as number[]) ?? [0,0,0];
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, (a[i] ?? 0) + (t[i] ?? 0));
        max[i] = Math.max(max[i]!, (b[i] ?? 0) + (t[i] ?? 0));
      }
    }
  }
  const size: [number,number,number] = [
    Number.isFinite(max[0]! - min[0]!) ? max[0]! - min[0]! : 0,
    Number.isFinite(max[1]! - min[1]!) ? max[1]! - min[1]! : 0,
    Number.isFinite(max[2]! - min[2]!) ? max[2]! - min[2]! : 0,
  ];
  return { nodeNames, size, animationNames };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- glb-read`
Expected: PASS (2 tests). If `getMin`/`getMax` return null for the authored accessors,
fix `make-fixtures.ts` to call `pos.setMin(...)/.setMax(...)` (or compute bounds from the
array) — adjust until the box reports ~1×1×1.

- [ ] **Step 8: Add scripts to `package.json`**

```json
    "make-fixtures": "tsx tools/make-fixtures.ts",
    "inspect-assets": "tsx tools/inspect-assets.ts",
    "optimize-assets": "tsx tools/optimize-assets.ts"
```

- [ ] **Step 9: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add tools/glb-read.ts tools/make-fixtures.ts assets/fixtures/ tests/glb-read.test.ts package.json package-lock.json
git commit -m "feat: headless GLB reader + test fixtures (de-risk spike)"
```

---

### Task 1.5: Compress the real models (one-time tooling + run)

Raw Sketchfab GLBs total ~366MB (some 60-70MB each) — too big to commit and slow to load.
A compression script runs the `@gltf-transform` CLI over `assets/*.glb`, writing optimized
versions (Draco geometry + WebP textures + 1024px resize). **Verified on real files: 69MB→~3MB.**
This produces the GLBs that actually get committed and loaded. The script is mechanical (a
thin wrapper over the CLI); the "test" is running it and confirming size reduction + that the
files still load in the browser (Task 6).

**Files:**
- Create: `tools/optimize-assets.ts`
- Modify: `package.json` (add `@gltf-transform/cli` devDep; `optimize-assets` script already added above)
- Output: optimized `assets/*.glb` (overwrites the raw files in place, after backing up raw to `assets/_raw/`)

**Interfaces:**
- Produces: a CLI run, no exported API. `optimize-assets` reads every top-level `assets/*.glb`,
  moves the raw original to `assets/_raw/<file>` (gitignored), and writes the compressed result
  back to `assets/<file>`.

- [ ] **Step 1: Install the CLI**

Run: `npm install -D @gltf-transform/cli`
Expected: added to devDependencies.

- [ ] **Step 2: Implement `tools/optimize-assets.ts`**

```ts
// Compress every assets/*.glb in place (Draco geometry + WebP textures + 1024 resize).
// Raw originals are preserved in assets/_raw/ (gitignored). Run: npm run optimize-assets
import { readdir, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const DIR = 'assets';
const RAW = join(DIR, '_raw');

async function main() {
  await mkdir(RAW, { recursive: true });
  const files = (await readdir(DIR)).filter(f => f.toLowerCase().endsWith('.glb'));
  if (files.length === 0) { console.log('No .glb files in assets/.'); return; }
  for (const file of files) {
    const src = join(DIR, file);
    const raw = join(RAW, file);
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
main();
```

- [ ] **Step 3: Gitignore the raw originals**

Add to `.gitignore`:
```
assets/_raw/
assets/_quarantine_noncommercial/
```

- [ ] **Step 4: Run the compression**

Run: `npm run optimize-assets`
Expected: each model prints a large reduction (e.g. `bronco_car_animation_red.glb: 69.3MB → ~3MB`).
Total `assets/*.glb` should drop from ~366MB to roughly 30-60MB. If a specific model fails
(e.g. an exotic extension), it's restored to raw and logged — note it; it can stay raw or be
hand-tuned later (the loader still handles uncompressed GLBs).

- [ ] **Step 5: Sanity-check total committed size**

Run: `du -ch assets/*.glb | tail -1`
Expected: a total small enough to commit comfortably (target < 60MB; if still large, re-run
specific models at `--texture-size 512`).

- [ ] **Step 6: Commit the compressed models + CREDITS**

Create `assets/CREDITS.md` listing each used model with its Sketchfab URL, author, and CC-BY
license (the 12 commercial-safe models; note the NC jeep is excluded). Then:
```bash
git add assets/*.glb assets/CREDITS.md tools/optimize-assets.ts package.json package-lock.json .gitignore
git commit -m "chore: compress real GLB models (draco+webp) + asset credits"
```

---

### Task 2: Manifest types + parse/validate (pure)

The typed contract and a tolerant parser: bad JSON / unknown roles / wrong-typed fields
never throw — they yield a valid `Manifest` with the offending parts dropped, so the loader
can always fall back per-role.

**Files:**
- Create: `shared/asset-manifest.ts`
- Test: `tests/asset-manifest.test.ts`

**Interfaces:**
- Produces:
  - `type AssetRef = { file: string; scale?: number; rotation?: [number,number,number]; offset?: [number,number,number] }`
  - `type Manifest = { cars: AssetRef[]; barrier: AssetRef | null; boostPad: AssetRef | null; props: AssetRef[] }`
  - `const EMPTY_MANIFEST: Manifest`
  - `parseManifest(raw: string): Manifest` — never throws; invalid input → `EMPTY_MANIFEST` (or partial)
  - `serializeManifest(m: Manifest): string` — pretty JSON

- [ ] **Step 1: Write the failing test** — `tests/asset-manifest.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseManifest, serializeManifest, EMPTY_MANIFEST } from '../shared/asset-manifest';

describe('parseManifest', () => {
  it('parses a full valid manifest', () => {
    const m = parseManifest(JSON.stringify({
      cars: [{ file: 'a.glb', scale: 1.2, rotation: [0,90,0], offset: [0,0,0] }],
      barrier: { file: 'b.glb' }, boostPad: { file: 'c.glb' },
      props: [{ file: 'tree.glb' }],
    }));
    expect(m.cars[0]!.file).toBe('a.glb');
    expect(m.cars[0]!.scale).toBe(1.2);
    expect(m.barrier!.file).toBe('b.glb');
    expect(m.props).toHaveLength(1);
  });
  it('returns EMPTY_MANIFEST for malformed JSON', () => {
    expect(parseManifest('{not json')).toEqual(EMPTY_MANIFEST);
  });
  it('drops AssetRefs missing a file string', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ scale: 1 }, { file: 'ok.glb' }] }));
    expect(m.cars).toHaveLength(1);
    expect(m.cars[0]!.file).toBe('ok.glb');
  });
  it('coerces missing role arrays/objects to defaults', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ file: 'a.glb' }] }));
    expect(m.barrier).toBeNull();
    expect(m.boostPad).toBeNull();
    expect(m.props).toEqual([]);
  });
  it('ignores bad-typed optional fields (rotation not a triple)', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ file: 'a.glb', rotation: 'nope', scale: 'x' }] }));
    expect(m.cars[0]!.rotation).toBeUndefined();
    expect(m.cars[0]!.scale).toBeUndefined();
  });
  it('round-trips through serialize', () => {
    const m = parseManifest(JSON.stringify({ cars: [{ file: 'a.glb', scale: 2 }], barrier: null, boostPad: null, props: [] }));
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- asset-manifest`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `shared/asset-manifest.ts`**

```ts
export type AssetRef = {
  file: string;
  scale?: number;
  rotation?: [number, number, number];
  offset?: [number, number, number];
};
export type Manifest = {
  cars: AssetRef[];
  barrier: AssetRef | null;
  boostPad: AssetRef | null;
  props: AssetRef[];
};
export const EMPTY_MANIFEST: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };

function triple(v: unknown): [number, number, number] | undefined {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number')
    ? [v[0], v[1], v[2]] : undefined;
}
function ref(v: unknown): AssetRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.file !== 'string' || !o.file) return null;
  const out: AssetRef = { file: o.file };
  if (typeof o.scale === 'number') out.scale = o.scale;
  const r = triple(o.rotation); if (r) out.rotation = r;
  const off = triple(o.offset); if (off) out.offset = off;
  return out;
}
function refArray(v: unknown): AssetRef[] {
  return Array.isArray(v) ? v.map(ref).filter((x): x is AssetRef => x !== null) : [];
}

export function parseManifest(raw: string): Manifest {
  let o: any;
  try { o = JSON.parse(raw); } catch { return { ...EMPTY_MANIFEST }; }
  if (!o || typeof o !== 'object') return { ...EMPTY_MANIFEST };
  return {
    cars: refArray(o.cars),
    barrier: ref(o.barrier),
    boostPad: ref(o.boostPad),
    props: refArray(o.props),
  };
}
export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- asset-manifest`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add shared/asset-manifest.ts tests/asset-manifest.test.ts
git commit -m "feat: asset manifest types + tolerant parser"
```

---

### Task 3: Auto-fit + wheel-detection math (pure)

Pure functions for the normalization logic, unit-tested without any GL/GLB.

**Files:**
- Create: `shared/asset-fit.ts`
- Test: `tests/asset-fit.test.ts`

**Interfaces:**
- Produces:
  - `autoFitScale(size: [number,number,number], targetLongest: number): number` — scale factor so the model's longest dimension equals `targetLongest`; returns 1 for a zero/degenerate size.
  - `isWheelNode(name: string): boolean` — matches `/wheel|tire|rim/i`.
  - `CAR_TARGET = 4.0`, `BARRIER_TARGET = TRACK_W / LANES`, `BOOST_TARGET = 2.6` (exported consts, importing TRACK_W/LANES from constants).

- [ ] **Step 1: Write the failing test** — `tests/asset-fit.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { autoFitScale, isWheelNode, CAR_TARGET } from '../shared/asset-fit';

describe('autoFitScale', () => {
  it('scales the longest dimension to the target', () => {
    // longest dim is 8 (z); target 4 => scale 0.5
    expect(autoFitScale([2, 1, 8], 4)).toBeCloseTo(0.5, 5);
  });
  it('scales tiny models up', () => {
    // longest dim 0.1; target 4 => scale 40
    expect(autoFitScale([0.05, 0.1, 0.02], 4)).toBeCloseTo(40, 5);
  });
  it('returns 1 for a degenerate (zero) size', () => {
    expect(autoFitScale([0, 0, 0], 4)).toBe(1);
  });
  it('CAR_TARGET is 4.0', () => { expect(CAR_TARGET).toBe(4.0); });
});

describe('isWheelNode', () => {
  it('matches wheel/tire/rim case-insensitively', () => {
    for (const n of ['wheel_FL','Wheel.001','front_tire','RIM_2','car_wheel_rear'])
      expect(isWheelNode(n)).toBe(true);
  });
  it('rejects non-wheel names', () => {
    for (const n of ['body','chassis','window','Car','seat'])
      expect(isWheelNode(n)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- asset-fit`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `shared/asset-fit.ts`**

```ts
import { TRACK_W, LANES } from './constants';

export const CAR_TARGET = 4.0;
export const BARRIER_TARGET = TRACK_W / LANES;
export const BOOST_TARGET = 2.6;

/** Scale factor so the model's longest dimension equals targetLongest. 1 if degenerate. */
export function autoFitScale(size: [number, number, number], targetLongest: number): number {
  const longest = Math.max(size[0], size[1], size[2]);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return targetLongest / longest;
}

export function isWheelNode(name: string): boolean {
  return /wheel|tire|rim/i.test(name);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- asset-fit`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add shared/asset-fit.ts tests/asset-fit.test.ts
git commit -m "feat: auto-fit scale + wheel-node detection (pure)"
```

---

### Task 4: CLI asset-inspector

Scans `assets/*.glb`, prints a per-model report (size + detected wheel nodes), and writes
a starter `assets/manifest.json` — heuristically assigning roles (the first cars to `cars`,
etc.) so Claude gets an auto best-shot to refine. The role-assignment heuristic is a pure,
tested function; the CLI wrapper around it is thin.

**Files:**
- Create: `tools/inspect-assets.ts`
- Test: `tests/inspect-assets.test.ts`

**Interfaces:**
- Consumes: `readGlb` (Task 1), `Manifest`/`serializeManifest` (Task 2), `isWheelNode` (Task 3).
- Produces:
  - `type GlbReport = { file: string; size: [number,number,number]; wheelNodes: string[] }`
  - `inspectDir(dir: string, read?: typeof readGlb): Promise<GlbReport[]>` — reports for every `*.glb` (excluding `fixtures/`)
  - `buildStarterManifest(reports: GlbReport[]): Manifest` — heuristic role assignment (pure)
  - `formatReport(reports: GlbReport[]): string` — human-readable table

- [ ] **Step 1: Write the failing test** — `tests/inspect-assets.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildStarterManifest, type GlbReport } from '../tools/inspect-assets';

const reports: GlbReport[] = [
  { file: 'sedan.glb',  size: [2,1.4,4],   wheelNodes: ['wheel_FL','wheel_FR','wheel_RL','wheel_RR'] },
  { file: 'truck.glb',  size: [2.4,2,5],   wheelNodes: ['wheel1','wheel2'] },
  { file: 'cone.glb',   size: [0.6,1,0.6], wheelNodes: [] },
  { file: 'tree.glb',   size: [3,6,3],     wheelNodes: [] },
];

describe('buildStarterManifest', () => {
  it('assigns wheeled models to cars', () => {
    const m = buildStarterManifest(reports);
    const carFiles = m.cars.map(c => c.file);
    expect(carFiles).toContain('sedan.glb');
    expect(carFiles).toContain('truck.glb');
  });
  it('puts non-car models into props (or barrier/boostPad), never cars', () => {
    const m = buildStarterManifest(reports);
    const carFiles = m.cars.map(c => c.file);
    expect(carFiles).not.toContain('tree.glb');
    // everything maps somewhere
    const all = [...m.cars, m.barrier, m.boostPad, ...m.props].filter(Boolean).map(r => (r as any).file);
    expect(all).toContain('tree.glb');
    expect(all).toContain('cone.glb');
  });
  it('produces a valid manifest shape even with no inputs', () => {
    const m = buildStarterManifest([]);
    expect(m).toEqual({ cars: [], barrier: null, boostPad: null, props: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- inspect-assets`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `tools/inspect-assets.ts`**

```ts
import { readdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readGlb } from './glb-read';
import { isWheelNode } from '../shared/asset-fit';
import { serializeManifest, type Manifest } from '../shared/asset-manifest';

export type GlbReport = { file: string; size: [number, number, number]; wheelNodes: string[] };

export async function inspectDir(dir: string, read = readGlb): Promise<GlbReport[]> {
  const entries = await readdir(dir);
  const glbs = entries.filter(f => f.toLowerCase().endsWith('.glb'));
  const reports: GlbReport[] = [];
  for (const file of glbs) {
    try {
      const { nodeNames, size } = await read(join(dir, file));
      reports.push({ file, size, wheelNodes: nodeNames.filter(isWheelNode) });
    } catch (e) {
      reports.push({ file, size: [0,0,0], wheelNodes: [] });
    }
  }
  return reports;
}

/** Heuristic starter roles: wheeled models => cars; the rest spread across barrier/boostPad/props. */
export function buildStarterManifest(reports: GlbReport[]): Manifest {
  const cars = reports.filter(r => r.wheelNodes.length > 0).map(r => ({ file: r.file }));
  const nonCars = reports.filter(r => r.wheelNodes.length === 0);
  const barrier = nonCars[0] ? { file: nonCars[0].file } : null;
  const boostPad = nonCars[1] ? { file: nonCars[1].file } : null;
  const props = nonCars.slice(2).map(r => ({ file: r.file }));
  return { cars, barrier, boostPad, props };
}

export function formatReport(reports: GlbReport[]): string {
  if (reports.length === 0) return 'No .glb files found in assets/.';
  return reports.map(r => {
    const [x,y,z] = r.size.map(n => n.toFixed(2));
    const wheels = r.wheelNodes.length ? `${r.wheelNodes.length} wheels [${r.wheelNodes.join(', ')}]` : 'no wheels';
    return `${r.file.padEnd(28)} size ${x}×${y}×${z}   ${wheels}`;
  }).join('\n');
}

// CLI entry (only when run directly)
const isMain = process.argv[1] && process.argv[1].endsWith('inspect-assets.ts');
if (isMain) {
  const dir = 'assets';
  inspectDir(dir).then(async (reports) => {
    console.log(formatReport(reports));
    const manifest = buildStarterManifest(reports);
    await writeFile(join(dir, 'manifest.json'), serializeManifest(manifest));
    console.log(`\nWrote ${join(dir, 'manifest.json')} (${manifest.cars.length} cars).`);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- inspect-assets`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the CLI runs against the fixtures**

Run: `npx tsx tools/inspect-assets.ts`
Expected: prints a report listing `fixtures/`? No — it scans `assets/` top level only. Since
the fixtures live in `assets/fixtures/` (a subdir), top-level scan finds none unless the user
added GLBs. To confirm the reader path, temporarily copy a fixture: 
`cp assets/fixtures/car4wheel.glb assets/_probe.glb && npx tsx tools/inspect-assets.ts && rm assets/_probe.glb`
Expected: prints `_probe.glb  size 2.00×0.80×4.00  4 wheels [...]` and writes `assets/manifest.json`.

- [ ] **Step 6: Commit**

```bash
git add tools/inspect-assets.ts tests/inspect-assets.test.ts
git commit -m "feat: CLI asset inspector + starter-manifest heuristic"
```

---

### Task 5: Manifest store + HTTP API

Disk read/write of `assets/manifest.json`, and `GET/POST /api/manifest` on the existing
HTTP server so the editor can load and save. The store is isolated for testability; the
route wiring is thin.

**Files:**
- Create: `server/manifest-store.ts`
- Modify: `server/http-server.ts` (add routes; static-serve `assets/`)
- Test: `tests/manifest-store.test.ts`, `tests/manifest-api.test.ts`

**Interfaces:**
- Consumes: `parseManifest`/`serializeManifest`/`Manifest` (Task 2), existing `HttpServer`.
- Produces:
  - `class ManifestStore { constructor(path: string); read(): Promise<Manifest>; write(m: Manifest): Promise<void>; }`
  - HTTP: `GET /api/manifest` → JSON manifest; `POST /api/manifest` (JSON body) → validates via `parseManifest`, writes, returns the stored manifest; `GET /assets/<file>` → serves the GLB/file.

- [ ] **Step 1: Write the failing store test** — `tests/manifest-store.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { ManifestStore } from '../server/manifest-store';
import { unlink } from 'node:fs/promises';

const tmp = 'assets/_test-manifest.json';
afterEach(async () => { try { await unlink(tmp); } catch {} });

describe('ManifestStore', () => {
  it('returns EMPTY_MANIFEST when the file does not exist', async () => {
    const s = new ManifestStore('assets/_does-not-exist.json');
    const m = await s.read();
    expect(m).toEqual({ cars: [], barrier: null, boostPad: null, props: [] });
  });
  it('round-trips a written manifest', async () => {
    const s = new ManifestStore(tmp);
    await s.write({ cars: [{ file: 'a.glb', scale: 2 }], barrier: null, boostPad: null, props: [] });
    const m = await s.read();
    expect(m.cars[0]!.file).toBe('a.glb');
    expect(m.cars[0]!.scale).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- manifest-store`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `server/manifest-store.ts`**

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { parseManifest, serializeManifest, EMPTY_MANIFEST, type Manifest } from '../shared/asset-manifest';

export class ManifestStore {
  constructor(private path: string) {}
  async read(): Promise<Manifest> {
    try { return parseManifest(await readFile(this.path, 'utf8')); }
    catch { return { ...EMPTY_MANIFEST }; }
  }
  async write(m: Manifest): Promise<void> {
    await writeFile(this.path, serializeManifest(m));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- manifest-store`
Expected: PASS.

- [ ] **Step 5: Wire routes into `server/http-server.ts`**

In the constructor, create a store: `private manifestStore = new ManifestStore('assets/manifest.json');`
(import it). In `onRequest`, before the 404, add:

```ts
    // ---- manifest API ----
    if (path === '/api/manifest' && req.method === 'GET') {
      const m = await this.manifestStore.read();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(m));
      return;
    }
    if (path === '/api/manifest' && req.method === 'POST') {
      const body = await readBody(req);
      const m = parseManifest(body);            // tolerant: validates + drops bad parts
      await this.manifestStore.write(m);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(m));
      return;
    }
    // ---- static assets (GLB etc.) ----
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      return this.serveAsset(path, res);
    }
```

Add a `serveAsset` method that safely serves files from `assets/` (guard against `..` path
traversal; set `Content-Type: model/gltf-binary` for `.glb`, `application/json` for `.json`):

```ts
  private async serveAsset(urlPath: string, res: http.ServerResponse): Promise<void> {
    const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ''));
    if (rel.includes('..') || rel.startsWith('/')) { res.writeHead(403).end('forbidden'); return; }
    const full = path.join('assets', rel);
    try {
      const data = await readFile(full);
      const type = rel.endsWith('.glb') ? 'model/gltf-binary'
                 : rel.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    } catch { res.writeHead(404).end('not found'); }
  }
```
(Ensure `path` from `node:path`, `readFile` from `node:fs/promises`, `parseManifest`, and
`ManifestStore` are imported at the top of `http-server.ts`.)

- [ ] **Step 6: Write the failing API integration test** — `tests/manifest-api.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink } from 'node:fs/promises';

let srv: HttpServer;
afterEach(async () => { await srv?.stop(); try { await unlink('assets/manifest.json'); } catch {} });

describe('manifest API', () => {
  it('POST then GET round-trips a manifest', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const payload = { cars: [{ file: 'a.glb', scale: 1.5 }], barrier: null, boostPad: null, props: [] };
    const post = await fetch(`http://127.0.0.1:${port}/api/manifest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(post.status).toBe(200);
    const get = await fetch(`http://127.0.0.1:${port}/api/manifest`);
    const m = await get.json();
    expect(m.cars[0].file).toBe('a.glb');
    expect(m.cars[0].scale).toBe(1.5);
  });
  it('POST with malformed JSON stores an empty manifest (tolerant, no crash)', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const post = await fetch(`http://127.0.0.1:${port}/api/manifest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    expect(post.status).toBe(200);
    const m = await post.json();
    expect(m).toEqual({ cars: [], barrier: null, boostPad: null, props: [] });
  });
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npm test -- manifest-api`
Expected: PASS (2 tests). (`fetch` is global in Node ≥ 20.)

- [ ] **Step 8: Full suite + typecheck + commit**

Run: `npm run typecheck && npm test`
Expected: all pass.
```bash
git add server/manifest-store.ts server/http-server.ts tests/manifest-store.test.ts tests/manifest-api.test.ts
git commit -m "feat: manifest store + GET/POST /api/manifest + static asset serving"
```

---

### Task 6: Asset loader + car factory + renderer integration

Load GLBs in the browser with three.js `GLTFLoader`, apply auto-fit + manifest overrides,
detect wheel nodes, cache, and fall back to the existing primitives on any failure. Rewire
`renderer.ts` to build cars/items from loaded assets. Verified by build + typecheck +
manual run (no unit test — GL/browser only).

**Files:**
- Create: `client/asset-loader.ts`, `client/car-factory.ts`
- Modify: `client/renderer.ts`, `client/main.ts` (await asset load before first render)

**Interfaces:**
- Consumes: `Manifest`/`AssetRef` (Task 2); `autoFitScale`/`isWheelNode`/`CAR_TARGET`/`BARRIER_TARGET`/`BOOST_TARGET` (Task 3).
- Produces:
  - `class AssetLoader { loadManifest(): Promise<void>; carTemplate(index: number): THREE.Group | null; barrierTemplate(): THREE.Group | null; boostTemplate(): THREE.Group | null; }`
    — each `*Template` returns a cloneable normalized group, or `null` to signal "use primitive".
  - `buildCar(template: THREE.Group | null, color: string, isMe: boolean): THREE.Group` (in `car-factory.ts`) — clones the template (tagging `userData.wheels` from wheel-named nodes) or builds the existing primitive; adds the cyan "you" cone if `isMe`.

- [ ] **Step 1: Implement `client/asset-loader.ts`**

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { autoFitScale, isWheelNode, CAR_TARGET, BARRIER_TARGET, BOOST_TARGET } from '../shared/asset-fit';
import type { Manifest, AssetRef } from '../shared/asset-manifest';

const deg = (d: number) => (d * Math.PI) / 180;

export class AssetLoader {
  private loader: GLTFLoader;
  private manifest: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };
  private cars: (THREE.Group | null)[] = [];
  private barrier: THREE.Group | null = null;
  private boost: THREE.Group | null = null;

  constructor() {
    this.loader = new GLTFLoader();
    // Our models are Draco-compressed (Task 1.5). DRACOLoader needs decoder wasm/js;
    // use the three.js CDN-hosted decoder (or vendor it under /assets/draco/ for offline).
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.loader.setDRACOLoader(draco);
  }

  async loadManifest(): Promise<void> {
    try {
      const res = await fetch('/api/manifest');
      this.manifest = await res.json();
    } catch { return; }   // no manifest => everything stays primitive
    this.cars = await Promise.all(this.manifest.cars.map(r => this.loadRef(r, CAR_TARGET)));
    this.barrier = this.manifest.barrier ? await this.loadRef(this.manifest.barrier, BARRIER_TARGET) : null;
    this.boost   = this.manifest.boostPad ? await this.loadRef(this.manifest.boostPad, BOOST_TARGET) : null;
  }

  private loadRef(ref: AssetRef, target: number): Promise<THREE.Group | null> {
    return new Promise((resolve) => {
      this.loader.load(`/assets/${ref.file}`, (gltf) => {
        try {
          const g = this.normalize(gltf.scene, ref, target);
          // Preserve any baked animation clips on the template for the factory/renderer.
          // (Real Sketchfab cars often animate via a clip, not wheel nodes — see Global Constraints.)
          g.userData.clips = gltf.animations ?? [];
          resolve(g);
        }
        catch { resolve(null); }
      }, undefined, () => resolve(null));   // load error => null => primitive fallback
    });
  }

  private normalize(scene: THREE.Group, ref: AssetRef, target: number): THREE.Group {
    const g = scene;
    // measure, auto-fit to target longest dimension
    const box = new THREE.Box3().setFromObject(g);
    const size = new THREE.Vector3(); box.getSize(size);
    const fit = autoFitScale([size.x, size.y, size.z], target);
    const s = fit * (ref.scale ?? 1);
    g.scale.setScalar(s);
    // recompute box after scaling; sit the model on y=0 and center x/z, then apply offset
    const box2 = new THREE.Box3().setFromObject(g);
    const c = new THREE.Vector3(); box2.getCenter(c);
    const min = box2.min;
    g.position.x += -c.x + (ref.offset?.[0] ?? 0);
    g.position.y += -min.y + (ref.offset?.[1] ?? 0);
    g.position.z += -c.z + (ref.offset?.[2] ?? 0);
    if (ref.rotation) g.rotation.set(deg(ref.rotation[0]), deg(ref.rotation[1]), deg(ref.rotation[2]));
    // tag wheel meshes for spin animation
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => { if (isWheelNode(o.name)) wheels.push(o); });
    g.userData.wheels = wheels;
    g.castShadow = true; g.traverse(o => { (o as THREE.Mesh).castShadow = true; });
    return g;
  }

  carTemplate(i: number): THREE.Group | null { return this.cars.length ? this.cars[i % this.cars.length] ?? null : null; }
  barrierTemplate(): THREE.Group | null { return this.barrier; }
  boostTemplate(): THREE.Group | null { return this.boost; }
}
```

- [ ] **Step 2: Implement `client/car-factory.ts`**

```ts
import * as THREE from 'three';

/** Build a car group: clone the GLB template if present (preserving wheel tags), else the primitive. */
export function buildCar(template: THREE.Group | null, color: string, isMe: boolean): THREE.Group {
  let g: THREE.Group;
  if (template) {
    g = template.clone(true);
    // re-collect wheels on the clone by matching the template's wheel names
    const wheelNames = new Set((template.userData.wheels as THREE.Object3D[] ?? []).map(w => w.name));
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => { if (wheelNames.has(o.name)) wheels.push(o); });
    g.userData.wheels = wheels;
    // If the model has a baked animation clip, set up a mixer to play it (preferred over wheel-spin).
    const clips = (template.userData.clips as THREE.AnimationClip[]) ?? [];
    if (clips.length > 0) {
      const mixer = new THREE.AnimationMixer(g);
      mixer.clipAction(clips[0]!).play();
      g.userData.mixer = mixer;   // renderer advances it each frame: mixer.update(dt)
    }
  } else {
    g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.7, 3.4),
      new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.4 }));
    body.position.y = 0.75; g.add(body);
    const wheels: THREE.Object3D[] = [];
    for (const [x, z] of [[-1.05,-1.1],[1.05,-1.1],[-1.05,1.1],[1.05,1.1]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16),
        new THREE.MeshStandardMaterial({ color: 0x0a0d16 }));
      w.rotation.z = Math.PI / 2; w.position.set(x!, 0.5, z!); g.add(w); wheels.push(w);
    }
    g.userData.wheels = wheels;
  }
  if (isMe) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 4),
      new THREE.MeshBasicMaterial({ color: 0x36d1dc }));
    cone.rotation.x = Math.PI; cone.position.y = 4; g.add(cone);
  }
  return g;
}
```

- [ ] **Step 3: Rewire `client/renderer.ts`** to use the loader + factory

Change the constructor to accept an optional `AssetLoader`: `constructor(mount: HTMLElement, private assets?: AssetLoader)`.
Replace `ensureCar`'s primitive-building body with `buildCar(this.assets?.carTemplate(carIndex) ?? null, color, id === this.myId)`
(track a per-id car index so each player deterministically gets a template). In `buildItems`,
replace the barrier/boost primitive creation with: if `this.assets?.barrierTemplate()` exists,
clone it for barriers; else the existing red box. Same for boost pads (clone `boostTemplate()`
else the green cylinder). Keep all positions/rotations/lane math identical.

**Per-frame animation (priority order, from Global Constraints):** the render loop receives
`dt`. For each car group: (1) if `g.userData.mixer` exists, call `g.userData.mixer.update(dt)`
to advance the model's baked clip; (2) else if `g.userData.wheels?.length`, spin them
(`w.rotation.x += speed * dt * k`); (3) else leave static (or a subtle bob). Keep the existing
camera + "you" marker behavior. Note the render loop must now have `dt` available — track
`performance.now()` between frames if it doesn't already.

- [ ] **Step 4: Load assets before first render in `client/main.ts`**

```ts
import { AssetLoader } from './asset-loader';
// ...
const assets = new AssetLoader();
const renderer = new Renderer(document.getElementById('app')!, assets);
await assets.loadManifest();   // top-level await is fine in an ES module; primitives if it fails
```
(If top-level await is awkward in the bundle, wrap boot in an async IIFE. The game must still
start if `loadManifest` rejects — it can't, it swallows errors, but guard anyway.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. (Note: importing from `three/examples/jsm/...` — if the client tsconfig needs
it, ensure `moduleResolution` resolves the subpath; `@types/three` ships these. If typecheck
errors on the GLTFLoader import path, use `three/examples/jsm/loaders/GLTFLoader` without `.js`
or add the example types — resolve so typecheck passes.)

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: vite build succeeds.

- [ ] **Step 7: Manual smoke — real compressed models in the browser (REQUIRED)**

This is where Draco decoding + WebP + the animation path get verified for real (they can't be
unit-tested). With the compressed models from Task 1.5 and a `manifest.json` present: start
server + client, open `http://localhost:5173/?display=1&room=4821`, start a race. Confirm:
- the real car models load and render (no console errors from DRACOLoader — if the gstatic
  decoder path fails offline, vendor the decoder under `assets/draco/` and point
  `setDecoderPath` there);
- animated models (e.g. the bronco's "Take 001") visibly animate; non-animated models with
  wheel nodes spin their wheels; others sit static — all three paths exercised;
- WebP textures display correctly.
Then rename/remove `manifest.json` and reload → confirm the game still renders **primitives**
exactly as before (the fallback path is intact). The full suite must still pass: `npm test`.

- [ ] **Step 8: Commit**

```bash
git add client/asset-loader.ts client/car-factory.ts client/renderer.ts client/main.ts
git commit -m "feat: GLB asset loader + car factory + renderer integration (primitive fallback)"
```

---

### Task 7: Interactive model editor (`/editor`)

A browser page that mirrors the game scene, lets the user click-select a car/barrier/boost
model, adjust scale/rotation/offset via a TransformControls gizmo + numeric fields, pick which
GLB fills each role, and save back to the manifest. Verified by build + typecheck + manual.

**Files:**
- Create: `client/editor/editor.html`, `client/editor/editor-main.ts`, `client/editor/manifest-client.ts`
- Modify: `client/vite config / entry` so `/editor` is served (Vite multi-page: add `editor.html` as an input), and `server/http-server.ts` only needs the manifest API (already added in Task 5; the editor page itself is served by Vite in dev / built as a second page).

**Interfaces:**
- Consumes: `AssetLoader` (Task 6), `parseManifest`/`serializeManifest`/`Manifest`/`AssetRef` (Task 2), the manifest API (Task 5).
- Produces:
  - `manifest-client.ts`: `fetchManifest(): Promise<Manifest>`, `saveManifest(m: Manifest): Promise<Manifest>`
  - `editor-main.ts`: boots a scene mirroring the game (track + sample cars in lanes + a barrier + a boost pad placed representatively), wires `OrbitControls` + `TransformControls`, selection by raycast, a small DOM panel (role dropdowns + numeric scale/rotation/offset fields + Save button) bound to a working `Manifest` copy.

- [ ] **Step 1: Implement `client/editor/manifest-client.ts`**

```ts
import type { Manifest } from '../../shared/asset-manifest';
export async function fetchManifest(): Promise<Manifest> {
  const res = await fetch('/api/manifest'); return res.json();
}
export async function saveManifest(m: Manifest): Promise<Manifest> {
  const res = await fetch('/api/manifest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
  return res.json();
}
```

- [ ] **Step 2: Create `client/editor/editor.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice Racer — Model Editor</title>
  <link rel="icon" href="data:," />
  <style>
    html,body{margin:0;height:100%;background:#0b1020;color:#e8ecf6;font-family:system-ui,sans-serif;overflow:hidden}
    #app{position:fixed;inset:0}
    #panel{position:absolute;top:14px;right:14px;width:280px;background:rgba(16,22,40,.92);
      border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;font-size:13px}
    #panel h4{margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#93a0c0;font-size:11px}
    label{display:grid;grid-template-columns:70px 1fr;gap:6px;align-items:center;margin:5px 0;color:#93a0c0;font-size:12px}
    input,select{background:#0e1530;color:#e8ecf6;border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:4px 6px;width:100%}
    button{font:inherit;color:#fff;background:#f22f46;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;width:100%;margin-top:10px;font-weight:600}
    .hint{color:#93a0c0;font-size:11px;line-height:1.5;margin-top:8px}
    #toast{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);background:#131a30;border:1px solid rgba(255,255,255,.12);padding:8px 16px;border-radius:10px;opacity:0;transition:.25s}
    #toast.show{opacity:1}
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="panel">
    <h4>Model Editor</h4>
    <div class="hint">Click a model in the scene to select it. Drag the gizmo or edit fields, then Save.</div>
    <div id="inspector"></div>
    <button id="save">💾 Save to manifest</button>
  </div>
  <div id="toast"></div>
  <script type="module" src="./editor-main.ts"></script>
</body>
</html>
```

- [ ] **Step 3: Implement `client/editor/editor-main.ts`**

Boot a three.js scene reusing the same track/lighting as `Renderer` (import shared constants
`TRACK_W`, `TRACK_LEN`, `LANES`, `laneX`). Use `AssetLoader` to load the manifest, then place:
the cars (one per lane using `carTemplate(i)`), a barrier and a boost pad at representative
positions. Add `OrbitControls` (camera) + `TransformControls` (gizmo). On pointerdown, raycast
against the placed groups; attach the gizmo to the hit group and show its role + numeric fields
(scale, rotation x/y/z in degrees, offset x/y/z) in `#inspector`, plus a `<select>` listing the
GLB files available for that role. Editing a field or dragging the gizmo updates both the
mesh and the working `Manifest` copy's matching `AssetRef`. The Save button calls
`saveManifest(working)` and flashes the toast. Keep it within scope — **transforms + role
assignment only**; no add/delete/lighting/zones.

```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { AssetLoader } from '../asset-loader';
import { fetchManifest, saveManifest } from './manifest-client';
import { TRACK_W, LANES, laneX } from '../../shared/constants';
import type { Manifest, AssetRef } from '../../shared/asset-manifest';

// Boot scene (track + lights mirroring Renderer), load AssetLoader, place cars-in-lanes +
// barrier + boost pad, wire OrbitControls + TransformControls + raycast selection + the
// inspector panel (numeric fields + role <select>) bound to a working Manifest copy, and
// Save → saveManifest(). [Full implementation written during the task — this file is GL/DOM
// glue verified by running, not unit-tested. Reuse Renderer's track/light setup verbatim to
// guarantee the editor scene matches the game.]
```
(The implementer writes the full body here following the description; it is browser glue, so
the acceptance bar is typecheck + build + a working `/editor` page, not a unit test. Keep the
selection→fields→manifest binding faithful so Save persists exactly what's shown.)

- [ ] **Step 4: Register `/editor` as a Vite page**

Create/modify `client/vite.config.ts` for multi-page input so both the game and the editor
build:
```ts
import { defineConfig } from 'vite';
import { resolve } from 'path';
export default defineConfig({
  root: __dirname,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor/editor.html'),
      },
    },
  },
});
```
In dev, the editor is reachable at `http://localhost:5173/editor/editor.html` (or set up a
cleaner `/editor` route if desired). Document the actual dev URL in the task report.

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean typecheck; vite builds both `main` and `editor` pages.

- [ ] **Step 6: Manual editor smoke**

Start server + client. Open the editor page. Confirm: the scene mirrors the game (track + cars
in lanes + a barrier + a boost pad); clicking a model selects it (gizmo appears); editing
scale/rotation/offset moves it; the role dropdown lists available GLBs; Save persists (reload
→ values stick; `assets/manifest.json` on disk shows the change). With no models, the editor
still loads and shows primitive stand-ins.

- [ ] **Step 7: Full suite + commit**

Run: `npm test`  (the editor is browser-only; the backend tests must still all pass)
```bash
git add client/editor/ client/vite.config.ts
git commit -m "feat: interactive model editor (transform + role assignment, saves manifest)"
```

---

## Self-Review Results

- **Placeholder scan:** none. (Task 7 Step 3's editor body is intentionally described-not-coded
  because it is browser/GL glue verified by running, not unit-tested — the description is
  complete enough to implement, and the surrounding files give exact imports/signatures.)
- **Spec coverage:** GLB-only loader + auto-fit + wheel-detect + primitive fallback → Tasks 3,6;
  manifest as source of truth → Tasks 2,5; CLI inspector (sizes + wheels + starter manifest) →
  Tasks 1,4; interactive editor (transform + role assignment, save) → Task 7; CREDITS.md →
  authored alongside models (noted; not its own task — it's a doc file the user/Claude fills as
  models are added); headless-GLB risk isolated first → Task 1. Auto-fit-then-overrides, wheel
  patterns, role target sizes all in Global Constraints.
- **Type/name consistency:** `parseManifest`/`serializeManifest`/`EMPTY_MANIFEST`/`Manifest`/
  `AssetRef` (Task 2) used consistently in 4,5,6,7; `readGlb` (1) used in 4; `autoFitScale`/
  `isWheelNode`/`*_TARGET` (3) used in 6; `ManifestStore` (5) used in http-server; `AssetLoader`/
  `buildCar` (6) used in 7. No drift.
- **API accuracy:** `@gltf-transform/core` installed and the exact methods the plan calls
  (`NodeIO.read/write`, `node.getWorldTranslation/getMesh/getName`, `accessor.getMin/getMax/
  setMin/setMax`, `root.listNodes`, `prim.getAttribute/setAttribute`, `mesh.listPrimitives/
  addPrimitive`) all verified to exist before finalizing. Fixture authoring sets accessor
  min/max (required by the reader).

## Deliberate notes

- **`CREDITS.md`** is a documentation file populated as the user supplies models (author +
  license per Sketchfab page); not a code task.
- **`three/examples/jsm` imports** (GLTFLoader, OrbitControls, TransformControls) ship with
  `@types/three`; if a typecheck path issue arises, Task 6/7 steps note resolving it.
- **Editor is scoped to transform + role assignment only** — no lighting, zones, or
  add/delete (deferred to the next Plan 5 spec).
