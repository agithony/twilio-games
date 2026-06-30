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

  /**
   * Fetch the manifest + load the car/barrier/boost GLBs. Resolves as soon as the MANIFEST is parsed
   * (names/count known) — the model GLBs then stream in IN THE BACKGROUND, filling this.cars[i] as
   * each arrives. This is deliberate: on a slow link the 19 GLBs (one is 7.8MB) took ~40s, and the
   * old code awaited Promise.all(all cars) before the menu/attract could start → the 3D background
   * didn't appear for a long time. Now the menu is interactive immediately; cars upgrade from
   * primitive fallback to real model as they load. `ready` (optional) resolves when ALL have loaded.
   */
  async loadManifest(): Promise<void> {
    try {
      const res = await fetch('/api/manifest');
      if (!res.ok) return;   // HTTP error => everything stays primitive (fetch doesn't reject on !ok)
      // Run the body through parseManifest (tolerant; returns EMPTY_MANIFEST on bad input).
      this.manifest = parseManifest(await res.text());
      // Pre-size the cars array so carTemplate(i) returns null (→ primitive) until GLB i lands.
      this.cars = new Array(this.manifest.cars.length).fill(null);
      // Kick off ALL loads without awaiting the whole batch — each fills its slot as it resolves.
      this.carsReady = Promise.all([
        ...this.manifest.cars.map((r, i) => this.loadRef(r, CAR_TARGET).then(g => { this.cars[i] = g; })),
        this.manifest.barrier ? this.loadRef(this.manifest.barrier, BARRIER_TARGET).then(g => { this.barrier = g; }) : Promise.resolve(),
        this.manifest.boostPad ? this.loadRef(this.manifest.boostPad, BOOST_TARGET).then(g => { this.boost = g; }) : Promise.resolve(),
      ]).then(() => undefined);
    } catch { return; }   // no manifest => everything stays primitive
  }

  /** Resolves once every car/barrier/boost GLB has finished loading (or immediately if none). The
   *  thumbnail renderer awaits this so it doesn't snapshot half-loaded templates. */
  carsReady: Promise<void> = Promise.resolve();

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
          // Keep ALL baked clips on a side field (not used by the game). The car-select thumbnail
          // rig samples these to pose SHOWCASE models (McLaren "Air Out", Yuterra "Take 001") whose
          // resting pose is OPEN/exploded — without it their portraits render as scattered panels.
          g.userData.allClips = gltf.animations ?? [];
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
    // Tag wheel nodes for spin animation. We spin about each node's LOCAL X (rotation.x += dt), which
    // only looks right when the node's origin is at the wheel's axle. Two hazards in real GLBs:
    //   1) BOTH a wrapper group and its child mesh are named like a wheel (Batmobile:
    //      "frontrighttire" + "frontrighttire_BatMobile_0") → spinning both compounds rotations.
    //   2) A wrapper group's origin is the model center, not the axle → rotating it ORBITS the wheel
    //      around the car instead of spinning it ("flying around everywhere").
    // So tag only the SINGLE-MESH leaf wheels (origin ≈ the wheel itself) and skip multi-mesh wheel
    // wrappers. A model whose wheels are all wrappers simply won't wheel-spin (static glide), which
    // looks fine — far better than wheels flying off.
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => {
      if (!isWheelNode(o.name)) return;
      if (meshCount(o) !== 1) return;   // wrapper/group → don't spin (would orbit)
      for (let p = o.parent; p && p !== g.parent; p = p.parent) if (isWheelNode(p.name)) return;
      wheels.push(o);
    });
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
  /** Number of cars in the manifest (the selectable roster size). */
  carCount(): number { return this.manifest.cars.length; }
  /** The raw manifest AssetRef for car i (file + scale/rotation/offset), for the thumbnail rig to
   *  load + place a FRESH copy of the GLB (the Garage-proven path that renders every car whole). */
  carRef(i: number): AssetRef | null { return this.manifest.cars[i] ?? null; }
  /** Friendly display name for car i: the manifest `name`, else a prettified filename. */
  carName(i: number): string {
    const r = this.manifest.cars[i];
    if (!r) return `Car ${i + 1}`;
    return r.name?.trim() || r.file.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim();
  }
  /** All car display names in manifest order (for the car-select grid). */
  carNames(): string[] { return this.manifest.cars.map((_, i) => this.carName(i)); }
}
