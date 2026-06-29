export type AssetRef = {
  file: string;
  scale?: number;
  rotation?: [number, number, number];
  offset?: [number, number, number];
  // Play the GLB's baked animation clip in-game? Default false: many free Sketchfab cars ship with
  // a showcase clip ("Air Out", doors/hood open) and a default OPEN resting pose. Off keeps the
  // model static (wheel-spin only); on lets the clip run (useful for cars that animate cleanly).
  animate?: boolean;
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
    ? [v[0], v[1], v[2]] as [number, number, number] : undefined;
}
function ref(v: unknown): AssetRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.file !== 'string' || !o.file) return null;
  const out: AssetRef = { file: o.file };
  if (typeof o.scale === 'number') out.scale = o.scale;
  const r = triple(o.rotation); if (r) out.rotation = r;
  const off = triple(o.offset); if (off) out.offset = off;
  if (o.animate === true) out.animate = true;   // opt-in; absent/false = static (default)
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
