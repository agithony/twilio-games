// shared/level.ts
// Pure level data model + helpers. No three.js, no DOM — usable by server, tests, and client.
// A "level" extends the old per-map config with optional cars/props/lighting/effects (back-compat).

export interface LevelTransform { pos: number[]; rotDeg: number[]; scale: number }
// Control points are [x, z] (ground) or [x, y, z] (per-point height, so the track follows hills).
export interface LevelPath { points: number[][]; laneScale?: number; shoulder?: number; smoothing?: number }
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
// Start/finish gantries are auto-placed on the track ends; an optional GantryOffset lets the author
// nudge/rotate/resize them off that default and have it persist (applied in both editor + game).
export interface GantryOffset { pos?: number[]; rotDeg?: number[]; scale?: number }
// Per-level size multipliers for the obstacle/boost models (the manifest sets the GLOBAL base size;
// these scale it per level so a barrier sized for a flat track can be resized to a 200x map). 1 = no
// change. Mirrors the per-level car-scale override model.
export interface ObstacleScales { barrierScale?: number; boostScale?: number }
// Per-level CAMERA. Two modes:
//  - 'chase' (default): the cinematic follow-cam. Tunable offsets relative to the lead car along the
//    track: `behind`/`height`/`lateral` place the eye, `lookAhead`/`lookHeight` aim it down-track.
//  - 'fixed': a static camera at world `pos` looking at world `lookAt` — the race plays from it.
// All fields optional on disk; resolveCamera() fills them from DEFAULT_CAMERA.
export interface LevelCamera {
  mode?: 'chase' | 'fixed';
  // chase params
  behind?: number; height?: number; lookAhead?: number; lookHeight?: number; lateral?: number;
  // fixed params (world space, sim coords)
  pos?: number[]; lookAt?: number[];
  fov?: number;   // shared by both modes
}
export interface LevelConfig {
  map: string; file: string;
  model: LevelTransform; track: LevelTransform; path?: LevelPath;
  cars: { masterScale: number; overrides: Record<string, number> };
  props: PlacedProp[];
  obstacles?: ObstacleScales;
  camera?: LevelCamera;
  startLine?: GantryOffset; finishLine?: GantryOffset;
  lighting?: LevelLighting; effects?: LevelEffects;
}

// The chase-cam numbers the game has always used (renderer.ts). A level with no camera resolves to
// exactly this, so existing levels look identical.
export interface ResolvedCamera {
  mode: 'chase' | 'fixed';
  behind: number; height: number; lookAhead: number; lookHeight: number; lateral: number;
  pos?: number[]; lookAt?: number[];
  fov: number;
}
export const DEFAULT_CAMERA = {
  mode: 'chase' as const, behind: 24, height: 9, lookAhead: 45, lookHeight: 2.2, lateral: 10, fov: 46,
};

