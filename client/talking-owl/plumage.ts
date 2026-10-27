import * as THREE from 'three';

/** A single pair of maps can be shared by every plumage material. */
export interface PlumageMaps {
  colorMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  bumpScale: number;
  dispose(): void;
}

export interface FeatherTuftOptions {
  name: string;
  material: THREE.Material;
  /** Center and half-extents of the underlying volume, in parent-local units. */
  center?: readonly [number, number, number];
  radii: readonly [number, number, number];
  count?: number;
  /** Length measured along the plumage, in parent-local units. */
  length?: number;
  /** Full width at the root, in parent-local units. */
  width?: number;
  seed?: number;
  /** Select a cap of the ellipsoid by its outward-facing surface normal. */
  normalBias?: readonly [number, number, number];
  normalCutoff?: number;
  /** Preferred feather direction, projected onto each tuft's tangent plane. */
  groom?: readonly [number, number, number];
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function textureFrom(canvas: HTMLCanvasElement, color: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  return texture;
}

function periodicNoise(grid: Float32Array, cells: number, x: number, y: number, size: number): number {
  const gx = x / size * cells;
  const gy = y / size * cells;
  const x0 = Math.floor(gx) % cells;
  const y0 = Math.floor(gy) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const fx = gx - Math.floor(gx);
  const fy = gy - Math.floor(gy);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = THREE.MathUtils.lerp(grid[y0 * cells + x0]!, grid[y0 * cells + x1]!, sx);
  const bottom = THREE.MathUtils.lerp(grid[y1 * cells + x0]!, grid[y1 * cells + x1]!, sx);
  return THREE.MathUtils.lerp(top, bottom, sy) * 2 - 1;
}

function paintFiber(
  context: CanvasRenderingContext2D,
  size: number,
  x: number, y: number,
  dx: number, dy: number,
  bend: number,
  width: number,
  color: string,
): void {
  context.lineWidth = width;
  context.strokeStyle = color;
  const reach = Math.max(Math.abs(dx), Math.abs(dy)) + Math.abs(bend) + width;
  const xOffsets = [0];
  const yOffsets = [0];
  if (x < reach) xOffsets.push(size);
  if (x > size - reach) xOffsets.push(-size);
  if (y < reach) yOffsets.push(size);
  if (y > size - reach) yOffsets.push(-size);
  for (const offsetX of xOffsets) {
    for (const offsetY of yOffsets) {
      context.beginPath();
      context.moveTo(x + offsetX, y + offsetY);
      context.quadraticCurveTo(
        x + dx * 0.48 + bend + offsetX,
        y + dy * 0.48 + offsetY,
        x + dx + offsetX,
        y + dy + offsetY,
      );
      context.stroke();
    }
  }
}

/**
 * Soft barbs and mottled down keep the owl's plumage readable at mobile size.
 * Both maps share the same deterministic flow.
 */
export function createPlumageMaps(seed = 71291): PlumageMaps {
  const size = 256;
  const colorCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colorCanvas.width = bumpCanvas.width = size;
  colorCanvas.height = bumpCanvas.height = size;
  const color = colorCanvas.getContext('2d', { alpha: false });
  const bump = bumpCanvas.getContext('2d', { alpha: false });
  if (!color || !bump) throw new Error('Owl plumage requires a 2D canvas context.');

  const random = randomSource(seed);
  const colorPixels = color.createImageData(size, size);
  const bumpPixels = bump.createImageData(size, size);
  const coarse = Float32Array.from({ length: 16 * 16 }, random);
  const fine = Float32Array.from({ length: 64 * 64 }, random);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const soft = periodicNoise(coarse, 16, x, y, size);
      const detail = periodicNoise(fine, 64, x, y, size);
      const grain = (random() - 0.5) * 3;
      const lightness = Math.round(247 + soft * 5 + detail * 2 + grain);
      colorPixels.data[i] = lightness;
      colorPixels.data[i + 1] = lightness;
      colorPixels.data[i + 2] = lightness - 2;
      colorPixels.data[i + 3] = 255;

      const height = Math.round(128 + soft * 9 + detail * 6 + grain * 2);
      bumpPixels.data[i] = height;
      bumpPixels.data[i + 1] = height;
      bumpPixels.data[i + 2] = height;
      bumpPixels.data[i + 3] = 255;
    }
  }
  color.putImageData(colorPixels, 0, 0);
  bump.putImageData(bumpPixels, 0, 0);
  color.lineCap = bump.lineCap = 'round';

  // Feather barbs stay low contrast so the geometric flight feathers lead.
  for (let i = 0; i < 230; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 7 + random() * 13;
    const angle = -Math.PI / 2 + (random() - 0.5) * 1.0;
    const dx = Math.cos(angle) * length;
    const dy = Math.sin(angle) * length;
    const bend = (random() - 0.5) * 3;
    const width = 1.4 + random() * 1.5;
    paintFiber(color, size, x, y, dx, dy, bend, width * 1.5, 'rgba(82,66,50,.021)');
    paintFiber(color, size, x, y, dx, dy, bend, width, 'rgba(94,68,49,.060)');
    paintFiber(color, size, x + width * 0.46, y, dx, dy, bend, width * 0.35, 'rgba(255,255,255,.23)');
    paintFiber(bump, size, x, y, dx, dy, bend, width * 1.2, 'rgba(53,53,53,.09)');
    paintFiber(bump, size, x + width * 0.44, y, dx, dy, bend, width * 0.42, 'rgba(225,225,225,.22)');
  }

  // Fine down supplies a soft surface while keeping the feather layers distinct.
  for (let i = 0; i < 3500; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 2.5 + random() * 6.5;
    const angle = -Math.PI / 2 + (random() - 0.5) * 1.15;
    const dx = Math.cos(angle) * length;
    const dy = Math.sin(angle) * length;
    const bend = (random() - 0.5) * 1.8;
    const width = 0.45 + random() * 0.65;
    const shadow = random() < 0.58;
    paintFiber(color, size, x, y, dx, dy, bend, width,
      shadow ? 'rgba(90,70,52,.08)' : 'rgba(255,255,255,.24)');
    paintFiber(bump, size, x, y, dx, dy, bend, width,
      shadow ? 'rgba(45,45,45,.18)' : 'rgba(229,229,229,.22)');
  }

  const colorMap = textureFrom(colorCanvas, true);
  const bumpMap = textureFrom(bumpCanvas, false);
  let disposed = false;
  return {
    colorMap,
    bumpMap,
    bumpScale: 0.014,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      colorMap.dispose();
      bumpMap.dispose();
    },
  };
}

