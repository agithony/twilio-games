import * as THREE from 'three';
import { autoFitScale } from '../shared/asset-fit';

const deg = (d: number) => (d * Math.PI) / 180;

/** The transform fields a manifest AssetRef can carry that affect placement. */
export interface PlacementRef {
  scale?: number;
  rotation?: [number, number, number];   // degrees, XYZ
  offset?: [number, number, number];
}

/**
 * Place a loaded model group consistently for BOTH the game and the garage:
 *   1. rotate FIRST (so the bounding box we measure is the rotated, on-screen box),
 *   2. auto-fit the longest dimension to `target` × the ref's manual scale,
 *   3. ground on y=0 and center x/z, then apply the manual offset.
 *
 * Ordering matters: three.js composes world = T · R · S, so centering by setting
 * position = -worldCenter only lands the model at the origin when that center is
 * measured AFTER rotation. Models authored off their local origin (e.g. the monster
 * truck, local center x≈-238) otherwise get flung sideways by a 90° Y-turn — the
 * "car sits outside the lane" bug. Measuring post-rotation makes placement rotation-safe.
 */
export function applyModelTransform(g: THREE.Object3D, ref: PlacementRef, target: number): void {
  g.scale.setScalar(1);
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  if (ref.rotation) g.rotation.set(deg(ref.rotation[0]), deg(ref.rotation[1]), deg(ref.rotation[2]));

  // measure the ROTATED model, then fit its longest dimension to the target
  const box = new THREE.Box3().setFromObject(g);
  const size = new THREE.Vector3(); box.getSize(size);
  const fit = autoFitScale([size.x, size.y, size.z], target);
  g.scale.setScalar(fit * (ref.scale ?? 1));

  // re-measure at final scale; ground on y=0, center x/z, then apply manual offset
  const box2 = new THREE.Box3().setFromObject(g);
  const c = new THREE.Vector3(); box2.getCenter(c);
  g.position.x += -c.x + (ref.offset?.[0] ?? 0);
  g.position.y += -box2.min.y + (ref.offset?.[1] ?? 0);
  g.position.z += -c.z + (ref.offset?.[2] ?? 0);
}
