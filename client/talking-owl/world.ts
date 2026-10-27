import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type OwlRoomMode = 'study' | 'lab';

const TAU = Math.PI * 2;
const SNACK_DURATION = 2.65;
const DRINK_DURATION = 2.45;
// The table and held versions use the same character action clock at pickup.
const PICKUP_HANDOFF = .35;

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function ink(color: number, roughness = 0.75, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function glow(color: number, strength = 1.2): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: strength,
    roughness: 0.32,
    metalness: 0.12,
  });
}

function block(
  parent: THREE.Object3D,
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  round = 0,
): THREE.Mesh {
  const geometry = round > 0
    ? new RoundedBoxGeometry(width, height, depth, 3, Math.min(round, width * 0.49, height * 0.49, depth * 0.49))
    : new THREE.BoxGeometry(width, height, depth);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function ball(
  parent: THREE.Object3D,
  radius: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(
  parent: THREE.Object3D,
  top: number,
  bottom: number,
  height: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  sides = 24,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, sides), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function hoop(
  parent: THREE.Object3D,
  radius: number,
  tube: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  horizontal = false,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 48), material);
  mesh.position.set(x, y, z);
  if (horizontal) mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function beam(
  parent: THREE.Object3D,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 10), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function tube(parent: THREE.Object3D, coordinates: number[][], radius: number, material: THREE.Material): THREE.Mesh {
  const points = coordinates.map(([x = 0, y = 0, z = 0]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 8), radius, 8, false), material);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function plane(
  parent: THREE.Object3D,
  width: number,
  height: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function seeded(seed: number): number {
  const value = Math.sin(seed * 127.1 + 78.233) * 43758.5453123;
  return value - Math.floor(value);
}

/** A biscuit has an uneven beveled crust, rather than a perfectly round disc. */
function biscuit(parent: THREE.Object3D, y: number, seed: number): THREE.Group {
  const biscuitGroup = new THREE.Group();
  biscuitGroup.position.y = y;
  parent.add(biscuitGroup);
  const outline = new THREE.Shape();
  for (let index = 0; index <= 32; index++) {
    const angle = index * TAU / 32;
    const radius = .177 * (1 + Math.sin(angle * 7 + seed) * .036
      + Math.sin(angle * 11 + seed * 1.7) * .024);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (index === 0) outline.moveTo(x, z); else outline.lineTo(x, z);
  }
  const crust = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, {
    depth: .047,
    bevelEnabled: true,
    bevelThickness: .011,
    bevelSize: .008,
    bevelSegments: 2,
    steps: 1,
  }), ink(0xc58a50, .96));
  crust.name = 'Hand-shaped oat biscuit crust';
  crust.rotation.x = -Math.PI / 2;
  crust.castShadow = true;
  crust.receiveShadow = true;
  biscuitGroup.add(crust);
  const chocolate = ink(0x50332b, .77);
  const toast = ink(0xe6b475, .98);
  for (let index = 0; index < 9; index++) {
    const angle = seeded(index * 7 + seed * 17) * TAU;
    const radius = .025 + seeded(index * 13 + seed * 5) * .125;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const chip = ball(biscuitGroup, .015 + seeded(index + seed) * .007, chocolate,
      x, .056, z, 1.1, .34, .75);
    chip.rotation.y = angle;
    ball(biscuitGroup, .006 + seeded(index * 3 + seed) * .003, toast,
      x + .026, .058, z - .018, 1.2, .25, .9);
  }
  return biscuitGroup;
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void, width: number, height: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is required for the Talking Owl stage.');
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function woodTexture(): THREE.CanvasTexture {
  const texture = canvasTexture((ctx, width, height) => {
    ctx.fillStyle = '#493126';
    ctx.fillRect(0, 0, width, height);
    for (let index = 0; index < 100; index++) {
      const y = seeded(index * 5.2) * height;
      const swing = 5 + seeded(index * 1.7) * 28;
      ctx.strokeStyle = index % 4 === 0 ? 'rgba(19,11,13,.34)' : 'rgba(214,145,85,.12)';
      ctx.lineWidth = index % 5 === 0 ? 3 : 1;
      ctx.beginPath();
      ctx.moveTo(-15, y);
      ctx.bezierCurveTo(width * .25, y + swing, width * .6, y - swing, width + 15, y + seeded(index + 23) * 13);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(11,17,22,.3)';
    ctx.fillRect(0, 0, width, 5);
    ctx.fillRect(0, height - 5, width, 5);
  }, 512, 256);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 10);
  return texture;
}

function wallpaperTexture(lab: boolean): THREE.CanvasTexture {
  const texture = canvasTexture((ctx, width, height) => {
    ctx.fillStyle = lab ? '#0b2531' : '#1c3943';
    ctx.fillRect(0, 0, width, height);
    for (let x = 0; x < width; x += 64) {
      ctx.fillStyle = lab ? 'rgba(40,105,114,.08)' : 'rgba(214,179,112,.07)';
      ctx.fillRect(x + 5, 0, 14, height);
      ctx.strokeStyle = lab ? 'rgba(93,197,194,.14)' : 'rgba(221,183,112,.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 32, 0);
      ctx.lineTo(x + 32, height);
      ctx.stroke();
    }
    if (!lab) {
      for (let x = 32; x < width; x += 64) for (let y = 25; y < height; y += 74) {
        ctx.strokeStyle = 'rgba(234,194,127,.13)';
        ctx.beginPath();
        ctx.ellipse(x, y, 14, 25, 0, 0, TAU);
        ctx.ellipse(x, y, 5, 14, 0, 0, TAU);
        ctx.stroke();
      }
    }
  }, 512, 512);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 2);
  return texture;
}

function rugTexture(): THREE.CanvasTexture {
  return canvasTexture((ctx, width, height) => {
    const gradient = ctx.createRadialGradient(width / 2, height / 2, 30, width / 2, height / 2, width * .5);
    gradient.addColorStop(0, '#154e58');
    gradient.addColorStop(.62, '#102f40');
    gradient.addColorStop(1, '#0c2839');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    const borders = [
      [18, '#bd8f58', 5], [34, '#326c72', 12], [53, '#d7b675', 3], [74, '#0a2432', 20], [95, '#aa7c4f', 3],
    ] as const;
    for (const [inset, color, lineWidth] of borders) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
    }
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.strokeStyle = '#b6905d';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(0, -height * .32);
    ctx.lineTo(width * .2, 0);
    ctx.lineTo(0, height * .32);
    ctx.lineTo(-width * .2, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = '#d7ba7f';
    ctx.lineWidth = 3;
    for (const scale of [.18, .32, .45]) {
      ctx.beginPath();
      ctx.ellipse(0, 0, width * scale, height * scale, 0, 0, TAU);
      ctx.stroke();
    }
    for (let index = 0; index < 12; index++) {
      ctx.save();
      ctx.rotate(index * TAU / 12);
      ctx.fillStyle = index % 2 === 0 ? '#d4af70' : '#478f91';
      ctx.beginPath();
      ctx.moveTo(0, -height * .16);
      ctx.quadraticCurveTo(15, -height * .22, 0, -height * .28);
      ctx.quadraticCurveTo(-15, -height * .22, 0, -height * .16);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    for (let row = 0; row < 2; row++) for (let index = 0; index < 14; index++) {
      const x = 107 + index * (width - 214) / 13;
      const y = row === 0 ? 106 : height - 106;
      ctx.fillStyle = index % 2 ? '#b58a59' : '#75a7a2';
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x + 8, y);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 8, y);
      ctx.closePath();
      ctx.fill();
    }
  }, 1024, 768);
}

function nightWindowTexture(): THREE.CanvasTexture {
  return canvasTexture((ctx, width, height) => {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#0a1b35');
    sky.addColorStop(.63, '#17485c');
    sky.addColorStop(1, '#0c2935');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
    const moon = ctx.createRadialGradient(328, 164, 8, 328, 164, 130);
    moon.addColorStop(0, 'rgba(219,246,250,.95)');
    moon.addColorStop(.19, 'rgba(185,226,239,.65)');
    moon.addColorStop(1, 'rgba(112,199,217,0)');
    ctx.fillStyle = moon;
    ctx.fillRect(170, 0, 310, 320);
    ctx.fillStyle = '#e8f5e9';
    ctx.beginPath();
    ctx.arc(328, 164, 43, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(184,210,204,.35)';
    ctx.beginPath();
    ctx.arc(313, 151, 7, 0, TAU);
    ctx.arc(343, 180, 5, 0, TAU);
    ctx.fill();
    for (let index = 0; index < 68; index++) {
      const x = seeded(index + 1) * width;
      const y = seeded(index * 7 + 2) * height * .72;
      const r = .5 + seeded(index * 13) * 1.8;
      ctx.fillStyle = index % 7 === 0 ? '#e7edc5' : 'rgba(185,224,239,.82)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    for (let layer = 0; layer < 3; layer++) {
      const base = height * (.77 + layer * .1);
      ctx.fillStyle = ['#163c49', '#0c2d39', '#09242e'][layer]!;
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, base);
      for (let x = 0; x <= width; x += 22) {
        const rise = 20 + seeded(layer * 61 + x) * 86;
        ctx.lineTo(x, base - rise);
      }
      ctx.lineTo(width, height);
      ctx.fill();
    }
    for (let index = 0; index < 18; index++) {
      const x = index * width / 17 + seeded(index + 90) * 20;
      const top = height * (.68 + seeded(index + 25) * .16);
      const trunk = 55 + seeded(index + 120) * 70;
      ctx.fillStyle = '#08222c';
      ctx.fillRect(x - 2, top, 4, trunk);
      for (let level = 0; level < 4; level++) {
        ctx.beginPath();
        ctx.moveTo(x, top - 58 + level * 23);
        ctx.lineTo(x - 21 - level * 4, top + level * 26);
        ctx.lineTo(x + 21 + level * 4, top + level * 26);
        ctx.fill();
      }
    }
  }, 512, 640);
}

