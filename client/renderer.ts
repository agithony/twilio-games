import * as THREE from 'three';
import { TRACK_W, TRACK_LEN, LANES, laneX } from '../shared/constants';
import type { WorldSnapshot, Item } from '../shared/types';
import { AssetLoader } from './asset-loader';
import { buildCar } from './car-factory';

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private carMeshes = new Map<string, THREE.Group>();
  private carIndex = new Map<string, number>();
  private nextCarIndex = 0;
  private itemMeshes: { mesh: THREE.Object3D; item: Item }[] = [];
  private myId: string | null = null;
  private lastFrame = performance.now();

  constructor(mount: HTMLElement, private assets?: AssetLoader) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0b1020);
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 2000);

    const sun = new THREE.DirectionalLight(0xfff6e6, 1.2);
    sun.position.set(40, 80, -20); sun.castShadow = true; this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x5566aa, 0.6));

    const track = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, TRACK_LEN * 3),
      new THREE.MeshStandardMaterial({ color: 0x1a2238 }));
    track.rotation.x = -Math.PI / 2; track.position.z = TRACK_LEN; this.scene.add(track);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  setMyId(id: string) { this.myId = id; }

  buildItems(items: Item[]) {
    for (const { mesh } of this.itemMeshes) this.scene.remove(mesh);
    this.itemMeshes = items.map(item => {
      let mesh: THREE.Object3D;
      if (item.kind === 'barrier') {
        const template = this.assets?.barrierTemplate() ?? null;
        mesh = template
          ? template.clone(true)
          : new THREE.Mesh(new THREE.BoxGeometry(TRACK_W / LANES - 1.5, 1.6, 1.2),
              new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0x550000 }));
      } else {
        const template = this.assets?.boostTemplate() ?? null;
        mesh = template
          ? template.clone(true)
          : new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.25, 20),
              new THREE.MeshStandardMaterial({ color: 0x36e08a, emissive: 0x0a5a32 }));
      }
      mesh.position.set(laneX(item.lane), item.kind === 'barrier' ? 0.8 : 0.13, item.z);
      this.scene.add(mesh);
      return { mesh, item };
    });
  }

  private ensureCar(id: string, color: string): THREE.Group {
    let g = this.carMeshes.get(id);
    if (!g) {
      let idx = this.carIndex.get(id);
      if (idx === undefined) { idx = this.nextCarIndex++; this.carIndex.set(id, idx); }
      const template = this.assets?.carTemplate(idx) ?? null;
      g = buildCar(template, color, id === this.myId);
      this.scene.add(g); this.carMeshes.set(id, g);
    }
    return g;
  }

  render(snap: WorldSnapshot) {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    for (const c of snap.cars) {
      const g = this.ensureCar(c.id, c.color);
      g.position.set(c.x, 0, c.z);
      // Animation priority: baked clip (mixer) > wheel-spin > static.
      const mixer = g.userData.mixer as THREE.AnimationMixer | undefined;
      if (mixer) {
        mixer.update(dt);
      } else {
        const wheels = g.userData.wheels as THREE.Object3D[] | undefined;
        if (wheels && wheels.length) {
          for (const w of wheels) w.rotation.x += dt * 14;
        }
      }
    }
    const me = snap.cars.find(c => c.id === this.myId) ?? snap.cars[0];
    const z = me ? me.z : 0;
    this.camera.position.set(13, 15, z - 30);
    this.camera.lookAt(me ? me.x * 0.4 : 0, 1.5, z + 26);
    this.renderer.render(this.scene, this.camera);
  }
}
