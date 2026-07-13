import * as THREE from 'three';
import {
  clipsForFighter,
  ANIMATION_POOLS,
  loadFbx,
  prepareFighterModel,
  type FighterSpec,
} from './fighter-assets';

export class FighterActor {
  readonly root = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  private current: THREE.AnimationAction | null = null;
  private currentId = 'idle';
  private returnToPose = true;
  private lastVariant = new Map<string, string>();
  private readonly baseModelY: number;
  private floorLocked = false;
  private readonly floorPoint = new THREE.Vector3();

  private constructor(
    readonly model: THREE.Group,
    private readonly clips: Map<string, THREE.AnimationClip>,
  ) {
    this.root.add(model);
    this.baseModelY = model.position.y;
    this.mixer = new THREE.AnimationMixer(model);
    this.mixer.addEventListener('finished', event => {
      if (event.action === this.current && this.returnToPose && this.currentId !== 'idle') this.play('idle', { loop: true, fade: 0.12 });
    });
    this.play('idle', { loop: true, fade: 0 });
  }

  static async load(
    spec: FighterSpec,
    sources: ReadonlyMap<string, THREE.AnimationClip>,
    onProgress?: (fraction: number) => void,
  ): Promise<FighterActor> {
    const model = await loadFbx(spec.file, onProgress);
    prepareFighterModel(model);
    return new FighterActor(model, clipsForFighter(model, sources, false));
  }

  static fallback(color: string): FighterActor {
    const model = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.2 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.05, 6, 12), material); body.position.y = 1.05;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), material); head.position.y = 2;
    const stance = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.18, 0.42), material); stance.position.y = 0.12;
    model.add(body, head, stance);
    return new FighterActor(model, new Map());
  }

  play(id: string, options: { loop?: boolean; hold?: boolean; fade?: number; speed?: number; lockFloor?: boolean } = {}): number {
    const clip = this.clips.get(id);
    if (!clip) return 0;
    const next = this.mixer.clipAction(clip);
    const loop = options.loop ?? false;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = options.hold ?? !loop;
    next.reset().setEffectiveTimeScale(options.speed ?? 1).setEffectiveWeight(1).play();
    const fade = options.fade ?? 0.12;
    if (this.current && this.current !== next) this.current.fadeOut(fade);
    if (fade) next.fadeIn(fade);
    this.current = next;
    this.currentId = id;
    this.returnToPose = !options.hold;
    if (options.lockFloor) this.floorLocked = true;
    else if (this.floorLocked) { this.floorLocked = false; this.model.position.y = this.baseModelY; }
    return clip.duration / (options.speed ?? 1);
  }

  playRandom(pool: string, options: { loop?: boolean; hold?: boolean; fade?: number; speed?: number; lockFloor?: boolean } = {}): number {
    const available = (ANIMATION_POOLS[pool] ?? [pool]).filter(id => this.clips.has(id));
    if (!available.length) return 0;
    const prior = this.lastVariant.get(pool);
    const choices = available.length > 1 ? available.filter(id => id !== prior) : available;
    const id = choices[Math.floor(Math.random() * choices.length)]!;
    this.lastVariant.set(pool, id); return this.play(id, options);
  }

  update(delta: number): void {
    this.mixer.update(delta);
    if (this.floorLocked) {
      this.root.updateMatrixWorld(true);
      const minY = new THREE.Box3().setFromObject(this.model, true).min.y;
      const floorY = this.root.getWorldPosition(this.floorPoint).y;
      if (Number.isFinite(minY)) this.model.position.y += floorY - minY;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    disposeObject(this.root);
    this.root.removeFromParent();
  }
}

function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of values) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}
