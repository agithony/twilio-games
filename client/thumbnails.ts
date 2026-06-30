// Render each car model to a small PNG data-URL for the car-select grid (SSB-style portraits).
// Uses one throwaway offscreen WebGLRenderer + scene; clones each car template (already auto-fit +
// grounded by the AssetLoader), frames it, snapshots the canvas. Falls back to '' on any failure so
// the grid just shows a styled placeholder tile.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { AssetLoader, stripDisplayBases } from './asset-loader';
import type { MapConfig } from './map-world';

const deg = (d: number) => (d * Math.PI) / 180;

/** A shared Draco-enabled GLTF loader for fresh thumbnail loads. */
function makeLoader(): GLTFLoader {
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
  return loader;
}

// Bright "showroom" rig for the car-select PORTRAITS — the goal is to SHOW OFF each car, so it's
// well-lit (cars must read clearly, even dark paint) with only a soft contact shadow. No ground
// DISC (it crowded the frame); just even studio light + a subtle floor for grounding.
function makeThumbRig(size: number) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  // Even, bright studio lighting from several directions so every car — including dark Batmobile/
  // Mustang — is clearly visible. Higher hemisphere fill lifts shadowed undersides.
  const key = new THREE.DirectionalLight(0xfff6ea, 2.4); key.position.set(5, 8, 6); scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 1.6); fill.position.set(-6, 4, 2); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(0, 5, -8); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x4a5578, 1.5));
  const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
  return { renderer, scene, cam };
}

/** Frame the rig's camera on a model + shoot it to a data-URL. Tight front-3/4 hero (car fills tile).
 *  Frames on the model's MAIN MASS — the median per-mesh bbox extent — so a stray far mesh/vertex
 *  (some GLBs have them) can't blow out the framing and shrink the car to a speck. */
function frameAndShoot(rig: ReturnType<typeof makeThumbRig>, model: THREE.Object3D): string {
  const { renderer, scene, cam } = rig;
  model.updateMatrixWorld(true);
  const full = new THREE.Box3().setFromObject(model);
  if (full.isEmpty()) return '';
  const center = new THREE.Vector3(); full.getCenter(center);
  // Per-mesh world-space extents; the median guards against outlier meshes inflating the frame.
  const exts: number[] = [];
  const mb = new THREE.Box3(); const ms = new THREE.Vector3();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    mb.setFromObject(m); if (mb.isEmpty()) return;
    mb.getSize(ms); exts.push(Math.max(ms.x, ms.y, ms.z));
  });
  exts.sort((a, b) => a - b);
  const median = exts.length ? exts[Math.floor(exts.length / 2)]! : 0;
  const fullSize = new THREE.Vector3(); full.getSize(fullSize);
  const fullMax = Math.max(fullSize.x, fullSize.y, fullSize.z, 1);
  // Use the full size normally; only fall back to a median-based radius when the full box is a WILD
  // outlier vs the main mass (a stray far mesh). Frame generously (×8) so we never end up inside the car.
  const r = (median > 0 && fullMax > median * 10) ? median * 8 : fullMax;
  // Cars face +Z (after manifest rotations) → camera in FRONT (+z) + to the side, looking back.
  cam.position.set(center.x + r * 0.72, center.y + r * 0.42, center.z + r * 1.15);
  cam.lookAt(center.x, center.y - r * 0.04, center.z);
  cam.updateProjectionMatrix();
  try { renderer.render(scene, cam); return renderer.domElement.toDataURL('image/png'); } catch { return ''; }
}

/**
 * Render the car-select portraits by LOADING EACH GLB FRESH (the exact path the Garage uses, which
 * renders every car — incl. the 123-mesh McLaren + open-frame Yuterra — whole). Borrowing the
 * AssetLoader's shared, normalized template fragmented those complex models; a fresh load + the
 * same stripDisplayBases + applyModelTransform the game uses does not. Async + yielding so the menu
 * stays smooth; reports each portrait via onOne(i, url) as it lands. One car GLB lives in the rig at
 * a time (added, shot, removed, disposed).
 */