// Default look: GOLDEN HOUR — a warm, low-angle sun (long shadows), cool sky fill for contrast,
// gentle warm fog, and tasteful bloom on highlights. A low sun.y vs a far +x/-z gives raking light
// that models the terrain instead of flat top-down fill.
export const DEFAULT_LIGHTING: LevelLighting = {
  sunPos: [-180, 70, -120], sunIntensity: 3.0, sunColor: '#ffd9a0',   // warm, low, raking
  ambientIntensity: 0.45, skyColor: '#9ec3ff', groundColor: '#3a2c22', exposure: 1.2,
};
export const DEFAULT_EFFECTS: LevelEffects = {
  bloom: { strength: 0.5, radius: 0.6, threshold: 0.9 },   // only genuine highlights bloom
  fog: { density: 0.0016, color: '#e8c9a0' },              // warm haze, not near-black
  trackEmissive: 1, pulse: { speed: 0, amount: 0 },
  skyTop: '#3b6fb0', skyBottom: '#ffcf9e',   // warm horizon under a cool sky = golden hour
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

function gantryOffset(v: unknown): GantryOffset | undefined {
  if (!isObj(v)) return undefined;
  const out: GantryOffset = {};
  if (Array.isArray(v.pos)) out.pos = v.pos.map(Number);
  if (Array.isArray(v.rotDeg)) out.rotDeg = v.rotDeg.map(Number);
  if (typeof v.scale === 'number' && isFinite(v.scale)) out.scale = v.scale;
  return (out.pos || out.rotDeg || out.scale !== undefined) ? out : undefined;
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
  const sl = gantryOffset(s.startLine); if (sl) out.startLine = sl;
  const fl = gantryOffset(s.finishLine); if (fl) out.finishLine = fl;
  if (isObj(s.path) && Array.isArray((s.path as Record<string, unknown>).points)) {
    const p = s.path as Record<string, unknown>;
    out.path = {
      // Preserve 2-element [x,z] OR 3-element [x,y,z] points (per-point height); don't truncate Y.
      points: (p.points as number[][]).map(pt => pt.length > 2
        ? [Number(pt[0]), Number(pt[1]), Number(pt[2])]
        : [Number(pt[0]), Number(pt[1])]),
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
  if (isObj(s.obstacles)) {
    const O = s.obstacles as Record<string, unknown>;
    const obs: ObstacleScales = {};
    if (typeof O.barrierScale === 'number' && isFinite(O.barrierScale)) obs.barrierScale = O.barrierScale;
    if (typeof O.boostScale === 'number' && isFinite(O.boostScale)) obs.boostScale = O.boostScale;
    if (obs.barrierScale !== undefined || obs.boostScale !== undefined) out.obstacles = obs;
  }
  if (isObj(s.camera)) {
    const C = s.camera as Record<string, unknown>;
    const cam: LevelCamera = {};
    if (C.mode === 'chase' || C.mode === 'fixed') cam.mode = C.mode;
    for (const k of ['behind', 'height', 'lookAhead', 'lookHeight', 'lateral', 'fov'] as const) {
      if (typeof C[k] === 'number' && isFinite(C[k] as number)) cam[k] = C[k] as number;
    }
    if (Array.isArray(C.pos) && C.pos.length === 3) cam.pos = C.pos.map(Number);
    if (Array.isArray(C.lookAt) && C.lookAt.length === 3) cam.lookAt = C.lookAt.map(Number);
    if (Object.keys(cam).length > 0) out.camera = cam;
  }
  return out;
}

export function resolveCarScale(level: LevelConfig, glb: string): number {
  return level.cars.masterScale * (level.cars.overrides[glb] ?? 1);
}

/** Per-level size multiplier for an obstacle/boost (1 if the level didn't override it). The manifest
 *  provides the global base size; this scales it so a level can fit obstacles to its track. */
export function resolveItemScale(level: LevelConfig, kind: 'barrier' | 'boost'): number {
  const o = level.obstacles;
  if (!o) return 1;
  return (kind === 'barrier' ? o.barrierScale : o.boostScale) ?? 1;
}

/** Resolve a level's camera to a complete config, filling any missing field from DEFAULT_CAMERA. */
export function resolveCamera(level: LevelConfig): ResolvedCamera {
  const c = level.camera ?? {};
  const r: ResolvedCamera = {
    mode: c.mode === 'fixed' ? 'fixed' : 'chase',
    behind: num(c.behind, DEFAULT_CAMERA.behind),
    height: num(c.height, DEFAULT_CAMERA.height),
    lookAhead: num(c.lookAhead, DEFAULT_CAMERA.lookAhead),
    lookHeight: num(c.lookHeight, DEFAULT_CAMERA.lookHeight),
    lateral: num(c.lateral, DEFAULT_CAMERA.lateral),
    fov: num(c.fov, DEFAULT_CAMERA.fov),
  };
  if (r.mode === 'fixed') {
    r.pos = Array.isArray(c.pos) && c.pos.length === 3 ? c.pos.map(Number) : [10, 50, -30];
    r.lookAt = Array.isArray(c.lookAt) && c.lookAt.length === 3 ? c.lookAt.map(Number) : [0, 2, 700];
  }
  return r;
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
