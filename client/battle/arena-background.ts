// The 3D battle arena that sits BEHIND the 2D Game Boy overlay. A slowly-spinning turntable of the
// arena model (three.js), rendered into its own WebGL canvas layered under the pixel-art battle
// canvas — the monsters + HP boxes draw over it, the command window is an opaque panel at the bottom.
// Transform/camera/spin come from an ArenaConfig (authored later in the multi-game editor); sensible
// defaults auto-frame the model so it looks right with zero config.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ArenaConfig {
  file: string;                 // under /assets/arena/
  pos?: [number, number, number];
  rotDeg?: [number, number, number];
  scale?: number;
  spinSpeed?: number;           // turntable radians/sec (0 = static). Default a slow spin.
  cam?: { pos: [number, number, number]; lookAt: [number, number, number]; fov?: number };
}

/** interactive: true → the editor gets drag-rotate + scroll-zoom OrbitControls (and the auto-spin is
 *  paused) so you can PICK the camera angle, then read it back with cameraPose(). false (default) →
 *  the in-battle background: fixed auto-framed camera + turntable spin, non-interactive. */
export interface ArenaOpts { interactive?: boolean }

export class ArenaBackground {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private turntable = new THREE.Group();   // the arena is parented here; we spin THIS
  private raf = 0;
  private last = performance.now();
  private spinSpeed = 0.18;                 // slow, cinematic default
  private disposed = false;
  private orbit: OrbitControls | null = null;   // editor-only camera control
  private interactive: boolean;

  constructor(private host: HTMLElement, opts: ArenaOpts = {}) {
    this.interactive = opts.interactive ?? false;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x0b1a0c, 1);          // deep GB-green void behind the arena
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(0, 3, 8);
    this.scene.add(this.turntable);
    // Lighting: a warm key + cool fill + hemisphere so the arena reads without a PMREM env (cheap).
    const key = new THREE.DirectionalLight(0xfff2d8, 2.0); key.position.set(6, 10, 6); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7); fill.position.set(-6, 4, -4); this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x24401c, 0.9));
    // EDITOR ONLY: drag to rotate, scroll to zoom, right-drag to pan — same basic camera controls the
    // racer editor has. In the live battle this stays null (fixed auto-framed camera + turntable spin).
    if (this.interactive) {
      this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
      this.orbit.enableDamping = true;
      this.orbit.minDistance = 0.5;
      this.orbit.zoomToCursor = true;
    }
    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  /** Load + place the arena. Auto-frames the camera on the model's bounds unless cfg.cam is given. */
  load(cfg: ArenaConfig): void {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);
    this.spinSpeed = cfg.spinSpeed ?? this.spinSpeed;
    loader.load(`/assets/arena/${cfg.file}`, (gltf) => {
      if (this.disposed) return;
      const model = gltf.scene;
      // Recenter the model on its own footprint so the turntable spins about its center, not a corner.
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      model.position.sub(center);
      if (cfg.pos) model.position.add(new THREE.Vector3(...cfg.pos));
      if (cfg.rotDeg) model.rotation.set(...cfg.rotDeg.map(d => (d * Math.PI) / 180) as [number, number, number]);
      if (cfg.scale) model.scale.setScalar(cfg.scale);
      this.turntable.add(model);
      // Auto-frame: pull the camera back to fit the model, angled down slightly (arena look).
      const lookAt = new THREE.Vector3(0, 0, 0);
      if (cfg.cam) {
        this.camera.fov = cfg.cam.fov ?? 45;
        this.camera.position.set(...cfg.cam.pos);
        lookAt.set(...cfg.cam.lookAt);
      } else {
        const r = Math.max(size.x, size.y, size.z) * (cfg.scale ?? 1);
        const dist = r * 1.4 + 2;
        this.camera.position.set(0, r * 0.5, dist);
      }
      this.camera.lookAt(lookAt);
      if (this.orbit) { this.orbit.target.copy(lookAt); this.orbit.update(); }   // keep orbit pivot in sync
      this.camera.updateProjectionMatrix();
    }, undefined, () => { /* load failed → the green void remains as a fallback backdrop */ });
  }

  private resize = (): void => {
    const w = this.host.clientWidth || 640, h = this.host.clientHeight || 640;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
    // In the editor you're POSING the camera, so pause the auto-spin (you'd fight it); the battle
    // background spins. A tiny preview spin in the editor is still nice, so keep a gentle spin only
    // when the user isn't actively dragging.
    if (!this.interactive) this.turntable.rotation.y += this.spinSpeed * dt;
    this.orbit?.update();
    this.renderer.render(this.scene, this.camera);
  };

  /** Read back the current camera pose (for the editor's "Set camera" → saved into ArenaConfig.cam). */
  cameraPose(): { pos: [number, number, number]; lookAt: [number, number, number]; fov: number } {
    const t = this.orbit ? this.orbit.target : new THREE.Vector3(0, 0, 0);
    const p = this.camera.position;
    return { pos: [round(p.x), round(p.y), round(p.z)], lookAt: [round(t.x), round(t.y), round(t.z)], fov: this.camera.fov };
  }
  /** Live spin-speed setter so the editor's slider updates the preview immediately. */
  setSpin(speed: number): void { this.spinSpeed = speed; }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.orbit?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;
