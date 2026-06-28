# Unified Level Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page (`/level.html`) where you pick a level from a dropdown and edit its world map, track + curve, decoration props, per-level car scale, lighting, and effects — then Save writes just that level to `maps.json`.

**Architecture:** A "level" extends today's per-map config in `maps.json` with optional `cars`, `props`, `lighting`, `effects` fields (all back-compat). Pure helpers in `shared/level.ts` (de)serialize and fill defaults. The game renderer gains setters that apply a level's lighting/effects/props and skip zone cycling when a level defines lighting. The editor reuses this session's `track-path`/`track-surface`/`align-curve`/gizmo code.

**Tech Stack:** TypeScript, three.js 0.164, Vite (multi-page), Vitest, Node http server (existing `/api/maps`, `/api/assets`).

## Global Constraints

- No changes to `shared/race-world.ts`, lap logic, collisions, or any sim code. All 123 existing tests MUST stay green.
- Every new level field is OPTIONAL; missing fields fall back to engine defaults via `mergeLevel` (back-compat: existing `silver_lake` config must load unchanged).
- Decoration props are visual-only — rendered, never seen by the sim (no collision).
- Per-level `lighting` (when present) DISABLES zone cycling for that level; levels without it keep current zone behavior.
- Tests use Vitest (`import { describe, it, expect } from 'vitest'`), run with `npm test`.
- Reuse existing modules; do not fork `track-path.ts`/`track-surface.ts`/`align-curve.ts` — extract shared helpers if generalization is needed.
- Colors stored as hex strings (`"#rrggbb"`); transforms as `{pos:number[], rotDeg:number[], scale:number}`.

## File Structure

- `shared/level.ts` (CREATE) — Level types + pure helpers: `levelDefaults`, `mergeLevel`, `resolveCarScale`, prop helpers (`addProp`, `duplicateProp`, `removeProp`). Pure, no three.js, no DOM.
- `tests/level.test.ts` (CREATE) — unit tests for `shared/level.ts`.
- `client/map-world.ts` (MODIFY) — re-export Level types for client convenience; extend `MapConfig` loaders to surface the new fields.
- `client/renderer.ts` (MODIFY) — add `setLighting`, `setEffects`, `setProps`; gate zone cycling on a `lightingLocked` flag; apply car scale.
- `client/main.ts` (MODIFY) — when a level defines lighting/effects/props, call the new setters.
- `client/level.html` (CREATE) — editor page shell.
- `client/level.ts` (CREATE) — editor bootstrap (dropdown, save/new, wires panels).
- `client/level-scene.ts` (CREATE) — the editor's three.js scene + selection/gizmo (generalizes align interaction to any object).
- `client/level-panels.ts` (CREATE) — inspector DOM (transform, track/curve, cars, lighting, effects).
- `client/vite.config.ts` (MODIFY) — add `level` rollup input, remove `maptest`.
- `client/maptest.ts`, `client/maptest.html` (DELETE) — superseded.
- `client/home.ts` (MODIFY) — link the Level Editor; relabel model studio "Models library".

---

## Phase 1 — Level data model + pure helpers

### Task 1: Level types & pure helpers (`shared/level.ts`)

**Files:**
- Create: `shared/level.ts`
- Test: `tests/level.test.ts`

**Interfaces:**
- Consumes: nothing (pure; mirrors `MapTransform`/`TrackPath` shapes from `client/map-world.ts` but defined standalone in shared so server/tests can use them without three.js).
- Produces:
  - `interface LevelTransform { pos: number[]; rotDeg: number[]; scale: number }`
  - `interface LevelPath { points: [number, number][]; laneScale?: number; shoulder?: number; smoothing?: number }`
  - `interface PlacedProp { id: string; file: string; pos: number[]; rotDeg: number[]; scale: number }`
  - `interface LevelLighting { sunPos: number[]; sunIntensity: number; sunColor: string; ambientIntensity: number; skyColor: string; groundColor: string; exposure: number }`
  - `interface LevelEffects { bloom: { strength: number; radius: number; threshold: number }; fog: { density: number; color: string }; trackEmissive: number; pulse: { speed: number; amount: number }; skyTop: string; skyBottom: string }`
  - `interface LevelConfig { map: string; file: string; model: LevelTransform; track: LevelTransform; path?: LevelPath; cars: { masterScale: number; overrides: Record<string, number> }; props: PlacedProp[]; lighting?: LevelLighting; effects?: LevelEffects }`
  - `function levelDefaults(map: string, file: string): LevelConfig`
  - `function mergeLevel(saved: unknown): LevelConfig` — fills every missing field with defaults; tolerates today's `{file,model,track,path}`-only configs.
  - `function resolveCarScale(level: LevelConfig, glb: string): number` — `masterScale * (overrides[glb] ?? 1)`.
  - `function addProp(level: LevelConfig, file: string, pos: number[]): LevelConfig` — appends a prop (new id `p${n}`), returns a new object.
  - `function duplicateProp(level: LevelConfig, id: string): LevelConfig` — clones the prop offset by `[8,0,8]`, new id.
  - `function removeProp(level: LevelConfig, id: string): LevelConfig`.
  - `const DEFAULT_LIGHTING: LevelLighting`, `const DEFAULT_EFFECTS: LevelEffects` (exported for the renderer/editor).

- [ ] **Step 1: Write the failing test**

```ts
// tests/level.test.ts
import { describe, it, expect } from 'vitest';
import { levelDefaults, mergeLevel, resolveCarScale, addProp, duplicateProp, removeProp,
         DEFAULT_LIGHTING, DEFAULT_EFFECTS } from '../shared/level';

describe('levelDefaults', () => {
  it('produces a full, sane level', () => {
    const l = levelDefaults('silver_lake', 'silver_lake.glb');
    expect(l.map).toBe('silver_lake');
    expect(l.file).toBe('silver_lake.glb');
    expect(l.cars.masterScale).toBe(1);
    expect(l.cars.overrides).toEqual({});
    expect(l.props).toEqual([]);
    expect(l.track.scale).toBe(1);
  });
});

describe('mergeLevel (back-compat)', () => {
  it('fills missing fields from a legacy {file,model,track,path}-only config', () => {
    const legacy = { map: 'silver_lake', file: 'silver_lake.glb',
      model: { pos: [1,2,3], rotDeg: [0,0,0], scale: 200 },
      track: { pos: [0,0,1050], rotDeg: [0,0,0], scale: 1 },
      path: { points: [[0,0],[0,2100]] } };
    const l = mergeLevel(legacy);
    expect(l.model.scale).toBe(200);          // preserved
    expect(l.cars.masterScale).toBe(1);        // filled
    expect(l.props).toEqual([]);               // filled
    expect(l.lighting).toBeUndefined();        // not set → zones stay (per spec)
    expect(l.path?.points.length).toBe(2);     // preserved
  });
  it('preserves saved lighting/effects when present', () => {
    const saved = { map: 'm', file: 'm.glb', model: levelDefaults('m','m.glb').model,
      track: levelDefaults('m','m.glb').track,
      lighting: { ...DEFAULT_LIGHTING, sunIntensity: 3 },
      effects: { ...DEFAULT_EFFECTS, trackEmissive: 2 } };
    const l = mergeLevel(saved);
    expect(l.lighting!.sunIntensity).toBe(3);
    expect(l.effects!.trackEmissive).toBe(2);
  });
  it('returns defaults for junk input', () => {
    const l = mergeLevel(null);
    expect(l.cars.masterScale).toBe(1);
    expect(typeof l.file).toBe('string');
  });
});

describe('resolveCarScale', () => {
  it('multiplies master by per-car override', () => {
    const l = levelDefaults('m','m.glb');
    l.cars.masterScale = 2; l.cars.overrides = { 'a.glb': 1.5 };
    expect(resolveCarScale(l, 'a.glb')).toBe(3);
    expect(resolveCarScale(l, 'b.glb')).toBe(2);   // no override → master only
  });
});

describe('prop helpers (immutable)', () => {
  it('adds, duplicates, and removes props returning new objects', () => {
    const l0 = levelDefaults('m','m.glb');
    const l1 = addProp(l0, 'tree.glb', [10, 0, 20]);
    expect(l0.props.length).toBe(0);             // original untouched
    expect(l1.props.length).toBe(1);
    expect(l1.props[0]!.file).toBe('tree.glb');
    const id = l1.props[0]!.id;
    const l2 = duplicateProp(l1, id);
    expect(l2.props.length).toBe(2);
    expect(l2.props[1]!.id).not.toBe(id);
    expect(l2.props[1]!.pos).toEqual([18, 0, 28]); // offset by [8,0,8]
    const l3 = removeProp(l2, id);
    expect(l3.props.length).toBe(1);
    expect(l3.props.find(p => p.id === id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/level.test.ts`
