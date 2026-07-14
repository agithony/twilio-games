import * as THREE from 'three';

export interface FighterAtmosphereSpec {
  top: string; horizon: string; ground: string;
  celestial: string; celestialGlow: string; celestialX: number; celestialY: number; celestialRadius: number;
  mountain: string[]; skyline?: boolean; stars?: boolean; clouds: string;
  platform?: 'wet-stone';
  effect: 'rain' | 'neon' | 'motes'; effectColor: number; effectCount: number;
  keyColor: number; keyIntensity: number; redColor: number; redIntensity: number;
  cyanColor: number; cyanIntensity: number; skyColor: number; groundColor: number;
  ambientIntensity: number; exposure: number; fogColor: number; fogDensity: number;
}

const SPECS: Record<string, FighterAtmosphereSpec> = {
  'cyberpunk-city': {
    top: '#07051c', horizon: '#31115a', ground: '#090411', celestial: '#b9d9ff', celestialGlow: '#5b8cff',
    celestialX: .78, celestialY: .2, celestialRadius: 34, mountain: ['#120b2b', '#0b071d', '#070512'], skyline: true, stars: true,
    clouds: 'rgba(120,65,180,.16)', effect: 'neon', effectColor: 0xff50e5, effectCount: 96,
    keyColor: 0x9eb8ff, keyIntensity: 3.6, redColor: 0xff2bd6, redIntensity: 75,
    cyanColor: 0x24e8ff, cyanIntensity: 70, skyColor: 0x6677cc, groundColor: 0x11051f,
    ambientIntensity: 1.55, exposure: 1.08, fogColor: 0x170925, fogDensity: .012,
  },
  inakaya: {
    top: '#18243d', horizon: '#e7884d', ground: '#24130f', celestial: '#fff1b8', celestialGlow: '#ff9c5b',
    celestialX: .72, celestialY: .28, celestialRadius: 42, mountain: ['#3f3540', '#292736', '#171925'],
    clouds: 'rgba(255,220,190,.2)', effect: 'motes', effectColor: 0xffc47a, effectCount: 110,
    keyColor: 0xffd5a3, keyIntensity: 4.6, redColor: 0xff7a3d, redIntensity: 48,
    cyanColor: 0x8fc8ff, cyanIntensity: 24, skyColor: 0xa5bce0, groundColor: 0x2b160e,
    ambientIntensity: 1.45, exposure: 1.12, fogColor: 0x5f3528, fogDensity: .009,
  },
  rain: {
    top: '#07111e', horizon: '#263f53', ground: '#071018', celestial: '#b8d7e8', celestialGlow: '#7095b0',
    celestialX: .2, celestialY: .23, celestialRadius: 28, mountain: ['#1c3543', '#122a36', '#091923'],
    clouds: 'rgba(170,195,210,.2)', platform: 'wet-stone', effect: 'rain', effectColor: 0x9edfff, effectCount: 220,
    keyColor: 0xa9c9df, keyIntensity: 2.7, redColor: 0x6b77ff, redIntensity: 28,
    cyanColor: 0x67cfff, cyanIntensity: 52, skyColor: 0x698ba3, groundColor: 0x07121a,
    ambientIntensity: 1.2, exposure: .98, fogColor: 0x152b38, fogDensity: .017,
  },
};

export function fighterAtmosphereSpec(mapId: string): FighterAtmosphereSpec | null { return SPECS[mapId] ?? null; }

export class FighterAtmosphere {
  readonly background: THREE.CanvasTexture;
  private readonly effect: THREE.Points | THREE.LineSegments;
  private readonly staticRoot = new THREE.Group();
  private readonly positions: Float32Array;
  private readonly center: THREE.Vector3;
  private elapsed = 0;

  constructor(readonly spec: FighterAtmosphereSpec, scene: THREE.Scene, center: THREE.Vector3, fightOrigin: THREE.Vector3, rotationY: number) {
    this.center = center.clone();
    this.background = makeSkyTexture(spec);
    scene.background = this.background;
    if (spec.platform === 'wet-stone') this.staticRoot.add(makeWetStonePlatform(fightOrigin, rotationY));
    scene.add(this.staticRoot);
    const built = spec.effect === 'rain' ? makeRain(spec, center) : makeParticles(spec, center);
    this.effect = built.object; this.positions = built.positions; scene.add(this.effect);
  }

  setEffectVisible(visible: boolean): void { this.effect.visible = visible; }
  freezeStatic(): void { this.staticRoot.visible = false; }

