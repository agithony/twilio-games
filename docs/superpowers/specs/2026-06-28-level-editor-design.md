# Unified Level Editor — Design

**Date:** 2026-06-28
**Status:** Approved (pending spec review)
**Relation:** Fulfills "Plan 5b — studio editor expansion" with a concrete, expanded goal: replace
the three separate editors (`/editor` model studio, `/maptest` strip-on-track, `/align` track+curve)
with ONE polished level editor. Builds directly on this session's align tool work (`track-path`,
`track-surface`, `align-curve`, `map-world`).

## Purpose & Scope

A single page where you pick a **level** from a dropdown and edit *everything about that level* in
one place — the world map, the race track + curve, placed decoration models, per-level car sizing,
lighting, and visual effects — then **Save** writes just that level. Pick another level → its full
contents load. Each level is a self-contained world.

**In scope:**
- One editor page (repurpose `/editor`) with a level dropdown + "New level" + per-level Save.
- Edit, per level: map (world GLB) transform; track transform; curve (points/smoothing); lane
  width + side shoulders; decoration props (add from GLB library, move/rotate/scale, duplicate,
  delete); car sizing (level master scale + per-car overrides) with live sample cars on the track;
  lighting (sun position + intensity + color, ambient intensity + sky/ground color, exposure);
  effects (bloom strength/radius/threshold, fog density/color, track emissive, optional pulse,
  sky dome top/bottom colors).
- The game (`play.html`) applies a level's saved lighting/effects and, when present, SKIPS the
  zone auto-cycling for that level (per-level look replaces zones).
- Retire `/maptest` (fully superseded by the level editor's track/curve tools); remove its rollup
  input. Keep the existing model studio (`/editor/editor.html`) as a secondary "Models library"
  for global role/manifest editing (see note under NOT in scope).

**Explicitly NOT in scope:**
- Hand-placing gameplay obstacles (barriers/boosts stay auto-spawned by the server sim).
- Per-level *car model selection* (which GLB is which car stays global in the manifest); only car
  SCALE is per-level. Decoration props are visual-only (no collision, no sim involvement).
  NOTE: the global manifest (which GLB fills each car/barrier/boost role + their base scale/offset)
  is still edited by the EXISTING model studio, which we keep reachable as a secondary "Models
  library" tool. The new Level Editor consumes that manifest (it lists the car GLBs for per-level
  scaling and the prop GLBs for placement) but does not replace global role assignment. Only
  `/maptest` is fully retired.
- Any change to `shared/` sim, lap logic, or collisions. The 123 sim tests must stay green.
- ConversationRelay announcer (Plan 3) — deferred; separate spec.

**Success criteria:** From one page you can switch levels, edit all of the above with live preview,
and save per level; the game renders a saved level with its own lighting/effects (no zone cycling);
sample cars show correct in-game size while editing; pure serialization/defaults/car-scale helpers
are unit-tested; `/maptest` and standalone model studio are gone; build + headless smoke clean.

## Architecture

### Data model — a "level" in `maps.json`
Each map key extends today's `{ file, model, track, path }` with new optional fields. Missing
fields fall back to current engine defaults (back-compat: existing `silver_lake` keeps working).

```ts
interface LevelConfig {
  map: string;                                  // key
  file: string;                                 // world GLB filename
  model: MapTransform;                          // world GLB transform (pos/rotDeg/scale)
  track: MapTransform;                          // canonical race track transform
  path?: TrackPath;                             // curve: points[], laneScale, shoulder, smoothing
  cars?: { masterScale: number;                 // multiplies ALL cars on this level
           overrides?: Record<string, number> } // per-car-GLB scale (keyed by glb filename)
  props?: PlacedProp[];                         // decoration models placed in the level
  lighting?: LevelLighting;                     // per-level look (replaces zone cycling when set)
  effects?: LevelEffects;
}
interface PlacedProp { id: string; file: string; pos: number[]; rotDeg: number[]; scale: number; }
interface LevelLighting {
  sunPos: number[]; sunIntensity: number; sunColor: string;
  ambientIntensity: number; skyColor: string; groundColor: string; exposure: number;
}
interface LevelEffects {
  bloom: { strength: number; radius: number; threshold: number };
  fog: { density: number; color: string };
  trackEmissive: number;                        // lane-glow emissive multiplier
  pulse?: { speed: number; amount: number };    // optional emissive pulse (0 amount = off)
  skyTop: string; skyBottom: string;
}
```

`MapTransform`, `TrackPath` already exist in `client/map-world.ts`. New types live alongside them.
Pure helpers: `levelDefaults()` (engine defaults), `mergeLevel(saved)` (fill missing → full
LevelConfig), `resolveCarScale(level, glb)` (master × override). These are unit-tested.

### Server
- GET `/api/maps` already returns all level configs (drives the dropdown). No change needed.
- POST `/api/maps` already merges one posted level by key. No change needed (it stores verbatim).
- GET `/api/assets` already lists GLBs (drives the "Add model" library + car list). No change.
- Map/world GLBs already served from `assets/maps/`; props can come from `assets/` (existing
  static route). New levels reference an existing GLB chosen in the dropdown.