Expected: FAIL — `Cannot find module '../shared/level'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// shared/level.ts
// Pure level data model + helpers. No three.js, no DOM — usable by server, tests, and client.
// A "level" extends the old per-map config with optional cars/props/lighting/effects (back-compat).

export interface LevelTransform { pos: number[]; rotDeg: number[]; scale: number }
export interface LevelPath { points: [number, number][]; laneScale?: number; shoulder?: number; smoothing?: number }
export interface PlacedProp { id: string; file: string; pos: number[]; rotDeg: number[]; scale: number }
export interface LevelLighting {
  sunPos: number[]; sunIntensity: number; sunColor: string;
  ambientIntensity: number; skyColor: string; groundColor: string; exposure: number;
}
export interface LevelEffects {
  bloom: { strength: number; radius: number; threshold: number };
  fog: { density: number; color: string };
  trackEmissive: number;
  pulse: { speed: number; amount: number };   // amount 0 = no pulse
  skyTop: string; skyBottom: string;
}
export interface LevelConfig {
  map: string; file: string;
  model: LevelTransform; track: LevelTransform; path?: LevelPath;
  cars: { masterScale: number; overrides: Record<string, number> };
  props: PlacedProp[];
  lighting?: LevelLighting; effects?: LevelEffects;
}

// Default look mirrors the renderer's current hardcoded values so an explicit level matches today.
export const DEFAULT_LIGHTING: LevelLighting = {
  sunPos: [60, 110, 40], sunIntensity: 2.1, sunColor: '#fff4e2',
  ambientIntensity: 0.7, skyColor: '#bfd4ff', groundColor: '#202840', exposure: 1.15,
};
export const DEFAULT_EFFECTS: LevelEffects = {
  bloom: { strength: 0.45, radius: 0.7, threshold: 0.85 },
  fog: { density: 0.0016, color: '#0b1020' },
  trackEmissive: 1, pulse: { speed: 0, amount: 0 },
  skyTop: '#2a6cff', skyBottom: '#bfe0ff',
};

const RACE_LEN = 2100;   // mirrors shared/constants RACE_LEN (TRACK_LEN*LAP_TARGET); avoids import cycle

export function levelDefaults(map: string, file: string): LevelConfig {
  return {
    map, file,
    model: { pos: [0, 0, RACE_LEN / 2], rotDeg: [0, 0, 0], scale: 20 },
    track: { pos: [0, 0, RACE_LEN / 2], rotDeg: [0, 0, 0], scale: 1 },
    cars: { masterScale: 1, overrides: {} },
    props: [],
  };
}

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object'; }
function num(v: unknown, d: number): number { return typeof v === 'number' && isFinite(v) ? v : d; }
function str(v: unknown, d: string): string { return typeof v === 'string' ? v : d; }
function transform(v: unknown, d: LevelTransform): LevelTransform {
  if (!isObj(v)) return { ...d };
  return {
    pos: Array.isArray(v.pos) ? v.pos.map(Number) : [...d.pos],
    rotDeg: Array.isArray(v.rotDeg) ? v.rotDeg.map(Number) : [...d.rotDeg],
    scale: num(v.scale, d.scale),
  };
}

export function mergeLevel(saved: unknown): LevelConfig {
  const s = isObj(saved) ? saved : {};
  const map = str(s.map, 'level');
  const file = str(s.file, `${map}.glb`);
  const d = levelDefaults(map, file);
  const out: LevelConfig = {
    map, file,
    model: transform(s.model, d.model),
    track: transform(s.track, d.track),
    cars: {
      masterScale: isObj(s.cars) ? num((s.cars as Record<string, unknown>).masterScale, 1) : 1,
      overrides: isObj(s.cars) && isObj((s.cars as Record<string, unknown>).overrides)
        ? { ...((s.cars as Record<string, unknown>).overrides as Record<string, number>) } : {},
    },
    props: Array.isArray(s.props) ? s.props.filter(isObj).map((p, i) => ({
      id: str((p as Record<string, unknown>).id, `p${i + 1}`),
      file: str((p as Record<string, unknown>).file, ''),
      pos: Array.isArray((p as Record<string, unknown>).pos) ? ((p as Record<string, unknown>).pos as number[]).map(Number) : [0, 0, 0],
      rotDeg: Array.isArray((p as Record<string, unknown>).rotDeg) ? ((p as Record<string, unknown>).rotDeg as number[]).map(Number) : [0, 0, 0],
      scale: num((p as Record<string, unknown>).scale, 1),
    })).filter(p => p.file) : [],
  };
  if (isObj(s.path) && Array.isArray((s.path as Record<string, unknown>).points)) {
    const p = s.path as Record<string, unknown>;
    out.path = {
      points: (p.points as [number, number][]).map(pt => [Number(pt[0]), Number(pt[1])] as [number, number]),
      laneScale: num(p.laneScale, 1), shoulder: num(p.shoulder, 0), smoothing: num(p.smoothing, 0),
    };
  }
  if (isObj(s.lighting)) {
    const L = s.lighting as Record<string, unknown>;
    out.lighting = {
      sunPos: Array.isArray(L.sunPos) ? (L.sunPos as number[]).map(Number) : [...DEFAULT_LIGHTING.sunPos],
      sunIntensity: num(L.sunIntensity, DEFAULT_LIGHTING.sunIntensity),
      sunColor: str(L.sunColor, DEFAULT_LIGHTING.sunColor),
      ambientIntensity: num(L.ambientIntensity, DEFAULT_LIGHTING.ambientIntensity),
      skyColor: str(L.skyColor, DEFAULT_LIGHTING.skyColor),
      groundColor: str(L.groundColor, DEFAULT_LIGHTING.groundColor),
      exposure: num(L.exposure, DEFAULT_LIGHTING.exposure),
    };
  }
  if (isObj(s.effects)) {
    const E = s.effects as Record<string, unknown>;
    const bl = isObj(E.bloom) ? E.bloom as Record<string, unknown> : {};
    const fg = isObj(E.fog) ? E.fog as Record<string, unknown> : {};
    const pu = isObj(E.pulse) ? E.pulse as Record<string, unknown> : {};
    out.effects = {
      bloom: { strength: num(bl.strength, DEFAULT_EFFECTS.bloom.strength),
               radius: num(bl.radius, DEFAULT_EFFECTS.bloom.radius),
               threshold: num(bl.threshold, DEFAULT_EFFECTS.bloom.threshold) },
      fog: { density: num(fg.density, DEFAULT_EFFECTS.fog.density), color: str(fg.color, DEFAULT_EFFECTS.fog.color) },
      trackEmissive: num(E.trackEmissive, DEFAULT_EFFECTS.trackEmissive),
      pulse: { speed: num(pu.speed, 0), amount: num(pu.amount, 0) },
      skyTop: str(E.skyTop, DEFAULT_EFFECTS.skyTop), skyBottom: str(E.skyBottom, DEFAULT_EFFECTS.skyBottom),
    };
  }
  return out;
}

export function resolveCarScale(level: LevelConfig, glb: string): number {
  return level.cars.masterScale * (level.cars.overrides[glb] ?? 1);
}

function nextPropId(level: LevelConfig): string {
  let n = level.props.length + 1;
  const ids = new Set(level.props.map(p => p.id));
  while (ids.has(`p${n}`)) n++;
  return `p${n}`;
}

export function addProp(level: LevelConfig, file: string, pos: number[]): LevelConfig {
  const prop: PlacedProp = { id: nextPropId(level), file, pos: [...pos], rotDeg: [0, 0, 0], scale: 1 };
  return { ...level, props: [...level.props, prop] };
}

export function duplicateProp(level: LevelConfig, id: string): LevelConfig {
  const src = level.props.find(p => p.id === id);
  if (!src) return level;
  const copy: PlacedProp = { ...src, id: nextPropId(level),
    pos: [src.pos[0]! + 8, src.pos[1]!, src.pos[2]! + 8], rotDeg: [...src.rotDeg] };
  return { ...level, props: [...level.props, copy] };
}

export function removeProp(level: LevelConfig, id: string): LevelConfig {
  return { ...level, props: level.props.filter(p => p.id !== id) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/level.test.ts`