  update(delta: number): void {
    this.elapsed += delta;
    if (this.spec.effect === 'rain') this.updateRain(delta);
    else this.updateParticles(delta);
    this.effect.geometry.attributes.position!.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.effect, this.staticRoot); this.effect.geometry.dispose();
    const material = this.effect.material; if (Array.isArray(material)) material.forEach(value => value.dispose()); else material.dispose();
    disposeGroup(this.staticRoot);
    this.background.dispose();
  }

  private updateRain(delta: number): void {
    const low = this.center.y - 1, high = this.center.y + 13;
    for (let index = 0; index < this.positions.length; index += 6) {
      let y = this.positions[index + 1]! - delta * 20;
      let x = this.positions[index]! + delta * 3.2;
      if (y < low) { y = high; x = this.center.x + seeded(index + Math.floor(this.elapsed * 7)) * 32 - 16; }
      this.positions[index] = x; this.positions[index + 1] = y;
      this.positions[index + 3] = x - .12; this.positions[index + 4] = y - .8;
    }
  }

  private updateParticles(delta: number): void {
    const low = this.center.y, high = this.center.y + 10;
    const speed = this.spec.effect === 'neon' ? .45 : .7;
    for (let index = 0; index < this.positions.length; index += 3) {
      let y = this.positions[index + 1]! + delta * speed;
      if (y > high) y = low;
      this.positions[index + 1] = y;
      this.positions[index] = this.positions[index]! + Math.sin(this.elapsed * .7 + index) * delta * .08;
    }
  }
}

function makeSkyTexture(spec: FighterAtmosphereSpec): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const sky = context.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, spec.top); sky.addColorStop(.62, spec.horizon); sky.addColorStop(1, spec.ground);
  context.fillStyle = sky; context.fillRect(0, 0, canvas.width, canvas.height);
  if (spec.stars) drawStars(context, canvas.width, canvas.height);
  drawCelestial(context, spec, canvas.width, canvas.height);
  drawClouds(context, spec, canvas.width, canvas.height);
  drawMountains(context, spec, canvas.width, canvas.height);
  if (spec.skyline) drawSkyline(context, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; return texture;
}

function drawCelestial(context: CanvasRenderingContext2D, spec: FighterAtmosphereSpec, width: number, height: number): void {
  const x = width * spec.celestialX, y = height * spec.celestialY;
  const glow = context.createRadialGradient(x, y, 0, x, y, spec.celestialRadius * 3.4);
  glow.addColorStop(0, spec.celestialGlow); glow.addColorStop(.2, `${spec.celestialGlow}88`); glow.addColorStop(1, `${spec.celestialGlow}00`);
  context.fillStyle = glow; context.fillRect(x - 180, y - 180, 360, 360);
  context.beginPath(); context.arc(x, y, spec.celestialRadius, 0, Math.PI * 2); context.fillStyle = spec.celestial; context.fill();
}

function drawClouds(context: CanvasRenderingContext2D, spec: FighterAtmosphereSpec, width: number, height: number): void {
  context.save(); context.fillStyle = spec.clouds; context.filter = 'blur(18px)';
  const count = spec.effect === 'rain' ? 11 : 8;
  for (let index = 0; index < count; index++) {
    const x = seeded(index * 17 + 3) * width, y = 70 + seeded(index * 31 + 9) * 190;
    const span = 90 + seeded(index) * 120, thickness = 15 + seeded(index + 2) * 22;
    for (let lobe = -1; lobe <= 1; lobe++) {
      context.beginPath(); context.ellipse(x + lobe * span * .46, y + Math.abs(lobe) * 8, span * (.62 + seeded(index + lobe + 8) * .25), thickness * (1 + seeded(index + lobe + 11) * .45), -.08, 0, Math.PI * 2); context.fill();
    }
  }
  context.restore();
}

function drawMountains(context: CanvasRenderingContext2D, spec: FighterAtmosphereSpec, width: number, height: number): void {
  spec.mountain.forEach((color, layer) => {
    const base = height * (.7 + layer * .1); context.beginPath(); context.moveTo(0, height); context.lineTo(0, base);
    const segments = 12;
    for (let index = 0; index <= segments; index++) {
      const x = index * width / segments;
      const peak = base - (35 + seeded(index + layer * 19) * (105 - layer * 18));
      context.lineTo(x, peak);
    }
    context.lineTo(width, height); context.closePath(); context.fillStyle = color; context.fill();
  });
}

