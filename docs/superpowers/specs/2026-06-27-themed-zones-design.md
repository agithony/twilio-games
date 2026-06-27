# Themed Zones — Design

**Date:** 2026-06-27
**Status:** Approved (autonomous build — user authorized continuing Phase 5)
**Milestone:** Plan 5c (completes Phase 5 visual work)

## Purpose & Scope

Make the straight track pass through distinct visual **zones** (e.g. neon tunnel → city dusk →
desert) so the world feels varied and produced, without requiring scenery-prop assets (the
user's 19 assets are all vehicles). Zones are an **atmosphere system**: as a car drives
forward, the sky color, ground color, fog, and lighting smoothly interpolate between zone
themes keyed to track distance.

**In scope:**
- A pure `themeAtZ(z, zones)` that returns the interpolated atmosphere for a given track-z.
- A default set of 3-4 zone themes tiled over one lap (`z mod TRACK_LEN`), so each lap cycles
  through the journey.
- Renderer integration: per-frame, apply the theme at the camera's z (background/fog/ground/
  sun/ambient), interpolated so transitions are seamless.

**Explicitly NOT in scope:** scenery props/buildings (no assets), per-zone hazard skins,
editor UI for zones (themes live in a shared config; editor authoring is a later plan),
server changes (zones are deterministic from z — every client agrees without coordination).

**Success criteria:** Driving the track visibly transitions through colored zones (no hard
seams), the game still runs with zero models (atmosphere is independent of assets), and the
zone math is unit-tested. No server/sim change; primitive + real-model paths both themed.

## Architecture

- **`shared/zones.ts` (pure, the contract + math):**
  - `interface ZoneTheme { name; sky; ground; fog; fogDensity; sun; sunIntensity; ambient }` (colors as `#rrggbb` strings).
  - `interface Zone { startZ: number; theme: ZoneTheme }` — a zone begins at `startZ` (within one lap, `0..TRACK_LEN`).
  - `DEFAULT_ZONES: Zone[]` — 3-4 themes spanning `[0, TRACK_LEN)`.
  - `themeAtZ(z: number, zones?: Zone[]): ResolvedTheme` — wraps z by `TRACK_LEN`, finds the
    surrounding pair, and **lerps every color + scalar** across a blend band so the result is
    continuous. Pure, deterministic, no THREE dependency (operates on hex strings + numbers,
    returns the same).
- **`client/renderer.ts` (apply):** add `scene.fog`; cache references to sun + ambient +
  ground material (currently local consts — promote to fields); each frame compute
  `themeAtZ(cameraZ)` and set `scene.background`, `fog.color`/`density`, `ground.material.color`,
  `sun.color`/`intensity`, `ambient.color`. The camera already follows the player's z, so the
  world re-themes as you race.

## Testing

- `themeAtZ` unit-tested (pure): returns a zone's exact theme at its center; blends toward the
  next at boundaries (a midpoint color is between the two); wraps correctly at `TRACK_LEN`
  (z=TRACK_LEN equals z=0); handles a single-zone list (constant). Color-lerp helper tested.
- Renderer integration verified by build + typecheck + headless browser smoke (atmosphere
  changes with z; no console errors; runs with no manifest).

## Risks

- **Fog hiding cars / hurting readability** — keep fog subtle (low density, far), tuned so the
  side-camera pack stays clearly visible. Verified in the smoke test.
- **Color pops at the lap wrap (z=TRACK_LEN→0)** — `themeAtZ` must treat the zone list as
  cyclic so the last zone blends back into the first. Explicitly tested.