Expected: PASS (all cases). Then `npm test` → still 123 + new = green.

- [ ] **Step 5: Commit**

```bash
git add shared/level.ts tests/level.test.ts
git commit -m "feat: level data model + pure helpers (types, mergeLevel, prop ops)"
```

---

## Phase 2 — Game applies a level's lighting / effects / props

### Task 2: Renderer setters + zone-cycling gate (`client/renderer.ts`, `client/main.ts`)

**Files:**
- Modify: `client/renderer.ts` (add fields + 3 setters; gate the per-frame zone block in `render()` ~lines 341–354)
- Modify: `client/main.ts` (apply level lighting/effects/props after loading a map)
- Test: covered by build + headless smoke (Task 2 has no pure logic of its own; the pure parts were Task 1). Add one renderer-logic test below for the zone-lock flag.
- Test (logic): `tests/renderer-level.test.ts`

**Interfaces:**
- Consumes: `LevelLighting`, `LevelEffects`, `PlacedProp`, `resolveCarScale` from `shared/level`.
- Produces (new public methods on `Renderer`):
  - `setLighting(l: LevelLighting | null): void` — applies sun pos/intensity/color, ambient, sky dome base colors, exposure; sets `this.lightingLocked = !!l` so `render()` skips zone cycling.
  - `setEffects(e: LevelEffects | null): void` — sets bloom strength/radius/threshold, fog density/color, stores `trackEmissive`/`pulse` for the surface, sky top/bottom.
  - `setProps(props: PlacedProp[]): void` — loads each prop GLB (via a shared `GLTFLoader`+`DRACOLoader`) and places it in `trackContent` at pos/rotDeg/scale; replaces any prior props.
  - `getLightingLocked(): boolean` (test seam).

- [ ] **Step 1: Write the failing test**

```ts
// tests/renderer-level.test.ts
// Renderer needs a DOM/WebGL context; in the node test env we only verify the PURE gate logic
// that decides whether zones cycle. Extract that decision into a tiny pure helper and test it.
import { describe, it, expect } from 'vitest';
import { shouldCycleZones } from '../client/zone-gate';

describe('shouldCycleZones', () => {
  it('cycles when no per-level lighting is locked', () => {
    expect(shouldCycleZones(false)).toBe(true);
  });
  it('does NOT cycle when a level locked its own lighting', () => {
    expect(shouldCycleZones(true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/renderer-level.test.ts`
Expected: FAIL — `Cannot find module '../client/zone-gate'`.

- [ ] **Step 3: Write minimal implementation**

Create the pure gate so the decision is testable without WebGL:

```ts
// client/zone-gate.ts
/** Zones auto-cycle ONLY when a level has not locked its own per-level lighting. */
export function shouldCycleZones(lightingLocked: boolean): boolean { return !lightingLocked; }
```

Then wire the renderer. Add imports + fields near the other private fields in `client/renderer.ts`:

```ts
// at top with other imports
import { shouldCycleZones } from './zone-gate';
import type { LevelLighting, LevelEffects, PlacedProp } from '../shared/level';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
```

```ts
// new private fields (near `private path: CurvedTrack | null = null;`)
private lightingLocked = false;
private trackEmissive = 1;
private pulse = { speed: 0, amount: 0 };
private propsGroup = new THREE.Group();     // decoration props live here (added to trackContent)
private propLoader = (() => {
  const l = new GLTFLoader(); const d = new DRACOLoader();
  d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/'); l.setDRACOLoader(d);
  return l;
})();
```

Add the setters (place after `setPath`):

```ts
/** Apply a level's lighting; null reverts to zone-cycling. */
setLighting(l: LevelLighting | null): void {
  this.lightingLocked = !!l;
  if (!l) return;
  this.sun.position.set(l.sunPos[0]!, l.sunPos[1]!, l.sunPos[2]!);
  this.sun.intensity = l.sunIntensity;
  this.sun.color.set(l.sunColor);
  this.ambient.intensity = l.ambientIntensity;
  this.ambient.color.set(l.skyColor);
  this.ambient.groundColor.set(l.groundColor);
  this.renderer.toneMappingExposure = l.exposure;
  const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
  (skyU.top!.value as THREE.Color).set(l.skyColor);
}

/** Apply a level's effects (bloom/fog/track-glow/sky); null leaves current values. */
setEffects(e: LevelEffects | null): void {
  if (!e) return;
  this.bloom.strength = e.bloom.strength;
  this.bloom.radius = e.bloom.radius;
  this.bloom.threshold = e.bloom.threshold;
  const fog = this.scene.fog as THREE.FogExp2;
  fog.density = e.fog.density; fog.color.set(e.fog.color);
  this.trackEmissive = e.trackEmissive;
  this.pulse = { ...e.pulse };
  const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
  (skyU.top!.value as THREE.Color).set(e.skyTop);
  (skyU.bottom!.value as THREE.Color).set(e.skyBottom);
}

/** Load + place decoration props (visual-only) in the track content group. */
setProps(props: PlacedProp[]): void {
  this.trackContent.remove(this.propsGroup);
  this.propsGroup = new THREE.Group();
  this.trackContent.add(this.propsGroup);
  for (const p of props) {
    this.propLoader.load(`/assets/${p.file}`, (gltf) => {
      const g = new THREE.Group(); g.add(gltf.scene);
      g.position.set(p.pos[0]!, p.pos[1]!, p.pos[2]!);
      g.rotation.set(p.rotDeg[0]! * Math.PI / 180, p.rotDeg[1]! * Math.PI / 180, p.rotDeg[2]! * Math.PI / 180);
      g.scale.setScalar(p.scale);
      g.userData.propId = p.id;
      this.propsGroup.add(g);
    }, undefined, () => { /* skip a failed prop, keep the scene */ });
  }
}

getLightingLocked(): boolean { return this.lightingLocked; }
```