### Client — the editor (`client/level.ts` + `client/level.html`, served at `/level.html`)
(The existing model studio stays at `/editor/editor.html` as the secondary Models library; the new
Level Editor is the primary "edit a whole level" tool and the one linked from the home page.)
Reuses the align tool's proven pieces as a library:
- `track-path.ts` / `track-surface.ts` — curve + 3-lane surface (unchanged).
- `align-curve.ts` `CurveEditor` — curve point editing (unchanged).
- `map-world.ts` — load/transform helpers; gains the new Level types + pure helpers.
- The align-mode interaction code (gizmo, screen-space point picking, axis lock, framing,
  unlimited-zoom dynamic near/far, undo/redo, per-object reset) is generalized so the editor can
  attach the gizmo to ANY selected object (map, track, or a prop), not just track/map.

Screen layout:
- **Top bar:** level `<select>` (from GET /api/maps) · "＋ New level" (prompt for key + pick world
  GLB) · "💾 Save level" (POST the current LevelConfig).
- **Left — Scene tree:** fixed rows Map, Track, Cars; then one row per placed prop. Selecting a row
  attaches the gizmo + swaps the inspector. Buttons: **＋ Add model** (opens GLB library →
  places a prop at the track start, selected), **Duplicate** (clones selected prop), **Delete**.
- **Right — Inspector** (by selection):
  - *Map / Prop:* position, rotation, scale (numeric + gizmo).
  - *Track:* transform + the curve/width tools from the align tool (bend, add/move/delete points,
    smoothing, shoulders, lane width).
  - *Cars:* master-scale slider + a list of car GLBs each with an override scale; "sample cars"
    toggle.
  - *Lighting:* sun position (gizmo-movable point + numeric), sun intensity/color, ambient
    intensity, sky color, ground color, exposure.
  - *Effects:* bloom strength/radius/threshold, fog density/color, track emissive, pulse
    speed/amount, sky top/bottom colors.
- **Center — 3D view:** gizmo + camera controls reused from align. A "sample cars" toggle drops a
  few real car GLBs at the track start at the resolved car scale, updating live.

### Game (`client/main.ts` + `client/renderer.ts`)
- On loading a level with `lighting`/`effects`, the renderer applies them and disables per-frame
  zone cycling for that race (per-level look replaces zones). Levels without them keep current
  behavior (zones cycle) — back-compat.
- Renderer gains setters: `setLighting(LevelLighting)`, `setEffects(LevelEffects)`,
  `setProps(PlacedProp[])` (load + place decoration GLBs), and the existing `setPath` already
  handles curve/width. Car scale flows through the existing per-car placement (multiplying the
  current scale by the resolved level car scale).
- Decoration props render in the scene (visual only); the sim never sees them.

## Build phases (one plan, sequenced tasks)
1. **Types + pure helpers + game-applies-lighting/effects/props** (renderer setters; zone-skip when
   a level defines lighting). Unit tests for helpers; game still runs.
2. **Editor shell + level dropdown + Save/New** (load a level, show map+track, save it). Add the
   `level.html` rollup input; remove the `maptest` rollup input + delete `maptest.ts`/`maptest.html`.
   Link the Level Editor from the home page (keep the model-studio link as "Models library").
3. **Scene tree + props** (add/duplicate/delete decoration models, gizmo on any selection).
4. **Cars panel** (master + per-car scale, sample cars live preview).
5. **Lighting + Effects panels** (all sliders, movable sun, live preview).

## Error handling
- Missing/empty `maps.json` → empty dropdown + "New level" still works.
- GLB load failure (world or prop) → skip with a toast; editor stays usable.
- Saving never wipes other levels (POST merges by key, as today).
- New-level key collision → confirm overwrite.
- Server unreachable on save → toast; values stay in the editor (no data loss mid-session).

## Testing
- **Pure (unit):** `levelDefaults`, `mergeLevel` (back-compat fill), `resolveCarScale`,
  prop add/duplicate/delete on a level object, serialize↔deserialize round-trip.
- **Renderer (logic):** applying a LevelLighting/LevelEffects sets the expected values and disables
  zone cycling; props build into the scene.
- **Smoke (headless):** editor loads, dropdown lists levels, switching loads a level, Save POSTs;
  game renders a saved level with its lighting; no console errors. Screenshot top + 3-D.
- All 123 existing sim tests stay green (no `shared/` change).

## Risks
- **Per-level lighting vs zones conflict** — resolved: a level with `lighting` disables zone
  cycling entirely for that race (chosen). Levels without it are unchanged.
- **Scope is large** — mitigated by the 5-phase sequence; each phase leaves a working app.
- **Reusing align interaction code** — generalize "selected object" from {track,map} to any
  object incl. props + the sun handle; keep the align tool's behavior intact by extracting shared
  helpers rather than forking.
- **Back-compat** — every new field optional; `mergeLevel` fills defaults so existing
  `silver_lake` and older configs load unchanged.
