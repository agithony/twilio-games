import type { FighterMapEntry } from './fighter-roster';

export function parseFighterMaps(value: unknown): FighterMapEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error('fighter maps must be a non-empty array');
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`map ${index + 1} must be an object`);
    const map = raw as Record<string, unknown>;
    const id = text(map.id, 64, `map ${index + 1} id`).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new Error(`invalid or duplicate map id: ${id}`); ids.add(id);
    const bounds = tuple(map.bounds, 2, `${id} bounds`);
    if (bounds[0]! >= bounds[1]! || bounds[1]! - bounds[0]! < 4 || Math.abs(bounds[0]!) > 1000 || Math.abs(bounds[1]!) > 1000) throw new Error(`${id} bounds must be ordered and at least 4 units wide`);
    const color = text(map.color, 16, `${id} color`); if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`${id} color must be #RRGGBB`);
    const file = optionalText(map.file, 128); if (file && (!/^[a-zA-Z0-9_.-]+\.glb$/i.test(file) || file.includes('..'))) throw new Error(`${id} has an unsafe GLB filename`);
    const preview = optionalText(map.preview, 256);
    if (preview && !/^\/(?:assets\/fighters\/previews|fighter-previews)\/[a-zA-Z0-9_.?=&-]+$/.test(preview)) throw new Error(`${id} has an unsafe preview URL`);
    const result: FighterMapEntry = { id, name: text(map.name, 80, `${id} name`), blurb: text(map.blurb, 240, `${id} blurb`), color,
      bounds: bounds as [number, number] };
    if (file) result.file = file; if (preview) result.preview = preview;
    if (map.pos !== undefined) result.pos = tuple(map.pos, 3, `${id} pos`) as [number, number, number];
    if (map.rotDeg !== undefined) result.rotDeg = tuple(map.rotDeg, 3, `${id} rotation`) as [number, number, number];
    if (map.scale !== undefined) { const scale = finite(map.scale, `${id} scale`); if (scale <= 0 || scale > 100) throw new Error(`${id} scale is out of range`); result.scale = scale; }
    if (map.floorY !== undefined) result.floorY = finite(map.floorY, `${id} floorY`);
    if (map.fightPlane !== undefined) {
      const plane = object(map.fightPlane, `${id} fightPlane`);
      result.fightPlane = { origin: tuple(plane.origin, 3, `${id} plane origin`) as [number, number, number], rotationY: finite(plane.rotationY, `${id} plane rotation`) };
    }
    if (map.camera !== undefined) {
      const camera = object(map.camera, `${id} camera`);
      result.camera = { pos: tuple(camera.pos, 3, `${id} camera pos`) as [number, number, number],
        lookAt: tuple(camera.lookAt, 3, `${id} camera target`) as [number, number, number] };
      if (camera.fov !== undefined) { const fov = finite(camera.fov, `${id} fov`); if (fov < 10 || fov > 120) throw new Error(`${id} fov is out of range`); result.camera.fov = fov; }
    }
    return result;
  });
}

function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function text(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is invalid`); return value.trim(); }
function optionalText(value: unknown, max: number): string | undefined { return value === undefined ? undefined : text(value, max, 'text'); }
function finite(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`); return value; }
function tuple(value: unknown, length: number, label: string): number[] { if (!Array.isArray(value) || value.length !== length) throw new Error(`${label} must have ${length} numbers`); return value.map(item => finite(item, label)); }