Gate the zone block in `render()` — wrap lines ~341–354 so they only run when zones should cycle:

```ts
    const z = me ? me.z : 0;

    if (shouldCycleZones(this.lightingLocked)) {
      const theme = themeAtZ(z);
      const fog = this.scene.fog as THREE.FogExp2;
      fog.color.set(theme.fog);
      (this.ground.material as THREE.MeshStandardMaterial).color.set(theme.ground);
      this.sun.color.set(theme.sun); this.sun.intensity = Math.max(1.4, theme.sunIntensity * 1.6);
      this.ambient.color.set(theme.sky);
      this.ambient.groundColor.set(theme.ground);
      const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
      (skyU.top!.value as THREE.Color).set(theme.sky);
      (skyU.bottom!.value as THREE.Color).set(theme.fog);
    }
    // Shadow frustum + sky always follow the action (independent of zones vs locked lighting).
    this.sun.position.set(this.sun.position.x, this.sun.position.y, z + 40);
    this.sun.target.position.set(0, 0, z + 20); this.sun.target.updateMatrixWorld();
```

NOTE: when lighting is locked we keep the sun's authored x/y (from `setLighting`) but still track z so shadows follow the cars. Leave the rest of `render()` (camera chase, sky.position.copy) unchanged.

In `client/main.ts`, after the existing map-load block that calls `renderer.setPath(...)`, apply the level look. Replace the map-load body to use `mergeLevel`:

```ts
import { mergeLevel } from '../shared/level';
// ...
      if (cfg) {
        const level = mergeLevel(cfg);
        const world = await loadMapWorld(cfg);
        if (world) renderer.setMapWorld(world);
        applyTrackTransform(renderer.getTrackGroup(), CANONICAL_TRACK);
        renderer.setPath(level.path ? new CurvedTrack(level.path) : null, surfaceOptsFromPath(level.path));
        renderer.setLighting(level.lighting ?? null);
        renderer.setEffects(level.effects ?? null);
        renderer.setProps(level.props);
      }
```

- [ ] **Step 4: Run test + build to verify**

Run: `npm test -- tests/renderer-level.test.ts` → PASS.
Run: `npm run build` → `✓ built`, no type errors.
Run: `npm test` → all green (123 + level + zone-gate).
Headless smoke (from a project with playwright, e.g. `~/Desktop/Git-Projects/twilio-workshop-builder`): load `/play.html?display=1&room=4821&map=silver_lake`, wait, assert `canvas` present + no `pageerror`. (silver_lake has no lighting yet → zones still cycle; back-compat verified.)

- [ ] **Step 5: Commit**

```bash
git add client/zone-gate.ts client/renderer.ts client/main.ts tests/renderer-level.test.ts
git commit -m "feat: renderer applies per-level lighting/effects/props; zone-cycling gate"
```

---

## Phase 3 — Editor shell: page, level dropdown, load/save/new

### Task 3: Level editor page + scene + dropdown + save/new (`client/level.html`, `client/level.ts`, `client/level-scene.ts`)

**Files:**
- Create: `client/level.html` (page shell: `#app` canvas mount, `#panel` UI container)
- Create: `client/level-scene.ts` (three.js scene: renderer, camera, OrbitControls w/ unlimited zoom + dynamic near/far, lights, loads map GLB + builds track surface via existing modules; selection + gizmo generalized to any object)
- Create: `client/level.ts` (bootstrap: fetch levels, populate dropdown, load selected, Save/New buttons)
- Modify: `client/vite.config.ts` (add `level` input; remove `maptest` input)
- Delete: `client/maptest.ts`, `client/maptest.html`
- Modify: `client/home.ts` (Level Editor link; relabel studio "Models library")
- Test: build + headless smoke (UI/3D; no pure logic beyond Task 1).

**Interfaces:**
- Consumes: `mergeLevel`, `levelDefaults`, `LevelConfig` from `shared/level`; `fetchMaps` from `client/map-world`; `CurvedTrack`/`buildTrackSurface`/`CurveEditor` (existing); `fetchAssets` from `client/editor/manifest-client`.
- Produces:
  - `client/level-scene.ts`: `class LevelScene { constructor(mount: HTMLElement); loadLevel(level: LevelConfig): Promise<void>; select(key: 'map'|'track'|string): void; current(): LevelConfig; onChange(cb: () => void): void; }` — owns the 3D view; `current()` returns the live edited level (transforms read back from the scene objects).
  - `client/level.ts`: no exports (bootstrap).

- [ ] **Step 1: Create the page shell**

```html
<!-- client/level.html -->
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Level Editor — Twilio Games</title>
<link rel="icon" href="data:," />
<style>
  html,body{margin:0;height:100%;background:#0b1020;overflow:hidden;
    font:13px -apple-system,system-ui,sans-serif;color:#e8ecf6}
  #app{position:fixed;inset:0}
  #topbar{position:fixed;top:0;left:0;right:0;height:48px;display:flex;align-items:center;gap:10px;
    padding:0 14px;background:rgba(16,22,40,.92);border-bottom:1px solid rgba(255,255,255,.12);z-index:10}
  #topbar select,#topbar button{font:inherit;color:#fff;background:#2a3350;border:0;border-radius:8px;
    padding:7px 12px;cursor:pointer}
  #topbar .save{background:#f22f46;font-weight:700}
  #panel{position:fixed;top:48px;right:0;width:300px;bottom:0;overflow:auto;
    background:rgba(16,22,40,.92);border-left:1px solid rgba(255,255,255,.12);padding:12px}
  #tree{position:fixed;top:48px;left:0;width:220px;bottom:0;overflow:auto;
    background:rgba(16,22,40,.92);border-right:1px solid rgba(255,255,255,.12);padding:12px}
  .row{padding:7px 9px;border-radius:7px;margin:2px 0;cursor:pointer;background:rgba(255,255,255,.05)}
  .row.sel{background:#3552a8}
  .btn{font:inherit;color:#fff;background:#2a3350;border:0;border-radius:7px;padding:6px 10px;margin:2px;cursor:pointer}
  h4{margin:10px 0 6px;font-size:12px;color:#9aa0b4}
  label{display:flex;justify-content:space-between;gap:8px;margin:4px 0;color:#cdd5e0;font-size:12px}
  input[type=range]{flex:1}
  input[type=number]{width:74px;background:#232b45;color:#fff;border:1px solid #4d5777;border-radius:6px;padding:3px 6px}
  input[type=color]{width:36px;height:24px;border:0;background:none}
</style>
</head>
<body>
  <div id="app"></div>
  <div id="topbar">
    <strong>🏗 Level Editor</strong>
    <select id="levelSelect"></select>
    <button id="newLevel">＋ New level</button>
    <span style="flex:1"></span>
    <button class="save" id="saveLevel">💾 Save level</button>
    <span id="status" style="color:#36e08a"></span>
  </div>
  <div id="tree"></div>
  <div id="panel"></div>
  <script type="module" src="./level.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Create `level-scene.ts`** (3D view; reuses align modules)

```ts
// client/level-scene.ts
// The editor's 3D viewport: loads the map GLB, builds the track surface, holds the gizmo, and lets
// the caller select/edit Map, Track, or a Prop. Reuses the align tool's proven modules. `current()`
// reads the live transforms back out so the bootstrap can serialize on Save.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { wrapMapScene, applyTrackTransform } from './map-world';
import { CurvedTrack } from './track-path';
import { buildTrackSurface, surfaceOptsFromPath } from './track-surface';
import { RACE_LEN } from '../shared/constants';
import type { LevelConfig, LevelTransform } from '../shared/level';

