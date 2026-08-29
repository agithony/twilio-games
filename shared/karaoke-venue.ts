export const KARAOKE_VENUE_VERSION = 1 as const;

export type KaraokeVenueRole = 'stage' | 'lead-singer' | 'backup-singer' | 'drummer' | 'guitarist';
export type KaraokeCameraMode = 'landscape' | 'compact' | 'portrait';
export type KaraokeVec3 = [number, number, number];

export interface KaraokeTransform {
  position: KaraokeVec3;
  rotation: KaraokeVec3;
  scale: KaraokeVec3;
}

export interface KaraokeVenueModel {
  id: string;
  role: KaraokeVenueRole;
  file: string;
  transform: KaraokeTransform;
}

export interface KaraokeCameraPose {
  position: KaraokeVec3;
  lookAt: KaraokeVec3;
  fov: number;
}

export interface KaraokeSpotlightConfig {
  id: string;
  color: string;
  intensity: number;
  distance: number;
  angleDeg: number;
  penumbra: number;
  decay: number;
  position: KaraokeVec3;
  target: KaraokeVec3;
  beamOpacity: number;
}

export interface KaraokeVenueConfig {
  version: typeof KARAOKE_VENUE_VERSION;
  models: KaraokeVenueModel[];
  cameras: Record<KaraokeCameraMode, KaraokeCameraPose>;
  highway: Record<'landscape' | 'portrait', KaraokeTransform>;
  drumAnchor: {
    mode: 'stage-node' | 'manual';
    nodeName: 'batteria';
    manualPosition: KaraokeVec3;
    fallbackPosition: KaraokeVec3;
    nodeTransform: KaraokeTransform;
  };
  lighting: {
    ambient: { skyColor: string; groundColor: string; intensity: number };
    directional: { color: string; intensity: number; position: KaraokeVec3 };
    spotlights: KaraokeSpotlightConfig[];
  };
}

const DEFAULT_VALUE: KaraokeVenueConfig = {
  version: KARAOKE_VENUE_VERSION,
  models: [
    { id: 'stage', role: 'stage', file: 'stage.glb', transform: { position: [0, 0, -3], rotation: [0, 180, 0], scale: [1, 1, 1] } },
    { id: 'lead-singer', role: 'lead-singer', file: 'lead-singer.glb', transform: { position: [-1.35, .58, -.25], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: 'backup-singer', role: 'backup-singer', file: 'backup-singer.glb', transform: { position: [1.35, .58, -.25], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: 'drummer', role: 'drummer', file: 'drummer.glb', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: 'guitarist', role: 'guitarist', file: 'guitarist.glb', transform: { position: [3.45, .58, -1.2], rotation: [0, -6.875, 0], scale: [1, 1, 1] } },
  ],
  cameras: {
    landscape: { position: [0, 5.05, 13.4], lookAt: [0, 1.18, .3], fov: 39 },
    compact: { position: [0, 5.05, 13.4], lookAt: [0, 1.18, .3], fov: 45 },
    portrait: { position: [0, 7.2, 18.4], lookAt: [0, 1.65, .65], fov: 46 },
  },
  highway: {
    landscape: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    portrait: { position: [0, 0, 1.4], rotation: [0, 0, 0], scale: [.56, 1, 1] },
  },
  drumAnchor: {
    mode: 'stage-node',
    nodeName: 'batteria',
    manualPosition: [0, .58, -2.55],
    fallbackPosition: [0, .58, -2.55],
    nodeTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  lighting: {
    ambient: { skyColor: '#a5ebff', groundColor: '#080c18', intensity: 1.2 },
    directional: { color: '#ffffff', intensity: 1.4, position: [0, 7, 6] },
    spotlights: [
      { id: 'spot-left', color: '#ef223a', intensity: 42, distance: 18, angleDeg: 19.48, penumbra: .72, decay: 1.35, position: [-5.6, 7, -1.5], target: [-1.232, .4, -1.7], beamOpacity: .026 },
      { id: 'spot-right', color: '#2188ef', intensity: 42, distance: 18, angleDeg: 19.48, penumbra: .72, decay: 1.35, position: [5.6, 7, -1.5], target: [1.232, .4, -1.7], beamOpacity: .026 },
      { id: 'spot-center', color: '#ffffff', intensity: 42, distance: 18, angleDeg: 19.48, penumbra: .72, decay: 1.35, position: [0, 8.2, -4.1], target: [0, .4, -1.7], beamOpacity: .026 },
      { id: 'spot-pink', color: '#fd7685', intensity: 42, distance: 18, angleDeg: 19.48, penumbra: .72, decay: 1.35, position: [-2.7, 6.8, -3.7], target: [-.594, .4, -1.7], beamOpacity: .026 },
      { id: 'spot-blue', color: '#3acefa', intensity: 42, distance: 18, angleDeg: 19.48, penumbra: .72, decay: 1.35, position: [2.7, 6.8, -3.7], target: [.594, .4, -1.7], beamOpacity: .026 },
    ],
  },
};

export const DEFAULT_KARAOKE_VENUE: KaraokeVenueConfig = deepFreeze(DEFAULT_VALUE);

const MODEL_ROLES: readonly KaraokeVenueRole[] = [
  'stage', 'lead-singer', 'backup-singer', 'drummer', 'guitarist',
];
const SAFE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const SAFE_GLB_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.glb$/i;
const COLOR = /^#[0-9a-f]{6}$/i;

export function isSafeKaraokeGlbBasename(value: unknown): value is string {
  return typeof value === 'string' && SAFE_GLB_BASENAME.test(value)
    && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

export function parseKaraokeVenueConfig(input: unknown): KaraokeVenueConfig {
  const root = record(input, '$');
  exactKeys(root, ['version', 'models', 'cameras', 'highway', 'drumAnchor', 'lighting'], '$');
  if (root.version !== KARAOKE_VENUE_VERSION) throw new Error(`$.version must be ${KARAOKE_VENUE_VERSION}`);

  if (!Array.isArray(root.models) || root.models.length !== MODEL_ROLES.length) {
    throw new Error(`$.models must contain exactly ${MODEL_ROLES.length} entries`);
  }
  const models = root.models.map((value, index) => parseModel(value, `$.models[${index}]`));
  const roles = new Set(models.map(model => model.role));
  if (roles.size !== MODEL_ROLES.length || MODEL_ROLES.some(role => !roles.has(role))) {
    throw new Error('$.models must contain every Karaoke role exactly once');
  }

  const camerasValue = record(root.cameras, '$.cameras');
  exactKeys(camerasValue, ['landscape', 'compact', 'portrait'], '$.cameras');
  const cameras = {
    landscape: parseCamera(camerasValue.landscape, '$.cameras.landscape'),
    compact: parseCamera(camerasValue.compact, '$.cameras.compact'),
    portrait: parseCamera(camerasValue.portrait, '$.cameras.portrait'),
  };

  const highwayValue = record(root.highway, '$.highway');
  exactKeys(highwayValue, ['landscape', 'portrait'], '$.highway');
  const highway = {
    landscape: parseTransform(highwayValue.landscape, '$.highway.landscape'),
    portrait: parseTransform(highwayValue.portrait, '$.highway.portrait'),
  };

  const drumValue = record(root.drumAnchor, '$.drumAnchor');
  exactKeys(drumValue, ['mode', 'nodeName', 'manualPosition', 'fallbackPosition', 'nodeTransform'], '$.drumAnchor');
  if (drumValue.mode !== 'stage-node' && drumValue.mode !== 'manual') {
    throw new Error('$.drumAnchor.mode must be "stage-node" or "manual"');
  }
  if (drumValue.nodeName !== 'batteria') throw new Error('$.drumAnchor.nodeName must be "batteria"');
  const drumAnchor: KaraokeVenueConfig['drumAnchor'] = {
    mode: drumValue.mode,
    nodeName: drumValue.nodeName,
    manualPosition: vector(drumValue.manualPosition, '$.drumAnchor.manualPosition', -250, 250),
    fallbackPosition: vector(drumValue.fallbackPosition, '$.drumAnchor.fallbackPosition', -250, 250),
    nodeTransform: parseTransform(drumValue.nodeTransform, '$.drumAnchor.nodeTransform'),
  };

  const lightingValue = record(root.lighting, '$.lighting');
  exactKeys(lightingValue, ['ambient', 'directional', 'spotlights'], '$.lighting');
  const ambientValue = record(lightingValue.ambient, '$.lighting.ambient');
  exactKeys(ambientValue, ['skyColor', 'groundColor', 'intensity'], '$.lighting.ambient');
  const directionalValue = record(lightingValue.directional, '$.lighting.directional');
  exactKeys(directionalValue, ['color', 'intensity', 'position'], '$.lighting.directional');
  if (!Array.isArray(lightingValue.spotlights) || lightingValue.spotlights.length < 1 || lightingValue.spotlights.length > 12) {
    throw new Error('$.lighting.spotlights must contain 1 through 12 entries');
  }
  const spotlights = lightingValue.spotlights.map((value, index) => parseSpotlight(value, `$.lighting.spotlights[${index}]`));
  const ids = [...models.map(model => model.id), ...spotlights.map(spotlight => spotlight.id)];
  if (new Set(ids).size !== ids.length) throw new Error('model and spotlight IDs must be unique');

  return {
    version: KARAOKE_VENUE_VERSION,
    models,
    cameras,
    highway,
    drumAnchor,
    lighting: {
      ambient: {
        skyColor: color(ambientValue.skyColor, '$.lighting.ambient.skyColor'),
        groundColor: color(ambientValue.groundColor, '$.lighting.ambient.groundColor'),
        intensity: finite(ambientValue.intensity, '$.lighting.ambient.intensity', 0, 20),
      },
      directional: {
        color: color(directionalValue.color, '$.lighting.directional.color'),
        intensity: finite(directionalValue.intensity, '$.lighting.directional.intensity', 0, 100),
        position: vector(directionalValue.position, '$.lighting.directional.position', -250, 250),
      },
      spotlights,
    },
  };
}

export function cloneKaraokeVenueConfig(config: KaraokeVenueConfig = DEFAULT_KARAOKE_VENUE): KaraokeVenueConfig {
  return parseKaraokeVenueConfig(JSON.parse(JSON.stringify(config)) as unknown);
}

export function karaokeVenueModel(config: KaraokeVenueConfig, role: KaraokeVenueRole): KaraokeVenueModel {
  const model = config.models.find(entry => entry.role === role);
  if (!model) throw new Error(`Karaoke venue is missing role ${role}`);
  return model;
}

export function karaokeCameraMode(aspect: number): KaraokeCameraMode {
  if (Number.isFinite(aspect) && aspect < .8) return 'portrait';
  if (Number.isFinite(aspect) && aspect < 1.2) return 'compact';
  return 'landscape';
}

function parseModel(value: unknown, path: string): KaraokeVenueModel {
  const input = record(value, path);
  exactKeys(input, ['id', 'role', 'file', 'transform'], path);
  if (!MODEL_ROLES.includes(input.role as KaraokeVenueRole)) throw new Error(`${path}.role is invalid`);
  if (!isSafeKaraokeGlbBasename(input.file)) throw new Error(`${path}.file must be a safe .glb basename`);
  return {
    id: id(input.id, `${path}.id`),
    role: input.role as KaraokeVenueRole,
    file: input.file,
    transform: parseTransform(input.transform, `${path}.transform`),
  };
}

function parseCamera(value: unknown, path: string): KaraokeCameraPose {
  const input = record(value, path);
  exactKeys(input, ['position', 'lookAt', 'fov'], path);
  return {
    position: vector(input.position, `${path}.position`, -250, 250),
    lookAt: vector(input.lookAt, `${path}.lookAt`, -250, 250),
    fov: finite(input.fov, `${path}.fov`, 10, 120),
  };
}

function parseTransform(value: unknown, path: string): KaraokeTransform {
  const input = record(value, path);
  exactKeys(input, ['position', 'rotation', 'scale'], path);
  return {
    position: vector(input.position, `${path}.position`, -250, 250),
    rotation: vector(input.rotation, `${path}.rotation`, -3600, 3600),
    scale: positiveVector(input.scale, `${path}.scale`),
  };
}

function parseSpotlight(value: unknown, path: string): KaraokeSpotlightConfig {
  const input = record(value, path);
  exactKeys(input, ['id', 'color', 'intensity', 'distance', 'angleDeg', 'penumbra', 'decay', 'position', 'target', 'beamOpacity'], path);
  return {
    id: id(input.id, `${path}.id`),
    color: color(input.color, `${path}.color`),
    intensity: finite(input.intensity, `${path}.intensity`, 0, 500),
    distance: finite(input.distance, `${path}.distance`, .1, 500),
    angleDeg: finite(input.angleDeg, `${path}.angleDeg`, 1, 89),
    penumbra: finite(input.penumbra, `${path}.penumbra`, 0, 1),
    decay: finite(input.decay, `${path}.decay`, 0, 4),
    position: vector(input.position, `${path}.position`, -250, 250),
    target: vector(input.target, `${path}.target`, -250, 250),
    beamOpacity: finite(input.beamOpacity, `${path}.beamOpacity`, 0, 1),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} has unexpected or missing fields`);
  }
}

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${path} must be a finite number from ${min} through ${max}`);
  }
  return value;
}

function vector(value: unknown, path: string, min: number, max: number): KaraokeVec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path} must contain exactly three numbers`);
  return value.map((entry, index) => finite(entry, `${path}[${index}]`, min, max)) as KaraokeVec3;
}

function positiveVector(value: unknown, path: string): KaraokeVec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path} must contain exactly three numbers`);
  return value.map((entry, index) => finite(entry, `${path}[${index}]`, .001, 100)) as KaraokeVec3;
}

function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${path} must be a safe lowercase ID`);
  return value;
}

function color(value: unknown, path: string): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error(`${path} must be a six-digit hex color`);
  return value.toLowerCase();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
