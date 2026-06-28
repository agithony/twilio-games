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
