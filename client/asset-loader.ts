import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { autoFitScale, isWheelNode, CAR_TARGET, BARRIER_TARGET, BOOST_TARGET } from '../shared/asset-fit';
import type { Manifest, AssetRef } from '../shared/asset-manifest';

const deg = (d: number) => (d * Math.PI) / 180;

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
      this.manifest = await res.json();
    } catch { return; }   // no manifest => everything stays primitive
    this.cars = await Promise.all(this.manifest.cars.map(r => this.loadRef(r, CAR_TARGET)));
    this.barrier = this.manifest.barrier ? await this.loadRef(this.manifest.barrier, BARRIER_TARGET) : null;
    this.boost   = this.manifest.boostPad ? await this.loadRef(this.manifest.boostPad, BOOST_TARGET) : null;
  }

  private loadRef(ref: AssetRef, target: number): Promise<THREE.Group | null> {
    return new Promise((resolve) => {
      this.loader.load(`/assets/${ref.file}`, (gltf) => {
        try {
          const g = this.normalize(gltf.scene, ref, target);
          // Preserve any baked animation clips on the template for the factory/renderer.
          // (Real Sketchfab cars often animate via a clip, not wheel nodes — see Global Constraints.)
          g.userData.clips = gltf.animations ?? [];
          resolve(g);
        }
        catch { resolve(null); }
      }, undefined, () => resolve(null));   // load error => null => primitive fallback
    });
  }

  private normalize(scene: THREE.Group, ref: AssetRef, target: number): THREE.Group {
    const g = scene;
    // measure, auto-fit to target longest dimension
    const box = new THREE.Box3().setFromObject(g);
    const size = new THREE.Vector3(); box.getSize(size);
    const fit = autoFitScale([size.x, size.y, size.z], target);
    const s = fit * (ref.scale ?? 1);
    g.scale.setScalar(s);
    // recompute box after scaling; sit the model on y=0 and center x/z, then apply offset
    const box2 = new THREE.Box3().setFromObject(g);
    const c = new THREE.Vector3(); box2.getCenter(c);
    const min = box2.min;
    g.position.x += -c.x + (ref.offset?.[0] ?? 0);
    g.position.y += -min.y + (ref.offset?.[1] ?? 0);
    g.position.z += -c.z + (ref.offset?.[2] ?? 0);
    if (ref.rotation) g.rotation.set(deg(ref.rotation[0]), deg(ref.rotation[1]), deg(ref.rotation[2]));
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
}