function artworkTexture(): THREE.CanvasTexture {
  return canvasTexture((ctx, width, height) => {
    ctx.fillStyle = '#e9dbb9';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#b79a62';
    ctx.lineWidth = 6;
    ctx.strokeRect(19, 19, width - 38, height - 38);
    ctx.strokeStyle = '#d3b67e';
    ctx.lineWidth = 2;
    ctx.strokeRect(29, 29, width - 58, height - 58);
    ctx.fillStyle = '#153a44';
    ctx.font = 'bold 25px Georgia';
    ctx.textAlign = 'center';
    ctx.fillText('THE NIGHT NATURALIST', width / 2, 70);
    ctx.fillStyle = '#18414b';
    ctx.fillRect(56, 95, width - 112, 346);
    ctx.strokeStyle = '#cba76d';
    ctx.lineWidth = 3;
    ctx.strokeRect(62, 101, width - 124, 334);
    const glow = ctx.createRadialGradient(334, 172, 5, 334, 172, 139);
    glow.addColorStop(0, 'rgba(223,211,154,.28)');
    glow.addColorStop(1, 'rgba(223,211,154,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(70, 103, 373, 290);
    ctx.fillStyle = '#f0dfae';
    ctx.beginPath();
    ctx.arc(359, 158, 36, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#18414b';
    ctx.beginPath();
    ctx.arc(374, 144, 34, 0, TAU);
    ctx.fill();
    for (let index = 0; index < 16; index++) {
      const x = 88 + seeded(index * 3 + 8) * 330;
      const y = 117 + seeded(index * 7 + 31) * 225;
      ctx.fillStyle = index % 3 === 0 ? '#d6bc82' : '#9db4aa';
      ctx.beginPath();
      ctx.arc(x, y, index % 4 === 0 ? 2 : 1.25, 0, TAU);
      ctx.fill();
    }
    // The owl is painted as one plump silhouette with two soft face disks.
    ctx.fillStyle = '#765844';
    ctx.beginPath();
    ctx.ellipse(256, 341, 103, 89, 0, 0, TAU);
    ctx.fill();
    // The portrait wears the same simple red track jacket as the owl in the chair.
    ctx.fillStyle = '#EF223A';
    ctx.beginPath();
    ctx.ellipse(256, 352, 96, 76, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#B10F23';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = '#fff5e7';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(256, 302);
    ctx.lineTo(256, 418);
    ctx.stroke();
    ctx.fillStyle = '#927055';
    ctx.beginPath();
    ctx.ellipse(256, 242, 112, 99, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(162, 202);
    ctx.lineTo(150, 139);
    ctx.quadraticCurveTo(188, 156, 206, 180);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(350, 202);
    ctx.lineTo(362, 139);
    ctx.quadraticCurveTo(324, 156, 306, 180);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#a27b59';
    ctx.beginPath();
    ctx.ellipse(171, 332, 35, 71, -.37, 0, TAU);
    ctx.ellipse(341, 332, 35, 71, .37, 0, TAU);
    ctx.fill();
    for (const side of [-1, 1]) {
      const eyeX = 256 + side * 48;
      ctx.fillStyle = '#e4d4ac';
      ctx.beginPath();
      ctx.ellipse(eyeX, 241, 51, 58, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#e1ad62';
      ctx.beginPath();
      ctx.arc(eyeX, 249, 25, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#293d40';
      ctx.beginPath();
      ctx.arc(eyeX, 249, 13, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fff2d0';
      ctx.beginPath();
      ctx.arc(eyeX - 5, 243, 4.5, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#d89754';
    ctx.beginPath();
    ctx.moveTo(256, 272);
    ctx.lineTo(244, 291);
    ctx.quadraticCurveTo(256, 303, 268, 291);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#6b553f';
    ctx.lineCap = 'round';
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(99, 408);
    ctx.quadraticCurveTo(256, 392, 408, 411);
    ctx.stroke();
    ctx.strokeStyle = '#b79062';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(99, 403);
    ctx.quadraticCurveTo(256, 387, 408, 406);
    ctx.stroke();
    for (const x of [222, 290]) {
      ctx.strokeStyle = '#b68851';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(x, 390);
      ctx.lineTo(x, 409);
      ctx.moveTo(x, 407);
      ctx.lineTo(x - 9, 415);
      ctx.moveTo(x, 407);
      ctx.lineTo(x + 9, 415);
      ctx.stroke();
    }
    ctx.fillStyle = '#6e5a43';
    ctx.font = 'italic 15px Georgia';
    ctx.fillText('TALKING OWL  •  1918', width / 2, height - 42);
  }, 512, 512);
}

function newspaperTexture(): THREE.CanvasTexture {
  return canvasTexture((ctx, width, height) => {
    ctx.fillStyle = '#e9dfc7';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2c3531';
    ctx.textAlign = 'center';
    ctx.font = 'bold 27px Georgia';
    ctx.fillText('THE EVENING HOOT', width / 2, 39);
    ctx.fillRect(20, 49, width - 40, 2);
    ctx.font = 'bold 15px Georgia';
    ctx.fillText('STRANGE LIGHTS ABOVE THE OLD LAB', width / 2, 71);
    ctx.fillStyle = '#93a8a0';
    ctx.fillRect(26, 85, width - 52, 60);
    ctx.fillStyle = '#425653';
    ctx.beginPath();
    ctx.moveTo(40, 132);
    ctx.lineTo(82, 94);
    ctx.lineTo(120, 126);
    ctx.lineTo(158, 90);
    ctx.lineTo(218, 132);
    ctx.fill();
    ctx.strokeStyle = '#263b39';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(53, 134);
    ctx.lineTo(114, 134);
    ctx.stroke();
    ctx.fillStyle = '#34423b';
    ctx.beginPath();
    ctx.ellipse(84, 117, 9, 12, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(84, 103, 10, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(76, 98);
    ctx.lineTo(74, 91);
    ctx.lineTo(81, 95);
    ctx.moveTo(92, 98);
    ctx.lineTo(94, 91);
    ctx.lineTo(87, 95);
    ctx.fill();
    ctx.fillStyle = '#e9dfc7';
    ctx.beginPath();
    ctx.arc(80, 104, 1.6, 0, TAU);
    ctx.arc(88, 104, 1.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#34423b';
    for (let column = 0; column < 3; column++) for (let row = 0; row < 15; row++) {
      const length = 58 + seeded(column * 47 + row) * 8;
      ctx.fillRect(25 + column * 76, 160 + row * 7, length, 2);
    }
  }, 256, 286);
}

function labSignTexture(): THREE.CanvasTexture {
  return canvasTexture((ctx, width, height) => {
    ctx.fillStyle = '#0b202b';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#b6a073';
    ctx.lineWidth = 5;
    ctx.strokeRect(9, 8, width - 18, height - 16);
    ctx.strokeStyle = '#4ed5cc';
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 17, width - 36, height - 34);
    ctx.fillStyle = '#e7d6a9';
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px Georgia';
    ctx.fillText('TALKING OWL', width / 2, 58);
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side < 0 ? 61 : width - 61, 62);
      ctx.scale(side, 1);
      ctx.rotate(-.18);
      ctx.fillStyle = '#b6a073';
      ctx.beginPath();
      ctx.moveTo(-7, 19);
      ctx.quadraticCurveTo(-25, -3, 2, -27);
      ctx.quadraticCurveTo(23, -9, 8, 10);
      ctx.quadraticCurveTo(0, 19, -7, 19);
      ctx.fill();
      ctx.strokeStyle = '#0b202b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-8, 23);
      ctx.quadraticCurveTo(3, -2, 4, -21);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = '#70d4ce';
    ctx.font = '16px Georgia';
    ctx.fillText('THE CURIOSITY LABORATORY', width / 2, 91);
  }, 512, 128);
}

interface Bubble {
  mesh: THREE.Mesh;
  radius: number;
  phase: number;
  drift: number;
}

type MixMotion = 'spiral' | 'burst' | 'fountain' | 'plain';

interface MixRecipe {
  title: string;
  quip: string;
  accent: string;
  liquid: number;
  light: number;
  particles: readonly number[];
  motion: MixMotion;
}

const MIX_DURATION = 3.6;
const MIX_RECIPES: Record<'berry-mint' | 'berry-amber' | 'mint-amber' | 'plain', MixRecipe> = {
  'berry-mint': {
    title: 'Moonberry Waltz',
    quip: 'It is dancing. Please do not teach it the cha-cha.',
    accent: '#c58de8',
    liquid: 0x9562c9,
    light: 0x9d6cc9,
    particles: [0x9b60ce, 0x3aaba8, 0xb985d7],
    motion: 'spiral',
  },
  'berry-amber': {
    title: 'Comet Pop',
    quip: 'Splendid. It nearly redecorated the ceiling.',
    accent: '#ffa46a',
    liquid: 0xd96573,
    light: 0xe58c4d,
    particles: [0xe99445, 0xd85c6d, 0xefbb6d],
    motion: 'burst',
  },
  'mint-amber': {
    title: 'Sunshower Fizz',
    quip: 'Refreshing. Volatile, but refreshing.',
    accent: '#bde76b',
    liquid: 0x81bc4d,
    light: 0x98c34a,
    particles: [0x87b94c, 0x3ab99e, 0xbad96b],
    motion: 'fountain',
  },
  plain: {
    title: 'Curious Concoction',
    quip: 'Well. That was certainly chemistry.',
    accent: '#67dacc',
    liquid: 0x17aa8c,
    light: 0x67dacc,
    particles: [0x65e8d2, 0x91dff2, 0xb3f6a4],
    motion: 'plain',
  },
};

const REAGENT_COLORS: Record<string, number> = {
  berry: 0xa85ed0,
  mint: 0x36bfa4,
  amber: 0xd79e47,
};

/**
 * A self-contained miniature set. Its only external light dependency is the
 * renderer's key/fill lighting; the practical fixtures are included here.
 */
export class TalkingOwlWorld {
  readonly group = new THREE.Group();

  private readonly study = new THREE.Group();
  private readonly lab = new THREE.Group();
  private readonly textures: THREE.Texture[] = [];
  private readonly bubbles: Bubble[] = [];
  private readonly sparks: THREE.Mesh[] = [];
  private readonly orbitRings: THREE.Mesh[] = [];
  private readonly burstRays = new THREE.Group();
  private readonly liquidMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly dust: THREE.Points;
  private readonly dustPositions: Float32Array;
  private readonly phoneReceiver = new THREE.Group();
  private readonly paperFlap = new THREE.Group();
  private readonly snackLid = new THREE.Group();
  private readonly snackCookie = new THREE.Group();
  private readonly portrait = new THREE.Group();
  private readonly teaCup = new THREE.Group();
  private readonly teaSaucer = new THREE.Group();
  private readonly teaSurface = new THREE.Group();
  private readonly teaSteam = new THREE.Group();
  private readonly lampFixture = new THREE.Group();
  private readonly reactorRotor = new THREE.Group();
  private readonly labFlasks: THREE.Group[] = [];
  private readonly phoneIndicator = glow(0xffa85e, .1);
  private readonly warmLamp = new THREE.PointLight(0xffbd7f, 0, 5, 2);
  private readonly phoneLight = new THREE.PointLight(0xff9f59, 0, 1.7, 2);
  private readonly labLight = new THREE.PointLight(0x46e4d4, 0, 5.5, 2);
  private readonly reactionLight = new THREE.PointLight(0x7effd3, 0, 4.4, 2);
  private readonly orbitMaterial = new THREE.MeshBasicMaterial({
    color: 0x9b60ce, transparent: true, opacity: .36, depthWrite: false,
    toneMapped: false,
  });
  private readonly burstMaterial = new THREE.MeshBasicMaterial({
    color: 0xe99445, transparent: true, opacity: .55, depthWrite: false,
    toneMapped: false,
  });
  private readonly plumeMaterial = new THREE.MeshBasicMaterial({
    color: 0x87b94c, transparent: true, opacity: .1, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  private readonly reactionRing: THREE.Mesh;
  private fountainPlume: THREE.Mesh | null = null;
  private readonly chairStudy: THREE.Group;
  private readonly chairLab: THREE.Group;
  private mode: OwlRoomMode = 'study';
  private clock = 0;
  private mixTime = 0;
  private mixRecipe: MixRecipe = MIX_RECIPES.plain;
  private mixStarted = false;
  private phoneActive = false;
  private phoneAnswered = false;
  private phoneReturnTime = 0;
  private paperTime = 0;
  private feedTime = 0;
  private portraitTime = 0;
  private drinkTime = 0;
  private burpTime = 0;
  private lampEnabled = true;

  constructor() {
    this.group.name = 'Talking Owl miniature set';
    this.study.name = 'The midnight study';
    this.lab.name = 'The curious laboratory';
    this.group.add(this.study, this.lab);
    this.buildShell(this.study, false);
    this.chairStudy = this.buildChair(this.study, false);
    this.buildStudy();
    this.buildShell(this.lab, true);
    this.chairLab = this.buildChair(this.lab, true);
    this.reactionRing = this.buildLab();
    this.lab.visible = false;

    const positions = new Float32Array(96 * 3);
    for (let index = 0; index < 96; index++) {
      positions[index * 3] = seeded(index + 100) * 10 - 5;
      positions[index * 3 + 1] = .5 + seeded(index + 213) * 4.7;
      positions[index * 3 + 2] = seeded(index + 43) * 5 - 2.5;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dustPositions = positions;
    this.dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({
      color: 0xffd9a0,
      size: .035,
      sizeAttenuation: true,
      transparent: true,
      opacity: .66,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.dust.frustumCulled = false;
    this.study.add(this.dust);
  }

  setMode(mode: OwlRoomMode): void {
    this.mode = mode;
    this.study.visible = mode === 'study';
    this.lab.visible = mode === 'lab';
  }

  mixIngredients(first: string, second: string): { title: string; quip: string; accent: string } {
    const a = first.trim().toLowerCase();
    const b = second.trim().toLowerCase();
    const has = (one: string, two: string): boolean => (a === one && b === two) || (a === two && b === one);
    const recipe = has('berry', 'mint') ? MIX_RECIPES['berry-mint']
      : has('berry', 'amber') ? MIX_RECIPES['berry-amber']
        : has('mint', 'amber') ? MIX_RECIPES['mint-amber']
          : MIX_RECIPES.plain;
    this.mixRecipe = recipe;
    this.mixStarted = true;
    this.mixTime = MIX_DURATION;
    this.applyMixColors(a, b);
    return { title: recipe.title, quip: recipe.quip, accent: recipe.accent };
  }

  private applyMixColors(first: string, second: string): void {
    const liquidColors = [this.mixRecipe.liquid, REAGENT_COLORS[first] ?? 0x298fc4, REAGENT_COLORS[second] ?? 0xa447ad];
    this.liquidMaterials.forEach((material, index) => {
      const color = liquidColors[index] ?? this.mixRecipe.liquid;
      material.color.setHex(color);
      material.emissive.setHex(color);
    });
    this.reactionLight.color.setHex(this.mixRecipe.light);
    (this.reactionRing.material as THREE.MeshBasicMaterial).color.setHex(this.mixRecipe.light);
    this.orbitMaterial.color.setHex(this.mixRecipe.light);
    this.burstMaterial.color.setHex(this.mixRecipe.light);
    this.plumeMaterial.color.setHex(this.mixRecipe.light);
    this.bubbles.forEach(({ mesh }, index) => {
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(this.mixRecipe.particles[index % this.mixRecipe.particles.length]!);
    });
    this.sparks.forEach((mesh, index) => {
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(this.mixRecipe.particles[(index + 1) % this.mixRecipe.particles.length]!);
    });
  }

  trigger(action: string): void {
    switch (action) {
      case 'call':
        this.phoneActive = true;
        this.phoneAnswered = false;
        this.phoneReturnTime = 0;
        this.phoneReceiver.visible = true;
        break;
      case 'answer':
        this.phoneActive = true;
        this.phoneAnswered = true;
        this.phoneReturnTime = 0;
        this.phoneReceiver.visible = false;
        break;
      case 'hangup':
        this.phoneActive = false;
        this.phoneAnswered = false;
        // The owl lowers the handset for 1.2 seconds; return the desk handset
        // once the held one disappears so two are never on screen.
        this.phoneReturnTime = 1.24;
        this.phoneReceiver.visible = false;
        break;
      case 'newspaper':
        this.paperTime = 1.25;
        break;
      case 'mix':
      case 'chemistry':
        this.mixStarted = true;
        this.mixTime = MIX_DURATION;
        break;
      case 'feed':
      case 'snack':
        this.feedTime = SNACK_DURATION;
        break;
      case 'drink':
      case 'sip':
        this.drinkTime = DRINK_DURATION;
        break;
      case 'burp':
        this.burpTime = 1.05;
        this.paperTime = Math.max(this.paperTime, .8);
        break;
      case 'lamp':
        this.lampEnabled = !this.lampEnabled;
        break;
      case 'portrait':
        this.portraitTime = 1.45;
        break;
      default:
        break;
    }
  }

  /** Restore both table props when a different action takes the owl's wing. */
  cancelPropActions(): void {
    this.feedTime = 0;
    this.drinkTime = 0;
    this.snackLid.rotation.z = .30;
    this.snackCookie.position.set(0, .15, 0);
    this.snackCookie.rotation.set(0, 0, 0);
    this.snackCookie.visible = true;
    this.teaCup.visible = true;
    this.teaCup.position.set(-.31, .93, -.16);
    this.teaCup.rotation.set(0, 0, 0);
    this.teaSurface.rotation.set(0, 0, 0);
    this.teaSaucer.rotation.set(0, 0, 0);
  }

  update(dt: number, elapsed: number, eatAge?: number | null, sipAge?: number | null): void {
    const delta = Math.min(Math.max(dt, 0), .1);
    this.clock = Number.isFinite(elapsed) ? elapsed : this.clock + delta;
    const time = this.clock;
    this.mixTime = Math.max(0, this.mixTime - delta);
    this.paperTime = Math.max(0, this.paperTime - delta);
    this.feedTime = Math.max(0, this.feedTime - delta);
    this.portraitTime = Math.max(0, this.portraitTime - delta);
    this.drinkTime = Math.max(0, this.drinkTime - delta);
    this.burpTime = Math.max(0, this.burpTime - delta);
    this.phoneReturnTime = Math.max(0, this.phoneReturnTime - delta);

    const phoneRinging = this.phoneActive && !this.phoneAnswered;
    // The desk handset trembles on its cradle; the owl holds another receiver
    // once the call connects, leaving the original base visibly empty.
    this.phoneReceiver.visible = !this.phoneAnswered && this.phoneReturnTime === 0;
    this.phoneReceiver.position.y = phoneRinging ? Math.sin(time * 18) * .005 : 0;
    this.phoneReceiver.rotation.z = phoneRinging ? Math.sin(time * 18 + .6) * .018 : 0;
    this.phoneReceiver.rotation.x = phoneRinging ? Math.sin(time * 18 + 1.2) * .009 : 0;
    this.phoneIndicator.emissiveIntensity = phoneRinging ? .8 + Math.sin(time * 7) * .55 : this.phoneAnswered ? .38 : .13;
    this.phoneLight.intensity = phoneRinging ? 1.5 + Math.sin(time * 7) * .8 : this.phoneAnswered ? .35 : 0;

    const lampTarget = this.lampEnabled ? 11.5 : 0;
    this.warmLamp.intensity += (lampTarget - this.warmLamp.intensity) * Math.min(1, delta * 5);
    if (this.lampEnabled) this.warmLamp.intensity += Math.sin(time * 2.4) * .035;

    this.paperFlap.rotation.y = this.paperTime > 0 ? Math.sin((1.25 - this.paperTime) * 14) * .47 * (this.paperTime / 1.25) : 0;
    const snackAge = this.feedTime > 0
      ? eatAge ?? SNACK_DURATION - this.feedTime : -1;
    const lidOpen = snackAge >= 0
      ? smooth01((snackAge - .04) / .30) * (1 - smooth01((snackAge - 1.66) / .54))
      : 0;
    this.snackLid.rotation.z = .30 + lidOpen * .89;
    const cookieLift = snackAge >= 0 && snackAge < PICKUP_HANDOFF
      ? smooth01((snackAge - .13) / .19) : 0;
    // Carry the visible biscuit from the tin to the waiting wing instead of
    // swapping it across a large gap. It turns toward camera as it travels.
    this.snackCookie.position.set(-cookieLift * 1.15,
      .15 + cookieLift * .14 + Math.sin(cookieLift * Math.PI) * .045,
      cookieLift * .18);
    this.snackCookie.rotation.x = cookieLift * 1.18;
    this.snackCookie.rotation.z = -cookieLift * .09;
    // The biscuit in the wing replaces the one rising from the tin. After the
    // bite a fresh top biscuit becomes visible for the next interaction.
    this.snackCookie.visible = snackAge < 0 || snackAge < PICKUP_HANDOFF || snackAge >= 2.50;
    this.portrait.rotation.z = this.portraitTime > 0 ? Math.sin((1.45 - this.portraitTime) * 19) * .085 * (this.portraitTime / 1.45) : 0;
    const drinkAge = this.drinkTime > 0
      ? sipAge ?? DRINK_DURATION - this.drinkTime : -1;
    const cupPickup = drinkAge >= 0 && drinkAge < PICKUP_HANDOFF
      ? smooth01((drinkAge - .12) / .20) : 0;
    const cupReturn = drinkAge >= 2.30
      ? 1 - smooth01((drinkAge - 2.30) / .15) : 0;
    this.teaCup.visible = drinkAge < 0 || drinkAge < PICKUP_HANDOFF || drinkAge >= 2.30;
    this.teaCup.position.set(-.31 - cupPickup * .40 - cupReturn * .07,
      .93 + cupPickup * .15 + cupReturn * .105,
      -.16 + cupPickup * .21 + cupReturn * .05);
    this.teaCup.rotation.z = -cupPickup * .17 - cupReturn * .12;
    this.teaCup.rotation.x = cupPickup * .065 + cupReturn * .045;
    this.teaSurface.rotation.z = Math.sin(time * 4.8) * .018 + cupPickup * .10 + cupReturn * .075;
    this.teaSteam.position.y = Math.sin(time * 2.2) * .014;
    this.teaSteam.rotation.z = Math.sin(time * 1.3) * .055;
    this.teaSaucer.rotation.z = drinkAge >= 2.30
      ? Math.sin((drinkAge - 2.30) * 24) * .018 * (1 - smooth01((drinkAge - 2.30) / .15)) : 0;
    this.lampFixture.rotation.z = this.burpTime > 0 ? Math.sin((1.05 - this.burpTime) * 18) * .04 * (this.burpTime / 1.05) : 0;

    this.updateMixVisuals(time);
    for (let index = 0; index < this.dustPositions.length; index += 3) {
      let y = this.dustPositions[index + 1]! + delta * (.025 + seeded(index) * .05);
      if (y > 5.3) y = .45;
      this.dustPositions[index + 1] = y;
      this.dustPositions[index] = this.dustPositions[index]! + Math.sin(time * .5 + index) * delta * .008;
    }
    this.dust.geometry.attributes.position!.needsUpdate = true;
    this.chairStudy.rotation.y = Math.sin(time * .42) * .0025;
    this.chairLab.rotation.y = Math.sin(time * .42) * .0025;
    this.chairStudy.rotation.z = this.burpTime > 0 ? Math.sin((1.05 - this.burpTime) * 23) * .013 * (this.burpTime / 1.05) : 0;
    this.reactorRotor.rotation.z = time * .13;
  }

  private updateMixVisuals(time: number): void {
    const active = this.mixTime > 0;
    const progress = active ? 1 - this.mixTime / MIX_DURATION : 0;
    const reactionTime = progress * MIX_DURATION;
    const energy = active ? Math.min(1, progress * 8) * Math.min(1, this.mixTime * 2.2) : 0;
    const motion = this.mixRecipe.motion;
    const burstWave = (reactionTime * 2.2) % 1;
    this.labLight.intensity = 10.5 + Math.sin(time * 2.3) * 1.2 + energy * (motion === 'burst' ? 3 : 1.5);
    this.reactionLight.intensity = (this.mixStarted ? 1.9 : 0)
      + energy * (motion === 'burst' ? 5.2 + Math.sin(time * 26) * 1.1 : 3.6 + Math.sin(time * 11) * .6);
    this.liquidMaterials.forEach((material, index) => {
      material.emissiveIntensity = .42 + Math.sin(time * 2.8 + index * 1.9) * .08
        + energy * (index === 0 ? (motion === 'burst' ? .85 : .57) : .18);
    });

    this.reactionRing.visible = energy > .015;
    if (this.reactionRing.visible) {
      const material = this.reactionRing.material as THREE.MeshBasicMaterial;
      if (motion === 'burst') {
        this.reactionRing.scale.setScalar(.75 + burstWave * 3);
        material.opacity = .48 * (1 - burstWave) * energy;
      } else if (motion === 'fountain') {
        this.reactionRing.scale.setScalar(1 + Math.sin(time * 7) * .15);
        material.opacity = .38 * energy;
      } else {
        this.reactionRing.scale.setScalar(.94 + Math.sin(time * 3.5) * .14);
        material.opacity = .36 * energy;
      }
      this.reactionRing.rotation.z = time * .4;
    }
    this.orbitRings.forEach((ring, index) => {
      ring.visible = energy > .015 && motion === 'spiral';
      ring.rotation.y = time * (index === 0 ? 1.8 : -1.45);
      ring.rotation.z = time * (index === 0 ? -.95 : 1.15);
      ring.scale.setScalar((index === 0 ? .92 : 1.08) + Math.sin(time * 4 + index * 2) * .08);
    });
    this.orbitMaterial.opacity = .34 * energy;
    this.burstRays.visible = energy > .015 && motion === 'burst';
    this.burstRays.scale.setScalar(.42 + burstWave * 1.12);
    this.burstRays.rotation.z = time * .65;
    this.burstMaterial.opacity = .55 * (1 - burstWave) * energy;
    if (this.fountainPlume) {
      this.fountainPlume.visible = energy > .015 && motion === 'fountain';
      this.fountainPlume.scale.set(1 + Math.sin(time * 9) * .12, .84 + Math.sin(time * 5) * .12, 1 + Math.sin(time * 9) * .12);
      this.plumeMaterial.opacity = .09 * energy;
    }

    this.bubbles.forEach((bubble, index) => {
      const angle = bubble.phase * TAU;
      const travel = (reactionTime * (.64 + bubble.drift * .46) + bubble.phase) % 1;
      let x: number;
      let y: number;
      let z: number;
      if (motion === 'spiral') {
        const turn = angle + reactionTime * 4.4 + travel * TAU;
        const radius = .2 + travel * .48;
        x = Math.cos(turn) * radius;
        y = 1.18 + travel * .96;
        z = 1.34 + Math.sin(turn) * radius * .75;
      } else if (motion === 'burst') {
        const burst = (reactionTime * 2.2 + bubble.phase) % 1;
        const radius = .25 + burst * 1.65;
        x = Math.cos(angle) * radius;
        y = 1.4 + Math.sin(angle) * radius * .3 + burst * .19;
        z = 1.36 + Math.sin(angle) * radius * .55;
      } else if (motion === 'fountain') {
        const radius = .09 + travel * .34;
        x = Math.cos(angle + time * 2) * radius;
        y = 1.17 + travel * 1.08;
        z = 1.36 + Math.sin(angle + time * 2) * radius * .8;
      } else {
        x = Math.cos(angle) * (bubble.radius + travel * .24);
        y = 1.07 + travel * 1.15;
        z = 1.4 + Math.sin(angle) * (bubble.radius + travel * .14);
      }
      bubble.mesh.visible = energy > .015 && (motion !== 'burst' || index % 3 === 0);
      bubble.mesh.position.set(x, y, z);
      bubble.mesh.scale.setScalar((.68 + (1 - travel) * .53) * energy);
    });
    this.sparks.forEach((spark, index) => {
      const angle = index * TAU / this.sparks.length;
      let size = .8 * energy;
      if (motion === 'burst') {
        const flight = (reactionTime * 2.2 + index * .045) % 1;
        const radius = .22 + flight * 1.85;
        spark.position.set(Math.cos(angle) * radius, 1.44 + Math.sin(angle) * radius * .3 + flight * .23, 1.48 + Math.sin(angle) * radius * .48);
        size = (1.1 - flight) * .85 * energy;
      } else if (motion === 'fountain') {
        const rise = (reactionTime * 1.3 + index / this.sparks.length) % 1;
        const radius = .15 + rise * .42;
        spark.position.set(Math.cos(angle + time * 2) * radius, 1.2 + rise * 1.13, 1.45 + Math.sin(angle + time * 2) * radius);
        size = (.35 + (1 - rise) * .4) * energy;
      } else {
        const spin = angle + reactionTime * (motion === 'spiral' ? 3.6 : 2);
        spark.position.set(Math.cos(spin) * .58, 1.42 + Math.sin(spin * 1.8) * .32, 1.48 + Math.sin(spin) * .33);
        size = .5 * energy;
      }
      spark.visible = energy > .015 && (motion !== 'fountain' || index % 2 === 0);
      spark.rotation.set(time * 4, time * 5 + index, time * 3);
      spark.scale.setScalar(size);
    });
    this.labFlasks.forEach((flask, index) => {
      let sway = Math.sin(time * 1.6 + index * 1.7) * .008;
      if (energy > 0) {
        if (motion === 'burst') sway += Math.sin(time * 23 + index * 1.4) * .05 * energy;
        else if (motion === 'spiral') sway += Math.sin(time * 5 + index * 1.6) * .029 * energy;
        else if (motion === 'fountain') sway += Math.sin(time * 8 + index) * .014 * energy;
      }
      flask.rotation.z = sway;
      flask.position.y = (index === 0 ? 1.15 : 1.13)
        + (index === 0 && motion === 'fountain' ? Math.sin(time * 9) * .026 * energy : 0);
    });
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
        else materials.add(object.material);
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
  }

  private buildShell(root: THREE.Group, lab: boolean): void {
    const wallTexture = wallpaperTexture(lab);
    const floorTexture = woodTexture();
    this.textures.push(wallTexture, floorTexture);
    const wall = new THREE.MeshStandardMaterial({ map: wallTexture, color: lab ? 0x78c2c4 : 0xffffff, roughness: .88 });
    const floor = new THREE.MeshStandardMaterial({ map: floorTexture, color: lab ? 0x6b8290 : 0xffffff, roughness: .73, metalness: lab ? .2 : .03 });
    const dark = ink(lab ? 0x0a1f2a : 0x172e35, .73);
    const panel = ink(lab ? 0x113441 : 0x28505a, .82);
    const trim = ink(lab ? 0x7d9e9f : 0xb69060, .42, .62);
    const edge = ink(lab ? 0x0d2a32 : 0x3f2e28, .62, .1);
    block(root, 13.2, .25, 9.1, floor, 0, -.13, .52);
    for (let row = -4; row <= 4; row++) {
      block(root, 13.1, .012, .017, edge, 0, .008, row * .95 + .52);
    }
    block(root, 13.2, 6.6, .24, wall, 0, 3.22, -3.67);
    block(root, .2, 6.6, 8.9, dark, -6.52, 3.22, .54);
    block(root, .2, 6.6, 8.9, dark, 6.52, 3.22, .54);
    block(root, 13.2, 1.32, .11, panel, 0, .76, -3.48);
    block(root, 13.3, .14, .24, edge, 0, 1.43, -3.4, .025);
    block(root, 13.3, .035, .29, trim, 0, 1.51, -3.38);
    block(root, 13.3, .24, .34, dark, 0, 6.14, -3.37);
    block(root, 13.3, .047, .38, trim, 0, 6.01, -3.35);
    block(root, 13.3, .16, .2, edge, 0, .08, -3.44);
    for (let index = -5; index <= 5; index++) {
      const x = index * 1.16;
      block(root, .06, 1.08, .09, trim, x, .78, -3.38);
      if (Math.abs(index) < 5) {
        block(root, .85, .065, .08, trim, x + .58, 1.22, -3.38);
        block(root, .85, .042, .08, trim, x + .58, .34, -3.38);
      }
    }
    for (const x of [-6.2, 6.2]) {
      block(root, .22, 6.1, .27, edge, x, 3.05, -3.33);
      block(root, .07, 5.85, .31, trim, x + (x < 0 ? .12 : -.12), 3.05, -3.3);
    }
    if (lab) {
      const tile = ink(0x123a45, .43, .34);
      const seam = ink(0x3e6c70, .5, .45);
      for (let x = -5.7; x <= 5.7; x += 1.14) {
        block(root, .025, .014, 8.9, seam, x, .015, .5);
      }
      for (let z = -3.4; z <= 4.5; z += 1.14) {
        block(root, 13, .014, .025, seam, 0, .015, z);
      }
      block(root, 12.6, .03, .52, tile, 0, .035, -3.05);
    } else {
      const rug = rugTexture();
      this.textures.push(rug);
      const rugMat = new THREE.MeshStandardMaterial({ map: rug, roughness: .98, side: THREE.DoubleSide });
      const rugMesh = plane(root, 5.25, 3.75, rugMat, 0, .015, .6);
      rugMesh.rotation.x = -Math.PI / 2;
      for (const side of [-1, 1]) for (let index = 0; index < 18; index++) {
        const thread = ink(index % 3 === 0 ? 0xc5a76b : 0xdec794, 1);
        beam(root, new THREE.Vector3(-2.58 + index * .303, .013, .6 + side * 1.86), new THREE.Vector3(-2.58 + index * .303, .012, .6 + side * 2.06), .012, thread);
      }
    }
  }

  private buildChair(root: THREE.Group, lab: boolean): THREE.Group {
    const chair = new THREE.Group();
    chair.name = lab ? 'Laboratory armchair' : 'Velvet armchair';
    root.add(chair);
    const wood = ink(lab ? 0x182a30 : 0x4c3228, .52, lab ? .18 : .02);
    const velvet = ink(lab ? 0x1b6d74 : 0x0c6e67, .98);
    const velvetLight = ink(lab ? 0x348b8e : 0x278b81, .96);
    const velvetDark = ink(lab ? 0x164d5b : 0x075450, 1);
    const brass = ink(lab ? 0x9ab9ae : 0xd0a464, .35, .72);
    block(chair, 2.9, 2.55, .59, wood, 0, 1.86, -1.04, .29);
    block(chair, 2.55, 2.30, .31, velvetDark, 0, 1.87, -.67, .28);
    block(chair, 2.35, 2.07, .27, velvet, 0, 1.86, -.48, .28);
    // Keep the seat under the haunches while leaving the lower legs in front
    // of the rail, so the feet do not appear to emerge through solid wood.
    block(chair, 2.46, .22, 1.28, wood, 0, .48, -.42, .08);
    block(chair, 2.27, .38, 1.17, velvetLight, 0, .72, -.32, .16);
    block(chair, 2.26, .095, 1.11, velvetDark, 0, .56, -.305, .04);
    for (const side of [-1, 1]) {
      block(chair, .36, 1.1, 1.68, wood, side * 1.31, .8, -.16, .12);
      block(chair, .48, .29, 1.67, velvet, side * 1.29, 1.14, -.13, .14);
      block(chair, .53, .24, .54, velvetLight, side * 1.29, 1.08, .55, .11);
      block(chair, .22, .5, .22, wood, side * 1.07, .24, .48, .04);
      block(chair, .22, .5, .22, wood, side * 1.07, .24, -.74, .04);
      ball(chair, .08, brass, side * 1.29, 1.17, .61, 1, .45, 1);
      for (let stud = 0; stud < 8; stud++) ball(chair, .025, brass, side * 1.48, .72 + stud * .09, .52);
    }
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      ball(chair, .045, velvetDark, -.64 + col * .64 + (row % 2) * .18, 1.36 + row * .56, -.316, 1, .7, .38);
    }
    for (let col = 0; col < 4; col++) {
      ball(chair, .025, brass, -.88 + col * .58, 3.03, -.75);
    }
    return chair;
  }

  private buildStudy(): void {
    this.buildWindow();
    this.buildBookshelf();
    this.buildPortrait();
    this.buildClock();
    this.buildFloorLamp();
    this.buildPhoneTable();
    this.buildSnackTable();
    this.buildPlant();
  }

  private buildWindow(): void {
    const group = new THREE.Group();
    group.name = 'Moonlit bay window';
    this.study.add(group);
    const oak = ink(0x4c352a, .56);
    const brass = ink(0xcda566, .36, .66);
    const fabric = ink(0x163d52, .93);
    const fold = ink(0x275264, .96);
    block(group, 2.81, 3.15, .16, oak, -3.78, 3.77, -3.32, .035);
    const texture = nightWindowTexture();
    this.textures.push(texture);
    plane(group, 2.46, 2.79, new THREE.MeshBasicMaterial({ map: texture }), -3.78, 3.77, -3.23);
    block(group, .11, 2.95, .14, brass, -5.03, 3.77, -3.17);
    block(group, .11, 2.95, .14, brass, -2.53, 3.77, -3.17);
    block(group, 2.57, .11, .14, brass, -3.78, 5.24, -3.17);
    block(group, 2.57, .11, .14, brass, -3.78, 2.3, -3.17);
    block(group, .056, 2.77, .08, brass, -3.78, 3.77, -3.1);
    block(group, 2.46, .07, .08, brass, -3.78, 3.78, -3.1);
    for (const side of [-1, 1]) {
      const x = -3.78 + side * 1.29;
      block(group, .33, 2.98, .12, fabric, x, 3.77, -2.99, .045);
      for (let stripe = 0; stripe < 4; stripe++) {
        block(group, .024, 2.84, .14, fold, x - .11 + stripe * .073, 3.77, -2.89);
      }
      ball(group, .13, brass, x, 3.13, -2.79, 1.15, .46, .75);
    }
    block(group, 2.98, .18, .55, oak, -3.78, 2.22, -3.02, .035);
    block(group, 2.98, .035, .58, brass, -3.78, 2.32, -3.01);
    const moonlight = new THREE.PointLight(0x9bd8ed, 8.5, 6.2, 2);
    moonlight.position.set(-3.72, 3.52, -2.71);
    group.add(moonlight);
  }

  private buildBookshelf(): void {
    const shelf = new THREE.Group();
    shelf.name = 'Curiosity bookshelf';
    shelf.position.set(4.54, 0, -2.55);
    this.study.add(shelf);
    const wood = ink(0x362820, .55);
    const woodLight = ink(0x654b36, .66);
    const brass = ink(0xb88b51, .38, .59);
    block(shelf, 2.7, 4.85, .51, wood, 0, 2.48, -.25, .08);
    block(shelf, 2.36, 4.42, .055, ink(0x26363a, .85), 0, 2.48, .035);
    for (const side of [-1, 1]) {
      block(shelf, .19, 4.86, .7, woodLight, side * 1.26, 2.48, -.05, .035);
      block(shelf, .022, 4.58, .72, brass, side * 1.16, 2.48, .01);
    }
    const books = [
      ink(0x485d58, .89), ink(0x7d493e, .91), ink(0x8d724a, .91), ink(0x31556a, .86),
      ink(0x425245, .89), ink(0x774f4e, .89), ink(0x8b835e, .87), ink(0x31414e, .86),
    ];
    for (let row = 0; row < 5; row++) {
      const shelfY = .42 + row * .89;
      block(shelf, 2.53, .12, .72, woodLight, 0, shelfY, .03, .02);
      block(shelf, 2.53, .018, .72, brass, 0, shelfY + .065, .03);
      if (row === 4) continue;
      let cursor = -1.03;
      for (let index = 0; index < 11; index++) {
        const width = .12 + seeded(row * 41 + index) * .07;
        const height = .48 + seeded(row * 19 + index * 3) * .19;
        const book = block(shelf, width, height, .31, books[(row * 3 + index) % books.length]!, cursor + width / 2, shelfY + .07 + height / 2, .13, .012);
        book.rotation.z = (seeded(row * 101 + index * 7) - .5) * .09;
        block(shelf, width * .73, .015, .313, brass, cursor + width / 2, shelfY + .17, .13);
        if (index % 3 === 0) block(shelf, width * .63, .012, .313, brass, cursor + width / 2, shelfY + height * .75, .13);
        cursor += width + .018;
        if (cursor > 1.02) break;
      }
    }
    block(shelf, 2.7, .16, .8, woodLight, 0, 4.91, -.02, .03);
    block(shelf, 2.78, .028, .82, brass, 0, 5.0, -.02);
    const globe = new THREE.Group();
    globe.position.set(-.61, 4.46, .06);
    shelf.add(globe);
    ball(globe, .24, ink(0x3c7f82, .5, .12), 0, .09, 0);
    hoop(globe, .26, .015, brass, 0, .09, 0);
    cylinder(globe, .018, .018, .24, brass, 0, -.16, 0);
    cylinder(globe, .21, .21, .045, brass, 0, -.29, 0);
    const bottles = [
      [0.28, 0x66c1ae], [0.61, 0xc39970], [.94, 0x9e8cb6],
    ] as const;
    for (const [x, color] of bottles) {
      cylinder(shelf, .08, .11, .31, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: .7, roughness: .2, metalness: .05 }), x, 4.38, .13, 12);
      cylinder(shelf, .055, .055, .11, wood, x, 4.59, .13, 12);
    }
  }

  private buildPortrait(): void {
    this.portrait.name = 'Nocturne owl portrait';
    this.portrait.position.set(1.87, 3.87, -3.24);
    this.portrait.userData.action = 'portrait';
    this.study.add(this.portrait);
    const dark = ink(0x302b29, .67);
    const gilded = ink(0xc89e60, .32, .73);
    block(this.portrait, 1.45, 1.82, .13, dark, 0, 0, 0, .035);
    block(this.portrait, 1.36, 1.73, .14, gilded, 0, 0, .055, .02);
    block(this.portrait, 1.17, 1.53, .04, ink(0x4c3d30, .8), 0, 0, .143);
    const texture = artworkTexture();
    this.textures.push(texture);
    plane(this.portrait, 1.08, 1.44, new THREE.MeshStandardMaterial({ map: texture, roughness: .9 }), 0, 0, .169);
    for (const x of [-.67, .67]) for (const y of [-.855, .855]) {
      ball(this.portrait, .038, gilded, x, y, .136, 1, 1, .35);
    }
    tube(this.study, [[1.87, 4.8, -3.31], [1.87, 4.9, -3.32], [1.99, 4.98, -3.35]], .016, gilded);
    ball(this.study, .065, gilded, 1.99, 4.98, -3.35);
  }

  private buildClock(): void {
    const clock = new THREE.Group();
    clock.name = 'Midnight clock';
    clock.position.set(.08, 4.16, -3.26);
    this.study.add(clock);
    const brass = ink(0xb89056, .34, .65);
    cylinder(clock, .51, .51, .11, ink(0x442f28, .62), 0, 0, 0);
    const dial = new THREE.Mesh(new THREE.CircleGeometry(.43, 36), ink(0xe6d6b1, .82));
    dial.position.z = .072;
    clock.add(dial);
    hoop(clock, .44, .027, brass, 0, 0, .08);
    for (let index = 0; index < 12; index++) {
      const angle = index * TAU / 12;
      ball(clock, .018, ink(0x3b4640, .5), Math.sin(angle) * .35, Math.cos(angle) * .35, .085, 1, 1, .55);
    }
    const hand = ink(0x324742, .3, .28);
    beam(clock, new THREE.Vector3(0, 0, .1), new THREE.Vector3(-.14, .19, .1), .017, hand);
    beam(clock, new THREE.Vector3(0, 0, .105), new THREE.Vector3(.06, .32, .105), .009, hand);
    ball(clock, .028, brass, 0, 0, .12);
  }

  private buildFloorLamp(): void {
    const lamp = this.lampFixture;
    lamp.name = 'Reading lamp';
    lamp.position.set(3.2, 0, -.15);
    lamp.userData.action = 'lamp';
    this.study.add(lamp);
    const brass = ink(0xc59a5e, .31, .76);
    const porcelain = new THREE.MeshStandardMaterial({
      color: 0xe3bb8d,
      emissive: 0xffa961,
      emissiveIntensity: .13,
      roughness: .8,
      side: THREE.DoubleSide,
    });
    cylinder(lamp, .39, .43, .09, ink(0x4a352d, .47, .14), 0, .08, 0);
    cylinder(lamp, .28, .29, .05, brass, 0, .15, 0);
    cylinder(lamp, .042, .055, 2.37, brass, 0, 1.34, 0, 12);
    cylinder(lamp, .16, .1, .13, brass, 0, 2.57, 0);
    cylinder(lamp, .4, .68, .57, porcelain, 0, 2.83, 0, 28);
    cylinder(lamp, .39, .39, .02, brass, 0, 3.12, 0, 28);
    hoop(lamp, .67, .025, brass, 0, 2.53, 0, true);
    ball(lamp, .12, glow(0xffd090, 1.1), 0, 2.57, 0);
    this.warmLamp.position.set(0, 2.57, 0);
    lamp.add(this.warmLamp);
    for (let index = 0; index < 6; index++) {
      const angle = index * TAU / 6;
      const bulb = ball(lamp, .025, brass, Math.cos(angle) * .54, 2.62, Math.sin(angle) * .54);
      bulb.castShadow = false;
    }
  }

  private buildPhoneTable(): void {
    const table = new THREE.Group();
    table.name = 'Telephone side table';
    table.position.set(-2.52, 0, .38);
    this.study.add(table);
    const walnut = ink(0x4d3327, .53, .07);
    const rim = ink(0x785238, .49, .12);
    const brass = ink(0xcaa56b, .35, .67);
    cylinder(table, .79, .76, .1, walnut, 0, .81, 0, 32);
    hoop(table, .75, .02, brass, 0, .875, 0, true);
    cylinder(table, .45, .49, .07, rim, 0, .72, 0, 32);
    cylinder(table, .16, .23, .58, walnut, 0, .42, 0, 16);
    for (let index = 0; index < 3; index++) {
      const angle = index * TAU / 3;
      beam(table, new THREE.Vector3(0, .46, 0), new THREE.Vector3(Math.cos(angle) * .56, .08, Math.sin(angle) * .56), .052, walnut);
      ball(table, .09, brass, Math.cos(angle) * .56, .075, Math.sin(angle) * .56, 1, .48, 1);
    }
    const phone = new THREE.Group();
    phone.name = 'Porcelain rotary phone';
    phone.position.set(0, .84, .01);
    phone.userData.action = 'call';
    table.add(phone);
    const body = ink(0xcbdac8, .35, .08);
    const ivory = ink(0xf4ead8, .42);
    const dark = ink(0x264148, .4, .21);
    block(phone, .82, .19, .55, body, 0, .095, 0, .085);
    block(phone, .65, .1, .43, ivory, 0, .194, -.01, .045);
    cylinder(phone, .205, .205, .031, brass, 0, .245, .035, 32);
    cylinder(phone, .172, .172, .035, dark, 0, .266, .035, 32);
    cylinder(phone, .139, .139, .015, ivory, 0, .292, .035, 32);
    for (let index = 0; index < 10; index++) {
      const angle = index * TAU / 10 - Math.PI / 2;
      cylinder(phone, .023, .023, .012, dark, Math.cos(angle) * .115, .306, .035 + Math.sin(angle) * .115, 10);
    }
    block(phone, .2, .04, .05, this.phoneIndicator, .27, .224, .234, .014);
    for (const side of [-1, 1]) {
      block(phone, .16, .025, .21, dark, side * .36, .236, -.06, .012);
      block(phone, .12, .009, .16, brass, side * .36, .253, -.06, .004);
    }
    this.phoneReceiver.name = 'Telephone handset';
    phone.add(this.phoneReceiver);
    tube(this.phoneReceiver, [[-.36, .37, -.065], [-.18, .43, -.08], [0, .45, -.08], [.18, .43, -.08], [.36, .37, -.065]], .065, dark);
    block(this.phoneReceiver, .17, .16, .23, body, -.39, .345, -.06, .06);
    block(this.phoneReceiver, .17, .16, .23, body, .39, .345, -.06, .06);
    cylinder(this.phoneReceiver, .095, .095, .025, brass, -.39, .265, -.06, 18);
    cylinder(this.phoneReceiver, .095, .095, .025, brass, .39, .265, -.06, 18);
    tube(phone, [[-.39, .35, -.07], [-.55, .23, -.32], [-.35, .16, -.39], [-.51, .08, -.27]], .018, dark);
    this.phoneLight.position.set(.28, .26, .25);
    phone.add(this.phoneLight);
  }

  private buildSnackTable(): void {
    const table = new THREE.Group();
    table.name = 'Tea and treats table';
    table.position.set(2.28, 0, .63);
    this.study.add(table);
    const wood = ink(0x50372b, .57);
    const brass = ink(0xb88b56, .39, .56);
    const porcelain = new THREE.MeshPhysicalMaterial({
      color: 0xf1e5ce, roughness: .22, metalness: .025,
      clearcoat: .38, clearcoatRoughness: .18,
    });
    const blueGlaze = ink(0x376d70, .31, .16);
    cylinder(table, .77, .77, .09, wood, 0, .85, 0, 32);
    hoop(table, .76, .018, brass, 0, .91, 0, true);
    cylinder(table, .15, .18, .7, wood, 0, .47, 0, 14);
    for (let index = 0; index < 3; index++) {
      const angle = index * TAU / 3;
      beam(table, new THREE.Vector3(0, .4, 0), new THREE.Vector3(Math.cos(angle) * .47, .08, Math.sin(angle) * .47), .045, wood);
    }

    // The saucer stays on the table while the cup moves into the owl's wing.
    // Lathed profiles give the ceramic a real open bowl and a rolled lip.
    this.teaSaucer.name = 'Glazed tea saucer';
    this.teaSaucer.position.set(-.31, .93, -.16);
    this.teaSaucer.userData.action = 'drink';
    table.add(this.teaSaucer);
    const saucerProfile = [
      [0, -.015], [.10, -.015], [.17, -.007], [.22, .014],
      [.224, .027], [.208, .031], [.155, .012], [.09, .006], [0, .006],
    ].map(([radius, height]) => new THREE.Vector2(radius!, height!));
    const saucer = new THREE.Mesh(new THREE.LatheGeometry(saucerProfile, 32), porcelain);
    saucer.castShadow = true;
    saucer.receiveShadow = true;
    this.teaSaucer.add(saucer);
    hoop(this.teaSaucer, .214, .007, brass, 0, .027, 0, true);
    cylinder(this.teaSaucer, .107, .107, .003, ink(0xd7c9a9, .49), 0, .008, 0, 32);

    this.teaCup.name = 'Porcelain tea cup';
    this.teaCup.position.set(-.31, .93, -.16);
    this.teaCup.userData.action = 'drink';
    table.add(this.teaCup);
    const cupProfile = [
      [0, .018], [.072, .018], [.092, .028], [.109, .052],
      [.121, .118], [.133, .221], [.128, .241], [.117, .243],
      [.111, .223], [.105, .146], [.093, .066], [.069, .051], [0, .051],
    ].map(([radius, height]) => new THREE.Vector2(radius!, height!));
    const cup = new THREE.Mesh(new THREE.LatheGeometry(cupProfile, 36), porcelain);
    cup.name = 'Hollow hand-glazed tea cup';
    cup.castShadow = true;
    cup.receiveShadow = true;
    this.teaCup.add(cup);
    hoop(this.teaCup, .121, .007, brass, 0, .238, 0, true);
    hoop(this.teaCup, .114, .006, blueGlaze, 0, .081, 0, true);
    hoop(this.teaCup, .108, .006, blueGlaze, 0, .061, 0, true);
    tube(this.teaCup, [
      [.119, .191, 0], [.205, .211, 0], [.268, .172, 0],
      [.273, .117, 0], [.228, .062, 0], [.119, .072, 0],
    ], .024, porcelain);
    ball(this.teaCup, .026, blueGlaze, 0, .155, .128, 1, 1.15, .23);
    for (const side of [-1, 1]) {
      ball(this.teaCup, .013, brass, side * .039, .128, .122, .8, 1.4, .21);
    }
    this.teaSurface.name = 'Amber tea inside the cup';
    this.teaSurface.position.y = .192;
    this.teaCup.add(this.teaSurface);
    const tea = new THREE.Mesh(new THREE.CircleGeometry(.106, 32),
      new THREE.MeshPhysicalMaterial({
        color: 0x6d3d27, roughness: .15, metalness: .04,
        clearcoat: .72, clearcoatRoughness: .09,
      }));
    tea.rotation.x = -Math.PI / 2;
    this.teaSurface.add(tea);
    ball(this.teaSurface, .023, ink(0xc3905a, .22), -.039, .002, .032, 1.7, .08, .54).castShadow = false;
    this.teaSteam.name = 'Warm tea steam';
    this.teaCup.add(this.teaSteam);
    const steam = new THREE.MeshBasicMaterial({
      color: 0xd3e7d3, transparent: true, opacity: .29,
      depthWrite: false, side: THREE.DoubleSide,
    });
    tube(this.teaSteam, [[-.047, .262, 0], [-.067, .322, .01], [-.032, .382, 0], [-.049, .438, -.015]], .006, steam).castShadow = false;
    tube(this.teaSteam, [[.037, .256, 0], [.059, .306, -.01], [.025, .364, .01], [.047, .411, 0]], .005, steam).castShadow = false;

    const paper = new THREE.Group();
    paper.name = 'Folded evening paper';
    paper.position.set(.01, .96, .28);
    paper.userData.action = 'newspaper';
    table.add(paper);
    const paperTexture = newspaperTexture();
    this.textures.push(paperTexture);
    const paperMat = new THREE.MeshStandardMaterial({ map: paperTexture, roughness: .93, side: THREE.DoubleSide });
    block(paper, .57, .034, .42, ink(0xd8c9aa, .95), 0, 0, 0, .006);
    this.paperFlap.position.set(-.18, .035, 0);
    paper.add(this.paperFlap);
    const paperFace = plane(this.paperFlap, .38, .43, paperMat, .18, .08, .02);
    paperFace.rotation.x = -1.1;
    paperFace.rotation.z = -.1;
    const tin = new THREE.Group();
    tin.name = 'Biscuit tin';
    tin.position.set(.38, .94, -.12);
    tin.userData.action = 'feed';
    table.add(tin);
    const tinProfile = [
      [0, -.014], [.198, -.014], [.211, 0], [.221, .185],
      [.23, .215], [.213, .225], [.204, .208], [.203, .053], [0, .053],
    ].map(([radius, height]) => new THREE.Vector2(radius!, height!));
    const tinBody = new THREE.Mesh(new THREE.LatheGeometry(tinProfile, 32), ink(0x326e6c, .36, .24));
    tinBody.castShadow = true;
    tinBody.receiveShadow = true;
    tin.add(tinBody);
    cylinder(tin, .195, .195, .004, ink(0x244849, .74), 0, .055, 0, 28);
    hoop(tin, .222, .012, brass, 0, .214, 0, true);
    hoop(tin, .210, .008, brass, 0, .018, 0, true);
    // A small owl medallion identifies the tin as part of the night's set.
    const medallion = new THREE.Mesh(new THREE.CircleGeometry(.075, 24), ink(0xe9d7a8, .48));
    medallion.position.set(0, .111, .225);
    tin.add(medallion);
    const emblem = ink(0x6a6148, .58);
    ball(tin, .039, emblem, 0, .108, .230, 1.32, 1.20, .13).castShadow = false;
    for (const side of [-1, 1]) {
      ball(tin, .013, ink(0xf2ddab, .55), side * .021, .121, .236, 1, 1, .25).castShadow = false;
      ball(tin, .005, emblem, side * .021, .121, .240, 1, 1, .25).castShadow = false;
    }
    const beak = new THREE.Mesh(new THREE.ConeGeometry(.012, .019, 3), brass);
    beak.position.set(0, .099, .241);
    beak.rotation.z = Math.PI;
    beak.castShadow = false;
    tin.add(beak);
    biscuit(tin, .084, 2.7).rotation.y = -.20;
    tin.add(this.snackCookie);
    biscuit(this.snackCookie, 0, 1.3).rotation.y = .12;
    this.snackCookie.position.y = .15;
    this.snackLid.position.set(-.23, .24, 0);
    tin.add(this.snackLid);
    cylinder(this.snackLid, .255, .255, .045, ink(0x86a9a1, .32, .35), .23, 0, 0, 32);
    hoop(this.snackLid, .239, .012, brass, .23, .028, 0, true);
    cylinder(this.snackLid, .102, .102, .004, ink(0x326e6c, .39, .21), .23, .026, 0, 24);
    ball(this.snackLid, .05, brass, .23, .062, 0, 1, .58, 1);
    // The brass pin is fixed to the tin. Short knuckles belong to the moving
    // lid so its edge stays visibly attached throughout the opening arc.
    const hingeMetal = ink(0x9c7146, .3, .68);
    for (const z of [-.15, .15]) {
      beam(tin, new THREE.Vector3(-.18, .11, z), new THREE.Vector3(-.23, .24, z), .017, hingeMetal);
      block(this.snackLid, .055, .03, .046, hingeMetal, .018, -.017, z, .009);
    }
    const hingePin = cylinder(tin, .021, .021, .36, hingeMetal, -.23, .24, 0, 12);
    hingePin.rotation.x = Math.PI / 2;
    ball(tin, .024, brass, -.23, .24, .19, .9, .9, .42).castShadow = false;
    const crumbs = ink(0xd49a5d, .97);
    for (const [x, z, size] of [[.10, -.34, .012], [.11, -.30, .008], [.19, -.38, .006]] as const) {
      ball(table, size, crumbs, x, .907, z, 1, .45, .8).castShadow = false;
    }
  }

  private buildPlant(): void {
    const group = new THREE.Group();
    group.name = 'Moon fern';
    group.position.set(-5.3, 0, -1.85);
    this.study.add(group);
    const pot = ink(0x6b4b3e, .75);
    const lip = ink(0xb48261, .66);
    const leaf = ink(0x4a8b6d, .83);
    const leafDark = ink(0x275d5b, .9);
    cylinder(group, .37, .27, .6, pot, 0, .32, 0, 12);
    hoop(group, .37, .035, lip, 0, .64, 0, true);
    cylinder(group, .29, .29, .02, ink(0x273a35, 1), 0, .65, 0);
    for (let stem = 0; stem < 8; stem++) {
      const angle = stem * TAU / 8;
      const length = 1.25 + seeded(stem) * .58;
      const tipX = Math.cos(angle) * (.45 + seeded(stem + 9) * .35);
      const tipZ = Math.sin(angle) * (.4 + seeded(stem + 13) * .3);
      tube(group, [[0, .65, 0], [tipX * .24, 1.14, tipZ * .24], [tipX, length, tipZ]], .018, leafDark);
      for (let segment = 0; segment < 5; segment++) {
        const t = .25 + segment * .14;
        const x = tipX * t;
        const y = .65 + (length - .65) * t;
        const z = tipZ * t;
        for (const side of [-1, 1]) {
          const frond = ball(group, .16, segment % 2 ? leaf : leafDark, x + side * Math.cos(angle + Math.PI / 2) * .12, y, z + side * Math.sin(angle + Math.PI / 2) * .12, .43, .18, 1);
          frond.rotation.y = angle + side * .55;
          frond.rotation.z = side * .26;
        }
      }
    }
  }

  private buildLab(): THREE.Mesh {
    const brass = ink(0xb2a077, .35, .73);
    const chrome = ink(0x7dabb0, .31, .68);
    const dark = ink(0x0c2734, .47, .39);
    const teal = glow(0x42d7cd, .85);
    const cyan = glow(0x63ebe6, 1.05);
    const wallTrim = ink(0x376470, .42, .5);
    for (const y of [1.72, 5.35]) {
      block(this.lab, 12.3, .045, .09, brass, 0, y, -3.39);
      block(this.lab, 12.3, .02, .095, teal, 0, y + .055, -3.38);
    }
    for (let x = -5.8; x <= 5.8; x += 1.4) {
      block(this.lab, .038, 3.45, .07, wallTrim, x, 3.55, -3.43);
      for (const y of [1.85, 5.21]) ball(this.lab, .045, brass, x, y, -3.34, 1, 1, .45);
    }
    this.buildReactor();
    this.buildLabShelf();
    this.buildLabGauges();
    const plaqueTexture = labSignTexture();
    this.textures.push(plaqueTexture);
    block(this.lab, 3.0, .8, .12, dark, 0, 4.42, -3.31, .06);
    block(this.lab, 2.88, .68, .035, brass, 0, 4.42, -3.22);
    plane(this.lab, 2.72, .52, new THREE.MeshBasicMaterial({ map: plaqueTexture }), 0, 4.42, -3.19);
    for (const x of [-1.43, 1.43]) {
      ball(this.lab, .055, brass, x, 4.73, -3.13, 1, 1, .4);
      ball(this.lab, .055, brass, x, 4.11, -3.13, 1, 1, .4);
    }
    tube(this.lab, [[-4.2, 5.57, -3.22], [-2.1, 5.67, -3.22], [-1.85, 5.34, -3.22], [-1.31, 5.34, -3.22]], .07, chrome);
    tube(this.lab, [[2.16, 5.42, -3.22], [2.7, 5.42, -3.22], [3.08, 5.72, -3.22], [4.7, 5.72, -3.22]], .065, chrome);
    for (const x of [-1.84, 3.08]) {
      cylinder(this.lab, .12, .12, .12, brass, x, 5.5, -3.22, 12);
    }
    this.buildOverheadLamp();

    const bench = new THREE.Group();
    bench.name = 'Alchemy workbench';
    this.lab.add(bench);
    const cabinet = ink(0x193b43, .6, .25);
    const cabinetInset = ink(0x102b35, .61, .32);
    block(bench, 6.32, .2, 1.72, cabinet, 0, .86, 1.35, .055);
    block(bench, 6.42, .025, 1.78, brass, 0, .975, 1.35);
    block(bench, 6.0, .17, 1.51, ink(0x526c6b, .37, .38), 0, 1.075, 1.35, .035);
    block(bench, 6.3, .65, .1, cabinet, 0, .47, 2.18, .027);
    block(bench, 6.1, .09, .12, brass, 0, .8, 2.25);
    for (const x of [-2.8, -1.4, 0, 1.4, 2.8]) {
      block(bench, .035, .5, .12, brass, x, .47, 2.245);
      ball(bench, .035, chrome, x, .47, 2.32, 1, 1, .4);
    }
    for (const x of [-2.88, 2.88]) {
      block(bench, .32, .72, 1.38, cabinetInset, x, .39, 1.35, .035);
      block(bench, .15, .68, 1.2, brass, x, .39, 1.35, .025);
    }
    for (const x of [-2.2, -.75, .75, 2.2]) {
      block(bench, 1.12, .46, .056, cabinetInset, x, .42, 2.26, .035);
      block(bench, .26, .035, .07, brass, x, .43, 2.31, .015);
    }
    const central = this.buildRoundFlask(bench, 0, 1.15, 1.33, 1.05, 0x17aa8c);
    central.userData.action = 'mix';
    const left = this.buildConicalFlask(bench, -1.52, 1.13, 1.23, .77, 0x298fc4);
    left.userData.action = 'mix';
    const right = this.buildConicalFlask(bench, 1.52, 1.13, 1.24, .79, 0xa447ad);
    right.userData.action = 'mix';
    this.buildLabTools(bench);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x58ffdc,
      transparent: true,
      opacity: .42,
      depthWrite: false,
      toneMapped: false,
    });
    const reactionRing = hoop(this.lab, .48, .035, ringMaterial, 0, 1.18, 1.33, true);
    reactionRing.visible = false;
    reactionRing.castShadow = false;
    for (let index = 0; index < 2; index++) {
      const orbit = hoop(this.lab, index === 0 ? .58 : .72, .018, this.orbitMaterial, 0, 1.68, 1.67);
      orbit.visible = false;
      orbit.castShadow = false;
      this.orbitRings.push(orbit);
    }
    this.burstRays.position.set(0, 1.55, 1.72);
    this.burstRays.visible = false;
    this.lab.add(this.burstRays);
    for (let index = 0; index < 12; index++) {
      const angle = index * TAU / 12;
      const ray = beam(this.burstRays,
        new THREE.Vector3(Math.cos(angle) * .38, Math.sin(angle) * .38, 0),
        new THREE.Vector3(Math.cos(angle) * .75, Math.sin(angle) * .75, 0),
        .022, this.burstMaterial);
      ray.castShadow = false;
    }
    this.fountainPlume = new THREE.Mesh(new THREE.CylinderGeometry(.1, .3, 1.02, 24, 1, true), this.plumeMaterial);
    this.fountainPlume.position.set(0, 1.72, 1.34);
    this.fountainPlume.visible = false;
    this.fountainPlume.castShadow = false;
    this.lab.add(this.fountainPlume);
    for (let index = 0; index < 26; index++) {
      const color = [0x65e8d2, 0x91dff2, 0xb3f6a4, 0xe78be1][index % 4]!;
      const bubble = ball(this.lab, .052 + seeded(index * 5) * .035,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .66, depthWrite: false, toneMapped: false }),
        0, 0, 0);
      bubble.visible = false;
      bubble.castShadow = false;
      this.bubbles.push({ mesh: bubble, radius: .19 + seeded(index * 11) * .25, phase: seeded(index * 7 + 2), drift: seeded(index * 13 + 4) * .75 });
    }
    for (let index = 0; index < 12; index++) {
      const color = index % 2 ? 0xc5f5b8 : 0x69eee1;
      const spark = new THREE.Mesh(new THREE.OctahedronGeometry(.09, 0), new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: .72,
        depthWrite: false,
        toneMapped: false,
      }));
      spark.visible = false;
      spark.castShadow = false;
      this.lab.add(spark);
      this.sparks.push(spark);
    }
    this.reactionLight.position.set(0, 1.57, 1.32);
    this.lab.add(this.reactionLight);
    return reactionRing;
  }

  private buildReactor(): void {
    const reactor = new THREE.Group();
    reactor.name = 'Lunar dynamo';
    reactor.position.set(-3.86, 3.67, -3.24);
    this.lab.add(reactor);
    const brass = ink(0xb2a077, .35, .73);
    const iron = ink(0x112e3b, .4, .48);
    const core = glow(0x4bd7d2, 1.16);
    const arc = glow(0x9cf7e9, 1.4);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.12, 48), iron);
    disc.position.z = .025;
    reactor.add(disc);
    hoop(reactor, 1.18, .095, brass, 0, 0, .08);
    hoop(reactor, .98, .026, core, 0, 0, .115);
    hoop(reactor, .83, .065, iron, 0, 0, .14);
    hoop(reactor, .64, .021, arc, 0, 0, .16);
    this.reactorRotor.position.z = .2;
    reactor.add(this.reactorRotor);
    for (let index = 0; index < 8; index++) {
      const angle = index * TAU / 8;
      beam(this.reactorRotor, new THREE.Vector3(Math.cos(angle) * .31, Math.sin(angle) * .31, 0), new THREE.Vector3(Math.cos(angle + .18) * .76, Math.sin(angle + .18) * .76, 0), .037, brass);
      ball(reactor, .055, brass, Math.cos(angle) * 1.11, Math.sin(angle) * 1.11, .14, 1, 1, .45);
    }
    ball(reactor, .32, core, 0, 0, .23, 1, 1, .5);
    hoop(reactor, .3, .016, arc, 0, 0, .33);
    this.labLight.position.set(-3.68, 3.62, -2.6);
    this.lab.add(this.labLight);
    for (const side of [-1, 1]) {
      tube(this.lab, [[-3.86 + side * 1.07, 3.75, -3.25], [-3.86 + side * 1.37, 3.8, -3.22], [-3.86 + side * 1.52, 3.45, -3.22], [-3.86 + side * 1.54, 1.8, -3.22]], .075, brass);
    }
  }

  private buildLabShelf(): void {
    const shelf = new THREE.Group();
    shelf.name = 'Reagent cabinet';
    shelf.position.set(4.25, 0, -2.75);
    shelf.userData.action = 'mix';
    this.lab.add(shelf);
    const frame = ink(0x173744, .39, .46);
    const brass = ink(0xb4a170, .36, .66);
    const glass = new THREE.MeshStandardMaterial({ color: 0xb5ece7, roughness: .12, metalness: .14, transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false });
    block(shelf, 2.8, 4.8, .4, frame, 0, 2.46, -.2, .05);
    for (const x of [-1.3, 1.3]) {
      block(shelf, .14, 4.8, .62, brass, x, 2.46, 0, .025);
    }
    for (let row = 0; row < 4; row++) {
      const y = .62 + row * .98;
      block(shelf, 2.72, .1, .65, frame, 0, y, .02, .015);
      block(shelf, 2.68, .025, .68, brass, 0, y + .064, .02);
      for (let col = 0; col < 5; col++) {
        const x = -1.02 + col * .51;
        const color = [0x4bdbcc, 0xe992c6, 0xa9e76b, 0x81c4ed, 0xe9b970][(row * 3 + col) % 5]!;
        const height = .38 + seeded(row * 16 + col) * .22;
        cylinder(shelf, .1, .13, height, glass, x, y + .075 + height / 2, .13, 16);
        cylinder(shelf, .085, .11, height * (.38 + seeded(col + row * 3) * .25), glow(color, .5), x, y + .075 + height * .24, .13, 16);
        cylinder(shelf, .09, .09, .055, brass, x, y + .105 + height, .13, 12);
        block(shelf, .12, .09, .006, ink(0xe9ddb5, .89), x, y + .15 + height * .35, .264);
      }
    }
    block(shelf, 2.88, .15, .7, frame, 0, 4.83, 0, .02);
    hoop(shelf, .2, .02, brass, 0, 4.43, .37);
    ball(shelf, .055, glow(0x72e5db, 1), 0, 4.43, .38);
  }

  private buildLabGauges(): void {
    const gauges = new THREE.Group();
    gauges.name = 'Pressure instruments';
    gauges.position.set(1.78, 3.65, -3.23);
    this.lab.add(gauges);
    const brass = ink(0xc4a779, .39, .7);
    const face = ink(0xe0e2d0, .62);
    for (let index = 0; index < 2; index++) {
      const x = index * .68;
      cylinder(gauges, .25, .25, .12, brass, x, 0, 0, 24).rotation.x = Math.PI / 2;
      const dial = new THREE.Mesh(new THREE.CircleGeometry(.205, 32), face);
      dial.position.set(x, 0, .073);
      gauges.add(dial);
      hoop(gauges, .207, .012, brass, x, 0, .076);
      for (let tick = 0; tick < 9; tick++) {
        const angle = -Math.PI * .78 + tick * Math.PI * 1.55 / 8;
        ball(gauges, .013, brass, x + Math.cos(angle) * .16, Math.sin(angle) * .16, .081, 1, 1, .6);
      }
      beam(gauges, new THREE.Vector3(x, 0, .09), new THREE.Vector3(x + .13, .09, .09), .009, ink(0x80544b, .4));
      ball(gauges, .018, brass, x, 0, .1);
    }
    block(this.lab, 1.73, .28, .14, ink(0x163947, .36, .43), 2.13, 2.74, -3.25, .04);
    for (let index = 0; index < 6; index++) {
      const color = index < 4 ? 0x5bdbbf : index === 4 ? 0xeebc66 : 0x8f3c4c;
      block(this.lab, .15, .07, .015, glow(color, .8), 1.52 + index * .24, 2.74, -3.15, .012);
    }
    tube(this.lab, [[1.77, 3.35, -3.26], [1.77, 3.02, -3.26], [2.12, 2.88, -3.26]], .026, brass);
    tube(this.lab, [[2.45, 3.35, -3.26], [2.45, 3.01, -3.26], [2.21, 2.88, -3.26]], .026, brass);
  }

  private buildOverheadLamp(): void {
    const lamp = new THREE.Group();
    lamp.name = 'Laboratory pendant';
    lamp.position.set(.17, 0, .85);
    this.lab.add(lamp);
    const chrome = ink(0x85a9ae, .32, .65);
    const dark = ink(0x153941, .36, .45);
    const light = glow(0x83eee5, .65);
    cylinder(lamp, .025, .025, .72, chrome, 0, 5.5, 0, 10);
    cylinder(lamp, .43, .57, .38, dark, 0, 5.04, 0, 24);
    hoop(lamp, .56, .035, chrome, 0, 4.85, 0, true);
    cylinder(lamp, .4, .4, .012, light, 0, 4.85, 0, 24);
    const cone = new THREE.SpotLight(0x9ff5ec, 16, 7, .66, .75, 2);
    cone.position.set(0, 4.82, 0);
    cone.target.position.set(0, 1.3, .4);
    lamp.add(cone, cone.target);
  }

  private buildRoundFlask(parent: THREE.Group, x: number, y: number, z: number, scale: number, color: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'Curiosity reaction flask';
    group.position.set(x, y, z);
    group.scale.setScalar(scale);
    parent.add(group);
    this.labFlasks.push(group);
    const glass = new THREE.MeshStandardMaterial({ color: 0x85cad0, roughness: .08, metalness: .1, transparent: true, opacity: .24, side: THREE.DoubleSide, depthWrite: false });
    const liquid = glow(color, .42);
    liquid.transparent = true;
    liquid.opacity = .96;
    liquid.depthWrite = true;
    this.liquidMaterials.push(liquid);
    const brass = ink(0xc6a86c, .35, .67);
    cylinder(group, .33, .39, .07, brass, 0, .02, 0, 24);
    for (let index = 0; index < 3; index++) {
      const angle = index * TAU / 3;
      beam(group, new THREE.Vector3(Math.cos(angle) * .29, .07, Math.sin(angle) * .29), new THREE.Vector3(Math.cos(angle) * .35, .28, Math.sin(angle) * .35), .022, brass);
    }
    const liquidBody = new THREE.Mesh(new THREE.SphereGeometry(.38, 32, 20, 0, TAU, 1.3, Math.PI - 1.3), liquid);
    liquidBody.position.y = .42;
    liquidBody.castShadow = true;
    group.add(liquidBody);
    cylinder(group, .366, .366, .013, liquid, 0, .523, 0, 32);
    ball(group, .43, glass, 0, .42, 0, 1, 1, 1);
    cylinder(group, .15, .17, .12, glass, 0, .80, 0, 20);
    hoop(group, .17, .016, brass, 0, .86, 0, true);
    cylinder(group, .14, .13, .055, ink(0x6b5741, .77), 0, .89, 0, 12);
    for (let index = 0; index < 7; index++) {
      const angle = index * 2.399;
      ball(group, .024 + seeded(index) * .024, glow(0xd4ffe8, .85), Math.cos(angle) * .18, .24 + seeded(index + 18) * .27, Math.sin(angle) * .14);
    }
    return group;
  }

  private buildConicalFlask(parent: THREE.Group, x: number, y: number, z: number, scale: number, color: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'Reagent flask';
    group.position.set(x, y, z);
    group.scale.setScalar(scale);
    parent.add(group);
    this.labFlasks.push(group);
    const glass = new THREE.MeshStandardMaterial({ color: 0x8bd0d4, roughness: .1, metalness: .11, transparent: true, opacity: .28, side: THREE.DoubleSide, depthWrite: false });
    const liquid = glow(color, .42);
    liquid.transparent = true;
    liquid.opacity = .95;
    liquid.depthWrite = true;
    this.liquidMaterials.push(liquid);
    const brass = ink(0xc2a775, .34, .66);
    cylinder(group, .31, .32, .055, brass, 0, .025, 0, 20);
    cylinder(group, .16, .31, .62, glass, 0, .38, 0, 20);
    cylinder(group, .195, .28, .29, liquid, 0, .25, 0, 20);
    cylinder(group, .105, .11, .35, glass, 0, .86, 0, 16);
    hoop(group, .12, .019, brass, 0, 1.05, 0, true);
    cylinder(group, .11, .1, .1, ink(0x6b5741, .76), 0, 1.11, 0, 12);
    for (let index = 0; index < 4; index++) {
      const markY = .15 + index * .11;
      block(group, .07 + index * .024, .009, .006, brass, .13 + index * -.012, markY, .225 - index * .034);
    }
    return group;
  }

  private buildLabTools(bench: THREE.Group): void {
    const brass = ink(0xbda273, .32, .72);
    const chrome = ink(0x8fbbc0, .32, .68);
    const dark = ink(0x153b45, .43, .37);
    const paper = ink(0xd8d8bb, .91);
    block(bench, .73, .018, .52, paper, -2.26, 1.18, 1.23, .01).rotation.y = -.16;
    for (let index = 0; index < 6; index++) {
      block(bench, .46 - index * .022, .005, .008, dark, -2.29, 1.192, 1.05 + index * .06).rotation.y = -.16;
    }
    cylinder(bench, .18, .19, .032, brass, 2.49, 1.17, 1.12);
    cylinder(bench, .018, .025, .74, chrome, 2.49, 1.55, 1.12, 10);
    const gauge = new THREE.Mesh(new THREE.CircleGeometry(.18, 24), ink(0xe0d9b7, .6));
    gauge.position.set(2.49, 1.92, 1.29);
    bench.add(gauge);
    hoop(bench, .18, .022, brass, 2.49, 1.92, 1.29);
    beam(bench, new THREE.Vector3(2.49, 1.92, 1.31), new THREE.Vector3(2.55, 2.02, 1.31), .012, dark);
    cylinder(bench, .16, .16, .11, dark, 2.27, 1.2, 1.67);
    cylinder(bench, .13, .13, .02, glow(0x5fe0ce, .65), 2.27, 1.27, 1.67);
    tube(bench, [[-1.49, 1.8, 1.23], [-1.17, 2.05, 1.19], [-.69, 2.01, 1.19], [-.41, 1.85, 1.33]], .035, chrome);
    tube(bench, [[1.5, 1.8, 1.23], [1.15, 2.05, 1.19], [.66, 2.01, 1.19], [.4, 1.85, 1.33]], .035, chrome);
    for (const x of [-.71, .7]) {
      cylinder(bench, .055, .055, .055, brass, x, 2.0, 1.2, 12);
    }
    for (let index = 0; index < 3; index++) {
      const x = -2.72 + index * .15;
      cylinder(bench, .055, .072, .25, new THREE.MeshStandardMaterial({ color: 0xa8d9da, transparent: true, opacity: .5, roughness: .14 }), x, 1.26, 1.7, 12);
      cylinder(bench, .049, .06, .09 + index * .025, glow([0xc66bd4, 0x71dfe3, 0xc8eb75][index]!, .52), x, 1.19, 1.7, 12);
      cylinder(bench, .045, .045, .045, brass, x, 1.42, 1.7, 10);
    }
    const coil = new THREE.Group();
    coil.position.set(2.08, 1.2, .89);
    bench.add(coil);
    for (let index = 0; index < 5; index++) hoop(coil, .13 + index * .025, .011, brass, 0, index * .1, 0, true);
    ball(coil, .06, glow(0x9becdb, .9), 0, .55, 0);
  }
}
