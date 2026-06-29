// Render each car model to a small PNG data-URL for the car-select grid (SSB-style portraits).
// Uses one throwaway offscreen WebGLRenderer + scene; clones each car template (already auto-fit +
// grounded by the AssetLoader), frames it, snapshots the canvas. Falls back to '' on any failure so
// the grid just shows a styled placeholder tile.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AssetLoader } from './asset-loader';

export function renderCarThumbnails(assets: AssetLoader, size = 256): string[] {
  const n = assets.carCount();
  if (n === 0) return [];
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch { return new Array(n).fill(''); }
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
  const out: string[] = [];

  for (let i = 0; i < n; i++) {
    const tmpl = assets.carTemplate(i);
    let url = '';
    if (tmpl) {
      const car = skeletonClone(tmpl) as THREE.Object3D;
      scene.add(car);
      // frame on the car's actual rendered bounds (it's already auto-fit to CAR_TARGET≈4 + grounded)
      const box = new THREE.Box3().setFromObject(car);
      const c = new THREE.Vector3(); box.getCenter(c);
      const s = new THREE.Vector3(); box.getSize(s);
      const r = Math.max(s.x, s.y, s.z, 1);
      // 3/4 hero angle
      cam.position.set(c.x + r * 1.1, c.y + r * 0.75, c.z + r * 1.5);
      cam.lookAt(c.x, c.y + r * 0.1, c.z);
      try { renderer.render(scene, cam); url = renderer.domElement.toDataURL('image/png'); }
      catch { url = ''; }
      scene.remove(car);
    }
    out.push(url);
  }
  renderer.dispose();
  return out;
}