export class LevelScene {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 50000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private loader = new GLTFLoader();
  private mapGroup = new THREE.Group();
  private trackGroup = new THREE.Group();
  private surface = new THREE.Group();
  private level!: LevelConfig;
  private changeCb: () => void = () => {};

  constructor(mount: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x223047);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x303040, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(300, 800, 200); this.scene.add(sun);
    this.scene.add(new THREE.GridHelper(RACE_LEN * 2, 60, 0x44597f, 0x2c3a55));
    this.scene.add(this.mapGroup, this.trackGroup);

    const d = new DRACOLoader(); d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.loader.setDRACOLoader(d);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true; this.orbit.minDistance = 0; this.orbit.maxDistance = Infinity;
    this.camera.position.set(RACE_LEN * 0.6, RACE_LEN * 0.5, -RACE_LEN * 0.3);
    this.orbit.target.set(0, 0, RACE_LEN / 2); this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', (e) =>
      { this.orbit.enabled = !(e as unknown as { value: boolean }).value; });
    this.gizmo.addEventListener('objectChange', () => this.changeCb());

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
    this.loop();
  }

  onChange(cb: () => void): void { this.changeCb = cb; }

  async loadLevel(level: LevelConfig): Promise<void> {
    this.level = level;
    // reset groups
    this.mapGroup.clear(); this.trackGroup.clear();
    // map GLB
    await new Promise<void>((res) => {
      this.loader.load(`/assets/maps/${level.file}`, (g) => {
        const wrap = wrapMapScene(g.scene); this.mapGroup.add(wrap);
        applyTrackTransform(this.mapGroup, level.model); res();
      }, undefined, () => res());
    });
    // track surface
    applyTrackTransform(this.trackGroup, level.track);
    this.surface = buildTrackSurface(new CurvedTrack(level.path ?? { points: [[0,0],[0,RACE_LEN]] }),
      surfaceOptsFromPath(level.path));
    this.trackGroup.add(this.surface);
    this.select('track');
  }

  select(key: 'map' | 'track' | string): void {
    if (key === 'map') this.gizmo.attach(this.mapGroup);
    else this.gizmo.attach(this.trackGroup);   // props handled in Phase 4
    this.changeCb();
  }

  /** Read the live scene transforms back into a LevelConfig for saving. */
  current(): LevelConfig {
    const t = (o: THREE.Object3D): LevelTransform => ({
      pos: o.position.toArray().map(n => Math.round(n * 1000) / 1000),
      rotDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map(r => Math.round(r * 180 / Math.PI)),
      scale: Math.round(o.scale.x * 1000) / 1000,
    });
    return { ...this.level, model: t(this.mapGroup), track: t(this.trackGroup) };
  }

  private loop(): void {
    requestAnimationFrame(() => this.loop());
    this.orbit.update();
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.camera.far = Math.max(2000, dist * 4); this.camera.near = Math.max(0.05, dist / 5000);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
```

- [ ] **Step 3: Create `level.ts`** (bootstrap: dropdown, load, save, new)

```ts
// client/level.ts
import { LevelScene } from './level-scene';
import { fetchMaps } from './map-world';
import { mergeLevel, levelDefaults, type LevelConfig } from '../shared/level';

const scene = new LevelScene(document.getElementById('app')!);
const sel = document.getElementById('levelSelect') as HTMLSelectElement;
const status = document.getElementById('status')!;
let levels: Record<string, LevelConfig> = {};

async function refresh(selectKey?: string): Promise<void> {
  const raw = await fetchMaps();
  levels = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, mergeLevel(v)]));
  sel.replaceChildren();
  for (const key of Object.keys(levels)) {
    const o = document.createElement('option'); o.value = key; o.textContent = key; sel.appendChild(o);
  }
  const key = selectKey ?? Object.keys(levels)[0];
  if (key) { sel.value = key; await scene.loadLevel(structuredClone(levels[key]!)); }
}

sel.addEventListener('change', () => { void scene.loadLevel(structuredClone(levels[sel.value]!)); });

document.getElementById('newLevel')!.addEventListener('click', async () => {
  const map = prompt('New level key (e.g. canyon):')?.trim();
  if (!map) return;
  const file = prompt('World GLB filename in assets/maps (e.g. canyon.glb):', `${map}.glb`)?.trim();
  if (!file) return;
  if (levels[map] && !confirm(`Overwrite existing level "${map}"?`)) return;
  levels[map] = levelDefaults(map, file);
  await scene.loadLevel(structuredClone(levels[map]!));
  const o = document.createElement('option'); o.value = map; o.textContent = map; sel.appendChild(o); sel.value = map;
});

document.getElementById('saveLevel')!.addEventListener('click', async () => {
  const cfg = scene.current();
  try {
    const res = await fetch('/api/maps', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    status.textContent = res.ok ? `Saved "${cfg.map}" ✓` : 'Save failed';
  } catch { status.textContent = 'Server unreachable'; }
  setTimeout(() => (status.textContent = ''), 2500);
});

void refresh();
```

- [ ] **Step 4: Wire Vite + retire maptest + home link**

In `client/vite.config.ts` `rollupOptions.input`: add `level: resolve(__dirname, 'level.html'),` and DELETE the `maptest:` line. Then:

```bash
git rm client/maptest.ts client/maptest.html
```

In `client/home.ts`, replace the editor link logic that points to the model studio: keep the studio link but relabel it, and add the Level Editor as the primary. Find the `.editor-link` anchor in `client/index.html` (line ~146) — change its text to "🏗 Open the Level Editor" and `href` to `level.html`; add a second small link to `editor/editor.html` labelled "Models library". (Edit `client/index.html` directly.)

- [ ] **Step 5: Build + headless smoke**

Run: `npm run build` → `✓ built`, emits `dist/level.html`, no `maptest` output, no type errors.
Headless (playwright from a sibling project dir): open `/level.html`, wait 2.5s, assert: a `canvas` exists, `#levelSelect` has ≥1 option (`silver_lake`), no `pageerror`. Screenshot to `/tmp/shots/level.png` and read it to confirm the map + track render and the top bar/panels show.

- [ ] **Step 6: Commit**

```bash
git add client/level.html client/level.ts client/level-scene.ts client/vite.config.ts client/index.html client/home.ts
git commit -m "feat: level editor shell — page, scene, level dropdown, save/new; retire maptest"
```

---

## Phase 4 — Scene tree + decoration props

### Task 4: Scene tree, add/duplicate/delete props, gizmo on props (`client/level-scene.ts`, `client/level.ts`)

**Files:**
- Modify: `client/level-scene.ts` (track props as selectable scene objects; add/remove/duplicate; `current()` reads props back)
- Modify: `client/level.ts` (render the left scene-tree; ＋ Add model library; Duplicate/Delete buttons)
- Test: prop ops already unit-tested in Task 1 (`addProp`/`duplicateProp`/`removeProp`); this task is wiring → build + headless smoke.

**Interfaces:**
- Consumes: `addProp`, `duplicateProp`, `removeProp`, `PlacedProp` from `shared/level`; `fetchAssets` from `client/editor/manifest-client`.
- Produces (additions to `LevelScene`):
  - `loadLevel` also loads `level.props` into a `propGroups: Map<string, THREE.Group>`.
  - `select(id)` attaches the gizmo to a prop group when `id` matches a prop.
  - `addProp(file: string): string` — loads GLB at track start, registers it, returns new id (uses pure `addProp` to mutate `this.level`).
  - `removeSelectedProp(): void`, `duplicateSelectedProp(): string | null`.
  - `selectedKey(): 'map'|'track'|string` and `current()` now serializes every prop group's live transform via the pure level (positions read from the scene).

- [ ] **Step 1: Extend `LevelScene` for props**

Add fields + methods to `client/level-scene.ts`:

```ts
// new imports
import { addProp as addPropPure, duplicateProp as dupPropPure, removeProp as rmPropPure,
         type PlacedProp } from '../shared/level';
```

```ts
// new fields
private propGroups = new Map<string, THREE.Group>();
private selKey: 'map' | 'track' | string = 'track';

// in loadLevel(), after building the track surface, load props:
this.propGroups.clear();
for (const p of level.props) this.spawnProp(p);

// helper to instantiate one prop group
private spawnProp(p: PlacedProp): void {
  this.loader.load(`/assets/${p.file}`, (g) => {
    const grp = new THREE.Group(); grp.add(g.scene);
    grp.position.set(p.pos[0]!, p.pos[1]!, p.pos[2]!);
    grp.rotation.set(p.rotDeg[0]! * Math.PI/180, p.rotDeg[1]! * Math.PI/180, p.rotDeg[2]! * Math.PI/180);
    grp.scale.setScalar(p.scale);
    grp.userData.propId = p.id;
    this.trackGroup.add(grp);            // props ride the track transform like the surface
    this.propGroups.set(p.id, grp);
  }, undefined, () => { /* skip failed prop */ });
}

// add a prop from the library at the track start (sim z≈40, lane center)
addProp(file: string): string {
  this.level = addPropPure(this.level, file, [0, 0, 40]);
  const p = this.level.props[this.level.props.length - 1]!;
  this.spawnProp(p);
  this.select(p.id);
  return p.id;
}

duplicateSelectedProp(): string | null {
  if (this.selKey === 'map' || this.selKey === 'track') return null;
  this.level = dupPropPure(this.level, this.selKey);
  const p = this.level.props[this.level.props.length - 1]!;
  this.spawnProp(p);
  this.select(p.id);
  return p.id;
}

removeSelectedProp(): void {
  if (this.selKey === 'map' || this.selKey === 'track') return;
  const g = this.propGroups.get(this.selKey);
  if (g) { this.trackGroup.remove(g); this.propGroups.delete(this.selKey); }
  this.level = rmPropPure(this.level, this.selKey);
  this.select('track');
}

selectedKey(): 'map' | 'track' | string { return this.selKey; }
```

Update `select()` to handle prop ids and record `selKey`:

```ts
select(key: 'map' | 'track' | string): void {
  this.selKey = key;
  if (key === 'map') this.gizmo.attach(this.mapGroup);
  else if (key === 'track') this.gizmo.attach(this.trackGroup);
  else { const g = this.propGroups.get(key); if (g) this.gizmo.attach(g); }
  this.changeCb();
}
```

Update `current()` to serialize props from their live groups:

```ts
current(): LevelConfig {
  const t = (o: THREE.Object3D) => ({
    pos: o.position.toArray().map(n => Math.round(n * 1000) / 1000),
    rotDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map(r => Math.round(r * 180 / Math.PI)),
    scale: Math.round(o.scale.x * 1000) / 1000,
  });
  const props: PlacedProp[] = this.level.props.map(p => {
    const g = this.propGroups.get(p.id);
    return g ? { ...p, ...t(g) } : p;
  });
  return { ...this.level, model: t(this.mapGroup), track: t(this.trackGroup), props };
}
```

- [ ] **Step 2: Render the scene tree + library in `level.ts`**

Add after the existing bootstrap, and call `renderTree()` inside `scene.onChange(...)` and after load:

```ts
import { fetchAssets } from './editor/manifest-client';

const tree = document.getElementById('tree')!;
let assetFiles: string[] = [];
void fetchAssets().then(f => { assetFiles = f; });

function renderTree(): void {
  tree.replaceChildren();
  const mk = (label: string, key: string) => {
    const d = document.createElement('div');
    d.className = 'row' + (scene.selectedKey() === key ? ' sel' : '');
    d.textContent = label; d.onclick = () => { scene.select(key); renderTree(); };
    return d;
  };
  tree.append(mk('🗺 Map', 'map'), mk('🏁 Track', 'track'));
  const cfg = scene.current();
  const h = document.createElement('h4'); h.textContent = `Props (${cfg.props.length})`; tree.append(h);
  for (const p of cfg.props) tree.append(mk(`📦 ${p.file.replace('.glb','')} (${p.id})`, p.id));

  const add = document.createElement('button'); add.className = 'btn'; add.textContent = '＋ Add model';
  add.onclick = () => {
    const file = prompt(`Add which GLB?\nAvailable:\n${assetFiles.join('\n')}`, assetFiles[0] ?? '');
    if (file) { scene.addProp(file); renderTree(); }
  };
  const dup = document.createElement('button'); dup.className = 'btn'; dup.textContent = 'Duplicate';
  dup.onclick = () => { if (scene.duplicateSelectedProp()) renderTree(); };
  const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete';
  del.onclick = () => { scene.removeSelectedProp(); renderTree(); };
  tree.append(document.createElement('br'), add, dup, del);
}

scene.onChange(() => renderTree());
```

Call `renderTree()` at the end of `refresh()` and after `scene.loadLevel(...)` in the dropdown/new handlers.

- [ ] **Step 3: Build + headless smoke**

Run: `npm run build` → `✓ built`, no type errors.
Headless: open `/level.html`; assert tree shows "🗺 Map" + "🏁 Track" + "＋ Add model"/"Duplicate"/"Delete" buttons; click a tree row → it gets `.sel`; no `pageerror`.

- [ ] **Step 4: Commit**

```bash
git add client/level-scene.ts client/level.ts
git commit -m "feat: level editor scene tree + add/duplicate/delete decoration props"
```

---

## Phase 5 — Inspector panel: transform, track/curve, cars, lighting, effects

### Task 5: Inspector for selected object + cars panel + sample cars (`client/level-panels.ts`, `client/level.ts`, `client/level-scene.ts`)

**Files:**
- Create: `client/level-panels.ts` (pure-ish DOM builders for the inspector sections; each takes the live value + an onChange callback)
- Modify: `client/level.ts` (render the right `#panel` from the selection; wire car master/override + sample-cars toggle)
- Modify: `client/level-scene.ts` (expose `setCarPreview(on, scale, overrides)`; reuse the track/curve `CurveEditor` for the Track inspector)
- Test: build + headless smoke; the value-shaping math (`resolveCarScale`) is already unit-tested in Task 1.

**Interfaces:**
- Consumes: `resolveCarScale`, `LevelConfig` from `shared/level`; `CurveEditor` from `client/align-curve`; `AssetLoader` (`carTemplate`) + `buildCar` for sample cars.
- Produces:
  - `client/level-panels.ts`: `function transformPanel(host, obj3d, onChange)`, `function carsPanel(host, level, carGlbs, onChange)`, `function numberRow(host, label, value, min, max, step, onInput)`, `function colorRow(host, label, hex, onInput)`. Each appends DOM to `host` and calls back on edit.
  - `LevelScene`: `setCarPreview(on: boolean): void` (drops N sample cars at the track start at the resolved scale; rebuilt on car-scale change), `getLevel(): LevelConfig` (mutable ref for panels), `applyCars(): void` (re-scale preview cars).

- [ ] **Step 1: Create `level-panels.ts`** (reusable control rows)

```ts
// client/level-panels.ts
// DOM builders for the inspector. Each appends a labelled control to `host` and invokes a callback
// on edit. Kept free of three.js so they're trivial to reason about and reuse across sections.
export function numberRow(host: HTMLElement, label: string, value: number,
  min: number, max: number, step: number, onInput: (v: number) => void): void {
  const l = document.createElement('label'); l.textContent = label;
  const inp = document.createElement('input'); inp.type = 'range';
  inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
  const num = document.createElement('input'); num.type = 'number'; num.value = String(value); num.step = String(step);
  const sync = (v: number) => { inp.value = String(v); num.value = String(v); onInput(v); };
  inp.oninput = () => sync(parseFloat(inp.value));
  num.oninput = () => sync(parseFloat(num.value));
  l.append(inp, num); host.append(l);
}

export function colorRow(host: HTMLElement, label: string, hex: string, onInput: (hex: string) => void): void {
  const l = document.createElement('label'); l.textContent = label;
  const c = document.createElement('input'); c.type = 'color'; c.value = hex;
  c.oninput = () => onInput(c.value);
  l.append(c); host.append(l);
}

export function heading(host: HTMLElement, text: string): void {
  const h = document.createElement('h4'); h.textContent = text; host.append(h);
}
```

- [ ] **Step 2: Add car preview + level ref to `LevelScene`**

```ts
// imports
import { AssetLoader } from './asset-loader';
import { buildCar } from './car-factory';
import { resolveCarScale } from '../shared/level';
import { laneX, LANES } from '../shared/constants';
```

```ts
// fields
private assets = new AssetLoader();
private previewCars = new THREE.Group();
private carPreviewOn = false;

// in constructor, kick off (non-blocking): this.assets.loadManifest().catch(()=>{});
// in loadLevel(), add: this.trackGroup.add(this.previewCars); this.applyCars();

getLevel(): LevelConfig { return this.level; }

setCarPreview(on: boolean): void { this.carPreviewOn = on; this.applyCars(); }

/** (Re)build sample cars at the start of each lane, scaled by the level's resolved car scale. */
applyCars(): void {
  this.previewCars.clear();
  if (!this.carPreviewOn) return;
  for (let lane = 0; lane < LANES; lane++) {
    const tmpl = this.assets.carTemplate(lane);
    const glb = tmpl?.userData.srcFile as string | undefined;   // see note below
    const model = buildCar(tmpl ?? null, '#36d1dc', false);
    const wrap = new THREE.Group(); wrap.add(model);
    const s = resolveCarScale(this.level, glb ?? `car${lane}`);
    wrap.scale.setScalar(s);
    wrap.position.set(laneX(lane), 0.6, 20);
    this.previewCars.add(wrap);
  }
  this.changeCb();
}
```

NOTE: car GLB filenames for overrides come from the manifest. If `AssetLoader` does not already tag templates with their source filename, use the manifest car index as the override KEY instead (e.g. `car0/car1/...`). Keep the override key consistent between this preview and the game (Task 6 game-side car scaling must use the SAME key). Simplest robust choice: key overrides by car INDEX string (`"0"`, `"1"`, ...) since the game assigns cars by index; update `resolveCarScale` callers accordingly and document it in the cars panel ("Car 1, Car 2…").

- [ ] **Step 3: Render the inspector in `level.ts`**

Replace/extend the panel rendering so selecting a tree row fills `#panel`:

```ts
import { numberRow, colorRow, heading } from './level-panels';

const panel = document.getElementById('panel')!;
function renderPanel(): void {
  panel.replaceChildren();
  const key = scene.selectedKey();
  heading(panel, key === 'map' ? 'Map' : key === 'track' ? 'Track' : `Prop ${key}`);
  // Transform sliders read/write the live object via scene helpers (Task 6 adds track curve tools here).
  // For brevity transforms are edited with the gizmo; numeric fine-tune rows can be added per object.

  // Cars section (always shown — it's level-wide)
  heading(panel, 'Cars');
  const lvl = scene.getLevel();
  numberRow(panel, 'All cars size', lvl.cars.masterScale, 0.1, 10, 0.05, (v) => {
    lvl.cars.masterScale = v; scene.applyCars();
  });
  const toggle = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox';
  cb.onchange = () => scene.setCarPreview(cb.checked);
  toggle.append(cb, document.createTextNode(' Show sample cars')); panel.append(toggle);
  for (let i = 0; i < LANES_PREVIEW; i++) {
    numberRow(panel, `Car ${i + 1} tweak`, lvl.cars.overrides[String(i)] ?? 1, 0.2, 5, 0.05, (v) => {
      lvl.cars.overrides[String(i)] = v; scene.applyCars();
    });
  }
}
const LANES_PREVIEW = 3;
scene.onChange(() => { renderTree(); renderPanel(); });
```

Call `renderPanel()` after load and selection.

- [ ] **Step 4: Build + headless smoke**

Run: `npm run build` → `✓ built`.
Headless: open `/level.html`; assert `#panel` contains "Cars" + "All cars size"; toggle "Show sample cars" → no `pageerror`; screenshot `/tmp/shots/level-cars.png` and read it to confirm sample cars appear on the track.

- [ ] **Step 5: Commit**

```bash
git add client/level-panels.ts client/level.ts client/level-scene.ts
git commit -m "feat: level editor inspector + per-level car scale with live sample cars"
```

---

### Task 6: Track/curve inspector + lighting + effects panels + game car scale (`client/level.ts`, `client/level-scene.ts`, `client/renderer.ts`)

**Files:**
- Modify: `client/level-scene.ts` (embed the align `CurveEditor` for the Track selection; expose lighting/effects edit that live-applies to the editor scene; store into `this.level`)
- Modify: `client/level.ts` (Track inspector shows curve/width buttons; Lighting + Effects sections with sliders/color pickers)
- Modify: `client/renderer.ts` (game: multiply each car's scale by the level's resolved car scale — the missing game-side half of per-level car sizing)
- Test: build + headless smoke + a renderer car-scale logic check.

**Interfaces:**
- Consumes: `CurveEditor` (existing), `DEFAULT_LIGHTING`, `DEFAULT_EFFECTS`, `resolveCarScale` from `shared/level`.
- Produces:
  - `LevelScene`: `editingTrack(): boolean`, exposes its `CurveEditor` so the panel's curve buttons (bend/add/delete/smoothing/width) drive it; `setLighting(l)`, `setEffects(e)` that live-apply to the editor scene AND store into `this.level`.
  - `Renderer`: `setCarScale(fn: (carIndex: number) => number)` — supplies the per-car multiplier the game applies in `ensureCar`/`render` when placing each car (keyed by car index to match the editor's override key).

- [ ] **Step 1: Game-side car scale (the half that makes editor car sizing real in-game)**

In `client/renderer.ts`, add a field + setter and apply it where cars are scaled:

```ts
private carScale: (i: number) => number = () => 1;
setCarScale(fn: (i: number) => number): void { this.carScale = fn; }
```

In `ensureCar(...)` (where the wrapper/model is built), after building, apply the index-based scale to the wrapper (NOT the inner model, to preserve grounding):

```ts
// idx is the per-car index already computed in ensureCar
wrapper.scale.setScalar(this.carScale(idx));
```

In `client/main.ts`, after `renderer.setProps(level.props)`:

```ts
import { resolveCarScale } from '../shared/level';
renderer.setCarScale((i) => resolveCarScale(level, String(i)));
```

Renderer logic test (`tests/renderer-level.test.ts`, add a case using a pure mirror): assert `resolveCarScale(level, '0')` returns master×override and `'9'` returns master — already covered by Task 1; add an explicit `String(index)` keying test:

```ts
import { levelDefaults, resolveCarScale } from '../shared/level';
it('keys car overrides by index string', () => {
  const l = levelDefaults('m', 'm.glb'); l.cars.masterScale = 1.5; l.cars.overrides['2'] = 2;
  expect(resolveCarScale(l, '2')).toBe(3);
  expect(resolveCarScale(l, '0')).toBe(1.5);
});
```

- [ ] **Step 2: Track/curve inspector**

In `LevelScene.loadLevel`, when a level has/needs a path, instantiate a `CurveEditor` (from `client/align-curve`) attached under `trackGroup` instead of the static `buildTrackSurface` surface, so the Track inspector can bend it. Expose it:

```ts
import { CurveEditor } from './align-curve';
private curve: CurveEditor | null = null;
// in loadLevel, replace the static surface with:
this.curve = new CurveEditor(this.level.path);
this.trackGroup.add(this.curve.group);
getCurve(): CurveEditor | null { return this.curve; }
// in current(): include path: this.curve ? this.curve.toPath() : this.level.path
```

In `level.ts`, when `scene.selectedKey()==='track'`, render curve buttons that call the existing `CurveEditor` methods (`addPointAt` is pointer-driven in the align tool — here expose simple buttons: "Bend mode" hint, "Straighten", "Sharper/Smoother corners", "Wider/Narrower sides", "Lanes wider/narrower") wired to `getCurve()` setters that already exist (`setSmoothing`, `setShoulder`, `setLaneScale`, `reset`). Pointer-drag point editing can reuse the align interaction in a later pass; buttons cover the core in-panel controls.

- [ ] **Step 3: Lighting + Effects panels**

In `level.ts` `renderPanel()`, append (always available, level-wide):

```ts
const lvl = scene.getLevel();
lvl.lighting = lvl.lighting ?? structuredClone(DEFAULT_LIGHTING);
heading(panel, 'Lighting (replaces zones)');
numberRow(panel, 'Sun intensity', lvl.lighting.sunIntensity, 0, 6, 0.05, v => { lvl.lighting!.sunIntensity = v; scene.applyLighting(); });
numberRow(panel, 'Sun X', lvl.lighting.sunPos[0]!, -500, 500, 5, v => { lvl.lighting!.sunPos[0] = v; scene.applyLighting(); });
numberRow(panel, 'Sun Y', lvl.lighting.sunPos[1]!, 0, 1000, 5, v => { lvl.lighting!.sunPos[1] = v; scene.applyLighting(); });
numberRow(panel, 'Sun Z', lvl.lighting.sunPos[2]!, -500, 500, 5, v => { lvl.lighting!.sunPos[2] = v; scene.applyLighting(); });
colorRow(panel, 'Sun color', lvl.lighting.sunColor, h => { lvl.lighting!.sunColor = h; scene.applyLighting(); });
numberRow(panel, 'Ambient', lvl.lighting.ambientIntensity, 0, 3, 0.05, v => { lvl.lighting!.ambientIntensity = v; scene.applyLighting(); });
colorRow(panel, 'Sky color', lvl.lighting.skyColor, h => { lvl.lighting!.skyColor = h; scene.applyLighting(); });
colorRow(panel, 'Ground color', lvl.lighting.groundColor, h => { lvl.lighting!.groundColor = h; scene.applyLighting(); });
numberRow(panel, 'Exposure', lvl.lighting.exposure, 0.2, 3, 0.05, v => { lvl.lighting!.exposure = v; scene.applyLighting(); });

lvl.effects = lvl.effects ?? structuredClone(DEFAULT_EFFECTS);
heading(panel, 'Effects');
numberRow(panel, 'Bloom strength', lvl.effects.bloom.strength, 0, 3, 0.05, v => { lvl.effects!.bloom.strength = v; scene.applyEffects(); });
numberRow(panel, 'Bloom radius', lvl.effects.bloom.radius, 0, 2, 0.05, v => { lvl.effects!.bloom.radius = v; scene.applyEffects(); });
numberRow(panel, 'Bloom threshold', lvl.effects.bloom.threshold, 0, 1, 0.01, v => { lvl.effects!.bloom.threshold = v; scene.applyEffects(); });
numberRow(panel, 'Fog density', lvl.effects.fog.density, 0, 0.02, 0.0005, v => { lvl.effects!.fog.density = v; scene.applyEffects(); });
colorRow(panel, 'Fog color', lvl.effects.fog.color, h => { lvl.effects!.fog.color = h; scene.applyEffects(); });
numberRow(panel, 'Track glow', lvl.effects.trackEmissive, 0, 4, 0.05, v => { lvl.effects!.trackEmissive = v; scene.applyEffects(); });
numberRow(panel, 'Pulse speed', lvl.effects.pulse.speed, 0, 6, 0.1, v => { lvl.effects!.pulse.speed = v; scene.applyEffects(); });
numberRow(panel, 'Pulse amount', lvl.effects.pulse.amount, 0, 1, 0.02, v => { lvl.effects!.pulse.amount = v; scene.applyEffects(); });
colorRow(panel, 'Sky top', lvl.effects.skyTop, h => { lvl.effects!.skyTop = h; scene.applyEffects(); });
colorRow(panel, 'Sky bottom', lvl.effects.skyBottom, h => { lvl.effects!.skyBottom = h; scene.applyEffects(); });
```

Add `applyLighting()` / `applyEffects()` to `LevelScene` that mirror the renderer setters onto the EDITOR scene (sun light, ambient, the editor's own bloom/fog if present, sky dome). Since the editor scene is simpler (no composer required), `applyEffects` may only tint the surface emissive + fog; document that the FULL bloom/sky preview is verified by launching the game. Store all values into `this.level` so `current()` saves them.

- [ ] **Step 4: Build + headless smoke + game verify**

Run: `npm test` → all green (incl. new car-index test). `npm run build` → `✓ built`.
Headless editor: open `/level.html`; assert `#panel` shows "Lighting (replaces zones)" + "Effects" + sliders; drag sun intensity → no error; Save → POST ok. Screenshot.
Headless game: save a level with lighting via the API, then open `/play.html?...&map=<that>`; assert canvas + no error (zones now skipped for it).

- [ ] **Step 5: Commit**

```bash
git add client/level.ts client/level-scene.ts client/renderer.ts client/main.ts tests/renderer-level.test.ts
git commit -m "feat: level editor track/curve + lighting + effects panels; game applies per-level car scale"
```

---

## Self-Review

**Spec coverage:** map/track transform (Task 3), curve+width (Task 6), props add/dup/delete (Tasks 1,4), car master+override+sample cars (Tasks 1,5,6), lighting incl. movable sun (Task 6), effects bloom/fog/glow/pulse/sky (Task 6), per-level lighting replaces zones (Task 2), retire maptest + keep model studio (Task 3), save-one-level (Tasks 3), back-compat (Task 1 `mergeLevel`), no sim change (all tasks). All covered.

**Open implementation note (resolve during execution):** the override KEY is car INDEX string (`"0".."N"`) — used identically by the editor preview (Task 5), the cars panel (Task 5), and the game (Task 6). Do not switch to GLB filename keys without updating all three.

**Type consistency:** `LevelConfig`/`LevelTransform`/`PlacedProp`/`LevelLighting`/`LevelEffects` defined once in Task 1 and imported everywhere; `resolveCarScale(level, key)` signature stable; renderer setters `setLighting/setEffects/setProps/setCarScale` named consistently across Tasks 2 and 6.
