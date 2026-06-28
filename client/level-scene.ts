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
import { AssetLoader } from './asset-loader';
import { buildCar } from './car-factory';
import { RACE_LEN, laneX, LANES } from '../shared/constants';
import { addProp as addPropPure, duplicateProp as dupPropPure, removeProp as rmPropPure,
         resolveCarScale, type PlacedProp } from '../shared/level';
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
  private propGroups = new Map<string, THREE.Group>();
  private selKey: 'map' | 'track' | string = 'track';
  private assets = new AssetLoader();
  private previewCars = new THREE.Group();
  private carPreviewOn = false;

  constructor(mount: HTMLElement) {
    // kick off car-template loading non-blocking; preview cars fall back to primitives until ready
    this.assets.loadManifest().catch(() => {});
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

  /** Mutable live level ref, so the inspector panels can read/write car scale etc. in place. */
  getLevel(): LevelConfig { return this.level; }

  setCarPreview(on: boolean): void { this.carPreviewOn = on; this.applyCars(); }

  /** Whether sample-car preview is on — so a panel re-render can reflect the live toggle state. */
  carPreviewEnabled(): boolean { return this.carPreviewOn; }

  /**
   * (Re)build sample cars at the start of each lane, scaled by the level's resolved car scale.
   * CONTRACT: overrides are keyed by the car INDEX STRING ("0","1","2", …) — the same key the game
   * uses (cars are assigned by index), NOT a GLB filename. Keep this in lockstep with the cars panel.
   */
  applyCars(): void {
    this.previewCars.clear();
    if (!this.carPreviewOn) return;
    for (let lane = 0; lane < LANES; lane++) {
      const tmpl = this.assets.carTemplate(lane);
      const model = buildCar(tmpl ?? null, '#36d1dc', false);
      const wrap = new THREE.Group(); wrap.add(model);
      const s = resolveCarScale(this.level, String(lane));
      wrap.scale.setScalar(s);
      wrap.position.set(laneX(lane), 0.6, 20);
      this.previewCars.add(wrap);
    }
    this.changeCb();
  }

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
    // props ride the track transform like the surface
    this.propGroups.clear();
    for (const p of level.props) this.spawnProp(p);
    // sample cars (editor-only preview) ride the track transform like the surface/props
    this.trackGroup.add(this.previewCars);
    this.applyCars();
    this.select('track');
  }

  // helper to instantiate one prop group
  private spawnProp(p: PlacedProp): void {
    this.loader.load(`/assets/${p.file}`, (g) => {
      const grp = new THREE.Group(); grp.add(g.scene);
      grp.position.set(p.pos[0]!, p.pos[1]!, p.pos[2]!);
      grp.rotation.set(p.rotDeg[0]! * Math.PI/180, p.rotDeg[1]! * Math.PI/180, p.rotDeg[2]! * Math.PI/180);
      grp.scale.setScalar(p.scale);
      grp.userData.propId = p.id;
      this.trackGroup.add(grp);            // props ride the track transform like the surface
      this.propGroups.set(p.id, grp);
    }, undefined, () => { /* skip failed prop */ });
  }

  // add a prop from the library at the track start (sim z≈40, lane center)
  addProp(file: string): string {
    this.level = addPropPure(this.level, file, [0, 0, 40]);
    const p = this.level.props[this.level.props.length - 1]!;
    this.spawnProp(p);
    this.select(p.id);
    return p.id;
  }

  duplicateSelectedProp(): string | null {
    if (this.selKey === 'map' || this.selKey === 'track') return null;
    this.level = dupPropPure(this.level, this.selKey);
    const p = this.level.props[this.level.props.length - 1]!;
    this.spawnProp(p);
    this.select(p.id);
    return p.id;
  }

  removeSelectedProp(): void {
    if (this.selKey === 'map' || this.selKey === 'track') return;
    const g = this.propGroups.get(this.selKey);
    if (g) { this.trackGroup.remove(g); this.propGroups.delete(this.selKey); }
    this.level = rmPropPure(this.level, this.selKey);
    this.select('track');
  }

  selectedKey(): 'map' | 'track' | string { return this.selKey; }

  select(key: 'map' | 'track' | string): void {
    this.selKey = key;
    if (key === 'map') this.gizmo.attach(this.mapGroup);
    else if (key === 'track') this.gizmo.attach(this.trackGroup);
    else { const g = this.propGroups.get(key); if (g) this.gizmo.attach(g); }
    this.changeCb();
  }

  /** Read the live scene transforms back into a LevelConfig for saving. */
  current(): LevelConfig {
    const t = (o: THREE.Object3D): LevelTransform => ({
      pos: o.position.toArray().map(n => Math.round(n * 1000) / 1000),
      rotDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map(r => Math.round(r * 180 / Math.PI)),
      scale: Math.round(o.scale.x * 1000) / 1000,
    });
    const props: PlacedProp[] = this.level.props.map(p => {
      const g = this.propGroups.get(p.id);
      return g ? { ...p, ...t(g) } : p;
    });
    return { ...this.level, model: t(this.mapGroup), track: t(this.trackGroup), props };
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
