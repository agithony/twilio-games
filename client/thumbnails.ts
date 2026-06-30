// Render each car model to a small PNG data-URL for the car-select grid (SSB-style portraits).
// Uses one throwaway offscreen WebGLRenderer + scene; clones each car template (already auto-fit +
// grounded by the AssetLoader), frames it, snapshots the canvas. Falls back to '' on any failure so
// the grid just shows a styled placeholder tile.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AssetLoader } from './asset-loader';

/** Build the offscreen renderer + scene + camera used to shoot one car. Reused across cars.
 *  Mirrors the GARAGE's proven setup (which renders every car correctly): a SOLID dark background +
 *  a soft env map. The earlier transparent background was the bug — glossy/specular cars (Yuterra)
 *  had nothing to reflect and blew out white, while dark cars (Mustang) became flat silhouettes. A
 *  dark backdrop gives reflections something to sample, and it blends into the dark glass tiles. */
function makeThumbRig(size: number) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141d3e);   // mid-dark card — bright enough that dark-painted
                                                  // cars (Yuterra's deep red) still read against it.
  // Soft studio env so PBR/specular materials read as metal/paint, not clipped white.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.045).texture;
  // Brighter, even lighting so even dark paint shows form; the env map keeps glossy cars from
  // clipping. Mustang reads fine at this level and lighter cars don't blow out (verified).
  const key = new THREE.DirectionalLight(0xfff4e2, 2.6); key.position.set(6, 10, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd2ff, 1.1); fill.position.set(-5, 3, -4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8); rim.position.set(0, 4, -7); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a3450, 1.1));
  const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
  return { renderer, scene, cam, pmrem };
}

/** Shoot one car's portrait to a PNG data-URL (''=fail). Pulls the rig's scene/cam by reference. */
function shootCar(rig: ReturnType<typeof makeThumbRig>, tmpl: THREE.Group | null): string {
  if (!tmpl) return '';
  const { renderer, scene, cam } = rig;
  const car = skeletonClone(tmpl) as THREE.Object3D;
  scene.add(car);
  // CRITICAL: refresh world matrices BEFORE measuring. skeletonClone copies local transforms but
  // leaves matrixWorld stale, and Box3.setFromObject reads each node's matrixWorld — without this,
  // rigged/transformed models (Mustang's rotation, Yuterra's 427-node rig) measure wrong and the
  // camera frames empty space or a sliver (the "not rendered correctly" tiles).
  car.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(car);
  if (box.isEmpty()) { scene.remove(car); return ''; }
  const c = new THREE.Vector3(); box.getCenter(c);
  // Frame on the bounding-SPHERE radius (robust to odd aspect ratios) and the camera FOV, so every
  // car fills the tile consistently regardless of its proportions.
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const fov = (cam.fov * Math.PI) / 180;
  const dist = (radius / Math.sin(fov / 2)) * 1.15;   // 1.15 = a little padding
  cam.position.set(c.x + dist * 0.62, c.y + dist * 0.42, c.z + dist * 0.66);
  cam.lookAt(c.x, c.y, c.z);
  cam.updateProjectionMatrix();
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
  rig.pmrem.dispose(); rig.renderer.dispose();
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
  rig.pmrem.dispose(); rig.renderer.dispose();
  return out;
}