/** One soft feather tip; instances vary in size, tilt, and plumage color. */
function tuftGeometry(): THREE.BufferGeometry {
  const rings = [
    { along: 0, lift: -0.018, halfWidth: 0.43, halfDepth: 0.11 },
    { along: 0.22, lift: 0.075, halfWidth: 0.50, halfDepth: 0.13 },
    { along: 0.52, lift: 0.155, halfWidth: 0.39, halfDepth: 0.11 },
    { along: 0.78, lift: 0.180, halfWidth: 0.24, halfDepth: 0.075 },
    { along: 0.94, lift: 0.160, halfWidth: 0.11, halfDepth: 0.045 },
    { along: 1, lift: 0.130, halfWidth: 0.018, halfDepth: 0.012 },
  ];
  const radialSegments = 6;
  const ringStride = radialSegments + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    for (let side = 0; side <= radialSegments; side++) {
      const angle = side / radialSegments * Math.PI * 2;
      positions.push(
        Math.cos(angle) * ring.halfWidth,
        ring.lift + Math.sin(angle) * ring.halfDepth,
        ring.along,
      );
      uvs.push(side / radialSegments, ring.along);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < radialSegments; side++) {
      const a = ring * ringStride + side;
      const b = a + 1;
      const c = (ring + 1) * ringStride + side;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Bias tip normals toward the surface so down stays soft around the silhouette.
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normals.count; i++) {
    const x = normals.getX(i) * 0.28;
    const y = 0.72 + normals.getY(i) * 0.28;
    const z = normals.getZ(i) * 0.28;
    const inverseLength = 1 / Math.hypot(x, y, z);
    normals.setXYZ(i, x * inverseLength, y * inverseLength, z * inverseLength);
  }
  return geometry;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Attach an instanced layer of short feather tips to an ellipsoid-like volume.
 * Its parent transform carries every tip through character animation.
 */
export function addFeatherTufts(parent: THREE.Object3D, options: FeatherTuftOptions): THREE.InstancedMesh {
  const count = THREE.MathUtils.clamp(Math.round(options.count ?? 24), 0, 96);
  const length = Math.max(0.002, options.length ?? 0.09);
  const width = Math.max(0.002, options.width ?? length * 0.48);
  const [cx, cy, cz] = options.center ?? [0, 0, 0];
  const [givenRx, givenRy, givenRz] = options.radii;
  const rx = Math.max(0.001, Math.abs(givenRx));
  const ry = Math.max(0.001, Math.abs(givenRy));
  const rz = Math.max(0.001, Math.abs(givenRz));
  const bias = options.normalBias
    ? new THREE.Vector3(...options.normalBias).normalize()
    : null;
  if (bias && bias.lengthSq() < 0.0001) bias.set(0, 1, 0);
  const cutoff = THREE.MathUtils.clamp(options.normalCutoff ?? -1, -1, 0.999);
  const groom = options.groom
    ? new THREE.Vector3(...options.groom).normalize()
    : new THREE.Vector3(0, -1, 0);
  if (groom.lengthSq() < 0.0001) groom.set(0, -1, 0);
  const capX = bias
    ? new THREE.Vector3().crossVectors(Math.abs(bias.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP, bias).normalize()
    : null;
  const capY = bias && capX ? new THREE.Vector3().crossVectors(bias, capX).normalize() : null;
  const random = randomSource(options.seed ?? hashName(options.name));
  const mesh = new THREE.InstancedMesh(tuftGeometry(), options.material, count);
  mesh.name = options.name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.plumage = true;
  // Decorative locks must not intercept the underlying character's hit areas.
  mesh.raycast = () => {};

  const normal = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const across = new THREE.Vector3();
  const position = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Matrix4();
  const tint = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const cosine = bias ? cutoff + (1 - cutoff) * random() : random() * 2 - 1;
    const azimuth = random() * Math.PI * 2;
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    if (bias && capX && capY) {
      normal.copy(bias).multiplyScalar(cosine)
        .addScaledVector(capX, Math.cos(azimuth) * sine)
        .addScaledVector(capY, Math.sin(azimuth) * sine);
    } else {
      normal.set(Math.cos(azimuth) * sine, cosine, Math.sin(azimuth) * sine);
    }

    // Support point of the ellipsoid for a chosen outward surface normal.
    const denominator = Math.hypot(rx * normal.x, ry * normal.y, rz * normal.z);
    position.set(
      cx + rx * rx * normal.x / denominator,
      cy + ry * ry * normal.y / denominator,
      cz + rz * rz * normal.z / denominator,
    );
    tangent.copy(groom).addScaledVector(normal, -groom.dot(normal));
    if (tangent.lengthSq() < 0.001) {
      tangent.set(0, 0, 1).addScaledVector(normal, -normal.z);
      if (tangent.lengthSq() < 0.001) tangent.set(1, 0, 0).addScaledVector(normal, -normal.x);
    }
    tangent.normalize().applyAxisAngle(normal, (random() - 0.5) * 0.75);
    across.crossVectors(normal, tangent).normalize();
    const variation = 0.70 + random() * 0.62;
    const localLength = length * variation;
    const localWidth = width * (0.75 + random() * 0.55);
    matrix.makeBasis(across, normal, tangent);
    scale.makeScale(localWidth, localLength, localLength);
    matrix.multiply(scale);
    matrix.setPosition(position);
    mesh.setMatrixAt(i, matrix);
    const shade = 0.91 + random() * 0.16;
    tint.setRGB(shade, shade * (0.99 + random() * 0.025), shade * (0.98 + random() * 0.025));
    mesh.setColorAt(i, tint);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}