export async function renderCarThumbnailsAsync(
  assets: AssetLoader, onOne: (i: number, url: string) => void, size = 256,
): Promise<string[]> {
  const n = assets.carCount();
  if (n === 0) return [];
  let rig: ReturnType<typeof makeThumbRig>;
  try { rig = makeThumbRig(size); } catch { return new Array(n).fill(''); }
  const loader = makeLoader();
  const out: string[] = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    const ref = assets.carRef(i);
    let url = '';
    if (ref) {
      try {
        const gltf = await new Promise<any>((res, rej) => loader.load(`/assets/${ref.file}`, res, undefined, rej));
        const model: THREE.Object3D = gltf.scene;
        stripDisplayBases(model);
        // Rotate the assembled model as a rigid unit via an outer wrapper, at the model's NATIVE
        // scale — do NOT rescale to a target. Rescaling complex hierarchies (the 123-mesh McLaren)
        // scattered them, because some meshes carry baked transforms that don't survive a group
        // rescale. The thumbnail camera frames whatever size the car is, so native scale is fine.
        // Render at the model's NATIVE scale (do NOT rescale — rescaling scatters complex
        // hierarchies like the 123-mesh McLaren whose meshes carry baked transforms). Rotation lives
        // on a wrapper so the model spins as a rigid unit. The camera frames to whatever size it is.
        const wrap = new THREE.Group();
        wrap.add(model);
        if (ref.rotation) wrap.rotation.set(deg(ref.rotation[0]!), deg(ref.rotation[1]!), deg(ref.rotation[2]!));
        rig.scene.add(wrap);
        url = frameAndShoot(rig, wrap);
        rig.scene.remove(wrap);
        disposeTree(model);                                         // free GPU memory between cars
      } catch { url = ''; }
    }
    out[i] = url;
    onOne(i, url);
    await new Promise(requestAnimationFrame);   // yield a frame between cars
  }
  rig.renderer.dispose();
  return out;
}

/** Free geometries + materials + textures of a loaded GLB subtree (per-car, so 19 loads don't leak). */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose?.();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) { if (!mat) continue; for (const k in mat) { const v = (mat as any)[k]; if (v && v.isTexture) v.dispose(); } mat.dispose?.(); }
    }
  });
}

/** Synchronous all-at-once render — kept for tests (they stub the AssetLoader). Uses the loaded
 *  templates directly; not used by the live app (which streams fresh loads via the async fn). */
export function renderCarThumbnails(assets: AssetLoader, size = 256): string[] {
  const n = assets.carCount();
  if (n === 0) return [];
  let rig: ReturnType<typeof makeThumbRig>;
  try { rig = makeThumbRig(size); } catch { return new Array(n).fill(''); }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const tmpl = assets.carTemplate(i);
    if (!tmpl) { out.push(''); continue; }
    const prev = tmpl.parent; rig.scene.add(tmpl);
    out.push(frameAndShoot(rig, tmpl));
    rig.scene.remove(tmpl); if (prev) prev.add(tmpl);
  }
  rig.renderer.dispose();
  return out;
}

/**
 * Render a MAP's 3D world to a preview PNG (''=fail) for the map-select tile — so the player sees
 * what the track actually looks like instead of a blank placeholder. Loads the map GLB, frames the
 * whole scene from an elevated 3/4 "establishing shot" angle. Heavy (scenery models are big) but
 * runs once per map at boot. Maps usually use spec-gloss/specular PBR, so we add a soft env light.
 */
export async function renderMapThumbnail(cfg: MapConfig, size = 480): Promise<string> {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
  catch { return ''; }
  renderer.setSize(size, Math.round(size * 0.62));   // landscape tile
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  const sun = new THREE.DirectionalLight(0xfff4e2, 2.4); sun.position.set(60, 120, -40); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202840, 1.0));

  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  const loader = new GLTFLoader(); loader.setDRACOLoader(draco);

  let url = '';
  try {
    const gltf = await new Promise<any>((res, rej) =>
      loader.load(`/assets/maps/${cfg.file}`, res, undefined, rej));
    const world: THREE.Object3D = gltf.scene;
    scene.add(world);
    world.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(world);
    if (!box.isEmpty()) {
      const c = new THREE.Vector3(); box.getCenter(c);
      const s = new THREE.Vector3(); box.getSize(s);
      const r = Math.max(s.x, s.z, 1);
      // Elevated establishing shot: high + back, looking down at the scene center.
      const cam = new THREE.PerspectiveCamera(50, renderer.domElement.width / renderer.domElement.height, 0.1, r * 12);
      cam.position.set(c.x + r * 0.55, c.y + r * 0.55, c.z + r * 0.75);
      cam.lookAt(c.x, c.y, c.z);
      cam.updateProjectionMatrix();
      renderer.render(scene, cam);
      url = renderer.domElement.toDataURL('image/png');
    }
  } catch { url = ''; }
  renderer.dispose();
  return url;
}
