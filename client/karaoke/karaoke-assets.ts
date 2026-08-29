import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  DEFAULT_KARAOKE_VENUE,
  cloneKaraokeVenueConfig,
  karaokeVenueModel,
  parseKaraokeVenueConfig,
  type KaraokeVenueConfig,
  type KaraokeVenueRole,
} from '../../shared/karaoke-venue';

export type KaraokeAssetRole = KaraokeVenueRole;

export interface KaraokeAssetSpec {
  role: KaraokeAssetRole;
  url: string;
  targetHeight?: number;
}

export interface KaraokeLoadedAsset {
  role: KaraokeAssetRole;
  model: THREE.Group;
  animations: readonly THREE.AnimationClip[];
  diagnostics: KaraokeMaterialDiagnostics;
}

export interface KaraokeMaterialDiagnostics {
  materialCount: number;
  textureCount: number;
  loadedTextureCount: number;
}

export interface KaraokeAssetBundle {
  models: ReadonlyMap<KaraokeAssetRole, THREE.Object3D>;
  animations: ReadonlyMap<KaraokeAssetRole, readonly THREE.AnimationClip[]>;
  failed: readonly KaraokeAssetRole[];
}

export const KARAOKE_ASSET_TIMEOUT_MS = 15_000;
export const KARAOKE_VENUE_TIMEOUT_MS = 5_000;
export const KARAOKE_ASSET_VERSION = '20260827-rendering-3';
export const KARAOKE_STAGE_TARGET_WIDTH = 14;
export const KARAOKE_STAGE_TARGET_DEPTH = 8.9;
export const KARAOKE_DRUMMER_FALLBACK_POSITION = Object.freeze(
  [...DEFAULT_KARAOKE_VENUE.drumAnchor.fallbackPosition] as [number, number, number],
);
export const KARAOKE_LEAD_MATERIAL_COUNT = 17;
export const KARAOKE_LEAD_TEXTURE_COUNT = 25;

/** Derives every model URL from a config that has already passed the strict basename parser. */
export function karaokeAssetManifest(config: KaraokeVenueConfig): readonly KaraokeAssetSpec[] {
  const targetHeights: Partial<Record<KaraokeAssetRole, number>> = {
    'lead-singer': 2.22, 'backup-singer': 2.22, drummer: 2.15, guitarist: 2.2,
  };
  return Object.freeze(config.models.map(({ role }) => ({
    role,
    url: `/assets/karaoke/${encodeURIComponent(karaokeVenueModel(config, role).file)}?v=${KARAOKE_ASSET_VERSION}`,
    ...(targetHeights[role] ? { targetHeight: targetHeights[role] } : {}),
  })));
}

/** Stable compiled fallback. Every role has an independently animated procedural replacement. */
export const KARAOKE_ASSET_MANIFEST = karaokeAssetManifest(DEFAULT_KARAOKE_VENUE);

export async function fetchKaraokeVenueConfig(
  request: typeof fetch = fetch,
  timeoutMs = KARAOKE_VENUE_TIMEOUT_MS,
): Promise<KaraokeVenueConfig> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request('/api/karaoke-venue', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`venue request failed (${response.status})`);
    return parseKaraokeVenueConfig(await response.json() as unknown);
  } catch (error) {
    console.warn('Karaoke venue config unavailable; using the compiled fallback.', error);
    return cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);
  } finally { clearTimeout(timer); }
}

function isVisiblyRenderable(object: THREE.Object3D): object is THREE.Mesh {
  if (!(object as THREE.Mesh).isMesh) return false;
  for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible || ![ancestor.scale.x, ancestor.scale.y, ancestor.scale.z].every(Number.isFinite)
      || ancestor.scale.x === 0 || ancestor.scale.y === 0 || ancestor.scale.z === 0) return false;
  }
  const mesh = object as THREE.Mesh;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some(material => material.visible && material.opacity > 0);
}

export function hasVisibleKaraokeTriangles(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse(object => {
    if (found || !isVisiblyRenderable(object)) return;
    const geometry = object.geometry;
    const available = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
    const drawCount = Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : available;
    const availableAfterStart = Math.max(0, available - geometry.drawRange.start);
    if (Math.min(availableAfterStart, drawCount) >= 3) found = true;
  });
  return found;
}

export function visibleKaraokeBounds(root: THREE.Object3D): THREE.Box3 | null {
  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  root.traverse(object => {
    if (!isVisiblyRenderable(object)) return;
    const meshBounds = new THREE.Box3().setFromObject(object, true);
    if (!meshBounds.isEmpty()) bounds.union(meshBounds);
  });
  if (bounds.isEmpty()) return null;
  const values = [...bounds.min.toArray(), ...bounds.max.toArray()];
  return values.every(Number.isFinite) ? bounds : null;
}

export function karaokeMaterialDiagnostics(root: THREE.Object3D): KaraokeMaterialDiagnostics {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const entries = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of entries) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if ((value as THREE.Texture)?.isTexture) textures.add(value as THREE.Texture);
      }
    }
  });
  const loadedTextureCount = [...textures].filter(texture => {
    const data = texture.source?.data as { width?: unknown; height?: unknown } | null;
    return Number(data?.width) > 0 && Number(data?.height) > 0;
  }).length;
  return { materialCount: materials.size, textureCount: textures.size, loadedTextureCount };
}

export function karaokeDrumAnchor(stage: THREE.Object3D, relativeTo: THREE.Object3D): THREE.Vector3 | null {
  let drumKit: THREE.Object3D | null = null;
  stage.traverse(object => {
    if (!drumKit && object.name.trim().toLocaleLowerCase() === 'batteria') drumKit = object;
  });
  const bounds = drumKit ? visibleKaraokeBounds(drumKit) : null;
  if (!bounds) return null;
  const worldAnchor = bounds.getCenter(new THREE.Vector3());
  worldAnchor.y = bounds.min.y;
  worldAnchor.z = bounds.min.z - .18;
  relativeTo.updateWorldMatrix(true, false);
  return relativeTo.worldToLocal(worldAnchor);
}

export function normalizeKaraokeAsset(spec: KaraokeAssetSpec, root: THREE.Object3D): THREE.Group | null {
  const bounds = visibleKaraokeBounds(root);
  if (!bounds) return null;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = spec.role === 'stage'
    ? Math.min(KARAOKE_STAGE_TARGET_WIDTH / size.x, KARAOKE_STAGE_TARGET_DEPTH / size.z)
    : (spec.targetHeight ?? 2.2) / size.y;
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const normalized = new THREE.Group();
  normalized.name = `${spec.role}-normalized`;
  normalized.add(root);
  normalized.scale.setScalar(scale);
  normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);

  const placement = new THREE.Group();
  placement.name = `karaoke-${spec.role}`;
  placement.userData.karaokeRole = spec.role;
  placement.userData.normalizationScale = scale;
  placement.add(normalized);
  placement.updateWorldMatrix(true, true);
  return visibleKaraokeBounds(placement) ? placement : null;
}

/** Keep vertical performance motion while pinning animated hip translation to its first X/Z sample. */
export function neutralizeKaraokeRootMotion(clips: readonly THREE.AnimationClip[]): readonly THREE.AnimationClip[] {
  return Object.freeze(clips.map(source => {
    const clip = source.clone();
    for (const track of clip.tracks) {
      if (!/hips[^.]*\.position$/i.test(track.name) || track.getValueSize() !== 3 || track.values.length < 3) continue;
      const x = track.values[0]!;
      const z = track.values[2]!;
      for (let index = 0; index < track.values.length; index += 3) {
        track.values[index] = x;
        track.values[index + 2] = z;
      }
    }
    return clip;
  }));
}

export function disposeKaraokeObjectResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (!renderable.geometry || !renderable.material) return;
    geometries.add(renderable.geometry);
    const entries = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
    for (const material of entries) {
      materials.add(material);
      for (const value of Object.values(material)) if ((value as THREE.Texture)?.isTexture) textures.add(value as THREE.Texture);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

export class KaraokeAssetLoader {
  private readonly loader = new GLTFLoader();
  private readonly draco = new DRACOLoader();
  private pending: Promise<KaraokeAssetBundle> | null = null;

  constructor() {
    this.draco.setDecoderPath('/draco/');
    this.loader.setDRACOLoader(this.draco);
  }

  loadOptional(
    onProgress?: (loaded: number, total: number) => void,
    manifest: readonly KaraokeAssetSpec[] = KARAOKE_ASSET_MANIFEST,
    timeoutMs = KARAOKE_ASSET_TIMEOUT_MS,
    onRole?: (asset: KaraokeLoadedAsset) => void,
  ): Promise<KaraokeAssetBundle> {
    if (this.pending) return this.pending;
    let completed = 0;
    this.pending = Promise.all(manifest.map(async spec => {
      try {
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const request = this.loader.loadAsync(spec.url).then(gltf => {
          if (expired) {
            disposeKaraokeObjectResources(gltf.scene);
            return null;
          }
          return gltf;
        }).catch(() => null);
        const timeout = new Promise<null>(resolve => {
          timer = setTimeout(() => { expired = true; resolve(null); }, timeoutMs);
        });
        const gltf = await Promise.race([request, timeout]);
        if (timer) clearTimeout(timer);
        const animations = gltf ? neutralizeKaraokeRootMotion(gltf.animations) : [];
        const needsAnimation = spec.role !== 'stage';
        if (!gltf || !hasVisibleKaraokeTriangles(gltf.scene) || (needsAnimation && animations.length === 0)) {
          if (gltf) disposeKaraokeObjectResources(gltf.scene);
          return { spec, root: null, animations: [] as readonly THREE.AnimationClip[] };
        }
        const root = normalizeKaraokeAsset(spec, gltf.scene);
        if (!root) {
          disposeKaraokeObjectResources(gltf.scene);
          return { spec, root: null, animations: [] as readonly THREE.AnimationClip[] };
        }
        const diagnostics = karaokeMaterialDiagnostics(root);
        if (spec.role === 'lead-singer' && (diagnostics.materialCount !== KARAOKE_LEAD_MATERIAL_COUNT
          || diagnostics.textureCount !== KARAOKE_LEAD_TEXTURE_COUNT
          || diagnostics.loadedTextureCount !== KARAOKE_LEAD_TEXTURE_COUNT)) {
          console.warn('[karaoke] Lead model texture diagnostics are incomplete.', diagnostics);
        }
        onRole?.({ role: spec.role, model: root, animations, diagnostics });
        return { spec, root, animations, diagnostics };
      } catch {
        return { spec, root: null, animations: [] as readonly THREE.AnimationClip[] };
      } finally {
        completed += 1;
        onProgress?.(completed, manifest.length);
      }
    })).then(results => {
      this.draco.dispose();
      return {
        models: new Map(results.flatMap(result => result.root ? [[result.spec.role, result.root] as const] : [])),
        animations: new Map(results.flatMap(result => result.root
          ? [[result.spec.role, result.animations] as const]
          : [])),
        failed: results.flatMap(result => result.root ? [] : [result.spec.role]),
      };
    });
    return this.pending;
  }
}
