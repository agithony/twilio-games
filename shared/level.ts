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
export interface LevelConfig {
  map: string; file: string;
  model: LevelTransform; track: LevelTransform; path?: LevelPath;
  cars: { masterScale: number; overrides: Record<string, number> };
  props: PlacedProp[];
  lighting?: LevelLighting; effects?: LevelEffects;
}

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
