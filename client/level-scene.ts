// client/level-scene.ts
// The editor's 3D viewport: loads the map GLB, builds the track surface, holds the gizmo, and lets
// the caller select/edit Map, Track, or a Prop. Reuses the align tool's proven modules. `current()`
// reads the live transforms back out so the bootstrap can serialize on Save.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { wrapMapScene, applyTrackTransform } from './map-world';
import { CurvedTrack } from './track-path';
import { buildTrackSurface, surfaceOptsFromPath } from './track-surface';
import { RACE_LEN } from '../shared/constants';
import type { LevelConfig, LevelTransform } from '../shared/level';

export class LevelScene {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 50000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private loader = new GLTFLoader();
  private mapGroup = new THREE.Group();
  private trackGroup = new THREE.Group();
  private surface = new THREE.Group();
  private level!: LevelConfig;
  private changeCb: () => void = () => {};

  constructor(mount: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x223047);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x303040, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(300, 800, 200); this.scene.add(sun);
    this.scene.add(new THREE.GridHelper(RACE_LEN * 2, 60, 0x44597f, 0x2c3a55));
    this.scene.add(this.mapGroup, this.trackGroup);

    const d = new DRACOLoader(); d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.loader.setDRACOLoader(d);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true; this.orbit.minDistance = 0; this.orbit.maxDistance = Infinity;
    this.camera.position.set(RACE_LEN * 0.6, RACE_LEN * 0.5, -RACE_LEN * 0.3);
    this.orbit.target.set(0, 0, RACE_LEN / 2); this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', (e) =>
      { this.orbit.enabled = !(e as unknown as { value: boolean }).value; });
    this.gizmo.addEventListener('objectChange', () => this.changeCb());

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
    this.loop();
  }

  onChange(cb: () => void): void { this.changeCb = cb; }

  async loadLevel(level: LevelConfig): Promise<void> {
    this.level = level;
    // reset groups
    this.mapGroup.clear(); this.trackGroup.clear();
    // map GLB
    await new Promise<void>((res) => {
      this.loader.load(`/assets/maps/${level.file}`, (g) => {
        const wrap = wrapMapScene(g.scene); this.mapGroup.add(wrap);
        applyTrackTransform(this.mapGroup, level.model); res();
      }, undefined, () => res());
    });
    // track surface
    applyTrackTransform(this.trackGroup, level.track);
    this.surface = buildTrackSurface(new CurvedTrack(level.path ?? { points: [[0,0],[0,RACE_LEN]] }),
      surfaceOptsFromPath(level.path));
    this.trackGroup.add(this.surface);
    this.select('track');
  }

  select(key: 'map' | 'track' | string): void {
    if (key === 'map') this.gizmo.attach(this.mapGroup);
    else this.gizmo.attach(this.trackGroup);   // props handled in Phase 4
    this.changeCb();
  }

  /** Read the live scene transforms back into a LevelConfig for saving. */
  current(): LevelConfig {
    const t = (o: THREE.Object3D): LevelTransform => ({
      pos: o.position.toArray().map(n => Math.round(n * 1000) / 1000),
      rotDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map(r => Math.round(r * 180 / Math.PI)),
      scale: Math.round(o.scale.x * 1000) / 1000,
    });
    return { ...this.level, model: t(this.mapGroup), track: t(this.trackGroup) };
  }

  private loop(): void {
    requestAnimationFrame(() => this.loop());
    this.orbit.update();
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.camera.far = Math.max(2000, dist * 4); this.camera.near = Math.max(0.05, dist / 5000);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
