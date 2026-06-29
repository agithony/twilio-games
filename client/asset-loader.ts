import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { isWheelNode, isDisplayBaseNode, groundPlaneIndices, CAR_TARGET, BARRIER_TARGET, BOOST_TARGET } from '../shared/asset-fit';
import type { MeshSize } from '../shared/asset-fit';
import { parseManifest } from '../shared/asset-manifest';
import type { Manifest, AssetRef } from '../shared/asset-manifest';
import { applyModelTransform } from './model-transform';

/** Count mesh descendants of an object (including itself). */
function meshCount(o: THREE.Object3D): number {
  let n = 0; o.traverse((c) => { if ((c as THREE.Mesh).isMesh) n++; }); return n;
}

/**
 * Remove showroom display props (bases, floors, turntable discs, photo backdrops) from a
 * loaded GLB so only the actual vehicle remains. Shared by the game loader and the editor
 * so both see identical geometry. Collects matches first, then detaches (mutating during
 * traverse is unsafe).
 *
 * STRUCTURAL GUARD: a real showroom prop is a SMALL leaf (a single flat plane/disc/dome), whereas
 * car parts that happen to be named "Circle"/"Sphere"/"Base" (e.g. wheels named Circle_NNN that
 * PARENT the rim/tire meshes, or a body named BaseCar) hold many meshes. So we only strip a
 * name-matched node when it carries at most 1 mesh — this protects wheel groups + bodies that
 * earlier over-eager name rules were deleting (McLaren wheels, climber body).
 */
export function stripDisplayBases(root: THREE.Object3D): void {
  const remove: THREE.Object3D[] = [];
  root.traverse(o => {
    if (o === root || !o.name || !isDisplayBaseNode(o.name)) return;
    if (meshCount(o) > 1) return;   // a multi-mesh group is real geometry, not a flat prop
    remove.push(o);
  });
  for (const o of remove) o.parent?.remove(o);
  stripGroundPlanes(root);
}

/**
 * Remove giant flat "environment" meshes (embedded floors/tracks/stadiums) that name-based
 * stripping can't catch because they're named generically (e.g. the Squadra Lamborghini ships a
 * whole oval circuit as Object_99…). Uses size, not name: measures each MESH's local bbox and drops
 * the flat huge outliers (see groundPlaneIndices). Conservative — does nothing unless there's a
 * clear small-vehicle-vs-huge-ground split.
 */
export function stripGroundPlanes(root: THREE.Object3D): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (meshes.length < 3) return;
  const box = new THREE.Box3(); const size = new THREE.Vector3();
  const sizes: MeshSize[] = meshes.map(m => {
    box.setFromObject(m); box.getSize(size);
    return { w: size.x, h: size.y, d: size.z };
  });
  for (const i of groundPlaneIndices(sizes)) meshes[i]!.parent?.remove(meshes[i]!);
}

export class AssetLoader {
  private loader: GLTFLoader;
  private manifest: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };
  private cars: (THREE.Group | null)[] = [];
  private barrier: THREE.Group | null = null;
  private boost: THREE.Group | null = null;

  constructor() {
    this.loader = new GLTFLoader();
    // Our models are Draco-compressed (Task 1.5). DRACOLoader needs decoder wasm/js;
    // use the three.js CDN-hosted decoder (or vendor it under /assets/draco/ for offline).
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.loader.setDRACOLoader(draco);
  }

  async loadManifest(): Promise<void> {
    try {
      const res = await fetch('/api/manifest');
      if (!res.ok) return;   // HTTP error => everything stays primitive (fetch doesn't reject on !ok)
      // Run the body through parseManifest (tolerant; returns EMPTY_MANIFEST on bad input) so a
      // malformed 200 body can't throw in the .map calls below and yields a valid Manifest shape.
      this.manifest = parseManifest(await res.text());
      this.cars = await Promise.all(this.manifest.cars.map(r => this.loadRef(r, CAR_TARGET)));
      this.barrier = this.manifest.barrier ? await this.loadRef(this.manifest.barrier, BARRIER_TARGET) : null;
      this.boost   = this.manifest.boostPad ? await this.loadRef(this.manifest.boostPad, BOOST_TARGET) : null;
    } catch { return; }   // no manifest => everything stays primitive
  }

  private loadRef(ref: AssetRef, target: number): Promise<THREE.Group | null> {
    return new Promise((resolve) => {
      this.loader.load(`/assets/${ref.file}`, (gltf) => {
        try {
          const g = this.normalize(gltf.scene, ref, target);
          // Baked clips are OFF by default: on free Sketchfab models they're usually SHOWCASE
          // animations (doors opening, "air out") with an OPEN resting pose that looks broken while
          // driving. Cars then animate via wheel-spin. Opt IN per-model with ref.animate (Models
          // Library toggle) for cars whose clip runs cleanly. buildCar reads userData.clips.
          g.userData.clips = ref.animate ? gltf.animations : [];
          resolve(g);
        }
        catch { resolve(null); }
      }, undefined, () => resolve(null));   // load error => null => primitive fallback
    });
  }

  private normalize(scene: THREE.Group, ref: AssetRef, target: number): THREE.Group {
    const g = scene;
    // REMOVE showroom display props (turntable bases, floors, photo backdrops, camera
    // bokeh planes) entirely — so they don't render AND don't skew the measurements that
    // drive auto-fit and grounding. Done before any Box3 so the car alone defines the size.
    stripDisplayBases(g);
    // rotate → fit → ground/center via the shared helper (same ordering as the garage). Rotating
    // BEFORE measuring keeps off-origin models (e.g. monster truck) centered after a 90° turn.
    applyModelTransform(g, ref, target);
    // tag wheel meshes for spin animation
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => { if (isWheelNode(o.name)) wheels.push(o); });
    g.userData.wheels = wheels;
    g.castShadow = true; g.traverse(o => { (o as THREE.Mesh).castShadow = true; });
    return g;
  }

  carTemplate(i: number): THREE.Group | null { return this.cars.length ? this.cars[i % this.cars.length] ?? null : null; }
  barrierTemplate(): THREE.Group | null { return this.barrier; }
  boostTemplate(): THREE.Group | null { return this.boost; }
  /** The manifest car-model filenames in order (car index i uses carFile(i)). Used to key per-level
   *  car-scale overrides by MODEL (so each car model can be sized per level), not by join index. */
  carFiles(): string[] { return this.manifest.cars.map(r => r.file); }
  carFile(i: number): string | null {
    return this.manifest.cars.length ? this.manifest.cars[i % this.manifest.cars.length]!.file : null;
  }
  /** The loaded car template for a given model filename (null if not found / not loaded). */
  carTemplateByFile(file: string): THREE.Group | null {
    const i = this.manifest.cars.findIndex(r => r.file === file);
    return i >= 0 ? this.cars[i] ?? null : null;
  }
}