function drawSkyline(context: CanvasRenderingContext2D, width: number, height: number): void {
  for (let index = 0; index < 32; index++) {
    const buildingWidth = 22 + seeded(index * 5) * 36, buildingHeight = 45 + seeded(index * 13) * 145;
    const x = index * width / 31 - buildingWidth / 2, y = height - 80 - buildingHeight;
    context.fillStyle = index % 2 ? '#080615' : '#0e0920'; context.fillRect(x, y, buildingWidth, buildingHeight);
    context.fillStyle = index % 3 ? 'rgba(50,225,255,.48)' : 'rgba(255,45,215,.5)';
    for (let windowY = y + 12; windowY < y + buildingHeight - 8; windowY += 16) for (let windowX = x + 7; windowX < x + buildingWidth - 5; windowX += 12) {
      if (seeded(index * 97 + windowY + windowX) > .42) context.fillRect(windowX, windowY, 4, 6);
    }
  }
}

function drawStars(context: CanvasRenderingContext2D, width: number, height: number): void {
  for (let index = 0; index < 90; index++) {
    const alpha = .25 + seeded(index * 7) * .7; context.fillStyle = `rgba(210,225,255,${alpha})`;
    const size = seeded(index * 11) > .86 ? 2 : 1; context.fillRect(seeded(index * 17) * width, seeded(index * 23) * height * .65, size, size);
  }
}

function makeRain(spec: FighterAtmosphereSpec, center: THREE.Vector3): { object: THREE.LineSegments; positions: Float32Array } {
  const positions = new Float32Array(spec.effectCount * 6);
  for (let index = 0; index < positions.length; index += 6) {
    const x = center.x + seeded(index) * 32 - 16, y = center.y + seeded(index + 1) * 14, z = center.z + seeded(index + 2) * 16 - 8;
    positions.set([x, y, z, x - .12, y - .8, z], index);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: spec.effectColor, transparent: true, opacity: .35, depthWrite: false, fog: false });
  const object = new THREE.LineSegments(geometry, material); object.frustumCulled = false; object.renderOrder = 20; return { object, positions };
}

function makeParticles(spec: FighterAtmosphereSpec, center: THREE.Vector3): { object: THREE.Points; positions: Float32Array } {
  const positions = new Float32Array(spec.effectCount * 3);
  for (let index = 0; index < positions.length; index += 3) positions.set([
    center.x + seeded(index) * 28 - 14, center.y + seeded(index + 1) * 10, center.z + seeded(index + 2) * 14 - 7,
  ], index);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: spec.effectColor, size: spec.effect === 'neon' ? .055 : .075, transparent: true, opacity: .58, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const object = new THREE.Points(geometry, material); object.frustumCulled = false; object.renderOrder = 20; return { object, positions };
}

function makeWetStonePlatform(origin: THREE.Vector3, rotationY: number): THREE.Group {
  const group = new THREE.Group(); group.position.copy(origin); group.rotation.y = rotationY;
  const stone = new THREE.MeshStandardMaterial({ color: 0x172631, roughness: .52, metalness: .25 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x0b151d, roughness: .75, metalness: .12 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x6fc8e8, transparent: true, opacity: .28 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(23, .32, 5.8), stone); slab.position.y = -.2; group.add(slab);
  for (const z of [-2.88, 2.88]) {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(23.5, .5, .38), edge); ledge.position.set(0, -.3, z); group.add(ledge);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(22.8, .018, .035), glow); strip.position.set(0, .012, z * .96); group.add(strip);
  }
  for (let x = -10.5; x <= 10.5; x += 1.5) {
    const seam = new THREE.Mesh(new THREE.BoxGeometry(.022, .012, 5.4), glow); seam.position.set(x, .008, 0); seam.material = glow; group.add(seam);
  }
  const puddleMaterial = new THREE.MeshBasicMaterial({ color: 0x8ecbe5, transparent: true, opacity: .12, depthWrite: false });
  for (let index = 0; index < 7; index++) {
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(.45 + seeded(index * 13) * .75, 20), puddleMaterial);
    puddle.rotation.x = -Math.PI / 2; puddle.scale.y = .35; puddle.position.set(-8.5 + index * 2.8, .018, (seeded(index * 21) - .5) * 3.7); group.add(puddle);
  }
  return group;
}

function disposeGroup(group: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  group.traverse(object => {
    const mesh = object as THREE.Mesh; mesh.geometry?.dispose();
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    values.forEach(material => materials.add(material));
  });
  materials.forEach(material => material.dispose());
}

function seeded(value: number): number { const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }
