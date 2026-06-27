# Themed Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** The track visibly transitions through colored atmosphere zones (neon → city → desert → night) as cars drive, with no new assets and no server change.

**Architecture:** A pure `themeAtZ(z)` in `shared/` interpolates zone atmosphere (sky/ground/fog/light colors) by track distance, cyclic over one lap. The renderer applies it each frame at the camera's z. Deterministic from z, so all clients agree with no coordination.

**Tech Stack:** TypeScript strict, three.js (Fog/colors in renderer), Vitest.

## Global Constraints

- ES modules, TS strict, noUncheckedIndexedAccess.
- `shared/zones.ts` is PURE — no THREE import; colors are `#rrggbb` strings, operates on numbers/strings.
- Zones are deterministic from track-z (`z mod TRACK_LEN`); no server/sim change.
- Atmosphere must not break readability — fog subtle, cars stay visible. Game runs with zero models.
- DRY, YAGNI, TDD, frequent commits.

---

### Task 1: Zone themes + `themeAtZ` (pure)

**Files:** Create `shared/zones.ts`, `tests/zones.test.ts`.

**Interfaces:**
- `interface ZoneTheme { name: string; sky: string; ground: string; fog: string; fogDensity: number; sun: string; sunIntensity: number; ambient: string }`
- `interface Zone { startZ: number; theme: ZoneTheme }`
- `const DEFAULT_ZONES: Zone[]`
- `function themeAtZ(z: number, zones?: Zone[]): ZoneTheme` — cyclic over `TRACK_LEN`, lerps all colors + scalars between the two surrounding zones.
- `function lerpHexColor(a: string, b: string, t: number): string` (exported for test).

- [ ] **Step 1: Write the failing test** — `tests/zones.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { themeAtZ, lerpHexColor, DEFAULT_ZONES } from '../shared/zones';
import { TRACK_LEN } from '../shared/constants';

describe('lerpHexColor', () => {
  it('returns endpoints at t=0 and t=1', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpHexColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
  it('blends to the midpoint', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0.5)).toBe('#808080'); // 127.5→128 rounded
  });
});

describe('themeAtZ', () => {
  it('returns a stable theme shape with all fields', () => {
    const t = themeAtZ(0);
    expect(typeof t.sky).toBe('string');
    expect(t.sky).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof t.fogDensity).toBe('number');
    expect(typeof t.sunIntensity).toBe('number');
  });
  it('is cyclic: z=0 equals z=TRACK_LEN equals z=2*TRACK_LEN', () => {
    expect(themeAtZ(0)).toEqual(themeAtZ(TRACK_LEN));
    expect(themeAtZ(50)).toEqual(themeAtZ(TRACK_LEN + 50));
  });
  it('at a zone start, matches that zone theme exactly', () => {
    const z0 = DEFAULT_ZONES[0]!;
    expect(themeAtZ(z0.startZ).sky).toBe(z0.theme.sky);
  });
  it('between two zones, sky is a blend of the two (not equal to either endpoint)', () => {
    // midpoint between zone 0 and zone 1 starts
    const a = DEFAULT_ZONES[0]!, b = DEFAULT_ZONES[1]!;
    const mid = (a.startZ + b.startZ) / 2;
    const sky = themeAtZ(mid).sky;
    expect(sky).not.toBe(a.theme.sky);
    expect(sky).not.toBe(b.theme.sky);
  });
  it('a single-zone list yields that zone everywhere (constant)', () => {
    const one = [{ startZ: 0, theme: DEFAULT_ZONES[0]!.theme }];
    expect(themeAtZ(10, one)).toEqual(themeAtZ(300, one));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- zones` → cannot find module.

- [ ] **Step 3: Implement `shared/zones.ts`**

```ts
import { TRACK_LEN } from './constants';

export interface ZoneTheme {
  name: string;
  sky: string; ground: string; fog: string; fogDensity: number;
  sun: string; sunIntensity: number; ambient: string;
}
export interface Zone { startZ: number; theme: ZoneTheme; }

export const DEFAULT_ZONES: Zone[] = [
  { startZ: 0, theme: { name: 'Neon Tunnel',
    sky: '#0b1020', ground: '#141a33', fog: '#1a1140', fogDensity: 0.010,
    sun: '#6a5cff', sunIntensity: 1.0, ambient: '#3a2a66' } },
  { startZ: TRACK_LEN * 0.25, theme: { name: 'City Dusk',
    sky: '#241a3a', ground: '#2a2440', fog: '#3a2c52', fogDensity: 0.008,
    sun: '#ff9e64', sunIntensity: 1.15, ambient: '#5a4a7a' } },
  { startZ: TRACK_LEN * 0.5, theme: { name: 'Desert Noon',
    sky: '#9ec6e6', ground: '#caa46a', fog: '#d8c39a', fogDensity: 0.006,
    sun: '#fff6e6', sunIntensity: 1.4, ambient: '#b7a98a' } },
  { startZ: TRACK_LEN * 0.75, theme: { name: 'Night Coast',
    sky: '#04101e', ground: '#0c1f2e', fog: '#06223a', fogDensity: 0.012,
    sun: '#4cc9ff', sunIntensity: 0.85, ambient: '#173a4a' } },
];

function clamp01(t: number) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.round(clamp01(n/255)*255).toString(16).padStart(2,'0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
export function lerpHexColor(a: string, b: string, t: number): string {
  const tt = clamp01(t);
  const [ar,ag,ab] = hexToRgb(a), [br,bg,bb] = hexToRgb(b);
  return rgbToHex(ar+(br-ar)*tt, ag+(bg-ag)*tt, ab+(bb-ab)*tt);
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

function blend(a: ZoneTheme, b: ZoneTheme, t: number): ZoneTheme {
  return {
    name: t < 0.5 ? a.name : b.name,
    sky: lerpHexColor(a.sky, b.sky, t),
    ground: lerpHexColor(a.ground, b.ground, t),
    fog: lerpHexColor(a.fog, b.fog, t),
    fogDensity: lerp(a.fogDensity, b.fogDensity, t),
    sun: lerpHexColor(a.sun, b.sun, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    ambient: lerpHexColor(a.ambient, b.ambient, t),
  };
}

/** Atmosphere at a given track-z, cyclic over one lap, blended between zones. */
export function themeAtZ(z: number, zones: Zone[] = DEFAULT_ZONES): ZoneTheme {
  if (zones.length === 1) return zones[0]!.theme;
  const span = TRACK_LEN;
  const zz = ((z % span) + span) % span;
  // find the zone whose [startZ, nextStartZ) contains zz (cyclic)
  let i = 0;
  for (let k = 0; k < zones.length; k++) {
    const start = zones[k]!.startZ;
    const next = k + 1 < zones.length ? zones[k+1]!.startZ : span;
    if (zz >= start && zz < next) { i = k; break; }
  }
  const cur = zones[i]!;
  const nextIdx = (i + 1) % zones.length;
  const nextStart = nextIdx === 0 ? span : zones[nextIdx]!.startZ;
  const segLen = nextStart - cur.startZ || 1;
  const t = (zz - cur.startZ) / segLen;
  return blend(cur.theme, zones[nextIdx]!.theme, t);
}
```

- [ ] **Step 4: Run to verify it passes** — `npm test -- zones`. (Note the midpoint test: blend at the *geometric* midpoint of two startZ uses the segment-relative t; since zones are evenly spaced the midpoint t≈0.5 so sky differs from both endpoints — assertion holds.)

- [ ] **Step 5: Typecheck + commit**
```bash
git add shared/zones.ts tests/zones.test.ts
git commit -m "feat: pure themed-zone atmosphere (themeAtZ) + default zones"
```

---

### Task 2: Apply zones in the renderer

**Files:** Modify `client/renderer.ts`.

**Interfaces:** Consumes `themeAtZ` (Task 1).

- [ ] **Step 1: Promote sun/ambient/ground to fields + add fog**

In the constructor, change the local `sun`, `ambient`, and `track` consts to instance fields
(`private sun`, `private ambient`, `private ground`), and add exponential fog:
`this.scene.fog = new THREE.FogExp2(0x0b1020, 0.01);`. Keep all existing positions/shadows.

- [ ] **Step 2: Apply the theme each frame**

In `render()`, after computing the camera target z (`z`), apply the zone theme:
```ts
import { themeAtZ } from '../shared/zones';
// ...in render(), using the player/camera z already computed:
const theme = themeAtZ(z);
(this.scene.background as THREE.Color).set(theme.sky);
const fog = this.scene.fog as THREE.FogExp2;
fog.color.set(theme.fog); fog.density = theme.fogDensity;
this.ground.material.color.set(theme.ground);   // ground.material typed as MeshStandardMaterial
this.sun.color.set(theme.sun); this.sun.intensity = theme.sunIntensity;
this.ambient.color.set(theme.ambient);
```
Cast `this.ground.material` to `THREE.MeshStandardMaterial` for `.color`. Ensure
`scene.background` is created as a `THREE.Color` (it already is) so `.set` works.

- [ ] **Step 3: Typecheck + build**
Run: `npm run typecheck && npm run build` → clean + builds.

- [ ] **Step 4: Headless smoke**
Start server + vite; load `http://localhost:5173/?display=1&room=4821`; advance time so the
race runs; confirm: no console errors, the background/ground color differs at different car
z-positions (sample two frames a few seconds apart), cars remain clearly visible (fog not too
thick). Also confirm it runs with no manifest (primitives). Report observations. Kill servers.

- [ ] **Step 5: Full suite + commit**
Run: `npm test` (89 + zones tests pass).
```bash
git add client/renderer.ts
git commit -m "feat: apply themed-zone atmosphere in renderer (sky/fog/ground/light by track-z)"
```

---

## Self-Review
(author check below)
