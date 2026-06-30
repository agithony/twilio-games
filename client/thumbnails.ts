// Render each car model to a small PNG data-URL for the car-select grid (SSB-style portraits).
// Uses one throwaway offscreen WebGLRenderer + scene; clones each car template (already auto-fit +
// grounded by the AssetLoader), frames it, snapshots the canvas. Falls back to '' on any failure so
// the grid just shows a styled placeholder tile.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AssetLoader } from './asset-loader';

/** Build the offscreen renderer + scene + camera used to shoot one car. Reused across cars. */
function makeThumbRig(size: number) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xfff2dd, 2.6); key.position.set(4, 7, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ec3ff, 1.4); rim.position.set(-5, 3, -4); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x202840, 1.0));
  const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
  return { renderer, scene, cam };
}

/** Shoot one car's portrait to a PNG data-URL (''=fail). Pulls the rig's scene/cam by reference. */
function shootCar(rig: ReturnType<typeof makeThumbRig>, tmpl: THREE.Group | null): string {
  if (!tmpl) return '';
  const { renderer, scene, cam } = rig;
  const car = skeletonClone(tmpl) as THREE.Object3D;
  scene.add(car);
  const box = new THREE.Box3().setFromObject(car);
  const c = new THREE.Vector3(); box.getCenter(c);
  const s = new THREE.Vector3(); box.getSize(s);
  const r = Math.max(s.x, s.y, s.z, 1);
  cam.position.set(c.x + r * 1.1, c.y + r * 0.75, c.z + r * 1.5);
  cam.lookAt(c.x, c.y + r * 0.1, c.z);
  let url = '';
  try { renderer.render(scene, cam); url = renderer.domElement.toDataURL('image/png'); } catch { url = ''; }
  scene.remove(car);
  return url;
}

/** Synchronous (all cars at once). Kept for tests / non-interactive callers. */
export function renderCarThumbnails(assets: AssetLoader, size = 256): string[] {
  const n = assets.carCount();
  if (n === 0) return [];
  let rig: ReturnType<typeof makeThumbRig>;
  try { rig = makeThumbRig(size); } catch { return new Array(n).fill(''); }
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(shootCar(rig, assets.carTemplate(i)));
  rig.renderer.dispose();
  return out;
}

/**
 * Async, YIELDING thumbnail render — shoots one car per animation frame and reports each via
 * onOne(i, url), so the main thread never freezes (the menu stays interactive while portraits fill
 * in progressively, AAA-style). Resolves with the full array. Use this at boot.
 */
export async function renderCarThumbnailsAsync(
  assets: AssetLoader, onOne: (i: number, url: string) => void, size = 256,
): Promise<string[]> {
  const n = assets.carCount();
  if (n === 0) return [];
  let rig: ReturnType<typeof makeThumbRig>;
  try { rig = makeThumbRig(size); } catch { return new Array(n).fill(''); }
  const out: string[] = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    const url = shootCar(rig, assets.carTemplate(i));
    out[i] = url;
    onOne(i, url);
    await new Promise(requestAnimationFrame);   // yield a frame between cars
  }
  rig.renderer.dispose();
  return out;
}
