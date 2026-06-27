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
